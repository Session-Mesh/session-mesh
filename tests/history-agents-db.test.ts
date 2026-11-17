// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode, Gemini CLI, Antigravity (agy), GitHub Copilot CLI and Mistral Vibe through mesh-history: the text
// of each transcript reaches the full-text database (history.db_search), not only the parse state's title and
// prompts. Every fixture is synthetic and lives under a temporary HOME; every location a client or Mesh could
// read is pointed there, so no real conversation is ever opened. The test is skipped without the mesh-history
// binary (MESH_HISTORY_CMD, or a dune build in ocaml/_build); MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const BIN = process.env.MESH_HISTORY_CMD || (fs.existsSync(BUILT) ? BUILT : '');
const skip = !BIN && !process.env.MESH_REQUIRE_NATIVE_HISTORY ? 'mesh-history is not built' : false;

const GEMINI_ID = 'c0ffee00-1111-4222-8333-444455556666';
const COPILOT_ID = '5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22';
const AGY_ID = '9a8b7c6d-1111-4222-8333-444455556666';
const VIBE_ID = '0a1b2c3d-1111-4222-8333-aaaabbbbcccc';
const OPENCODE_ID = 'ses_2f8a9c1d4e7bAbCdEfGh';
const OPENCODE_V2_ID = 'ses_3a9b0d2e5f8cBcDeFgHi';

let home: string;
let work: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-agents-db-'));
  work = path.join(home, 'work');
  fs.mkdirSync(work, {recursive: true});
  const at = (...parts: string[]): string => path.join(home, ...parts);
  env = {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    MESH_HISTORY_CMD: BIN};
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** One history.py process: scan, then ask the database; the helper stays on disk between processes. */
function databaseSearch(q: string): {live: boolean; hits: string[] | null} {
  const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)})
