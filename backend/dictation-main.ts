// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configuration} from './dictation.ts';
import {startService} from './dictation-service.ts';

type Bootstrap = {
  secret: string; inventory: string; parent: number; principal: string; socket?: string;
};
function parseBootstrap(line: string, standalone: boolean): Bootstrap {
  const value = JSON.parse(line);
  if (!value || typeof value.secret !== 'string' || !/^[a-f0-9]{64}$/.test(value.secret) ||
      typeof value.principal !== 'string' || !/^[a-f0-9]{64}$/.test(value.principal) ||
      typeof value.inventory !== 'string' || !value.inventory.startsWith('/') ||
      value.parent !== process.ppid ||
      (standalone
        ? typeof value.socket !== 'string' || !value.socket.startsWith('/')
        : value.socket !== undefined)) throw Error('Bootstrap invalid');
  return value;
}
function readBootstrap(standalone: boolean): Promise<Bootstrap> {
  return new Promise((resolve, reject) => {
    let input = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', receive);
      process.stdin.off('end', closed);
    };
    const fail = (reason: string) => { cleanup(); reject(new Error(reason)); };
    const closed = () => fail('Bootstrap closed');
    const receive = (part: Buffer) => {
      const newline = part.indexOf(10);
      const size = newline < 0 ? part.length : newline;
      if (input.length + size > 4096) return fail('Bootstrap limit');
      input = Buffer.concat([input, part.subarray(0, size)]);
      if (newline < 0) return;
      cleanup();
      try { resolve(parseBootstrap(new TextDecoder('utf-8', {fatal: true}).decode(input), standalone)); }
      catch (error) { reject(error); }
    };
    const timer = setTimeout(() => fail('Bootstrap timeout'), 5000);
    process.stdin.on('data', receive);
    process.stdin.once('end', closed);
  });
}

async function main() {
  const standalone = process.argv[2] === '--worker';
  if (process.argv.length > (standalone ? 3 : 2)) throw Error('Invalid worker mode');
  let config;
  try { config = configuration(process.env); }
  catch { process.stdout.write('invalid_configuration\n'); process.exitCode = 1; return; }
  if (!config) throw Error('Disabled worker');
  // The normal entry creates and removes its own private directory; the closed
  // --worker mode retains the lower-level protocol fixture's supplied socket.
  const bootstrap = await readBootstrap(standalone);
  const directory = standalone ? undefined : await mkdtemp('/tmp/mesh-dictation-');
  const socket = bootstrap.socket ?? join(directory!, 'worker.sock');
  const controller = new AbortController();
  let started: ReturnType<typeof startService>;
  let closing: Promise<void> | undefined;
  try {
    if (directory) process.stdout.write(JSON.stringify({directory}) + '\n');
    started = startService(config, bootstrap.secret, socket, bootstrap.inventory,
      bootstrap.principal, controller.signal);
    const close = (failure = false) => {
      if (failure) process.exitCode = 1;
      if (closing) return closing;
      closing = (async () => {
        controller.abort();
        clearInterval(parentWatch);
        process.stdin.pause();
        try {
          const service = await started.catch(() => null);
          if (service) await service.close();
        } finally {
          if (directory) await rm(directory, {recursive: true, force: true});
        }
      })();
      return closing;
    };
    const shutdown = (failure = false) => {
      void close(failure).catch(() => {
        process.exitCode = 1;
        process.stderr.write('Dictation worker unavailable.\n');
      });
    };
    const parentWatch = setInterval(() => { if (process.ppid !== bootstrap.parent) shutdown(); }, 250);
    process.stdin.on('end', () => shutdown()); process.stdin.resume();
    process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
    if (process.stdin.readableEnded || process.ppid !== bootstrap.parent) { await close(); return; }
    let service;
    try { service = await started; }
    catch (error) { if (controller.signal.aborted) return; clearInterval(parentWatch); throw error; }
    if (controller.signal.aborted) { await close(); return; }
    if (service.failed) { await close(true); return; }
    void service.failure.then(() => shutdown(true));
    process.stdout.write(standalone ? 'ready\n' : JSON.stringify({socket}) + '\n');
  } catch (error) {
    if (directory && !closing) await rm(directory, {recursive: true, force: true});
    throw error;
  }
}
void main().catch(() => { process.stderr.write('Dictation worker unavailable.\n'); process.exit(1); });
