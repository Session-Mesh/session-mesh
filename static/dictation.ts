// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {hasDictationControls} from '../shared/dictation-text.ts';

// Page-memory-only jobs and authorization; only the opt-in boolean is persisted.
export type DictationState = 'idle' | 'requesting' | 'recording' | 'uploading' |
  'queued' | 'processing' | 'ready' | 'error' | 'recovery' | 'delivering';
interface Job {
  job_id: string; request_id: string; session: string; created: number;
  state: 'queued' | 'processing' | 'ready' | 'error' | 'cancelled' | 'settled';
  text: string | null; error: {code: string; message: string} | null;
  outcome: 'submitted' | 'discarded' | null;
}
export interface DictationChannel {
  valid(): boolean;
  captureFresh?(): boolean;
  claim(): boolean;
  release(): void;
  deliver(text: string, done: (result: {kind: string}) => void, guard: () => boolean): void;
}
interface MediaPorts {
  supported(): boolean;
  permission(): Promise<MediaStream>;
  recorder(stream: MediaStream): MediaRecorder;
}
interface Ports {
  namespace: string; uuid(): string; allowed(): boolean; changed(): void;
  eligible?(session: DictationSession): boolean;
  preference?: {read(): unknown; write(enabled: boolean): void};
  retain(session: DictationSession): DictationChannel | null;
  media: MediaPorts; request(path: string, init?: RequestInit): Promise<Response>;
  schedule(callback: () => void, ms: number): number; unschedule(id: number): void; now(): number;
}
interface Config {enabled: boolean; max_bytes: number; capture_seconds: number;
  queue_wait_seconds?: number; active_timeout_seconds?: number; result_ttl_seconds?: number}
