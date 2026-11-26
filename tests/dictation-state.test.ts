// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDictationController, createRetainedLifetime} from '../static/dictation.ts';
import {createHumanInputLease, createHumanInputScope, createDictationModeObserver, createTerminalInputOrigin} from '../static/pane-actions.ts';

function fixture() {
  const requests: {path: string; init: RequestInit | undefined}[] = [];
  let release = 0, streams = 0, stopped = 0;
  let resolvePermission: (value: any) => void = () => {};
  const stream = {getTracks: () => [{stop: () => stopped++}]};
  const controller = createDictationController({namespace: 'local', uuid: () => crypto.randomUUID(),
    allowed: () => true, changed() {}, retain: () => ({valid: () => true, claim: () => true, release: () => release++,
      deliver: (_text, done) => done({kind: 'submitted'})}),
    media: {supported: () => true, permission: () => {streams++; return new Promise(r => {resolvePermission = r;});},
      recorder: () => {throw Error('unused');}},
    request: async (path, init) => {requests.push({path, init}); return new Response(JSON.stringify({enabled: true,
      max_bytes: 1024, capture_seconds: 1}), {status: 200});},
    schedule: () => 1, unschedule() {}, now: () => 0});
  return {controller, requests, stream, permit: () => resolvePermission(stream),
    counts: () => ({release, streams, stopped})};
}

