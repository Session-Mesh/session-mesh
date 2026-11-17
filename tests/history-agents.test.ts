// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The History index of OpenCode, Gemini CLI, Antigravity (agy), GitHub Copilot CLI and Mistral Vibe:
// listing, title, full-text search, incremental update, malformed input, resume argv, delete policy and
// the conversation named for a pin. history.py runs in a python subprocess against a synthetic HOME built
// from each client's documented on-disk format (see history.py); no client binary and no real data.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const GEMINI_ID = 'c0ffee00-1111-4222-8333-444455556666';
const GEMINI_MESH_ID = 'c0ffee00-1111-4222-8333-777788889999';
const COPILOT_ID = '5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22';
const AGY_ID = '9a8b7c6d-1111-4222-8333-444455556666';
const VIBE_ID = '0a1b2c3d-1111-4222-8333-aaaabbbbcccc';
const OPENCODE_ID = 'ses_2f8a9c1d4e7bAbCdEfGh';

let home: string;
let work: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-agents-'));
  work = path.join(home, 'work dir');
  fs.mkdirSync(work, {recursive: true});
  const at = (...parts: string[]): string => path.join(home, ...parts);
  env = {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    OPENCODE_DB: at('data', 'opencode', 'opencode.db'),
    // The in-memory index and ripgrep alone, whatever mesh-history is installed on the machine: the helper's
    // side is covered by history-agents-db.test.ts and history-review-fixes.test.ts, which compares both modes.
    MESH_HISTORY_DB_DISABLE: '1'};
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

function python(code: string): any {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env, encoding: 'utf8'});
  return JSON.parse(output);
}

const list = (): any[] => python('import history\nhistory.refresh()\nprint(json.dumps(history.listing()[0]))');
const byAgent = (agent: string): any => list().find(d => d.agent === agent);
const jsonl = (file: string, lines: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join(''));
};
const search = (q: string): string[] => python(`
import history, subprocess
history.refresh()
argv = history.search_argv(${JSON.stringify(q)})
out = subprocess.run(argv, capture_output=True, text=True).stdout.splitlines() if argv else []
print(json.dumps(sorted(set(history.search_ids(out) + history.search_db(${JSON.stringify(q)})))))
`);

const geminiFile = (root: string, id: string, extra: unknown[] = []): string => {
  const file = path.join(root, 'tmp', 'proj', 'chats', `session-2026-11-01T10-00-${id.slice(0, 8)}.jsonl`);
  jsonl(file, [
    {sessionId: id, projectHash: 'h', startTime: '2026-11-01T10:00:00.000Z', lastUpdated: '2026-11-01T10:00:00.000Z', kind: 'main'},
    {id: 'm1', timestamp: '2026-11-01T10:00:01.000Z', type: 'user', content: [{text: 'gemini needle question'}]},
    {id: 'm2', timestamp: '2026-11-01T10:00:02.000Z', type: 'gemini', content: 'an answer', model: 'gemini-x', tokens: null},
    {id: 'm2', timestamp: '2026-11-01T10:00:02.000Z', type: 'gemini', content: 'an answer', model: 'gemini-x',
      tokens: {input: 100, output: 7, cached: 40, thoughts: 3, tool: 0, total: 110}},
    {$set: {summary: 'Gemini summary title'}},
    ...extra,
  ]);
  fs.writeFileSync(path.join(root, 'tmp', 'proj', '.project_root'), work + '\n');
  return file;
};