const RECOVERY_MS = 30000;
export class DictationSession {
  readonly key: string; readonly name: string; readonly created: number;
  private readonly changed: () => void;
  text = ''; revision = 0; state: DictationState = 'idle'; message = ''; transcript = '';
  requestId: string | null = null; job: Job | null = null; audio: Blob | null = null;
  channel: DictationChannel | null = null; discard = false; outcome: 'submitted' | 'discarded' | null = null;
  initialRevision = 0; timer: number | null = null; channelTimer: number | null = null; busy = false; sent = false;
  delivery = 0;
  missing = false;
  generation = 0; io = 0; reconciling = false; uploadStarted = false;
  recoveryDeadline = 0; recoveryTimer: number | null = null;
  readonly pending = new Set<AbortController>();
  autoAuthorized = false; autoAttempted = false; insertionRevision: number | null = null;
  constructor(key: string, name: string, created: number, changed: () => void) {
    this.key = key; this.name = name; this.created = created; this.changed = changed;
  }
  edit(text: string): void {
    if (this.text === text) return;
    this.text = text; this.revision++; this.changed();
  }
  get outstanding(): boolean {return this.state !== 'idle' || this.requestId !== null;}
  release(): void {this.channel?.release(); this.channel = null;}
}
interface Capture {
  session: DictationSession; stream: MediaStream | null; recorder: MediaRecorder | null;
  chunks: Blob[]; bytes: number; released: boolean; cancelled: boolean; started: number;
  timer: number | null; completed: boolean; generation: number;
}
interface Operation {generation: number; requestId: string}
export function createRetainedLifetime(close: () => void) {
  let attached = true, disposed = false, refs = 0;
  const check = (): void => {if (!disposed && !attached && !refs) {disposed = true; close();}};
  return {
    retain(): (() => void) | null {
      if (disposed) return null;
      refs++; let held = true;
      return () => {if (!held) return; held = false; refs--; check();};
    },
    detach(): void {attached = false; check();},
    dispose(): void {if (disposed) return; disposed = true; close();},
  };
}
export class DictationController {
  private readonly p: Ports;
  private started = false; private disposed = false; private suspended = false; private config: Config | null = null;
  private client = ''; private capture: Capture | null = null;
  private readonly sessions = new Map<string, DictationSession>();
  private abort = new AbortController();
  private automatic = false;
  preferenceMessage = '';
  constructor(p: Ports) {this.p = p;}
  session(name: string, created: number): DictationSession {
    const key = JSON.stringify([this.p.namespace, name, created]);
    let session = this.sessions.get(key);
    if (!session) {
      session = new DictationSession(key, name, created, () => this.notify());
      this.sessions.set(key, session);
    }
    return session;
  }
  peekSession(name: string, created: number): DictationSession | undefined {
    return this.sessions.get(JSON.stringify([this.p.namespace, name, created]));
  }
  private allowed(): boolean {return this.started && !this.disposed && !this.suspended && this.p.allowed();}
  get autoSend(): boolean {return this.allowed() && this.automatic;}
  get preferenceAvailable(): boolean {return this.allowed() && !!this.config && !!this.p.preference;}
  private revokeAutomatic(): void {
    this.automatic = false;
    for (const s of this.sessions.values()) s.autoAuthorized = false;
  }
  setAutoSend(enabled: boolean): void {
    if (!this.allowed() || !this.p.preference) return;
    if (!enabled) this.revokeAutomatic();
    try {
      this.p.preference.write(enabled === true);
      this.automatic = enabled === true; this.preferenceMessage = '';
    } catch {
      this.revokeAutomatic();
      this.preferenceMessage = enabled ? 'storageWrite' : 'storageOptOut';
    }
    this.notify();
  }
  private readPreference(): void {
    try {this.automatic = this.p.preference?.read() === true;}
    catch {this.automatic = false; this.preferenceMessage = 'storageRead';}
  }
  private notify(): void {if (!this.disposed) this.p.changed();}
  private async read(
    path: string, init: RequestInit = {}, s?: DictationSession,
  ): Promise<{response: Response; value: any}> {
    if (!this.allowed()) throw Error('disposed');
    const lifetime = this.abort, abort = new AbortController();
    const deadline = Math.min(this.p.now() + RECOVERY_MS, s?.recoveryDeadline || Infinity);
    if (this.p.now() >= deadline) throw Error('deadline');
    s?.pending.add(abort);
    const cancel = (): void => abort.abort();
    lifetime.signal.addEventListener('abort', cancel, {once: true});
    const timer = this.p.schedule(cancel, Math.max(0, deadline - this.p.now()));
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => {this.p.unschedule(timer); reject(Error('aborted'));};
    });
    abort.signal.addEventListener('abort', rejectAbort, {once: true});
    try {
      // Race the whole exchange, not only fetch: an adapter may ignore abort or
      // resolve headers while its JSON body never settles.
      return await Promise.race([aborted, (async () => {
        const response = await this.p.request(path, {...init, signal: abort.signal});
        if (abort.signal.aborted || lifetime !== this.abort || !this.allowed() || this.p.now() >= deadline) {
          throw Error('aborted');
        }
        if (response.status === 401 || response.status === 403) {this.dispose(); throw Error('authentication');}
        const value = await response.json().catch(() => null);
        if (abort.signal.aborted || lifetime !== this.abort || !this.allowed() || this.p.now() >= deadline) {
          throw Error('aborted');
        }
        return {response, value};
      })()]);
    } finally {
      this.p.unschedule(timer); lifetime.signal.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', rejectAbort); s?.pending.delete(abort);
    }
  }
  async start(): Promise<void> {
    if (this.started || this.disposed || !this.p.allowed()) return;
    this.started = true; this.client = this.p.uuid();
    this.readPreference();
    await this.configure();
  }
  private async configure(): Promise<void> {
    const abort = this.abort;
    try {
      const {response: r, value: c} = await this.read('/api/transcribe/config');
      if (abort === this.abort && this.allowed() && r.ok && c?.enabled === true && Number.isSafeInteger(c.max_bytes)
        && c.max_bytes > 0 && Number.isSafeInteger(c.capture_seconds) && c.capture_seconds > 0) this.config = c;
    } catch { /* Default off; no media effect. */ }
    this.notify();
  }
  reason(s: DictationSession): string {
    if (!this.allowed() || !this.config) return 'unavailable';
    if (!this.p.media.supported()) return 'unsupported';
    if (s.text.length) return 'nonempty';
    if (s.outstanding) return 'outstanding';
    if (this.capture) return 'microphoneBusy';
    if (this.p.eligible && !this.p.eligible(s)) return 'ineligible';
    return '';
  }
  async press(s: DictationSession): Promise<boolean> {
    if (this.reason(s)) return false;
    let channel: DictationChannel | null = null;
    try {channel = this.p.retain(s); if (!channel?.valid()) throw Error('channel');}
    catch {channel?.release(); s.message = 'originalUnavailable'; this.notify(); return false;}
    s.channel = channel; s.initialRevision = s.revision; s.state = 'requesting'; s.message = '';
    s.generation++; s.uploadStarted = false;
    s.autoAuthorized = this.autoSend; s.autoAttempted = false; s.insertionRevision = null;
    const cap: Capture = {session: s, stream: null, recorder: null, chunks: [], bytes: 0,
      released: false, cancelled: false, started: this.p.now(), timer: null,
      completed: false, generation: s.generation};
    this.capture = cap; this.notify();
    cap.timer = this.p.schedule(() => this.failCapture(cap, 'permissionTimeout'), this.config!.capture_seconds * 1000);
    try {
      const stream = await this.p.media.permission();
      if (!this.captureCurrent(cap) || s.text.length || s.revision !== s.initialRevision || !channel.valid()) {
        stream.getTracks().forEach(t => t.stop()); if (this.capture === cap) this.cancelCapture(cap); return false;
      }
      cap.stream = stream; this.record(cap); return true;
    } catch {if (this.captureCurrent(cap)) this.failCapture(cap, 'permissionDenied'); return false;}
  }
  private captureCurrent(cap: Capture): boolean {
    return this.allowed() && this.capture === cap && cap.generation === cap.session.generation
      && !cap.cancelled && !cap.released;
  }
  private record(cap: Capture): void {
    if (cap.timer !== null) this.p.unschedule(cap.timer);
    const recorder = this.p.media.recorder(cap.stream!); cap.recorder = recorder;
    recorder.ondataavailable = e => {
      if (cap.cancelled || cap.completed || !e.data.size) return;
      cap.bytes += e.data.size;
      if (cap.bytes > this.config!.max_bytes) {this.failCapture(cap, 'audioLimit'); return;}
      cap.chunks.push(e.data);
    };
    recorder.onerror = () => this.failCapture(cap, 'recordingError');
    recorder.onstop = () => this.captured(cap);
    cap.stream!.getTracks().forEach(t => {
      t.onended = () => {if (!cap.released) this.failCapture(cap, 'microphoneInterrupted');};
    });
    recorder.start(250); cap.session.state = 'recording';
    cap.timer = this.p.schedule(() => this.failCapture(cap, 'durationLimit'), this.config!.capture_seconds * 1000);
    this.notify();
  }
  release(s: DictationSession): void {
    const cap = this.capture;
    if (!cap || cap.session !== s) return;
    if (!cap.recorder || cap.recorder.state !== 'recording') {this.cancelCapture(cap); return;}
    cap.released = true; s.state = 'uploading'; s.requestId = this.p.uuid();
    this.boundChannel(s, true);
    this.stop(cap); this.notify();
  }
  private stop(cap: Capture): void {
    if (cap.timer !== null) this.p.unschedule(cap.timer);
    cap.timer = null;
    if (cap.recorder?.state === 'recording') cap.recorder.stop();
    cap.stream?.getTracks().forEach(t => {t.onended = null; t.stop();});
  }
  private cancelCapture(cap: Capture): void {
    const current = cap.generation === cap.session.generation;
    cap.cancelled = true; this.stop(cap); cap.chunks = [];
    if (this.capture === cap) this.capture = null;
    if (current) {cap.session.generation++; cap.session.state = 'idle'; cap.session.release(); this.notify();}
  }
  private failCapture(cap: Capture, message: string): void {
    if (cap.cancelled || cap.completed || cap.generation !== cap.session.generation) return;
    cap.session.requestId = null;
    if (cap.session.channelTimer !== null) this.p.unschedule(cap.session.channelTimer);
    cap.session.channelTimer = null;
    this.cancelCapture(cap); cap.session.state = 'error'; cap.session.message = message; this.notify();
  }
  private captured(cap: Capture): void {
    if (cap.completed) return;
    cap.completed = true;
    if (this.capture === cap) this.capture = null;
    if (cap.cancelled || !cap.released || !this.allowed() || cap.generation !== cap.session.generation) return;
    const s = cap.session, type = cap.chunks.find(b => b.type)?.type || cap.recorder?.mimeType || '';
    s.audio = new Blob(cap.chunks, {type}); cap.chunks = [];
    if (!s.audio.size || !/^audio\/(webm|mp4|ogg|wav|x-wav)(;|$)/i.test(type)) {
      s.requestId = null; s.audio = null; s.release(); s.state = 'error'; s.message = 'invalidAudio';
      this.notify(); return;
    }
    void this.upload(s);
  }
  private headers(): Record<string, string> {return {'X-Mesh-Dictation-Client': this.client};}
  private operation(s: DictationSession): Operation {return {generation: s.generation, requestId: s.requestId!};}
  private current(s: DictationSession, op: Operation): boolean {
    return this.allowed() && s.generation === op.generation && s.requestId === op.requestId;
  }
  private beginIo(s: DictationSession): Operation {s.io++; s.busy = true; return this.operation(s);}
  private endIo(s: DictationSession, op: Operation): void {
    if (!this.current(s, op)) return;
    s.io--; s.busy = s.reconciling || (s.io > 0 && !s.job); this.notify(); this.later(s);
    if (s.io === 0 && !s.busy) this.automaticReady(s);
  }
  private automaticReady(s: DictationSession): void {
    if (!s.autoAuthorized || s.autoAttempted || s.state !== 'ready' || s.sent) return;
    s.autoAttempted = true;
    if (s.insertionRevision !== s.revision || s.text !== s.transcript || !s.channel?.captureFresh?.()) {
      s.release(); s.state = 'recovery'; s.message = 'contextChanged';
      this.notify(); return;
    }
    this.send(s, true);
  }
  private boundChannel(s: DictationSession, admitting = false): void {
    const op = this.operation(s);
    const c = this.config!;
    const seconds = (c.queue_wait_seconds ?? 600) + (c.active_timeout_seconds ?? 60) + (c.result_ttl_seconds ?? 1800)
      + (admitting ? RECOVERY_MS / 1000 : 0);
    if (s.channelTimer !== null) this.p.unschedule(s.channelTimer);
    s.channelTimer = this.p.schedule(() => {
      if (!this.current(s, op)) return;
      s.channelTimer = null; s.release();
      if (s.requestId) {s.state = 'recovery'; s.message = 'channelExpired'; this.notify();}
    }, seconds * 1000);
  }
  private resultChannel(s: DictationSession): void {
    const op = this.operation(s);
    if (s.channelTimer !== null) this.p.unschedule(s.channelTimer);
    s.channelTimer = this.p.schedule(() => {
      if (!this.current(s, op)) return;
      s.channelTimer = null; s.release();
      if (s.requestId) {s.state = 'recovery'; s.message = 'resultExpired'; this.notify();}
    }, (this.config!.result_ttl_seconds ?? 1800) * 1000);
  }
  private async upload(s: DictationSession): Promise<void> {
    const op = this.beginIo(s), audio = s.audio!; s.audio = null; s.uploadStarted = true;
    try {
      const {response: r, value} = await this.read('/api/transcribe', {method: 'POST', headers: {...this.headers(),
        'Content-Type': audio.type, 'X-Mesh-Session': s.name, 'X-Mesh-Created': String(s.created),
        'X-Mesh-Request-Id': op.requestId}, body: audio}, s);
      if (!this.current(s, op) || s.job) return;
      if (!r.ok) {
        // A concrete rejection is not an admission acknowledgement. Keep uncertain 5xx.
        if (r.status < 500) {this.finish(s); s.state = 'error';
          s.message = value?.error?.code || 'admissionRejected'; this.notify(); return;}
        throw Error('unavailable');
      }
      if (this.current(s, op) && !s.job) this.accept(s, value);
    } catch {if (this.current(s, op) && !s.job) {
      this.boundRecovery(s); s.state = 'recovery'; s.message = 'admissionUnconfirmed';
    }}
    finally {this.endIo(s, op);}
  }
  private accept(s: DictationSession, value: unknown): void {
    const j = value as Job;
    if (!j || typeof j.job_id !== 'string' || j.request_id !== s.requestId
      || j.session !== s.name || j.created !== s.created
      || !['queued', 'processing', 'ready', 'error', 'cancelled', 'settled'].includes(j.state)) {
      throw Error('invalid job');
    }
    if (j.state === 'ready'
      && (typeof j.text !== 'string' || !j.text.trim() || hasDictationControls(j.text))) {
      throw Error('invalid text');
    }
    const firstResult = !['ready', 'error'].includes(s.job?.state || '');
    if (!s.job && ['queued', 'processing'].includes(j.state)) this.boundChannel(s);
    s.job = j; s.audio = null;
    if (!s.discard && !s.outcome) this.clearRecovery(s);
    if (firstResult && ['ready', 'error'].includes(j.state)) this.resultChannel(s);
    if (j.state === 'cancelled' || j.state === 'settled') {this.finish(s); return;}
    if (s.discard || s.outcome) return;
    if (j.state === 'ready') {
      s.transcript = j.text!;
      if (s.state === 'ready' || s.sent) return;
      if (s.revision === s.initialRevision && s.text.length === 0) {
        s.edit(j.text!); s.insertionRevision = s.revision; s.state = 'ready'; s.message = '';
        if (!s.channel) {s.state = 'recovery'; s.message = 'channelUnavailable';}
      }
      else {s.state = 'recovery'; s.message = 'draftChanged';}
    } else {s.state = j.state; s.message = j.error?.code || '';}
  }
  private later(s: DictationSession): void {
    const retainedResult = ['ready', 'error'].includes(s.job?.state || s.state);
    if (!this.allowed() || s.missing || !s.requestId || s.timer !== null
      || (!s.discard && !s.outcome && retainedResult)) return;
    if (s.recoveryDeadline && this.p.now() >= s.recoveryDeadline) return;
    const op = this.operation(s);
    s.timer = this.p.schedule(() => {if (this.current(s, op)) {s.timer = null; void this.reconcile(s);}}, 1000);
  }
  async reconcile(s: DictationSession): Promise<void> {
    if (!this.allowed() || s.missing || s.reconciling || !s.requestId) return;
    if (s.recoveryDeadline && this.p.now() >= s.recoveryDeadline) {if (s.discard || s.outcome) this.finish(s); return;}
    const op = this.beginIo(s), knownId = s.job?.job_id ?? null; s.reconciling = true;
    const obsolete = (): boolean => !this.current(s, op)
      || (knownId !== null ? s.job?.job_id !== knownId : s.job !== null);
    try {
      if (s.job && (s.discard || s.outcome)) {await this.acknowledge(s, op); return;}
      const path = knownId !== null ? `/api/transcribe/${knownId}` : `/api/transcribe/request/${op.requestId}`;
      const {response: r, value} = await this.read(path, {headers: this.headers(), cache: 'no-store'}, s);
      if (obsolete()) return;
      if (r.status === 404 && knownId !== null) {this.absent(s); return;}
      if (!r.ok) throw Error('unavailable'); // 404 after a lost ack does not prove non-admission.
      if (!obsolete()) this.accept(s, value);
    } catch {if (!obsolete()) {s.state = 'recovery'; s.message = 'statusUnavailable';}}
    finally {if (this.current(s, op)) s.reconciling = false; this.endIo(s, op);}
  }
  private async acknowledge(s: DictationSession, op: Operation): Promise<void> {
    const action = s.outcome ? 'settle' : 'cancel';
    const {response: r, value: j} = await this.read(`/api/transcribe/${s.job!.job_id}/${action}`, {method: 'POST',
      headers: {...this.headers(), 'Content-Type': 'application/json'},
      body: JSON.stringify(s.outcome ? {outcome: s.outcome} : {})}, s);
    if (!this.current(s, op)) return;
    if (r.status === 404) {this.absent(s); return;}
    if (!r.ok) throw Error('unconfirmed');
    if (j?.state !== 'cancelled' && j?.state !== 'settled') throw Error('unconfirmed');
    this.accept(s, j);
  }
  private finish(s: DictationSession): void {
    s.generation++; s.io = 0; s.busy = false; s.reconciling = false; s.uploadStarted = false;
    s.delivery++;
    s.autoAuthorized = false; s.autoAttempted = false; s.insertionRevision = null;
    this.clearTimers(s);
    this.clearRecovery(s); this.abortSession(s);
    s.release(); s.audio = null; s.requestId = null; s.job = null; s.transcript = '';
    s.discard = false; s.outcome = null; s.sent = false; s.missing = false; s.state = 'idle'; s.message = '';
    this.notify();
  }
  private abortSession(s: DictationSession): void {
    for (const abort of s.pending) abort.abort(); s.pending.clear();
  }
  private clearRecovery(s: DictationSession): void {
    if (s.recoveryTimer !== null) this.p.unschedule(s.recoveryTimer);
    s.recoveryTimer = null; s.recoveryDeadline = 0;
  }
  private boundRecovery(s: DictationSession): void {
    if (!s.recoveryDeadline) s.recoveryDeadline = this.p.now() + RECOVERY_MS;
    if (s.recoveryTimer !== null) return;
    const op = this.operation(s);
    s.recoveryTimer = this.p.schedule(() => {
      s.recoveryTimer = null;
      if (!this.current(s, op)) return;
      if (s.discard || s.outcome) {this.finish(s); return;}
      // No absence claim: keep the identity for explicit local discard, but stop
      // background retries and revoke the original input authority at the bound.
      s.release(); this.abortSession(s);
      if (s.timer !== null) this.p.unschedule(s.timer); s.timer = null;
      s.state = 'recovery'; s.message = 'admissionUnconfirmed'; this.notify();
    }, Math.max(0, s.recoveryDeadline - this.p.now()));
  }
  private clearTimers(s: DictationSession): void {
    if (s.channelTimer !== null) this.p.unschedule(s.channelTimer);
    if (s.timer !== null) this.p.unschedule(s.timer);
    s.channelTimer = s.timer = null;
  }
  private absent(s: DictationSession): void {
    s.missing = true; s.delivery++; this.clearTimers(s); s.release(); s.audio = null;
    if (s.discard || s.outcome) {this.finish(s); return;}
    s.state = 'recovery'; s.message = 'jobMissing'; this.notify();
  }
  discard(s: DictationSession): void {
    if (!this.allowed()) return;
    if (this.capture?.session === s && !s.uploadStarted) {this.cancelCapture(this.capture); this.finish(s); return;}
    s.delivery++; s.discard = true; s.release();
    if (!s.requestId || s.missing) {this.finish(s); this.notify(); return;}
    this.boundRecovery(s);
    if (this.p.now() >= s.recoveryDeadline) {this.finish(s); return;}
    s.state = 'recovery'; s.message = 'discardPending'; void this.reconcile(s); this.notify();
  }
  send(s: DictationSession, automatic = false): boolean {
    if (!this.allowed() || s.state !== 'ready' || s.sent || s.busy || !s.text) return false;
    if (automatic && !s.autoAuthorized) return false;
    if (!s.channel?.valid() || !s.channel.claim()) {
      s.release(); s.state = 'recovery'; s.message = 'channelUnavailable';
      this.notify(); return false;
    }
    const text = s.text, revision = s.revision, operation = ++s.delivery;
    s.state = 'delivering'; s.sent = true; this.notify();
    void this.deliver(s, text, revision, operation, automatic);
    return true;
  }
  private async deliver(
    s: DictationSession, text: string, revision: number, operation: number, automatic: boolean,
  ): Promise<void> {
    const guard = (): boolean => this.allowed() && s.delivery === operation && !s.discard
      && (!automatic || s.autoAuthorized)
      && s.state === 'delivering' && s.revision === revision && s.text === text;
    try {
      // Revalidate the existing job, never admission or input, before using its original port.
      const {response: r, value: j} = await this.read(`/api/transcribe/${s.job!.job_id}`,
        {headers: this.headers(), cache: 'no-store'}, s);
      if (!this.allowed() || s.delivery !== operation) return;
      if (r.status === 404) {this.absent(s); return;}
      if (!r.ok || j?.job_id !== s.job!.job_id || j.request_id !== s.requestId || j.session !== s.name
        || j.created !== s.created || j.state !== 'ready' || j.text !== s.transcript
        || !guard() || !s.channel?.valid()) throw Error('guard');
    } catch {
      if (!this.allowed() || s.delivery !== operation) return;
      s.delivery++; s.release(); s.state = 'recovery'; s.message = 'resultUnconfirmed'; this.notify(); return;
    }
    s.channel!.deliver(text, result => {
      if (!this.allowed() || s.delivery !== operation) return;
      s.delivery++;
      s.release();
      if (result.kind === 'submitted') {
        if (s.revision === revision && s.text === text) s.edit('');
        s.outcome = 'submitted'; s.message = 'settlementPending';
        this.boundRecovery(s);
        s.state = 'recovery'; void this.reconcile(s);
      } else {s.state = 'recovery'; s.message = 'deliveryUncertain';}
      this.notify();
    }, guard);
  }
  detach(s: DictationSession): void {
    if (this.capture?.session === s && !this.capture.released) this.cancelCapture(this.capture);
  }
  hidden(): void {if (this.capture && !this.capture.released) this.cancelCapture(this.capture);}
  holds(): DictationSession[] {return [...this.sessions.values()].filter(s => s.outstanding || s.text.length > 0);}
  suspendForPageCache(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true; this.abort.abort();
    const cap = this.capture;
    if (cap && !cap.released) this.cancelCapture(cap);
    else if (cap) {
      cap.cancelled = true; this.stop(cap); cap.chunks = []; this.capture = null;
      if (!cap.session.uploadStarted) cap.session.requestId = null;
    }
    for (const s of this.sessions.values()) {
      const delivering = s.state === 'delivering';
      s.generation++; s.delivery++; s.io = 0; s.busy = false; s.reconciling = false;
      s.autoAuthorized = false; s.autoAttempted = true;
      this.clearTimers(s); s.release();
      if (s.recoveryTimer !== null) this.p.unschedule(s.recoveryTimer); s.recoveryTimer = null;
      if (s.outstanding) {s.state = 'recovery'; s.message = delivering ? 'deliveryUncertain' : 'channelUnavailable';}
    }
    this.notify();
  }
  resumeFromPageCache(): void {
    if (this.disposed || !this.suspended || !this.p.allowed()) return;
    this.abort = new AbortController(); this.suspended = false;
    // Only status reads may resume. No old job gets a new channel or admission.
    for (const s of this.sessions.values()) {if (s.recoveryDeadline) this.boundRecovery(s); this.later(s);}
    if (!this.config) void this.configure();
    this.notify();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeAutomatic();
    this.abort.abort();
    if (this.capture) this.cancelCapture(this.capture);
    for (const s of this.sessions.values()) {
      if (s.timer !== null) this.p.unschedule(s.timer);
      if (s.channelTimer !== null) this.p.unschedule(s.channelTimer);
      this.clearRecovery(s); this.abortSession(s);
      s.release(); s.audio = null;
    }
  }
}
export function createDictationController(ports: Ports): DictationController {return new DictationController(ports);}

export function browserDictationMedia(): MediaPorts {
  return {
    supported: () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined',
    permission: () => navigator.mediaDevices.getUserMedia({audio: true}),
    recorder(stream) {
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      return new MediaRecorder(stream, mimeType ? {mimeType} : {});
    },
  };
}
