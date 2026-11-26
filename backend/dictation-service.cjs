// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// backend/dictation.ts
var import_node_crypto = require("node:crypto");
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));
var import_node_net = require("node:net");
var import_node_dns = __toESM(require("node:dns"));
var import_node_stream = require("node:stream");
var import_promises = require("node:stream/promises");

// shared/dictation-text.ts
function hasDictationControls(text) {
  return /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text);
}

// backend/dictation.ts
var messages = {
  invalid_request: "Invalid dictation request.",
  not_found: "Dictation job not found.",
  session_busy: "This session already has outstanding dictation.",
  stale_session: "The session is no longer live.",
  request_conflict: "The request belongs to another session.",
  invalid_state: "Invalid dictation transition.",
  audio_too_large: "Audio exceeds the configured limit.",
  unsupported_audio: "Unsupported audio format.",
  queue_full: "The dictation queue is full.",
  capacity_full: "Dictation capacity is full.",
  disabled: "Dictation is disabled.",
  unavailable: "Dictation is unavailable.",
  queue_expired: "The dictation queue wait expired.",
  upstream_timeout: "Transcription timed out.",
  upstream_unavailable: "Transcription service unavailable.",
  upstream_invalid: "Invalid transcription response.",
  empty_transcript: "No speech was transcribed."
};
var statuses = {
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
  unavailable: 503
};
var Fault = class extends Error {
  status;
  code;
  constructor(code) {
    super(messages[code]);
    this.code = code;
    this.status = statuses[code] ?? 400;
  }
  json() {
    return { error: { code: this.code, message: this.message } };
  }
};
function loopbackAddress(address) {
  return address === "::1" || (0, import_node_net.isIP)(address) === 4 && address.split(".")[0] === "127";
}
var loopbackLookup = (hostname, options, callback) => {
  import_node_dns.default.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const local = addresses.filter((item) => loopbackAddress(item.address));
    if (!local.length) {
      callback(new Fault("upstream_unavailable"), "");
      return;
    }
    if (options.all) callback(null, local);
    else callback(null, local[0].address, local[0].family);
  });
};
function configuration(env) {
  if (!env.MESH_WHISPER_URL) return null;
  const url = new URL(env.MESH_WHISPER_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || env.MESH_WHISPER_URL.includes("#")) throw Error("Invalid Whisper URL");
  const host = url.hostname;
  const loopback = host === "localhost" || host === "localhost." || host === "[::1]" || loopbackAddress(host);
  if (url.protocol === "http:" && !loopback) throw Error("Remote Whisper URL requires HTTPS");
  const integer = (key, fallback) => {
    const value = env[`MESH_WHISPER_${key}`];
    if (value === void 0) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
      throw Error(`Invalid Whisper ${key}`);
    return Number(value);
  };
  const language = env.MESH_WHISPER_LANGUAGE ?? null;
  if (language !== null && !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(language)) throw Error("Invalid Whisper language");
  return { url, public: {
    enabled: true,
    language,
    max_bytes: integer("MAX_BYTES", 8388608),
    aggregate_bytes: integer("AGGREGATE_BYTES", 67108864),
    queue_size: integer("QUEUE_SIZE", 16),
    workers: integer("WORKERS", 1),
    active_timeout_seconds: integer("TIMEOUT", 60),
    queue_wait_seconds: integer("QUEUE_TTL", 600),
    result_ttl_seconds: integer("RESULT_TTL", 1800),
    capture_seconds: integer("CAPTURE_SECONDS", 120)
  } };
}
function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Fault("invalid_request");
  return value.toLowerCase();
}
var extensions = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav"
};
function media(value) {
  if (!/^[a-z]+\/[a-z0-9-]+(?:\s*;\s*[a-z0-9_-]+=(?:[a-z0-9_.+-]+|"[a-z0-9_.+ -]+"))*\s*$/i.test(value))
    throw new Fault("unsupported_audio");
  const base = value.split(";")[0].trim().toLowerCase();
  if (!extensions[base]) throw new Fault("unsupported_audio");
  return base;
}
function admission(value) {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(value.session) || !Number.isFinite(value.created))
    throw new Fault("invalid_request");
  return { ...value, client: uuid(value.client), request: uuid(value.request), mime: media(value.mime) };
}
var PREPARATION_MS = 15e3;
var Dictation = class {
  config;
  records = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  slots = /* @__PURE__ */ new Map();
  queue = [];
  operations = /* @__PURE__ */ new Set();
  controllers = /* @__PURE__ */ new Set();
  bytes = 0;
  active = 0;
  closed = false;
  now;
  infer;
  isLive;
  timer;
  principal;
  revision = 0;
  constructor(config, options = {}) {
    this.config = config;
    this.principal = options.principal ?? null;
    this.now = options.now ?? (() => performance.now());
    this.infer = options.infer ?? ((chunks, m, signal) => transcribe(config, chunks, m, signal));
    this.isLive = options.isLive ?? (async () => true);
    this.timer = setInterval(() => this.sweep(), 100);
    this.timer.unref();
  }
  authorize(principal) {
    if (this.principal !== null && principal !== this.principal) throw new Fault("not_found");
  }
  activate(principal, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Fault("invalid_request");
    if (revision === this.revision && principal === this.principal) return;
    if (revision <= this.revision) throw new Fault("not_found");
    this.principal = principal;
    this.revision = revision;
    for (const r of this.records.values()) if (r.meta.principal !== principal) {
      this.terminal(r, "cancelled", true);
      this.remove(r);
    }
  }
  key(m, request) {
    return JSON.stringify([m.principal, uuid(m.client), uuid(request)]);
  }
  slot(m) {
    return JSON.stringify([m.session, m.created]);
  }
  snapshot(r) {
    return { ...r.job, error: r.job.error ? { ...r.job.error } : null };
  }
  owned(m, id) {
    this.authorize(m.principal);
    this.sweep();
    const r = this.records.get(uuid(id));
    if (!r || r.meta.principal !== m.principal || r.meta.client !== uuid(m.client)) throw new Fault("not_found");
    return r;
  }
  read(m, id) {
    return this.snapshot(this.owned(m, id));
  }
  lookup(m, request) {
    this.authorize(m.principal);
    this.sweep();
    const r = this.requests.get(this.key(m, request));
    if (!r || r.phase !== "committed") throw new Fault("not_found");
    return this.snapshot(r);
  }
  checkPreparation(r) {
    this.authorize(r.meta.principal);
    const expired = r.expires !== null ? this.now() >= r.expires : r.phase !== "committed" && this.now() >= r.deadline;
    if (this.closed || this.records.get(r.job.job_id) !== r || expired) throw new Fault("unavailable");
  }
  async prepare(input, source, verify) {
    this.authorize(input.principal);
    if (this.closed) throw new Fault("unavailable");
    this.sweep();
    const m = admission(input), existing = this.requests.get(this.key(m, m.request));
    if (existing) {
      if (existing.meta.session !== m.session || existing.meta.created !== m.created)
        throw new Fault("request_conflict");
      await existing.prepared;
      if (verify) await verify(existing.meta);
      this.checkPreparation(existing);
      return { job: this.snapshot(existing), preparation: existing.preparation };
    }
    const r = this.reserve(m);
    let timeout;
    try {
      const received = await Promise.race([
        this.receiveAudio(r, source),
        new Promise((_, no) => {
          timeout = setTimeout(() => no(new Fault("unavailable")), PREPARATION_MS);
        })
      ]);
      this.checkPreparation(r);
      if (!received && r.job.state === "queued") throw new Fault("invalid_request");
      if (verify) {
        await verify(m);
        this.checkPreparation(r);
      }
      if (r.phase === "receiving") r.phase = "prepared";
      r.resolve();
      return { job: this.snapshot(r), preparation: r.preparation };
    } catch (error) {
      if (r.expires === null) {
        this.remove(r);
        r.reject(error);
      } else r.resolve();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  async verifySession(session) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let live;
    try {
      live = await this.isLive(session, controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
    this.authorize(session.principal);
    if (!live) throw new Fault("stale_session");
  }
  reserve(m) {
    if (this.slots.has(this.slot(m))) throw new Fault("session_busy");
    if (this.records.size >= 256) throw new Fault("capacity_full");
    const waiting = [...this.records.values()].filter((r2) => r2.job.state === "queued").length;
    if (waiting + this.active >= this.config.public.queue_size + this.config.public.workers)
      throw new Fault("queue_full");
    let resolve, reject;
    const prepared = new Promise((ok, no) => {
      resolve = ok;
      reject = no;
    });
    void prepared.catch(() => {
    });
    const r = {
      meta: m,
      job: {
        job_id: (0, import_node_crypto.randomUUID)(),
        request_id: m.request,
        session: m.session,
        created: m.created,
        state: "queued",
        text: null,
        error: null,
        outcome: null
      },
      preparation: (0, import_node_crypto.randomUUID)(),
      phase: "receiving",
      chunks: [],
      bytes: 0,
      deadline: this.now() + PREPARATION_MS,
      expires: null,
      queuedAt: 0,
      prepared,
      resolve,
      reject,
      running: false
    };
    this.records.set(r.job.job_id, r);
    this.requests.set(this.key(m, m.request), r);
    this.slots.set(this.slot(m), r);
    return r;
  }
  async receiveAudio(r, source) {
    let received = 0;
    for await (const chunk of source) {
      if (this.closed || !this.records.has(r.job.job_id) || this.now() >= r.deadline) throw new Fault("unavailable");
      received += chunk.length;
      if (received > this.config.public.max_bytes) throw new Fault("audio_too_large");
      if (r.job.state !== "queued") continue;
      if (this.bytes + chunk.length > this.config.public.aggregate_bytes) throw new Fault("capacity_full");
      this.bytes += chunk.length;
      r.bytes += chunk.length;
      r.chunks.push(chunk);
    }
    return received;
  }
  commit(m, id, preparation) {
    const r = this.owned(m, id);
    if (r.preparation !== preparation) throw new Fault("not_found");
    if (r.phase === "receiving") {
      if (!["cancelled", "settled"].includes(r.job.state)) throw new Fault("invalid_state");
      r.phase = "committed";
    }
    if (r.phase === "prepared") {
      r.phase = "committed";
      if (r.job.state === "queued") {
        r.queuedAt = this.now();
        this.queue.push(r);
        this.pump();
      }
    }
    return this.snapshot(r);
  }
  abort(m, id, preparation) {
    const r = this.owned(m, id);
    if (r.preparation !== preparation) throw new Fault("not_found");
    if (r.phase !== "committed" && r.expires === null) this.remove(r);
  }
  cancel(m, id) {
    const r = this.owned(m, id);
    if (!["cancelled", "settled"].includes(r.job.state)) this.terminal(r, "cancelled", true);
    return this.snapshot(r);
  }
  settle(m, id, outcome) {
    const r = this.owned(m, id);
    if (!["submitted", "discarded", "inserted"].includes(outcome)) throw new Fault("invalid_request");
    if (r.job.state === "settled") {
      if (r.job.outcome !== outcome) throw new Fault("invalid_state");
      return this.snapshot(r);
    }
    if ((outcome === "submitted" || outcome === "inserted") && r.job.state !== "ready")
      throw new Fault("invalid_state");
    this.terminal(r, "settled", true);
    r.job.outcome = outcome;
    return this.snapshot(r);
  }
  releaseAudio(r) {
    this.bytes -= r.bytes;
    r.bytes = 0;
    r.chunks = [];
  }
  releaseSlot(r) {
    if (this.slots.get(this.slot(r.meta)) === r) this.slots.delete(this.slot(r.meta));
  }
  terminal(r, state, release = false, error) {
    r.job.state = state;
    r.job.text = null;
    r.job.error = error ? { code: error, message: messages[error] } : null;
    r.job.outcome = null;
    r.expires = this.now() + this.config.public.result_ttl_seconds * 1e3;
    if (release) r.resolve();
    this.queue = this.queue.filter((item) => item !== r);
    if (!r.running) this.releaseAudio(r);
    if (release) this.releaseSlot(r);
  }
  remove(r) {
    const key = this.key(r.meta, r.meta.request);
    this.records.delete(r.job.job_id);
    if (this.requests.get(key) === r) this.requests.delete(key);
    this.releaseSlot(r);
    this.queue = this.queue.filter((item) => item !== r);
    if (!r.running) this.releaseAudio(r);
  }
  sweep() {
    const now = this.now();
    for (const r of this.records.values()) {
      if (r.expires !== null && now >= r.expires) this.remove(r);
      else if (r.expires === null && r.phase !== "committed" && now >= r.deadline) {
        this.remove(r);
        r.reject(new Fault("unavailable"));
      } else if (r.phase === "committed" && r.job.state === "queued" && now - r.queuedAt >= this.config.public.queue_wait_seconds * 1e3) {
        this.terminal(r, "error", false, "queue_expired");
      }
    }
    this.pump();
  }
  pump() {
    while (!this.closed && this.active < this.config.public.workers && this.queue.length) {
      const r = this.queue.shift();
      if (r.job.state !== "queued") continue;
      if (this.now() - r.queuedAt >= this.config.public.queue_wait_seconds * 1e3) {
        this.terminal(r, "error", false, "queue_expired");
        continue;
      }
      this.active++;
      r.running = true;
      r.job.state = "processing";
      const operation = this.run(r);
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation));
    }
  }
  async run(r) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer;
    try {
      if (!await this.isLive(r.meta, controller.signal)) throw new Fault("stale_session");
      if (this.closed || r.job.state !== "processing") return;
      const deadline = this.now() + this.config.public.active_timeout_seconds * 1e3;
      const expire = () => {
        const remaining = deadline - this.now();
        if (remaining <= 0) controller.abort(new Fault("upstream_timeout"));
        else timer = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      expire();
      const text = normalizeText(await this.infer(r.chunks, r.meta, controller.signal));
      if (r.job.state === "processing") {
        this.terminal(r, "ready");
        r.job.text = text;
      }
    } catch (error) {
      if (r.job.state === "processing") {
        const code = controller.signal.aborted && !this.closed ? "upstream_timeout" : error instanceof Fault ? error.code : "upstream_unavailable";
        this.terminal(r, "error", false, code);
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
  stats() {
    return { records: this.records.size, bytes: this.bytes, active: this.active, waiting: this.queue.length };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.controllers) c.abort();
    for (const r of this.records.values()) {
      r.reject(new Fault("unavailable"));
      if (!r.running) this.releaseAudio(r);
    }
    await Promise.allSettled([...this.operations]);
    this.records.clear();
    this.requests.clear();
    this.slots.clear();
    this.queue = [];
  }
};
function normalizeText(value) {
  if (typeof value !== "string") throw new Fault("upstream_invalid");
  const normalized = value.replace(/\r\n?/g, "\n");
  if (hasDictationControls(normalized)) throw new Fault("upstream_invalid");
  const text = normalized.trim();
  if (Buffer.byteLength(text) > 32768) throw new Fault("upstream_invalid");
  if (!text) throw new Fault("empty_transcript");
  return text;
}
function multipartPrefix(config, boundary, mime) {
  const fields = [
    `--${boundary}\r
Content-Disposition: form-data; name="response_format"\r
\r
json\r
`
  ];
  if (config.public.language !== null) fields.push(
    `--${boundary}\r
Content-Disposition: form-data; name="language"\r
\r
${config.public.language}\r
`
  );
  fields.push(`--${boundary}\r
Content-Disposition: form-data; name="file"; filename="audio.${extensions[mime]}"\r
Content-Type: ${mime}\r
\r
`);
  return Buffer.from(fields.join(""));
}
async function transcriptResponse(res) {
  if (res.statusCode !== 200) throw new Fault("upstream_unavailable");
  if (res.headers["content-encoding"]) throw new Fault("upstream_invalid");
  const parts = [];
  let size = 0;
  for await (const part of res) {
    size += part.length;
    if (size > 65536) throw new Fault("upstream_invalid");
    parts.push(part);
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType === "application/json") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Fault("upstream_invalid");
    }
    return normalizeText(parsed?.text);
  }
  if (contentType === "text/plain") return normalizeText(body);
  throw new Fault("upstream_invalid");
}
async function transcribe(config, chunks, m, signal) {
  const boundary = `mesh-${(0, import_node_crypto.randomUUID)()}`, mime = media(m.mime);
  const prefix = multipartPrefix(config, boundary, mime);
  const suffix = Buffer.from(`\r
--${boundary}--\r
`);
  const transport = config.url.protocol === "https:" ? import_node_https.default : import_node_http.default;
  const connection = config.url.protocol === "http:" ? { lookup: loopbackLookup, autoSelectFamily: true } : {};
  const failure = () => signal.aborted && signal.reason instanceof Fault ? signal.reason : new Fault("upstream_unavailable");
  try {
    return await new Promise((resolve, reject) => {
      let upload;
      const req = transport.request(config.url, {
        ...connection,
        method: "POST",
        agent: false,
        signal,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": prefix.length + suffix.length + chunks.reduce((sum, b) => sum + b.length, 0)
        }
      }, (res) => {
        void (async () => {
          try {
            const text = await transcriptResponse(res);
            await upload;
            resolve(text);
          } catch (error) {
            res.destroy();
            req.destroy();
            reject(error instanceof Fault ? error : new Fault("upstream_invalid"));
          }
        })();
      });
      req.on("error", () => reject(failure()));
      req.once("upgrade", (_response, socket) => {
        socket.destroy();
        reject(failure());
      });
      upload = (0, import_promises.pipeline)(import_node_stream.Readable.from([prefix, ...chunks, suffix]), req);
      void upload.catch(() => reject(failure()));
    });
  } catch (error) {
    throw error instanceof Fault ? error : new Fault("upstream_unavailable");
  }
}

