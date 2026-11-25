// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// H marks a human-input lease; only D withdraws an already-pending notice Enter.
// This is an isolated native-PTY protocol test, not model or phone evidence.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {ptyhostArgv} from './ptyhost-command.ts';
import {attach, request, waitFor, type Attachment} from './ptyhost-wire-lib.ts';

const repo = path.resolve(import.meta.dirname, '..');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('original-channel H/D/H withdraws a pending notice Enter, whereas H alone does not', async () => {
  assert.ok(process.env.MESH_PTYHOST_CMD, 'MESH_PTYHOST_CMD must select this tree\'s fresh native build explicitly');
  const [executable] = ptyhostArgv();
  assert.equal(executable, process.env.MESH_PTYHOST_CMD);
  assert.ok(path.isAbsolute(executable)); fs.accessSync(executable, fs.constants.X_OK);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-'));
  const home = path.join(scratch, 'home'), runtime = path.join(scratch, 'run');
  fs.mkdirSync(home, {mode: 0o700}); fs.mkdirSync(runtime, {mode: 0o700});
  const socket = path.join(runtime, 'session-mesh', 'ptyhost.sock');
  const host = spawn(executable, [], {cwd: repo, stdio: ['ignore', 'ignore', 'pipe'],
    env: {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime,
      MESH_RUNTIME_DIR: runtime, MESH_CONF_DIR: path.join(home, 'config'), LANG: 'C'}});
  let errors = '', terminal: Attachment | undefined;
  host.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
  host.on('error', error => { errors = error.message; });
  try {
    await waitFor('private host socket', 10000, () => request(socket, {op: 'list'}).then(() => true, () => false));
    assert.deepEqual(await request(socket, {op: 'new', name: 'agent', cwd: home, command: null}), {ok: true, name: 'agent'});
    const [session] = await request(socket, {op: 'list'}) as {created: number}[];
    terminal = await attach(socket, 'agent');
    const log = path.join(home, 'input.log');
    const script = `stty raw -echo; echo READY; cat > ${quote(log)}`;
    assert.deepEqual(await request(socket, {op: 'start_if', name: 'agent', created: session.created,
      command: `exec -a claude sh -c ${quote(script)}`}), {ok: true});
    await waitFor('raw input receiver', 10000, () => terminal!.output().includes('READY'));
    await pause(300);
    const received = () => fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : '';
    const wake = (serial: number) => request(socket, {op: 'notify_if', name: 'agent', created: session.created,
      notification_id: `dictation_notice_${String(serial).padStart(4, '0')}`, count: 1, through_seq: serial,
      agent: 'claude', idle_since: Date.now() / 1000});
    const lease = {client_id: 'dictation_browser_000001', dirty: true};
    const notice = '# Mesh: new message(s) waiting; the user approved reading mail. '
      + 'Please check mail.inbox and read authorized entries without asking again.';

    assert.deepEqual(await wake(1), {ok: true, accepted: true});
    terminal.send('H', lease);
    await waitFor('notice Enter despite dirty H', 5000, () => received().endsWith('\r'));
    const first = received();
    assert.equal(first, notice + '\r');
    assert.equal(first.includes('\x15'), false, 'H is not human input');

    terminal.send('H', {...lease, dirty: false}); await pause(100);
    assert.deepEqual(await wake(2), {ok: true, accepted: true});
    terminal.send('H', lease);
    const paste = '\x1b[200~dictated original-session prompt\x1b[201~';
    terminal.send('D', Buffer.from(paste));
    await pause(700);
    const added = received().slice(first.length);
    assert.ok(added.startsWith(notice));
    assert.equal(added.endsWith('\x15' + paste), true, JSON.stringify(added));
    assert.equal(added.includes('\r'), false, 'the notice must not submit the dictated prompt');
    terminal.send('D', Buffer.from('\r')); terminal.send('H', {...lease, dirty: false});
    await waitFor('only explicit Send Enter', 5000, () => received().endsWith(paste + '\r'));
    assert.equal(received().slice(first.length).split('\r').length - 1, 1);
  } finally {
    terminal?.close();
    try {
      if (host.exitCode === null && host.signalCode === null) {
        await request(socket, {op: 'kill', name: 'agent'}).catch(() => {});
        await waitFor('private session reaped', 15000, async () =>
          (await request(socket, {op: 'list'}) as unknown[]).length === 0);
      }
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
      try { await waitFor('private host exit', 5000, () => host.exitCode !== null || host.signalCode !== null); }
      catch { host.kill('SIGKILL'); await waitFor('private host reaped', 3000, () => host.exitCode !== null || host.signalCode !== null); }
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  }
  assert.ok(host.exitCode === 0 || host.signalCode === 'SIGTERM', errors);
});
