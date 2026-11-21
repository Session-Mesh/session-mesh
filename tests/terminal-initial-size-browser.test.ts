// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';

declare const active: any;

test('the initial owner-none snapshot does not duplicate a claim, but a later release still claims', async () => {
  await harness(async (page, _api, sockets) => {
    await page.waitForFunction(() => !active.conn.autoRedraw && !active.conn.initialFollow
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    const size = await page.evaluate(() => {
      (window as any).sizeClaims = [];
      const socket = active.conn.ws, send = socket.send.bind(socket);
      socket.send = (data: any) => {
        if (typeof data === 'string' && JSON.parse(data).t === 'r') (window as any).sizeClaims.push(JSON.parse(data));
        send(data);
      };
      return {rows: active.term.rows, cols: active.term.cols};
    });
    const socket = sockets.get('A')![0]!;
    socket.send(JSON.stringify({t: 's', ...size, owner: 'none'}));
    await page.waitForFunction(() => active.conn.pty?.owner === 'none');
    assert.deepEqual(await page.evaluate(() => (window as any).sizeClaims), []);
    socket.send(JSON.stringify({t: 's', ...size, owner: 'other'}));
    await page.waitForFunction(() => active.conn.pty?.owner === 'other');
    assert.deepEqual(await page.evaluate(() => (window as any).sizeClaims), []);
    socket.send(JSON.stringify({t: 's', ...size, owner: 'none'}));
    await page.waitForFunction(() => active.conn.pty?.owner === 'none');
    assert.deepEqual(await page.evaluate(() => (window as any).sizeClaims), [{t: 'r', ...size}]);
  }, false, 'en', null);
});
