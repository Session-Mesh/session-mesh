// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the mesh launches for each OpenCode major: 1.x (v1 configuration), 2.x (--standalone, the v2
// configuration and plugin, the user's choices kept, a resumed conversation checked first), any other or
// unreadable version (bare, no token, a notice). A fake `opencode` that answers --version and
// `debug config --standalone` stands in for the binary (no real OpenCode, no model, no service).
// The Python modules the server uses are run with an isolated HOME and a PATH that holds only the fake.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {addConversationV2, createStoreV2} from './helpers/opencode-store.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const KNOWN = 'ses_e1ec1ceb2ffeve47ULriArjJ5g';
let scratch: string;
let meshBin: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-v2-'));
  meshBin = path.join(scratch, 'meshbin');
  fs.mkdirSync(meshBin);
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
});
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

/** A directory holding an `opencode` shell script; `body` is what it does. */
function fakeOpencode(body: string): string {
  const dir = fs.mkdtempSync(path.join(scratch, 'bin-'));
  fs.writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\n${body}\n`, {mode: 0o755});
  return dir;
}
const answering = (text: string): string => fakeOpencode(`[ "$1" = "--version" ] && echo '${text}'`);
/** An OpenCode 2 whose `debug config --standalone` prints `documents` (JSON), or fails when it is null. */
function v2With(documents: unknown[] | null): string {
  const dir = fakeOpencode('');
  const config = path.join(dir, 'documents.json');
  fs.writeFileSync(config, JSON.stringify(documents ?? []));
  fs.writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh
[ "$1" = "--version" ] && { echo 'opencode v2.3.0'; exit 0; }
[ "$1 $2 $3" = "debug config --standalone" ] || exit 9
${documents === null ? 'exit 3' : `cat '${config}'`}
`, {mode: 0o755});
  return dir;
}

function python(code: string, bin: string, extra: Record<string, string> = {}): unknown {
  const home = extra.HOME ?? fs.mkdtempSync(path.join(scratch, 'home-'));
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: `${bin}:/usr/bin:/bin`, HOME: home, MESH_BIN_DIR: meshBin, ...extra}});
  return JSON.parse(output);
}

type Launch = {line?: string; notice?: string | null; refused?: string};
const launchRaw = (bin: string, command = 'opencode', extra: Record<string, string> = {}): Launch => python(`
import asyncio, json, server
from aiohttp import web
try:
    line, notice = asyncio.run(server._opencode_command(${JSON.stringify(command)}, "/"))
    print(json.dumps({"line": line, "notice": notice}))
except web.HTTPConflict as exc:
    print(json.dumps({"refused": exc.text}))
`, bin, extra) as Launch;
// The line names the binary that was read (see 'the binary that was read is the one that runs'): the other tests
// compare it with the bare name.
const bare = (result: Launch, bin: string): Launch =>
  result.line === undefined ? result : {...result, line: result.line.replace(path.join(bin, 'opencode'), 'opencode')};

const launch = (bin: string, command = 'opencode', extra: Record<string, string> = {}): Launch =>
  bare(launchRaw(bin, command, extra), bin);

const configOf = (line: string): Record<string, any> =>
  JSON.parse(/^env OPENCODE_CONFIG_CONTENT='(.*)' opencode /.exec(line)![1]);
const BARE = 'env -u MESH_SESSION_TOKEN opencode';

describe('the binary that was read is the one that runs', () => {
  test('the launch line names the resolved executable, for 1.x, 2.x and a bare launch', () => {
    for (const bin of [answering('1.18.35'), v2With([]), answering('opencode v3.0.1')]) {
      const line = launchRaw(bin).line!;
      assert.ok(line.includes(` ${path.join(bin, 'opencode')}`), line);
    }
  });

  test('no opencode found leaves the command as it is; one found but unreadable is still named', () => {
    const unreadable = answering('hello');
    assert.equal(launchRaw(unreadable).line, `env -u MESH_SESSION_TOKEN ${path.join(unreadable, 'opencode')}`);
    assert.equal(launchRaw(fs.mkdtempSync(path.join(scratch, 'empty-'))).line, BARE);
  });
});

describe('OpenCode 1.x', () => {
  test('keeps the v1 injection, without the token and without --standalone', () => {
    const result = launch(answering('1.18.35'), 'opencode --session ses_x');
    assert.equal(result.notice, null);
    assert.match(result.line!, /^env OPENCODE_CONFIG_CONTENT='\{.*\}' opencode --session ses_x$/);
    assert.ok(!/MESH_SESSION_TOKEN|standalone/.test(result.line!));
    const config = configOf(result.line!);
    assert.deepEqual(Object.keys(config).sort(), ['mcp', 'plugin']);
  });
});