// backend/dictation-service.ts
var import_node_http2 = require("node:http");
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path = require("node:path");
var import_node_net2 = require("node:net");
function single(req, name, optional = false) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[i + 1]);
  }
  if (values.length === 0 && optional) return "";
  if (values.length !== 1) throw new Fault("invalid_request");
  return values[0];
}
function owner(req) {
  const principal = single(req, "X-Mesh-Principal");
  if (!/^[a-f0-9]{64}$/.test(principal)) throw new Fault("invalid_request");
  return { principal, client: uuid(single(req, "X-Mesh-Dictation-Client")) };
}
function metadata(req) {
  const created = single(req, "X-Mesh-Created");
  if (!created.trim()) throw new Fault("invalid_request");
  return admission({
    ...owner(req),
    session: single(req, "X-Mesh-Session"),
    created: Number(created),
    request: single(req, "X-Mesh-Request-Id"),
    mime: single(req, "Content-Type")
  });
}
async function object(req) {
  if (single(req, "Content-Type").split(";")[0].trim() !== "application/json") throw new Fault("invalid_request");
  let size = 0;
  const parts = [];
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 1024) throw new Fault("invalid_request");
    parts.push(part);
  }
  try {
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error();
    return result;
  } catch {
    throw new Fault("invalid_request");
  }
}
async function empty(req) {
  for await (const part of req.iterator({ destroyOnReturn: false })) if (part.length) throw new Fault("invalid_request");
}
function validInventoryItem(value) {
  if (!value || typeof value !== "object") return false;
  const item = value;
  return typeof item.name === "string" && item.name.length > 0 && typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0 && typeof item.cwd === "string" && typeof item.created === "number" && Number.isFinite(item.created) && typeof item.activity === "number" && Number.isFinite(item.activity) && typeof item.attached === "number" && Number.isInteger(item.attached) && item.attached >= 0 && !!item.meta && typeof item.meta === "object" && !Array.isArray(item.meta);
}
async function liveInventory(socketPath, m, signal) {
  if (signal?.aborted) throw new Fault("unavailable");
  return await new Promise((resolve, reject) => {
    const socket = (0, import_node_net2.connect)(socketPath);
    let data = Buffer.alloc(0), done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (value === void 0) reject(new Fault("unavailable"));
      else resolve(value);
    };
    const deadline = setTimeout(() => finish(), 1e3);
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish());
    socket.on("end", () => finish());
    socket.on("connect", () => {
      const body = Buffer.from('{"op":"list"}'), head = Buffer.alloc(5);
      head[0] = 67;
      head.writeUInt32BE(body.length, 1);
      socket.end(Buffer.concat([head, body]));
    });
    socket.on("data", (chunk) => {
      if (data.length + chunk.length > 1048581) return finish();
      data = Buffer.concat([data, chunk]);
      if (data.length < 5) return;
      if (data[0] !== 67) return finish();
      const size = data.readUInt32BE(1);
      if (size > 1048576) return finish();
      if (data.length < size + 5) return;
      try {
        const list = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(5, 5 + size)));
        if (!Array.isArray(list) || !list.every(validInventoryItem)) return finish();
        finish(list.some((item) => item.name === m.session && item.created === m.created));
      } catch {
        finish();
      }
    });
  });
}
async function dispatch(req, config, engine, send) {
  const path = req.url ?? "";
  if (/[?#%\\]/.test(path) || req.headers["content-encoding"] !== void 0) throw new Fault("invalid_request");
  for (const name of ["X-Mesh-Dictation-Client", "X-Mesh-Session", "X-Mesh-Created", "X-Mesh-Request-Id"])
    single(req, name, true);
  const principal = single(req, "X-Mesh-Principal");
  if (!/^[a-f0-9]{64}$/.test(principal)) throw new Fault("invalid_request");
  if (req.method === "POST" && path === "/internal/principal") {
    const body = await object(req);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "revision")) throw new Fault("invalid_request");
    engine.activate(principal, body.revision);
    send(200, {});
    return;
  }
  if (req.method === "GET") await empty(req);
  engine.authorize(principal);
  if (req.method === "GET" && path === "/api/transcribe/config") {
    send(200, config.public);
    return;
  }
  if (req.method === "POST" && path === "/internal/admission") {
    await empty(req);
    await engine.verifySession(metadata(req));
    send(200, {});
    return;
  }
  if (req.method === "POST" && path === "/api/transcribe") {
    const admission2 = metadata(req);
    const result = await engine.prepare(
      admission2,
      req.iterator({ destroyOnReturn: false }),
      (current) => engine.verifySession(current)
    );
    send(202, result);
    return;
  }
  await dispatchJob(req, path, engine, send);
}
async function dispatchJob(req, path, engine, send) {
  const m = owner(req);
  const lookup = /^\/api\/transcribe\/request\/([^/]+)$/.exec(path);
  if (req.method === "GET" && lookup) {
    send(200, engine.lookup(m, uuid(lookup[1])));
    return;
  }
  const internal = /^\/internal\/(commit|abort)\/([^/]+)$/.exec(path);
  if (req.method === "POST" && internal) {
    const body = await object(req);
    if (Object.keys(body).length) throw new Fault("invalid_request");
    const preparation = uuid(single(req, "X-Mesh-Preparation"));
    if (internal[1] === "commit") send(200, engine.commit(m, uuid(internal[2]), preparation));
    else {
      engine.abort(m, uuid(internal[2]), preparation);
      send(200, {});
    }
    return;
  }
  const job = /^\/api\/transcribe\/([^/]+)(?:\/(cancel|settle))?$/.exec(path);
  if (!job) throw new Fault("not_found");
  const id = uuid(job[1]);
  if (req.method === "GET" && !job[2]) {
    send(200, engine.read(m, id));
    return;
  }
  if (req.method === "POST" && job[2]) {
    const body = await object(req), keys = Object.keys(body);
    if (job[2] === "cancel") {
      if (keys.length) throw new Fault("invalid_request");
      send(200, engine.cancel(m, id));
    } else {
      if (keys.length !== 1 || keys[0] !== "outcome" || !["submitted", "discarded", "inserted"].includes(body.outcome)) throw new Fault("invalid_request");
      send(200, engine.settle(m, id, body.outcome));
    }
    return;
  }
  throw new Fault("not_found");
}
var digest = (value) => (0, import_node_crypto2.createHash)("sha256").update(value).digest();
function serviceHandler(config, engine, expected) {
  let handlers = 0;
  return (req, res) => {
    const send = (status, body) => {
      if (res.destroyed) return;
      if (!req.complete) res.setHeader("Connection", "close");
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      let counted = false;
      try {
        if (!(0, import_node_crypto2.timingSafeEqual)(digest(single(req, "X-Mesh-Bridge")), expected)) {
          send(403, new Fault("not_found").json());
          return;
        }
        if (!(req.method === "POST" && req.url === "/internal/principal")) {
          if (handlers >= 32) throw new Fault("capacity_full");
          handlers++;
          counted = true;
        }
        await dispatch(req, config, engine, send);
      } catch (error) {
        const fault = error instanceof Fault ? error : new Fault("unavailable");
        send(fault.status, fault.json());
      } finally {
        if (counted) handlers--;
      }
    })();
  };
}
async function startService(config, secret, socketPath, inventorySocket, principal) {
  if (!/^[a-f0-9]{64}$/.test(principal)) throw Error("Initial principal required");
  const parent = await (0, import_promises2.lstat)((0, import_node_path.dirname)(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 511) !== 448 || parent.uid !== process.getuid())
    throw Error("Private dictation directory required");
  const engine = new Dictation(config, { principal, isLive: (m, signal) => liveInventory(inventorySocket, m, signal) });
  const server = (0, import_node_http2.createServer)(
    { maxHeaderSize: 8192, requestTimeout: 16e3, headersTimeout: 5e3 },
    serviceHandler(config, engine, digest(secret))
  );
  server.maxConnections = 64;
  server.keepAliveTimeout = 1e3;
  server.timeout = 16e3;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await (0, import_promises2.chmod)(socketPath, 384);
  return { engine, server, async close() {
    server.closeAllConnections();
    await engine.close();
    await new Promise((resolve) => server.close(() => resolve()));
  } };
}

