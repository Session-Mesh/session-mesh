// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session list's progressive loading, without a browser: the generic single-flight poller
// (static/single-flight-poller.ts), its cadence, published retry times and outcomes on a fake clock,
// the contract adapter (static/sessions-contract.ts: counts, ready, since/removed merge, focus) and
// the status rules (static/sessions-status.ts). The other modules: tests/sessions-progress-parts.test.ts.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createPoller, initialState, pollDelay, retryDelay, type Clock, type LoadOutcome, type PollerState} from '../static/single-flight-poller.ts';
import {RETRYABLE, authoritative, holdKnownRows, inventoryUrl, mergeListing, progress, rowState} from '../static/sessions-contract.ts';
import {statusLine, statusTicks, type StatusInput} from '../static/sessions-status.ts';

class FakeClock implements Clock {
  time = 0;
  private timers = new Map<number, {at: number; run: () => void}>();
  private next = 1;
  now() { return this.time; }
  setTimeout(run: () => void, ms: number) { const id = this.next++; this.timers.set(id, {at: this.time + ms, run}); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  pending() { return [...this.timers.values()].map(timer => timer.at).sort((a, b) => a - b); }
  /** Advance to `to`, firing due timers in order (and those they set). */
  async advance(ms: number) {
    const to = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
      await flush();
    }
    this.time = to;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const idle: PollerState = {...initialState(), lastSuccessAt: 1000, lastDurationMs: 50, nextAttemptAt: 5000, everLoaded: true};
const input: StatusInput = {poller: idle, listing: {}, rows: [], now: 0, formatTime: (at: number) => `T${at}`};

/** A load whose answers the test releases one by one; it records how many requests overlapped. */
function scriptedLoad(clock: FakeClock) {
  const calls: {resolve: (outcome: LoadOutcome) => void; signal: AbortSignal; at: number}[] = [];
  let inFlight = 0, maxInFlight = 0;
  const load = (signal: AbortSignal) => new Promise<LoadOutcome>(resolve => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({signal, at: clock.now(), resolve: outcome => { inFlight -= 1; resolve(outcome); }});
  });
  return {load, calls, maxInFlight: () => maxInFlight};
}

describe('single-flight poller', () => {
  test('timer ticks never overlap a slow request, and the next waits as long as the answer took', async () => {
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    const poller = createPoller({load: script.load, apply: value => value, clock});
    void poller.start();
    await flush();
    assert.equal(script.calls.length, 1);
    await clock.advance(30_000);   // a 30 s listing: ticks would have fired 7 times at 4 s
    assert.equal(script.calls.length, 1);
    script.calls[0]!.resolve({kind: 'loaded', value: {mesh: []}});
    await flush();
    assert.deepEqual(clock.pending(), [60_000], 'the next poll waits 30 s, as long as the answer took');
    await clock.advance(29_999);
    assert.equal(script.calls.length, 1);
    await clock.advance(1);
    assert.equal(script.calls.length, 2);
    script.calls[1]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.deepEqual(clock.pending(), [64_000], 'a fast answer: back to the 4 s base');
    assert.equal(script.maxInFlight(), 1);
  });

  test('explicit requests during a run share one follow-up started after them', async () => {
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    let applied = 0;
    const poller = createPoller({load: script.load, apply: () => ++applied, clock});
    const first = poller.start();
    await flush();
    const a = poller.request(), b = poller.request(), c = poller.request();
    await flush();
    assert.equal(script.calls.length, 1, 'no second request while one is in flight');
    script.calls[0]!.resolve({kind: 'loaded', value: 1});
    assert.equal(await first, 1);
    assert.equal(script.calls.length, 2, 'one follow-up for the three callers');
    script.calls[1]!.resolve({kind: 'loaded', value: 2});
    assert.deepEqual(await Promise.all([a, b, c]), [2, 2, 2]);
    assert.equal(script.maxInFlight(), 1);
  });

  test('a failure publishes the next attempt; the backoff is bounded and resets on success', async () => {
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    const states: PollerState[] = [];
    const poller = createPoller({load: script.load, apply: v => v, clock, onChange: s => states.push(s)});
    void poller.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      script.calls[i]!.resolve({kind: 'failed', status: null});
      await flush();
      const state = poller.state();
      assert.equal(state.failures, i + 1);
      assert.equal(state.restartSuspected, true);
      assert.ok(state.nextAttemptAt !== null);
      delays.push(state.nextAttemptAt! - clock.now());
      await clock.advance(state.nextAttemptAt! - clock.now());
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 15000, 15000]);
    script.calls[5]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.equal(poller.state().failures, 0);
    assert.equal(poller.state().restartSuspected, false);
    assert.ok(states.length > 5, 'every change is published');
  });

