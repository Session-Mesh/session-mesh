// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {randomUUID} from 'node:crypto';
import http, {type IncomingMessage} from 'node:http';
import https from 'node:https';
import {isIP, type LookupFunction} from 'node:net';
import dns from 'node:dns';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {hasDictationControls} from '../shared/dictation-text.ts';

const messages = {
  invalid_request: 'Invalid dictation request.',
  not_found: 'Dictation job not found.',
  session_busy: 'This session already has outstanding dictation.',
  stale_session: 'The session is no longer live.',
  request_conflict: 'The request belongs to another session.',
  invalid_state: 'Invalid dictation transition.',
  audio_too_large: 'Audio exceeds the configured limit.',
  unsupported_audio: 'Unsupported audio format.',
  queue_full: 'The dictation queue is full.',
  capacity_full: 'Dictation capacity is full.',
  disabled: 'Dictation is disabled.',
  unavailable: 'Dictation is unavailable.',
  queue_expired: 'The dictation queue wait expired.',
  upstream_timeout: 'Transcription timed out.',
  upstream_unavailable: 'Transcription service unavailable.',
  upstream_invalid: 'Invalid transcription response.',
  empty_transcript: 'No speech was transcribed.',
} as const;
export type Code = keyof typeof messages;
const statuses: Partial<Record<Code, number>> = {
  not_found: 404,
  session_busy: 409,
  stale_session: 409,
  request_conflict: 409,
  invalid_state: 409,
  audio_too_large: 413,
  unsupported_audio: 415,
  queue_full: 429,
  capacity_full: 429,
  disabled: 503,
  unavailable: 503,
};
export class Fault extends Error {
  readonly status: number;
  readonly code: Code;
  constructor(code: Code) {
    super(messages[code]);
    this.code = code;
    this.status = statuses[code] ?? 400;
  }
  json() { return {error: {code: this.code, message: this.message}}; }
}
export interface PublicConfig {
  enabled: true;
  language: string | null;
  max_bytes: number;
  aggregate_bytes: number;
  queue_size: number;
  workers: number;
  active_timeout_seconds: number;
  queue_wait_seconds: number;
  result_ttl_seconds: number;
  capture_seconds: number;
}
export interface Config {url: URL; public: PublicConfig}
function loopbackAddress(address: string) {
  return address === '::1' || (isIP(address) === 4 && address.split('.')[0] === '127');
}
const loopbackLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, {...options, all: true}, (error, addresses) => {
    if (error) { callback(error, ''); return; }
    const local = addresses.filter(item => loopbackAddress(item.address));
    if (!local.length) { callback(new Fault('upstream_unavailable'), ''); return; }
    if (options.all) callback(null, local);
    else callback(null, local[0].address, local[0].family);
  });
};
export function configuration(env: NodeJS.ProcessEnv): Config | null {
  if (!env.MESH_WHISPER_URL) return null;
  const url = new URL(env.MESH_WHISPER_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.hash || env.MESH_WHISPER_URL.includes('#')) throw Error('Invalid Whisper URL');
  const host = url.hostname;
  const loopback = host === 'localhost' || host === 'localhost.' || host === '[::1]' || loopbackAddress(host);
  if (url.protocol === 'http:' && !loopback) throw Error('Remote Whisper URL requires HTTPS');
  const integer = (key: string, fallback: number) => {
    const value = env[`MESH_WHISPER_${key}`];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
      throw Error(`Invalid Whisper ${key}`);
    return Number(value);
  };
  const language = env.MESH_WHISPER_LANGUAGE ?? null;
  if (language !== null && !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(language)) throw Error('Invalid Whisper language');
  return {url, public: {
    enabled: true,
    language,
    max_bytes: integer('MAX_BYTES', 8388608),
    aggregate_bytes: integer('AGGREGATE_BYTES', 67108864),
    queue_size: integer('QUEUE_SIZE', 16),
    workers: integer('WORKERS', 1),
    active_timeout_seconds: integer('TIMEOUT', 60),
    queue_wait_seconds: integer('QUEUE_TTL', 600),
    result_ttl_seconds: integer('RESULT_TTL', 1800),
    capture_seconds: integer('CAPTURE_SECONDS', 120),
  }};
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Fault('invalid_request');
  return value.toLowerCase();
}
const extensions: Record<string, string> = {
  'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
export function media(value: string): string {
  // Ordinary MIME parameters, never CR/LF, quoted escapes or multipart headers.
  if (!/^[a-z]+\/[a-z0-9-]+(?:\s*;\s*[a-z0-9_-]+=(?:[a-z0-9_.+-]+|"[a-z0-9_.+ -]+"))*\s*$/i.test(value))
    throw new Fault('unsupported_audio');
  const base = value.split(';')[0].trim().toLowerCase();
  if (!extensions[base]) throw new Fault('unsupported_audio');
  return base;
}
export interface Owner {principal: string; client: string}
export interface Admission extends Owner {request: string; session: string; created: number; mime: string}
export function admission(value: Admission): Admission {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(value.session) || !Number.isFinite(value.created))
    throw new Fault('invalid_request');
  return {...value, client: uuid(value.client), request: uuid(value.request), mime: media(value.mime)};
}
export type State = 'queued' | 'processing' | 'ready' | 'error' | 'cancelled' | 'settled';
export type SettlementOutcome = 'submitted' | 'discarded' | 'inserted';
export interface Job {
  job_id: string;
  request_id: string;
  session: string;
  created: number;
  state: State;
  text: string | null;
  error: {code: Code; message: string} | null;
  outcome: SettlementOutcome | null;
}
interface RecordEntry {
  meta: Admission;
  job: Job;
  preparation: string;
  phase: 'receiving' | 'prepared' | 'committed';
  chunks: Buffer[];
  bytes: number;
  deadline: number;
  expires: number | null;
  queuedAt: number;
  prepared: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  running: boolean;
}
export const PREPARATION_MS = 15000;
type Infer = (chunks: Buffer[], meta: Admission, signal: AbortSignal) => Promise<string>;
type IsLive = (meta: Admission, signal: AbortSignal) => Promise<boolean>;
interface Options {
  now?: () => number;
  infer?: Infer;
  isLive?: IsLive;
  principal?: string;
}
export class Dictation {
  readonly config: Config;
  private records = new Map<string, RecordEntry>();
  private requests = new Map<string, RecordEntry>();
  private slots = new Map<string, RecordEntry>();
  private queue: RecordEntry[] = [];
  private operations = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private bytes = 0;
  private active = 0;
  private closed = false;
  private now: () => number;
  private infer: Infer;
  private isLive: IsLive;
  private timer: NodeJS.Timeout;
  private principal: string | null;
  private revision = 0;