// backend/dictation-main.ts
function parseBootstrap(line) {
  const value = JSON.parse(line);
  if (!value || typeof value.secret !== "string" || !/^[a-f0-9]{64}$/.test(value.secret) || typeof value.principal !== "string" || !/^[a-f0-9]{64}$/.test(value.principal) || typeof value.socket !== "string" || !value.socket.startsWith("/") || typeof value.inventory !== "string" || !value.inventory.startsWith("/") || value.parent !== process.ppid) {
    throw new Error("Bootstrap invalid");
  }
  return {
    secret: value.secret,
    socket: value.socket,
    inventory: value.inventory,
    parent: value.parent,
    principal: value.principal
  };
}
function readBootstrap() {
  return new Promise((resolve, reject) => {
    let input = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off("data", receive);
      process.stdin.off("end", closed);
    };
    const fail = (reason) => {
      cleanup();
      reject(new Error(reason));
    };
    const closed = () => fail("Bootstrap closed");
    const receive = (part) => {
      const newline = part.indexOf(10);
      const size = newline < 0 ? part.length : newline;
      if (input.length + size > 4096) {
        fail("Bootstrap limit");
        return;
      }
      input = Buffer.concat([input, part.subarray(0, size)]);
      if (newline < 0) return;
      cleanup();
      try {
        resolve(parseBootstrap(new TextDecoder("utf-8", { fatal: true }).decode(input)));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => fail("Bootstrap timeout"), 5e3);
    process.stdin.on("data", receive);
    process.stdin.once("end", closed);
  });
}
async function main() {
  let config;
  try {
    config = configuration(process.env);
  } catch {
    process.stdout.write("invalid_configuration\n");
    process.exitCode = 1;
    return;
  }
  if (!config) throw Error("Disabled worker");
  const bootstrap = await readBootstrap();
  const service = await startService(config, bootstrap.secret, bootstrap.socket, bootstrap.inventory, bootstrap.principal);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(parentWatch);
    await service.close();
    process.exit(0);
  };
  const parentWatch = setInterval(() => {
    if (process.ppid !== bootstrap.parent) void close();
  }, 250);
  process.stdin.on("end", () => void close());
  process.stdin.resume();
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  if (process.stdin.readableEnded || process.ppid !== bootstrap.parent) {
    await close();
    return;
  }
  process.stdout.write("ready\n");
}
void main().catch(() => {
  process.stderr.write("Dictation worker unavailable.\n");
  process.exit(1);
});
