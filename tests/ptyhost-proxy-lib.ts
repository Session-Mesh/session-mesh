// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A man-in-the-middle for the PTY host's control socket, for tests that need the host to misbehave
// at one precise request: slow, refusing, or with a side effect (a file system change) just before
// the request reaches it. Every connection is piped to the real host unchanged, except a first
// control frame ('C') that the `intercept` function names: it may wait (the request is forwarded
// afterwards, even when its caller gave up meanwhile, like a host that is slow to answer), or answer
// in the host's place (the request never reaches the real host; `rawReply`: with bytes that are not JSON; `replyAfter`: with the
// object the promise resolves to, once it does: an answer true when asked, stale on arrival). Other requests, `list` included,
// are served at once: this is what the native host does while it creates a session in a fiber.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {encode} from './ptyhost-wire-lib.ts';

export type Intercepted = {wait?: Promise<unknown>; reply?: object; rawReply?: string; replyAfter?: Promise<object>} | void;
export type Intercept = (request: any) => Intercepted;

export type Proxy = {socketPath: string; close: () => void};

export async function startProxy(socketPath: string, realSocketPath: string, intercept: Intercept): Promise<Proxy> {
  fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
  fs.rmSync(socketPath, {force: true});
  const clients = new Set<net.Socket>();
  const server = net.createServer(client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    let decided = false;
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (decided || head.length < 5 || head.length < 5 + head.readUInt32BE(1)) return;
      decided = true;
      client.off('data', onData);
      client.pause();
      let verdict: Intercepted = undefined;
      if (head.subarray(0, 1).toString('latin1') === 'C') {
        try { verdict = intercept(JSON.parse(head.subarray(5, 5 + head.readUInt32BE(1)).toString('utf8'))); } catch { /* not JSON */ }
      }
      const forward = () => {
        const upstream = net.createConnection(realSocketPath);
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      };
      if (verdict && verdict.rawReply !== undefined) client.end(encode('C', Buffer.from(verdict.rawReply)));
      else if (verdict && verdict.reply) client.end(encode('C', Buffer.from(JSON.stringify(verdict.reply))));
      else if (verdict && verdict.replyAfter) void verdict.replyAfter.then(reply => client.end(encode('C', Buffer.from(JSON.stringify(reply)))));
      else if (verdict && verdict.wait) void verdict.wait.then(forward);
      else forward();
    };
    client.on('data', onData);
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return {socketPath, close: () => { server.close(); for (const client of clients) client.destroy(); }};
}