describe('OpenCode 2.x', () => {
  test('is started with --standalone, the v2 configuration (mcp.servers, plugins), no token, no notice', () => {
    const result = launch(v2With([]));
    assert.equal(result.notice, null);
    assert.match(result.line!, /^env OPENCODE_CONFIG_CONTENT='\{.*\}' opencode --standalone$/);
    assert.ok(!/MESH_SESSION_TOKEN/.test(result.line!));
    const config = configOf(result.line!);
    assert.deepEqual(Object.keys(config).sort(), ['mcp', 'plugins']);
    assert.deepEqual(Object.keys(config.mcp), ['servers']);
    assert.equal(config.mcp.servers['mesh-board'].type, 'local');
    assert.deepEqual(config.mcp.servers['mesh-board'].command, [path.join(meshBin, 'mesh-board-mcp')]);
    assert.deepEqual(config.plugins, [{package: path.join(REPO, 'opencode-mesh-plugin-v2')}]);
    assert.ok(fs.existsSync(path.join(config.plugins[0].package, 'index.ts')));
  });

  test('--standalone is not repeated, and the other options 2.x takes are kept', () => {
    const line = launch(v2With([]), 'opencode --standalone --auto --log-level debug /srv/project').line!;
    assert.match(line, / opencode --standalone --auto --log-level debug \/srv\/project$/);
  });

  test('a user who disabled mesh-board (global, project or inline document) keeps that choice: no server is injected', () => {
    for (const documents of [
      [{type: 'document', path: '/g', info: {mcp: {servers: {'mesh-board': {type: 'local', command: ['x'], disabled: true}}}}}],
      [{type: 'document', info: {mcp: {servers: {other: {}}}}}, {type: 'document', info: {mcp: {servers: {'mesh-board': {disabled: true}}}}}],
    ]) {
      const config = configOf(launch(v2With(documents)).line!);
      assert.equal(config.mcp, undefined);
      assert.equal(config.plugins.length, 1, 'the state plugin is still loaded');
    }
  });

  test('an enabled or absent mesh-board in the user\'s documents does not stop the injection', () => {
    const documents = [{type: 'document', info: {mcp: {servers: {'mesh-board': {type: 'local', command: ['x'], disabled: false}}}}},
      {type: 'directory', path: '/x'}, {type: 'document', info: {permissions: [{action: 'mesh-board_*', resource: '*', effect: 'deny'}]}}];
    assert.ok(configOf(launch(v2With(documents)).line!).mcp.servers['mesh-board']);
  });

  test('a configuration that cannot be read injects the plugin but no server', () => {
    const config = configOf(launch(v2With(null)).line!);
    assert.equal(config.mcp, undefined);
    assert.equal(config.plugins.length, 1);
  });

  test('the configuration probe runs with no Mesh variable and never starts the shared service', () => {
    const bin = fakeOpencode(`[ "$1" = "--version" ] && { echo 'opencode v2.3.0'; exit 0; }
[ "$1 $2 $3" = "debug config --standalone" ] || exit 9
env | grep -c '^MESH_' >&2 && exit 4
echo '[]'`);
    const result = launch(bin, 'opencode', {MESH_SESSION_TOKEN: 'secret', MESH_PORT: '7690'});
    assert.match(result.line!, /--standalone$/);
    assert.ok(configOf(result.line!).mcp, 'the probe succeeded, so no MESH_ variable reached it');
  });

  test('a resumed conversation is checked in the store: a known one is resumed, an unknown one refused', () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const data = path.join(home, 'data');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const store = createStoreV2(path.join(data, 'opencode', 'opencode.db'));
    addConversationV2(store, KNOWN, home, {updated: Date.now() - 1000});
    store.close();
    const bin = v2With([]);
    const extra = {HOME: home, XDG_DATA_HOME: data};
    for (const flags of [`--session ${KNOWN}`, `-s ${KNOWN}`, `--session=${KNOWN}`]) {
      assert.match(launch(bin, `opencode ${flags}`, extra).line!, / opencode --standalone (--session[ =]|-s )/, flags);
    }
    for (const flags of ['--session ses_doesnotexist0000000000', '-s ses_doesnotexist0000000000', '--session=', '-s']) {
      assert.match(launch(bin, `opencode ${flags}`, extra).refused!, /would start an empty conversation/, flags);
    }
    assert.match(launch(bin, 'opencode --session ses_x', {HOME: fs.mkdtempSync(path.join(scratch, 'home-'))}).refused!, /empty conversation/,
      'no store at all: not verified, so refused');
  });

  test('a migrated 1.x conversation (only in the old session table) can be resumed too', () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const data = path.join(home, 'data');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const store = createStoreV2(path.join(data, 'opencode', 'opencode.db'), {legacySession: true});
    addConversationV2(store, KNOWN, home, {updated: Date.now() - 1000, legacyOnly: true});
    store.close();
    assert.match(launch(v2With([]), `opencode --session ${KNOWN}`, {HOME: home, XDG_DATA_HOME: data}).line!, /--session/);
  });

  test('options 2.x does not have: model, mini and replay options are dropped; --pure, --agent, --server, --fork refuse', () => {
    const bin = v2With([]);
    const line = launch(bin, 'opencode --model a/b -m c/d --mini --no-replay --replay-limit 5 --model=x').line!;
    assert.match(line, / opencode --standalone$/);
    for (const option of ['--pure', '--agent plan', '--server http://127.0.0.1:1', '--fork', '--unknown']) {
      assert.match(launch(bin, `opencode ${option}`).refused!, /does not take the option/, option);
    }
  });
});

