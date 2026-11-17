// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// mesh-history end to end: the JSON-lines protocol server.py speaks, against the real binary.
// MESH_HISTORY_CMD names the binary; without it the test looks for a dune build in ocaml/_build and
// is skipped when there is none (MESH_REQUIRE_NATIVE_HISTORY=1 turns the skip into a failure).
import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const BIN = process.env.MESH_HISTORY_CMD || (fs.existsSync(BUILT) ? BUILT : '');
const skip = !BIN && !process.env.MESH_REQUIRE_NATIVE_HISTORY ? 'mesh-history is not built' : false;

type Json = Record<string, any>;

class Helper {
  private child: ChildProcessWithoutNullStreams;
  private lines: AsyncIterator<string>;
  readonly dbPath: string;
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.child = spawn(BIN, [], {env: {...process.env, MESH_HISTORY_DB: dbPath}, stdio: ['pipe', 'pipe', 'pipe']});
    this.lines = readline.createInterface({input: this.child.stdout})[Symbol.asyncIterator]();
  }
  async call(request: Json): Promise<Json> {
    this.child.stdin.write(JSON.stringify(request) + '\n');
    const {value, done} = await this.lines.next();
    assert.ok(!done, 'the helper closed its output');
    return JSON.parse(value);
  }
  async raw(line: string): Promise<Json> {
    this.child.stdin.write(line + '\n');
    return JSON.parse((await this.lines.next()).value);
  }
  async stop(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
  }
}

const conversation = (id: string, extra: Json = {}): Json => ({
  op: 'ingest', agent: 'claude', id, path: `/t/${id}.jsonl`, cwd: '/w', title: `Session ${id}`,
  started: 1.5, updated: 2.5, summary: '', ...extra,
});