  constructor(config: Config, options: Options = {}) {
    this.config = config;
    this.principal = options.principal ?? null;
    this.now = options.now ?? (() => performance.now());
    this.infer = options.infer ?? ((chunks, m, signal) => transcribe(config, chunks, m, signal));
    this.isLive = options.isLive ?? (async () => true);
    this.timer = setInterval(() => this.sweep(), 100);
    this.timer.unref();
  }
  authorize(principal: string) {
    if (this.principal !== null && principal !== this.principal) throw new Fault('not_found');
  }
  activate(principal: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Fault('invalid_request');
    if (revision === this.revision && principal === this.principal) return;
    if (revision <= this.revision) throw new Fault('not_found');
    this.principal = principal;
    this.revision = revision;
    // Detach revoked records, not their in-flight operations: running audio and
    // upstream occupancy remain owned until the actual inference finishes.
    for (const r of this.records.values()) if (r.meta.principal !== principal) {
      this.terminal(r, 'cancelled', true);
      this.remove(r);
    }
  }
  private key(m: Owner, request: string) { return JSON.stringify([m.principal, uuid(m.client), uuid(request)]); }
  private slot(m: Admission) { return JSON.stringify([m.session, m.created]); }
  private snapshot(r: RecordEntry): Job { return {...r.job, error: r.job.error ? {...r.job.error} : null}; }
  private owned(m: Owner, id: string): RecordEntry {
    this.authorize(m.principal);
    this.sweep();
    const r = this.records.get(uuid(id));
    if (!r || r.meta.principal !== m.principal || r.meta.client !== uuid(m.client)) throw new Fault('not_found');
    return r;
  }
  read(m: Owner, id: string) { return this.snapshot(this.owned(m, id)); }
  lookup(m: Owner, request: string) {
    this.authorize(m.principal);
    this.sweep();
    const r = this.requests.get(this.key(m, request));
    if (!r || r.phase !== 'committed') throw new Fault('not_found');
    return this.snapshot(r);
  }
  private checkPreparation(r: RecordEntry) {
    this.authorize(r.meta.principal);
    const expired = r.expires !== null ? this.now() >= r.expires :
      r.phase !== 'committed' && this.now() >= r.deadline;
    if (this.closed || this.records.get(r.job.job_id) !== r || expired) throw new Fault('unavailable');
  }
  async prepare(input: Admission, source: AsyncIterable<Buffer>): Promise<{job: Job; preparation: string}> {
    this.authorize(input.principal);
    if (this.closed) throw new Fault('unavailable');
    this.sweep();
    const m = admission(input), existing = this.requests.get(this.key(m, m.request));
    if (existing) {
      if (existing.meta.session !== m.session || existing.meta.created !== m.created)
        throw new Fault('request_conflict');
      await existing.prepared;
      this.checkPreparation(existing);
      return {job: this.snapshot(existing), preparation: existing.preparation};
    }
    const r = this.reserve(m);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const received = await Promise.race([
        this.receiveAudio(r, source),
        new Promise<never>((_, no) => {
          timeout = setTimeout(() => no(new Fault('unavailable')), PREPARATION_MS);
        }),
      ]);
      this.checkPreparation(r);
      if (!received && r.job.state === 'queued') throw new Fault('invalid_request');
      if (r.phase === 'receiving') r.phase = 'prepared';
      r.resolve();
      return {job: this.snapshot(r), preparation: r.preparation};
    } catch (error) {
      if (r.expires === null) { this.remove(r); r.reject(error); }
      else r.resolve();
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async verifyPreparedSession(session: Admission): Promise<void> {
    const live = await this.isLive(session);
    // A revocation can arrive while the inventory is being read.
    this.authorize(session.principal);
    if (!live) throw new Fault('stale_session');
  }

  private reserve(m: Admission): RecordEntry {
    if (this.slots.has(this.slot(m))) throw new Fault('session_busy');
    if (this.records.size >= 256) throw new Fault('capacity_full');
    const waiting = [...this.records.values()].filter(r => r.job.state === 'queued').length;
    if (waiting + this.active >= this.config.public.queue_size + this.config.public.workers)
      throw new Fault('queue_full');
    let resolve!: () => void, reject!: (error: unknown) => void;
    const prepared = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    void prepared.catch(() => {});
    const r: RecordEntry = {
      meta: m,
      job: {
        job_id: randomUUID(), request_id: m.request, session: m.session, created: m.created,
        state: 'queued', text: null, error: null, outcome: null,
      },
      preparation: randomUUID(), phase: 'receiving', chunks: [], bytes: 0,
      deadline: this.now() + PREPARATION_MS, expires: null, queuedAt: 0,
      prepared, resolve, reject, running: false,
    };
    this.records.set(r.job.job_id, r);
    this.requests.set(this.key(m, m.request), r);
    this.slots.set(this.slot(m), r);
    return r;
  }
  private async receiveAudio(r: RecordEntry, source: AsyncIterable<Buffer>): Promise<number> {
    let received = 0;
    for await (const chunk of source) {
      if (this.closed || !this.records.has(r.job.job_id) || this.now() >= r.deadline) throw new Fault('unavailable');
      received += chunk.length;
      if (received > this.config.public.max_bytes) throw new Fault('audio_too_large');
      if (r.job.state !== 'queued') continue;
      if (this.bytes + chunk.length > this.config.public.aggregate_bytes) throw new Fault('capacity_full');
      this.bytes += chunk.length;
      r.bytes += chunk.length;
      r.chunks.push(chunk);
    }
    return received;
  }
  commit(m: Owner, id: string, preparation: string): Job {
    const r = this.owned(m, id);
    if (r.preparation !== preparation) throw new Fault('not_found');
    if (r.phase === 'receiving') {
      if (!['cancelled', 'settled'].includes(r.job.state)) throw new Fault('invalid_state');
      r.phase = 'committed';
    }
    if (r.phase === 'prepared') {
      r.phase = 'committed';
      if (r.job.state === 'queued') {
        r.queuedAt = this.now();
        this.queue.push(r);
        this.pump();
      }
    }
    return this.snapshot(r);
  }
  abort(m: Owner, id: string, preparation: string) {
    const r = this.owned(m, id);
    if (r.preparation !== preparation) throw new Fault('not_found');
    if (r.phase !== 'committed' && r.expires === null) this.remove(r);
  }
  cancel(m: Owner, id: string): Job {
    const r = this.owned(m, id);
    if (!['cancelled', 'settled'].includes(r.job.state)) this.terminal(r, 'cancelled', true);
    return this.snapshot(r);
  }
  settle(m: Owner, id: string, outcome: SettlementOutcome): Job {
    const r = this.owned(m, id);
    if (!['submitted', 'discarded', 'inserted'].includes(outcome)) throw new Fault('invalid_request');
    if (r.job.state === 'settled') {
      if (r.job.outcome !== outcome) throw new Fault('invalid_state');
      return this.snapshot(r);
    }
    if ((outcome === 'submitted' || outcome === 'inserted') && r.job.state !== 'ready')
      throw new Fault('invalid_state');
    this.terminal(r, 'settled', true);
    r.job.outcome = outcome;
    return this.snapshot(r);
  }
  private releaseAudio(r: RecordEntry) {
    this.bytes -= r.bytes;
    r.bytes = 0;
    r.chunks = [];
  }
  private releaseSlot(r: RecordEntry) {
    if (this.slots.get(this.slot(r.meta)) === r) this.slots.delete(this.slot(r.meta));
  }
  private terminal(r: RecordEntry, state: State, release = false, error?: Code) {
    r.job.state = state;
    r.job.text = null;
    r.job.error = error ? {code: error, message: messages[error]} : null;
    r.job.outcome = null;
    r.expires = this.now() + this.config.public.result_ttl_seconds * 1000;
    if (release) r.resolve();
    this.queue = this.queue.filter(item => item !== r);
    if (!r.running) this.releaseAudio(r);
    if (release) this.releaseSlot(r);
  }
  private remove(r: RecordEntry) {
    const key = this.key(r.meta, r.meta.request);
    this.records.delete(r.job.job_id);
    if (this.requests.get(key) === r) this.requests.delete(key);
    this.releaseSlot(r);
    this.queue = this.queue.filter(item => item !== r);
    if (!r.running) this.releaseAudio(r);
  }
  sweep() {
    const now = this.now();
    for (const r of this.records.values()) {
      if (r.expires !== null && now >= r.expires) this.remove(r);
      else if (r.expires === null && r.phase !== 'committed' && now >= r.deadline) {
        this.remove(r);
        r.reject(new Fault('unavailable'));
      } else if (r.phase === 'committed' && r.job.state === 'queued' &&
                 now - r.queuedAt >= this.config.public.queue_wait_seconds * 1000) {
        this.terminal(r, 'error', false, 'queue_expired');
      }
    }
    this.pump();
  }
  private pump() {
    while (!this.closed && this.active < this.config.public.workers && this.queue.length) {
      const r = this.queue.shift()!;
      if (r.job.state !== 'queued') continue;
      if (this.now() - r.queuedAt >= this.config.public.queue_wait_seconds * 1000) {
        this.terminal(r, 'error', false, 'queue_expired');
        continue;
      }
      this.active++;
      r.running = true;
      r.job.state = 'processing';
      const operation = this.run(r);
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation));
    }
  }
  private async run(r: RecordEntry) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!await this.isLive(r.meta, controller.signal)) throw new Fault('stale_session');
      if (this.closed || r.job.state !== 'processing') return;
      const deadline = this.now() + this.config.public.active_timeout_seconds * 1000;
      const expire = () => {
        const remaining = deadline - this.now();
        if (remaining <= 0) controller.abort(new Fault('upstream_timeout'));
        else timer = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      expire();
      const text = normalizeText(await this.infer(r.chunks, r.meta, controller.signal));
      if (r.job.state === 'processing') {
        this.terminal(r, 'ready');
        r.job.text = text;
      }
    } catch (error) {
      if (r.job.state === 'processing') {
        const code = controller.signal.aborted && !this.closed ? 'upstream_timeout' :
          error instanceof Fault ? error.code : 'upstream_unavailable';
        this.terminal(r, 'error', false, code);
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      r.running = false;
      this.releaseAudio(r);
      this.active--;
      this.pump();
    }
  }
  stats() { return {records: this.records.size, bytes: this.bytes, active: this.active, waiting: this.queue.length}; }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.controllers) c.abort();
    for (const r of this.records.values()) {
      r.reject(new Fault('unavailable'));
      if (!r.running) this.releaseAudio(r);
    }
    await Promise.allSettled([...this.operations]);
    this.records.clear();
    this.requests.clear();
    this.slots.clear();
    this.queue = [];
  }
}
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') throw new Fault('upstream_invalid');
  const normalized = value.replace(/\r\n?/g, '\n');
  if (hasDictationControls(normalized)) throw new Fault('upstream_invalid');
  const text = normalized.trim();
  if (Buffer.byteLength(text) > 32768) throw new Fault('upstream_invalid');
  if (!text) throw new Fault('empty_transcript');
  return text;
}

