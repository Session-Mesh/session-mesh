// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The state file of the Codex `codex queue` wake, driven straight at agentwake.CodexQueue with a
// fake `codex` (a shell script that only counts its runs): damage, doubt, restarts and failed writes. The end to
// end cases (a real server, the PTY host) are in codex-queue-wake.test.ts.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

// Runs `code` after a prelude that gives it `queue()` (a CodexQueue on STATE, restartable), `post(q, name, created, n)`,
// `runs()` (how many times the fake codex ran) and `STATE` (the state file). Prints the JSON the code prints.
function scenario(code: string): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqws-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import asyncio, json, os, pathlib, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import agentwake, fsutil
ROOT = pathlib.Path(${JSON.stringify(dir)})
BIN = ROOT / "bin"; BIN.mkdir()
LOG = ROOT / "runs.log"
(BIN / "codex").write_text("#!/bin/sh\\necho run >> " + str(LOG) + "\\nexit 0\\n"); (BIN / "codex").chmod(0o755)
STATE = ROOT / "state.json"
THREAD = "0cb916db-26aa-40f2-86b5-1ba81b225fd2"
def queue(enabled=True, clock=None):
    async def verify(name, created): return THREAD
    return agentwake.CodexQueue(STATE, lambda: {"PATH": str(BIN)}, verify, timeout=5, enabled=enabled,
                                **({"clock": clock} if clock else {}))
def post(q, name, created, n):
    return asyncio.run(q.post({"name": name, "created": created, "notification_id": "%032x" % n}, {"thread": THREAD}))
def runs(): return LOG.read_text().count("run") if LOG.exists() else 0
def aside(): return sorted(p for p in ROOT.iterdir() if p.name.startswith("state.json.damaged-"))
${code}`], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: dir, TMPDIR: dir}});
    return JSON.parse(output.trim().split('\n').pop()!);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const UNCONFIRMED = {ok: false, reason: 'unconfirmed'};
const ACCEPTED = {ok: true, accepted: true};

test('a repair is a durable marker: a restart before any retain still runs nothing, and a post is refused meanwhile', () => {
  const result = scenario(`
TORN = '{"entries": [torn'
STATE.write_text(TORN)
q = queue()                                   # the repair
same_process = post(q, "x", 1.0, 1)           # nothing has listed the incarnations yet
restarted = queue()                           # a restart before the first retain
after_restart = [post(restarted, "x", 1.0, 2), post(restarted, "y", 2.0, 3)]
before_retain = runs()
marker = json.loads(STATE.read_text())
restarted.retain([("x", 1.0)])                # the incarnation alive at that time
after_retain = [post(restarted, "x", 1.0, 4), post(restarted, "z", 3.0, 5)]
runs_after_retain = runs()
lifted = json.loads(STATE.read_text())
third = queue()                               # a restart after the lift keeps the doubt, not the marker
third.retain([("x", 1.0), ("z", 3.0)])
after_third = [post(third, "x", 1.0, 6), post(third, "z", 3.0, 7)]
print(json.dumps({"same_process": same_process, "after_restart": after_restart, "before_retain": before_retain,
                  "marker": marker.get("all_in_doubt"), "after_retain": after_retain, "runs": runs_after_retain,
                  "lifted": lifted.get("all_in_doubt"), "doubt": lifted["doubt"], "after_third": after_third,
                  "final_runs": runs(), "kept": [p.read_text() for p in aside()], "mode": oct(STATE.stat().st_mode & 0o777)}))
