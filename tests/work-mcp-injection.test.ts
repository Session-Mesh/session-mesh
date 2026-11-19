// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The project tracker (work-mcp, docs/work-mcp.md) is registered beside the board for every agent the mesh
// configures, under the reserved server name `mesh-work`.  One list (agentmcp.mesh_servers) gives the servers in
// order, and each agent adapter only shapes them: the board, then the tracker; nothing without the board bridge.
// The tracker's entry names the agent kind (WL_AGENT); no session token, no session name and no data directory
// is written into a configuration or a command line as a value.  A user's restrictions on a reserved name are
// kept; a user's own definition under it is replaced.  Run in a Python subprocess against an isolated HOME and
// stub programs: no agent, no model, no PTY host, no data repository.
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
let withoutBoard: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wmi-'));
  withWork = path.join(scratch, 'bin');
  withoutWork = path.join(scratch, 'bin-old');
  withoutBoard = path.join(scratch, 'bin-no-board');
  for (const [dir, names] of [[withWork, ['mesh-board-mcp', 'mesh-event', 'work-mcp']], [withoutWork, ['mesh-board-mcp', 'mesh-event']],
    [withoutBoard, ['mesh-event', 'work-mcp']]] as const) {
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
  const pi = fs.mkdtempSync(path.join(scratch, 'pi-agent-'));
  const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', program], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin,
      VIBE_HOME: path.join(scratch, 'vibe-home'), PI_CODING_AGENT_DIR: pi}});
  return JSON.parse(out.trim().split('\n').pop()!);
}

const work = (agent: string, bin = withWork) => ({command: path.join(bin, 'work-mcp'), args: [], env: {WL_AGENT: agent}});

/** Every launch configuration, by agent kind, as names of the Mesh servers it carries. */
const SERVER_NAMES_BY_KIND = `
import pimcp
def names(mapping): return sorted(mapping) if isinstance(mapping, dict) else []
def claude():
    argv = agentmcp.inject("claude", ["claude"])
    return names(json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]) if "--mcp-config" in argv else []
def codex():
    return sorted({word.split(".")[1] for word in agentmcp.inject("codex", ["codex"]) if word.startswith("mcp_servers.")})
def copilot():
    args = agentmcp.copilot_args()
    return names(json.loads(args[args.index("--additional-mcp-config") + 1])["mcpServers"]) if "--additional-mcp-config" in args else []
def vibe():
    value = agentmcp.vibe_mcp_value({})
    return sorted(entry["name"] for entry in json.loads("tok".join(value))) if value else []
def agy():
    files = agentmcp.agy_plugin_files()
    return names(json.loads(files["mcp_config.json"])["mcpServers"]) if "mcp_config.json" in files else []
def pi():
    try:
        return names(json.loads((pimcp.prepare(os.environ["MESH_CONF_DIR"])[1] / "mcp.json").read_text())["mcpServers"])
    except pimcp.PiUnavailable:
        return "refused"
print(json.dumps({"claude": claude(), "codex": codex(), "copilot": copilot(), "vibe": vibe(), "agy": agy(), "pi": pi(),
                  "opencode1": names(json.loads(agentmcp.opencode_config()).get("mcp")),
                  "opencode2": names(json.loads(agentmcp.opencode_config_v2()).get("mcp", {}).get("servers")),
                  "gemini": names(agentmcp.gemini_settings({}).get("mcpServers"))}))`;

describe('one list of Mesh servers, one rule', () => {
  test('mesh_servers gives the board then the tracker, and the reserved names are those two', () => {
    const r = py(withWork, `
print(json.dumps({"names": list(agentmcp.MESH_SERVER_NAMES),
                  "servers": [server._asdict() for server in agentmcp.mesh_servers("codex", {"MESH_PORT": "7"})]}))`);
    assert.deepEqual(r.names, ['mesh-board', 'mesh-work']);
    assert.deepEqual(r.servers.map((server: any) => server.name), ['mesh-board', 'mesh-work']);
    assert.deepEqual(r.servers[0].env, {MESH_PORT: '7'}, 'reach goes to the board only');
    assert.deepEqual(r.servers[1], {name: 'mesh-work', ...work('codex'), env_names: ['MESH_SESSION', 'WL_HOME'],
      identity_env: ['MESH_SESSION', 'WL_HOME']});
  });

  test('every agent kind gets both servers when both are installed', () => {
    const r = py(withWork, SERVER_NAMES_BY_KIND);
    for (const [kind, servers] of Object.entries(r)) assert.deepEqual(servers, ['mesh-board', 'mesh-work'], kind);
  });

  test('without the board bridge no agent kind gets the tracker either (Pi refuses to launch, as before)', () => {
    const r = py(withoutBoard, SERVER_NAMES_BY_KIND);
    for (const [kind, servers] of Object.entries(r)) assert.deepEqual(servers, kind === 'pi' ? 'refused' : [], kind);
  });

  test('without work-mcp (an older installation) every agent kind gets the board alone', () => {
    const r = py(withoutWork, SERVER_NAMES_BY_KIND);
    for (const [kind, servers] of Object.entries(r)) assert.deepEqual(servers, ['mesh-board'], kind);
  });
});

