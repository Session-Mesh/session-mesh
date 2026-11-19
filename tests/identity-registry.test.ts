// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session identity registry as respawn.py implements it: the shared vectors (ocaml/identity/test runs the
// same ones through Mesh_identity), the file (0600, never through a link, a newer version left alone), the
// migration from the snapshot, what a listing records, and what a restore reads.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const VECTORS = path.join(REPO, 'ocaml', 'identity', 'test', 'vectors', 'registry-v1.json');
const A = '0e6c0000-1111-4222-8333-444444444444';
const B = '0e6c0000-1111-4222-8333-555555555555';
const NONCE = '0123456789abcdef0123456789abcdef';

/** Run `code` with respawn imported and its files in a fresh home; the JSON it prints. */
function python(code: string, home?: string): any {
  const where = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'identity-registry-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, os, pathlib, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import respawn
home = pathlib.Path(${JSON.stringify(where)})
respawn.FILE = home / "sessions-snapshot.json"
A, B, NONCE = ${JSON.stringify(A)}, ${JSON.stringify(B)}, ${JSON.stringify(NONCE)}

def listed(name, created, kind, sid, source, started=100.0):
    agent = {"type": kind, "session_id": sid, "identity_source": source, "argv": [kind], "started": started}
    return {"name": name, "cwd": str(home), "created": created, "cmd": None, "agent": agent}

def registry():
    return json.loads(respawn.identity_file().read_text())
${code}`],
    {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: where, MESH_CONF_DIR: where, TMPDIR: where}});
    return JSON.parse(output.trim().split('\n').at(-1)!);
  } finally {
    if (!home) fs.rmSync(where, {recursive: true, force: true});
  }
}

const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

describe('the shared vectors, through respawn.py', () => {
  const results = python(`
vectors = json.loads(pathlib.Path(${JSON.stringify(VECTORS)}).read_text())
out = {"cases": [], "files": []}
for case in vectors["cases"]:
    registry, _ = respawn._parse_identities(json.dumps({"version": 1, **case["start"]}))
    for step in case["steps"]:
        if "claim" in step:
            listed = [k for k in map(respawn._valid_incarnation, step["listed"]) if k] if "listed" in step else None
            registry = respawn.merge_identity(registry, step["claim"], step["now"], listed)
        else:
            keep = [k for k in map(respawn._valid_incarnation, step["prune"]) if k]
            registry = respawn.prune_identities(registry, keep, step["now"])
    resolved = [list(respawn.resolve_identity(registry, q["name"], q["created"], q["agent"]))
                for q in case.get("resolve", [])]
    out["cases"].append({"registry": registry, "resolve": resolved})
for case in vectors["files"]:
    registry, writable = respawn._parse_identities(case["text"])
    out["files"].append({"registry": registry, "writable": writable})
print(json.dumps(out))
`);
  vectors.cases.forEach((vector: any, index: number) => {
    test(vector.name, () => {
      assert.deepEqual(results.cases[index].registry, vector.expect);
      assert.deepEqual(results.cases[index].resolve, (vector.resolve ?? []).map((query: any) => query.expect));
    });
  });
  vectors.files.forEach((vector: any, index: number) => {
    test(`file: ${vector.name}`, () => {
      assert.deepEqual(results.files[index], {registry: vector.expect, writable: vector.writable});
    });
  });
});

describe('the registry file', () => {
  test('a first listing migrates the snapshot: only its exact ids, never argv or a guess; the file is private', () => {
    const out = python(`
C, D = "0e6c0000-1111-4222-8333-666666666666", "0e6c0000-1111-4222-8333-777777777777"
respawn.update([listed("w", 1.0, "codex", A, "cwd_unique"), listed("v", 2.0, "copilot", B, "copilot_hooks"),
                listed("c", 3.0, "claude", C, "pid_metadata"), listed("r", 4.0, "codex", D, "argv_resume")],
               True, now=1000.0, host="1:1")
respawn.identity_file().unlink()        # as before an upgrade: a snapshot, no registry
respawn.update([listed("w", 1.0, "codex", None, None), listed("v", 2.0, "copilot", B, "argv_session"),
                listed("c", 3.0, "claude", None, None), listed("r", 4.0, "codex", None, None)],
               True, now=1010.0, host="1:1")
mode = respawn.identity_file().stat().st_mode & 0o777
print(json.dumps([mode, [(e["session"]["name"], e["id"], e["source"], e["evidence"]) for e in registry()["entries"]],
                  [respawn.restore_identity(respawn.entry_of(listed(n, t, k, s, src)))[0]["agent"]["session_id"]
                   for n, t, k, s, src in [("w", 1.0, "codex", A, "cwd_unique"), ("r", 4.0, "codex", D, "argv_resume")]]]))
`);
    assert.deepEqual(out, [0o600, [['c', '0e6c0000-1111-4222-8333-666666666666', 'observed', 'migrated:pid_metadata'], ['v', B, 'observed', 'migrated:hooks']],
      [A, '0e6c0000-1111-4222-8333-777777777777']], 'what is not imported still restores from the snapshot');
  });

  test('a listing records only what it saw exactly: an open rollout, a pid file; never argv or a guess', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout"), listed("b", 2.0, "claude", B, "pid_metadata"),
                listed("c", 3.0, "codex", "0e6c0000-1111-4222-8333-666666666666", "argv_resume"),
                listed("d", 4.0, "codex", "0e6c0000-1111-4222-8333-777777777777", "cwd_unique"),
                listed("e", 5.0, "gemini", "0e6c0000-1111-4222-8333-888888888888", "history_cwd")],
               True, now=1000.0, host="1:1", nonces={("a", 1.0): NONCE})
print(json.dumps([(e["session"], e["id"], e["evidence"], e["holds_open"]) for e in registry()["entries"]]))
`);
    assert.deepEqual(out, [
      [{name: 'a', created: 1, nonce: NONCE}, A, 'observed:open_rollout', true],
      [{name: 'b', created: 2, nonce: null}, B, 'observed:pid_metadata', false],
    ]);
  });

  test('the conversation held open survives listings that no longer see it, and is restored', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
respawn.update([listed("a", 1.0, "codex", None, None)], True, now=1010.0, host="1:1")
respawn.update([], True, now=1020.0, host="2:2")      # the PTY host restarted
entry, reason = respawn.restore_identity(respawn.lost_entry("a"))
print(json.dumps([respawn.lost_entry("a")["agent"]["session_id"], entry["agent"]["session_id"], reason]))
`);
    assert.deepEqual(out, [null, A, null], 'the snapshot lost it, the registry kept it');
  });

  test('two live sessions on one conversation: the holder keeps it, the other restores as contested', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
respawn.update([listed("a", 1.0, "codex", A, "open_rollout"), listed("b", 2.0, "codex", A, "open_rollout")],
               True, now=1010.0, host="1:1")
respawn.update([], True, now=1020.0, host="2:2")
print(json.dumps([list(respawn.restore_identity(respawn.lost_entry(n))) for n in ("a", "b")]))
`);
    assert.equal(out[0][0].agent.session_id, A);
    assert.equal(out[0][1], null);
    assert.equal(out[1][0].agent.session_id, null);
    assert.equal(out[1][1], 'contested');
  });

  test('an incarnation the registry does not know restores the snapshot conversation; none at all is unknown', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "cwd_unique"), listed("b", 2.0, "codex", None, None)],
               True, now=1000.0, host="1:1")