import history
history.refresh()
print(json.dumps({"live": history._hdb._db["live"], "hits": history.db_search(${JSON.stringify(q)})}))
history.flush()`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', code], {cwd: REPO, env, encoding: 'utf8'}));
}

function hits(q: string): string[] {
  const found = databaseSearch(q);
  assert.equal(found.live, true, 'the database mirrors the index');
  return found.hits ?? [];
}

const jsonl = (file: string, lines: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));
};

describe('mesh-history carries the text of every agent', {skip}, () => {
  test('Gemini: the messages of a chat, and lines appended later', () => {
    const file = path.join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-2026-11-01T10-00-c0ffee00.jsonl');
    jsonl(file, [
      {sessionId: GEMINI_ID, startTime: '2026-11-01T10:00:00.000Z', lastUpdated: '2026-11-01T10:00:00.000Z', kind: 'main'},
      {id: 'm1', timestamp: '2026-11-01T10:00:01.000Z', type: 'user', content: [{text: 'first gemini question'}]},
      {id: 'm2', timestamp: '2026-11-01T10:00:02.000Z', type: 'gemini', content: 'a middle gemini answer with gazelle inside'},
      {id: 'm3', timestamp: '2026-11-01T10:00:03.000Z', type: 'user', content: 'second gemini question'},
      {id: 'm4', timestamp: '2026-11-01T10:00:04.000Z', type: 'gemini', content: 'last gemini answer'},
    ]);
    assert.deepEqual(hits('gazelle'), [`gemini:${GEMINI_ID}`], 'a reply that is neither the first nor the last message');
    assert.deepEqual(hits('wildebeest'), []);
    fs.appendFileSync(file, JSON.stringify({id: 'm5', timestamp: '2026-11-01T10:05:00.000Z', type: 'gemini', content: 'appended wildebeest'}) + '\n');
    assert.deepEqual(hits('wildebeest'), [`gemini:${GEMINI_ID}`], 'only the new lines are read from the stored cursor');
    assert.deepEqual(hits('gazelle'), [`gemini:${GEMINI_ID}`], 'the earlier text is kept');
  });

  test('Copilot: user and assistant events, and events appended later', () => {
    const file = path.join(home, '.copilot', 'session-state', COPILOT_ID, 'events.jsonl');
    jsonl(file, [
      {id: 'e1', type: 'session.start', timestamp: '2026-11-02T09:00:00.000Z', data: {sessionId: COPILOT_ID, context: {cwd: work}}},
      {id: 'e2', type: 'user.message', timestamp: '2026-11-02T09:00:05.000Z', data: {content: 'first copilot prompt'}},
      {id: 'e3', type: 'assistant.message', timestamp: '2026-11-02T09:00:09.000Z', data: {content: 'a middle copilot reply about heron'}},
      {id: 'e4', type: 'user.message', timestamp: '2026-11-02T09:00:10.000Z', data: {content: 'second copilot prompt'}},
      {id: 'e5', type: 'assistant.message', timestamp: '2026-11-02T09:00:11.000Z', data: {content: 'last copilot reply'}},
    ]);
    assert.deepEqual(hits('heron'), [`copilot:${COPILOT_ID}`]);
    fs.appendFileSync(file, JSON.stringify({id: 'e6', type: 'user.message', timestamp: '2026-11-02T09:10:00.000Z', data: {content: 'appended ibis'}}) + '\n');
    assert.deepEqual(hits('ibis'), [`copilot:${COPILOT_ID}`]);
    assert.deepEqual(hits('heron'), [`copilot:${COPILOT_ID}`]);
  });

  test('Antigravity: the rewritten transcript replaces what was stored', () => {
    const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', AGY_ID, '.system_generated', 'logs', 'transcript.jsonl');
    jsonl(file, [
      {type: 'USER_INPUT', created_at: '2026-11-03T08:00:00Z', content: 'first agy request'},
      {type: 'PLANNER_RESPONSE', created_at: '2026-11-03T08:00:04Z', content: 'a middle agy plan about okapi'},
      {type: 'USER_INPUT', created_at: '2026-11-03T08:00:05Z', content: 'second agy request'},
      {type: 'PLANNER_RESPONSE', created_at: '2026-11-03T08:00:06Z', content: 'last agy plan'},
    ]);
    assert.deepEqual(hits('okapi'), [`agy:${AGY_ID}`]);
    jsonl(file, [
      {type: 'USER_INPUT', created_at: '2026-11-03T08:00:00Z', content: 'rewritten agy request'},
      {type: 'PLANNER_RESPONSE', created_at: '2026-11-03T08:00:04Z', content: 'rewritten plan about quokka'},
    ]);
    assert.deepEqual(hits('quokka'), [`agy:${AGY_ID}`]);
    assert.deepEqual(hits('okapi'), [], 'the old text is gone: the chunks were replaced, not added to');
  });

  test('Vibe: the chunk store, read again when a new checkpoint is written', () => {
    const dir = path.join(home, '.vibe', 'logs', 'session', 'unified', VIBE_ID);
    const checkpoint = (generation: string, digest: string, messages: object[]): void => {
      fs.mkdirSync(path.join(dir, 'generations', generation), {recursive: true});
      fs.mkdirSync(path.join(dir, 'chunks'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'generations', generation, 'manifest.json'), JSON.stringify({checkpoint: {chunks: [digest]}}));
      fs.writeFileSync(path.join(dir, 'chunks', `${digest}.json`), JSON.stringify(messages.map(message => ({message}))));
    };
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({session_id: VIBE_ID, start_time: '2026-11-04T07:00:00Z',
      end_time: '2026-11-04T07:05:00Z', title: 'Vibe title', environment: {working_directory: work}}));
    checkpoint('0000000000000001', 'ab'.repeat(32), [
      {role: 'user', content: 'first vibe prompt'},
      {role: 'assistant', content: [{type: 'text', text: 'a middle vibe answer about pangolin'}]},
      {role: 'user', content: 'second vibe prompt'},
      {role: 'assistant', content: 'last vibe answer'}]);
    assert.deepEqual(hits('pangolin'), [`vibe:${VIBE_ID}`]);
    checkpoint('0000000000000002', 'cd'.repeat(32), [
      {role: 'user', content: 'fresh vibe prompt'},
      {role: 'assistant', content: 'fresh answer about tapir'}]);
    assert.deepEqual(hits('tapir'), [`vibe:${VIBE_ID}`]);
    assert.deepEqual(hits('pangolin'), []);
  });

  test('OpenCode 1.x: the text parts of the read-only store, and a part added later', () => {
    const file = path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, title text, version text,
               time_created integer, time_updated integer);
             CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
             CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run(OPENCODE_ID, work, null, 'OpenCode title', '1.18.35', 1000, 5000);
    const say = (n: number, role: string, text: string): void => {
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(`m${n}`, OPENCODE_ID, 1000 + n, 1000 + n, JSON.stringify({role}));
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`p${n}`, `m${n}`, OPENCODE_ID, 1000 + n, 1000 + n, JSON.stringify({type: 'text', text}));
    };
    say(1, 'user', 'first opencode prompt');
    say(2, 'assistant', 'a middle opencode answer about lemur');
    say(3, 'user', 'second opencode prompt');
    say(4, 'assistant', 'last opencode answer');
    db.close();
    assert.deepEqual(hits('lemur'), [`opencode:${OPENCODE_ID}`]);
    const again = new DatabaseSync(file);
    again.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m5', OPENCODE_ID, 1100, 1100, JSON.stringify({role: 'user'}));
    again.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p5', 'm5', OPENCODE_ID, 1100, 1100, JSON.stringify({type: 'text', text: 'added aardvark'}));
    again.prepare('UPDATE session SET time_updated = 9000 WHERE id = ?').run(OPENCODE_ID);
    again.close();
    assert.deepEqual(hits('aardvark'), [`opencode:${OPENCODE_ID}`]);
    assert.deepEqual(hits('lemur'), [`opencode:${OPENCODE_ID}`]);
  });

  test('OpenCode 2.x: session_message rows', () => {
    const file = path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, directory text, parent_id text, title text, version text,
               time_created integer, time_updated integer);
             CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer,
               time_created integer, time_updated integer, data text);`);
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)').run(OPENCODE_V2_ID, work, null, 'V2 title', '2.0.0', 1000, 5000);
    const row = (n: number, type: string, data: object): void => {
      db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(`r${n}`, OPENCODE_V2_ID, type, n, 1000 + n, 1000 + n, JSON.stringify(data));
    };
    row(1, 'user', {text: 'first v2 prompt'});
    row(2, 'assistant', {content: [{type: 'reasoning', text: 'hidden thoughts'}, {type: 'text', text: 'a middle v2 answer about marmot'}]});
    row(3, 'user', {text: 'second v2 prompt'});
    row(4, 'assistant', {content: [{type: 'text', text: 'last v2 answer'}]});
    db.close();
    assert.deepEqual(hits('marmot'), [`opencode:${OPENCODE_V2_ID}`]);
    assert.deepEqual(hits('hidden thoughts'), [], 'only text blocks are indexed');
  });

  test('nothing outside the temporary HOME was needed: an empty store finds nothing', () => {
    assert.deepEqual(databaseSearch('anything'), {live: true, hits: []});
  });
});

