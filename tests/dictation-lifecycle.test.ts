// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDictationController, type DictationSession} from '../static/dictation.ts';

const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
function fixture() {
  const jobs = new Map<string, any>(), requests: string[] = [], timers = new Map<number, () => void>();
  let serial = 0, releases = 0, writes = 0, stopped = 0, preferenceWrites = 0;
  let pause = false, missing = false, resume = () => {}, permission: (() => Promise<any>) | null = null;
  let holdAdmission = false, releaseAdmission = () => {};
  let deliver: (() => void) | null = null;
  const recorder: any = {state: 'inactive', mimeType: 'audio/webm', start() {this.state = 'recording';},
    stop() {this.state = 'inactive'; queueMicrotask(() => {
      this.ondataavailable({data: new Blob(['audio'], {type: 'audio/webm'})}); this.onstop();
    });}};
  const controller = createDictationController({namespace: 'lifecycle', uuid: () => crypto.randomUUID(),
    allowed: () => true, changed() {}, preference: {read: () => true, write: () => {preferenceWrites++;}},
    media: {supported: () => true, permission: async () => permission ? permission() : ({getTracks: () => [{stop: () => {stopped++;}}]}),
      recorder: () => recorder}, retain: () => ({valid: () => true, captureFresh: () => true, claim: () => true,
      release: () => {releases++;}, deliver(_text, done, guard) {deliver = () => {if (guard()) writes++; done({kind: 'submitted'});};}}),
    request: async (path, init) => {
      requests.push(path);
      if (path.endsWith('/config')) return Response.json({enabled: true, max_bytes: 100, capture_seconds: 5});
      if (path === '/api/transcribe') {
        const h = init!.headers as Record<string, string>, name = h['X-Mesh-Session']!;
        const job = {job_id: crypto.randomUUID(), request_id: h['X-Mesh-Request-Id'], session: name,
          created: Number(h['X-Mesh-Created']), state: 'queued', text: null}; jobs.set(name, job);
        if (holdAdmission) await new Promise<void>(resolve => {releaseAdmission = resolve;});
        return Response.json(job);
      }
      const job = [...jobs.values()].find(j => path.includes(j.job_id) || path.endsWith(j.request_id));
      assert.ok(job);
      if (pause) {pause = false; await new Promise<void>(resolve => {resume = resolve;});}
      if (missing) return Response.json({error: {code: 'not_found'}}, {status: 404});
      if (path.endsWith('/cancel')) job.state = 'cancelled';
      return Response.json(job);
    }, schedule: fn => {timers.set(++serial, fn); return serial;}, unschedule: id => {timers.delete(id);}, now: () => 0});
  return {controller, jobs, requests, timers, recorder, counts: () => ({releases, writes, stopped, preferenceWrites}),
    pauseRead: () => {pause = true;}, releaseRead: () => resume(), deliver: () => deliver!(),
    expire: () => {missing = true;},
    holdAdmission: () => {holdAdmission = true;}, releaseAdmission: () => releaseAdmission(),
    permission: (fn: () => Promise<any>) => {permission = fn;}};
}
async function record(f: ReturnType<typeof fixture>, name = 'A'): Promise<DictationSession> {
  const s = f.controller.session(name, 1); assert.equal(await f.controller.press(s), true);
  f.controller.release(s); await flush(); return s;
}
function suspend(f: ReturnType<typeof fixture>): void {(f.controller as any).suspendForPageCache();}
function restore(f: ReturnType<typeof fixture>): void {(f.controller as any).resumeFromPageCache();}

test('cache suspension revokes pending automatic delivery, keeps draft/job/preference and never replays', async () => {
  const f = fixture(); await f.controller.start(); const s = await record(f);
  Object.assign(f.jobs.get('A'), {state: 'ready', text: 'spoken'}); await f.controller.reconcile(s);
  await flush(); assert.equal(s.state, 'delivering');
  const id = s.requestId; suspend(f);
  assert.equal(s.state, 'recovery'); assert.equal(s.autoAuthorized, false); assert.equal(s.channel, null);
  assert.equal(s.text, 'spoken'); assert.equal(s.requestId, id); assert.equal(f.counts().preferenceWrites, 0);
  f.deliver(); restore(f); f.deliver(); await flush();
  assert.equal(f.counts().writes, 0); assert.equal(f.controller.autoSend, true);
  assert.equal(f.controller.send(s), false); assert.equal(s.text, 'spoken');
  assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 1);
  assert.equal(f.requests.filter(path => path.endsWith('/settle')).length, 0);
  f.controller.discard(s); await flush(); assert.equal(s.state, 'idle');
  s.edit(''); assert.equal(await f.controller.press(s), true); f.controller.dispose();
});