  test('a request hung past the timeout is aborted and counted as a slow server, not a gone one', async () => {
    const clock = new FakeClock();
    const poller = createPoller({clock, apply: v => v, timeoutMs: 1000,
      load: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))});
    void poller.start();
    await clock.advance(1000);
    const state = poller.state();
    assert.deepEqual([state.failures, state.lastFailureKind, state.restartSuspected, state.inFlightSince], [1, 'timeout', false, null]);
    assert.equal(statusLine({...input, poller: state})?.key, 'sessions.status.timeout');
  });

  test('an exception in apply is a client error: the server state stays answered', async () => {
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    const reported: unknown[] = [];
    let fail = true;
    const poller = createPoller({load: script.load, clock, onApplyError: error => reported.push(error),
      apply: value => { if (fail) throw new Error('page bug'); return value; }});
    void poller.start();
    await flush();
    script.calls[0]!.resolve({kind: 'loaded', value: 1});
    await flush();
    let state = poller.state();
    assert.deepEqual([state.failures, state.restartSuspected, state.clientError, state.everLoaded, state.lastFailureKind],
      [0, false, true, false, null]);
    assert.equal(reported.length, 1);
    assert.deepEqual(clock.pending(), [4000], 'the next poll at the normal cadence, no backoff');
    assert.equal(statusLine({...input, poller: state})?.key, 'sessions.status.clientError');
    fail = false;
    await clock.advance(4000);
    script.calls[1]!.resolve({kind: 'loaded', value: 2});
    await flush();
    state = poller.state();
    assert.deepEqual([state.clientError, state.everLoaded], [false, true]);
  });

  test('a floor raises every scheduled delay (a hidden page), and an explicit request still runs at once', async () => {
    let hidden = true;
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    const poller = createPoller({load: script.load, apply: v => v, clock, minDelayMs: () => (hidden ? 30_000 : 0)});
    void poller.start();
    await flush();
    script.calls[0]!.resolve({kind: 'failed', status: null});
    await flush();
    assert.deepEqual(clock.pending(), [30_000], 'a hidden page retries no faster than every 30 s');
    hidden = false;
    void poller.request();
    await flush();
    assert.equal(script.calls.length, 2, 'becoming visible asks at once');
    script.calls[1]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.deepEqual(clock.pending(), [4000]);
  });

  test('stop aborts the request in flight, drops its answer and schedules nothing', async () => {
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    let applied = 0;
    const poller = createPoller({load: script.load, apply: () => { applied++; }, clock});
    const pending = poller.start();
    await flush();
    poller.stop();
    assert.equal(script.calls[0]!.signal.aborted, true);
    script.calls[0]!.resolve({kind: 'loaded', value: {}});
    assert.equal(await pending, undefined);
    assert.equal(applied, 0);
    assert.deepEqual(clock.pending(), []);
  });

  test('a refusal (signed out) stops polling', async () => {
    const clock = new FakeClock();
    const poller = createPoller({clock, apply: v => v, load: async () => ({kind: 'refused'})});
    await poller.start();
    assert.equal(poller.state().stopped, true);
    assert.deepEqual(clock.pending(), []);
  });

  test('an incomplete listing polls at the faster base, never faster than the answer took', async () => {
    let complete = false;
    const clock = new FakeClock();
    const script = scriptedLoad(clock);
    const poller = createPoller({load: script.load, apply: v => v, clock, baseIntervalMs: () => complete ? 4000 : 1000});
    void poller.start();
    await flush();
    script.calls[0]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.deepEqual(clock.pending(), [1000]);
    assert.equal(pollDelay(2500, 1000), 2500);
    complete = true;
    await clock.advance(1000);
    script.calls[1]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.deepEqual(clock.pending(), [5000]);
    assert.equal(retryDelay(0), 2000);
    assert.equal(pollDelay(1000), 3000, 'quick answers: a request every 4 s, start to start');
    assert.equal(pollDelay(90_000), 60_000, 'bounded');
  });
});

