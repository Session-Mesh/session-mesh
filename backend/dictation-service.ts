// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {chmod, lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {connect} from 'node:net';
import {
  type Admission, type Config, Dictation, Fault, type Owner, type SettlementOutcome, admission, uuid,
} from './dictation.ts';

export function single(req: IncomingMessage, name: string, optional = false): string {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[i + 1]);
  }
  if (values.length === 0 && optional) return '';
  if (values.length !== 1) throw new Fault('invalid_request');
  return values[0];
}
function owner(req: IncomingMessage): Owner {
  const principal = single(req, 'X-Mesh-Principal');
  if (!/^[a-f0-9]{64}$/.test(principal)) throw new Fault('invalid_request');
  return {principal, client: uuid(single(req, 'X-Mesh-Dictation-Client'))};
}
export function metadata(req: IncomingMessage): Admission {
  const created = single(req, 'X-Mesh-Created');
  if (!created.trim()) throw new Fault('invalid_request');
  return admission({
    ...owner(req), session: single(req, 'X-Mesh-Session'), created: Number(created),
    request: single(req, 'X-Mesh-Request-Id'), mime: single(req, 'Content-Type'),
  });
}
async function object(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (single(req, 'Content-Type').split(';')[0].trim() !== 'application/json') throw new Fault('invalid_request');
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req.iterator({destroyOnReturn: false})) {
    size += part.length;
    if (size > 1024) throw new Fault('invalid_request');
    parts.push(part);
  }
  try {
    const result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
    return result;
  } catch { throw new Fault('invalid_request'); }
}
async function empty(req: IncomingMessage) {
  for await (const part of req.iterator({destroyOnReturn: false})) if (part.length) throw new Fault('invalid_request');
}

function validInventoryItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && item.name.length > 0 &&
    typeof item.pid === 'number' && Number.isInteger(item.pid) && item.pid > 0 &&
    typeof item.cwd === 'string' &&
    typeof item.created === 'number' && Number.isFinite(item.created) &&
    typeof item.activity === 'number' && Number.isFinite(item.activity) &&
    typeof item.attached === 'number' && Number.isInteger(item.attached) && item.attached >= 0 &&
    !!item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta);
}

// Read only the existing local inventory protocol. Never attach or send input.
export async function liveInventory(socketPath: string, m: Admission, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new Fault('unavailable');
  return await new Promise<boolean>((resolve, reject) => {
    const socket = connect(socketPath);
    let data = Buffer.alloc(0), done = false;
    const finish = (value?: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (value === undefined) reject(new Fault('unavailable'));
      else resolve(value);
    };
    const deadline = setTimeout(() => finish(), 1000);
    const abort = () => finish();
    signal?.addEventListener('abort', abort, {once: true});
    socket.on('error', () => finish());
    socket.on('end', () => finish());
    socket.on('connect', () => {
      const body = Buffer.from('{"op":"list"}'), head = Buffer.alloc(5);
      head[0] = 67;
      head.writeUInt32BE(body.length, 1);
      socket.end(Buffer.concat([head, body]));
    });
    socket.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > 1048581) return finish();
      data = Buffer.concat([data, chunk]);
      if (data.length < 5) return;
      if (data[0] !== 67) return finish();
      const size = data.readUInt32BE(1);
      if (size > 1048576) return finish();
      if (data.length < size + 5) return;
      try {
        const list = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(5, 5 + size)));
        if (!Array.isArray(list) || !list.every(validInventoryItem)) return finish();
        finish(list.some(item => item.name === m.session && item.created === m.created));
      } catch { finish(); }
    });
  });
}
type Send = (status: number, body: unknown) => void;
async function dispatch(req: IncomingMessage, config: Config, engine: Dictation, send: Send) {
  // Match the original HTTP path, never a URL parser's normalized operation.
  const path = req.url ?? '';
  if (/[?#%\\]/.test(path) || req.headers['content-encoding'] !== undefined) throw new Fault('invalid_request');
  for (const name of ['X-Mesh-Dictation-Client', 'X-Mesh-Session', 'X-Mesh-Created', 'X-Mesh-Request-Id'])
    single(req, name, true);
  // Even config needs the parent-derived authenticated principal, not a job UUID.
  const principal = single(req, 'X-Mesh-Principal');
  if (!/^[a-f0-9]{64}$/.test(principal)) throw new Fault('invalid_request');
  if (req.method === 'POST' && path === '/internal/principal') {
    const body = await object(req);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'revision')) throw new Fault('invalid_request');
    engine.activate(principal, body.revision as number);
    send(200, {});
    return;
  }
  if (req.method === 'GET') await empty(req);
  engine.authorize(principal);
  if (req.method === 'GET' && path === '/api/transcribe/config') { send(200, config.public); return; }
  if (req.method === 'POST' && path === '/internal/admission') {
    await empty(req);
    await engine.verifySession(metadata(req));
    send(200, {});
    return;
  }
  if (req.method === 'POST' && path === '/api/transcribe') {
    const admission = metadata(req);
    const result = await engine.prepare(admission, req.iterator({destroyOnReturn: false}));
    await engine.verifySession(admission);
    send(202, result);
    return;
  }
  await dispatchJob(req, path, engine, send);
}