describe('Gemini CLI', () => {
  test('lists a chat of the user\'s store: title, folder from the project marker, tokens counted once, not resumable here', () => {
    geminiFile(path.join(home, '.gemini'), GEMINI_ID);
    const d = byAgent('gemini');
    assert.equal(d.id, GEMINI_ID);
    assert.equal(d.title, 'Gemini summary title');
    assert.equal(d.cwd, work);
    assert.deepEqual([d.n_user, d.n_assistant, d.tin, d.tout, d.tcr], [1, 1, 60, 10, 40]);
    assert.deepEqual(d.models, ['gemini-x']);
    assert.equal(d.first, 'gemini needle question');
    assert.equal(d.resumable, false, 'Mesh-started Gemini runs in a private home');
    assert.equal(d.deletable, true);
  });

  test('a chat of Mesh\'s private overlay home is resumable', () => {
    geminiFile(path.join(env.MESH_CONF_DIR!, 'gemini-home', '.gemini'), GEMINI_MESH_ID);
    const d = byAgent('gemini');
    assert.equal(d.id, GEMINI_MESH_ID);
    assert.equal(d.resumable, true);
  });

  test('is found by full-text search and updated incrementally from the appended lines', () => {
    const file = geminiFile(path.join(home, '.gemini'), GEMINI_ID);
    assert.deepEqual(search('needle'), [`gemini:${GEMINI_ID}`]);
    const first = fs.statSync(file).size;
    fs.appendFileSync(file, JSON.stringify({id: 'm3', timestamp: '2026-11-01T10:05:00.000Z', type: 'user', content: 'second prompt'}) + '\n');
    const d = byAgent('gemini');
    assert.equal(d.n_user, 2);
    assert.equal(d.last_user, 'second prompt');
    const cached = JSON.parse(fs.readFileSync(path.join(env.MESH_CACHE_DIR!, 'history.json'), 'utf8')) as {files: Record<string, {offset: number}>};
    assert.ok(fs.statSync(file).size > first && cached.files[file]!.offset === fs.statSync(file).size, 'parsed up to the end of the file');
  });

  test('a malformed file and a sub-agent chat are ignored', () => {
    const chats = path.join(home, '.gemini', 'tmp', 'proj', 'chats');
    jsonl(path.join(chats, 'session-2026-11-01T10-00-badbadba.jsonl'), ['not json', '{"sessionId": 7}', '[1,2]']);
    jsonl(path.join(chats, 'session-2026-11-01T10-00-subsubsu.jsonl'), [
      {sessionId: 'aaaaaaaa-1111-4222-8333-444455556666', kind: 'subagent', startTime: '2026-11-01T10:00:00.000Z'},
      {id: 'x', type: 'user', content: 'hidden'}]);
    assert.deepEqual(list(), []);
  });

  test('delete removes the chat file of a quiet conversation', () => {
    const file = geminiFile(path.join(home, '.gemini'), GEMINI_ID);
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    assert.deepEqual(python(`import history\nhistory.refresh()\nhistory.delete("gemini", ${JSON.stringify(GEMINI_ID)})\nprint(json.dumps(True))`), true);
    assert.equal(fs.existsSync(file), false);
  });
});

describe('GitHub Copilot CLI', () => {
  const events = (): string => path.join(home, '.copilot', 'session-state', COPILOT_ID, 'events.jsonl');
  const write = (): void => {
    jsonl(events(), [
      {id: 'e1', type: 'session.start', timestamp: '2026-11-02T09:00:00.000Z',
        data: {sessionId: COPILOT_ID, startTime: '2026-11-02T09:00:00.000Z', copilotVersion: '1.0.112', context: {cwd: work}}},
      {id: 'e2', type: 'user.message', timestamp: '2026-11-02T09:00:05.000Z', data: {content: 'copilot needle prompt'}},
      {id: 'e3', type: 'assistant.message', timestamp: '2026-11-02T09:00:09.000Z', data: {messageId: 'x', content: 'done', outputTokens: 12}},
      {id: 'e3', type: 'assistant.message', timestamp: '2026-11-02T09:00:09.000Z', data: {messageId: 'x', content: 'done', outputTokens: 12}},
    ]);
    fs.writeFileSync(path.join(path.dirname(events()), 'workspace.yaml'), `id: ${COPILOT_ID}\ncwd: ${work}\nname: Fix the flaky test\n`);
  };

  test('lists the conversation with its title from workspace.yaml, folder and counts (a repeated event id counts once)', () => {
    write();
    const d = byAgent('copilot');
    assert.deepEqual([d.id, d.title, d.cwd, d.version, d.n_user, d.n_assistant, d.tout], [COPILOT_ID, 'Fix the flaky test', work, '1.0.112', 1, 1, 12]);
    assert.equal(d.resumable, true);
    assert.equal(d.deletable, false, 'the directory also holds checkpoints and plans');
  });

  test('is searchable, picks up appended events and honours COPILOT_HOME', () => {
    write();
    assert.deepEqual(search('needle'), [`copilot:${COPILOT_ID}`]);
    fs.appendFileSync(events(), JSON.stringify({id: 'e9', type: 'user.message', timestamp: '2026-11-02T09:10:00.000Z', data: {content: 'later'}}) + '\n');
    assert.equal(byAgent('copilot').n_user, 2);
    fs.renameSync(path.join(home, '.copilot'), path.join(home, 'elsewhere'));
    env.COPILOT_HOME = path.join(home, 'elsewhere');
    assert.equal(byAgent('copilot').id, COPILOT_ID);
  });

  test('a malformed events file is ignored', () => {
    jsonl(events(), ['{', 'null', '{"type": "user.message", "data": 5}']);
    assert.deepEqual(list(), []);
  });
});

