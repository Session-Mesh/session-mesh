// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The OpenCode launch line is prepared (version read with `opencode debug config`, conversation checked) once per
// launch. "Restart now" prepares it before the agent is stopped and the relaunch reuses that result.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string): unknown {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-once-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import asyncio, json, sys\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport server\nfrom aiohttp import web\nCONF = ${JSON.stringify(conf)}\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

describe('OpenCode launch line', () => {
  test('a restart prepares it once and starts the session with that line and notice', () => {
    assert.deepEqual(python(`
prepared, sent = [], []
async def opencode_command(command, cwd="/"):
    prepared.append(command)
    return command + " --prepared", "a notice"
async def host(request):
    sent.append(request)
    return [] if request["op"] == "list" else {"ok": True}
async def wait_dead(pid): return True
server._opencode_command, server.host, server._wait_dead = opencode_command, host, wait_dead
server.os.kill = lambda pid, sig: None
async def main():
    target = {"pid": 9, "cwd": CONF, "agent": {"type": "opencode", "pid": 11, "session_id": "ses_abcdefghijkl",
                                               "argv": ["opencode"]}}
    await server.resume_target(target)
    new = [r for r in sent if r["op"] == "new"][0]
    print(json.dumps([len(prepared), new["command"].endswith("--prepared"), new["meta"].get("notice")]))
asyncio.run(main())
`), [1, true, 'a notice']);
  });

  test('a plain new session still prepares it, once', () => {
    assert.deepEqual(python(`
prepared, sent = [], []
async def opencode_command(command, cwd="/", environ=None, *, fresh=False, require_v2=False):
    prepared.append([command, cwd, environ, fresh, require_v2])
    return command, None
async def host(request):
    sent.append(request)
    return [] if request["op"] == "list" else {"ok": True}
server._opencode_command, server.host = opencode_command, host
async def main():
    await server.new_session("o", CONF, "opencode", "opencode", "opencode")
    print(json.dumps([len(prepared), prepared[0][0], prepared[0][2:]]))
asyncio.run(main())
`), [1, 'opencode', [null, false, false]]);
  });
});