test('production reload predicate sees hidden session drafts and permission ownership', async () => {
  const source = readFileSync('static/app.js', 'utf8');
  const functions = ['reloadHolds', 'safeToReload'].map(name => {
    const match = source.match(new RegExp(`^function ${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(match, `missing production ${name}`); return match[0];
  });
  const f = fixture(); await f.controller.start();
  const context: Record<string, any> = {
    panes: [], dictation: f.controller, inlineDictation: null, fieldHoldsText: () => false, t: (key: string) => key,
    document: {visibilityState: 'hidden', querySelector: () => null}, performance: {now: () => 1000},
    uploadHolds: new Set(), listBusy: false, ctxMenu: null, paneMenuHolds: new Set(), paneStopHolds: new Set(),
    linePending: null, lineRecovery: null, composeOwner: null, capActive: null,
    composeRecovery: [], composeUploads: [], pickerGate: {pending: null}, lastActivity: 0, reloadIdleMs: 100,
  };
  vm.runInNewContext(`${functions.join('\n')}; this.safe = safeToReload`, context);
  assert.equal(context.safe(), true);
  const session = f.controller.session('A', 1); session.edit('hidden draft');
  assert.equal(context.safe(), false, 'offscreen session text prevents reload');
  session.edit(''); assert.equal(context.safe(), true);
  const pending = f.controller.press(session);
  assert.equal(context.safe(), false, 'late microphone permission owns a reload hold');
  f.controller.detach(session); f.permit(); await pending;
  assert.equal(context.safe(), true); f.controller.dispose();
});

test('no effects before start; whitespace and attachment edits forbid permission', async () => {
  const f = fixture(), s = f.controller.session('A', 1);
  assert.equal(await f.controller.press(s), false); assert.equal(f.requests.length, 0);
  await f.controller.start();
  for (const text of [' ', '\n', '/uploaded/attachment ']) {
    s.edit(text); assert.equal(await f.controller.press(s), false);
  }
  assert.equal(f.counts().streams, 0);
});

test('late permission after view close is stopped, never recorded', async () => {
  const f = fixture(); await f.controller.start(); const s = f.controller.session('A', 1);
  const pending = f.controller.press(s); f.controller.detach(s); f.permit(); await pending;
  assert.deepEqual(f.counts(), {release: 1, streams: 1, stopped: 1});
  assert.equal(s.state, 'idle'); assert.equal(f.requests.length, 1);
});

test('session drafts/revisions survive detach and are incarnation-scoped', async () => {
  const f = fixture(); await f.controller.start(); const a = f.controller.session('A', 1);
  a.edit('original'); f.controller.detach(a);
  assert.equal(f.controller.session('A', 1), a);
  assert.equal(a.text, 'original'); assert.equal(a.revision, 1);
  assert.equal(f.controller.session('A', 2).text, '');
  assert.equal(f.controller.holds().length, 1);
  f.controller.dispose(); assert.equal(await f.controller.press(a), false);
});

test('read-only session lookup preserves existing drafts without allocating observed incarnations', () => {
  const f = fixture(), a = f.controller.session('A', 1);
  a.edit('retained draft');
  for (let created = 2; created < 1002; created++) {
    assert.equal(f.controller.peekSession('A', created), undefined);
  }
  assert.equal(Reflect.get(f.controller, 'sessions').size, 1);
  assert.equal(f.controller.peekSession('A', 1), a);
  assert.equal(a.text, 'retained draft');
  f.controller.dispose();
});

test('retaining an original channel outlives view, last release closes; force wins', () => {
  let closed = 0; const life = createRetainedLifetime(() => closed++);
  const release = life.retain(); life.detach(); assert.equal(closed, 0);
  release!(); release!(); assert.equal(closed, 1);
  const other = createRetainedLifetime(() => closed++); const late = other.retain();
  other.dispose(); late!(); assert.equal(closed, 2); assert.equal(other.retain(), null);
});

function recordingFixture() {
  const requests: {path: string; init: RequestInit | undefined}[] = [], timers = new Map<number, () => void>();
  let serial = 0, stopped = 0, releases = 0, writes = 0, live = true;
  let lost = false, missing = false, rejectAck = false, tooLarge = false, denied = false;
  let job: any = null;
  const recorder: any = {state: 'inactive', mimeType: 'audio/webm', start() {this.state = 'recording';},
    stop() {this.state = 'inactive'; queueMicrotask(() => {
      this.ondataavailable({data: new Blob(['audio'], {type: 'audio/webm'})}); this.onstop();
    });}};
  const controller = createDictationController({namespace: 'test', allowed: () => live, changed() {},
    uuid: () => crypto.randomUUID(), media: {supported: () => true,
      permission: async () => {if (denied) throw Error('denied'); return {getTracks: () => [{stop: () => stopped++}]} as any;},
      recorder: () => recorder},
    retain: () => ({valid: () => live, claim: () => live, release: () => releases++,
      deliver: (_text, done, guard) => {if (guard()) writes++; done({kind: guard() ? 'submitted' : 'uncertain'});}}),
    request: async (path, init) => {
      requests.push({path, init});
      if (path.endsWith('/config')) return Response.json({enabled: true, max_bytes: tooLarge ? 1 : 100, capture_seconds: 1});
      if (path === '/api/transcribe') {
        const headers = init!.headers as Record<string, string>;
        job = {job_id: crypto.randomUUID(), request_id: headers['X-Mesh-Request-Id'], session: headers['X-Mesh-Session'],
          created: Number(headers['X-Mesh-Created']), state: 'queued', text: null, error: null, outcome: null};
        if (lost) throw Error('lost acknowledgement');
      }
      if (missing) return Response.json({error: {code: 'not_found'}}, {status: 404});
      if (path.endsWith('/cancel') || path.endsWith('/settle')) {
        if (rejectAck) throw Error('lost acknowledgement');
        job.state = path.endsWith('/cancel') ? 'cancelled' : 'settled';
        job.text = null; job.outcome = path.endsWith('/settle') ? JSON.parse(String(init!.body)).outcome : null;
      }
      return Response.json(job);
    },
    schedule: callback => {timers.set(++serial, callback); return serial;},
    unschedule: id => {timers.delete(id);}, now: () => 0});
  return {controller, recorder, requests, timers, job: () => job,
    flags: (flags: {lost?: boolean; missing?: boolean; rejectAck?: boolean; tooLarge?: boolean; denied?: boolean}) => {
      lost = flags.lost ?? lost; missing = flags.missing ?? missing; rejectAck = flags.rejectAck ?? rejectAck;
      tooLarge = flags.tooLarge ?? tooLarge; denied = flags.denied ?? denied;
    }, counts: () => ({stopped, releases, writes}), dead: () => {live = false;}};
}
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
async function capture(f: ReturnType<typeof recordingFixture>, name = 'A') {
  const s = f.controller.session(name, 1); assert.equal(await f.controller.press(s), true);
  f.controller.release(s); await flush(); return s;
}

test('release owns upload after detach; queued then processing then editable manual ready never writes', async () => {
  const f = recordingFixture(); await f.controller.start(); const s = await capture(f);
  f.controller.detach(s); assert.equal(s.state, 'queued'); assert.equal(f.counts().stopped, 1);
  const request = s.requestId; f.recorder.onstop(); f.recorder.onerror(); await flush();
  assert.equal(s.requestId, request); assert.equal(f.requests.filter(r => r.path === '/api/transcribe').length, 1);
  f.job().state = 'processing'; await f.controller.reconcile(s); assert.equal(s.state, 'processing');
  f.job().state = 'ready'; f.job().text = 'bonjour'; await f.controller.reconcile(s);
  assert.equal(s.state, 'ready'); assert.equal(s.text, 'bonjour'); assert.equal(f.counts().writes, 0);
  s.edit('edited'); await f.controller.reconcile(s); assert.equal(s.text, 'edited');
  f.controller.dispose(); assert.equal(f.counts().releases, 1);
});

test('lost ack + request 404 retains identity without retaining audio; cancel latches until recovered and acknowledged', async () => {
  const f = recordingFixture(); f.flags({lost: true}); await f.controller.start(); const s = await capture(f);
  const id = s.requestId; assert.equal(s.state, 'recovery'); assert.ok(id); assert.equal(s.audio, null);
  f.flags({missing: true}); await f.controller.reconcile(s); assert.equal(s.requestId, id); assert.equal(s.audio, null);
  f.controller.discard(s); await flush(); assert.equal(s.requestId, id);
  f.flags({missing: false, rejectAck: true}); await f.controller.reconcile(s); await f.controller.reconcile(s);
  assert.equal(s.requestId, id); assert.equal(s.discard, true);
  f.flags({rejectAck: false}); await f.controller.reconcile(s); assert.equal(s.state, 'idle');
  assert.equal(f.requests.filter(r => r.path === '/api/transcribe').length, 1);
  assert.ok(f.requests.some(r => r.path.endsWith(`/request/${id}`)));
  assert.equal(f.counts().writes, 0);
});

test('edits and attachment paths during job preserve their draft, transcript becomes per-session recovery', async () => {
  const f = recordingFixture(); await f.controller.start(); const a = await capture(f);
  a.edit('/uploaded/file '); f.job().state = 'ready'; f.job().text = 'spoken';
  await f.controller.reconcile(a); assert.equal(a.text, '/uploaded/file ');
  assert.equal(a.transcript, 'spoken'); assert.equal(a.state, 'recovery');
  const b = f.controller.session('B', 2); assert.equal(f.controller.reason(b), '');
  assert.equal(f.counts().writes, 0);
});

test('manual submit once, lost settlement ack retries only settle, never input', async () => {
  const f = recordingFixture(); await f.controller.start(); const s = await capture(f);
  f.job().state = 'ready'; f.job().text = 'bonjour'; await f.controller.reconcile(s);
  f.flags({rejectAck: true}); assert.equal(f.controller.send(s), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(s.state, 'recovery'); assert.equal(f.controller.send(s), false);
  await f.controller.reconcile(s); assert.equal(f.counts().writes, 1);
  f.flags({rejectAck: false}); await f.controller.reconcile(s); assert.equal(s.state, 'idle');
  assert.equal(f.job().outcome, 'submitted'); assert.equal(f.counts().writes, 1);
});

test('byte/time ceilings discard rather than admit; permission denial and stream error are visible', async () => {
  const f = recordingFixture(); f.flags({tooLarge: true}); await f.controller.start();
  const s = await capture(f); assert.equal(s.state, 'error');
  assert.equal(f.requests.filter(r => r.path === '/api/transcribe').length, 0);
  f.controller.discard(s); f.flags({denied: true}); assert.equal(await f.controller.press(s), false);
  assert.equal(s.state, 'error'); assert.equal(s.message, 'permissionDenied');
  f.controller.discard(s); f.flags({denied: false}); await f.controller.press(s);
  [...f.timers.values()].at(-1)!(); await flush();
  assert.equal(s.state, 'error'); assert.equal(s.message, 'durationLimit');
  assert.equal(f.requests.filter(r => r.path === '/api/transcribe').length, 0);
});

test('dispose stops requesting/recording and invalidates job callback effects', async () => {
  const f = recordingFixture(); await f.controller.start(); const s = f.controller.session('A', 1);
  await f.controller.press(s); f.controller.dispose(); await flush();
  assert.equal(f.counts().stopped, 1); assert.equal(f.counts().releases, 1);
  assert.equal(await f.controller.press(s), false);
  assert.equal(f.requests.length, 1);
});

test('bound native transport preserves original client identity and shared dirty bit', () => {
  const normal: unknown[] = [], original: unknown[] = [];
  const lease = createHumanInputLease({clientId: 'same-client', control: (id, dirty) => normal.push([id, dirty]),
    data: bytes => normal.push(bytes)});
  const bound = {control: (id: string, dirty: boolean) => original.push([id, dirty]), data: (bytes: Uint8Array) => original.push(bytes)};
  lease.reconnect(); lease.write(new Uint8Array([1]), false, bound); assert.equal(lease.dirty, true);
  lease.write(new Uint8Array([13]), true, bound); assert.equal(lease.dirty, false);
  assert.deepEqual(original.filter(Array.isArray), [['same-client', true], ['same-client', false]]);
  assert.deepEqual(normal, [['same-client', false]]);
});

test('original mode observer is chunk-safe, handles string escapes/reset and bounded numeric parameter lists', () => {
  const context = {exports: {} as any, module: {exports: {} as any}, self: {}, process, setTimeout, clearTimeout};
  vm.runInNewContext(readFileSync('static/vendor/xterm.min.js', 'utf8'), context);
  const Terminal = context.exports.Terminal || context.module.exports.Terminal;
  const terminal = new Terminal();
  const mode = createDictationModeObserver(false, terminal), bytes = (text: string) => mode.bytes(new TextEncoder().encode(text));
  terminal.dispose();
  bytes('\x1b[?20'); bytes('04h'); assert.equal(mode.value, true);
  bytes('\x1b]title \x1b[?2004l\x07'); assert.equal(mode.value, false);
  bytes('\x1bPignored \x1b[?2004h\x1b\\'); assert.equal(mode.value, true);
  bytes('\x1bc'); assert.equal(mode.value, false);
  for (const char of '\x1b[?' + '1;'.repeat(2000) + '2004h') bytes(char);
  assert.equal(mode.value, false);
  mode.dispose();
});

test('expired/unavailable ready job cannot authorize manual input from a long-open editor', async () => {
  const f = recordingFixture(); await f.controller.start(); const s = await capture(f);
  f.job().state = 'ready'; f.job().text = 'spoken'; await f.controller.reconcile(s);
  f.flags({missing: true}); assert.equal(f.controller.send(s), true); await flush();
  assert.equal(s.state, 'recovery'); assert.equal(s.text, 'spoken'); assert.ok(s.requestId);
  assert.equal(f.counts().writes, 0); assert.equal(f.counts().releases, 1);
});

test('native attempt detects even a completed foreign write on another lease', () => {
  const scope = createHumanInputScope(), controls: unknown[] = [];
  const transport = {control: (id: string, dirty: boolean) => controls.push([id, dirty]), data() {}};
  const a = createHumanInputLease({clientId: 'A', scope, ...transport});
  const b = createHumanInputLease({clientId: 'B', scope, ...transport});
  const attempt = a.claim()!; assert.equal(attempt.valid(), true);
  assert.equal(attempt.write(new Uint8Array([97]), false, transport), true);
  assert.equal(attempt.valid(), true); assert.equal(a.dirty, true);
  b.write(new Uint8Array([13]), true); assert.equal(b.dirty, false);
  assert.equal(attempt.valid(), false);
  assert.equal(attempt.write(new Uint8Array([13]), true, transport), false);
  assert.equal(a.dirty, true, 'voice must not complete dirty human input');
  assert.equal(a.revision, b.revision); assert.equal(b.claim(), null);
});

test('own native frames advance the token; failed/foreign attempts cannot release the dirty bit', () => {
  const scope = createHumanInputScope(), controls: unknown[] = [];
  const transport = {control: (id: string, dirty: boolean) => controls.push([id, dirty]), data() {}};
  const lease = createHumanInputLease({clientId: 'same-client', scope, ...transport}), attempt = lease.claim()!;
  assert.equal(attempt.write(new Uint8Array([97]), false, transport), true);
  assert.equal(attempt.write(new Uint8Array([13]), true, transport), true);
  assert.deepEqual(controls, [['same-client', true], ['same-client', false]]); assert.equal(lease.dirty, false);
  const pending = lease.claim()!;
  lease.write(new Uint8Array([98]), false, {...transport, data() {throw Error('uncertain');}});
  assert.equal(pending.valid(), false); assert.equal(lease.dirty, true);
});

test('clean lease observations retire only after their retained reference releases', () => {
  let empty = 0; const scope = createHumanInputScope(() => empty++);
  const lease = createHumanInputLease({clientId: 'original', scope, control() {}, data() {}});
  const release = lease.retain(); lease.retire(); assert.equal(empty, 0);
  release(); release(); assert.equal(empty, 1); assert.equal(lease.claim(), null);
  assert.equal(scope.dirty, false);
});

test('unsupported parser/origin shapes fail conservatively', () => {
  const mode = createDictationModeObserver(false, {}); assert.equal(mode.valid, false);
  mode.bytes(new Uint8Array([27, 91, 63, 50, 48, 48, 52, 104])); assert.equal(mode.value, false);
  const origin = createTerminalInputOrigin({}); assert.equal(origin.consume(), true); origin.dispose();
  const frozen = createTerminalInputOrigin({onUserInput: () => ({dispose() {}})}, Object.freeze({parse() {}}));
  assert.equal(frozen.consume(), true); frozen.dispose();
  const invalidSignal = createTerminalInputOrigin({onUserInput: () => ({})} as any, {parse() {}});
  assert.equal(invalidSignal.consume(), true); invalidSignal.dispose();
});

test('retired job timers cannot release the successor capture/channel', async () => {
  const f = recordingFixture(); await f.controller.start(); const s = await capture(f);
  f.job().state = 'ready'; f.job().text = 'old'; await f.controller.reconcile(s);
  const oldTimer = [...f.timers.values()].at(-1)!;
  s.edit(''); f.controller.discard(s); await flush();
  assert.equal(s.state, 'idle'); await f.controller.press(s);
  const released = f.counts().releases; oldTimer();
  assert.equal(s.state, 'recording'); assert.equal(f.counts().releases, released);
  f.controller.dispose();
});

function preferenceFixture(saved: unknown = false) {
  let allowed = true, getError = false, setError = false, reads = 0, writes = 0;
  const ports = {namespace: 'preference', uuid: () => crypto.randomUUID(), allowed: () => allowed, changed() {},
    preference: {read() {reads++; if (getError) throw Error('blocked'); return saved;},
      write(value: boolean) {writes++; if (setError) throw Error('blocked'); saved = value;}},
    retain: () => null, media: {supported: () => true, permission: async () => {throw Error('unused');},
      recorder: () => {throw Error('unused');}}, request: async () => Response.json({enabled: true, max_bytes: 100, capture_seconds: 1}),
    schedule: () => 1, unschedule() {}, now: () => 0};
  const controller = createDictationController(ports);
  return {controller, saved: () => saved, counts: () => ({reads, writes}),
    toggle: (enabled: boolean) => controller.setAutoSend(enabled), value: () => controller.autoSend,
    flags: (flags: {allowed?: boolean; getError?: boolean; setError?: boolean}) => {
      allowed = flags.allowed ?? allowed; getError = flags.getError ?? getError; setError = flags.setError ?? setError;
    }};
}

test('preference effects only after allowed start, never before or after dispose', async () => {
  const f = preferenceFixture(true); f.flags({allowed: false}); f.toggle(true); await f.controller.start();
  assert.deepEqual(f.counts(), {reads: 0, writes: 0}); assert.equal(f.value(), false);
  f.flags({allowed: true}); await f.controller.start(); assert.equal(f.value(), true);
  assert.deepEqual(f.counts(), {reads: 1, writes: 0});
  f.controller.dispose(); f.toggle(false); await f.controller.start();
  assert.deepEqual(f.counts(), {reads: 1, writes: 0}); assert.equal(f.value(), false);
});

for (const value of [null, undefined, 'true', 1, {}, false, true]) {
  test(`preference reads strictly a boolean: ${JSON.stringify(value)}`, async () => {
    const f = preferenceFixture(value); await f.controller.start();
    assert.equal(f.value(), value === true); assert.deepEqual(f.counts(), {reads: 1, writes: 0});
  });
}

test('preference read/write failures are honest safe-off; failed enable never arms', async () => {
  const f = preferenceFixture(true); f.flags({getError: true}); await f.controller.start();
  assert.equal(f.value(), false); assert.equal(f.controller.preferenceMessage, 'storageRead');
  f.flags({getError: false}); f.toggle(true); assert.equal(f.value(), true); assert.equal(f.saved(), true);
  f.flags({setError: true}); f.toggle(true); assert.equal(f.value(), false);
  assert.equal(f.controller.preferenceMessage, 'storageWrite');
  f.flags({setError: false}); f.toggle(false); assert.equal(f.saved(), false);
  f.flags({allowed: false}); f.toggle(true); assert.equal(f.value(), false);
  assert.deepEqual(f.counts(), {reads: 1, writes: 3});
});
