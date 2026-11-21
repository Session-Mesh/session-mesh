// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createDictationController, type DictationSession} from '../static/dictation.ts';
import {createDictationChannel} from '../static/dictation-channel.ts';
import {createDictationView, dictationLabel, setTranslator, createHumanInputLease, createHumanInputScope,
  type CapturedTarget} from '../static/pane-actions.ts';

const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
function backgroundFixture(saved = false) {
  const jobs = new Map<string, any>(), delivered: {session: string; text: string}[] = [];
  const requests: string[] = [], fresh = new Map<string, boolean>();
  const channelCalls: string[] = [];
  let permission = async () => ({getTracks: () => [{stop() {}}]}) as any;
  const recorder: any = {state: 'inactive', mimeType: 'audio/webm', start() {this.state = 'recording';},
    stop() {this.state = 'inactive'; queueMicrotask(() => {
      this.ondataavailable({data: new Blob(['audio'], {type: 'audio/webm'})}); this.onstop();
    });}};
  const controller = createDictationController({namespace: 'local', uuid: () => crypto.randomUUID(),
    allowed: () => true, changed() {}, preference: {read: () => saved, write: value => {saved = value;}},
    media: {supported: () => true, permission: () => permission(), recorder: () => recorder},
    retain: s => ({valid: () => true, captureFresh: () => fresh.get(s.name) !== false,
      claim() {channelCalls.push('claim'); return true;}, release() {},
      deliver(text, done, guard) {
        channelCalls.push('deliver');
        if (guard()) delivered.push({session: s.name, text});
        done({kind: guard() ? 'submitted' : 'uncertain'});
      }}),
    request: async (path, init) => {
      requests.push(path);
      if (path.endsWith('/config')) return Response.json({enabled: true, max_bytes: 100, capture_seconds: 2});
      if (path === '/api/transcribe') {
        const h = init!.headers as Record<string, string>;
        const job = {job_id: crypto.randomUUID(), request_id: h['X-Mesh-Request-Id'], session: h['X-Mesh-Session'],
          created: Number(h['X-Mesh-Created']), state: 'queued', text: null};
        assert.match(h['X-Mesh-Dictation-Client']!, /^[0-9a-f-]{36}$/);
        jobs.set(job.session!, job); return Response.json(job);
      }
      const job = [...jobs.values()].find(j => path.includes(j.job_id)); assert.ok(job);
      if (path.endsWith('/settle') || path.endsWith('/cancel')) job.state = path.endsWith('/settle') ? 'settled' : 'cancelled';
      return Response.json(job);
    }, schedule: () => 1, unschedule() {}, now: () => 0});
  return {controller, delivered, jobs, requests, fresh, channelCalls, saved: () => saved,
    setPermission(fn: typeof permission) {permission = fn;}};
}
async function record(f: ReturnType<typeof backgroundFixture>, name: string): Promise<DictationSession> {
  const s = f.controller.session(name, 7); assert.equal(await f.controller.press(s), true);
  f.controller.release(s); f.controller.detach(s); await flush(); return s;
}
async function ready(f: ReturnType<typeof backgroundFixture>, s: DictationSession): Promise<void> {
  Object.assign(f.jobs.get(s.name), {state: 'ready', text: `spoken ${s.name}`});
  await f.controller.reconcile(s); await flush();
}

test('default-off A+B continue while C owns its independent unchanged draft', async () => {
  const f = backgroundFixture(); await f.controller.start();
  const a = await record(f, 'A'), b = await record(f, 'B'), c = f.controller.session('C', 7);
  c.edit('C draft'); const revision = c.revision;
  assert.equal(f.controller.autoSend, false);
  assert.equal(await f.controller.press(a), false, 'one outstanding job per session');
  await ready(f, a); await ready(f, b);
  assert.equal(a.text, 'spoken A'); assert.equal(b.text, 'spoken B');
  assert.deepEqual(f.delivered, []); assert.equal(c.text, 'C draft'); assert.equal(c.revision, revision);
  assert.equal(f.controller.send(a), true); await flush();
  assert.deepEqual(f.delivered, [{session: 'A', text: 'spoken A'}]);
  assert.equal(b.state, 'ready'); assert.equal(c.text, 'C draft');
  f.controller.dispose();
});

