// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The project tracker (work-mcp, docs/work-mcp.md) is registered beside the board for every agent the mesh
// configures (agentmcp.py, pimcp.py, server._vibe_launch), under the server name `mesh-work`, with the agent
// kind as WL_AGENT and nothing else: no session token, no session name and no data directory is written into a
// configuration or a command line. Without an installed work-mcp nothing changes. Run in a Python subprocess
// against an isolated HOME and stub programs: no agent, no model, no PTY host, no data repository.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
let scratch: string;
let withWork: string;
let withoutWork: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wmi-'));
  withWork = path.join(scratch, 'bin');
  withoutWork = path.join(scratch, 'bin-old');
  for (const [dir, names] of [[withWork, ['mesh-board-mcp', 'mesh-event', 'work-mcp']], [withoutWork, ['mesh-board-mcp', 'mesh-event']]] as const) {
    fs.mkdirSync(dir);
    for (const name of names) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  }
  // A stand-in Pi 1.3.0 where pimcp looks first (~/.local/bin).
  fs.mkdirSync(path.join(scratch, '.local', 'bin'), {recursive: true});
  fs.writeFileSync(path.join(scratch, '.local', 'bin', 'pi'), '#!/bin/sh\necho 1.3.0\n', {mode: 0o755});
});
after(() => {
  execFileSync('chmod', ['-R', 'u+rwX', scratch]);
  fs.rmSync(scratch, {recursive: true, force: true});
});

/** Run Python with agentmcp (and `server` when asked) imported; the code prints one JSON value, returned parsed. */
function py(bin: string, code: string, withServer = false): any {
  const program = `import sys, os, json, shlex
sys.path.insert(0, ${JSON.stringify(REPO)})
import agentmcp${withServer ? ', server' : ''}
${code}`;
  const conf = fs.mkdtempSync(path.join(scratch, 'conf-'));
  const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', program], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin,
      VIBE_HOME: path.join(scratch, 'vibe-home'), PI_CODING_AGENT_DIR: path.join(scratch, 'pi-agent')}});
  return JSON.parse(out.trim().split('\n').pop()!);
}

const work = (agent: string, bin = withWork) => ({command: path.join(bin, 'work-mcp'), args: [], env: {WL_AGENT: agent}});

describe('agents launched from argv', () => {
  test('Claude gets the tracker in the same --mcp-config as the board, once, also after a restore', () => {
    const r = py(withWork, `
once = agentmcp.inject("claude", ["claude"])
twice = agentmcp.inject("claude", once)
print(json.dumps({"once": once, "twice": twice}))`);
    assert.equal(r.once[1], '--mcp-config');
    const servers = JSON.parse(r.once[2]).mcpServers;
    assert.deepEqual(Object.keys(servers).sort(), ['mesh-board', 'mesh-work']);
    assert.deepEqual(servers['mesh-work'], work('claude'));
    assert.deepEqual(r.twice, r.once, 'a resumed command carries exactly the current entries');
  });

  test('Codex lists the session name and WL_HOME by name only, and a restore does not duplicate the items', () => {
    const r = py(withWork, `
once = agentmcp.inject("codex", ["codex"])
twice = agentmcp.inject("codex", once)
print(json.dumps({"once": once, "twice": twice, "free": agentmcp.without_free_codex_config(once)}))`);
    const items = r.once.filter((_: string, i: number) => r.once[i - 1] === '-c');
    const own = items.filter((item: string) => item.startsWith('mcp_servers.mesh-work.'));
    assert.deepEqual(own, [
      `mcp_servers.mesh-work.command=${JSON.stringify(path.join(withWork, 'work-mcp'))}`,
      'mcp_servers.mesh-work.args=[]',
      'mcp_servers.mesh-work.env_vars=["MESH_SESSION","WL_HOME"]',
      'mcp_servers.mesh-work.env={WL_AGENT="codex"}',
    ]);
    assert.equal(items.filter((item: string) => item.startsWith('mcp_servers.mesh-board.')).length, 3);
    assert.deepEqual(r.twice, r.once);
    assert.deepEqual(r.free, ['codex'], 'the tracker is an item the mesh sets again, not a user restriction');
  });

  test('without work-mcp (an older installation) the launch is the board alone', () => {
    const r = py(withoutWork, `
print(json.dumps({"claude": agentmcp.inject("claude", ["claude"]), "codex": agentmcp.inject("codex", ["codex"]),
                  "available": agentmcp.work_available()}))`);
    assert.equal(r.available, false);
    assert.deepEqual(Object.keys(JSON.parse(r.claude[2]).mcpServers), ['mesh-board']);
    assert.equal(r.codex.some((word: string) => word.includes('mesh-work')), false);
  });

  test('Claude and Codex get the tracker even when the board bridge is missing', () => {
    const r = py(withWork, `
agentmcp.board_available = lambda: False
print(json.dumps({"claude": agentmcp.inject("claude", ["claude"]), "codex": agentmcp.inject("codex", ["codex"])}))`);
    assert.deepEqual(Object.keys(JSON.parse(r.claude[2]).mcpServers), ['mesh-work']);
    assert.equal(r.codex.filter((word: string) => word === '-c').length, 4);
  });
});