respawn.update([], True, now=1010.0, host="2:2")
print(json.dumps([[e["agent"]["session_id"], r] for e, r in map(respawn.restore_identity,
                  [respawn.lost_entry("a"), respawn.lost_entry("b")])]))
`);
    assert.deepEqual(out, [[A, null], [null, 'unknown']]);
  });

  test('entries of sessions neither listed nor offered are dropped after the grace; lost offers keep theirs', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout"), listed("b", 2.0, "claude", B, "pid_metadata")],
               True, now=1000.0, host="1:1")
respawn.forget_live("b", 2.0)                                # closed on purpose: never offered
respawn.update([], True, now=1010.0, host="2:2")              # a is lost (offered), b is not
early = sorted(e["session"]["name"] for e in registry()["entries"])
respawn.update([], True, now=1000.0 + respawn.IDENTITY_GRACE + 1, host="2:2")
print(json.dumps([early, sorted(e["session"]["name"] for e in registry()["entries"])]))
`);
    assert.deepEqual(out, [['a', 'b'], ['a']]);
  });

  test('a registry of a newer version is never replaced, and restores fall back to the snapshot', () => {
    const out = python(`
text = json.dumps({"version": 2, "generation": 1, "entries": [{"anything": True}]})
respawn.identity_file().write_text(text)
respawn.identity_file().chmod(0o600)
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
respawn.update([], True, now=1010.0, host="2:2")
print(json.dumps([respawn.identity_file().read_text() == text, respawn.restore_identity(respawn.lost_entry("a"))[0]["agent"]["session_id"]]))
`);
    assert.deepEqual(out, [true, A]);
  });

  test('a link in place of the registry is not followed: its target is untouched, a file replaces the link', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-registry-'));
    try {
      const target = path.join(home, 'elsewhere.json');
      fs.writeFileSync(target, 'precious', {mode: 0o600});
      fs.symlinkSync(target, path.join(home, 'session-identities.json'));
      python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
print("{}")
`, home);
      assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
      const registry = path.join(home, 'session-identities.json');
      assert.equal(fs.lstatSync(registry).isSymbolicLink(), false);
      assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8')).entries[0].id, A);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  test('a launch claim: a lost offer holding the conversation is no holder, a live session is', () => {
    const out = python(`
respawn.update([listed("old", 1.0, "codex", A, "open_rollout"), listed("live", 2.0, "codex", B, "open_rollout")],
               True, now=1000.0, host="1:1")
listed_now = [{"name": "live", "created": 2.0, "nonce": None}]          # "old" is no longer listed
new = {"name": "new", "created": None, "nonce": NONCE}
over_lost = respawn.claim_identity(new, "codex", A, "chosen", "launch:restore", live=listed_now, required=True)
other = {"name": "other", "created": None, "nonce": "f" * 32}
respawn.claim_identity({"name": "live", "created": 2.0, "nonce": None}, "codex", B, "chosen", "launch:history")
over_live = respawn.claim_identity(other, "codex", B, "chosen", "launch:history", live=listed_now, required=True)
respawn.forget_identity(other)
invalid = respawn.claim_identity(new, "codex", "-x", "chosen", "launch:restore")
print(json.dumps([over_lost, over_live, invalid, sorted((e["session"]["name"], e["state"]) for e in registry()["entries"])]))
`);
    assert.deepEqual(out, ['active', 'held', null, [['live', 'active'], ['new', 'active'], ['old', 'active']]]);
  });

  test('a launch is refused while a live session holds the conversation, whatever its source', () => {
    const out = python(`
x = {"name": "x", "created": 1.0, "nonce": NONCE}
respawn.update([listed("x", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1", nonces={("x", 1.0): NONCE})
respawn.update([listed("x", 1.0, "codex", None, None)], True, now=1010.0, host="1:1", nonces={("x", 1.0): NONCE})
y = {"name": "y", "created": None, "nonce": "e" * 32}
over_observed = respawn.claim_identity(y, "codex", A, "chosen", "launch:history", live=[x], required=True)
h = {"name": "h", "created": 2.0, "nonce": "d" * 32}
respawn.claim_identity(h, "claude", B, "hook", "hook:Stop")
z = {"name": "z", "created": None, "nonce": "c" * 32}
over_hook = respawn.claim_identity(z, "claude", B, "chosen", "launch:restore", live=[x, h], required=True)
own = respawn.claim_identity(h, "claude", B, "chosen", "launch:restore", live=[x, h], required=True)
print(json.dumps([over_observed, over_hook, own,
                  sorted((e["session"]["name"], e["state"], e["id"]) for e in registry()["entries"])]))
`);
    assert.deepEqual(out, ['held', 'held', 'active', [['h', 'active', B], ['x', 'active', A]]],
      'the holders keep their conversation; the session itself may relaunch its own');
  });

  test('a newer version is never overwritten, whatever the shape of its entries', () => {
    const out = python(`
kept = []
for text in ('{"version": 2, "entries": {}}', '{"version": 2}', '{"version": 3, "entries": "x"}'):
    respawn.identity_file().write_text(text)
    respawn.identity_file().chmod(0o600)
    respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
    try:
        respawn.claim_identity({"name": "n", "created": None, "nonce": NONCE}, "codex", B, "chosen", "launch:x",
                               live=[], required=True)
        refused = False
    except OSError:
        refused = True
    kept.append([respawn.identity_file().read_text() == text, refused])
print(json.dumps(kept))
`);
    assert.deepEqual(out, [[true, true], [true, true], [true, true]]);
  });

  test('a corrupt or too deeply nested registry never breaks a listing: it is replaced, with one line logged', () => {
    const out = python(`
import contextlib, io
results = []
for text in ("[" * 200000 + "]" * 200000, "{not json", '{"version": 1, "entries": {}}'):
    respawn.identity_file().write_text(text)
    respawn.identity_file().chmod(0o600)
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
        respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1010.0, host="1:1")
    lines = log.getvalue().splitlines()
    results.append([len(lines), [e["id"] for e in registry()["entries"]],
                    any(A in line or str(home) in line for line in lines)])
print(json.dumps(results))
`);
    for (const [lines, ids, leaks] of out) {
      assert.equal(lines, 1, 'one line, at the replacement');
      assert.deepEqual(ids, [A], 'replaced by the next write');
      assert.equal(leaks, false, 'no id and no path in the line');
    }
  });

  test('the restore offer says what the restore does: the registry first, the snapshot after', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout"), listed("b", 2.0, "codex", A, "open_rollout"),
                listed("c", 3.0, "claude", None, None)], True, now=1000.0, host="1:1")
respawn.claim_identity({"name": "c", "created": 3.0, "nonce": None}, "claude", B, "hook", "hook:Stop")
offers = respawn.update([], True, now=1010.0, host="2:2")
print(json.dumps(sorted((o["name"], o["resumable"]) for o in offers)))
`);
    assert.deepEqual(out, [['a', true], ['b', false], ['c', true]],
      'b is contested although its snapshot names A; c has only a hook id, which the snapshot lacks');
  });

  test("pruning keys on the PTY host's list (seen), not on the sessions the listing described", () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout"), listed("b", 2.0, "claude", B, "pid_metadata")],
               True, now=1000.0, host="1:1")
late = 1000.0 + respawn.IDENTITY_GRACE + 1
respawn.record([listed("a", 1.0, "codex", A, "open_rollout")], True, now=late, host="1:1",
               seen={("a", 1.0), ("b", 2.0)})
with_seen = sorted(e["session"]["name"] for e in registry()["entries"])
respawn.record([listed("a", 1.0, "codex", A, "open_rollout")], True, now=late + 1, host="1:1")
print(json.dumps([with_seen, sorted(e["session"]["name"] for e in registry()["entries"])]))
`);
    assert.deepEqual(out, [['a', 'b'], ['a']], 'b is kept while the host lists it; without seen, as before');
  });

  test('at the cap, the entries of sessions the host no longer lists go first', () => {
    const out = python(`
registry = respawn._empty_identities()
for i in range(respawn.IDENTITY_MAX_ENTRIES):
    sid = "0e6c0000-1111-4222-8333-%012d" % i
    registry = respawn.merge_identity(registry, {"session": {"name": "s%d" % i, "created": float(i + 1), "nonce": None},
        "agent": "codex", "id": sid, "source": "observed", "evidence": "observed:open_rollout"}, float(i + 1))
oldest = {"name": "s0", "created": 1.0, "nonce": None}
after = respawn.merge_identity(registry, {"session": {"name": "new", "created": 9999.0, "nonce": None}, "agent": "codex",
    "id": "0e6c0000-1111-4222-8333-999999999999", "source": "observed", "evidence": "observed:open_rollout"}, 9999.0,
    listed=[oldest])
names = {e["session"]["name"] for e in after["entries"]}
print(json.dumps([len(names), "s0" in names, "s1" in names, "new" in names]))
`);
    assert.deepEqual(out, [400, true, false, true]);
  });

  test("Gemini, Antigravity and Vibe hooks only fill in a missing conversation; Claude's replace it", () => {
    const out = python(`
g = {"name": "g", "created": 1.0, "nonce": NONCE}
first = respawn.claim_identity(g, "gemini", A, "hook", "hook:AfterAgent", fill_only=True)
respawn.claim_identity(g, "gemini", B, "hook", "hook:AfterAgent", fill_only=True)
c = {"name": "c", "created": 2.0, "nonce": "e" * 32}
respawn.claim_identity(c, "claude", A, "hook", "hook:Stop")
respawn.claim_identity(c, "claude", B, "hook", "hook:Stop")
print(json.dumps([first, sorted((e["session"]["name"], e["id"]) for e in registry()["entries"])]))
`);
    assert.deepEqual(out, ['active', [['c', B], ['g', A]]]);
  });

  test('a world-readable registry is refused (read as empty) and rewritten private', () => {
    const out = python(`
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
respawn.identity_file().chmod(0o644)
refused = respawn.identities()["entries"]
respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1010.0, host="1:1")
print(json.dumps([refused, respawn.identity_file().stat().st_mode & 0o777, len(registry()["entries"])]))
`);
    assert.deepEqual(out, [[], 0o600, 1]);
  });

  test('a lost offer holding a conversation loses it to the listed session that runs it, by listing or by hook', () => {
    const out = python(`