test('opted-in A+B auto-send through their original channels, never C', async () => {
  const f = backgroundFixture(); await f.controller.start(); f.controller.setAutoSend(true);
  const a = await record(f, 'A'), b = await record(f, 'B'), c = f.controller.session('C', 7); c.edit('C draft');
  await ready(f, b); await ready(f, a);
  assert.deepEqual(f.delivered, [{session: 'B', text: 'spoken B'}, {session: 'A', text: 'spoken A'}]);
  assert.equal(c.text, 'C draft'); assert.equal(c.revision, 1);
  assert.equal(f.controller.autoSend, true, 'preference survives successful sends');
  assert.equal(f.saved(), true); f.controller.dispose();
  const reloaded = backgroundFixture(f.saved()); await reloaded.controller.start();
  assert.equal(reloaded.controller.autoSend, true); reloaded.controller.dispose();
});

test('enabling after recording does not authorize the pending recording; disabling revokes it', async () => {
  const f = backgroundFixture(); await f.controller.start(); const a = await record(f, 'A');
  f.controller.setAutoSend(true); await ready(f, a); assert.deepEqual(f.delivered, []);
  const b = await record(f, 'B'); f.controller.setAutoSend(false); await ready(f, b);
  assert.deepEqual(f.delivered, []); assert.equal(b.state, 'ready'); f.controller.dispose();
});

test('changed original terminal history or changed draft prevents automatic delivery', async () => {
  const f = backgroundFixture(true); await f.controller.start();
  const a = await record(f, 'A'); f.fresh.set('A', false); await ready(f, a);
  assert.equal(a.state, 'recovery'); assert.equal(a.message, 'contextChanged'); assert.equal(a.text, 'spoken A');
  const b = await record(f, 'B'); b.edit('human draft'); await ready(f, b);
  assert.equal(b.state, 'recovery'); assert.equal(b.text, 'human draft'); assert.equal(b.transcript, 'spoken B');
  assert.deepEqual(f.delivered, []); f.controller.dispose();
});

for (const autoSend of [false, true]) {
  test(`ready transcripts reject every C1 control without input or automatic recovery (autoSend=${autoSend})`, async () => {
    const controls = [0x00, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f,
      ...Array.from({length: 0x20}, (_, index) => 0x80 + index)];
    for (const point of controls) {
      const f = backgroundFixture(autoSend);
      try {
        await f.controller.start();
        const s = await record(f, 'A'), requestId = s.requestId;
        const text = `before${String.fromCodePoint(point)}after`;
        Object.assign(f.jobs.get(s.name), {state: 'ready', text});
        for (let attempt = 0; attempt < 2; attempt++) {
          await f.controller.reconcile(s); await flush();
          assert.equal(s.state, 'recovery', `U+${point.toString(16)}`);
          assert.equal(s.message, 'statusUnavailable');
          assert.equal(s.text, '', 'invalid text is rejected, never stripped into a draft');
          assert.equal(s.transcript, '');
          assert.equal(s.insertionRevision, null);
          assert.equal(s.autoAttempted, false);
          assert.equal(s.requestId, requestId, 'recovery keeps the original request binding');
          assert.equal(f.controller.send(s), false);
          assert.equal(f.controller.send(s, true), false);
        }
        assert.deepEqual(f.channelCalls, [], 'invalid results cannot claim or deliver on the channel');
        assert.deepEqual(f.delivered, [], 'no terminal write or submit');
        assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 1);
        assert.equal(f.requests.some(path => path.endsWith('/settle')), false);
      } finally {f.controller.dispose();}
    }
  });

  test(`TAB/LF and printable C1 boundaries remain exact and sendable (autoSend=${autoSend})`, async () => {
    const f = backgroundFixture(autoSend), text = 'before\x7e\tline\n\xa0été';
    try {
      await f.controller.start();
      const s = await record(f, 'A');
      Object.assign(f.jobs.get(s.name), {state: 'ready', text});
      await f.controller.reconcile(s); await flush();
      if (!autoSend) {
        assert.equal(s.state, 'ready');
        assert.equal(s.text, text);
        assert.equal(f.controller.send(s), true); await flush();
      }
      assert.deepEqual(f.delivered, [{session: 'A', text}]);
      assert.deepEqual(f.channelCalls, ['claim', 'deliver']);
    } finally {f.controller.dispose();}
  });
}