describe('any other major, or an unreadable version', () => {
  test('is launched bare: no configuration, the token removed from the agent environment, a notice', () => {
    for (const text of ['opencode v3.0.1', '12.0.0', '0.9.0']) {
      const result = launch(answering(text));
      assert.equal(result.notice, 'opencode-unsupported', text);
      assert.equal(result.line, BARE, text);
    }
  });

  test('an unreadable version is bare as well, with its own notice', () => {
    for (const bin of [answering('hello'), answering(''), fakeOpencode('exit 3'), fakeOpencode('sleep 30')]) {
      const result = launch(bin);
      assert.equal(result.notice, 'opencode-unreadable');
      assert.equal(result.line, BARE);
    }
  });

  test('no opencode on the PATH is unreadable as well, and a resume says so (not "not supported")', () => {
    const empty = fs.mkdtempSync(path.join(scratch, 'empty-'));
    assert.equal(launch(empty).notice, 'opencode-unreadable');
    assert.match(launch(empty, 'opencode --session ses_x').refused!, /could not be read/);
    assert.match(launch(answering('opencode v3.0.1'), 'opencode --session ses_x').refused!, /not supported/);
  });

  test('a conversation is never resumed by --session, -s, --continue or --fork', () => {
    const bin = answering('opencode v3.0.1');
    for (const flags of ['--session ses_x', '-s ses_x', '--session=ses_x', '--continue', '-c', '--fork']) {
      assert.match(launch(bin, `opencode ${flags}`).refused!, /cannot be resumed/, flags);
    }
    assert.equal(launch(bin, 'opencode --model a/b').line, `${BARE} --model a/b`);
  });
});

describe('the version probe', () => {
  test('the version of the binary that changes is read again (cache keyed by path, size, mtime)', () => {
    const dir = answering('1.18.35');
    const code = `
import asyncio, json, os, server
first = asyncio.run(server._opencode_command("opencode", "/"))[1]
path = os.path.join(${JSON.stringify(dir)}, "opencode")
open(path, "w").write("#!/bin/sh\\n[ \\"$1\\" = --version ] && echo 'opencode v3.1.0'\\n")
os.utime(path, (1, 1))
second = asyncio.run(server._opencode_command("opencode", "/"))[1]
print(json.dumps([first, second]))`;
    assert.deepEqual(python(code, dir), [null, 'opencode-unsupported']);
  });

  test('the probe runs without any Mesh variable, with stdin closed, from a neutral folder', () => {
    const bin = fakeOpencode(`env | grep -c '^MESH_' >&2; [ "$(pwd)" = / ] || exit 4; read x && exit 5; echo 1.0.0`);
    const result = python(`
import asyncio, json, os, server
os.environ["MESH_SESSION_TOKEN"] = "secret"
print(json.dumps(asyncio.run(server._opencode_command("opencode", "/"))[1]))`, bin);
    assert.equal(result, null);
  });
});

