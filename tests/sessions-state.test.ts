// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/sessions answers from the background state (docs/sessions-api.md): one round at a time reads
// the PTY host and describes the sessions; a request never runs a listing of its own. With 300 sessions
// the first answer is a skeleton built from the host's list, mesh.json and the recovery snapshot, and the
// snapshot is not written from it. A fake PTY host (tests/fake-pty-host.ts) serves the list and counts the
// requests; its sessions are real idle processes, so the listing describes real pids.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {type FakeHost, type FakeSession, sleepers, startFakeHost} from './fake-pty-host.ts';
import {removeScratch, runServer, scratchHome, stopServer, type Scratch} from './mesh-server-lib.ts';

type Row = {name: string; ready: boolean; label?: string | null; agent?: Record<string, unknown> | null};
type Answer = {mesh: Row[]; generation: number; now: number; opens?: unknown[]; full: boolean; complete: boolean; counts: {total: number; ready: number};
  host: string; removed?: string[]; external?: unknown[]; focus?: string[]; restorable: unknown[];
  management: {state?: string}; update: unknown; sessionRequests: unknown; agentMailConsent: unknown};

type Mesh = {where: Scratch; server: ChildProcess; host: FakeHost; base: string; snapshot: string; startedMs: number};

const SOCKET = (where: Scratch) => path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock');

function rows(pids: number[], cwd: string): FakeSession[] {
  return pids.map((pid, i) => ({name: `s${String(i).padStart(3, '0')}`, pid, cwd, created: 1_700_000_000 + i,
    activity: 1_700_000_000 + i, attached: 0, meta: {}}));
}

/** A recovery snapshot from an earlier run that knows the agent of the first `count` sessions. */
function earlierSnapshot(file: string, sessions: FakeSession[], count: number): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({version: 1, host: null, lost: [], live: sessions.slice(0, count).map(s => ({
    name: s.name, cwd: s.cwd, created: s.created, cmd: null, lost_at: null, org: {},
    agent: {type: 'claude', session_id: `conversation-${s.name}`, argv: ['claude', '--resume', 'argv-never-shown']}}))}));
}

async function start(prefix: string, sessions: (where: Scratch) => FakeSession[], hostMode: object, seed: number): Promise<Mesh> {
  const where = await scratchHome(prefix, {MESH_SESSIONS_WAIT: '', MESH_TEST_SESSIONS_COMPLETE: ''});   // the server's default wait
  const snapshot = path.join(where.confDir, 'sessions-snapshot.json');
  const listed = sessions(where);
  earlierSnapshot(snapshot, listed, seed);
  const host = await startFakeHost(SOCKET(where), {sessions: listed, ...hostMode});
  const startedMs = Date.now();
  const {child, result} = await runServer(where);
  assert.ok(result.listened, result.output);
  return {where, server: child, host, base: `http://127.0.0.1:${where.port}`, snapshot, startedMs};
}

async function stop(mesh: Mesh | undefined): Promise<void> {
  if (!mesh) return;
  await stopServer(mesh.server);
  await mesh.host.stop();
  removeScratch(mesh.where.scratch);
}

function token(mesh: Mesh): string {
  return fs.readFileSync(path.join(mesh.where.confDir, 'token'), 'utf8').trim();
}

/** JSON.parse, refusing a duplicate key in any object as a strict parser does. */
function strictParse(text: string): unknown {
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '')) at += 1; };
  const string = (): string => {
    const start = at;
    for (at += 1; text[at] !== '"'; at += text[at] === '\\' ? 2 : 1);
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const value = (): void => {
    space();
    const open = text[at];
    if (open !== '{' && open !== '[') { if (open === '"') string(); else while (at < text.length && !/[,\]}\s]/.test(text[at]!)) at += 1; return; }
    const keys = new Set<string>();
    for (at += 1, space(); text[at] !== (open === '{' ? '}' : ']'); space()) {
      if (open === '{') {
        space();
        const key = string();
        assert.ok(!keys.has(key), `duplicate key ${key}`);
        keys.add(key);
        space();
        at += 1;   // the colon
      }
      value();
      space();
      if (text[at] === ',') at += 1;
    }
    at += 1;
  };
  value();
  return JSON.parse(text);
}

async function get(mesh: Mesh, query = ''): Promise<{ms: number; body: Answer}> {
  const sent = performance.now();
  const response = await fetch(`${mesh.base}/api/sessions${query}`, {headers: {Authorization: `Bearer ${token(mesh)}`, Origin: mesh.base}});
  assert.equal(response.status, 200);
  const body = strictParse(await response.text()) as Answer;
  return {ms: performance.now() - sent, body};
}