test('cache suspension bounds in-flight IO and ignores old results after restoration', async () => {
  const f = fixture(); await f.controller.start(); const s = await record(f);
  f.pauseRead(); const pending = f.controller.reconcile(s); assert.equal(s.busy, true);
  suspend(f); assert.equal(s.busy, false); assert.equal(s.io, 0); assert.equal(s.reconciling, false);
  assert.equal(f.timers.size, 0); restore(f);
  Object.assign(f.jobs.get('A'), {state: 'ready', text: 'after freeze'}); f.releaseRead(); await pending;
  assert.equal(s.transcript, '', 'the pre-suspension read has no surviving generation');
  await f.controller.reconcile(s); assert.equal(s.text, 'after freeze'); assert.equal(s.state, 'recovery');
  assert.equal(s.channel, null); assert.equal(s.busy, false); assert.equal(s.io, 0);
  assert.equal(f.counts().writes, 0); assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 1);
  f.controller.dispose();
});

test('cache suspension stops unreleased recording and late permission; new captures still work', async () => {
  const f = fixture(); await f.controller.start(); const a = f.controller.session('A', 1);
  let permit = (_stream: any) => {}; f.permission(() => new Promise(resolve => {permit = resolve;}));
  const pending = f.controller.press(a); suspend(f); restore(f);
  let lateStopped = 0; permit({getTracks: () => [{stop: () => {lateStopped++;}}]}); await pending;
  assert.equal(lateStopped, 1); assert.equal(a.state, 'idle');
  f.permission(async () => ({getTracks: () => [{stop() {}}]})); await f.controller.press(a);
  assert.equal(a.state, 'recording'); suspend(f); restore(f); await flush();
  assert.equal(f.recorder.state, 'inactive'); assert.equal(a.state, 'idle');
  assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 0);
  assert.equal(await f.controller.press(a), true); f.controller.dispose();
});

test('final disposal during cache suspension cannot be resumed', async () => {
  const f = fixture(); await f.controller.start(); suspend(f); f.controller.dispose(); restore(f);
  assert.equal(await f.controller.press(f.controller.session('A', 1)), false);
  assert.equal(f.controller.autoSend, false); assert.equal(f.requests.length, 1);
});

test('a result expiring while cached is checked by its original job ID, never readmitted', async () => {
  const f = fixture(); await f.controller.start(); const s = await record(f);
  s.edit('manual draft'); const id = s.requestId, job = s.job!.job_id;
  suspend(f); f.expire(); restore(f); await f.controller.reconcile(s);
  assert.equal(f.requests.at(-1), `/api/transcribe/${job}`);
  assert.equal(s.requestId, id); assert.equal(s.text, 'manual draft'); assert.equal(s.missing, true);
  assert.equal(s.state, 'recovery'); assert.equal(s.channel, null); assert.equal(f.counts().writes, 0);
  assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 1);
  f.controller.discard(s); assert.equal(s.state, 'idle'); assert.equal(s.text, 'manual draft'); f.controller.dispose();
});

test('an uncertain admission reconciles only the same request and ignores its pre-freeze acknowledgement', async () => {
  const f = fixture(); await f.controller.start(); f.holdAdmission(); const s = await record(f);
  assert.equal(s.state, 'uploading'); assert.equal(s.busy, true); const request = s.requestId;
  suspend(f); restore(f); await f.controller.reconcile(s);
  assert.equal(f.requests.at(-1), `/api/transcribe/request/${request}`);
  assert.equal(s.requestId, request); assert.equal(s.channel, null); assert.equal(s.autoAuthorized, false);
  f.releaseAdmission(); await flush(); assert.equal(s.io, 0); assert.equal(s.busy, false);
  Object.assign(f.jobs.get('A'), {state: 'ready', text: 'retained'}); await f.controller.reconcile(s);
  assert.equal(s.text, 'retained'); assert.equal(s.state, 'recovery'); assert.equal(f.counts().writes, 0);
  assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 1); f.controller.dispose();
});

test('released but not uploaded capture cannot become a delayed new admission after cache return', async () => {
  const f = fixture(); await f.controller.start(); const s = f.controller.session('A', 1);
  await f.controller.press(s); f.controller.release(s); suspend(f); restore(f); await flush();
  assert.equal(f.requests.filter(path => path === '/api/transcribe').length, 0);
  assert.equal(s.state, 'recovery'); assert.equal(s.requestId, null); assert.equal(s.channel, null);
  f.controller.discard(s); assert.equal(s.state, 'idle'); f.controller.dispose();
});
