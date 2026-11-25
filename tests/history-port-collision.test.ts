// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import net from 'node:net';
import {test} from 'node:test';
import {runHistoryServer} from './history-resume-name-lib.ts';
import {listenerReady, removeScratch, scratchHome, stopServer} from './mesh-server-lib.ts';

test('concurrent history servers survive a port claimed after allocation without accepting foreign listeners', async () => {
  const places: Awaited<ReturnType<typeof scratchHome>>[] = [];
  const blockers: net.Server[] = [];
  const running: Awaited<ReturnType<typeof runHistoryServer>>[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const place = await scratchHome('history-port-race-'); places.push(place);
      const blocker = net.createServer(socket => socket.destroy());
      await new Promise<void>((resolve, reject) => blocker.once('error', reject).listen(place.port, '127.0.0.1', resolve));
      blockers.push(blocker);
    }
    const oldPorts = places.map(place => place.port);
    const results = await Promise.allSettled(places.map(async place => {
      const run = await runHistoryServer(place); running.push(run); return run;
    }));
    for (let i = 0; i < places.length; i++) {
      const result = results[i]!;
      assert.equal(result.status, 'fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      assert.equal(result.value.result.listened, true, result.value.result.output);
      assert.notEqual(places[i]!.port, oldPorts[i]);
      assert.equal(await listenerReady(result.value.child, places[i]!.port), true);
      assert.equal(blockers[i]!.listening, true, 'foreign listener was left untouched');
    }
    assert.equal(new Set(places.map(place => place.port)).size, places.length);
  } finally {
    await Promise.all(running.map(run => stopServer(run.child)));
    await Promise.all(blockers.map(blocker => new Promise<void>(resolve => blocker.close(() => resolve()))));
    for (const place of places) removeScratch(place.scratch);
  }
});

test('a startup failure other than a bind collision is not retried', async () => {
  const place = await scratchHome('history-port-invalid-');
  const port = place.port;
  place.env.MESH_PORT = 'not-a-port';
  try {
    const run = await runHistoryServer(place);
    assert.equal(run.result.listened, false);
    assert.equal(place.port, port);
    assert.match(run.result.output, /not-a-port/);
    await stopServer(run.child);
  } finally { removeScratch(place.scratch); }
});