// Incremental chunks. One history.py process scans, changes a fixture, scans again; every ingest request sent to
// the helper is recorded (replace flag, cursor, new texts), so what an append sends, and what a rewrite or an
// unreadable source sends, is read off the requests. Corrupting what was stored shows it is not read again.
function session(code: string): any {
  const script = `import sys, json, os, pathlib, sqlite3, time; sys.path.insert(0, ${JSON.stringify(REPO)})
import history
sent, rows = [], [0]
real_call, real_iter = history._hdb._db_call, history._oc_iter
def spy(req, read=False, wait=None):
    if req.get("op") == "ingest":
        sent.append({"replace": req["replace_chunks"], "offset": req["cursor"]["offset"],
                     "texts": [c["text"] for c in req["chunks"] if c["role"] != "state"]})
    return real_call(req, read, wait)
def counting(*args, **kw):
    for row in real_iter(*args, **kw):
        rows[0] += 1
        yield row
history._hdb._db_call, history._oc_iter = spy, counting
def step():
    del sent[:]
    rows[0] = 0
    history.refresh()
    return {"sent": [dict(x) for x in sent], "rows": rows[0]}
def lines(*items):
    return "".join(json.dumps(i) + "\\n" for i in items)
def hits(q):
    return history.db_search(q)
${code}
history.flush()`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {cwd: REPO, env, encoding: 'utf8'}));
}