describe('Antigravity (agy)', () => {
  const brain = (): string => path.join(home, '.gemini', 'antigravity-cli', 'brain', AGY_ID, '.system_generated', 'logs');
  const write = (): void => {
    jsonl(path.join(brain(), 'transcript.jsonl'), [
      {step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-03T08:00:00Z', content: 'agy needle request'},
      {step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-03T08:00:04Z', content: 'agy reply', tool_calls: []},
      {step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-03T08:00:05Z', content: '', tool_calls: [{name: 'x'}]},
    ]);
  };

  test('lists the conversation: id from its directory, no title (the first prompt shows), not deletable', () => {
    write();
    const d = byAgent('agy');
    assert.deepEqual([d.id, d.title, d.first, d.n_user, d.n_assistant, d.deletable], [AGY_ID, '', 'agy needle request', 1, 1, false]);
    assert.equal(d.resumable, false, 'no folder is recorded for it');
  });

  test('the folder comes from cache/last_conversations.json, which makes it resumable and nameable for a pin', () => {
    write();
    jsonl(path.join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'), [JSON.stringify({[work]: AGY_ID, relative: 'zzzzzzzz'})]);
    const d = byAgent('agy');
    assert.deepEqual([d.cwd, d.resumable], [work, true]);
    assert.equal(python(`import history\nhistory.refresh()\nprint(json.dumps(history.newest_for("agy", ${JSON.stringify(work)}, 0)))`), AGY_ID);
  });

  test('is searchable, is read again when the transcript is rewritten, and a full transcript hit maps to it', () => {
    write();
    assert.deepEqual(search('needle'), [`agy:${AGY_ID}`]);
    jsonl(path.join(brain(), 'transcript_full.jsonl'), [{type: 'USER_INPUT', content: 'only in the full file zebra'}]);
    assert.deepEqual(search('zebra'), [`agy:${AGY_ID}`]);
    jsonl(path.join(brain(), 'transcript.jsonl'), [
      {step_index: 0, type: 'USER_INPUT', created_at: '2026-11-03T08:00:00Z', content: 'rewritten prompt'}]);
    const d = byAgent('agy');
    assert.deepEqual([d.n_user, d.n_assistant, d.first], [1, 0, 'rewritten prompt']);
  });

  test('a malformed transcript and a directory that is not an id are ignored', () => {
    jsonl(path.join(brain(), 'transcript.jsonl'), ['garbage', '{"type": 3}']);
    jsonl(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'x', '.system_generated', 'logs', 'transcript.jsonl'),
      [{type: 'USER_INPUT', content: 'short id'}]);
    assert.deepEqual(list(), []);
  });
});

describe('Mistral Vibe', () => {
  // Vibe 3.1.2's unified store: meta.json, and the checkpoint's transcript in chunks/<sha256>.json named by the
  // newest generation's manifest.json (layout read from vibe/_storage.py of the mistral-vibe 3.1.2 wheel).
  const SHA = 'ab'.repeat(32);
  const dir = (): string => path.join(home, '.vibe', 'logs', 'session', 'unified', VIBE_ID);
  const write = (title = 'Vibe title', withChunks = true): void => {
    fs.mkdirSync(dir(), {recursive: true});
    fs.writeFileSync(path.join(dir(), 'meta.json'), JSON.stringify({session_id: VIBE_ID, start_time: '2026-11-04T07:00:00Z',
      end_time: '2026-11-04T07:05:00Z', title, environment: {working_directory: work}, config: {model_name: 'devstral-x'}}));
    if (!withChunks) return;
    fs.mkdirSync(path.join(dir(), 'generations', '0000000000000002'), {recursive: true});
    fs.mkdirSync(path.join(dir(), 'generations', '0000000000000001'), {recursive: true});
    fs.mkdirSync(path.join(dir(), 'chunks'), {recursive: true});
    fs.writeFileSync(path.join(dir(), 'generations', '0000000000000002', 'manifest.json'),
      JSON.stringify({checkpoint: {path: 'checkpoint.json', chunks: [SHA, 'not-a-digest']}}) + '\n');
    fs.writeFileSync(path.join(dir(), 'chunks', `${SHA}.json`), JSON.stringify([
      {message: {role: 'system', content: 'sys'}}, {message: {role: 'user', content: 'vibe needle prompt'}},
      {message: {role: 'assistant', content: [{type: 'text', text: 'vibe answer'}]}}, 'junk', {message: 5}]) + '\n');
  };

  test('lists the conversation with title, folder, model and counts; a rename is picked up', () => {
    write();
    const d = byAgent('vibe');
    assert.deepEqual([d.id, d.title, d.cwd, d.n_user, d.n_assistant, d.first, d.models, d.resumable, d.deletable],
      [VIBE_ID, 'Vibe title', work, 1, 1, 'vibe needle prompt', ['devstral-x'], true, false]);
    write('Renamed');
    assert.equal(byAgent('vibe').title, 'Renamed');
  });

  test('a titled conversation whose transcript cannot be read is still listed (by its title)', () => {
    write('Only a title', false);
    const d = byAgent('vibe');
    assert.deepEqual([d.title, d.n_user], ['Only a title', 0]);
  });

  test('is searchable through its chunks; a sub-agent session and a malformed meta.json are ignored', () => {
    write();
    assert.deepEqual(search('needle'), [`vibe:${VIBE_ID}`]);
    const sub = path.join(home, '.vibe', 'logs', 'session', 'unified', 'sub');
    fs.mkdirSync(sub, {recursive: true});
    fs.writeFileSync(path.join(sub, 'meta.json'), JSON.stringify({session_id: 'bbbbbbbb-1111-4222-8333-444455556666', parent_session_id: VIBE_ID}));
    jsonl(path.join(sub, 'messages.jsonl'), [{role: 'user', content: 'child'}]);
    const bad = path.join(home, '.vibe', 'logs', 'session', 'unified', 'bad');
    fs.mkdirSync(bad, {recursive: true});
    fs.writeFileSync(path.join(bad, 'meta.json'), '{ not json');
    assert.deepEqual(list().map(d => d.id), [VIBE_ID]);
  });
});

describe('OpenCode', () => {
  const build = (): void => {
    const db = path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(db), {recursive: true});
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.executescript("""
CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text,
  time_created integer, time_updated integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
""")
sid, other = sys.argv[2], "ses_child000000000000"
con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)", (sid, "p", None, "s", sys.argv[3], "OpenCode title", "1.18.35", 1000, 5000, None))
con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)", (other, "p", sid, "s", sys.argv[3], "child", "1.18.35", 1000, 5000, None))
msgs = [("m1", 1100, {"role": "user"}), ("m2", 1200, {"role": "assistant", "modelID": "claude-x",
        "tokens": {"input": 30, "output": 5, "reasoning": 2, "cache": {"read": 10, "write": 1}}})]
for mid, t, data in msgs:
    con.execute("INSERT INTO message VALUES (?,?,?,?,?)", (mid, sid, t, t, json.dumps(data)))
for pid, mid, t, text in (("p1", "m1", 1100, "opencode needle prompt"), ("p2", "m2", 1200, "opencode answer")):
    con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (pid, mid, sid, t, t, json.dumps({"type": "text", "text": text})))
con.commit()
`, db, OPENCODE_ID, work], {env});
  };

  test('lists the root conversation of the read-only store: title, folder, tokens, texts; sub-conversations are skipped', () => {
    build();
    const rows = list().filter(d => d.agent === 'opencode');
    assert.equal(rows.length, 1);
    const d = rows[0];
    assert.deepEqual([d.id, d.title, d.cwd, d.version, d.n_user, d.n_assistant, d.first, d.last_assistant, d.models, d.tin, d.tout, d.tcr, d.tcw],
      [OPENCODE_ID, 'OpenCode title', work, '1.18.35', 1, 1, 'opencode needle prompt', 'opencode answer', ['claude-x'], 30, 7, 10, 1]);
    assert.deepEqual([d.started, d.updated, d.resumable, d.deletable], [1, 5, true, false]);
  });

  test('is searched inside the SQLite store (literal, case-insensitive) and follows the store when it changes', () => {
    build();
    assert.deepEqual(search('NEEDLE'), [`opencode:${OPENCODE_ID}`]);
    assert.deepEqual(search('absent-term'), []);
    assert.deepEqual(search('100%'), [], 'LIKE wildcards are literal');
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("UPDATE session SET title = 'Retitled', time_updated = 9000 WHERE id = ?", (sys.argv[2],))
con.commit()
`, path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db'), OPENCODE_ID], {env});
    assert.equal(byAgent('opencode').title, 'Retitled');
  });

  test('a placeholder title is dropped, an unreadable or missing store lists nothing and keeps what was indexed', () => {
    assert.deepEqual(list(), [], 'no store');
    build();
    assert.equal(list().length, 1);
    fs.writeFileSync(path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db'), 'this is not sqlite');
    assert.equal(list().length, 1, 'a broken store does not erase the index');
  });

  test('delete is refused: the conversation is a database row', () => {
    build();
    assert.deepEqual(python(`
import history
history.refresh()
try:
    history.delete("opencode", ${JSON.stringify(OPENCODE_ID)})
    print(json.dumps("deleted"))
except history.Unsupported:
    print(json.dumps("refused"))
`), 'refused');
  });
});

