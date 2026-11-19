// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The reference Codex rows of the native session listing (mesh-sessions, docs/sessions-protocol.md):
// the Python listing (discover.codex_info, in one listing scope, then drop_duplicate_guessed_ids) runs
// on the fictional process tables and homes of ocaml/mesh_sessions/test/fixtures/codex/scenarios.json,
// and its answers must equal the committed golden.json, which the OCaml test
// (ocaml/mesh_sessions/test/test_codex_parity.ml) compares the Codex adapter's rows with.
//
// Each scenario's process table is a fake /proc tree (stat, cmdline, cwd, fd), bind-mounted on /proc
// in a new user and mount namespace (`unshare -rm`) for the Python process only: no real process is
// started or read. The listing's clock is fixed to the scenario's time. Everything lives in a
// temporary directory. MESH_SESSIONS_PARITY_WRITE=1 rewrites golden.json instead of comparing.
//
// A second test needs no namespace, so that it runs wherever MESH_PYTHON is set (CI included): the
// Codex option table of resumeargs._CODEX must equal fixtures/codex/options.json, which the OCaml
// test (test_codex.ml, "option table") compares with Mesh_agent_codex_argv's table.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'ocaml/mesh_sessions/test/fixtures/codex');
const GOLDEN = path.join(FIXTURES, 'golden.json');
const PYTHON = process.env.MESH_PYTHON ?? '';
const CLOCK_TICKS = 100;

type Word = string | { hex: string };
interface RolloutSpec {
  name: string; cwd: string; id: string | null; age: number; source?: unknown; day?: string; lines?: unknown[];
}
interface ProcessSpec {
  pid: number; comm: string; ppid: number; age: number; cwd?: string | null; argv: Word[]; fds?: string[];
  fd_state?: 'ok' | 'unreadable' | 'vanished' | 'denied'; zombie?: boolean;
}
interface Scenario {
  name: string; labels: Record<string, number>; rollouts: RolloutSpec[]; processes: ProcessSpec[];
  days?: Record<string, number>;
}
interface Spec { btime: number; ids: Record<string, string>; tail: string[]; scenarios: Scenario[] }

const spec: Spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8'));
const BASE: ProcessSpec[] = [
  { pid: 1, comm: 'systemd', ppid: 0, age: -1, cwd: '/', argv: ['/sbin/init'] },
  { pid: 50, comm: 'bash', ppid: 1, age: 9000, cwd: '$W', argv: ['bash'] },
  { pid: 60, comm: 'bash', ppid: 1, age: 9000, cwd: '/', argv: ['bash'] },
];

function unavailable(): string | false {
  if (process.platform !== 'linux' || !PYTHON) return 'Linux and MESH_PYTHON are required';
  if (spawnSync('unshare', ['-rm', 'true']).status !== 0) return 'user and mount namespaces are not available';
  const ticks = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim();
  return ticks === String(CLOCK_TICKS) ? false : 'the fixtures assume 100 clock ticks per second';
}
const skip = unavailable();

let temp = '';
after(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); });

// $A_UPPER before $A: the longest names first.
function expand(text: string, work: string): string {
  let out = text;
  for (const name of Object.keys(spec.ids).sort((a, b) => b.length - a.length)) out = out.replaceAll(name, spec.ids[name]);
  return out.replaceAll('$W', work);
}

function words(argv: Word[], work: string): Buffer[] {
  return argv.flatMap(word => typeof word !== 'string' ? [Buffer.from(word.hex, 'hex')]
    : word === '$TAIL' ? spec.tail.map(item => Buffer.from(item)) : [Buffer.from(expand(word, work))]);
}

function rolloutPath(home: string, rollout: RolloutSpec): string {
  return path.join(home, '.codex/sessions', rollout.day ?? '2026/11/19', `rollout-${rollout.name}.jsonl`);
}

function line(item: unknown, work: string): Buffer {
  if (typeof item === 'string') return Buffer.from(item + '\n');
  if (item && typeof item === 'object' && 'hex' in item) return Buffer.concat([Buffer.from((item as { hex: string }).hex, 'hex'), Buffer.from('\n')]);
  return Buffer.from(expand(JSON.stringify(item), work) + '\n');
}

function writeHome(home: string, scenario: Scenario, work: string, now: number): void {
  const days = new Set<string>();
  for (const rollout of scenario.rollouts) {
    const file = rolloutPath(home, rollout);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    days.add(rollout.day ?? '2026/11/19');
    const id = rollout.id === null ? null : expand(rollout.id, work);
    const header = { type: 'session_meta', payload: { id, cwd: expand(rollout.cwd, work), source: rollout.source ?? 'cli' } };
    fs.writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...(rollout.lines ?? []).map(item => line(item, work))]));
    fs.utimesSync(file, now - rollout.age, now - rollout.age);
  }
  for (const day of days) {
    const age = scenario.days?.[day] ?? 0;
    fs.utimesSync(path.join(home, '.codex/sessions', day), now - age, now - age);
  }
}

