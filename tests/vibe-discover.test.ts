// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How Mesh recognises Mistral Vibe and names its conversation (discover.vibe_info), with a fake bundled interface
// named vibe-rs (the name `vibe` execs, observed on 3.1.2) and a store with the real meta.json shape. No Vibe, no model.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
let scratch: string;
let work: string;
const children: ChildProcess[] = [];
const ID = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

function python(code: string, env: NodeJS.ProcessEnv): unknown {
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
    `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)}); import discover\n${code}`],
  {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: scratch, ...env}}));
}
const info = (pid: number, vibeHome: string) =>
  python(`print(json.dumps(discover.agent_info(${pid}, "vibe")))`, {VIBE_HOME: vibeHome}) as
  {type: string; session_id?: string; identity_source?: string; pid: number; argv: string[]};

/** A conversation as Vibe's unified store records it (only the fields Mesh reads). */
function conversation(vibeHome: string, id: string, directory: string, parent: string | null = null): void {
  const dir = path.join(vibeHome, 'logs', 'session', 'unified', id);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({session_id: id, parent_session_id: parent,
    environment: {working_directory: directory}, origin_directory: directory, title: 'private title'}));
}

async function fakeTui(directory: string, ...args: string[]): Promise<number> {
  const child = spawn(path.join(scratch, 'bin', 'vibe-rs'), args, {cwd: directory, stdio: 'ignore'});
  children.push(child);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() === 'vibe-rs') break;
    } catch { /* not started yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return child.pid!;
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-discover-'));
  work = fs.mkdtempSync(path.join(scratch, 'work-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  fs.writeFileSync(path.join(scratch, 'bin', 'vibe-rs'), '#!/bin/sh\nsleep 300\n', {mode: 0o755});
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('Vibe identity', () => {
  test('the process named vibe-rs is the agent vibe, and so is a launcher named vibe', async () => {
    const pid = await fakeTui(work);
    assert.equal(python(`print(json.dumps(discover.is_agent(${pid}, discover.read_stat(${pid}))))`, {}), 'vibe');
    assert.equal(python('print(json.dumps(discover._agent_of_argv([b"/x/_bin/vibe-rs", b"--yolo"])))', {}), 'vibe');
    assert.equal(python('print(json.dumps(discover._agent_of_argv([b"/usr/bin/vibe"])))', {}), 'vibe');
    assert.equal(python('print(json.dumps(discover._agent_of_argv([b"/usr/bin/vibe-app-server"])))', {}), null);
  });

  test('--resume names the conversation', async () => {
    const home = path.join(scratch, 'home-named');
    conversation(home, ID(1), work);
    const pid = await fakeTui(work, '--resume', ID(1));
    const got = info(pid, home);
    assert.deepEqual([got.type, got.session_id, got.identity_source], ['vibe', ID(1), 'argv_resume']);
    assert.deepEqual(got.argv.slice(-2), ['--resume', ID(1)]);
  });

  test('a lone process takes the single conversation written in its folder since it started', async () => {
    const home = path.join(scratch, 'home-lone');
    const alone = fs.mkdtempSync(path.join(scratch, 'alone-'));
    const other = fs.mkdtempSync(path.join(scratch, 'other-'));
    const pid = await fakeTui(alone);
    conversation(home, ID(2), alone);
    conversation(home, ID(3), other);
    conversation(home, ID(4), alone, ID(2));   // a sub-agent's
    const got = info(pid, home);
    assert.deepEqual([got.session_id, got.identity_source], [ID(2), 'unique_vibe_session']);
    assert.ok(!JSON.stringify(got).includes('private title'), 'titles are not read');
  });

  test('two conversations in the folder, or two processes there, name none', async () => {
    const home = path.join(scratch, 'home-two');
    const shared = fs.mkdtempSync(path.join(scratch, 'shared-'));
    const first = await fakeTui(shared);
    conversation(home, ID(5), shared);
    conversation(home, ID(6), shared);
    assert.deepEqual(info(first, home).session_id, undefined);
    const crowded = fs.mkdtempSync(path.join(scratch, 'crowded-'));
    const a = await fakeTui(crowded);
    await fakeTui(crowded);
    conversation(home, ID(7), crowded);
    assert.deepEqual(info(a, home).session_id, undefined);
  });

  test('a missing store, or an id that is not a conversation id, is no conversation and no error', async () => {
    const pid = await fakeTui(work, '--resume', '../../etc');
    assert.equal(info(pid, path.join(scratch, 'absent')).session_id, undefined);
  });
});