`);
  assert.deepEqual(result.same_process, UNCONFIRMED, 'a post before the retain after a repair runs nothing');
  assert.deepEqual(result.after_restart, [UNCONFIRMED, UNCONFIRMED], 'a restart before the first retain forgets nothing');
  assert.equal(result.before_retain, 0);
  assert.equal(result.marker, true, 'the marker is in the new file');
  assert.deepEqual(result.after_retain, [UNCONFIRMED, ACCEPTED], 'the incarnation alive at the repair stays in doubt, a later one is woken');
  assert.equal(result.runs, 1);
  assert.equal(result.final_runs, 2, 'the later incarnation is woken once per notification, the one in doubt never');
  assert.equal(result.lifted, null, 'the marker is lifted once the live incarnations are in doubt');
  assert.deepEqual(result.doubt, [['x', 1]]);
  assert.deepEqual(result.after_third, [UNCONFIRMED, ACCEPTED]);
  assert.deepEqual(result.kept, ['{"entries": [torn'], 'the damaged file is kept whole');
  assert.equal(result.mode, '0o600');
});

test('a marker that cannot be written runs nothing and deletes nothing', () => {
  const result = scenario(`
TORN = '{"entries": [torn'
STATE.write_text(TORN)
healthy = fsutil.atomic_write
def refuse(*args, **kwargs): raise OSError(28, "no space left")
fsutil.atomic_write = refuse
q = queue()
first = post(q, "x", 1.0, 1)
q.retain([("x", 1.0)])
second = post(q, "x", 1.0, 2)
fresh = post(q, "z", 3.0, 3)
print(json.dumps({"answers": [first, second, fresh], "runs": runs(), "state": STATE.read_text() == TORN}))
`);
  assert.deepEqual(result.answers, [UNCONFIRMED, UNCONFIRMED, UNCONFIRMED]);
  assert.equal(result.runs, 0);
  assert.equal(result.state, true, 'the damaged file is still there, untouched');
});

test('disabled, the wake neither reads nor writes the state file an enabled trial left', () => {
  const result = scenario(`
ENTRY = {"name": "x", "created": 1.0, "at": 5.0, "state": "unconfirmed"}
TRIAL = json.dumps({"version": 1, "entries": {"%032x" % 1: ENTRY}, "doubt": [["y", 2.0]]})
STATE.write_text(TRIAL)
reads = []
real_read = pathlib.Path.read_text
def watching(self, *args, **kwargs):
    reads.append(str(self)); return real_read(self, *args, **kwargs)
pathlib.Path.read_text = watching
q = queue(enabled=False)
marks = sorted(q.unconfirmed())
q.note_inbox_read("x", 1.0)
q.retain([])
pathlib.Path.read_text = real_read
untouched = STATE.read_text() == TRIAL
STATE.write_text("{torn")
queue(enabled=False)                          # a damaged file is not repaired either
print(json.dumps({"marks": marks, "untouched": untouched, "reads": reads, "torn": STATE.read_text() == "{torn",
                  "kept": [p.name for p in aside()]}))