// One /proc/<pid> as discover reads it: stat (start time in clock ticks after btime), cmdline, cwd, fd.
function writeProcess(proc: string, entry: ProcessSpec, scenario: Scenario, home: string, work: string, now: number): void {
  const dir = path.join(proc, String(entry.pid));
  fs.mkdirSync(dir);
  const start = entry.age < 0 ? spec.btime : now - entry.age;
  const ticks = Math.trunc((start - spec.btime) * CLOCK_TICKS);
  const head = entry.zombie ? ['Z', entry.ppid, entry.pid, entry.pid, 0, -1] : ['S', entry.ppid, entry.pid, entry.pid, 34816, entry.pid];
  const fields = [...head, ...Array(13).fill(0), ticks, ...Array(10).fill(0)];
  fs.writeFileSync(path.join(dir, 'stat'), `${entry.pid} (${entry.comm}) ${fields.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), Buffer.concat(words(entry.argv, work).map(word => Buffer.concat([word, Buffer.from([0])]))));
  if (entry.cwd !== null && entry.cwd !== undefined) fs.symlinkSync(expand(entry.cwd, work), path.join(dir, 'cwd'));
  const state = entry.fd_state ?? 'ok';
  // Denied: unreadable, and /proc/<pid> is owned by this user (the namespace's only one).
  if (state === 'unreadable' || state === 'denied') fs.writeFileSync(path.join(dir, 'fd'), '');
  if (state !== 'ok') return;
  fs.mkdirSync(path.join(dir, 'fd'));
  (entry.fds ?? []).forEach((name, index) => {
    const rollout = scenario.rollouts.find(item => item.name === name);
    const target = rollout ? rolloutPath(home, rollout) : expand(name, work);
    fs.symlinkSync(target, path.join(dir, 'fd', String(index + 3)));
  });
}

const LISTING = [
  'import contextlib, io, json, sys, time, types',
  'sys.path.insert(0, sys.argv[1])',
  'import discover',
  'now = float(sys.argv[2])',
  'labels = json.loads(sys.argv[3])',
  'discover.time = types.SimpleNamespace(time=lambda: now, monotonic=time.monotonic)',
  'with contextlib.redirect_stdout(io.StringIO()):',
  '    with discover.listing_scope():',
  '        infos = {label: discover.codex_info(pid) for label, pid in labels.items()}',
  '    discover.drop_duplicate_guessed_ids([{"agent": info} for info in infos.values()])',
  'print(json.dumps(infos))',
].join('\n');

// Paths under the scenario become "$ROOT", `updated` an age (0 stays 0, Python's unreadable rollout);
// keys are sorted so the file is stable.
function normalize(value: unknown, root: string, now: number): unknown {
  if (typeof value === 'string') return value.replaceAll(root, '$ROOT');
  if (Array.isArray(value)) return value.map(item => normalize(item, root, now));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      out[key] = key === 'updated' && typeof item === 'number' && item !== 0
        ? Math.round((item - now) * 1000) / 1000 : normalize(item, root, now);
    }
    return out;
  }
  return value;
}

function runScenario(scenario: Scenario): unknown {
  const root = path.join(temp, scenario.name);
  const home = path.join(root, 'home'), work = path.join(root, 'w'), proc = path.join(root, 'proc');
  for (const dir of [home, path.join(work, 'sub'), proc]) fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeHome(home, scenario, work, now);
  fs.writeFileSync(path.join(proc, 'stat'), `cpu 0\nbtime ${spec.btime}\n`);
  for (const entry of [...BASE, ...scenario.processes]) writeProcess(proc, entry, scenario, home, work, now);
  const run = spawnSync('unshare', ['-rm', 'sh', '-c', 'mount --bind "$0" /proc && exec "$@"', proc,
    PYTHON, '-I', '-B', '-c', LISTING, ROOT, String(now), JSON.stringify(scenario.labels)], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
  });
  assert.equal(run.status, 0, `${scenario.name}: ${run.stderr}`);
  return normalize(JSON.parse(run.stdout), root, now);
}

test('the Python listing gives the committed Codex identities and rows', { skip }, () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mscp-')));
  const answers: Record<string, unknown> = {};
  for (const scenario of spec.scenarios) answers[scenario.name] = runScenario(scenario);
  if (process.env.MESH_SESSIONS_PARITY_WRITE === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(answers, null, 2) + '\n');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  for (const scenario of spec.scenarios) assert.deepEqual(answers[scenario.name], golden[scenario.name], scenario.name);
  assert.deepEqual(Object.keys(golden).sort(), spec.scenarios.map(scenario => scenario.name).sort());
});

const OPTIONS = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import resumeargs',
  'table = resumeargs._CODEX',
  'print(json.dumps({"categories": sorted(table), "takes_value": sorted(table["keep_value"] | table["drop_value"]),',
  '                  "flags": sorted(table["keep_flag"] | table["drop_flag"])}))',
].join('\n');

// Skipped only without MESH_PYTHON outside CI: in CI a missing interpreter fails the test.
const noPython = !PYTHON && !process.env.CI ? 'MESH_PYTHON is required' : false;

test('the Codex option table equals resumeargs._CODEX', { skip: noPython }, () => {
  assert.ok(PYTHON, 'MESH_PYTHON must be set in CI');
  const run = spawnSync(PYTHON, ['-I', '-B', '-c', OPTIONS, ROOT], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const python = JSON.parse(run.stdout) as { categories: string[]; takes_value: string[]; flags: string[] };
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'options.json'), 'utf8')) as typeof python;
  assert.deepEqual(python.categories, fixture.categories, 'a new kind of Codex option needs the OCaml reader too');
  assert.deepEqual(python.takes_value, [...fixture.takes_value].sort());
  assert.deepEqual(python.flags, [...fixture.flags].sort());
});
