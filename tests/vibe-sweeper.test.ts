// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sweeper of Vibe's per-launch hooks directories (agentmcp.remove_vibe_hooks_dir, purge_vibe_hooks and the
// server task that runs them), the directory's own modes, the launch of a Vibe named by a path, and what a resume
// does with the abbreviated options that clap (Vibe's CLI parser) refuses. No Vibe, no PTY host.
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  for (const name of ['mesh-board-mcp', 'mesh-event']) fs.writeFileSync(path.join(scratch, 'bin', name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
});
after(() => {
  execFileSync('chmod', ['-R', 'u+rwX', scratch]);
  fs.rmSync(scratch, {recursive: true, force: true});
});

function py(code: string): any {
  const conf = fs.mkdtempSync(path.join(scratch, 'conf-'));
  const program = `import sys, os, json, asyncio, stat, types
sys.path.insert(0, ${JSON.stringify(REPO)})
import server, agentmcp, resumeargs
from aiohttp import web
CONF = ${JSON.stringify(conf)}
SCRATCH = ${JSON.stringify(scratch)}
${code}`;
  const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', program], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: conf, MESH_BIN_DIR: path.join(scratch, 'bin'),
      XDG_RUNTIME_DIR: conf, TMPDIR: scratch}});
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe('removing a hooks directory', () => {
  test('a tree a thousand levels deep is removed without recursion', () => {
    assert.deepEqual(py(`
root = os.path.join(CONF, "deep")
os.mkdir(root)
fd = os.open(root, os.O_RDONLY)
for _ in range(1100):
    os.mkdir("d", dir_fd=fd)
    nxt = os.open("d", os.O_RDONLY, dir_fd=fd)
    os.close(fd)
    fd = nxt
os.close(fd)
agentmcp.remove_vibe_hooks_dir(root)
print(json.dumps(os.path.lexists(root)))
`), false);
  });

  test('read-only directories are made writable, and a link is removed, never entered', () => {
    assert.deepEqual(py(`
outside = os.path.join(CONF, "outside")
os.makedirs(os.path.join(outside, "keep"))
open(os.path.join(outside, "keep", "file"), "w").write("x")
os.chmod(os.path.join(outside, "keep"), 0o500)
root = os.path.join(CONF, "launch")
os.makedirs(os.path.join(root, ".vibe"))
open(os.path.join(root, ".vibe", "hooks.toml"), "w").write("x")
os.symlink(outside, os.path.join(root, "link"))
os.symlink(os.path.join(outside, "keep", "file"), os.path.join(root, ".vibe", "filelink"))
os.chmod(os.path.join(root, ".vibe"), 0o500)
os.chmod(root, 0o500)
agentmcp.remove_vibe_hooks_dir(root)
print(json.dumps([os.path.lexists(root), os.path.exists(os.path.join(outside, "keep", "file")),
                  oct(stat.S_IMODE(os.lstat(os.path.join(outside, "keep")).st_mode))]))
`), [false, true, '0o500']);
  });

  test('a link in place of the directory is unlinked and its target is kept', () => {
    assert.deepEqual(py(`
target = os.path.join(CONF, "target")
os.mkdir(target)
open(os.path.join(target, "file"), "w").write("x")
link = os.path.join(CONF, "asdir")
os.symlink(target, link)
agentmcp.remove_vibe_hooks_dir(link)
print(json.dumps([os.path.lexists(link), os.path.exists(os.path.join(target, "file"))]))
`), [false, true]);
  });

  test('the sweep goes on after an entry that cannot be removed', () => {
    assert.deepEqual(py(`
root = os.path.join(CONF, "mesh-vibe-hooks")
os.mkdir(root, 0o700)
for name in ("vibe-aaaaaaaaaaaa", "vibe-bbbbbbbbbbbb"):
    os.mkdir(os.path.join(root, name))
real = agentmcp.remove_vibe_hooks_dir
def flaky(path):
    if str(path).endswith("aaaaaaaaaaaa"):
        raise RuntimeError("boom")
    return real(path)
agentmcp.remove_vibe_hooks_dir = flaky
removed = agentmcp.purge_vibe_hooks(CONF, (), 0)
print(json.dumps([removed, sorted(os.listdir(root))]))
`), [1, ['vibe-aaaaaaaaaaaa']]);
  });
});

describe('the hooks directory of a launch', () => {
  test('an existing parent directory that is open to others is made private', () => {
    assert.deepEqual(py(`
root = os.path.join(CONF, "mesh-vibe-hooks")
os.mkdir(root, 0o755)
os.chmod(root, 0o755)
directory = agentmcp.vibe_hooks_dir(CONF, "vibe-cccccccccccc")
print(json.dumps([oct(stat.S_IMODE(os.lstat(root).st_mode)), oct(stat.S_IMODE(os.lstat(directory).st_mode)),
                  oct(stat.S_IMODE(os.lstat(os.path.join(directory, ".vibe", "hooks.toml")).st_mode))]))
`), ['0o700', '0o500', '0o400']);
  });
});