describe('contract adapter', () => {
  test('a listing without the new fields is complete: every row ready', () => {
    const rows = [{id: 'a'}, {id: 'b'}];
    assert.deepEqual(progress({mesh: rows}, rows), {total: 2, ready: 2, phase: null});
    assert.equal(rowState({id: 'a'}), 'ready');
    assert.equal(authoritative({id: 'a'}, {mesh: rows}), true);
  });

  test('counts, ready, state and phase from the server', () => {
    const rows = [{id: 'a', ready: true}, {id: 'b', ready: false}, {id: 'c', state: 'slow'}, {id: 'd', state: 'error'}];
    assert.deepEqual(rows.map(rowState), ['ready', 'loading', 'slow', 'error']);
    assert.deepEqual(progress({counts: {total: 300, ready: 12}, phase: 'focus'}, rows), {total: 300, ready: 12, phase: 'focus'});
    assert.deepEqual(progress({counts: {total: 1, ready: 5}}, rows), {total: 4, ready: 1, phase: null}, 'incoherent counts: counted on the rows');
    assert.equal(authoritative({id: 'b', ready: false}, null), false);
    assert.equal(authoritative({id: 'a'}, {management: {state: 'pending'}}), false, 'a pending listing is not authority');
    assert.equal(authoritative({id: 'a', provisional: true}, null), false);
    // A server state other than ready: the row is not described (or failed to be): not observed fact.
    for (const state of ['loading', 'slow', 'error']) assert.equal(authoritative({id: 'c', state}, null), false, state);
    assert.equal(authoritative({id: 'c', state: 'ready'}, null), true);
    assert.equal(authoritative({id: 'c', state: 'unreachable'}, null), true, 'never the server\'s to say: ignored');
  });

  test('since and focus go only to a server that numbers its listings', () => {
    assert.deepEqual(inventoryUrl('/api/sessions', {mesh: []}, ['a']), {url: '/api/sessions', since: null});
    const {url, since} = inventoryUrl('/api/sessions', {generation: 7}, ['main pane', 'b,c', 'd']);
    assert.equal(since, 7);
    const params = new URL(url, 'http://x').searchParams;
    assert.equal(params.get('since'), '7');
    assert.equal(params.get('focus'), 'main pane,b,c,d');
    const many = Array.from({length: 200}, (_, i) => `session-${i}-${'x'.repeat(40)}`);
    const long = inventoryUrl('/api/sessions', {generation: 1}, many).url;
    assert.ok(long.length < 4300, `bounded URL (${long.length})`);
    assert.ok((new URL(long, 'http://x').searchParams.get('focus') ?? '').split(',').length <= 64);
  });

  test('an incremental answer merges changed rows and drops removed ones', () => {
    const previous = {generation: 3, mesh: [{id: 'a', v: 1}, {id: 'b', v: 1}, {id: 'c', v: 1}], external: [{id: 't1'}], home: '/h'};
    const merged = mergeListing(previous, {generation: 5, mesh: [{id: 'b', v: 2}, {id: 'n', v: 1}], removed: ['c'], counts: {total: 3, ready: 3}}, 3);
    assert.deepEqual((merged.mesh as {id: string}[]).map(row => row.id), ['n', 'a', 'b']);
    assert.equal((merged.mesh as {v: number}[])[2]!.v, 2);
    assert.deepEqual(merged.external, [{id: 't1'}]);
    assert.equal(merged.home, '/h');
    const restarted = {generation: 1, mesh: [{id: 'z'}]};
    assert.equal(mergeListing(previous, restarted, 3), restarted, 'a generation that went back is a full answer');
    const full = {mesh: [{id: 'q'}]};
    assert.equal(mergeListing(previous, full, null), full);
  });

  test('a delta row without an id is dropped and reported; a server row never says unreachable', () => {
    const previous = {generation: 3, mesh: [{id: 'a'}]};
    const dropped: unknown[] = [];
    const merged = mergeListing(previous, {generation: 4, mesh: [{name: 'no-id'}, {id: 'b'}]}, 3, row => dropped.push(row));
    assert.deepEqual((merged.mesh as {id: string}[]).map(row => row.id), ['b', 'a']);
    assert.deepEqual(dropped, [{name: 'no-id'}]);
    assert.equal(rowState({id: 'a', state: 'unreachable'}), 'ready', 'unreachable is the page\'s own judgement');
    assert.equal(rowState({id: 'a', rowState: 'unreachable'}), 'unreachable');
  });

  test('a merge keeps the server order (rank, then newest first)', () => {
    const previous = {generation: 1, mesh: [{id: 'new', rank: null, created: 9}, {id: 'a', rank: 0, created: 1}, {id: 'b', rank: 1, created: 2}]};
    const merged = mergeListing(previous, {generation: 2, mesh: [{id: 'a', rank: 2, created: 1}]}, 1);
    assert.deepEqual((merged.mesh as {id: string}[]).map(row => row.id), ['new', 'b', 'a']);
  });
});

