// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The event-loop check of tests/sessions-state.test.ts (tests/loop-heartbeat.ts). Its rule on figures
// measured on CI and with the regression it guards against, then against a server of its own: a loop held
// for 1 s in every window, or for 120 ms over and over, fails it; a loop that answers passes, and so does a
// single held window followed by a clean one.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {type ChildProcess, spawn} from 'node:child_process';
import {assertLoopAnswers, judge} from './loop-heartbeat.ts';

/** `count` probes of `ms`, then the `slow` ones. */
const lags = (count: number, ms: number, ...slow: number[]) => [...Array.from({length: count}, () => ms), ...slow];

describe('the stall rule', () => {
  test('a few slow probes of a busy machine are not a stall', () => {
    assert.equal(judge(lags(200, 2, 190)).stalled, null);   // the worst CI window seen
    assert.equal(judge(lags(140, 8, 60, 70, 95, 120, 160, 213)).stalled, null);
  });

  test('a loop held at every round is a stall, and so is one probe held 400 ms or more', () => {
    assert.match(judge(lags(90, 2, ...lags(20, 120))).stalled ?? '', /one probe in ten waited 120 ms/);
    assert.match(judge(lags(200, 2, 450)).stalled ?? '', /a probe waited 450 ms/);
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

  /** A load that holds the server's loop for 1 s in the windows `held` says, then idles to the end. */
  const holding = (held: (index: number) => boolean) => {
    let windows = 0;
    return async (end: number) => {
      if (held(windows++)) {
        await pause(300);   // the probes have started
        await fetch(`${base}/block?ms=1000`);
      }
      while (performance.now() < end) await pause(50);
    };
  };

  test('a loop held for 1 s in every window fails, after a second window', async () => {
    await assert.rejects(assertLoopAnswers(`${base}/`, WINDOW_MS, holding(() => true)), /a probe waited \d+ ms .*; then a probe waited/);
  });

  test('a loop held 120 ms over and over fails, after a second window', async () => {
    const load = async (end: number) => {
      while (performance.now() < end) {
        await fetch(`${base}/block?ms=120`);
        await pause(100);
      }
    };
    await assert.rejects(assertLoopAnswers(`${base}/`, WINDOW_MS, load), /one probe in ten waited \d+ ms .*; then/);
  });

  test('a loop that keeps answering passes', async () => {
    await assertLoopAnswers(`${base}/`, WINDOW_MS, holding(() => false));
  });

  test('one held window, then a clean one, passes', async () => {
    const windows = await assertLoopAnswers(`${base}/`, WINDOW_MS, holding(index => index === 0));
    assert.equal(windows.length, 2);
    assert.ok(windows[0]!.worst >= 900, `the first window saw the hold: ${windows[0]!.worst} ms`);
  });
});