test('ready transcript validation does not narrow explicit manual draft edits', async () => {
  const f = backgroundFixture();
  try {
    await f.controller.start();
    const s = await record(f, 'A'); await ready(f, s);
    const text = 'explicit manual edit\x85\r';
    s.edit(text);
    assert.equal(f.controller.send(s), true); await flush();
    assert.deepEqual(f.delivered, [{session: 'A', text}]);
  } finally {f.controller.dispose();}
});

function channelFixture() {
  let listener = (_text: string): void => {}, live = true, released = 0, guard = true;
  const frames: string[] = [], controls: unknown[] = [], preparations: (() => void)[] = [];
  const mode = {value: true, valid: true, bytes() {}, dispose() {}};
  const transport = {control: (id: string, dirty: boolean) => controls.push([id, dirty]),
    data: (bytes: Uint8Array) => frames.push(new TextDecoder().decode(bytes))};
  const scope = createHumanInputScope(), lease = createHumanInputLease({clientId: 'original-client', scope, ...transport});
  const channel = createDictationChannel({target: {} as CapturedTarget, socket: {send() {throw Error('not the original transport');}},
    lease, mode, valid: () => live, release: () => {released++;}, transport,
    encoder: () => ({write: (_text, done) => {preparations.push(done);},
      paste: text => listener(`\x1b[200~${text}\x1b[201~`), onData: fn => {listener = fn; return {dispose() {}};}, dispose() {}})});
  return {channel, frames, controls, preparations, lease, mode, scope, released: () => released,
    guard: () => guard, invalidate: () => {live = false;}, edit: () => {guard = false;}};
}
const delay = () => new Promise(resolve => setTimeout(resolve, 90));

test('retained channel uses original client lease and xterm framing, followed by delayed Enter', async () => {
  const f = channelFixture(); assert.equal(f.channel.claim(), true);
  const results: string[] = []; f.channel.deliver('spoken', r => results.push(r.kind), f.guard);
  assert.deepEqual(f.frames, []); f.preparations.shift()!();
  assert.deepEqual(f.frames, ['\x1b[200~spoken\x1b[201~']); await delay();
  assert.deepEqual(f.frames, ['\x1b[200~spoken\x1b[201~', '\r']); assert.deepEqual(results, ['submitted']);
  assert.deepEqual(f.controls, [['original-client', true], ['original-client', false]]);
  f.channel.release(); f.channel.release(); assert.equal(f.released(), 1);
});

test('a replaced socket refuses before paste, never reconnecting by session name', () => {
  const f = channelFixture(); assert.equal(f.channel.claim(), true);
  const results: string[] = []; f.channel.deliver('spoken', r => results.push(r.kind), f.guard);
  f.invalidate(); f.preparations.shift()!();
  assert.deepEqual(f.frames, []); assert.deepEqual(results, ['refused']); f.channel.release();
});

test('native foreign input before delayed Enter yields uncertain, with no retry or lease release', async () => {
  const f = channelFixture(); assert.equal(f.channel.claim(), true);
  const results: string[] = []; f.channel.deliver('spoken', r => results.push(r.kind), f.guard);
  f.preparations.shift()!(); f.scope.mutate(); await delay();
  assert.deepEqual(results, ['uncertain']); assert.equal(f.frames.length, 1); assert.equal(f.lease.dirty, true);
  f.channel.release(); await delay(); assert.equal(f.frames.length, 1);
});

test('bounded mode reseeding fails closed before any payload', () => {
  const f = channelFixture(); assert.equal(f.channel.claim(), true);
  const results: string[] = []; f.channel.deliver('spoken', r => results.push(r.kind), f.guard);
  for (let i = 0; i < 3; i++) {f.mode.value = !f.mode.value; f.preparations.shift()!();}
  assert.deepEqual(results, ['refused']); assert.deepEqual(f.frames, []); f.channel.release();
});