describe('status line', () => {
  test('nothing to say once everything is listed and ready', () => {
    assert.equal(statusLine({...input, listing: {mesh: [{}]}, rows: [{}], now: 2000}), null);
  });
  test('server unreachable: announced once; the time of the next attempt is a detail, not announced', () => {
    const line = statusLine({...input, poller: {...idle, failures: 2, nextAttemptAt: 9000, restartSuspected: true,
      lastFailureKind: 'network'}, listing: null, now: 5000});
    assert.deepEqual([line?.key, line?.params, line?.detail, line?.retry],
      ['sessions.status.serverDown', {}, {key: 'sessions.status.nextAttempt', params: {time: 'T9000'}}, true]);
    const later = statusLine({...input, poller: {...idle, failures: 3, nextAttemptAt: 17_000, restartSuspected: true,
      lastFailureKind: 'network'}, listing: null, now: 9000});
    assert.deepEqual([later?.key, later?.params], [line?.key, line?.params], 'the announced message does not change at each retry');
  });
  test('refused after a first success: the status is announced, the next attempt is a detail', () => {
    const line = statusLine({...input, poller: {...idle, failures: 1, lastFailureStatus: 403, lastFailureKind: 'http', nextAttemptAt: 7000}});
    assert.deepEqual([line?.key, line?.params, line?.detail?.params], ['sessions.status.refused', {status: 403}, {time: 'T7000'}]);
  });
  test('waiting for the first answer after a restart, with the elapsed time', () => {
    const line = statusLine({...input, poller: {...idle, inFlightSince: 4000, restartSuspected: true}, listing: null, now: 9000});
    assert.deepEqual([line?.key, line?.since], ['sessions.status.restarted', 4000]);
  });
  test('a retry after a timeout is not a restart', () => {
    const retrying = {...idle, failures: 1, lastFailureKind: 'timeout' as const, inFlightSince: 1000};
    assert.equal(statusLine({...input, poller: retrying, listing: {}, now: 2000}), null);
    assert.equal(statusLine({...input, poller: retrying, listing: {}, now: 9500})?.key, 'sessions.status.slow');
  });
  test('offline comes first, with a retry', () => {
    const line = statusLine({...input, poller: {...idle, failures: 4, lastFailureKind: 'network'}, offline: true});
    assert.deepEqual([line?.key, line?.tone, line?.retry], ['sessions.status.offline', 'bad', true]);
  });
  test('first load: the rows this device knows are counted', () => {
    const first = {...idle, everLoaded: false, lastSuccessAt: null, inFlightSince: 0};
    assert.equal(statusLine({...input, poller: first, listing: null, now: 10})?.key, 'sessions.status.loading');
    assert.deepEqual(statusLine({...input, poller: first, listing: null, rows: [{}, {}], now: 10})?.params, {n: 2});
  });
  test('host silent, then N / M ready from counts', () => {
    assert.equal(statusLine({...input, listing: {management: {state: 'unavailable'}}})?.key, 'sessions.status.hostSilent');
    assert.equal(statusLine({...input, listing: {host: 'silent'}})?.key, 'sessions.status.hostSilent');
    assert.equal(statusLine({...input, listing: {host: 'silent'}, hostSilent: false}), null, 'the page\'s own judgement wins');
    const line = statusLine({...input, listing: {counts: {total: 52, ready: 12}, phase: 'focus'}});
    assert.deepEqual([line?.key, line?.params, line?.detail],
      ['sessions.status.describingPhase', {phase: {key: 'sessions.phase.focus'}}, {key: 'sessions.status.readyCount', params: {ready: 12, total: 52}}]);
  });
  test('the announced progress message changes with the phase only, never with the count', () => {
    const at = (ready: number, phase?: string) => statusLine({...input, listing: {counts: {total: 50, ready}, ...(phase ? {phase} : {})}});
    const first = at(3), next = at(4);
    assert.deepEqual([first?.key, first?.params], ['sessions.status.describing', {}]);
    assert.deepEqual([next?.key, next?.params], [first?.key, first?.params], 'a count change is not announced');
    assert.deepEqual(next?.detail, {key: 'sessions.status.readyCount', params: {ready: 4, total: 50}});
    assert.notDeepEqual(at(5, 'recent')?.params, at(5, 'focus')?.params, 'a phase change is');
    assert.equal(at(50), null, 'complete: the line empties');
  });
  test('a slow answer after a good one: the age of the list is a detail', () => {
    const slow = {...idle, inFlightSince: 1000};
    assert.equal(statusLine({...input, poller: slow, listing: {}, now: 5000}), null);
    const line = statusLine({...input, poller: slow, listing: {}, now: 9000});
    assert.deepEqual([line?.key, line?.params, line?.detail], ['sessions.status.slow', {},
      {key: 'sessions.status.listAsOf', params: {time: 'T1000'}}]);
    assert.equal(statusTicks(null, slow), true, 'a pending request is re-read every second');
    assert.equal(statusTicks(null, idle), false);
  });
});

