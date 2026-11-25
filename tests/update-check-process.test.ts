// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Where the update check runs: in the native PTY host (OCaml), which asks for the answer once at
// startup and every three hours and keeps it in memory; server.py only relays the host's
// `update_notice` reply as the `update` field of /api/sessions, and runs no program of its own for
// it. An older host does not know the request (it answers an error), a source install or a missing
// host has nothing to say: the field is then null. `./mesh` help and doctor read the cache only and
// never wait. The host's curl here is a stand-in: no request leaves the machine.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {startUpdateHost, NOTES} from './helpers/update-host.ts';
import {REPO, removeScratch, startMesh, type Mesh} from './mesh-server-lib.ts';
import {encode} from './ptyhost-wire-lib.ts';

const until = async <T>(what: string, probe: () => Promise<T | false>): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const listing = async (mesh: Mesh): Promise<{update: unknown}> =>
  await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base}})).json() as {update: unknown};

/** A PTY host from before the update check: it lists no session and answers every other request with an error. */
function olderHost(socket: string): net.Server {
  fs.mkdirSync(path.dirname(socket), {recursive: true, mode: 0o700});
  const server = net.createServer(connection => {
    let received = Buffer.alloc(0);
    connection.on('error', () => undefined);
    connection.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
      const request = JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')) as {op?: string};
      const reply = request.op === 'list' ? [] : {error: 'invalid request'};
      connection.end(encode('C', Buffer.from(JSON.stringify(reply))));
    });
  });
  server.listen(socket);
  return server;
}

describe('update check', () => {
  test('the PTY host runs it and the server only relays its answer', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-update-proc-'));
    const mesh = await startMesh('upd-proc-', {MESH_BIN_DIR: bin});
    // A server that still started the program would leave this trace.
    fs.writeFileSync(path.join(bin, 'mesh-platform'), `#!/bin/sh\necho "$@" > '${path.join(bin, 'invoked')}'\n`, {mode: 0o755});
    let host: ReturnType<typeof startUpdateHost> | undefined;
    try {
      assert.equal((await listing(mesh)).update, null, 'no host yet: nothing');
      host = startUpdateHost(mesh, {release: true});
      const update = await until('the notice', async () => {
        const value = (await listing(mesh)).update as Record<string, unknown> | null;
        return value && value.status === 'available' ? value : false;
      });
      assert.equal(update.latest, 'v0.2.0');
      assert.equal(update.current, 'v0.1.0');
      assert.equal(update.security, true);
      assert.equal(update.notes_url, NOTES);
      assert.equal(host.log().split('mesh-ptyhost: Session Mesh v0.2.0 is available').length - 1, 1, 'one log line, written by the host');
      assert.equal(fs.existsSync(path.join(bin, 'invoked')), false, 'the server runs no update program');
      assert.ok(!mesh.output().includes('is available'), 'and logs no notice of its own');
    } finally {
      await host?.stop();
      await mesh.stop();
      removeScratch(bin);
    }
  });

  test('a source install, an older host and no host show nothing', async () => {
    const mesh = await startMesh('upd-none-');
    try {
      assert.equal((await listing(mesh)).update, null, 'no host');
      const cache = path.join(mesh.home, '.cache', 'session-mesh');
      fs.mkdirSync(cache, {recursive: true});
      fs.writeFileSync(path.join(cache, 'unrelated-cache'), 'another feature may use this directory');
      const requested = path.join(mesh.home, 'update-requested');
      const source = startUpdateHost(mesh, {release: false,
        curl: '#!/bin/sh\nprintf called > "$HOME/update-requested"\nexit 1\n'});
      try {
        await until('the host', async () => fs.existsSync(source.socket));
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal((await listing(mesh)).update, null, 'a source install');
        // Only the updater's file/request are absent; listing/history caches may use this directory.
        assert.equal(fs.existsSync(path.join(cache, 'update-check.json')), false, 'no update cache');
        assert.equal(fs.existsSync(requested), false, 'no update request');
        assert.equal(fs.readFileSync(path.join(cache, 'unrelated-cache'), 'utf8'),
          'another feature may use this directory', 'unrelated cache entries are preserved');
      } finally {
        await source.stop();
      }
      fs.rmSync(path.dirname(source.socket), {recursive: true, force: true});
      const older = olderHost(source.socket);
      try {
        assert.equal((await listing(mesh)).update, null, 'an older host');
      } finally {
        older.close();
      }
    } finally {
      await mesh.stop();
    }
  });

  test('./mesh help and doctor read the cache only and print its line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-update-cli-'));
    try {
      fs.mkdirSync(path.join(root, 'bin'));
      fs.copyFileSync(path.join(REPO, 'scripts/bundle/mesh'), path.join(root, 'mesh'));
      fs.copyFileSync(path.join(REPO, 'scripts/bundle/env.sh'), path.join(root, 'env.sh'));
      // Waits a minute unless it is told not to make a request, as a stale cache offline would.
      fs.writeFileSync(path.join(root, 'bin', 'mesh-platform'),
        '#!/bin/sh\ncase " $* " in *" --cache-only "*) echo "Session Mesh v9.9.9 is available" ;; *) sleep 60 ;; esac\n',
        {mode: 0o755});
      fs.writeFileSync(path.join(root, 'bin', 'mesh-python'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
      const started = Date.now();
      const help = spawnSync('bash', [path.join(root, 'mesh'), 'help'], {encoding: 'utf8', timeout: 20000});
      assert.equal(help.status, 2);
      assert.ok(Date.now() - started < 10000, 'help does not wait for a request');
      assert.match(help.stdout, /^Session Mesh v9\.9\.9 is available\n/);
    } finally {
      removeScratch(root);
    }
  });
});
