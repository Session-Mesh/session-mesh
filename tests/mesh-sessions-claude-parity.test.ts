// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The reference rows of the native session listing (mesh-sessions, docs/sessions-protocol.md) for
// Claude: the Python listing (discover.describe) runs on real processes and a fictional home built
// from ocaml/mesh_sessions/test/fixtures/claude/scenarios.json, and its rows must equal the committed
// golden.json, which the OCaml test (ocaml/mesh_sessions/test/test_parity.ml) compares its own rows
// with. A drift of either side fails one of the two tests.
//
// MESH_SESSIONS_PARITY_WRITE=1 rewrites golden.json from the Python rows instead of comparing.
// Everything lives in a temporary directory: the processes are /bin/sh scripts in their own session,
// killed afterwards, and HOME points into the temporary directory.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'ocaml/mesh_sessions/test/fixtures/claude');
const GOLDEN = path.join(FIXTURES, 'golden.json');
const PYTHON = process.env.MESH_PYTHON ?? '';
const skip = process.platform !== 'linux' || !PYTHON
  ? 'Linux and MESH_PYTHON are required (the Python listing reads /proc there)' : false;

interface ProcessSpec { comm: string; args: string[]; metadata?: Record<string, unknown>; children?: ProcessSpec[] }
interface SessionSpec { label: string; project?: string; transcript?: string; process: ProcessSpec }
interface Spec { mtime: number; sessions: SessionSpec[] }
interface Node { id: string; spec: ProcessSpec; script: string; children: Node[] }

const spec: Spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8'));
const leaders: number[] = [];
let temp = '';

after(() => {
  for (const pid of leaders) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// One /bin/sh script per process, named by its comm: it starts its children, then waits.
function buildTree(base: string, label: string, processSpec: ProcessSpec, counter: { next: number }): Node {
  const index = counter.next++;
  const dir = path.join(base, 'p', label, String(index));
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, processSpec.comm);
  const children = (processSpec.children ?? []).map(child => buildTree(base, label, child, counter));
  const lines = ['#!/bin/sh', ...children.map(child => [child.script, ...child.spec.args].map(quote).join(' ') + ' &'),
    'while :; do sleep 60; done', ''];
  fs.writeFileSync(script, lines.join('\n'), { mode: 0o755 });
  return { id: `${label}/${index}`, spec: processSpec, script, children };
}

function stat(pid: number): { comm: string; ppid: number } | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    const close = raw.lastIndexOf(')');
    return { comm: raw.slice(raw.indexOf('(') + 1, close), ppid: Number(raw.slice(close + 2).split(' ')[1]) };
  } catch {
    return null;
  }
}

// The pid of each node: the leader's is known; a child is the process of its comm whose parent is its parent.
async function locate(node: Node, pid: number, pids: Map<string, number>): Promise<void> {
  pids.set(node.id, pid);
  for (const child of node.children) {
    let found = 0;
    for (let attempt = 0; attempt < 100 && !found; attempt++) {
      for (const entry of fs.readdirSync('/proc')) {
        const candidate = Number(entry);
        const info = Number.isInteger(candidate) ? stat(candidate) : null;
        if (info && info.ppid === pid && info.comm === child.spec.comm && ![...pids.values()].includes(candidate)) found = candidate;
      }
      if (!found) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(found, `process ${child.id} did not start`);
    await locate(child, found, pids);
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.children.forEach(child => walk(child, visit));
}

function writeHome(home: string, session: SessionSpec, tree: Node, pids: Map<string, number>): void {
  walk(tree, node => {
    if (node.spec.metadata) {
      fs.writeFileSync(path.join(home, '.claude/sessions', `${pids.get(node.id)}.json`), JSON.stringify(node.spec.metadata));
      const id = node.spec.metadata.sessionId;
      if (session.transcript && session.project && typeof id === 'string') {
        const dir = path.join(home, '.claude/projects', session.project);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `${id}.jsonl`);
        fs.copyFileSync(path.join(FIXTURES, session.transcript), target);
        fs.utimesSync(target, spec.mtime, spec.mtime);
      }
    }
  });
}

// Root paths become "$ROOT", agent pids the node's id; keys are sorted so the file is stable.
function normalize(value: unknown, root: string, ids: Map<number, string>): unknown {
  if (typeof value === 'string') return value.replaceAll(root, '$ROOT');
  if (Array.isArray(value)) return value.map(item => normalize(item, root, ids));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      out[key] = key === 'pid' && typeof item === 'number' ? ids.get(item) ?? item : normalize(item, root, ids);
    }
    return out;
  }
  return value;
}

const DESCRIBE = 'import json, sys\nimport discover\nprocs = discover.snapshot()\n'
  + 'print(json.dumps({pid: discover.describe(procs, int(pid)) for pid in sys.argv[1:]}))';

test('the Python listing gives the committed Claude rows', { skip }, async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msp-')));
  const home = path.join(temp, 'home');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/projects'), { recursive: true });
  const labels = new Map<number, string>();
  const ids = new Map<number, string>();
  for (const session of spec.sessions) {
    const tree = buildTree(temp, session.label, session.process, { next: 0 });
    const cwd = path.join(temp, 'work', session.label);
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(tree.script, session.process.args, { cwd, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    child.unref();
    assert.ok(child.pid, `session ${session.label} did not start`);
    leaders.push(child.pid);
    const pids = new Map<string, number>();
    await locate(tree, child.pid, pids);
    for (const [id, pid] of pids) ids.set(pid, id);
    labels.set(child.pid, session.label);
    writeHome(home, session, tree, pids);
  }
  const run = spawnSync(PYTHON, ['-c', DESCRIBE, ...leaders.map(String)], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(run.stdout) as Record<string, unknown>;
  const byLabel: Record<string, unknown> = {};
  for (const [pid, row] of Object.entries(rows)) byLabel[labels.get(Number(pid)) ?? pid] = normalize(row, temp, ids);
  const sorted = normalize(byLabel, temp, ids);
  if (process.env.MESH_SESSIONS_PARITY_WRITE === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(sorted, null, 2) + '\n');
    return;
  }
  assert.deepEqual(sorted, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
