// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanupHistoricalFixture} from './helpers/historical-cleanup.ts';

test('unconfirmed retirement retains the scratch and still stops the fixture host', async () => {
  const calls: string[] = [];
  await assert.rejects(cleanupHistoricalFixture('/fixture/scratch', {
    stopServer: async () => { calls.push('server'); },
    retireHost: async () => { calls.push('retire'); throw new Error('host unavailable'); },
    stopHost: async () => { calls.push('host'); },
    removeScratch: () => { calls.push('remove'); },
  }), /cleanup unconfirmed; retained \/fixture\/scratch/);
  assert.deepEqual(calls,['server','retire','host']);
});

test('successful retirement removes the scratch after the host stops', async () => {
  const calls: string[] = [];
  await cleanupHistoricalFixture('/fixture/scratch', {
    stopServer: async () => { calls.push('server'); },
    retireHost: async () => { calls.push('retire'); },
    stopHost: async () => { calls.push('host'); },
    removeScratch: () => { calls.push('remove'); },
  });
  assert.deepEqual(calls,['server','retire','host','remove']);
});

for (const failed of ['server', 'host'] as const) test(`unconfirmed ${failed} stop retains the scratch`, async () => {
  let removed = false;
  await assert.rejects(cleanupHistoricalFixture('/fixture/scratch', {
    stopServer: async () => { if (failed === 'server') throw new Error('server stop failed'); },
    retireHost: async () => {},
    stopHost: async () => { if (failed === 'host') throw new Error('host stop failed'); },
    removeScratch: () => { removed = true; },
  }), /cleanup unconfirmed; retained \/fixture\/scratch/);
  assert.equal(removed,false);
});