describe('mesh-history protocol', {skip}, () => {
  let dir: string;
  let helper: Helper;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-history-e2e-'));
    helper = new Helper(path.join(dir, 'sub', 'history.sqlite'));
  });
  after(async () => {
    assert.equal(await helper.stop(), 0, 'end of input ends the helper cleanly');
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('hello reports the protocol, schema and tokenizer', async () => {
    const r = await helper.call({req: 7, op: 'hello'});
    assert.deepEqual([r.req, r.ok, r.protocol, r.schema], [7, true, 1, 2]);
    assert.match(r.tokenizer, /^unicode61 remove_diacritics [12]$/);
    assert.match(r.sqlite_version, /^3\.\d+\.\d+$/, 'the SQLite the executable carries');
    assert.deepEqual(r.modes, ['text']);
  });

  test('ingest, full-text search with accents, detail and list', async () => {
    const a = await helper.call(conversation('a', {
      summary: 'un résumé', meta: {branch: 'main', n_user: 2},
      chunks: [{seq: 0, role: 'user', text: 'Le café était délicieux'}, {seq: 1, role: 'assistant', text: 'Voici la réponse'}],
    }));
    assert.equal(a.ok, true);
    await helper.call(conversation('b', {updated: 9, chunks: [{seq: 0, role: 'user', text: 'rien à voir'}]}));
    const found = await helper.call({op: 'search', q: 'CAFE delicieux', mode: 'text', limit: 10});
    assert.deepEqual(found.results.map((h: Json) => `${h.agent}:${h.id}`), ['claude:a']);
    assert.match(found.results[0].snippet, /café/);
    const detail = await helper.call({op: 'detail', agent: 'claude', id: 'a'});
    assert.equal(detail.session.summary, 'un résumé');
    assert.equal(detail.session.path, '/t/a.jsonl');
    assert.equal(detail.session.branch, 'main');
    const list = await helper.call({op: 'list'});
    assert.deepEqual(list.sessions.map((s: Json) => s.id), ['b', 'a']);
    assert.deepEqual(list.sessions.map((s: Json) => s.path), ['/t/b.jsonl', '/t/a.jsonl'], 'a listed row carries its transcript path');
    assert.equal(list.sessions[1].has_summary, true);
    assert.equal(list.sessions[1].n_user, 2);
  });

  test('ingest is idempotent and the cursor survives', async () => {
    const request = conversation('c', {cursor: {offset: 10, next_seq: 1, epoch: 4}, chunks: [{seq: 0, role: 'user', text: 'zèbre'}]});
    await helper.call(request);
    await helper.call(request);
    const stats = await helper.call({op: 'stats'});
    assert.equal(stats.conversations, 3);
    assert.equal(stats.chunks, 3 + 2 + 2);   // each conversation: its chunks plus its title (a: 2, b: 1, c: 1)
    const cursors = await helper.call({op: 'cursors'});
    const c = cursors.cursors.find((x: Json) => x.id === 'c');
    assert.deepEqual([c.offset, c.next_seq, c.epoch, c.path], [10, 1, 4, '/t/c.jsonl']);
  });

  test('list since a generation, with removed ids', async () => {
    const before = (await helper.call({op: 'list'})).gen;
    const forgotten = await helper.call({op: 'forget', agent: 'claude', id: 'b'});
    assert.deepEqual([forgotten.ok, forgotten.removed], [true, true]);
    const delta = await helper.call({op: 'list', since: before});
    assert.equal(delta.full, false);
    assert.deepEqual(delta.gone, ['claude:b']);
    assert.deepEqual(delta.sessions, []);
    assert.deepEqual((await helper.call({op: 'search', q: 'voir'})).results, []);
    assert.equal((await helper.call({op: 'forget', agent: 'claude', id: 'b'})).removed, false);
  });

  test('an empty chunk text removes that chunk; a missing text is refused', async () => {
    await helper.call(conversation('e', {chunks: [{seq: 0, role: 'user', text: 'persistent'}, {seq: 5, role: 'state', text: 'vanishing'}]}));
    assert.equal((await helper.call({op: 'search', q: 'vanishing'})).results.length, 1);
    assert.equal((await helper.call(conversation('e', {chunks: [{seq: 5, role: 'state', text: ''}]}))).ok, true);
    assert.deepEqual((await helper.call({op: 'search', q: 'vanishing'})).results, []);
    assert.equal((await helper.call({op: 'search', q: 'persistent'})).results.length, 1);
    assert.equal((await helper.call(conversation('e', {chunks: [{seq: 5, role: 'state'}]}))).error.code, 'bad_request');
  });

  test('hostile queries are answered, never fatal', async () => {
    for (const q of ['"', 'a OR', 'NEAR(', '{text}: x', '*', '\u0000', 'x'.repeat(200000)]) {
      const r = await helper.call({op: 'search', q});
      assert.equal(r.ok, true, `query ${JSON.stringify(q.slice(0, 12))}`);
    }
  });

  test('bad requests get an error and the helper keeps serving', async () => {
    assert.equal((await helper.raw('{broken')).error.code, 'bad_request');
    assert.equal((await helper.call({op: 'nope'})).error.code, 'bad_request');
    assert.equal((await helper.call({op: 'search', q: 'x', mode: 'semantic'})).error.code, 'bad_request');
    assert.equal((await helper.call({op: 'ingest', agent: 'claude'})).error.code, 'bad_request');
    assert.equal((await helper.call({op: 'stats'})).ok, true);
  });

  test('the database is private to the user', () => {
    for (const name of fs.readdirSync(path.dirname(helper.dbPath))) {
      const mode = fs.statSync(path.join(path.dirname(helper.dbPath), name)).mode & 0o777;
      assert.equal(mode & 0o077, 0, `${name} is ${mode.toString(8)}`);
    }
    assert.equal(fs.statSync(path.dirname(helper.dbPath)).mode & 0o077, 0);
  });
});

describe('mesh-history on a corrupt database', {skip}, () => {
  test('answers corrupt for each request instead of exiting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-history-corrupt-'));
    try {
      const db = path.join(dir, 'history.sqlite');
      fs.writeFileSync(db, Buffer.alloc(8192, 0x67));
      const helper = new Helper(db);
      assert.equal((await helper.call({op: 'stats'})).error.code, 'corrupt');
      assert.equal((await helper.call({op: 'list'})).error.code, 'corrupt');
      assert.equal(await helper.stop(), 0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