describe('a bare OpenCode session', () => {
  const listing = (meta: object): unknown => python(`
import json, server
raw = {"name": "s", "pid": 1, "cwd": "/", "created": 1.0, "activity": 1.0, "attached": 0, "meta": ${JSON.stringify(meta)}}
print(json.dumps({"mail": server._agent_mail_live([raw]), "notice": server._session_notice(raw)}))`, '/usr/bin');

  test('has no mailbox and is flagged', () => {
    for (const notice of ['opencode-unsupported', 'opencode-unreadable']) {
      assert.deepEqual(listing({known_agent: 'opencode', notice}), {mail: [], notice});
    }
  });

  test('an OpenCode session that is supported keeps its mailbox', () => {
    assert.deepEqual(listing({known_agent: 'opencode'}),
      {mail: [{id: 's', created: 1, agent: 'opencode'}], notice: null});
  });

  test('an unknown notice is ignored', () => {
    assert.equal((listing({known_agent: 'opencode', notice: 'x'}) as {notice: unknown}).notice, null);
  });
});

describe('a hook report of an earlier OpenCode process', () => {
  const applied = (received: number): {session_id: string; status: string} => python(`
import json, server
agent = {"type": "opencode", "started": 1000.0, "session_id": "ses_typedbyhandCCCCCCCC", "status": "idle"}
hook = {"type": "working", "received": ${received}, "detail": {"source": "opencode", "session": "ses_staleconversationBB"}}
server._apply_reported_state([{"agent": agent, "hook": hook}])
print(json.dumps({"session_id": agent["session_id"], "status": agent["status"]}))`, '/usr/bin') as {session_id: string; status: string};

  test('does not override the conversation and state of an OpenCode typed by hand in the same terminal', () => {
    assert.deepEqual(applied(500), {session_id: 'ses_typedbyhandCCCCCCCC', status: 'idle'});
  });

  test('a report received after the process started still applies (the start time has a one second error)', () => {
    assert.deepEqual(applied(1000), {session_id: 'ses_staleconversationBB', status: 'busy'});
    assert.deepEqual(applied(998.5), {session_id: 'ses_staleconversationBB', status: 'busy'});
  });
});

describe('moving an OpenCode from another terminal into the mesh (resume_target)', () => {
  // The real resume_target with a `sleep` standing for the agent process and a stub PTY host: the question is
  // whether the process is stopped before the launch line is refused.
  const adopt = (bin: string, extra: Record<string, string> = {}): {outcome: string; alive: boolean} => python(`
import asyncio, json, os, subprocess, server
victim = subprocess.Popen(["sleep", "60"])
async def fake_host(message):
    return [] if message.get("op") == "list" else {"ok": True}
server.host = fake_host
server._resume_argv = lambda agent: ["opencode", "--session", "${KNOWN}"]
target = {"cwd": os.getcwd(), "agent": {"type": "opencode", "pid": victim.pid, "session_id": "${KNOWN}"}}
try:
    asyncio.run(server.resume_target(target))
    outcome = "relaunched"
except Exception as exc:
    outcome = type(exc).__name__ + ": " + str(getattr(exc, "text", exc))
alive = victim.poll() is None
if alive:
    victim.kill()
print(json.dumps({"outcome": outcome, "alive": alive}))
`, bin, extra) as {outcome: string; alive: boolean};

  test('an unreadable version, an unsupported major, or an unknown 2.x conversation: refused, the agent keeps running', () => {
    for (const [bin, pattern] of [[fs.mkdtempSync(path.join(scratch, 'empty-')), /could not be read/],
      [answering('opencode v3.0.1'), /not supported/], [v2With([]), /empty conversation/]] as [string, RegExp][]) {
      const result = adopt(bin);
      assert.match(result.outcome, /HTTPConflict/, result.outcome);
      assert.match(result.outcome, pattern);
      assert.equal(result.alive, true, 'the process was not stopped');
    }
  });

  test('OpenCode 1.x, and a 2.x whose conversation is in the store, are stopped and relaunched', () => {
    assert.deepEqual(adopt(answering('1.18.35')), {outcome: 'relaunched', alive: false});
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const data = path.join(home, 'data');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const store = createStoreV2(path.join(data, 'opencode', 'opencode.db'));
    addConversationV2(store, KNOWN, home, {updated: Date.now() - 1000});
    store.close();
    assert.deepEqual(adopt(v2With([]), {HOME: home, XDG_DATA_HOME: data}), {outcome: 'relaunched', alive: false});
  });
});
