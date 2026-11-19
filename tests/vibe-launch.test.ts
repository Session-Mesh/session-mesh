// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the server does before it hands a command to Mistral Vibe (server._vibe_launch and the paths that use it),
// run in a Python subprocess against an isolated HOME and conf directory: no Vibe, no model, no PTY host (server.host
// is replaced by a recorder). Covered: the board limits read from the session's folder (and refused when that file is a
// FIFO, a device or too large), the hooks directory prepared BEFORE an external agent is stopped, the directory recorded
// in the session and swept when no session claims it, "restart when idle" refused for Vibe.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = 'e98ebb44-7316-c2a7-62cf-582ea59f42f6';
let scratch: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  for (const name of ['mesh-board-mcp', 'mesh-event']) fs.writeFileSync(path.join(scratch, 'bin', name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
});
after(() => {
  execFileSync('chmod', ['-R', 'u+rwX', scratch]);
  fs.rmSync(scratch, {recursive: true, force: true});
});

/** Run Python code with the server imported; the code prints one JSON value, returned parsed. `conf` is the mesh's conf dir. */
function py(conf: string, code: string): any {
  const program = `import sys, os, json, asyncio, shlex, subprocess, types
sys.path.insert(0, ${JSON.stringify(REPO)})
import server, agentmcp
from aiohttp import web
${code}`;
  const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', program], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: conf, MESH_BIN_DIR: path.join(scratch, 'bin'), VIBE_HOME: path.join(scratch, 'vibe-home')}});
  return JSON.parse(out.trim().split('\n').pop()!);
}

/** A fresh project folder and conf directory; `config` is the content of <folder>/.vibe/config.toml when given. */
function fixture(name: string, config?: string): {cwd: string; conf: string} {
  const cwd = path.join(scratch, name, 'project');
  const conf = path.join(scratch, name, 'conf');
  fs.mkdirSync(path.join(cwd, '.vibe'), {recursive: true});
  if (config !== undefined) fs.writeFileSync(path.join(cwd, '.vibe', 'config.toml'), config);
  return {cwd, conf};
}
const board = (tools: string[], extra = '') => `[[mcp_servers]]
name = "mesh-board"
transport = "stdio"
command = "/bin/false"
${extra}disabled_tools = ${JSON.stringify(tools)}
`;

/** What _vibe_launch builds for `vibe --agent plan` in a folder: the VIBE_MCP_SERVERS value and the other words. */
const LAUNCH = (cwd: string) => `
launch = server._vibe_launch("vibe --agent plan", ${JSON.stringify(cwd)})
words = shlex.split(launch.command)
script = words[2].removeprefix("export ").removesuffix('; exec "$@"')
print(json.dumps({"servers": json.loads(shlex.split(script)[0].split("=", 1)[1]), "words": words[5:], "hooks": launch.hooks}))`;
/** The status and text of what an async call raised, or what it returned. */
const REFUSED = (call: string) => `
async def go():
    try:
        return {"returned": str(await ${call})}
    except web.HTTPException as exc:
        return {"status": exc.status, "text": exc.text}
print(json.dumps(asyncio.run(go())))`;

