// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// server.py when its state or its PTY host is not what it expects:
// - a symlinked or shared session-request database: one line and status 1, no traceback (under
//   systemd a traceback per restart is a restart loop that says nothing);
// - a damaged database is set aside, and only the three most recent damaged copies are kept;
// - a marker table with NaN or Infinity, or a dangling symbolic link in its place, is unreadable:
//   documents get file-only scope (fail closed), as for any other corrupt table;
// - a PTY host that accepts and never answers gives 503, also on Python 3.10, where
//   asyncio.TimeoutError is not an OSError (run with MESH_PYTHON=<a 3.10 interpreter> for that).
// Each server runs in its own scratch home (tests/mesh-server-lib.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {runServer, scratchHome, stopServer, type Scratch} from './mesh-server-lib.ts';

const DATABASE = 'session-requests.sqlite3';
const MARKERS = 'session-opened-documents.json';
const scratches: string[] = [];
after(() => { for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true}); });

async function home(prefix: string): Promise<Scratch> {
  const where = await scratchHome(prefix);
  scratches.push(where.scratch);
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
  return where;
}

async function refusal(where: Scratch): Promise<string> {
  const {result} = await runServer(where);
  assert.equal(result.listened, false, result.output);
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /Traceback/);
  return result.output;
}

async function startOutput(where: Scratch): Promise<string> {
  const {child, result, output} = await runServer(where);
  assert.equal(result.listened, true, result.output);
  await stopServer(child);
  return output();
}

describe('server.py start-up with surprising state', () => {
  test('a symlinked session-request database is refused in one line', async () => {
    const where = await home('mesh-robust-link-');
    const elsewhere = path.join(where.scratch, 'elsewhere.sqlite3');
    fs.writeFileSync(elsewhere, '', {mode: 0o600});
    fs.symlinkSync(elsewhere, path.join(where.confDir, DATABASE));
    assert.match(await refusal(where), /session-mesh: refusing to start: Request storage is not a regular file/);
  });

  test('a session-request database readable by others is refused in one line', async () => {
    const where = await home('mesh-robust-mode-');
    fs.writeFileSync(path.join(where.confDir, DATABASE), '', {mode: 0o644});
    fs.chmodSync(path.join(where.confDir, DATABASE), 0o644);
    assert.match(await refusal(where), /session-mesh: refusing to start: Request storage is not private/);
  });

  test('a damaged database is set aside, keeping the three most recent copies', async () => {
    const where = await home('mesh-robust-corrupt-');
    for (const stamp of [1, 2, 3, 4, 5]) {
      fs.writeFileSync(path.join(where.confDir, `${DATABASE}.corrupt-${stamp}`), 'old', {mode: 0o600});
    }
    fs.writeFileSync(path.join(where.confDir, `${DATABASE}.corrupt-1-wal`), 'old', {mode: 0o600});
    fs.writeFileSync(path.join(where.confDir, DATABASE), 'this is not a database'.repeat(100), {mode: 0o600});
    assert.match(await startOutput(where), /is not a usable database/);
    const copies = fs.readdirSync(where.confDir).filter(name => name.startsWith(`${DATABASE}.corrupt-`)).sort();
    assert.equal(copies.length, 3, copies.join(' '));
    const stamps = copies.map(name => Number(name.slice(`${DATABASE}.corrupt-`.length))).sort((a, b) => a - b);
    assert.deepEqual(stamps.slice(0, 2), [4, 5]);
    assert.ok(stamps[2] > 1e15, `the copy just made is kept: ${copies.join(' ')}`);
  });

  for (const [what, table] of [['NaN', 'NaN'], ['Infinity', 'Infinity']]) {
    test(`a marker table whose all_until is ${what} is unreadable: file-only scope`, async () => {
      const where = await home('mesh-robust-nan-');
      fs.writeFileSync(path.join(where.confDir, MARKERS), `{"version": 1, "all_until": ${table}, "paths": {}}`);
      assert.match(await startOutput(where), new RegExp(`${MARKERS} is unreadable .*no directory access`));
    });
  }

  test('a dangling symbolic link in place of the marker table is unreadable: file-only scope', async () => {
    const where = await home('mesh-robust-dangling-');
    fs.symlinkSync(path.join(where.scratch, 'gone.json'), path.join(where.confDir, MARKERS));
    assert.match(await startOutput(where), new RegExp(`${MARKERS} is unreadable .*no directory access`));
  });
});

describe('server.py with a PTY host that never answers', () => {
  test('a request that needs the host gets 503, the session list an empty answer', async () => {
    const where = await home('mesh-robust-frozen-');
    const socketDir = path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh');
    fs.mkdirSync(socketDir, {recursive: true, mode: 0o700});
    const held: net.Socket[] = [];
    const frozen = net.createServer(socket => { held.push(socket); }).listen(path.join(socketDir, 'ptyhost.sock'));
    const {child, result, output} = await runServer(where);
    try {
      assert.equal(result.listened, true, result.output);
      const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
      const base = `http://127.0.0.1:${where.port}`;
      const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
      const kill = await fetch(`${base}/api/kill/frozen`, {method: 'POST', headers, body: '{"created": 1}'});
      assert.equal(kill.status, 503, `${await kill.text()}\n${output()}`);
      const listed = await fetch(`${base}/api/sessions`, {headers});
      assert.equal(listed.status, 200, `${await listed.text()}\n${output()}`);
      assert.doesNotMatch(output(), /Traceback/);
    } finally {
      await stopServer(child);
      for (const socket of held) socket.destroy();
      frozen.close();
    }
  });
});