describe('resume argv and ids', () => {
  const argv = (agent: string, id: string): string[] => python(`
import resumeargs
print(json.dumps(resumeargs.resume_argv(${JSON.stringify(agent)}, [], ${JSON.stringify(id)})))`);

  test('each agent resumes with its own bare command, the id as one argument', () => {
    assert.deepEqual(argv('opencode', OPENCODE_ID), ['opencode', '--session', OPENCODE_ID]);
    assert.deepEqual(argv('gemini', GEMINI_ID), ['gemini', '--resume', GEMINI_ID]);
    assert.deepEqual(argv('agy', AGY_ID), ['agy', '--conversation', AGY_ID]);
    assert.deepEqual(argv('copilot', COPILOT_ID), ['copilot', `--resume=${COPILOT_ID}`]);
    assert.deepEqual(argv('vibe', VIBE_ID), ['vibe', '--resume', VIBE_ID]);
  });

  test('the History routes accept every indexed agent and an id that cannot be an option', () => {
    const result = python(`
import history, server
print(json.dumps({"agents": sorted(server.HISTORY_AGENTS), "rejects": [server.SID_RE.fullmatch(x) is None for x in ("--yolo", "-s", "a b", "x;rm -rf /", "$(id)abc")],
 "accepts": all(server.SID_RE.fullmatch(x) for x in (${[OPENCODE_ID, GEMINI_ID, COPILOT_ID, AGY_ID, VIBE_ID].map(i => JSON.stringify(i)).join(',')}))}))`);
    assert.deepEqual(result.agents, ['agy', 'claude', 'codex', 'copilot', 'gemini', 'opencode', 'pi', 'vibe']);
    assert.ok(result.accepts);
    assert.ok(result.rejects.every(Boolean));
  });

  test('every agent the resume route accepts is indexed: no separate "history unavailable" refusal is needed', () => {
    assert.deepEqual(python(`
import history, respawn
print(json.dumps(sorted(set(respawn.AGENT_TYPES) ^ set(history.AGENTS))))`), []);
  });
});