describe('mesh-history chunks follow the sources incrementally', {skip}, () => {
  test('agy: the appended lines only; a shrunk, rewritten or replaced transcript is stored again', () => {
    const out = session(`
f = pathlib.Path(${JSON.stringify(home)}) / ".gemini/antigravity-cli/brain/${AGY_ID}/.system_generated/logs/transcript.jsonl"
f.parent.mkdir(parents=True)
pad = "x" * 400
def entry(kind, text):
    return {"type": kind, "created_at": "2026-11-03T08:00:00Z", "content": text}
f.write_text(lines(entry("USER_INPUT", "first agy request"), entry("PLANNER_RESPONSE", pad + " one"),
                   entry("USER_INPUT", "second agy request"), entry("PLANNER_RESPONSE", pad + " two")))
out = [step()]
f.write_text(f.read_text().replace("first agy request", "sixty agy request"))   # stored already: not read again
with open(f, "a") as h:
    h.write(lines(entry("USER_INPUT", "third agy request")))
out += [step()]
out.append({"hit_first": hits("sixty"), "hit_old": hits("first")})
f.write_text(f.read_text().replace(pad + " two", pad + " TWO") + lines(entry("USER_INPUT", "fourth agy request")))
out += [step()]                                  # same size before the cursor, other bytes: stored again
tmp = f.with_name("t.tmp")
tmp.write_text(f.read_text() + lines(entry("USER_INPUT", "fifth agy request")))
os.replace(tmp, f)                                # another file, same bytes before the cursor
out += [step()]
f.write_text(lines(entry("USER_INPUT", "short")))
out += [step()]
print(json.dumps(out))`);
    const [first, append, hit, rewrite, replaced, shrunk] = out;
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0].replace, true);
    assert.equal(first.sent[0].texts.length, 4);
    assert.deepEqual(append.sent.map((r: any) => [r.replace, r.texts]), [[false, ['third agy request']]], 'only the new line');
    assert.deepEqual([hit.hit_first.length, hit.hit_old.length], [0, 1], 'the stored text of the first line was not read again');
    assert.deepEqual(rewrite.sent.map((r: any) => [r.replace, r.texts.length]), [[true, 6]], 'bytes before the cursor changed');
    assert.deepEqual(replaced.sent.map((r: any) => [r.replace, r.texts.length]), [[true, 7]], 'another inode');
    assert.deepEqual(shrunk.sent.map((r: any) => [r.replace, r.texts]), [[true, ['short']]]);
  });

  test('Vibe: the chunks not stored yet; a dropped chunk replaces all; an unreadable chunk or manifest wipes nothing', () => {
    const out = session(`
d = pathlib.Path(${JSON.stringify(home)}) / ".vibe/logs/session/unified/${VIBE_ID}"
(d / "chunks").mkdir(parents=True)
def meta(title):
    (d / "meta.json").write_text(json.dumps({"session_id": "${VIBE_ID}", "start_time": "2026-11-04T07:00:00Z", "title": title}))
def chunk(c, *texts):
    (d / "chunks" / (c * 64 + ".json")).write_text(json.dumps([{"message": {"role": "user", "content": t}} for t in texts]))
def generation(n, manifest):
    g = d / "generations" / ("%016d" % n)
    g.mkdir(parents=True)
    (g / "manifest.json").write_text(manifest if isinstance(manifest, str) else json.dumps({"checkpoint": {"chunks": [c * 64 for c in manifest]}}))
meta("T1")
chunk("a", "vibe one", "vibe uno")
generation(1, ["a"])
out = [step()]
(d / "chunks" / ("a" * 64 + ".json")).write_text("{ corrupted")   # stored already: not read again
chunk("b", "vibe two")
generation(2, ["a", "b"])
out += [step()]
generation(3, ["a", "b", "c"])                                               # chunk c is missing
out += [step()]
chunk("c", "vibe three")
out += [step()]
chunk("d", "vibe rewritten")
generation(4, ["d"])                                                 # the manifest dropped stored chunks
out += [step()]
out.append({"hit_dropped": hits("vibe two"), "hit_new": hits("rewritten")})
meta("T2")
generation(5, "{ not json")                                        # no manifest: nothing is replaced
out += [step()]
out.append({"hit_kept": hits("rewritten")})
print(json.dumps(out))`);
    const [first, append, missing, arrived, rewound, hit, bad, kept] = out;
    assert.deepEqual(first.sent.map((r: any) => [r.replace, r.offset, r.texts]), [[true, 1, ['vibe one', 'vibe uno']]]);
    assert.deepEqual(append.sent.map((r: any) => [r.replace, r.offset, r.texts]), [[false, 2, ['vibe two']]], 'only chunk b');
    assert.deepEqual(missing.sent.map((r: any) => [r.replace, r.offset, r.texts]), [[false, 2, []]], 'chunk c is unreadable: skipped, nothing replaced');
    assert.deepEqual(arrived.sent.map((r: any) => [r.replace, r.offset, r.texts]), [[false, 3, ['vibe three']]], 'and stored when it appears');
    assert.deepEqual(rewound.sent.map((r: any) => [r.replace, r.offset, r.texts]), [[true, 1, ['vibe rewritten']]]);
    assert.deepEqual([hit.hit_dropped.length, hit.hit_new.length], [0, 1]);
    assert.ok(bad.sent.every((r: any) => !r.replace && r.texts.length === 0), 'an unreadable manifest replaces nothing');
    assert.equal(kept.hit_kept.length, 1);
  });

  test('OpenCode 1.x: the rows after the cursor only; a rewind stores all again; a locked store keeps the chunks', () => {
    const out = session(`
db = pathlib.Path(os.environ["XDG_DATA_HOME"]) / "opencode" / "opencode.db"
db.parent.mkdir(parents=True)
con = sqlite3.connect(db)
con.executescript("""
CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, title text, version text, time_created integer, time_updated integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
""")
sid = "${OPENCODE_ID}"
con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?)", (sid, ${JSON.stringify(work)}, None, "T", "1.18.35", 1000, 5000))
def say(n, role, text):
    con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?,?)", ("m%d" % n, sid, 1000 + n, 1000 + n, json.dumps({"role": role})))
    con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?,?)", ("p%d" % n, "m%d" % n, sid, 1000 + n, 1000 + n, json.dumps({"type": "text", "text": text})))
for n, (role, text) in enumerate([("user", "first oc prompt"), ("assistant", "oc answer lemur"), ("user", "second oc prompt"), ("assistant", "last oc answer")], 1):
    say(n, role, text)
con.commit()
out = [step()]
con.execute("UPDATE part SET data = ? WHERE id = 'p1'", (json.dumps({"type": "text", "text": "CORRUPT"}),))   # stored already
say(5, "user", "appended oc prompt")
con.execute("UPDATE session SET time_updated = 9000")
con.commit()
out += [step()]
out.append({"hit_corrupt": hits("CORRUPT"), "hit_old": hits("lemur")})
con.execute("DELETE FROM message WHERE id IN ('m4', 'm5')")
con.execute("DELETE FROM part WHERE id IN ('p4', 'p5')")
say(6, "user", "after the rewind")
con.execute("UPDATE session SET time_updated = 9500")
con.commit()
out += [step()]
out.append({"hit_dropped": hits("appended"), "hit_new": hits("rewind")})
key = "opencode:" + sid
lock = sqlite3.connect(db, isolation_level=None)
lock.execute("BEGIN EXCLUSIVE")
with history._lock:
    history._files[key]["g"] = history._bump()                       # the entry changed: it is synced again
out += [step()]
out.append({"hit_locked": hits("rewind")})
lock.execute("ROLLBACK")
lock.close()
out += [step()]
print(json.dumps(out))`);
    const [first, append, hit, rewind, afterRewind, locked, keptWhileLocked, unlocked] = out;
    assert.deepEqual([first.sent[0].replace, first.sent[0].texts.length, first.rows], [true, 4, 8], "four rows read for the parse state, four for the chunks");
    assert.deepEqual(append.sent.map((r: any) => [r.replace, r.texts]), [[false, ['appended oc prompt']]], 'only the new message');
    assert.equal(append.rows, 2, "one new row, read for the parse state and for the chunks, not the five rows of the conversation");
    assert.deepEqual([hit.hit_corrupt.length, hit.hit_old.length], [0, 1], 'the stored text was not read again');
    assert.deepEqual(rewind.sent.map((r: any) => [r.replace, r.texts.includes('CORRUPT')]), [[true, true]], 'the cursor row is gone: all stored again');
    assert.deepEqual([afterRewind.hit_dropped.length, afterRewind.hit_new.length], [0, 1]);
    assert.deepEqual(locked.sent, [], 'a locked store sends nothing, not an empty replace');
    assert.equal(keptWhileLocked.hit_locked.length, 1, 'the chunks stored before are still found');
    assert.ok(unlocked.sent.every((r: any) => !r.replace || r.texts.length > 0), 'and the next scan is not an empty replace either');
  });

  test('OpenCode 2.x: session_message rows after the cursor', () => {
    const out = session(`
db = pathlib.Path(os.environ["XDG_DATA_HOME"]) / "opencode" / "opencode.db"
db.parent.mkdir(parents=True)
con = sqlite3.connect(db)
con.executescript("""
CREATE TABLE session_v2 (id text PRIMARY KEY, directory text, parent_id text, title text, version text, time_created integer, time_updated integer);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
""")
sid = "${OPENCODE_V2_ID}"
con.execute("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)", (sid, ${JSON.stringify(work)}, None, "T", "2.0.0", 1000, 5000))
def row(n, kind, data):
    con.execute("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", ("r%d" % n, sid, kind, n, 1000 + n, 1000 + n, json.dumps(data)))
row(1, "user", {"text": "first v2 prompt"})
row(2, "assistant", {"content": [{"type": "reasoning", "text": "hidden"}, {"type": "text", "text": "v2 answer marmot"}]})
con.commit()
out = [step()]
row(3, "user", {"text": "appended v2 prompt"})
con.execute("UPDATE session_v2 SET time_updated = 9000")
con.commit()
out += [step()]
print(json.dumps(out))`);
    assert.deepEqual([out[0].sent[0].replace, out[0].sent[0].texts], [true, ['first v2 prompt', 'v2 answer marmot']]);
    assert.deepEqual(out[1].sent.map((r: any) => [r.replace, r.texts]), [[false, ['appended v2 prompt']]]);
    assert.equal(out[1].rows, 2, "one new row, read for the parse state and for the chunks");
  });
});