async function dispatchJob(req: IncomingMessage, path: string, engine: Dictation, send: Send) {
  const m = owner(req);
  const lookup = /^\/api\/transcribe\/request\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && lookup) { send(200, engine.lookup(m, uuid(lookup[1]))); return; }
  const internal = /^\/internal\/(commit|abort)\/([^/]+)$/.exec(path);
  if (req.method === 'POST' && internal) {
    const body = await object(req);
    if (Object.keys(body).length) throw new Fault('invalid_request');
    const preparation = uuid(single(req, 'X-Mesh-Preparation'));
    if (internal[1] === 'commit') send(200, engine.commit(m, uuid(internal[2]), preparation));
    else { engine.abort(m, uuid(internal[2]), preparation); send(200, {}); }
    return;
  }
  const job = /^\/api\/transcribe\/([^/]+)(?:\/(cancel|settle))?$/.exec(path);
  if (!job) throw new Fault('not_found');
  const id = uuid(job[1]);
  if (req.method === 'GET' && !job[2]) { send(200, engine.read(m, id)); return; }
  if (req.method === 'POST' && job[2]) {
    const body = await object(req), keys = Object.keys(body);
    if (job[2] === 'cancel') {
      if (keys.length) throw new Fault('invalid_request');
      send(200, engine.cancel(m, id));
    } else {
      if (keys.length !== 1 || keys[0] !== 'outcome' ||
          !['submitted', 'discarded', 'inserted'].includes(body.outcome as string)) throw new Fault('invalid_request');
      send(200, engine.settle(m, id, body.outcome as SettlementOutcome));
    }
    return;
  }
  throw new Fault('not_found');
}
const digest = (value: string) => createHash('sha256').update(value).digest();
function serviceHandler(config: Config, engine: Dictation, expected: Buffer) {
  let handlers = 0;
  return (req: IncomingMessage, res: ServerResponse) => {
    const send: Send = (status, body) => {
      if (res.destroyed) return;
      // Do not drain an unfinished rejected upload. Node closes the connection
      // after flushing this response, rather than destroying it in the iterator.
      if (!req.complete) res.setHeader('Connection', 'close');
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(body));
    };
    void (async () => {
      let counted = false;
      try {
        if (!timingSafeEqual(digest(single(req, 'X-Mesh-Bridge')), expected)) {
          send(403, new Fault('not_found').json());
          return;
        }
        // Parent-only transitions must not wait behind the uploads they revoke.
        if (!(req.method === 'POST' && req.url === '/internal/principal')) {
          if (handlers >= 32) throw new Fault('capacity_full');
          handlers++;
          counted = true;
        }
        await dispatch(req, config, engine, send);
      } catch (error) {
        const fault = error instanceof Fault ? error : new Fault('unavailable');
        send(fault.status, fault.json());
      } finally { if (counted) handlers--; }
    })();
  };
}

export async function startService(
  config: Config, secret: string, socketPath: string, inventorySocket: string, principal: string,
) {
  if (!/^[a-f0-9]{64}$/.test(principal)) throw Error('Initial principal required');
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid!())
    throw Error('Private dictation directory required');
  const engine = new Dictation(config, {principal, isLive: (m, signal) => liveInventory(inventorySocket, m, signal)});
  const server = createServer({maxHeaderSize: 8192, requestTimeout: 16000, headersTimeout: 5000},
    serviceHandler(config, engine, digest(secret)));
  server.maxConnections = 64;
  server.keepAliveTimeout = 1000;
  server.timeout = 16000;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await Promise.all([stopped, engine.close()]);
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(socketPath);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return {engine, server, close};
}