import time
x = {"name": "x", "created": 1.0, "nonce": NONCE}
respawn.update([listed("x", 1.0, "claude", None, None)], True, now=time.time(), host="1:1", nonces={("x", 1.0): NONCE})
respawn.claim_identity(x, "claude", A, "hook", "hook:Stop")            # x's Claude reported A
respawn.update([], True, now=time.time(), host="2:2")                    # the PTY host restarted: x is an offer
# A shell z where the owner typed claude --resume A: a listing reads A in Claude's pid file.
respawn.update([listed("z", 50.0, "claude", A, "pid_metadata", started=51.0)], True, now=time.time(), host="2:2")
by_listing = sorted((e["session"]["name"], e["state"]) for e in registry()["entries"])
# The same with B, reported by z's own hook after a listing that names z and not y (y's entry is older).
respawn.claim_identity({"name": "y", "created": 2.0, "nonce": None}, "claude", B, "hook", "hook:Stop")
respawn.update([listed("z", 50.0, "claude", A, "pid_metadata", started=51.0)], True, now=time.time(), host="2:2")
respawn.claim_identity({"name": "z", "created": 50.0, "nonce": None}, "claude", B, "hook", "hook:Stop")
by_hook = sorted((e["session"]["name"], e["state"], e["id"]) for e in registry()["entries"])
print(json.dumps([by_listing, by_hook, respawn.restore_identity(respawn.lost_entry("x"))[1]]))
`);
    assert.deepEqual(out, [[['x', 'contested'], ['z', 'active']],
      [['x', 'contested', null], ['y', 'contested', null], ['z', 'active', B]], 'contested'],
    'the offer restores as a shell; the live session keeps the conversation it runs');
  });

  test('a holder launched after the last listing is not taken for unlisted, by hook or by listing', () => {
    const out = python(`