function multipartPrefix(config: Config, boundary: string, mime: string): Buffer {
  const fields = [
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
  ];
  if (config.public.language !== null) fields.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${config.public.language}\r\n`,
  );
  fields.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${extensions[mime]}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`);
  return Buffer.from(fields.join(''));
}

async function transcriptResponse(res: IncomingMessage): Promise<string> {
  if (res.statusCode !== 200) throw new Fault('upstream_unavailable');
  if (res.headers['content-encoding']) throw new Fault('upstream_invalid');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of res) {
    size += part.length;
    if (size > 65536) throw new Fault('upstream_invalid');
    parts.push(part);
  }
  const body = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts));
  const contentType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') {
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new Fault('upstream_invalid'); }
    return normalizeText(parsed?.text);
  }
  if (contentType === 'text/plain') return normalizeText(body);
  throw new Fault('upstream_invalid');
}

export async function transcribe(config: Config, chunks: Buffer[], m: Admission, signal: AbortSignal): Promise<string> {
  const boundary = `mesh-${randomUUID()}`, mime = media(m.mime);
  const prefix = multipartPrefix(config, boundary, mime);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const transport = config.url.protocol === 'https:' ? https : http;
  const connection = config.url.protocol === 'http:' ? {lookup: loopbackLookup, autoSelectFamily: true} : {};
  const failure = () => signal.aborted && signal.reason instanceof Fault ?
    signal.reason : new Fault('upstream_unavailable');
  try {
    return await new Promise<string>((resolve, reject) => {
      let upload: Promise<void>;
      const req = transport.request(config.url, {
        ...connection, method: 'POST', agent: false, signal,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': prefix.length + suffix.length + chunks.reduce((sum, b) => sum + b.length, 0),
        },
      }, res => {
        void (async () => {
          try {
            const text = await transcriptResponse(res);
            // An early upstream response does not release the local HTTP slot
            // while its audio upload is still backpressured or unwinding.
            await upload;
            resolve(text);
          } catch (error) {
            res.destroy();
            req.destroy();
            reject(error instanceof Fault ? error : new Fault('upstream_invalid'));
          }
        })();
      });
      req.on('error', () => reject(failure()));
      req.once('upgrade', (_response, socket) => {
        socket.destroy();
        reject(failure());
      });
      upload = pipeline(Readable.from([prefix, ...chunks, suffix]), req);
      void upload.catch(() => reject(failure()));
    });
  } catch (error) { throw error instanceof Fault ? error : new Fault('upstream_unavailable'); }
}