class ElementStub extends EventTarget {
  textContent = ''; title = ''; value = ''; checked = false; disabled = false; hidden = false;
  className = ''; type = ''; dataset: Record<string, string> = {}; children: ElementStub[] = [];
  attributes = new Map<string, string>(); onclick: (() => void | Promise<void>) | null = null;
  parent: ElementStub | null = null;
  setAttribute(key: string, value: string) {this.attributes.set(key, value);}
  append(...items: ElementStub[]) {for (const item of items) {item.parent = this; this.children.push(item);}}
  remove() {if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null;}
  replaceChildren(...items: ElementStub[]) {this.children = items;}
  get childElementCount() {return this.children.length;}
}
function viewFixture(f: ReturnType<typeof backgroundFixture>, s: DictationSession) {
  const documentStub = Object.assign(new EventTarget(), {createElement: () => new ElementStub(), hidden: false, activeElement: null});
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', {value: documentStub, configurable: true});
  Object.defineProperty(globalThis, 'window', {value: new EventTarget(), configurable: true});
  const p = {controller: () => f.controller, session: () => s, text: new ElementStub(), microphone: new ElementStub(),
    status: new ElementStub(), send: new ElementStub(), insert: new ElementStub(), global: new ElementStub(), discard: new ElementStub(),
    autoSend: new ElementStub(), preferenceStatus: new ElementStub(), sync() {}};
  const view = createDictationView(p as any);
  const restore = (key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  };
  return {p, view, document: documentStub, dispose() {restore('document', previousDocument); restore('window', previousWindow); setTranslator(key => key);}};
}

test('background polling preserves original row/control identity without stealing focus', async () => {
  const f = backgroundFixture(); await f.controller.start(); const s = f.controller.session('A', 7), v = viewFixture(f, s);
  try {
    s.state = 'recovery'; s.transcript = 'spoken'; s.edit('edited'); v.view.render();
    const row = v.p.global.children[0], controls = row.children.filter(node => node.type === 'button');
    assert.equal(controls.length, 4);
    for (const control of controls) {
      v.document.activeElement = control as any;
      s.message = 'statusUnavailable'; v.view.render();
      assert.equal(v.p.global.children[0], row); assert.ok(row.children.includes(control));
      assert.equal(v.document.activeElement, control);
    }
    v.document.activeElement = v.p.text as any;
    const b = f.controller.session('B', 8); b.state = 'queued'; v.view.render();
    assert.equal(v.document.activeElement, v.p.text); assert.equal(v.p.global.children[0], row);
    b.state = 'idle'; v.view.render(); assert.equal(v.p.global.children.length, 1);
  } finally {v.dispose(); f.controller.dispose();}
});

test('a cached composer without the new discard element remains usable during a frontend update', async () => {
  const f = backgroundFixture(); await f.controller.start();
  const s = f.controller.session('A', 7), v = viewFixture(f, s);
  try {
    const legacy = createDictationView({...v.p, discard: null} as any);
    s.state = 'ready'; legacy.render();
    assert.equal(v.p.send.disabled, true);
    assert.equal(v.p.status.textContent, 'dictation.emptyDraft');
  } finally {v.dispose(); f.controller.dispose();}
});

test('microphone pressed indicator starts only after permission and successful recorder start', async () => {
  const f = backgroundFixture(); await f.controller.start(); const s = f.controller.session('A', 7), v = viewFixture(f, s);
  try {
    let permit!: (stream: any) => void;
    f.setPermission(() => new Promise(resolve => {permit = resolve;}));
    const pending = f.controller.press(s); v.view.render();
    assert.equal(s.state, 'requesting'); assert.equal(v.p.microphone.attributes.get('aria-pressed'), 'false');
    assert.equal(v.p.microphone.attributes.get('aria-disabled'), 'false', 'release must still cancel the pending hold');
    f.controller.release(s); let stopped = 0; permit({getTracks: () => [{stop() {stopped++;}}]});
    assert.equal(await pending, false); assert.equal(stopped, 1); assert.equal(s.state, 'idle');
    f.setPermission(async () => {throw Error('denied');}); assert.equal(await f.controller.press(s), false); v.view.render();
    assert.equal(s.state, 'error'); assert.equal(v.p.microphone.attributes.get('aria-pressed'), 'false');
    f.controller.discard(s); f.setPermission(async () => ({getTracks: () => [{stop() {}}]}));
    assert.equal(await f.controller.press(s), true); v.view.render();
    assert.equal(s.state, 'recording'); assert.equal(v.p.microphone.attributes.get('aria-pressed'), 'true');
  } finally {v.dispose(); f.controller.dispose();}
});