import time
h, l = {"name": "h", "created": 60.0, "nonce": None}, {"name": "l", "created": 50.0, "nonce": None}
respawn.update([listed("l", 50.0, "claude", None, None)], True, now=time.time() - 1, host="1:1")
respawn.claim_identity(h, "claude", A, "chosen", "launch:session_id", live=[l, h])   # h launched since
by_hook = respawn.claim_identity(l, "claude", A, "hook", "hook:Stop")                 # l reports A itself
# The listing path: that listing's own list, read before h's entry was written.
respawn.forget_identity(l)
respawn.record([listed("l", 50.0, "claude", A, "pid_metadata", started=51.0)], True, now=time.time(), host="1:1",
               order=time.monotonic() - 1)
by_listing = sorted((e["session"]["name"], e["state"]) for e in registry()["entries"])
print(json.dumps([by_hook, by_listing]))
`);
    assert.deepEqual(out, ['contested', [['h', 'active'], ['l', 'contested']]], 'I4: the launched holder keeps it');
  });

  test('a hook compares with no list once the last listing recorded is stale', () => {
    const out = python(`
import time
x, z = {"name": "x", "created": 1.0, "nonce": None}, {"name": "z", "created": 50.0, "nonce": None}
respawn.claim_identity(x, "claude", A, "hook", "hook:Stop")
# x's entry predates the stale read (40 s, inside the prune's grace): only the age keeps x from losing.
respawn.update_identities(lambda r: {**r, "entries": [{**e, "observed_at": e["observed_at"] - 40} for e in r["entries"]]})
respawn.record([listed("z", 50.0, "claude", None, None)], True, now=time.time(), host="1:1",
               order=time.monotonic() - respawn.LISTED_FRESH - 1)