describe('the sweeper task', () => {
  test('survives a malformed host reply and a deep failure, and sweeps again', () => {
    assert.deepEqual(py(`
root = os.path.join(CONF, "mesh-vibe-hooks")
os.mkdir(root, 0o700)
old = os.path.join(root, "vibe-dddddddddddd")
os.mkdir(old)
os.utime(old, (1, 1))
replies = [ValueError("not json"), RecursionError(), [{"name": "x", "meta": "not a dict"}, "nor an item"]]
calls = []
async def request(message):
    calls.append(message)
    reply = replies.pop(0)
    if isinstance(reply, BaseException):
        raise reply
    return reply
server.ptyhost.request = request
sleeps = []
real_sleep = asyncio.sleep
async def sleep(seconds):
    sleeps.append(seconds)
    if len(sleeps) >= 3:
        raise asyncio.CancelledError()
    await real_sleep(0)
asyncio.sleep = sleep
async def main():
    try:
        await server.vibe_hooks_sweeper({})
    except asyncio.CancelledError:
        pass
asyncio.run(main())
print(json.dumps([len(calls), sorted(os.listdir(root))]))
`), [3, []]);
  });

  test('the start-up sweep keeps a directory younger than the grace period (a launch in flight)', () => {
    assert.deepEqual(py(`
root = os.path.join(CONF, "mesh-vibe-hooks")
os.mkdir(root, 0o700)
os.mkdir(os.path.join(root, "vibe-eeeeeeeeeeee"))
async def request(message):
    return []
server.ptyhost.request = request
async def sleep(seconds):
    raise asyncio.CancelledError()
asyncio.sleep = sleep
async def main():
    try:
        await server.vibe_hooks_sweeper({})
    except asyncio.CancelledError:
        pass
asyncio.run(main())
print(json.dumps(sorted(os.listdir(root))))
`), ['vibe-eeeeeeeeeeee']);
  });
});

describe('the launch line', () => {
  test('a Vibe named by a path keeps its path and gets its hooks and board entry', () => {
    assert.deepEqual(py(`
launch = server._vibe_launch("/usr/local/bin/vibe --agent plan", SCRATCH)
print(json.dumps([launch.command.startswith("/bin/sh -c 'export VIBE_MCP_SERVERS="), " sh /usr/local/bin/vibe --add-dir" in launch.command,
                  launch.hooks is not None]))
`), [true, true, true]);
  });

  test('a command that is not a Vibe is refused instead of starting bare', () => {
    assert.deepEqual(py(`
out = []
for command in ("env X=1 vibe", "sh -c vibe", ""):
    try:
        server._vibe_launch(command, SCRATCH)
        out.append("launched")
    except web.HTTPException as refusal:
        out.append([refusal.status, refusal.text])
print(json.dumps(out))
`), Array(3).fill([400, 'Non-canonical Vibe command']));
  });
});

describe('abbreviated options at a resume', () => {
  const resume = (argv: string[]): unknown => py(`
try:
    print(json.dumps(resumeargs.resume_argv("vibe", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

  // Vibe 3.1.2 parses its command line with clap, which refuses an abbreviation ("unexpected argument", exit 1): a
  // saved command cannot hold one that ran. An abbreviation is therefore an unknown option, never a kept option.
  test('an abbreviation is not carried over as the option it abbreviates', () => {
    assert.deepEqual(resume(['vibe', '--ag', 'plan']), ['vibe', '--resume', SID]);
    assert.deepEqual(resume(['vibe', '--agent', 'plan']), ['vibe', '--resume', SID, '--agent', 'plan']);
  });

  test('a restrictive option behind an abbreviation refuses the resume, naming it', () => {
    const refused = (argv: string[]) => (resume(argv) as {refused?: string}).refused ?? '';
    assert.match(refused(['vibe', '--ag', 'plan', '--disabled-tools', 'bash']), /--disabled-tools/);
    assert.match(refused(['vibe', '--disabled-t', 'bash', '--agent', 'plan']), /--agent/);
  });

  test('an abbreviation of a one-shot option is not read as one either (clap refuses it, nothing ran)', () => {
    assert.deepEqual(resume(['vibe', '--prom', 'x']), ['vibe', '--resume', SID]);
    assert.match((resume(['vibe', '--prompt', 'x']) as {refused: string}).refused, /not interactive/);
  });
});