async function until(mesh: Mesh, what: string, timeoutMs: number, done: (body: Answer) => boolean, query = ''): Promise<Answer> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const {body} = await get(mesh, query);
    if (done(body)) return body;
    if (performance.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const lists = (mesh: Mesh) => mesh.host.ops().filter(op => op === 'list').length;

/** Until the host has not been asked to list for two seconds (no round, no read runs); the number of lists then. */
async function quiet(mesh: Mesh): Promise<number> {
  let seen = lists(mesh);
  for (let calm = 0; calm < 8; calm += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (lists(mesh) !== seen) { seen = lists(mesh); calm = 0; }
  }
  return seen;
}

describe('300 sessions', () => {
  const N = 300;
  let mesh: Mesh;
  let processes: ReturnType<typeof sleepers>;
  let sessions: FakeSession[];
  before(async () => {
    processes = sleepers(N);
    mesh = await start('sessions-state-', where => (sessions = rows(processes.pids, where.home)), {}, 10);
    // From the second list on (the first request asks for a read and a round at once; the round reads again
    // under the organisation lock, before it writes the snapshot) each waits 3 s: meanwhile the state holds
    // the skeleton.
    const base = await quiet(mesh);
    mesh.host.control({sessions, slowFrom: base + 2, delayMs: 3000});
  });
  after(async () => { await stop(mesh); processes?.kill(); });

  test('the first answer is a skeleton, under 500 ms, and the snapshot is not written from it', async () => {
    const before = fs.readFileSync(mesh.snapshot);
    const {ms, body} = await get(mesh);
    assert.ok(ms < 500, `first answer in ${Math.round(ms)} ms`);
    assert.equal(body.mesh.length, N);
    assert.ok(body.mesh.every(row => row.ready === false), 'every row of the skeleton is provisional');
    assert.equal(body.management.state, 'pending');
    assert.equal(body.complete, false);
    assert.deepEqual(body.counts, {total: N, ready: 0});
    assert.equal(body.full, true);
    assert.ok(body.generation >= mesh.startedMs, 'the generation starts from the start time in ms');
    const known = body.mesh.find(row => row.name === 's000')!;
    assert.deepEqual(known.agent, {type: 'claude', session_id: 'conversation-s000', provisional: true});
    assert.ok(!JSON.stringify(body).includes('argv-never-shown'), 'never the stored argv');
    assert.ok('update' in body && 'sessionRequests' in body && 'agentMailConsent' in body);
    assert.ok(Array.isArray(body.opens), 'the skeleton carries the open requests (a client sets its replay cutoff from them)');
    assert.deepEqual(fs.readFileSync(mesh.snapshot), before, 'the skeleton does not write the snapshot');
    console.log(`first answer: ${Math.round(ms)} ms for ${N} sessions`);
  });

  test('the listing replaces the skeleton, and the snapshot follows it', async () => {
    const body = await until(mesh, 'a complete listing', 60_000, answer => answer.complete);
    assert.deepEqual(body.counts, {total: N, ready: N});
    assert.ok(body.mesh.every(row => row.ready === true));
    assert.notEqual(body.management.state, 'pending');
    const written = JSON.parse(fs.readFileSync(mesh.snapshot, 'utf8')) as {live: unknown[]; lost: unknown[]};
    assert.equal(written.live.length, N);
    mesh.host.control({sessions});   // no more slow lists
  });

  test('16 simultaneous requests share the rounds: no host list per request', async () => {
    const before = await quiet(mesh);
    const replies = await Promise.all(Array.from({length: 16}, () => get(mesh)));
    for (const {body} of replies) assert.equal(body.mesh.length, N);
    const made = await quiet(mesh) - before;
    // A round lists twice (once to describe, once under the organisation lock to write) and a read once: the
    // burst asked for one of each, and at most one more of each may have started meanwhile.
    assert.ok(made <= 6, `${made} host lists for 16 requests`);
  });

  test('a host restart while half the sessions are not described offers none of them for restore', async () => {
    // The new host's first two lists (a request's read, and the one the round describes) name half of the
    // sessions; the list read under the lock, before the snapshot is written, names them all. The other half
    // are seen, not described: their entries are kept, never taken for lost ones.
    await quiet(mesh);   // no round in flight reads the old host first
    await mesh.host.restart({sessions, firstList: sessions.slice(0, N / 2).map(s => s.name)});
    await until(mesh, 'the restarted host', 30_000, body => body.host === 'restarted');
    await until(mesh, 'a listing of every session', 30_000, body => body.mesh.length === N && body.host === 'ok');
    const written = JSON.parse(fs.readFileSync(mesh.snapshot, 'utf8')) as {live: unknown[]; lost: unknown[]};
    assert.deepEqual(written.lost, []);
    assert.equal(written.live.length, N);
    assert.deepEqual((await get(mesh)).body.restorable, []);
  });

  test('the event loop keeps answering during bursts and rounds', async () => {
    // The heartbeat runs in a process of its own, so that this one decoding the bursts' answers does not
    // delay it: every 20 ms an unauthenticated request, which the server refuses on its event loop.
    const heartbeat = spawn(process.execPath, ['-e', `
      const lags = []; const end = Date.now() + 5000;
      (async () => {
        while (Date.now() < end) {
          const sent = performance.now();
          if ((await fetch(process.argv[1])).status !== 401) process.exit(2);
          lags.push(performance.now() - sent);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        console.log(JSON.stringify(lags));
      })();`, `${mesh.base}/api/sessions`], {stdio: ['ignore', 'pipe', 'inherit']});
    let output = '';
    heartbeat.stdout!.on('data', chunk => { output += chunk; });
    const done = new Promise(resolve => heartbeat.on('close', resolve));
    const until = performance.now() + 5000;   // bursts that ask for rounds, while rounds run
    while (performance.now() < until) {
      await Promise.all(Array.from({length: 16}, () => get(mesh)));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await done, 0);
    const lags = JSON.parse(output) as number[];
    const worst = Math.max(...lags);
    console.log(`heartbeat: ${lags.length} probes, worst ${Math.round(worst)} ms`);
    assert.ok(worst < Number(process.env.MESH_TEST_LOOP_STALL_MS || 100), `the event loop stalled ${Math.round(worst)} ms`);
  });

  test('a new session and a rename are visible within one round', async () => {
    mesh.host.control({sessions: [...sessions, {...sessions[0]!, name: 'fresh', created: 1_800_000_000}]});
    await until(mesh, 'the new session', 30_000, body => body.mesh.some(row => row.name === 'fresh'));
    const renamed = await fetch(`${mesh.base}/api/organize`, {method: 'POST', body: JSON.stringify({op: 'rename', id: 's001', label: 'Renamed'}),
      headers: {Authorization: `Bearer ${token(mesh)}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
    assert.equal(renamed.status, 200);
    await until(mesh, 'the new label', 30_000, body => body.mesh.some(row => row.name === 's001' && row.label === 'Renamed'));
  });

  test('since: only the changed rows, the removed names, and external only when it changed', async () => {
    const full = (await get(mesh)).body;
    mesh.host.control({sessions});   // "fresh" ends
    const delta = await until(mesh, 'the removal', 30_000, body => (body.removed ?? []).includes('fresh'), `?since=${full.generation}`);
    assert.ok((await get(mesh, `?since=${full.generation}`)).ms < 500, 'a request with since never waits for a round');
    assert.equal(delta.full, false);
    assert.ok(delta.generation > full.generation);
    assert.ok(delta.mesh.length < N / 2, `${delta.mesh.length} rows in a delta`);
    assert.ok(!delta.mesh.some(row => row.name === 'fresh'));
    assert.deepEqual(delta.counts, {total: N, ready: N});
    // Nothing changed since the current generation: an empty delta, without `external`.
    const same = await until(mesh, 'a quiet delta', 30_000, body => body.mesh.length === 0,
      `?since=${(await get(mesh)).body.generation}`);
    assert.equal(same.full, false);
    assert.deepEqual(same.removed, []);
    assert.ok(!('external' in same), 'an unchanged external list is not sent in a delta');
    for (const since of ['abc', '-1', '1'.repeat(17), '1', String(same.generation + 1000)]) {
      const {body} = await get(mesh, `?since=${since}`);
      assert.equal(body.full, true, `since=${since}`);
      assert.equal(body.mesh.length, N, `since=${since}`);
      assert.ok(Array.isArray(body.external));
    }
  });

  test('focus: bounded, distinct, valid names the host lists', async () => {
    const focus = async (value: string) => (await get(mesh, `?focus=${encodeURIComponent(value)}`)).body.focus;
    assert.deepEqual(await focus('s002,s002,bad name!,s003,unknown,s002,'), ['s002', 's003']);
    assert.equal((await focus(sessions.slice(0, 70).map(s => s.name).join(','))).length, 64);
    assert.equal(await focus('s'.repeat(5000)), undefined, 'an oversized focus is ignored');
    assert.equal((await get(mesh)).body.focus, undefined);
    assert.deepEqual(await focus(['../etc', '', 's004', 'x'.repeat(49)].join(',')), ['s004']);
  });
});

describe('a silent host', () => {
  let mesh: Mesh;
  before(async () => {
    mesh = await start('sessions-silent-', where => rows([process.pid], where.home), {silent: true}, 1);
  });
  after(async () => { await stop(mesh); });

  test('answers within the silent threshold (1 s) with host "silent", then at once, and leaves the snapshot as it was', async () => {
    const before = fs.readFileSync(mesh.snapshot);
    const mtime = fs.statSync(mesh.snapshot).mtimeMs;
    const {ms, body} = await get(mesh);
    assert.ok(ms < 1500, `answer in ${Math.round(ms)} ms`);
    assert.equal(body.host, 'silent');
    assert.equal(body.complete, false);
    // Past the host's request timeout (5 s): the round gave up, the answers still come at once.
    await new Promise(resolve => setTimeout(resolve, 6000));
    const later = await get(mesh);
    assert.ok(later.ms < 500, `answer in ${Math.round(later.ms)} ms`);
    assert.equal(later.body.host, 'silent');
    assert.ok(mesh.host.ops().includes('list'), 'the round asked the host');
    assert.deepEqual(fs.readFileSync(mesh.snapshot), before);
    assert.equal(fs.statSync(mesh.snapshot).mtimeMs, mtime);
  });
});

describe('slow rounds, with the default wait', () => {
  let mesh: Mesh;
  let processes: ReturnType<typeof sleepers>;
  let sessions: FakeSession[];
  before(async () => {
    processes = sleepers(4);
    mesh = await start('sessions-slow-', where => (sessions = rows(processes.pids, where.home)), {}, 1);
    await until(mesh, 'a complete listing', 60_000, answer => answer.complete);
  });
  after(async () => { await stop(mesh); processes?.kill(); });

  test('a session created, or ended, while a round runs is in the next answer, and now is the answer\'s time', async () => {
    // A round's listing records the conversations it saw under this file lock: held, every round lasts 8 s.
    const lock = path.join(mesh.where.confDir, 'conversation-names.lock');
    const holder = spawn('flock', [lock, 'sleep', '8'], {stdio: 'ignore'});
    await new Promise(resolve => setTimeout(resolve, 300));
    await get(mesh, '?since=0');   // starts a round, which stops at the lock
    await new Promise(resolve => setTimeout(resolve, 1500));
    mesh.host.control({sessions: [...sessions.slice(1), {...sessions[0]!, name: 'fresh', created: 1_800_000_000}]});
    const {ms, body} = await get(mesh);   // what the page does right after POST /api/new, before it opens the pane
    const fresh = body.mesh.find(row => row.name === 'fresh');
    assert.ok(fresh, `the new session is listed (answer in ${Math.round(ms)} ms)`);
    assert.equal(fresh.ready, false);
    assert.ok(!body.mesh.some(row => row.name === sessions[0]!.name), 'the ended session is not listed');
    assert.ok(ms < 2500, `answer in ${Math.round(ms)} ms`);
    assert.ok(Math.abs(body.now * 1000 - Date.now()) < 1000, 'now is the time of the answer, not of the last round');
    holder.kill('SIGKILL');
    await until(mesh, 'the new session described', 30_000, answer => answer.mesh.some(row => row.name === 'fresh' && row.ready));
  });
});

describe('a failing extra', () => {
  let mesh: Mesh;
  before(async () => {
    mesh = await start('sessions-extra-', where => {
      // The agent-mail lock cannot be opened: reading the consent requests fails at every round.
      fs.mkdirSync(path.join(where.confDir, 'agent-mail.json.lock'), {recursive: true});
      return rows([process.pid], where.home);
    }, {}, 0);
  });
  after(async () => { await stop(mesh); });

  test('neither stops the listing nor the restart snapshot', async () => {
    const body = await until(mesh, 'a complete listing', 30_000, answer => answer.complete);
    assert.deepEqual(body.agentMailConsent, []);
    assert.ok(Array.isArray(body.sessionRequests));
    const written = JSON.parse(fs.readFileSync(mesh.snapshot, 'utf8')) as {live: unknown[]};
    assert.equal(written.live.length, 1, 'the round recorded the snapshot');
  });
});