describe('agents launched from argv', () => {
  test('Claude gets the tracker in the same --mcp-config as the board, once, also after a restore', () => {
    const r = py(withWork, `
once = agentmcp.inject("claude", ["claude"])
twice = agentmcp.inject("claude", once)
print(json.dumps({"once": once, "twice": twice}))`);
    assert.equal(r.once[1], '--mcp-config');
    const servers = JSON.parse(r.once[2]).mcpServers;
    assert.deepEqual(Object.keys(servers), ['mesh-board', 'mesh-work']);
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
});

describe('a user\'s restriction on a reserved name is kept, a user\'s definition under it is replaced', () => {
  test('Codex: enabled=false and a tool limit on mesh-work survive launch and restore, as on the board', () => {
    const r = py(withWork, `
user = ["codex", "-c", "mcp_servers.mesh-work.enabled=false", "-c", 'mcp_servers.mesh-work.disabled_tools=["work_add_product"]',
        "-c", "mcp_servers.mesh-board.enabled=false", "-c", 'mcp_servers.mesh-work.command="/bin/other"',
        "-c", 'mcp_servers={mesh-work={enabled=false,command="/bin/other"}}']
once = agentmcp.inject("codex", user)
print(json.dumps({"once": once, "twice": agentmcp.inject("codex", once), "free": agentmcp.without_free_codex_config(user)}))`);
    for (const kept of ['mcp_servers.mesh-work.enabled=false', 'mcp_servers.mesh-work.disabled_tools=["work_add_product"]',
      'mcp_servers.mesh-board.enabled=false', 'mcp_servers={mesh-work={enabled=false}}']) {
      assert.ok(r.once.includes(kept), kept);
      assert.ok(r.free.includes(kept), `${kept} is a restriction, not a free item`);
    }
    assert.equal(r.once.includes('mcp_servers.mesh-work.command="/bin/other"'), false, 'the definition is Mesh\'s');
    assert.deepEqual(r.twice, r.once);
  });

  test('Claude: a user\'s mesh-work in --mcp-config is replaced; --disallowedTools on it stays', () => {
    const r = py(withWork, `
user = ["claude", "--disallowedTools", "mcp__mesh-work__work_add_product",
        "--mcp-config", json.dumps({"mcpServers": {"mesh-work": {"command": "/bin/other"}, "mine": {"command": "/bin/mine"}}})]
print(json.dumps(agentmcp.inject("claude", user)))`);
    assert.deepEqual(r.slice(0, 3), ['claude', '--disallowedTools', 'mcp__mesh-work__work_add_product']);
    assert.deepEqual(JSON.parse(r[4]).mcpServers, {mine: {command: '/bin/mine'}});
    assert.deepEqual(JSON.parse(r[6]).mcpServers['mesh-work'], work('claude'));
  });

  test('Copilot: --disable-mcp-server mesh-work stays; a configuration of reserved names only is Mesh\'s', () => {
    const r = py(withWork, `
own = json.dumps({"mcpServers": {"mesh-work": {"type": "local", "command": "/bin/other"}}})
mixed = json.dumps({"mcpServers": {"mesh-work": {"type": "local", "command": "/bin/other"}, "mine": {"command": "/bin/mine"}}})
print(json.dumps(agentmcp.without_copilot_mesh(["copilot", "--disable-mcp-server", "mesh-work",
                                                "--additional-mcp-config", own, "--additional-mcp-config", mixed])))`);
    assert.deepEqual(r.slice(0, 3), ['copilot', '--disable-mcp-server', 'mesh-work']);
    assert.equal(r.length, 5, 'only the configuration that also holds another server is the user\'s');
    assert.ok(r[4].includes('"mine"'));
  });

  test('Pi: a user\'s "enabled": false on mesh-work or mesh-board stays in the overlay', () => {
    const r = py(withWork, `
import pimcp
base = os.environ["PI_CODING_AGENT_DIR"]
with open(os.path.join(base, "mcp.json"), "w") as out:
    json.dump({"mcpServers": {"mesh-work": {"command": "/bin/other", "enabled": False}}}, out)
overlay = pimcp.prepare(os.environ["MESH_CONF_DIR"])[1]
print(json.dumps(json.loads((overlay / "mcp.json").read_text())["mcpServers"]))`);
    assert.deepEqual(r['mesh-work'], {...work('pi'), exposure: 'direct', enabled: false});
    assert.equal(r['mesh-board'].enabled, true);
  });
});

describe('agents configured through the environment, a file or options', () => {
  test('OpenCode 1 and 2: a local server named mesh-work, and none when the user disabled it (v2)', () => {
    const r = py(withWork, `
print(json.dumps({"v1": json.loads(agentmcp.opencode_config()), "v2": json.loads(agentmcp.opencode_config_v2()),
                  "v2off": json.loads(agentmcp.opencode_config_v2(disabled={"mesh-work"}))}))`);
    const entry = {type: 'local', command: [path.join(withWork, 'work-mcp')], environment: {WL_AGENT: 'opencode'}};
    assert.deepEqual(r.v1.mcp['mesh-work'], entry);
    assert.deepEqual(r.v2.mcp.servers['mesh-work'], entry);
    assert.equal('mesh-work' in r.v2off.mcp.servers, false);
    assert.ok('mesh-board' in r.v2off.mcp.servers);
  });

  test('Gemini CLI (references, never values), Copilot CLI and the Antigravity plugin', () => {
    const r = py(withWork, `
args = agentmcp.copilot_args(reach={"MESH_PORT": "7701"})
print(json.dumps({"gemini": agentmcp.gemini_settings({})["mcpServers"], "copilot": args,
                  "copilot_rebuilt": agentmcp.without_copilot_mesh(["copilot", *args]),
                  "agy": json.loads(agentmcp.agy_plugin_files()["mcp_config.json"])}))`);
    assert.deepEqual(r.gemini['mesh-work'], {...work('gemini'),
      env: {MESH_SESSION: '$MESH_SESSION', WL_HOME: '$WL_HOME', WL_AGENT: 'gemini'}});
    assert.deepEqual(r.gemini['mesh-board'].env, {MESH_SESSION_TOKEN: '$MESH_SESSION_TOKEN'});
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
  const LAUNCH = (cwd: string, environment: Record<string, string>) => `
launch = server._vibe_launch("vibe", ${JSON.stringify(cwd)})
words = shlex.split(launch.command)
script = words[2].removeprefix("export ").removesuffix('; exec "$@"')
import subprocess
shell = subprocess.run([*words[:3], "sh", "printenv", "VIBE_MCP_SERVERS"], capture_output=True, text=True, check=True,
                       env={"PATH": "/usr/bin:/bin", **${JSON.stringify(environment)}}).stdout
print(json.dumps({"command": launch.command, "servers": json.loads(shlex.split(script)[0].split("=", 1)[1]),
                  "expanded": json.loads(shell)}))`;
  const project = (name: string, config?: string) => {
    const cwd = path.join(scratch, name);
    fs.mkdirSync(path.join(cwd, '.vibe'), {recursive: true});
    if (config !== undefined) fs.writeFileSync(path.join(cwd, '.vibe', 'config.toml'), config);
    return cwd;
  };
  const session = {MESH_SESSION: 'box-1', MESH_SESSION_TOKEN: 'tok'};

  test('the session name and WL_HOME are expanded by the inner shell, like the token, never written on the line', () => {
    const r = py(withWork, LAUNCH(project('vibe-plain'), {...session, WL_HOME: '/data/wl'}), true);
    assert.equal(r.servers.length, 2);
    assert.deepEqual(r.servers[1], {name: 'mesh-work', transport: 'stdio', command: path.join(withWork, 'work-mcp'), args: [],
      env: {WL_AGENT: 'vibe', MESH_SESSION: '$MESH_SESSION', WL_HOME: '$WL_HOME'}});
    assert.match(r.command, /'"\$MESH_SESSION"'/);
    assert.match(r.command, /'"\$WL_HOME"'/);
    assert.equal(r.command.includes('@@'), false, 'no placeholder is left');
    assert.equal(r.expanded[1].env.MESH_SESSION, 'box-1', 'the inner shell gives the tracker the session name');
    assert.equal(r.expanded[1].env.WL_HOME, '/data/wl', 'and the WL_HOME the user set');
    assert.equal(r.expanded[0].env.MESH_SESSION_TOKEN, 'tok', 'and the board its token, as before');
  });

  test('an unset WL_HOME expands to an empty value, which the tracker reads as unset', () => {
    const r = py(withWork, LAUNCH(project('vibe-nohome'), session), true);
    assert.equal(r.expanded[1].env.WL_HOME, '');
  });

  test('a user\'s restriction on mesh-work is repeated in the injected entry', () => {
    const cwd = project('vibe-off', '[[mcp_servers]]\nname = "mesh-work"\ntransport = "stdio"\ncommand = "/bin/false"\ndisabled = true\ndisabled_tools = ["work_add_product"]\n');
    const r = py(withWork, LAUNCH(cwd, session), true);
    assert.equal(r.servers[1].disabled, true);
    assert.deepEqual(r.servers[1].disabled_tools, ['work_add_product']);
    assert.equal('disabled' in r.servers[0], false, 'the board keeps its own limits');
  });
});