describe('the conversation of a pinned session', () => {
  test('is the one conversation written in the folder since the process started, never a guess among several', () => {
    const events = (id: string): string => path.join(home, '.copilot', 'session-state', id, 'events.jsonl');
    const start = (id: string, cwd: string, ts: string): unknown[] => [
      {id: 'a', type: 'session.start', timestamp: ts, data: {sessionId: id, startTime: ts, context: {cwd}}},
      {id: 'b', type: 'user.message', timestamp: ts, data: {content: 'hello there'}}];
    jsonl(events(COPILOT_ID), start(COPILOT_ID, work, '2026-11-02T09:00:00.000Z'));
    const ask = (since: number): unknown => python(`import history\nhistory.refresh()\nprint(json.dumps(history.newest_for("copilot", ${JSON.stringify(work)}, ${since})))`);
    const t0 = Date.parse('2026-11-02T08:00:00Z') / 1000;
    assert.equal(ask(t0), COPILOT_ID);
    assert.equal(ask(t0 + 7200), null, 'written before the process started');
    const other = '6e4b2d63-1d4f-4a8f-8c72-4b8e9d1a2f33';
    jsonl(events(other), start(other, work, '2026-11-02T09:30:00.000Z'));
    assert.equal(ask(t0), null, 'two candidates: nothing is guessed');
  });

  test('the server fills it in only for a Gemini, Antigravity or Copilot that has none, never over a reported one', () => {
    jsonl(path.join(home, '.copilot', 'session-state', COPILOT_ID, 'events.jsonl'), [
      {id: 'a', type: 'session.start', timestamp: '2026-11-02T09:00:00.000Z', data: {sessionId: COPILOT_ID, context: {cwd: work}}},
      {id: 'b', type: 'user.message', timestamp: '2026-11-02T09:00:01.000Z', data: {content: 'hello there'}}]);
    const t0 = Date.parse('2026-11-02T08:00:00Z') / 1000;
    const result = python(`
import history, server
history.refresh()
def entry(kind, sid, started=${t0}, cwd=${JSON.stringify(work)}):
    return {"cwd": cwd, "agent": {"type": kind, "session_id": sid, "started": started}}
mesh = [entry("copilot", None), entry("copilot", "reported-id-1234"), entry("copilot", None, None), entry("codex", None),
        entry("copilot", None, cwd="/elsewhere")]
server._apply_history_identity(mesh)
print(json.dumps([[e["agent"]["session_id"], e["agent"].get("identity_source")] for e in mesh]))`);
    assert.deepEqual(result, [[COPILOT_ID, 'history_cwd'], ['reported-id-1234', null], [null, null], [null, null], [null, null]]);
  });
});

