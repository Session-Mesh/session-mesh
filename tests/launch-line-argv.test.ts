// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The launch lines Mesh types into a terminal never put the session token in the argument of a process.
// The pty shell expands every unquoted "$MESH_SESSION_TOKEN" before it runs the command, so a line such as
// `env VIBE_MCP_SERVERS='...'"$MESH_SESSION_TOKEN"'...' vibe` hands the value to `env` as an argument, readable in
// /proc/<pid>/cmdline.  Here the lines built by server._vibe_launch and server._copilot_command run in a real shell,
// with recorders in front of `env`, `sh`, `vibe` and `copilot` in PATH that log their argv and then run the real
// command (or, for the agents, stop).  The detector is checked against the legacy form, which must leak.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const TOKEN = `t${'0123456789'.repeat(3)}-${process.pid}-canary`;   // a value that no file of the repository holds
let scratch: string;
let bin: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(scratch, 'meshbin'));
  for (const name of ['mesh-board-mcp', 'mesh-event']) fs.writeFileSync(path.join(scratch, 'meshbin', name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const record = `printf '%s\\n' "$0 $*" >> '${path.join(scratch, 'argv.log')}'\n`;
  for (const [name, real] of [['env', '/usr/bin/env'], ['sh', '/bin/sh']])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${record}exec ${real} "$@"\n`, {mode: 0o755});
  for (const name of ['vibe', 'copilot'])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${record}exit 0\n`, {mode: 0o755});
});
after(() => {
  execFileSync('chmod', ['-R', 'u+rwX', scratch]);   // the hooks directory is read-only
  fs.rmSync(scratch, {recursive: true, force: true});
});

/** The lines the server builds, printed as a JSON object. */
function buildLines(): {vibe: string; legacy: string; copilot: string} {
  const program = `import sys, json, shlex
sys.path.insert(0, ${JSON.stringify(REPO)})
import server, agentmcp
value = agentmcp.vibe_mcp_value(server._mesh_reach_env(), {})
legacy = f"env VIBE_MCP_SERVERS={shlex.quote(value[0])}\\"$MESH_SESSION_TOKEN\\"{shlex.quote(value[1])} vibe --agent plan"
print(json.dumps({"vibe": server._vibe_launch("vibe --agent plan", ${JSON.stringify(scratch)}).command, "legacy": legacy,
                  "copilot": server._copilot_command("copilot --model x")}))`;
  const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', program], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: path.join(scratch, 'conf'), MESH_BIN_DIR: path.join(scratch, 'meshbin'),
          VIBE_HOME: path.join(scratch, 'vibe-home')}});
  return JSON.parse(out.trim().split('\n').pop()!);
}

const shellEnv = () => ({PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, MESH_SESSION_TOKEN: TOKEN});

/** Run a line the way the pty shell does (it expands the token), and return every argv the recorders saw. */
function argvOf(line: string): string {
  const log = path.join(scratch, 'argv.log');
  fs.rmSync(log, {force: true});
  execFileSync('/bin/bash', ['-c', line], {cwd: scratch, timeout: 10_000, stdio: 'ignore', env: shellEnv()});
  return fs.readFileSync(log, 'utf8');
}

describe('no launch line puts the session token in an argument', () => {
  let lines: {vibe: string; legacy: string; copilot: string};
  before(() => { lines = buildLines(); });

  test('the Vibe line: the token is expanded by the inner shell, and Vibe is reached', () => {
    // The line names /bin/sh by its absolute path; the recorder stands in for it here, to see the argv of that shell.
    const seen = argvOf(lines.vibe.replace(/^\/bin\/sh /, `${bin}/sh `));
    assert.match(seen, /^\S*\/sh -c /m, 'the recorder saw the inner shell');
    assert.ok(!seen.includes(TOKEN), `the token is in an argv:\n${seen.split(TOKEN).join('<TOKEN>')}`);
    assert.match(seen, /^\S*vibe --add-dir \S+ --agent plan$/m, 'vibe was started with its words');
    assert.ok(seen.includes('MESH_SESSION_TOKEN'), 'the script carries the reference, not the value');
  });

  test('the Vibe line gets the token into Vibe\'s environment', () => {
    const log = path.join(scratch, 'vibe-env.log');
    fs.writeFileSync(path.join(bin, 'vibe'), `#!/bin/sh\nprintf '%s' "$VIBE_MCP_SERVERS" > '${log}'\n`, {mode: 0o755});
    execFileSync('/bin/bash', ['-c', lines.vibe], {cwd: scratch, timeout: 10_000, stdio: 'ignore', env: shellEnv()});
    const servers = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(servers[0].env.MESH_SESSION_TOKEN, TOKEN);
  });

  test('the Vibe line starts with a plain command word that csh and tcsh accept (no VAR=value prefix)', () => {
    assert.match(lines.vibe, /^\/bin\/sh -c '/);
  });

  test('the Copilot line', () => {
    const seen = argvOf(lines.copilot);
    assert.ok(!seen.includes(TOKEN), 'the token is in an argv');
    assert.match(seen, /copilot --model x/);
  });

  test('the detector: the legacy env VAR=...$TOKEN... form leaks the token', () => {
    const legacy = lines.legacy;
    assert.match(legacy, /^env VIBE_MCP_SERVERS=/, 'the legacy line was rebuilt');
    assert.ok(argvOf(legacy).includes(TOKEN), 'the detector does not see a leak it must see');
  });
});
