// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Antigravity (agy): resume command, capability row, the Mesh plugin and the identity of a running process, read
// from the Python modules the server uses. The option list is `agy --help` of 1.5.9. No model and no login is
// involved; the plugin is validated and installed by the real `agy` only into a temporary HOME, when agy exists.
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = '0b9a1c2e-1111-4222-8333-444455556666';

function python(code: string, env: NodeJS.ProcessEnv = {}, lastLine = false): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, encoding: 'utf8'});
  return JSON.parse(lastLine ? output.trim().split('\n').pop() ?? '' : output);
}

const resume = (argv: string[]): unknown => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs.resume_argv("agy", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

describe('agy resume', () => {
  test('keeps the session options, drops the conversation pickers, the prompt and the print mode', () => {
    assert.deepEqual(resume(['agy']), ['agy', '--conversation', SID]);
    assert.deepEqual(resume(['/home/me/.local/bin/agy', '--model', 'm', '--effort', 'high', '-i', 'again', '--conversation', 'old',
      '-c', '--continue', '--new-project', '--log-file', '/x', '--remote-control', '--add-dir', '/work', '--project', 'p']),
    ['agy', '--conversation', SID, '--model', 'm', '--effort', 'high', '--add-dir', '/work', '--project', 'p']);
  });

  test('keeps the restrictive options and the user\'s explicit bypass', () => {
    assert.deepEqual(resume(['agy', '--sandbox', '--mode', 'plan', '--agent', 'reviewer', '--settings', '/s.json']),
      ['agy', '--conversation', SID, '--sandbox', '--mode', 'plan', '--agent', 'reviewer', '--settings', '/s.json']);
    assert.deepEqual(resume(['agy', '--dangerously-skip-permissions']), ['agy', '--conversation', SID, '--dangerously-skip-permissions']);
  });

  test('refuses rather than drop a restrictive option it cannot read', () => {
    assert.match((resume(['agy', '--unknown-flag', '--sandbox']) as {refused: string}).refused, /--sandbox/);
    assert.match((resume(['sh', '-c', 'agy --mode plan']) as {refused: string}).refused, /--mode/);
    assert.match((resume(['agy', '--unknown-flag', '--settings=/strict.json']) as {refused: string}).refused, /--settings/);
    assert.match((resume(['agy', '-unknown-flag', '-sandbox=true']) as {refused: string}).refused, /--sandbox/);
    assert.match((resume(['bash', '-lc', 'agy -sandbox']) as {refused: string}).refused, /--sandbox/);
  });

  // Go flag parsing: one dash and two are the same flag, and `-name=value` is `--name=value`.
  test('reads every single-dash form as the option it is, so none of them is lost', () => {
    const kept = (...words: string[]) => resume(['agy', ...words]);
    assert.deepEqual(kept('-sandbox'), ['agy', '--conversation', SID, '--sandbox']);
    assert.deepEqual(kept('-mode', 'plan'), ['agy', '--conversation', SID, '--mode', 'plan']);
    assert.deepEqual(kept('-mode=plan'), ['agy', '--conversation', SID, '--mode=plan']);
    assert.deepEqual(kept('-settings', '/strict.json'), ['agy', '--conversation', SID, '--settings', '/strict.json']);
    assert.deepEqual(kept('-settings=/strict.json'), ['agy', '--conversation', SID, '--settings=/strict.json']);
    assert.deepEqual(kept('-agent', 'reviewer'), ['agy', '--conversation', SID, '--agent', 'reviewer']);
    assert.deepEqual(kept('--model', 'm', '-sandbox'), ['agy', '--conversation', SID, '--model', 'm', '--sandbox']);
    assert.deepEqual(kept('-sandbox', '--model', 'm'), ['agy', '--conversation', SID, '--sandbox', '--model', 'm']);
    assert.deepEqual(kept('-model', 'm', '-continue', '-print=x'), ['agy', '--conversation', SID, '--model', 'm']);
    assert.deepEqual(kept('-p=again', '-i', 'again'), ['agy', '--conversation', SID]);
    assert.deepEqual(kept('--sandbox'), ['agy', '--conversation', SID, '--sandbox']);
  });

  test('an option read in the single-dash form is kept by the strict reader too, and a word with an attached value is unknown', () => {
    const strict = (word: string) => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs._kept_options("agy", [${JSON.stringify(word)}], strict=True)))
except ValueError as exc:
    print(json.dumps({"error": str(exc)}))`);
    assert.deepEqual(strict('-sandbox'), ['--sandbox']);
    assert.deepEqual(strict('-pfoo'), {error: 'unknown saved option'});
  });

  // Go's flag package stops reading options at the first positional: what follows is the prompt's text.
  test('an option after the first positional was never applied, so it is not kept, and a restrictive one refuses', () => {
    const plain = ['agy', '--conversation', SID];
    assert.deepEqual(resume(['agy', 'fix the bug', '--dangerously-skip-permissions']), plain);
    assert.deepEqual(resume(['agy', '--model', 'm', 'fix', '--model', 'other']), [...plain, '--model', 'm']);
    assert.deepEqual(resume(['agy', '--', '--dangerously-skip-permissions']), plain);
    assert.match((resume(['agy', 'fix the bug', '-sandbox']) as {refused: string}).refused, /--sandbox/);
    assert.match((resume(['agy', '--', '--mode', 'plan']) as {refused: string}).refused, /--mode/);
  });

  // MESH_AGY_QUIET_SECONDS is read when server.py is imported: a bad value must not stop the server, nor make
  // every working session waiting at once (0, negative), nor switch the detection off (nan, inf).
  test('the quiet delay of the waiting state falls back to 30 with a trace on a value outside 1 to 600', () => {
    const quiet = (raw: string | null) => python(`
import contextlib, io, json, server
out = io.StringIO()
with contextlib.redirect_stdout(out):
    value = server._agy_quiet_seconds(json.loads(${JSON.stringify(JSON.stringify(raw))}))
print(json.dumps([value, out.getvalue().strip()]))`) as [number, string];
    assert.deepEqual(quiet(null), [30, '']);
    assert.deepEqual(quiet(''), [30, '']);
    assert.deepEqual(quiet('4'), [4, '']);
    assert.deepEqual(quiet('600'), [600, '']);
    for (const bad of ['abc', '0', '-5', 'nan', 'inf', '0.5', '601', '1e9']) {
      const [value, trace] = quiet(bad);
      assert.equal(value, 30, bad);
      assert.match(trace, /MESH_AGY_QUIET_SECONDS=.*ignored.*using 30/, bad);
    }
  });

  test('a server started with a malformed MESH_AGY_QUIET_SECONDS still imports', () => {
    assert.equal(python('import server, json; print(json.dumps(server.AGY_QUIET_SECONDS))', {MESH_AGY_QUIET_SECONDS: 'abc'}, true), 30);
  });

  test('a subcommand is not an interactive conversation', () => {
    assert.deepEqual(resume(['agy', 'mcp', 'list']), ['agy', '--conversation', SID]);
    assert.deepEqual(resume(['agy', 'models']), ['agy', '--conversation', SID]);
  });

  test('node and npx launchers of another agent do not make an agy entry point', () => {
    assert.deepEqual(resume(['node', '/opt/x/agy.js', '--model', 'm']), ['agy', '--conversation', SID]);
    assert.deepEqual(resume(['npx', '-y', 'agy', '--model', 'm']), ['agy', '--conversation', SID]);
  });
});

describe('agy integration data', () => {
  test('the capability row: board, history and resume supported, bare launch vector', () => {
    assert.deepEqual(python(`
import json, agentcap, launchplan
print(json.dumps({"row": {f.value: s.value for f, s in agentcap.MATRIX["agy"].items()},
                  "argv": launchplan.build("agy").command(), "agent": launchplan.agent_type("agy")}))`),
    {row: {board_mcp: 'supported', history: 'supported', resume: 'supported', structured_output: 'unknown'}, argv: ['agy'], agent: 'agy'});
  });

  test('inject leaves the argv alone: agy has no per-session configuration to add', () => {
    assert.deepEqual(python('import json, agentmcp; print(json.dumps(agentmcp.inject("agy", ["agy", "--model", "m"])))'),
      ['agy', '--model', 'm']);
  });

  test('the plugin holds the board bridge and the two state hooks, and no credential', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-'));
    try {
      fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\n', {mode: 0o755});
      const files = python('import json, agentmcp; print(json.dumps(agentmcp.agy_plugin_files()))',
        {MESH_BIN_DIR: bin, MESH_SESSION_TOKEN: 'ms1.must-not-appear', GEMINI_API_KEY: 'must-not-appear'}) as Record<string, string>;
      assert.deepEqual(Object.keys(files).sort(), ['hooks.json', 'mcp_config.json', 'plugin.json']);
      assert.deepEqual(JSON.parse(files['mcp_config.json']), {mcpServers: {'mesh-board': {command: path.join(bin, 'mesh-board-mcp'), args: []}}});
      const hooks = JSON.parse(files['hooks.json'])['session-mesh'] as Record<string, {command: string; timeout: number}[]>;
      assert.deepEqual(Object.keys(hooks).sort(), ['PreInvocation', 'Stop']);
      assert.equal(hooks.Stop[0].command, `${path.join(bin, 'mesh-event')} agy Stop`);
      assert.ok(hooks.Stop[0].timeout <= 5);
      assert.ok(!Object.values(files).join('').includes('must-not-appear'));
    } finally {
      fs.rmSync(bin, {recursive: true, force: true});
    }
  });

  test('without the bridge the plugin carries the hooks only', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-empty-'));
    try {
      const files = python('import json, agentmcp; print(json.dumps(agentmcp.agy_plugin_files()))', {MESH_BIN_DIR: empty}) as Record<string, string>;
      assert.deepEqual(Object.keys(files).sort(), ['hooks.json', 'plugin.json']);
    } finally {
      fs.rmSync(empty, {recursive: true, force: true});
    }
  });

  test('install fails, and installs nothing, when the board bridge is not executable', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-nobridge-'));
    const empty = path.join(scratch, 'empty');
    fs.mkdirSync(empty);
    const calls = path.join(scratch, 'calls.log');
    fs.writeFileSync(path.join(scratch, 'agy'), `#!/bin/sh\necho "$*" >> '${calls}'\n`, {mode: 0o755});
    try {
      const run = spawnSync(path.join(REPO, 'scripts', 'agy-setup.sh'), ['install'], {encoding: 'utf8', cwd: scratch, env: {
        PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, MESH_BIN_DIR: empty, MESH_AGY: path.join(scratch, 'agy'),
        MESH_PYTHON: process.env.MESH_PYTHON || 'python3'}});
      assert.notEqual(run.status, 0, 'a missing bridge is an error, not a warning');
      assert.match(run.stderr, /no executable .*mesh-board-mcp/);
      assert.ok(!fs.existsSync(calls), 'agy was never asked to validate or install anything');
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });

  test('a running process names its conversation only through its argv; nothing is read from the agy store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proc-'));
    fs.writeFileSync(path.join(dir, 'agy'), '#!/bin/sh\nread line\n', {mode: 0o755});
    const named = spawn(path.join(dir, 'agy'), ['--conversation', SID], {stdio: ['pipe', 'ignore', 'ignore']});
    const unnamed = spawn(path.join(dir, 'agy'), ['--conversation', '--model'], {stdio: ['pipe', 'ignore', 'ignore']});
    try {
      const info = python(`
import json, discover
print(json.dumps([discover.agy_info(${named.pid}), discover.agy_info(${unnamed.pid})]))`) as
        {type: string; session_id?: string; identity_source?: string}[];
      assert.deepEqual([info[0].type, info[0].session_id, info[0].identity_source], ['agy', SID, 'argv_conversation']);
      assert.deepEqual([info[1].type, info[1].session_id], ['agy', undefined]);
    } finally {
      named.kill('SIGKILL');
      unnamed.kill('SIGKILL');
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

const AGY = process.env.MESH_AGY || path.join(os.homedir(), '.local', 'bin', 'agy');

describe('agy plugin accepted by the real agy', {skip: !fs.existsSync(AGY) && 'no agy executable'}, () => {
  test('validate --strict, install and list, in a temporary HOME', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\n', {mode: 0o755});
    const env = {PATH: process.env.PATH, HOME: scratch, XDG_RUNTIME_DIR: scratch, TMPDIR: scratch, LANG: 'C.UTF-8', MESH_BIN_DIR: bin,
      MESH_AGY: AGY, MESH_PYTHON: process.env.MESH_PYTHON || 'python3'};
    try {
      const install = spawnSync(path.join(REPO, 'scripts', 'agy-setup.sh'), ['install'], {env, encoding: 'utf8', cwd: scratch});
      assert.equal(install.status, 0, install.stdout + install.stderr);
      const listed = JSON.parse(execFileSync(AGY, ['plugin', 'list', '--json'], {env, encoding: 'utf8', cwd: scratch})) as
        {name: string; enabled: boolean; mcpServers?: string[]; hooks?: string[]}[];
      const plugin = listed.find(item => item.name === 'session-mesh');
      assert.ok(plugin?.enabled);
      assert.deepEqual(plugin.mcpServers, ['mesh-board']);
      assert.deepEqual(plugin.hooks, ['session-mesh']);
      const removed = spawnSync(path.join(REPO, 'scripts', 'agy-setup.sh'), ['uninstall'], {env, encoding: 'utf8', cwd: scratch});
      assert.equal(removed.status, 0, removed.stdout + removed.stderr);
      assert.deepEqual(JSON.parse(execFileSync(AGY, ['plugin', 'list', '--json'], {env, encoding: 'utf8', cwd: scratch})), []);
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });
});