// Incremental parse state: an append reads only what is new (shown by corrupting what was already read, which a
// second read would pick up), a rewrite or rewind reads everything again, an unreadable source changes nothing.
describe('incremental parse state of agy, Vibe and OpenCode', () => {
  const entries = (): any[] => python('import history\nhistory.refresh()\nhistory.flush()\nprint(json.dumps([e["s"] for e in history._files.values()]))');
  const only = (agent: string): any => entries().find(s => s.agent === agent);

  test('agy: lines appended after the byte cursor; a shrunk, rewritten in place or replaced transcript is read again', () => {
    const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', AGY_ID, '.system_generated', 'logs', 'transcript.jsonl');
    const pad = 'x'.repeat(400);
    const step = (type: string, content: string): object => ({type, created_at: '2026-11-03T08:00:00Z', content});
    jsonl(file, [step('USER_INPUT', 'first agy request'), step('PLANNER_RESPONSE', `${pad} one`),
      step('USER_INPUT', 'second agy request'), step('PLANNER_RESPONSE', `${pad} two`)]);
    assert.deepEqual([only('agy').first, only('agy').n_user], ['first agy request', 2]);

    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('first agy request', 'FIRST agy request'));   // already read: must not be read again
    fs.appendFileSync(file, JSON.stringify(step('USER_INPUT', 'third agy request')) + '\n');
    assert.deepEqual([only('agy').first, only('agy').n_user], ['first agy request', 3], 'only the appended line was read');

    fs.appendFileSync(file, JSON.stringify(step('USER_INPUT', 'half written')));   // no newline yet
    assert.equal(only('agy').n_user, 3, 'an incomplete last line waits');
    fs.appendFileSync(file, '\n');
    assert.equal(only('agy').n_user, 4);

    const rewritten = fs.readFileSync(file, 'utf8').replace(`${pad} two`, `${pad} TWO`);   // same size: the bytes before the cursor changed
    fs.writeFileSync(file, rewritten + JSON.stringify(step('USER_INPUT', 'fifth agy request')) + '\n');
    assert.deepEqual([only('agy').first, only('agy').n_user], ['FIRST agy request', 5], 'a rewrite in place is detected');

    const same = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(`${file}.tmp`, same.replace('FIRST', 'NEWER') + JSON.stringify(step('USER_INPUT', 'sixth')) + '\n');
    fs.renameSync(`${file}.tmp`, file);   // another inode, the same bytes before the cursor
    assert.equal(only('agy').first, 'NEWER agy request', 'a replaced file is read again');

    jsonl(file, [step('USER_INPUT', 'short')]);
    assert.deepEqual([only('agy').first, only('agy').n_user], ['short', 1], 'a transcript shorter than the cursor is read again');
  });

  describe('Vibe', () => {
    const root = (): string => path.join(home, '.vibe', 'logs', 'session', 'unified', VIBE_ID);
    const digest = (c: string): string => c.repeat(64);
    const meta = (title: string): void => {
      fs.mkdirSync(root(), {recursive: true});
      fs.writeFileSync(path.join(root(), 'meta.json'), JSON.stringify({session_id: VIBE_ID, start_time: '2026-11-04T07:00:00Z', title}));
    };
    const chunk = (c: string, ...texts: string[]): void => {
      fs.mkdirSync(path.join(root(), 'chunks'), {recursive: true});
      fs.writeFileSync(path.join(root(), 'chunks', `${digest(c)}.json`),
        JSON.stringify(texts.map(content => ({message: {role: 'user', content}}))));
    };
    const generation = (n: number, manifest: unknown): void => {
      const gen = path.join(root(), 'generations', String(n).padStart(16, '0'));
      fs.mkdirSync(gen, {recursive: true});
      fs.writeFileSync(path.join(gen, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    };
    const chunks = (...names: string[]): object => ({checkpoint: {chunks: names.map(digest)}});

    test('a new generation reads only the chunks not read before; a dropped chunk, an unreadable one and a bad manifest', () => {
      meta('T1');
      chunk('a', 'vibe one');
      generation(1, chunks('a'));
      assert.deepEqual([only('vibe').n_user, only('vibe').first], [1, 'vibe one']);

      fs.writeFileSync(path.join(root(), 'chunks', `${digest('a')}.json`), '{ corrupted');   // read already: not read again
      chunk('b', 'vibe two');
      generation(2, chunks('a', 'b'));
      assert.deepEqual([only('vibe').n_user, only('vibe').first], [2, 'vibe one']);

      generation(3, chunks('a', 'b', 'c'));   // chunk c is not there yet: nothing is lost, it is read when it appears
      assert.equal(only('vibe').n_user, 2);
      chunk('c', 'vibe three');
      assert.equal(only('vibe').n_user, 3);

      chunk('d', 'vibe rewritten');
      generation(4, chunks('d'));   // the new manifest dropped chunks that were read: everything is read again
      assert.deepEqual([only('vibe').n_user, only('vibe').first], [1, 'vibe rewritten']);

      meta('T2');
      generation(5, '{ not json');
      assert.deepEqual([only('vibe').title, only('vibe').n_user], ['T2', 1], 'an unreadable manifest keeps the transcript state');
    });
  });

  describe('OpenCode', () => {
    const db = (): string => path.join(env.XDG_DATA_HOME!, 'opencode', 'opencode.db');
    const sqlite = (code: string): void => {
      execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import json, sqlite3, sys, time\ncon = sqlite3.connect(sys.argv[1])\n${code}\ncon.commit()`,
        db(), OPENCODE_ID, work], {env});
    };
    const build = (): void => {
      fs.mkdirSync(path.dirname(db()), {recursive: true});
      sqlite(`
con.executescript("""
CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, title text, version text, time_created integer, time_updated integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
""")
con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?)", (sys.argv[2], sys.argv[3], None, "T", "1.18.35", 1000, 5000))
`);
    };
    const say = (n: number, role: string, text: string, extra: object = {}): void =>
      sqlite(`
mid = "m${n}"
con.execute("INSERT OR REPLACE INTO message VALUES (?,?,?,?,?)", (mid, sys.argv[2], 1000 + ${n}, 1000 + ${n}, json.dumps({"role": "${role}", **${JSON.stringify(extra)}})))
con.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?,?,?)", ("p${n}", mid, sys.argv[2], 1000 + ${n}, 1000 + ${n}, json.dumps({"type": "text", "text": ${JSON.stringify(text)}})))`);
    const touch = (ms: string): void => sqlite(`con.execute("UPDATE session SET time_updated = ? WHERE id = ?", (${ms}, sys.argv[2]))`);
    const view = (): any => {
      const s = only('opencode');
      return [s.n_user, s.n_assistant, s.first, s.last_user, s.last_assistant, s.tin];
    };

    test('messages after the row cursor only; the newest one is read again while the conversation is active; a rewind reads all', () => {
      build();
      say(1, 'user', 'first oc prompt');
      say(2, 'assistant', 'oc answer', {tokens: {input: 5, output: 1}});
      assert.deepEqual(view(), [1, 1, 'first oc prompt', 'first oc prompt', 'oc answer', 5]);

      sqlite(`con.execute("UPDATE message SET data = ? WHERE id = 'm1'", (json.dumps({"role": "assistant"}),))`);   // settled: not read again
      say(3, 'user', 'later oc prompt');
      touch('9000');
      assert.deepEqual(view(), [2, 1, 'first oc prompt', 'later oc prompt', 'oc answer', 5], 'only the new message was read');

      touch('int(time.time() * 1000)');   // active: the newest message may still be written
      say(4, 'assistant', 'partial', {tokens: {input: 0, output: 0}});
      assert.deepEqual(view(), [2, 2, 'first oc prompt', 'later oc prompt', 'partial', 5]);
      say(4, 'assistant', 'final answer', {tokens: {input: 7, output: 3}});
      touch('int(time.time() * 1000) + 1');
      assert.deepEqual(view(), [2, 2, 'first oc prompt', 'later oc prompt', 'final answer', 12], 'the open message replaced, not added');
      touch('9999');
      assert.deepEqual(view(), [2, 2, 'first oc prompt', 'later oc prompt', 'final answer', 12], 'settled once idle');

      sqlite(`con.execute("DELETE FROM message WHERE id IN ('m3','m4')")\ncon.execute("DELETE FROM part WHERE id IN ('p3','p4')")`);
      touch('10000');
      assert.deepEqual(view(), [0, 2, '', '', 'oc answer', 5], 'the cursor row is gone: everything is read again (m1 now reads as an assistant message)');
    });

    test('a locked store keeps the state; it is picked up when the store opens again', () => {
      build();
      say(1, 'user', 'first oc prompt');
      assert.equal(view()[0], 1);
      say(2, 'user', 'second oc prompt');
      touch('9000');
      const lock = new DatabaseSync(db());
      lock.exec('BEGIN EXCLUSIVE');
      try {
        assert.equal(view()[0], 1, 'the locked store is not read and not forgotten');
      } finally {
        lock.exec('ROLLBACK');
        lock.close();
      }
      assert.equal(view()[0], 2);
    });
  });
});
