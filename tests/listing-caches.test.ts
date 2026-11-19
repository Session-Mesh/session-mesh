// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session listing reuses what it already read: each test proves the answer is the one
// computed without the reuse, and counts the work that is no longer repeated.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string, home: string): any {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3',
    ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, encoding: 'utf8', timeout: 120_000, env: {   // a hang fails instead of stalling the run
      PATH: process.env.PATH, HOME: home,
      MESH_CONF_DIR: path.join(home, 'conf'), MESH_CACHE_DIR: path.join(home, 'cache'),
    }});
  return JSON.parse(output);
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'listing-caches-'));
}

describe('conversation names are serialised only to be written', () => {
  test('an unchanged listing serialises and writes nothing; a change is written once, as before', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, time, conversation_names as names
T = float(int(time.time()) - 100)   # in the past: _load keeps only entries seen before now
real, dumps = json.dumps, []
def counted(*args, **kwargs):
    dumps.append(1)
    return real(*args, **kwargs)
names.json.dumps = counted
sessions = [{"name": f"s{i}", "created": 100 + i, "label": f"L{i}",
             "agent": {"type": "claude", "session_id": f"abcdefgh-{i:04d}", "identity_source": "pid_metadata"}}
            for i in range(30)]
names.observe(sessions, now=T)
first = len(dumps)
mtime = os.stat(names.FILE).st_mtime_ns
del dumps[:]
names.observe(sessions, now=T + 1)
unchanged = {"dumps": len(dumps), "written": os.stat(names.FILE).st_mtime_ns != mtime}
seen = sorted({e["seen"] - T for e in names.snapshot()})
del dumps[:]
sessions[3] = dict(sessions[3], label="Renamed")
names.observe(sessions, now=T + 2)
changed = [e for e in names.snapshot() if e["name"] == "s3"][0]
later = [e for e in names.snapshot() if e["name"] == "s4"][0]
print(json.dumps({"first": first, "unchanged": unchanged, "seen": seen, "changed_dumps": len(dumps),
                  "s3": [changed["label"], changed["aliases"], changed["seen"] - T], "s4_seen": later["seen"] - T}))
`, home);
      assert.equal(result.first, 1, 'the first listing writes the file: one serialisation');
      assert.deepEqual(result.unchanged, {dumps: 0, written: false});
      assert.deepEqual(result.seen, [0], 'an unchanged entry keeps its time');
      assert.equal(result.changed_dumps, 1);
      assert.deepEqual(result.s3, ['Renamed', ['s3', 'L3', 'Renamed'], 2]);
      // As before: once an entry changed in this listing, the entries handled after it are stamped too.
      assert.equal(result.s4_seen, 2);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('a transcript is parsed again only when its file changed', () => {
  test('codex: same answer, no line decoded on an unchanged file; a write, a replace or a moved link is a miss', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, time, discover
decoded = []
real_line = discover._json_line
def counted(line):
    decoded.append(1)
    return real_line(line)
discover._json_line = counted
def line(role, text):
    return json.dumps({"type": "response_item", "payload": {"type": "message", "role": role,
                       "content": [{"type": "text", "text": text}]}}) + "\\n"
def write(path, *lines):
    with open(path, "w") as out:
        out.writelines(lines)
def read(path):
    del decoded[:]
    found = discover._codex_transcript(path)
    return [found["last"], found["said"], found["status"], len(decoded)]
def uncached(path):
    discover._parsed.clear()
    discover._cache.clear()
    return read(path)[:3]
a, b, link = (os.path.join(discover.HOME, n) for n in ("a.jsonl", "b.jsonl", "link.jsonl"))
write(a, line("user", "one"), line("assistant", "reply one"))
out = {"first": read(a), "again": read(a)}
out["uncached"] = uncached(a)
with open(a, "a") as more:
    more.write(line("user", "two"))
out["appended"] = read(a)
st = os.stat(a)
write(b, line("user", "six"), line("assistant", "reply six"), line("user", "ten"))   # same size as a
os.utime(b, ns=(st.st_atime_ns, st.st_mtime_ns))
out["same_stat"] = [os.stat(b).st_size == st.st_size, os.stat(b).st_mtime_ns == st.st_mtime_ns]
os.replace(b, a)
out["replaced"] = read(a)
write(b, line("user", "six"), line("assistant", "reply six"), line("user", "ten"))
os.utime(b, ns=(st.st_atime_ns, st.st_mtime_ns))
write(a, line("user", "one"), line("assistant", "reply one"), line("user", "two"))
os.utime(a, ns=(st.st_atime_ns, st.st_mtime_ns))
os.symlink(a, link)
out["link_a"] = read(link)
os.unlink(link)
os.symlink(b, link)
out["link_b"] = read(link)
discover.time.time = lambda real=time.time: real() + 100
out["later"] = read(link)
read(b)
st = os.stat(b)
with open(b, "a") as more:
    more.write(line("user", "eleven"))
os.utime(b, ns=(st.st_atime_ns, st.st_mtime_ns))
out["grown_same_mtime"] = read(b)
# Another file renamed in between the path's stat and the open, then the first put back.
c, d = (os.path.join(discover.HOME, n) for n in ("c.jsonl", "d.jsonl"))
write(c, line("user", "cee"))
write(d, line("user", "dee"))
def swapping(file, *args, **kwargs):
    if file != c:
        return open(file, *args, **kwargs)
    os.rename(c, c + ".aside")
    os.rename(d, c)
    handle = open(file, *args, **kwargs)
    os.rename(c, d)
    os.rename(c + ".aside", c)
    return handle
discover.open = swapping
out["swapped"] = read(c)[0]
del discover.open
out["put_back"] = read(c)[0]
discover.PARSED_MAX = 2
for path in (a, b, link):
    discover._codex_transcript(path)
out["bounded"] = len(discover._parsed)
print(json.dumps(out))
`, home);
      assert.deepEqual(result.first, ['one', 'reply one', 'busy', 2]);
      assert.deepEqual(result.again, ['one', 'reply one', 'busy', 0]);
      assert.deepEqual(result.uncached, result.first.slice(0, 3));
      assert.deepEqual(result.appended, ['two', 'reply one', 'busy', 3]);
      assert.deepEqual(result.same_stat, [true, true]);
      assert.deepEqual(result.replaced, ['ten', 'reply six', 'busy', 3]);
      assert.deepEqual(result.link_a, ['two', 'reply one', 'busy', 3]);
      assert.deepEqual(result.link_b, ['ten', 'reply six', 'busy', 3]);
      assert.deepEqual(result.later, ['ten', 'reply six', 'idle', 0], 'the state follows the clock, from the cache');
      assert.deepEqual(result.grown_same_mtime, ['eleven', 'reply six', 'idle', 4], 'grown, mtime_ns set back: a miss');
      assert.deepEqual([result.swapped, result.put_back], ['dee', 'cee'], 'cached under the stamp of the file read');
      assert.equal(result.bounded, 2);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  test('claude: same answer, no line decoded on an unchanged file, the choices are not shared', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, discover
decoded = []
real_line = discover._json_line
def counted(line):
    decoded.append(1)
    return real_line(line)
discover._json_line = counted
sid = "abcdefgh-1111-2222-3333-444455556666"
os.makedirs(os.path.join(discover.HOME, ".claude", "sessions"))
os.makedirs(os.path.join(discover.HOME, ".claude", "projects", "w"))
with open(os.path.join(discover.HOME, ".claude", "sessions", "42.json"), "w") as out:
    json.dump({"sessionId": sid, "status": "waiting"}, out)
ask = {"type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion", "input": {"questions": [
    {"question": "Which?", "options": [{"label": "Left"}, {"label": "Right"}]}]}}
with open(os.path.join(discover.HOME, ".claude", "projects", "w", sid + ".jsonl"), "w") as out:
    out.write(json.dumps({"type": "user", "cwd": "/w", "message": {"content": "hello"}}) + "\\n")
    out.write(json.dumps({"type": "assistant", "cwd": "/w", "message": {"id": "m1", "content": [ask]}}) + "\\n")
first = discover.claude_info(42)
first_decoded = len(decoded)
del decoded[:]
second = discover.claude_info(42)
second_decoded = len(decoded)
discover._parsed.clear()
discover._cache.clear()
third = discover.claude_info(42)
print(json.dumps({"same": first == second == third, "decoded": [first_decoded, second_decoded],
                  "shared": first["choices"] is second["choices"], "keys": list(second),
                  "choices": second["choices"], "last": second["last"]}))
`, home);
      assert.equal(result.same, true);
      assert.deepEqual(result.decoded, [2, 0]);
      assert.equal(result.shared, false);
      assert.deepEqual(result.choices, ['Left', 'Right']);
      assert.equal(result.last, 'hello');
      assert.deepEqual(result.keys, ['type', 'session_id', 'identity_source', 'name', 'status', 'since', 'waiting_for',
        'title', 'last', 'updated', 'cwd', 'said', 'choices', 'ask_id']);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('resource observation indexes each process table once', () => {
  test('the same agents are found, and a table is validated once instead of once per session', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, observability as obs
SESSIONS, OTHERS = 30, 2000
def table():
    procs = {}
    for i in range(SESSIONS):
        shell = 1000 + i
        procs[shell] = ("bash", "S", 1, shell, shell, 0, shell + 5000)
        procs[shell + 5000] = ("codex", "S", shell, shell + 5000, shell, 0, shell + 5000)
    for pid in range(20000, 20000 + OTHERS):
        procs[pid] = ("node", "S", 1, pid, pid, 0, -1)
    return procs
validated = []
real_state = obs._process_state
def counted(processes, pid):
    validated.append(1)
    return real_state(processes, pid)
obs._process_state = counted
rows = [{"name": f"s{i}", "created": 100.0, "source": "mesh", "agent_type": "codex", "lifecycle": "active",
         "time_basis": "created", "time": 100.0} for i in range(SESSIONS)]
raw = [{"name": f"s{i}", "created": 100.0, "pid": 1000 + i} for i in range(SESSIONS)]
read = []
collector = obs.Collector(process_snapshot=table, read_start_ticks=lambda pid: 77,
                          read_process=lambda pid: read.append(pid) or {"sid": pid - 5000, "start_ticks": 77,
                                                                      "cpu_ticks": 1, "rss_bytes": 4096})
result = collector.enrich(raw=raw, management={"sessions": rows}, listed=True, now=200.0, monotonic=5.0)
during = len(validated)
per_row = [obs._comm_only_session_agent(table(), 1000 + i) for i in range(SESSIONS)]
print(json.dumps({"read": sorted(read), "rss": [r["metrics"]["rss_bytes"]["value"] for r in result["sessions"]],
                  "validated": during,
                  "per_row": per_row}))
`, home);
      assert.deepEqual(result.read, Array.from({length: 30}, (_unused, i) => 6000 + i));
      assert.deepEqual(result.rss, Array(30).fill(4096));
      assert.deepEqual(result.per_row, Array.from({length: 30}, (_unused, i) => [6000 + i, 'codex']));
      // Without the index, each of the 30 rows validated the whole table of 2060 processes, before and after
      // the reads: about 124 000 validations. With it, each table is validated once: about 4 200.
      assert.ok(result.validated < 5000, `validations during enrich: ${result.validated}`);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('the first line of each rollout is read once, across restarts', () => {
  // One fresh Python process per call: what a restart of the web server starts from.
  const listing = (home: string, before = '', ids = '0, 7, 99') => python(`
import json, os, sys, discover
opened = []
sys.addaudithook(lambda event, args: event == "open" and os.path.basename(str(args[0])).startswith("rollout-")
                 and opened.append(1))
day = os.path.join(discover.HOME, ".codex", "sessions", "2026", "11", "19")
${before}
with discover.listing_scope():
    found = [os.path.basename(discover._rollout_of(f"abcdefgh-{i:04d}") or "") for i in (${ids})]
print(json.dumps({"found": found, "opened": len(opened)}))
`, home);

  test('a restart reads no first line again; a changed, replaced or unknown file is read; bad caches are ignored', () => {
    const home = tempHome();
    try {
      const day = path.join(home, '.codex', 'sessions', '2026', '11', '19');
      fs.mkdirSync(day, {recursive: true});
      const rollout = (i: number, id = `abcdefgh-${String(i).padStart(4, '0')}`) => fs.writeFileSync(
        path.join(day, `rollout-${String(i).padStart(4, '0')}.jsonl`),
        JSON.stringify({type: 'session_meta', payload: {id, cwd: '/w', base_instructions: 'PRIVATE TEXT'}}) + '\n');
      for (let i = 0; i < 20; i++) rollout(i);
      const want = ['rollout-0000.jsonl', 'rollout-0007.jsonl', ''];
      const cache = path.join(home, 'cache', 'codex-rollout-meta.json');

      assert.deepEqual(listing(home), {found: want, opened: 20});
      assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
      const stored = JSON.parse(fs.readFileSync(cache, 'utf8'));
      assert.equal(stored.v, 1);
      assert.equal(Object.keys(stored.files).length, 20);
      assert.ok(!fs.readFileSync(cache, 'utf8').includes('PRIVATE TEXT'), 'no transcript text in the cache');
      const before = fs.statSync(cache).mtimeMs;

      assert.deepEqual(listing(home), {found: want, opened: 0}, 'after a restart: nothing read');
      assert.equal(fs.statSync(cache).mtimeMs, before, 'nothing learned: not written again');

      // Only the row's mtime_ns differs from the file (edited in Python: JSON numbers past 2**53 lose digits in JS).
      assert.deepEqual(listing(home, `
rows = json.loads(discover.META_FILE.read_text())
rows["files"][os.path.join(day, "rollout-0005.jsonl")][3] += 1
discover.META_FILE.write_text(json.dumps(rows))`), {found: want, opened: 1}, 'a row of another mtime_ns is read again');

      fs.appendFileSync(path.join(day, 'rollout-0003.jsonl'), '{"type":"event_msg","payload":{}}\n');
      assert.deepEqual(listing(home), {found: want, opened: 1}, 'a grown file is read again');

      // Same size, same mtime_ns, another inode and another id: renamed over the path.
      assert.deepEqual(listing(home, `
target = os.path.join(day, "rollout-0007.jsonl")
st = os.stat(target)
with open(target) as old, open(target + ".new", "w") as out:
    out.write(old.read().replace("abcdefgh-0007", "abcdefgh-0099"))
os.utime(target + ".new", ns=(st.st_atime_ns, st.st_mtime_ns))
os.replace(target + ".new", target)
del opened[:]`), {found: ['rollout-0000.jsonl', '', 'rollout-0007.jsonl'], opened: 1});
      rollout(7);

      for (const bad of ['{not json', JSON.stringify({v: 0, files: {}}), JSON.stringify([1, 2]),
        JSON.stringify({v: 1, files: {[path.join(day, 'rollout-0000.jsonl')]: ['x']}})]) {
        fs.writeFileSync(cache, bad);
        assert.deepEqual(listing(home), {found: want, opened: 20}, `ignored: ${bad}`);
        assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).v, 1, 'rewritten whole');
      }

      // A link to a valid cache and a FIFO are no cache: not followed, not waited on; replaced by a file.
      fs.renameSync(cache, `${cache}.real`);
      fs.symlinkSync(`${cache}.real`, cache);
      assert.deepEqual(listing(home), {found: want, opened: 20}, 'a link is not followed');
      fs.rmSync(cache);
      execFileSync('mkfifo', [cache]);
      assert.deepEqual(listing(home), {found: want, opened: 20}, 'a FIFO is not waited on');
      assert.ok(fs.lstatSync(cache).isFile());

      // Another file renamed in between the path's stat and the open, then the first put back: the row
      // holds the stamp of the file read, so the next process reads the first line again.
      rollout(30);
      fs.writeFileSync(path.join(home, 'decoy.jsonl'),
        JSON.stringify({type: 'session_meta', payload: {id: 'abcdefgh-0031', cwd: '/w'}}) + '\n');
      const swapped = listing(home, `
target, decoy, real_open = os.path.join(day, "rollout-0030.jsonl"), os.path.join(discover.HOME, "decoy.jsonl"), open
def swapping(file, *args, **kwargs):
    if file != target:
        return real_open(file, *args, **kwargs)
    os.rename(target, target + ".aside")
    os.rename(decoy, target)
    handle = real_open(file, *args, **kwargs)
    os.rename(target, decoy)
    os.rename(target + ".aside", target)
    return handle
discover.open = swapping`, '30, 31');
      assert.deepEqual(swapped.found, ['', 'rollout-0030.jsonl'], 'the decoy was read');
      assert.deepEqual(listing(home, '', '30, 31'), {found: ['rollout-0030.jsonl', ''], opened: 1});
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('codex rollouts are listed once per listing', () => {
  test('inside listing_scope the glob runs once and every rule sees the same rollouts', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, discover
day = os.path.join(discover.HOME, ".codex", "sessions", "2026", "11", "19")
os.makedirs(day)
for sid in ("aaaaaaaa-1111", "bbbbbbbb-2222"):
    with open(os.path.join(day, f"rollout-{sid}.jsonl"), "w") as out:
        out.write(json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": "/w"}}) + "\\n")
real, calls = discover.recent_rollouts, []
def counted(days=30):
    calls.append(days)
    return real(days)
discover.recent_rollouts = counted
def answers():
    return [os.path.basename(discover._rollout_of(sid) or "") for sid in ("aaaaaaaa-1111", "bbbbbbbb-2222", "cccccccc-3333")]
outside = answers()
outside_calls = len(calls)
del calls[:]
with discover.listing_scope():
    inside = answers()
print(json.dumps({"outside": outside, "inside": inside, "outside_calls": outside_calls, "inside_calls": len(calls)}))
`, home);
      assert.deepEqual(result.inside, result.outside);
      assert.deepEqual(result.outside, ['rollout-aaaaaaaa-1111.jsonl', 'rollout-bbbbbbbb-2222.jsonl', '']);
      assert.equal(result.outside_calls, 3);
      assert.equal(result.inside_calls, 1);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});