describe('the board limits of the session folder', () => {
  test('a restriction in the project configuration is repeated in the injected entry', () => {
    const {cwd, conf} = fixture('limits', board(['agent_message_send'], 'disabled = true\n'));
    const launch = py(conf, LAUNCH(cwd));
    assert.equal(launch.servers.length, 1);
    assert.deepEqual(launch.servers[0].disabled_tools, ['agent_message_send']);
    assert.equal(launch.servers[0].disabled, true);
    assert.deepEqual(launch.words.slice(0, 1), ['--add-dir']);
    assert.match(launch.words[1], new RegExp(`^${conf}/mesh-vibe-hooks/vibe-[0-9a-f]{24}$`));
    assert.deepEqual(launch.words.slice(2), ['--agent', 'plan']);
    assert.equal(launch.hooks, path.basename(launch.words[1]));
  });

  test('the user\'s restriction on the board is repeated as disabled: true, and nothing is added when there is none', () => {
    const value = py(path.join(scratch, 'v', 'conf'), `
reach = {"MESH_PORT": "7777", "MESH_CONF_DIR": "/c"}
def parse(limits):
    before, after = agentmcp.vibe_mcp_value(reach, {"mesh-board": limits})
    return json.loads(before + "tok" + after)[0]
print(json.dumps({"off": parse({"disabled": True, "disabled_tools": []}), "plain": parse({"disabled": False, "disabled_tools": []}), "none": parse(None)}))`);
    assert.equal(value.off.disabled, true);
    assert.equal('disabled' in value.plain, false);
    assert.equal('disabled' in value.none, false);
    assert.equal('disabled_tools' in value.plain, false);
  });

  test('a FIFO as the project configuration is refused at once instead of blocking the server', () => {
    const {cwd, conf} = fixture('fifo');
    execFileSync('mkfifo', [path.join(cwd, '.vibe', 'config.toml')]);
    const result = py(conf, REFUSED(`server._prepare_vibe("vibe", ${JSON.stringify(cwd)})`));
    assert.equal(result.status, 409);
    assert.match(result.text, /^Mistral Vibe: .*config\.toml is not a regular file/);
  });

  test('a link to /dev/zero is refused without reading it, a link to a regular file is followed', () => {
    const zero = fixture('zero');
    fs.symlinkSync('/dev/zero', path.join(zero.cwd, '.vibe', 'config.toml'));
    const refused = py(zero.conf, REFUSED(`server._prepare_vibe("vibe", ${JSON.stringify(zero.cwd)})`));
    assert.equal(refused.status, 409);
    assert.match(refused.text, /not a regular file/);
    const linked = fixture('linked');
    fs.writeFileSync(path.join(scratch, 'linked', 'dotfile.toml'), board(['agent_message_reply']));
    fs.symlinkSync(path.join(scratch, 'linked', 'dotfile.toml'), path.join(linked.cwd, '.vibe', 'config.toml'));
    assert.deepEqual(py(linked.conf, LAUNCH(linked.cwd)).servers[0].disabled_tools, ['agent_message_reply']);
  });

  test('an oversized file, undecodable bytes and too many disabled tools are refused with a message', () => {
    const big = fixture('big', '# ' + 'x'.repeat(1 << 21) + '\n');
    const bigResult = py(big.conf, REFUSED(`server._prepare_vibe("vibe", ${JSON.stringify(big.cwd)})`));
    assert.equal(bigResult.status, 409);
    assert.match(bigResult.text, /larger than 1048576 bytes/);
    const binary = fixture('binary');
    fs.writeFileSync(path.join(binary.cwd, '.vibe', 'config.toml'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const binaryResult = py(binary.conf, REFUSED(`server._prepare_vibe("vibe", ${JSON.stringify(binary.cwd)})`));
    assert.equal(binaryResult.status, 409);
    assert.match(binaryResult.text, /UnicodeDecodeError/);
    const many = fixture('many', board(Array.from({length: 257}, (_, i) => `tool_${i}`)));
    const manyResult = py(many.conf, REFUSED(`server._prepare_vibe("vibe", ${JSON.stringify(many.cwd)})`));
    assert.equal(manyResult.status, 409);
    assert.match(manyResult.text, /disables 257 tools/);
    const invalid = fixture('invalid', 'this is = not [ toml');
    assert.equal(py(invalid.conf, LAUNCH(invalid.cwd)).servers.length, 1, 'invalid TOML is Vibe\'s to report');
  });
});

describe('an external Vibe is restarted in the mesh', () => {
  // A child process stands for the external agent; `host` records what the server asks the PTY host.
  const RESTART = (cwd: string, conf: string) => `
child = subprocess.Popen(["sleep", "60"])
log = []
async def fake_host(req):
    if req["op"] == "list":
        hooks = os.path.join(${JSON.stringify(conf)}, "mesh-vibe-hooks")
        log.append({"op": "list", "alive": child.poll() is None, "prepared": os.path.isdir(hooks) and bool(os.listdir(hooks))})
        return []
    log.append(req)
    return {}
server.host = fake_host
target = {"agent": {"type": "vibe", "pid": child.pid, "session_id": "${SID}", "argv": ["vibe", "--agent", "plan"]}, "cwd": ${JSON.stringify(cwd)}}
async def go():
    try:
        name = await server.resume_target(target)
        error = None
    except web.HTTPException as exc:
        name, error = None, [exc.status, exc.text]
    return {"name": name, "error": error, "alive": child.poll() is None, "log": log}
result = asyncio.run(go())
child.kill()
print(json.dumps(result))`;

  test('the Vibe command is built before the agent is stopped: it is stopped only once everything is ready', () => {
    const {cwd, conf} = fixture('restart', board(['agent_message_send']));
    const result = py(conf, RESTART(cwd, conf));
    assert.equal(result.error, null);
    assert.equal(result.alive, false, 'the external agent was stopped');
    assert.deepEqual(result.log[0], {op: 'list', alive: true, prepared: true}, 'prepared while the agent still runs');
    const created = result.log.find((request: {op: string}) => request.op === 'new');
    assert.match(created.command, /--add-dir \S+\/mesh-vibe-hooks\/vibe-[0-9a-f]{24} --resume e98ebb44/);
    assert.match(created.command, /^\/bin\/sh -c 'export VIBE_MCP_SERVERS=/);
    assert.match(created.command, /agent_message_send/, 'the folder\'s limits are in the restarted command');
    assert.equal(created.meta.vibe_hooks, created.command.match(/(vibe-[0-9a-f]{24})/)[1]);
    assert.equal(fs.existsSync(path.join(conf, 'mesh-vibe-hooks', created.meta.vibe_hooks, '.vibe', 'hooks.toml')), true);
  });

  test('a configuration Mesh refuses leaves the agent running', () => {
    const {cwd, conf} = fixture('restart-fifo');
    execFileSync('mkfifo', [path.join(cwd, '.vibe', 'config.toml')]);
    const result = py(conf, RESTART(cwd, conf));
    assert.equal(result.error[0], 409);
    assert.match(result.error[1], /^Mistral Vibe: /);
    assert.equal(result.alive, true);
    assert.deepEqual(result.log, [], 'the PTY host was not even asked');
  });

  test('a hooks directory that cannot be written leaves the agent running (503, not a stopped agent)', () => {
    const {cwd, conf} = fixture('restart-disk', board([]));
    fs.mkdirSync(conf, {recursive: true});
    fs.writeFileSync(path.join(conf, 'mesh-vibe-hooks'), 'a file where the directory should be');
    const result = py(conf, RESTART(cwd, conf));
    assert.equal(result.error[0], 503);
    assert.match(result.error[1], /^Mistral Vibe: the hooks directory could not be prepared/);
    assert.equal(result.alive, true);
    assert.deepEqual(result.log, []);
  });
});

describe('restart when idle, and the sweep of the hooks directories', () => {
  test('"restart when idle" is refused for Vibe, which reports no reliable idle state', () => {
    const result = py(path.join(scratch, 'idle', 'conf'), `
async def sessions(**_):
    return {"external": [{"pid": 4242, "agent": {"type": "vibe", "pid": 4242}}]}
async def body(_):
    return {"pid": 4242, "mode": "when-idle"}
server.sessions, server.json_object = sessions, body
request = types.SimpleNamespace(app={"organisation_lock": None})
${REFUSED('server.api_adopt(request)')}
print(json.dumps({**asyncio.run(go()), "pending": 4242 in server.PENDING}))`);
    assert.equal(result.status, 400);
    assert.equal(result.text, 'This agent does not report a reliable idle state; manual restart only');
    assert.equal(result.pending, false);
  });

  test('a new session records its hooks directory, and the sweep keeps what a session claims and removes the rest', () => {
    const conf = path.join(scratch, 'sweep', 'conf');
    const result = py(conf, `
requests = []
async def fake_host(req):
    requests.append(req)
    return []
server.host = fake_host
async def go():
    name = await server.new_session("p", ${JSON.stringify(scratch)}, "vibe", "vibe", "vibe")
    created = next(r for r in requests if r["op"] == "new")
    stale = agentmcp.vibe_hooks_dir(server.CONF_DIR, "vibe-stale00000")
    root = os.path.join(server.CONF_DIR, "mesh-vibe-hooks")
    claimed = created["meta"]["vibe_hooks"]
    async def listing(req):
        return [{"name": name, "meta": created["meta"]}]
    server.ptyhost.request = listing
    young = await server.sweep_vibe_hooks()
    after_young = sorted(os.listdir(root))
    old = await server.sweep_vibe_hooks(grace=0)
    after_old = sorted(os.listdir(root))
    async def down(req):
        raise OSError("down")
    server.ptyhost.request = down
    agentmcp.vibe_hooks_dir(server.CONF_DIR, "vibe-other0000")
    unreachable = await server.sweep_vibe_hooks(grace=0)
    return {"claimed": claimed, "young": young, "after_young": after_young, "old": old, "after_old": after_old,
            "unreachable": unreachable, "left": sorted(os.listdir(root))}
print(json.dumps(asyncio.run(go())))`);
    assert.equal(result.young, 0, 'a directory younger than the grace period is not swept');
    assert.equal(result.old, 1);
    assert.deepEqual(result.after_old, [result.claimed]);
    assert.equal(result.unreachable, 0, 'nothing is deleted while the PTY host does not answer');
    assert.deepEqual(result.left, [result.claimed, 'vibe-other0000'].sort());
  });
});
