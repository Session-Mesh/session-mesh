// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The REAL OpenCode 2 binary (MESH_OPENCODE_V2_BIN; tested: 2.3.0), a scripted OpenAI-compatible provider instead of a
// model, a stand-in board bridge, and a local endpoint standing in for the mesh's /api/event. Skipped without the
// binary. Everything runs in a temporary HOME and XDG_* directories. What it establishes on the real binary:
//   - the configuration Mesh injects (from the real `debug config --standalone`) merges with the user's own: a
//     disabled mesh-board, a permission rule survive; the tools reach the model through `execute`;
//   - --standalone makes the token and the environment those of the process launched: two terminals share nothing;
//   - the plugin reports working, permission waits, question waits and the end of a turn, with the root conversation;
//   - a resumed conversation is checked in the real store, and the real binary recalls it.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, RealOpencode, skipReal, startListener} from './helpers/opencode-v2-real.ts';

const oc = new RealOpencode();
let listener: Awaited<ReturnType<typeof startListener>>;
let stubDir: string;
let stubLog: string;
const PEERS = '[[execute: const peers = await tools["mesh-board"]["agent_peers"](); console.log(JSON.stringify(peers));]]';

before(async () => {
  if (skipReal) return;
  await oc.start();
  listener = await startListener();
  stubDir = path.join(oc.scratch, 'meshbin');
  stubLog = path.join(oc.scratch, 'stub.log');
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, 'mesh-board-mcp'),
    `#!/bin/sh\nexec '${process.execPath}' '${path.join(REPO, 'tests', 'fixtures', 'fake-board-mcp.mjs')}'\n`, {mode: 0o755});
});
after(async () => {
  if (skipReal) return;
  await listener?.close();
  await oc.stop();
});

/** What the mesh would type for `command`, run by Python against the real binary and the user's configuration. */
function launchLine(command = 'opencode', cwd = oc.work): {line?: string; refused?: string} {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})
import asyncio, json, server
from aiohttp import web
try:
    line, notice = asyncio.run(server._opencode_command(${JSON.stringify(command)}, ${JSON.stringify(cwd)}))
    print(json.dumps({"line": line, "notice": notice}))
except web.HTTPConflict as exc:
    print(json.dumps({"refused": exc.text}))
