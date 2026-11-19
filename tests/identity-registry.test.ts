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
            registry = respawn.merge_identity(registry, step["claim"], step["now"])
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
  test('a first listing migrates the snapshot: its ids as observed, nothing guessed; the file is private', () => {
    const out = python(`
respawn.update([listed("w", 1.0, "codex", A, "cwd_unique"), listed("v", 2.0, "copilot", B, "copilot_hooks")],
               True, now=1000.0, host="1:1")
respawn.identity_file().unlink()        # as before an upgrade: a snapshot, no registry
respawn.update([listed("w", 1.0, "codex", None, None), listed("v", 2.0, "copilot", B, "argv_session")],
               True, now=1010.0, host="1:1")
mode = respawn.identity_file().stat().st_mode & 0o777
print(json.dumps([mode, [(e["session"]["name"], e["id"], e["source"], e["evidence"]) for e in registry()["entries"]]]))
`);
    assert.deepEqual(out, [0o600, [['v', B, 'observed', 'migrated:hooks'], ['w', A, 'observed', 'migrated:legacy']]]);
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
});