// Answers shaped like the background-list server's (docs/sessions-api.md): `since` answered at once from
// the previous round, an empty pending answer before the first listing, no `phase`, no per-row `state`.
describe('against the background-list server', () => {
  test('a requested load (refresh after a change) sends no since; polls keep it', async () => {
    const clock = new FakeClock();
    const seen: boolean[] = [];
    const script = scriptedLoad(clock);
    const load = (signal: AbortSignal, attempt: {requested: boolean}) => { seen.push(attempt.requested); return script.load(signal); };
    const poller = createPoller({load, apply: v => v, clock});
    void poller.start();
    await flush();
    script.calls[0]!.resolve({kind: 'loaded', value: {}});
    await flush();
    await clock.advance(4000);   // a timer poll
    void poller.request();   // asked while the poll runs: the shared follow-up is a requested one
    script.calls[1]!.resolve({kind: 'loaded', value: {}});
    await flush();
    script.calls[2]!.resolve({kind: 'loaded', value: {}});
    await flush();
    assert.deepEqual(seen, [true, false, true]);
    poller.stop();
    const fresh = inventoryUrl('/api/sessions', {generation: 7}, ['a'], true);
    assert.equal(fresh.since, null);
    const params = new URL(fresh.url, 'http://x').searchParams;
    assert.deepEqual([params.get('since'), params.get('focus')], [null, 'a'], 'no since; focus still sent');
    assert.deepEqual(mergeListing({generation: 7, mesh: [{id: 'old'}]}, {generation: 9, mesh: [{id: 'new'}]}, fresh.since).mesh,
      [{id: 'new'}], 'its answer is taken whole');
  });

  test('an empty pending answer before the first listing keeps the sessions known on this device', () => {
    const before = {generation: 5, mesh: [], external: [], management: {state: 'pending'}, complete: false, counts: {total: 0, ready: 0}, host: 'ok'};
    const known = {mesh: [{id: 'a', provisional: true}], external: [], provisional: true};
    assert.equal(holdKnownRows(before, known), true);
    assert.equal(holdKnownRows({...before, complete: true}, known), false, 'a complete empty listing is an answer');
    assert.equal(holdKnownRows({...before, mesh: [{id: 'a', ready: false}]}, known), false, 'a skeleton row is an answer');
    assert.equal(holdKnownRows(before, {mesh: [{id: 'a'}], external: []}), false, 'only the provisional listing is held');
    assert.equal(holdKnownRows(null, known), false);
    const line = statusLine({...input, listing: before, rows: known.mesh});
    assert.deepEqual([line?.key, line?.params], ['sessions.status.loadingKnown', {n: 1}], 'the status line still says loading');
  });

  test('no phase and no per-row state: derived from ready and counts', () => {
    const rows = [{id: 'a', ready: true}, {id: 'b', ready: false, agent: {type: 'claude', provisional: true}}];
    assert.deepEqual(rows.map(row => rowState(row)), ['ready', 'loading']);
    assert.equal(RETRYABLE.has(rowState(rows[1]!)), false, 'no retry button on a row being described');
    const line = statusLine({...input, listing: {counts: {total: 2, ready: 1}, complete: false, mesh: rows}, rows});
    assert.deepEqual([line?.key, line?.detail?.params], ['sessions.status.describing', {ready: 1, total: 2}]);
  });

  test('while the host is silent, listed rows are unreachable and not authority', () => {
    const row = {id: 'a', ready: true};
    assert.equal(rowState(row, true), 'unreachable');
    assert.equal(authoritative(row, {host: 'silent', mesh: [row]}, true), false);
    assert.equal(rowState({...row, provisional: true}, true), 'loading');
  });
});
