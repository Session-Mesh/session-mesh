// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The event-loop check of tests/sessions-state.test.ts (tests/loop-heartbeat.ts). Its rule on figures
// measured on CI and with the regression it guards against, then against a server of its own: a loop held
// for 1 s in every window, or for 120 ms over and over, fails it after exactly two windows; a loop held
// once for 2 s fails it at once; a loop that answers passes, and so does a single window held for 1 s
// followed by a clean one. The stall bound is given explicitly (400 ms), so MESH_TEST_LOOP_STALL_MS set in
// the environment does not change these tests.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {type ChildProcess, spawn} from 'node:child_process';
import {assertLoopAnswers, judge} from './loop-heartbeat.ts';

const STALL_MS = 400;

/** `count` probes of `ms`, then the `slow` ones. */
const lags = (count: number, ms: number, ...slow: number[]) => [...Array.from({length: count}, () => ms), ...slow];

describe('the stall rule', () => {
  test('a few slow probes of a busy machine are not a stall', () => {
    assert.equal(judge(lags(200, 2, 190), STALL_MS).stalled, null);   // the worst CI window seen
    assert.equal(judge(lags(140, 8, 60, 70, 95, 120, 160, 213), STALL_MS).stalled, null);
  });

  test('a loop held at every round is a stall, and so is one probe held 400 ms or more', () => {
    assert.match(judge(lags(90, 2, ...lags(20, 120)), STALL_MS).stalled ?? '', /one probe in ten waited 120 ms/);
    assert.match(judge(lags(200, 2, 450), STALL_MS).stalled ?? '', /a probe waited 450 ms/);
  });
});

// Every request is refused with 401, as the probes expect; /block?ms=N first holds the loop N ms.
const SERVER = `
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    const held = Number(new URL(request.url, 'http://localhost').searchParams.get('ms') || 0);
    const end = Date.now() + held;
    while (Date.now() < end);
    response.writeHead(401).end();
  });
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));`;

const WINDOW_MS = 2000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('the event-loop check', () => {
  let server: ChildProcess;
  let base: string;
  before(async () => {
    server = spawn(process.execPath, ['-e', SERVER], {stdio: ['ignore', 'pipe', 'inherit']});
    const port = await new Promise<string>(resolve => server.stdout!.once('data', chunk => resolve(String(chunk).trim())));
    base = `http://127.0.0.1:${port}`;
  });
  after(() => { server.kill(); });

  /** A load that holds the server's loop for `ms` in the windows `held` says, then idles to the end;
   * `windows()` is the number of windows it ran in. */
  const holding = (held: (index: number) => boolean, ms = 1000) => {
    let windows = 0;
    const load = async (end: number) => {
      if (held(windows++)) {
        await pause(300);   // the probes have started
        await fetch(`${base}/block?ms=${ms}`);
      }
      while (performance.now() < end) await pause(50);
    };
    return Object.assign(load, {windows: () => windows});
  };

  test('a loop held for 1 s in every window fails after exactly two windows', async () => {
    const load = holding(() => true);
    await assert.rejects(assertLoopAnswers(`${base}/`, WINDOW_MS, load, STALL_MS),
      /^AssertionError.*: a probe waited \d+ ms [^;]*; then a probe waited \d+ ms [^;]*$/);
    assert.equal(load.windows(), 2);
  });

  test('a loop held 120 ms over and over fails, after a second window', async () => {
    const load = async (end: number) => {
      while (performance.now() < end) {
        await fetch(`${base}/block?ms=120`);
        await pause(100);
      }
    };
    await assert.rejects(assertLoopAnswers(`${base}/`, WINDOW_MS, load, STALL_MS), /one probe in ten waited \d+ ms .*; then/);
  });

  test('a loop held once for 2 s fails at once, without a second window', async () => {
    // A 3 s window, so that the probes before and after the hold stay well above the minimum count.
    const load = holding(index => index === 0, 2000);
    await assert.rejects(assertLoopAnswers(`${base}/`, 3000, load, STALL_MS), /the event loop froze: a probe waited \d+ ms/);
    assert.equal(load.windows(), 1);
  });

  test('a loop that keeps answering passes', async () => {
    await assertLoopAnswers(`${base}/`, WINDOW_MS, holding(() => false), STALL_MS);
  });

  test('one window held for 1 s, then a clean one, passes', async () => {
    const windows = await assertLoopAnswers(`${base}/`, WINDOW_MS, holding(index => index === 0), STALL_MS);
    assert.equal(windows.length, 2);
    assert.ok(windows[0]!.worst >= 900, `the first window saw the hold: ${windows[0]!.worst} ms`);
  });
});