describe('agents configured through the environment, a file or options', () => {
  test('OpenCode 1 and 2: a local server named mesh-work, and none when the user disabled it (v2)', () => {
    const r = py(withWork, `
print(json.dumps({"v1": json.loads(agentmcp.opencode_config()), "v2": json.loads(agentmcp.opencode_config_v2()),
                  "v2off": json.loads(agentmcp.opencode_config_v2(work=False))}))`);
    const entry = {type: 'local', command: [path.join(withWork, 'work-mcp')], environment: {WL_AGENT: 'opencode'}};
    assert.deepEqual(r.v1.mcp['mesh-work'], entry);
    assert.deepEqual(r.v2.mcp.servers['mesh-work'], entry);
    assert.equal('mesh-work' in r.v2off.mcp.servers, false);
    assert.ok('mesh-board' in r.v2off.mcp.servers);
  });

  test('Gemini CLI, Copilot CLI and the Antigravity plugin', () => {
    const r = py(withWork, `
args = agentmcp.copilot_args(reach={"MESH_PORT": "7701"})
print(json.dumps({"gemini": agentmcp.gemini_settings({})["mcpServers"], "copilot": args,
                  "copilot_rebuilt": agentmcp.without_copilot_mesh(["copilot", *args]),
                  "agy": json.loads(agentmcp.agy_plugin_files()["mcp_config.json"])}))`);
    assert.deepEqual(r.gemini['mesh-work'], work('gemini'));
    const copilot = JSON.parse(r.copilot[r.copilot.indexOf('--additional-mcp-config') + 1]).mcpServers;
    assert.deepEqual(copilot['mesh-work'], {type: 'local', ...work('copilot')});
    assert.deepEqual(copilot['mesh-board'].env, {MESH_PORT: '7701'});
    assert.deepEqual(r.copilot_rebuilt, ['copilot'], 'a rebuilt command drops the mesh\'s own servers');
    assert.deepEqual(r.agy.mcpServers['mesh-work'], work('agy'));
  });

  test('Pi: the private overlay holds the tracker beside the board', () => {
    const r = py(withWork, `
import pimcp
executable, overlay = pimcp.prepare(os.environ["MESH_CONF_DIR"])
print(json.dumps(json.loads((overlay / "mcp.json").read_text())["mcpServers"]))`);
    assert.deepEqual(r['mesh-work'], {...work('pi'), exposure: 'direct', enabled: true});
    assert.ok('mesh-board' in r);
  });

  test('without work-mcp none of them names the tracker', () => {
    const r = py(withoutWork, `
import pimcp
executable, overlay = pimcp.prepare(os.environ["MESH_CONF_DIR"])
print(json.dumps([agentmcp.opencode_config(), agentmcp.opencode_config_v2(), agentmcp.gemini_settings({}),
                  agentmcp.copilot_args(), agentmcp.agy_plugin_files(), agentmcp.vibe_mcp_value({}),
                  (overlay / "mcp.json").read_text()]))`);
    assert.equal(JSON.stringify(r).includes('mesh-work'), false);
    assert.equal(JSON.stringify(r).includes('work-mcp'), false);
  });
});

describe('Mistral Vibe', () => {
  const LAUNCH = (cwd: string) => `
launch = server._vibe_launch("vibe", ${JSON.stringify(cwd)})
words = shlex.split(launch.command)
script = words[2].removeprefix("export ").removesuffix('; exec "$@"')
import subprocess
shell = subprocess.run([*words[:3], "sh", "printenv", "VIBE_MCP_SERVERS"], capture_output=True, text=True, check=True,
                       env={"PATH": "/usr/bin:/bin", "MESH_SESSION": "box-1", "MESH_SESSION_TOKEN": "tok"}).stdout
print(json.dumps({"command": launch.command, "servers": json.loads(shlex.split(script)[0].split("=", 1)[1]),
                  "expanded": json.loads(shell)}))`;
  const project = (name: string, config?: string) => {
    const cwd = path.join(scratch, name);
    fs.mkdirSync(path.join(cwd, '.vibe'), {recursive: true});
    if (config !== undefined) fs.writeFileSync(path.join(cwd, '.vibe', 'config.toml'), config);
    return cwd;
  };

  test('the session name is expanded by the inner shell, like the token, never written on the line', () => {
    const r = py(withWork, LAUNCH(project('vibe-plain')), true);
    assert.equal(r.servers.length, 2);
    assert.deepEqual(r.servers[1], {name: 'mesh-work', transport: 'stdio', command: path.join(withWork, 'work-mcp'), args: [],
      env: {WL_AGENT: 'vibe', MESH_SESSION: '$MESH_SESSION'}});
    assert.match(r.command, /'"\$MESH_SESSION"'/);
    assert.equal(r.command.includes('@@'), false, 'no placeholder is left');
    assert.equal(r.expanded[1].env.MESH_SESSION, 'box-1', 'the inner shell gives the tracker the session name');
    assert.equal(r.expanded[0].env.MESH_SESSION_TOKEN, 'tok', 'and the board its token, as before');
  });

  test('a user\'s restriction on mesh-work is repeated in the injected entry', () => {
    const cwd = project('vibe-off', '[[mcp_servers]]\nname = "mesh-work"\ntransport = "stdio"\ncommand = "/bin/false"\ndisabled = true\ndisabled_tools = ["work_add_product"]\n');
    const r = py(withWork, LAUNCH(cwd), true);
    assert.equal(r.servers[1].disabled, true);
    assert.deepEqual(r.servers[1].disabled_tools, ['work_add_product']);
    assert.equal('disabled' in r.servers[0], false, 'the board keeps its own limits');
  });
});