`);
  assert.deepEqual(result.marks, [], 'no wake_unconfirmed mark from an earlier trial');
  assert.equal(result.untouched, true, 'a look at the inbox does not rewrite the file');
  assert.deepEqual(result.reads, [], 'the file is not even read');
  assert.equal(result.torn, true);
  assert.deepEqual(result.kept, [], 'nothing is set aside while the wake is off');
});

// A fake codex that writes to its stdout without end.
const ENDLESS = `(BIN / "codex").write_text("#!/bin/sh\\necho run >> " + str(LOG) + "\\nexec ${process.execPath} -e \\"const chunk = 'y'.repeat(8192); const pump = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', pump); }; pump();\\"\\n")`;

test('a runaway writer is killed and post returns at once, not after the 2 s wait bound', () => {
  // The state at the kill is forced, not left to timing: the reads before the kill are stalled, so the
  // endless writer fills the pipe and the 128 KiB the stream buffer takes before it stops reading the pipe,
  // and the time limit (1 s) kills it.  A pipe that is not read never reports its end: without the read
  // that follows the kill, wait() always runs into its 2 s bound (about 3 s in all, against about 1 s).
  // Nothing here depends on how fast the writer or the machine is.
  const result = scenario(`
import time
async def stalled(stream): await asyncio.sleep(3600)
agentwake._drain = stalled
${ENDLESS}
q = queue()
q._timeout = 1
begun = time.monotonic()
answer = post(q, "x", 1.0, 1)
took = time.monotonic() - begun
print(json.dumps({"answer": answer, "took": took, "runs": runs()}))
`);
  assert.deepEqual(result.answer, UNCONFIRMED);
  assert.equal(result.runs, 1);
  assert.ok(result.took >= 1, `the time limit was not what stopped the writer (${result.took} s)`);
  assert.ok(result.took < 2, `post took ${result.took} s: wait() ran into its bound after the kill`);
});

test('an output over the limit is killed at once, long before the time limit', () => {
  const result = scenario(`
import time
${ENDLESS}
q = queue()
begun = time.monotonic()
answer = post(q, "x", 1.0, 1)
print(json.dumps({"answer": answer, "took": time.monotonic() - begun, "runs": runs()}))
`);
  assert.deepEqual(result.answer, UNCONFIRMED);
  assert.equal(result.runs, 1);
  assert.ok(result.took < 4, `post took ${result.took} s: the output limit did not stop the writer before the 5 s time limit`);
});

test('where hard links are refused, the damaged file is copied aside and the marker still replaces it', () => {
  const result = scenario(`
import errno
STATE.write_text('{"entries": [torn')
def refuse(*args, **kwargs): raise OSError(errno.EPERM, "operation not permitted")
os.link = refuse
q = queue()
first = post(q, "x", 1.0, 1)
q.retain([("x", 1.0)])
print(json.dumps({"first": first, "after": post(q, "x", 1.0, 2), "runs": runs(), "damaged": q._damaged,
                  "kept": [p.read_text() for p in aside()], "mode": oct(aside()[0].stat().st_mode & 0o777),
                  "doubt": json.loads(STATE.read_text())["doubt"]}))
`);
  assert.deepEqual(result.kept, ['{"entries": [torn'], 'the damaged file is kept whole, as a copy');
  assert.equal(result.mode, '0o600');
  assert.equal(result.damaged, false, 'the state is repaired, not damaged for ever');
  assert.deepEqual([result.first, result.after], [UNCONFIRMED, UNCONFIRMED], 'the incarnation alive at the repair stays in doubt');
  assert.equal(result.runs, 0, 'nothing is replayed');
  assert.deepEqual(result.doubt, [['x', 1]]);
});

test('a copy that fails midway leaves no truncated file that could pass for the evidence', () => {
  const result = scenario(`
import errno, shutil
STATE.write_text('{"entries": [torn')
def refuse(*args, **kwargs): raise OSError(errno.EPERM, "operation not permitted")
def partial(source, copy, *args):
    copy.write(source.read(5)); raise OSError(errno.ENOSPC, "no space left on device")
os.link = refuse
shutil.copyfileobj = partial
q = queue()
print(json.dumps({"answer": post(q, "x", 1.0, 1), "runs": runs(), "damaged": q._damaged, "aside": [p.name for p in aside()],
                  "original": STATE.read_text()}))
`);
  assert.deepEqual(result.aside, [], 'the partial copy is removed');
  assert.equal(result.original, '{"entries": [torn', 'the original is untouched');
  assert.equal(result.damaged, true, 'the state stays damaged');
  assert.deepEqual(result.answer, UNCONFIRMED);
  assert.equal(result.runs, 0, 'nothing is replayed');
});

test('two repairs within the same second keep both damaged files under different names', () => {
  const result = scenario(`
now = lambda: 1760000000.5
STATE.write_text("first damage")
first = queue(clock=now)
STATE.write_text("second damage {")
second = queue(clock=now)
healthy = second._damaged is False and first._damaged is False
print(json.dumps({"kept": sorted(p.read_text() for p in aside()), "names": [p.name for p in aside()],
                  "healthy": healthy, "marker": json.loads(STATE.read_text()).get("all_in_doubt")}))
`);
  assert.deepEqual(result.kept, ['first damage', 'second damage {'], 'the second repair did not overwrite the first file');
  assert.equal(new Set(result.names).size, 2);
  assert.equal(result.healthy, true);
  assert.equal(result.marker, true);
});