`], {cwd: REPO, encoding: 'utf8', env: oc.env({MESH_BIN_DIR: stubDir, MESH_PORT: String(listener.port),
    MESH_CONF_DIR: path.join(oc.scratch, 'conf')})});
  return JSON.parse(output);
}

function injected(command = 'opencode'): Record<string, any> {
  const line = launchLine(command).line!;
  assert.match(line, /^env OPENCODE_CONFIG_CONTENT='/);
  return JSON.parse(/^env OPENCODE_CONFIG_CONTENT='(.*)' \S*opencode /.exec(line)![1]);
}

const stubEntries = (): any[] => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const reset = () => { fs.rmSync(stubLog, {force: true}); listener.requests.length = 0; };
const mesh = (token: string) => ({MESH_SESSION_TOKEN: token, MESH_PORT: String(listener.port), STUB_LOG: stubLog});
const stateTypes = (token: string) => listener.requests.filter(item => item.auth === `MeshSession ${token}`).map(item => item.body.type);
const toolNames = (output: unknown): string[] => JSON.parse(/\[.*\]/s.exec(String(output))![0]);

describe('the injected configuration on the real OpenCode 2', {skip: skipReal}, () => {
  test('the bridge is a tool of `execute`, and its structured result reaches the model', async () => {
    reset();
    oc.writeUserConfig(null);
    const result = await oc.run(`list peers ${PEERS}`, injected(), mesh('tok-a'));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.texts.some(text => text.includes('zebra-peer-42')), `the model saw the peer: ${result.texts}`);
    const started = stubEntries().find(entry => entry.started);
    assert.ok(started, 'the bridge was started');
    assert.deepEqual([started.token, started.port], ['tok-a', String(listener.port)],
      'the bridge has the token of the process that launched OpenCode, and the pinned port');
    assert.ok(stubEntries().some(entry => entry.method === 'tools/call'));
  });

  test('the user\'s `disabled: true` on mesh-board survives (native form)', async () => {
    reset();
    oc.writeUserConfig({mcp: {servers: {'mesh-board': {type: 'local', command: ['/bin/false'], disabled: true}}}});
    const config = injected();
    assert.equal(config.mcp, undefined, 'Mesh read the choice and did not inject the server');
    const result = await oc.run('names [[execute: console.log(JSON.stringify(Object.keys(tools)));]]', config, mesh('tok-b'));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!toolNames(result.tools[0].output).includes('mesh-board'));
    assert.deepEqual(stubEntries(), [], 'the bridge never ran');
    assert.ok(stateTypes('tok-b').includes('done'), 'the state plugin is loaded all the same');
  });

  test('the user\'s `enabled: false` (1.x form) is normalised by OpenCode 2 and survives too', async () => {
    reset();
    oc.writeUserConfig({mcp: {'mesh-board': {type: 'local', command: ['/bin/false'], enabled: false}}});
    const config = injected();
    assert.equal(config.mcp, undefined);
    const result = await oc.run('names [[execute: console.log(JSON.stringify(Object.keys(tools)));]]', config, mesh('tok-c'));
    assert.ok(!toolNames(result.tools[0].output).includes('mesh-board'));
    assert.deepEqual(stubEntries(), []);
  });

  test('a project that disables mesh-board is read as well', async () => {
    reset();
    oc.writeUserConfig(null);
    fs.writeFileSync(path.join(oc.work, 'opencode.json'),
      JSON.stringify({mcp: {servers: {'mesh-board': {type: 'local', command: ['/bin/false'], disabled: true}}}}));
    try {
      assert.equal(injected().mcp, undefined);
    } finally {
      fs.rmSync(path.join(oc.work, 'opencode.json'));
    }
  });

  test('without the injection the user\'s disabled server is indeed off (the control for the two tests above)', async () => {
    reset();
    oc.writeUserConfig({mcp: {servers: {'mesh-board': {type: 'local', command: ['node', path.join(REPO, 'tests', 'fixtures', 'fake-board-mcp.mjs')], disabled: true}}}});
    const result = await oc.run('names [[execute: console.log(JSON.stringify(Object.keys(tools)));]]', {}, mesh('tok-d'));
    assert.ok(!toolNames(result.tools[0].output).includes('mesh-board'));
    // And what an injection that ignored the choice would do: the replaced object has no `disabled`.
    const naive = {mcp: {servers: {'mesh-board': {type: 'local', command: [path.join(stubDir, 'mesh-board-mcp')]}}}};
    const wrong = await oc.run('names [[execute: console.log(JSON.stringify(Object.keys(tools)));]]', naive, mesh('tok-d'));
    assert.ok(toolNames(wrong.tools[0].output).includes('mesh-board'), 'a naive injection would have turned the server back on');
  });

  test('the user\'s permission rule on the bridge\'s tools survives: a denied tool is not called', async () => {
    reset();
    oc.writeUserConfig({permissions: [{action: 'mesh-board_agent_peers', resource: '*', effect: 'deny'}]});
    const result = await oc.run(`list peers ${PEERS}`, injected(), mesh('tok-e'));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.texts.some(text => text.includes('zebra-peer-42')), 'the peer list was not returned');
    assert.ok(!stubEntries().some(entry => entry.method === 'tools/call'), 'the bridge never received the call');
  });
});

describe('--standalone: the token and the environment are the launched process\'s own', {skip: skipReal}, () => {
  test('two terminals at once, then a third without a token: each bridge and plugin has its own and nothing is inherited', async () => {
    reset();
    oc.writeUserConfig(null);
    const config = injected();
    const logs = ['one', 'two', 'three'].map(name => path.join(oc.scratch, `stub-${name}.log`));
    const runs = await Promise.all([
      oc.run(`list peers ${PEERS}`, config, {...mesh('tok-one'), STUB_LOG: logs[0], MESH_SESSION: 'one'}),
      oc.run(`list peers ${PEERS}`, config, {...mesh('tok-two'), STUB_LOG: logs[1], MESH_SESSION: 'two'}),
      oc.run(`list peers ${PEERS}`, config, {MESH_PORT: String(listener.port), STUB_LOG: logs[2]}),
    ]);
    for (const run of runs) assert.equal(run.code, 0, run.stderr);
    const started = logs.map(file => JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]));
    assert.deepEqual(started.map(entry => entry.token), ['tok-one', 'tok-two', null]);
    assert.deepEqual(started.map(entry => entry.session), ['one', 'two', null]);
    // The plugin reports with the token of its own process; the conversation of a request is that process's.
    const bySession = new Map<string, Set<string>>();
    for (const {auth, body} of listener.requests) {
      const set = bySession.get(body.detail.session) ?? new Set<string>();
      set.add(auth ?? 'none');
      bySession.set(body.detail.session, set);
    }
    assert.deepEqual([...bySession.get(runs[0].sessionID!)!], ['MeshSession tok-one']);
    assert.deepEqual([...bySession.get(runs[1].sessionID!)!], ['MeshSession tok-two']);
    assert.ok(!bySession.has(runs[2].sessionID!), 'a process with no token reports nothing');
    assert.ok(![...listener.requests].some(item => item.auth === 'MeshSession tok-three'));
  });

  test('no process of this scratch is left behind (no shared service was started)', () => {
    const mine = execFileSync('/bin/sh', ['-c', `grep -l '${oc.scratch}' /proc/[0-9]*/environ 2>/dev/null | wc -l`], {encoding: 'utf8',
      env: {PATH: '/usr/bin:/bin'}});
    assert.equal(Number(mine.trim()), 0, 'no process of this scratch is left running');
  });
});

describe('the state the plugin reports from the real events', {skip: skipReal}, () => {
  test('a turn: working, then done, with the conversation', async () => {
    reset();
    oc.writeUserConfig(null);
    const result = await oc.run('say hi', injected(), mesh('tok-s1'));
    assert.deepEqual(stateTypes('tok-s1'), ['working', 'done']);
    assert.ok(listener.requests.every(item => item.body.detail.session === result.sessionID));
  });

  test('a question put to the user: waiting_question, then working again when it is cancelled', async () => {
    reset();
    const result = await oc.run('ask [[question]]', injected(), mesh('tok-s2'));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stateTypes('tok-s2'), ['working', 'waiting_question', 'working', 'done']);
  });

  test('a permission request on the bridge\'s tool: waiting_permission, then working again once it is refused', async () => {
    reset();
    oc.writeUserConfig({permissions: [{action: 'mesh-board_agent_peers', resource: '*', effect: 'ask'}]});
    const result = await oc.run(`list peers ${PEERS}`, injected(), mesh('tok-s3'));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stateTypes('tok-s3'), ['working', 'waiting_permission', 'working', 'done']);
    oc.writeUserConfig(null);
  });

  test('a slow turn is working the whole time: done comes only after the answer', async () => {
    reset();
    const started = Date.now();
    await oc.run('slow [[slow 2500]]', injected(), mesh('tok-s4'));
    const events = listener.requests.filter(item => item.auth === 'MeshSession tok-s4');
    const done = events.find(item => item.body.type === 'done')!;
    assert.ok(done.body.at * 1000 - started > 2400, 'done was reported after the 2.5 s answer, not before');
  });
});

describe('resume on the real store', {skip: skipReal}, () => {
  test('a conversation of the real store is verified and resumed with its history; an unknown id is refused', async () => {
    reset();
    oc.writeUserConfig(null);
    const first = await oc.run('remember the codeword PELICAN-77', injected(), mesh('tok-r1'));
    assert.equal(first.code, 0, first.stderr);
    const known = launchLine(`opencode --session ${first.sessionID}`);
    assert.match(known.line!, new RegExp(`opencode --standalone --session ${first.sessionID}$`));
    const unknown = launchLine('opencode --session ses_doesnotexist0000000000');
    assert.match(unknown.refused!, /would start an empty conversation/);
    const resumed = await oc.run('what was the codeword?', injected(), mesh('tok-r2'), ['--session', first.sessionID!]);
    assert.equal(resumed.sessionID, first.sessionID);
    const last = oc.provider.requests.at(-1) as {messages: {content: unknown}[]};
    assert.ok(JSON.stringify(last.messages).includes('PELICAN-77'), 'the model received the earlier conversation');
  });
});