stale = respawn.claim_identity(z, "claude", A, "hook", "hook:Stop")
respawn.record([listed("z", 50.0, "claude", None, None)], True, now=time.time(), host="1:1")
fresh = respawn.claim_identity(z, "claude", A, "hook", "hook:Stop")
print(json.dumps([stale, fresh]))
`);
    assert.deepEqual(out, ['contested', 'active'], 'a stale list says nothing; a fresh one outlists x');
  });

  test('of two listings recorded out of order, a hook compares with the newer host list', () => {
    const out = python(`
import time
x, z = {"name": "x", "created": 1.0, "nonce": None}, {"name": "z", "created": 50.0, "nonce": None}
respawn.claim_identity(x, "claude", A, "hook", "hook:Stop")
newer = time.monotonic()
respawn.record([listed("z", 50.0, "claude", None, None)], True, now=time.time(), host="1:1", order=newer)
respawn.record([listed("x", 1.0, "claude", None, None), listed("z", 50.0, "claude", None, None)], True,
               now=time.time(), host="1:1", order=newer - 1)    # read before, recorded after
print(json.dumps(respawn.claim_identity(z, "claude", A, "hook", "hook:Stop")))
`);
    assert.equal(out, 'active', 'the newer list does not name x: z takes the conversation');
  });

  test('a directory at the registry path reads as empty: listings go on, a launch claim fails safely', () => {
    const out = python(`
import contextlib, io
respawn.identity_file().mkdir()
log = io.StringIO()
with contextlib.redirect_stdout(log):
    offers = respawn.update([listed("a", 1.0, "codex", A, "open_rollout")], True, now=1000.0, host="1:1")
    respawn.update([], True, now=1010.0, host="2:2")
    read = respawn.identities()
    try:
        respawn.claim_identity({"name": "n", "created": None, "nonce": NONCE}, "codex", B, "chosen", "launch:x",
                               live=[], required=True)
        refused = False
    except OSError:
        refused = True
print(json.dumps([offers, read, refused, respawn.identity_file().is_dir(), len(log.getvalue().splitlines()) > 0,
                  A in log.getvalue()]))
`);
    assert.deepEqual(out, [[], {generation: 0, entries: []}, true, true, true, false]);
  });
});
