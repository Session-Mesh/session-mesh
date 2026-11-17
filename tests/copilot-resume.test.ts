// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Copilot CLI's resume command, capability row and launch options, read from the Python modules the server
// uses. The option list is `copilot --help` of 1.0.86 (the packaged one) plus the options an earlier list had from 1.0.112. No Copilot binary and no model is involved.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';
const OLD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// The options of `copilot --help` of 1.0.86 (the packaged one; the 1.0.112 a launcher keeps in its cache was not
// read: the table also holds the options an earlier list had that 1.0.86 does not print).
const HELP_1_0_86 = ['--acp', '--add-dir', '--add-github-mcp-tool', '--add-github-mcp-toolset', '--additional-mcp-config', '--agent',
  '--allow-all', '--allow-all-mcp-server-instructions', '--allow-all-paths', '--allow-all-tools', '--allow-all-urls', '--allow-tool',
  '--allow-url', '--assisted-approval', '--attachment', '--autopilot', '--auto-tier', '--available-tools', '--banner', '--bash-env',
  '--connect', '--context', '--continue', '--deny-tool', '--deny-url', '--disable-builtin-mcps', '--disable-mcp-server',
  '--disallow-temp-dir', '--dynamic-retrieval', '--enable-all-github-mcp-tools', '--enable-mcp-server', '--enable-memory',
  '--excluded-tools', '--experimental', '--extension-sdk-path', '--fleet', '-h', '--help', '-i', '--interactive', '--log-dir',
  '--log-level', '--max-ai-credits', '--max-autopilot-continues', '--mode', '--model', '--mouse', '-n', '--name', '--no-ask-user',
  '--no-auto-update', '--no-bash-env', '--no-color', '--no-custom-instructions', '--no-eager-powershell-resolution',
  '--no-experimental', '--no-mouse', '--no-remote', '--no-remote-export', '--output-format', '-p', '--plain-diff', '--plan',
  '--plugin-dir', '--prompt', '-r', '--reasoning-effort', '--remote', '--remote-export', '--resume', '-s', '--screen-reader',
  '--secret-env-vars', '--session-id', '--share', '--share-gist', '--silent', '--stream', '--usage-output-file', '-v', '-C'];

function python(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, encoding: 'utf8'});
  return JSON.parse(output);
}

