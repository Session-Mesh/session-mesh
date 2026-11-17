// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode's resume command, capability row and configuration, read from the Python modules the server uses.
// The option list is `opencode --help` of 1.18.35. No OpenCode binary and no model is involved.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = 'ses_e1ec1ceb2ffeve47ULriArjJ5g';

function python(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, encoding: 'utf8'});
  return JSON.parse(output);
}

const resume = (argv: string[]): unknown => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs.resume_argv("opencode", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

describe('OpenCode resume', () => {
  test('keeps the session options, drops the conversation pickers, the server options and the prompt', () => {
    assert.deepEqual(resume(['opencode']), ['opencode', '--session', SID]);
    assert.deepEqual(resume(['opencode', '-m', 'ollama/x', '--auto', '-s', 'ses_old00000000', '--port', '4096',
      '--hostname', '0.0.0.0', '--cors', 'https://a', 'https://b', '--continue', '--fork', '--prompt', 'again', '/work']),
    ['opencode', '--session', SID, '-m', 'ollama/x', '--auto']);
    assert.deepEqual(resume(['/opt/tools/bin/opencode', '--mini', '--replay-limit', '20']),
      ['opencode', '--session', SID, '--mini', '--replay-limit', '20']);
  });

  test('keeps the restrictive options', () => {
    assert.deepEqual(resume(['opencode', '--pure', '--agent', 'plan']), ['opencode', '--session', SID, '--pure', '--agent', 'plan']);
  });

  test('refuses rather than drop a restrictive option it cannot read', () => {
    assert.match((resume(['opencode', '--unknown-flag', '--pure']) as {refused: string}).refused, /--pure/);
    assert.match((resume(['sh', '-c', 'opencode --agent plan']) as {refused: string}).refused, /--agent/);
  });

  test('a one-shot run is never resumed, another subcommand is not an interactive conversation', () => {
    assert.match((resume(['opencode', 'run', 'hello']) as {refused: string}).refused, /not interactive/);
    assert.deepEqual(resume(['opencode', 'serve']), ['opencode', '--session', SID]);
  });

  test('--auto false stays off: its false is read as the flag value (yargs, OpenCode 1.18.35), not dropped as a positional', () => {
    assert.deepEqual(resume(['opencode', '--auto', 'false', '/work']), ['opencode', '--session', SID, '--auto', 'false']);
    assert.deepEqual(resume(['opencode', '--auto', 'true', '--mini']), ['opencode', '--session', SID, '--auto', 'true', '--mini']);
    assert.deepEqual(resume(['opencode', '--auto=false']), ['opencode', '--session', SID, '--auto=false']);
    assert.deepEqual(resume(['opencode', '--auto', '/work']), ['opencode', '--session', SID, '--auto']);
  });

  test('npx opencode-ai is recognised as the entry point; another package is not', () => {
    assert.deepEqual(resume(['npx', '-y', 'opencode-ai@1.18.35', '--auto']), ['opencode', '--session', SID, '--auto']);
    assert.deepEqual(resume(['npx', 'other-package', '--auto']), ['opencode', '--session', SID]);
  });
});

describe('OpenCode integration data', () => {
  test('the typed launch line sets the configuration through env (csh and tcsh reject VAR=value command)', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-resume-'));
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho 1.18.35\n', {mode: 0o755});
    const line = python(`
import asyncio, json, server
print(json.dumps(asyncio.run(server._opencode_command("opencode --session ses_x"))[0]))`, {PATH: `${bin}:/usr/bin:/bin`}) as string;
    fs.rmSync(bin, {recursive: true, force: true});
    assert.match(line, /^env OPENCODE_CONFIG_CONTENT='\{.*\}' \S*opencode --session ses_x$/);
    assert.ok(!/MESH_SESSION_TOKEN|ms1\./.test(line), 'the line is on the screen and in the history: no secret in it');
  });

  test('the capability row: board, history and resume supported, bare launch vector', () => {
    assert.deepEqual(python(`
import json, agentcap, launchplan
print(json.dumps({"row": {f.value: s.value for f, s in agentcap.MATRIX["opencode"].items()},
                  "argv": launchplan.build("opencode").command()}))`),
    {row: {board_mcp: 'supported', history: 'supported', resume: 'supported', structured_output: 'unknown'}, argv: ['opencode']});
  });

  test('the configuration holds the board server and plugin, and no board server when the bridge is not installed', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bin-'));
    try {
      fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\n', {mode: 0o755});
      const code = 'import json, agentmcp; print(agentmcp.opencode_config())';
      const installed = python(code, {MESH_BIN_DIR: bin}) as {mcp: Record<string, unknown>; plugin: string[]};
      assert.deepEqual(installed.mcp, {'mesh-board': {type: 'local', command: [path.join(bin, 'mesh-board-mcp')]}});
      assert.equal(installed.plugin.length, 1);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-empty-'));
      try {
        const missing = python(code, {MESH_BIN_DIR: empty}) as {mcp?: unknown; plugin: string[]};
        assert.equal(missing.mcp, undefined, 'an entry for a missing bridge would only fail at every launch');
        assert.equal(missing.plugin.length, 1);
      } finally {
        fs.rmSync(empty, {recursive: true, force: true});
      }
    } finally {
      fs.rmSync(bin, {recursive: true, force: true});
    }
  });
});