test('background Copy reports unavailable/denied clipboard access and clears feedback on success without losing focus', async () => {
  const f = backgroundFixture(); await f.controller.start(); const s = f.controller.session('A', 7), v = viewFixture(f, s);
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    s.state = 'recovery'; s.transcript = 'spoken'; s.edit('edited'); v.view.render();
    const row = v.p.global.children[0], copies = row.children.filter(node => node.type === 'button').slice(0, 2);
    for (const copy of copies) {
      v.document.activeElement = copy as any;
      for (const clipboard of [undefined, {writeText() {throw Error('blocked');}}, {writeText: async () => {throw Error('denied');}}]) {
        Object.defineProperty(globalThis, 'navigator', {value: {clipboard}, configurable: true});
        await copy.onclick?.(); await flush();
        const feedback = row.children.find(node => node.attributes.get('aria-live') === 'polite')!;
        assert.ok(feedback); assert.equal(feedback.textContent, 'compose.copyFailed'); assert.equal(feedback.hidden, false);
        v.view.render(); assert.equal(v.document.activeElement, copy); assert.equal(v.p.global.children[0], row);
        assert.equal(s.transcript, 'spoken'); assert.equal(s.text, 'edited');
      }
      const copied: string[] = [];
      Object.defineProperty(globalThis, 'navigator', {value: {clipboard: {writeText: async (text: string) => {copied.push(text);}}}, configurable: true});
      await copy.onclick?.(); await flush(); assert.equal(copied.length, 1);
      const feedback = row.children.find(node => node.attributes.get('aria-live') === 'polite')!;
      assert.equal(feedback.textContent, ''); assert.equal(feedback.hidden, true); assert.equal(v.document.activeElement, copy);
    }
  } finally {
    if (old) Object.defineProperty(globalThis, 'navigator', old); else Reflect.deleteProperty(globalThis, 'navigator');
    v.dispose(); f.controller.dispose();
  }
});

for (const language of ['en', 'fr']) {
  test(`${language}: translator owns queued, processing, preference and recovery presentation`, async () => {
    const catalog = JSON.parse(readFileSync(`static/i18n/${language}.json`, 'utf8'));
    const f = backgroundFixture(); await f.controller.start(); const s = f.controller.session('A', 7), v = viewFixture(f, s);
    setTranslator((key, params) => {
      assert.ok(Object.hasOwn(catalog, key), `missing ${key}`);
      return catalog[key].replace(/\{(\w+)\}/g, (_: string, name: string) => String(params?.[name] ?? ''));
    });
    try {
      s.state = 'queued'; v.view.render();
      assert.equal(v.p.status.textContent, catalog['dictation.state.queued']); assert.equal(v.p.status.dataset.state, 'queued');
      assert.equal(v.p.microphone.attributes.get('aria-disabled'), 'true');
      assert.equal(v.p.preferenceStatus.textContent, catalog['dictation.autoDisabled']);
      s.state = 'processing'; v.view.render(); assert.equal(v.p.status.textContent, catalog['dictation.state.processing']);
      assert.notEqual(dictationLabel('queued'), dictationLabel('processing'));
      s.state = 'recovery'; s.message = 'untrusted unknown service prose'; s.text = 'editable recovery'; v.view.render();
      assert.equal(v.p.text.value, 'editable recovery'); assert.ok(v.p.status.textContent.includes(catalog['dictation.message.serviceError']));
      assert.ok(!v.p.status.textContent.includes(s.message));
      assert.equal(v.p.insert.disabled, true); assert.equal(v.p.send.disabled, true);
      s.state = 'ready'; s.message = ''; s.text = ''; v.p.send.disabled = false; v.view.render();
      assert.equal(v.p.status.textContent, catalog['dictation.emptyDraft']);
      assert.equal(v.p.send.disabled, true);
      assert.equal(v.p.discard.disabled, false);
      s.state = 'idle'; v.view.render(); assert.equal(v.p.discard.disabled, true);
    } finally {v.dispose(); f.controller.dispose();}
  });
}
