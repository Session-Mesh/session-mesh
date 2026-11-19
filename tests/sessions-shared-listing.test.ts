// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/sessions under a burst of requests: the requests that arrive while a listing runs share the next
// one instead of each queueing its own behind the organisation lock. A page polls every 4 s; on a loaded
// machine one listing takes longer than that, and one listing per request made the wait grow without bound.
// The `now` of a reply is the time its listing was made: shared listings answer the same value.
// A request sent after a change is answered by a listing that began after it.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {REPO, removeScratch, runServer, scratchHome, stopServer, type Scratch} from './mesh-server-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

type Mesh = {base: string; home: string; token: () => string; stop: () => Promise<void>};

type Listing = {now: number; mesh: unknown[]; external: unknown[]};

let mesh: Mesh;
// The server with a PTY host of its own (both confined to a scratch HOME and a free port), so that a test can create sessions.
async function startWithHost(): Promise<Mesh> {
  const where: Scratch = await scratchHome('shared-listing-');
  const [command, ...args] = nativePtyhost();
  const runtime = where.env.XDG_RUNTIME_DIR!;
  const host: ChildProcess = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH: process.env.PATH, HOME: where.home, XDG_RUNTIME_DIR: runtime, LANG: 'C', SHELL: '/bin/bash'}});
  await waitFor('ptyhost answering', 10000, () => fs.existsSync(path.join(runtime, 'session-mesh', 'ptyhost.sock')));
  const {child, result} = await runServer(where);
  assert.ok(result.listened, result.output);
  return {
    base: `http://127.0.0.1:${where.port}`, home: where.home,
    token: () => fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim(),
    stop: async () => {
      await stopServer(child);
      host.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 300));
      for (let attempt = 0; ; attempt += 1) {   // the sessions of the killed host may still be writing
        try { removeScratch(where.scratch); break; } catch (error) {
          if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    },
  };
}

before(async () => { mesh = await startWithHost(); });
after(async () => { await mesh?.stop(); });

async function listing(): Promise<{sentAt: number; body: Listing}> {
  const sentAt = Date.now() / 1000;
  const response = await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base}});
  assert.equal(response.status, 200);
  return {sentAt, body: await response.json() as Listing};
}

test('a burst of requests shares the listings and every one is answered', async () => {
  await listing();   // the first listing of a fresh server warms its caches
  const burst = 16;
  const replies = await Promise.all(Array.from({length: burst}, () => listing()));
  for (const {body} of replies) {
    assert.ok(Array.isArray(body.mesh) && Array.isArray(body.external), 'a complete listing');
  }
  const made = new Set(replies.map(({body}) => body.now));
  // Far fewer listings than requests (one each before the change gives 16); the exact count depends on how
  // the requests spread over the listing's duration.
  assert.ok(made.size < burst / 2, `${made.size} listings were made for ${burst} simultaneous requests`);
});

async function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${mesh.base}${route}`, {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
}

function names(body: Listing): string[] {
  return (body.mesh as {name: string}[]).map(session => session.name);
}

test('a request sent after a change is never answered by a listing that began before the change', async () => {
  // Pollers keep a listing running all the time. A session is created while one runs; every request sent
  // once the creation has returned must show it. Returning the listing already in flight to a new request
  // would hand some of them a listing that began before the creation.
  let polling = true;
  const pollers = Array.from({length: 3}, async () => { while (polling) await listing(); });
  try {
    for (let round = 0; round < 4; round += 1) {
      const name = `shared-${round}`;
      await new Promise(resolve => setTimeout(resolve, 100));
      const made = await post('/api/new', {preset: 'shell', cwd: mesh.home, name});
      assert.equal(made.status, 200, await made.text());
      const replies = await Promise.all(Array.from({length: 6}, () => listing()));
      for (const {body} of replies) {
        assert.ok(names(body).includes(name), `a reply sent after the creation of ${name} does not list it`);
      }
    }
  } finally {
    polling = false;
    await Promise.all(pollers);
  }
});

test('the per-request fields stay per request', async () => {
  const replies = await Promise.all(Array.from({length: 4}, () => listing()));
  for (const {body} of replies) {
    const fields = body as unknown as Record<string, unknown>;
    assert.ok('sessionRequests' in fields && 'agentMailConsent' in fields && 'update' in fields);
  }
});