const resume = (argv: string[]): unknown => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs.resume_argv("copilot", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

describe('Copilot CLI resume', () => {
  test('keeps the session options, drops the conversation pickers, the prompt and the output options', () => {
    assert.deepEqual(resume(['copilot']), ['copilot', `--resume=${SID}`]);
    assert.deepEqual(resume(['copilot', '--model', 'gpt-x', '--allow-all-tools', '--resume', OLD, '--name', 'my feature',
      '--session-id', OLD, '-i', 'again', '--output-format', 'json', '--add-dir', '/work/a', '--continue']),
    ['copilot', `--resume=${SID}`, '--model', 'gpt-x', '--allow-all-tools', '--add-dir', '/work/a']);
    assert.deepEqual(resume(['/usr/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot', '--yolo', '--resume=old-id']),
      ['copilot', `--resume=${SID}`, '--yolo']);
  });

  test('keeps every restrictive option, including variadic ones, and the later options after them', () => {
    assert.deepEqual(resume(['copilot', '--deny-tool', 'shell(rm)', 'shell(git push)', '--available-tools', 'view', 'grep',
      '--disable-mcp-server', 'mesh-board', '--disallow-temp-dir', '--secret-env-vars=A,B', '--max-ai-credits', '5', '--model', 'm']),
    ['copilot', `--resume=${SID}`, '--deny-tool', 'shell(rm)', 'shell(git push)', '--available-tools', 'view', 'grep',
      '--disable-mcp-server', 'mesh-board', '--disallow-temp-dir', '--secret-env-vars=A,B', '--max-ai-credits', '5', '--model', 'm']);
  });

  test('refuses rather than drop a restrictive option it cannot read', () => {
    assert.match((resume(['copilot', '--unknown-flag', '--deny-tool', 'shell(rm)']) as {refused: string}).refused, /--deny-tool/);
    assert.match((resume(['sh', '-c', 'copilot --available-tools view']) as {refused: string}).refused, /--available-tools/);
    assert.match((resume(['copilot', '--future-option', '--disallow-temp-dir']) as {refused: string}).refused, /--disallow-temp-dir/);
  });

  test('refuses behind an unknown option when what follows disables the board or hides secrets', () => {
    assert.match((resume(['copilot', '--future-option', '--disable-mcp-server', 'mesh-board']) as {refused: string}).refused,
      /--disable-mcp-server/);
    assert.match((resume(['copilot', '--future-option', '--secret-env-vars', 'A,B']) as {refused: string}).refused,
      /--secret-env-vars/);
    assert.match((resume(['copilot', '--future-option', '--secret-env-vars=A']) as {refused: string}).refused,
      /--secret-env-vars/);
  });

  test('--mouse and --bash-env keep their on/off value, and stand alone before anything else', () => {
    assert.deepEqual(resume(['copilot', '--mouse', 'off', '--bash-env', 'off', '--model', 'm']),
      ['copilot', `--resume=${SID}`, '--mouse', 'off', '--bash-env', 'off', '--model', 'm']);
    assert.deepEqual(resume(['copilot', '--mouse', '--model', 'm']), ['copilot', `--resume=${SID}`, '--mouse', '--model', 'm']);
    assert.deepEqual(resume(['copilot', '--mouse=off']), ['copilot', `--resume=${SID}`, '--mouse=off']);
    // A prompt after the option is not its value.
    assert.deepEqual(resume(['copilot', '--bash-env', 'fix the build']), ['copilot', `--resume=${SID}`, '--bash-env']);
  });

  test('--no-remote and --no-remote-export are kept and restrictive, --remote and --remote-export are never carried over', () => {
    assert.deepEqual(resume(['copilot', '--no-remote', '--model', 'm']), ['copilot', `--resume=${SID}`, '--no-remote', '--model', 'm']);
    assert.deepEqual(resume(['copilot', '--no-remote-export', '--plain-diff']), ['copilot', `--resume=${SID}`, '--no-remote-export', '--plain-diff']);
    assert.deepEqual(resume(['copilot', '--remote', '--remote-export', '--model', 'm']), ['copilot', `--resume=${SID}`, '--model', 'm']);
    // Read behind an option Mesh does not know: the restrictive one is named, not lost.
    assert.match((resume(['copilot', '--future-option', '--no-remote']) as {refused: string}).refused, /--no-remote/);
    assert.match((resume(['sh', '-c', 'copilot --no-remote-export']) as {refused: string}).refused, /--no-remote-export/);
  });

  test('every option of `copilot --help` (1.0.86) is classified, so none is read as unknown', () => {
    assert.deepEqual(resume(['copilot', '--plain-diff', '--deny-tool', 'x']), ['copilot', `--resume=${SID}`, '--plain-diff', '--deny-tool', 'x']);
    assert.deepEqual(resume(['copilot', '--no-eager-powershell-resolution', '--deny-url', 'u']),
      ['copilot', `--resume=${SID}`, '--no-eager-powershell-resolution', '--deny-url', 'u']);
    const classified = python(`
import json, resumeargs
print(json.dumps(sorted(set().union(*resumeargs._COPILOT.values()))))
`) as string[];
    for (const option of HELP_1_0_86) assert.ok(classified.includes(option), `${option} is classified`);
  });

  test('a print-mode or ACP run is never resumed; a subcommand is not an interactive conversation', () => {
    assert.match((resume(['copilot', '-p', 'hello']) as {refused: string}).refused, /not interactive/);
    assert.match((resume(['copilot', '--prompt=hello']) as {refused: string}).refused, /not interactive/);
    assert.match((resume(['copilot', '--acp']) as {refused: string}).refused, /not interactive/);
    assert.deepEqual(resume(['copilot', 'mcp', 'list']), ['copilot', `--resume=${SID}`]);
    assert.match((resume(['copilot', 'config', '--deny-tool', 'x']) as {refused: string}).refused, /--deny-tool/);
  });

  test("Mesh's own options are removed (the server adds the current ones), a user's are kept", () => {
    const plugin = path.join(REPO, 'copilot-mesh-plugin');
    const own = JSON.stringify({mcpServers: {'mesh-board': {type: 'local', command: '/old/install/bin/mesh-board-mcp', args: []}}});
    const user = JSON.stringify({mcpServers: {other: {type: 'local', command: 'x', args: []}}});
    assert.deepEqual(resume(['copilot', '--additional-mcp-config', own, '--plugin-dir', plugin, '--model', 'm']),
      ['copilot', `--resume=${SID}`, '--model', 'm']);
    assert.deepEqual(resume(['copilot', `--plugin-dir=${plugin}`, '--additional-mcp-config', user, '--plugin-dir', '/work/my-plugin']),
      ['copilot', `--resume=${SID}`, '--additional-mcp-config', user, '--plugin-dir', '/work/my-plugin']);
  });

  test("a user's plugin directory that has the name of Mesh's, with its own hooks, is kept", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-plugin-'));
    try {
      const mine = path.join(home, 'copilot-mesh-plugin');
      fs.mkdirSync(path.join(mine, 'hooks'), {recursive: true});
      fs.writeFileSync(path.join(mine, 'hooks', 'hooks.json'), '{"version": 1, "hooks": {}}');
      const other = path.join(home, 'old-install', 'copilot-mesh-plugin');
      fs.mkdirSync(path.join(other, 'hooks'), {recursive: true});
      fs.copyFileSync(path.join(REPO, 'copilot-mesh-plugin', 'hooks', 'hooks.json'), path.join(other, 'hooks', 'hooks.json'));
      assert.deepEqual(resume(['copilot', '--plugin-dir', mine, '--plugin-dir', other, '--model', 'm']),
        ['copilot', `--resume=${SID}`, '--plugin-dir', mine, '--model', 'm']);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('Copilot CLI restart recovery', () => {
  test('a listing without the hooked conversation does not erase it from the snapshot', () => {
    const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-snapshot-'));
    const result = python(`
import json, respawn
def listing(sid):
    return [{"name": "a", "cwd": "/tmp", "created": 1.0, "agent": {"type": "copilot", "session_id": sid, "argv": ["copilot"]}}]
respawn.update(listing("${SID}"), True, now=1.0)
respawn.update(listing(None), True, now=2.0)          # a caller that did not apply the hooks
lost = respawn.update([], True, now=3.0)              # the PTY host restarted
print(json.dumps([[e["name"], e["resumable"]] for e in lost]))
`, {MESH_CONF_DIR: conf});
    fs.rmSync(conf, {recursive: true, force: true});
    assert.deepEqual(result, [['a', true]]);
  });
});

describe('Copilot CLI discovery and entry points', () => {
  test('a package runner or a node script of an agent that has no package is not its entry point (no exception)', () => {
    assert.deepEqual(python(`
import json, agentcap
print(json.dumps([agentcap.entry_args("copilot", argv) for argv in (
    ["node", "/x/copilot.js", "a"], ["npx", "-y", "@scope/copilot", "a"], ["bunx", "copilot"], ["copilot", "a"])]))
`), [null, null, null, ['a']]);
  });

  test('a Copilot found by discovery has no state of its own until a hook reports one', () => {
    assert.deepEqual(python(`
import json, os, discover
info = discover.copilot_info(os.getpid())
print(json.dumps([info["type"], "status" in info]))
`, {HOME: process.env.TMPDIR ?? '/tmp'}), ['copilot', false]);
  });
});

describe('Copilot CLI integration data', () => {
  test('the capability row: board, history and resume supported', () => {
    assert.deepEqual(python(`
import json, agentcap
print(json.dumps({f.value: agentcap.status("copilot", f).value for f in agentcap.Feature}))
`), {board_mcp: 'supported', history: 'supported', resume: 'supported', structured_output: 'unknown'});
  });

  test('the launch arguments carry no credential and pin the mesh the bridge reaches', () => {
    const args = python(`
import json, agentmcp
print(json.dumps(agentmcp.copilot_args(reach={"MESH_PORT": "7701", "MESH_CONF_DIR": "/c"})))
`, {MESH_BIN_DIR: path.join(REPO, 'bin')}) as string[];
    // No bridge in bin/ of the checkout: only the plugin is added.
    assert.deepEqual(args, ['--plugin-dir', path.join(REPO, 'copilot-mesh-plugin')]);
    const withBridge = python(`
import json, os, tempfile, agentmcp
d = tempfile.mkdtemp()
b = os.path.join(d, "mesh-board-mcp")
open(b, "w").write("#!/bin/sh\\n"); os.chmod(b, 0o755)
agentmcp.BOARD_MCP = b
print(json.dumps(agentmcp.copilot_args(reach={"MESH_PORT": "7701", "MESH_CONF_DIR": "/c"})))
`) as string[];
    assert.equal(withBridge[0], '--additional-mcp-config');
    const config = JSON.parse(withBridge[1]);
    assert.deepEqual(Object.keys(config.mcpServers), ['mesh-board']);
    assert.deepEqual(config.mcpServers['mesh-board'].env, {MESH_PORT: '7701', MESH_CONF_DIR: '/c'});
    assert.ok(!/ms1\.|TOKEN/.test(withBridge[1]), 'no session token in the configuration');
    assert.deepEqual(withBridge.slice(2), ['--plugin-dir', path.join(REPO, 'copilot-mesh-plugin')]);
  });
});
