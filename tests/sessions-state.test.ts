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
import {assertLoopAnswers} from './loop-heartbeat.ts';
import {waitForServer} from './wait-for-token.ts';
import {removeScratch, runServer, scratchHome, stopServer, type Scratch} from './mesh-server-lib.ts';

type Row = {name: string; ready: boolean; label?: string | null; agent?: Record<string, unknown> | null};
type Answer = {mesh: Row[]; generation: number; instance: string; now: number; opens?: unknown[]; full: boolean; complete: boolean; counts: {total: number; ready: number};
  host: string; removed?: string[]; external?: unknown[]; restorable: unknown[];
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

async function start(prefix: string, sessions: (where: Scratch) => FakeSession[], hostMode: object, seed: number,
  wait = ''): Promise<Mesh> {
  const where = await scratchHome(prefix, {MESH_SESSIONS_WAIT: wait, MESH_TEST_SESSIONS_COMPLETE: ''});   // '': the server's default wait
  const snapshot = path.join(where.confDir, 'sessions-snapshot.json');
  const listed = sessions(where);
  earlierSnapshot(snapshot, listed, seed);
  const host = await startFakeHost(SOCKET(where), {sessions: listed, ...hostMode});
  const startedMs = Date.now();
  const {child, result} = await runServer(where);
  if (!result.listened) {   // the suite's teardown gets no Mesh: stop the fake host here
    await host.stop();
    removeScratch(where.scratch);
    assert.fail(result.output);
  }
  const base = `http://127.0.0.1:${where.port}`;
  try {   // the port accepts before the server has written its token file
    await waitForServer(path.join(where.confDir, 'token'), `${base}/api/dirs`, base);
  } catch (error) {
    await stopServer(child);
    await host.stop();
    removeScratch(where.scratch);
    throw error;
  }
  return {where, server: child, host, base, snapshot, startedMs};
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
  const parsed: unknown = JSON.parse(text);   // first: the scan below assumes valid JSON (a truncated body would never end it)
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
  return parsed;
}

async function get(mesh: Mesh, query = '', signal?: AbortSignal): Promise<{ms: number; body: Answer}> {
  const sent = performance.now();
  const response = await fetch(`${mesh.base}/api/sessions${query}`, {headers: {Authorization: `Bearer ${token(mesh)}`, Origin: mesh.base}, signal});
  assert.equal(response.status, 200);
  const body = strictParse(await response.text()) as Answer;
  return {ms: performance.now() - sent, body};
}

async function until(mesh: Mesh, what: string, timeoutMs: number, done: (body: Answer) => boolean, query = ''): Promise<Answer> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // The deadline also bounds a request in flight (a body that never ends).
    const body = await get(mesh, query, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))).then(answer => answer.body,
      error => { if ((error as Error).name === 'TimeoutError') return null; throw error; });
    if (body && done(body)) return body;
    if (performance.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const lists = (mesh: Mesh, op = 'list') => mesh.host.ops().filter(line => line === op).length;

/** Until every list asked of the host is answered and none was asked for two seconds (no round, no read
 * runs); the number of lists then. */
async function quiet(mesh: Mesh): Promise<number> {
  let seen = lists(mesh);
  for (let calm = 0; calm < 8; calm += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (lists(mesh) !== seen || lists(mesh, 'list answered') !== seen) { seen = lists(mesh); calm = 0; }
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
    // Bursts that ask for rounds, while rounds run (tests/loop-heartbeat.ts: the probes, the bound).
    await assertLoopAnswers(`${mesh.base}/api/sessions`, 5000, async end => {
      while (performance.now() < end) {
        await Promise.all(Array.from({length: 16}, () => get(mesh)));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
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
    assert.match(full.instance, /^[0-9a-f]{16}$/);
    assert.equal(delta.instance, full.instance, 'one process, one instance');
    assert.ok(delta.mesh.length < N / 2, `${delta.mesh.length} rows in a delta`);
    assert.ok(!delta.mesh.some(row => row.name === 'fresh'));
    assert.deepEqual(delta.counts, {total: N, ready: N});
    // Nothing changed since the current generation: an empty delta, without `external`. Each try takes the
    // generation again: a change after one (an outside terminal) would stay in every delta to it.
    let same: Answer | undefined;
    for (const deadline = performance.now() + 30_000; !same || same.mesh.length > 0 || 'external' in same;) {
      assert.ok(performance.now() < deadline, 'a quiet delta: not within 30000 ms');
      if (same) await new Promise(resolve => setTimeout(resolve, 200));
      same = (await get(mesh, `?since=${(await get(mesh)).body.generation}`)).body;
    }
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
});

describe('a silent host', () => {
  let mesh: Mesh;
  before(async () => {
    // A 4 s wait: an answer within 2.5 s after the first read failed shows the 1 s bound, not the wait.
    mesh = await start('sessions-silent-', where => rows([process.pid], where.home), {silent: true}, 1, '4');
  });
  after(async () => { await stop(mesh); });

  test('answers within the wait with host "silent", then within 1 s, and leaves the snapshot as it was', async () => {
    const before = fs.readFileSync(mesh.snapshot);
    const mtime = fs.statSync(mesh.snapshot).mtimeMs;
    const {ms, body} = await get(mesh);
    assert.ok(ms < 5000, `answer in ${Math.round(ms)} ms`);
    assert.equal(body.host, 'silent');
    assert.equal(body.complete, false);
    // Past the host's request timeout (5 s): the round gave up; an answer waits at most 1 s for a read. Only a
    // failed read sets that bound (a read merely pending still waits the 4 s): 2.5 s also shows it failed.
    await new Promise(resolve => setTimeout(resolve, 6000));
    const later = await get(mesh);
    assert.ok(later.ms < 2500, `answer in ${Math.round(later.ms)} ms`);
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
  let current: FakeSession[] = [];   // what the host lists now
  before(async () => {
    processes = sleepers(4);
    mesh = await start('sessions-slow-', where => (sessions = rows(processes.pids, where.home)), {}, 1);
    await until(mesh, 'a complete listing', 60_000, answer => answer.complete);
  });
  after(async () => { await stop(mesh); processes?.kill(); });

  test('a session created, or ended, while a round runs is in the next answer, and now is the answer\'s time', async () => {
    // A round's listing records the conversations it saw under this file lock: held, every round lasts 8 s.
    const lock = path.join(mesh.where.confDir, 'conversation-names.lock');
    const holder = spawn('flock', [lock, 'sh', '-c', 'echo held; exec sleep 8'], {stdio: ['ignore', 'pipe', 'ignore']});
    await new Promise(resolve => holder.stdout!.once('data', resolve));   // the lock is held
    const before = lists(mesh);
    await get(mesh, '?since=0');   // starts a round, which stops at the lock
    // The round has read the host's list before it changes (no request without since reads it meanwhile).
    await until(mesh, 'the round\'s read of the host', 30_000, () => lists(mesh, 'list answered') > before, '?since=0');
    await new Promise(resolve => setTimeout(resolve, 1500));   // then describes that list, up to the lock
    mesh.host.control({sessions: [...sessions.slice(1), {...sessions[0]!, name: 'fresh', created: 1_800_000_000}]});
    const {ms, body} = await get(mesh);   // what the page does right after POST /api/new, before it opens the pane
    const fresh = body.mesh.find(row => row.name === 'fresh');
    assert.ok(fresh, `the new session is listed (answer in ${Math.round(ms)} ms)`);
    assert.equal(fresh.ready, false);
    assert.ok(!body.mesh.some(row => row.name === sessions[0]!.name), 'the ended session is not listed');
    // It waits for a read of the host's list that starts after it, not for the held round (nor for its 2 s bound).
    assert.ok(ms < 1500, `answer in ${Math.round(ms)} ms`);
    console.log(`a request without since while a round is held: ${Math.round(ms)} ms`);
    assert.ok(Math.abs(body.now * 1000 - Date.now()) < 1000, 'now is the time of the answer, not of the last round');
    holder.kill('SIGKILL');
    await until(mesh, 'the new session described', 30_000, answer => answer.mesh.some(row => row.name === 'fresh' && row.ready));
    // The held round listed the ended session: when it published, it was dropped again (it is in no later change).
    const after = (await get(mesh, `?since=${body.generation}`)).body;
    assert.ok(![...after.mesh.map(row => row.name), ...after.removed!].includes(sessions[0]!.name), 'the ended session stays removed');
  });

  test('a host list slower than the silent threshold still lists a session created before the request', async () => {
    await quiet(mesh);
    const listed = [...sessions.slice(1), {...sessions[0]!, name: 'fresh', created: 1_800_000_000},
      {...sessions[0]!, name: 'late', created: 1_800_000_100}];
    mesh.host.control({sessions: listed, slowFrom: 1, delayMs: 1300});
    const {ms, body} = await get(mesh);
    assert.ok(body.mesh.some(row => row.name === 'late'), `the new session is listed (answer in ${Math.round(ms)} ms)`);
    mesh.host.control({sessions: (current = listed)});
    await until(mesh, 'the new session described', 30_000, answer => answer.mesh.some(row => row.name === 'late' && row.ready));
  });

  test('host is "silent" only once a host list has been pending for 1 s', async () => {
    await quiet(mesh);
    mesh.host.control({sessions: current, slowFrom: 1, delayMs: 3000});
    await get(mesh, '?since=0');   // asks for a round, whose read of the host's list then lasts 3 s
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await get(mesh, '?since=0')).body.host, 'ok');
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal((await get(mesh, '?since=0')).body.host, 'silent');
    mesh.host.control({sessions: current});
    await until(mesh, 'a complete listing', 30_000, answer => answer.complete && answer.host === 'ok');
  });

  test('a session created as the host comes back is in the next answer without since', async () => {
    await quiet(mesh);
    await mesh.host.stop();   // the PTY host restarts: its socket refuses, the reads fail at once
    await until(mesh, 'the host known silent', 30_000, answer => answer.host === 'silent');
    const listed = [...current, {...sessions[0]!, name: 'back', created: 1_800_000_200}];
    await mesh.host.restart({sessions: listed});   // then POST /api/new creates a session, and the page refreshes
    const {ms, body} = await get(mesh);
    assert.ok(body.mesh.some(row => row.name === 'back'), `the new session is listed (answer in ${Math.round(ms)} ms, host ${body.host})`);
    current = listed;
    await until(mesh, 'the new session described', 30_000, answer => answer.mesh.some(row => row.name === 'back' && row.ready));
  });

  test('8 tabs polling with since ask the host for no list of their own', async () => {
    await quiet(mesh);
    const lock = path.join(mesh.where.confDir, 'conversation-names.lock');
    const holder = spawn('flock', ['-o', lock, 'sleep', '8'], {stdio: 'ignore'});   // -o: killing flock frees the lock
    await new Promise(resolve => setTimeout(resolve, 300));
    const {generation} = (await get(mesh, '?since=0')).body;   // starts a round, which reads, then stops at the lock
    await new Promise(resolve => setTimeout(resolve, 1000));
    const before = lists(mesh);
    const end = performance.now() + 3000;
    await Promise.all(Array.from({length: 8}, async () => {
      while (performance.now() < end) {
        await get(mesh, `?since=${generation}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }));
    const made = lists(mesh) - before;
    holder.kill('SIGKILL');
    assert.equal(made, 0, `${made} host lists for the polls of 8 tabs while a round is held`);
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
