// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A small HTTPS reverse proxy that behaves like the defaults of Caddy's `reverse_proxy`, for tests:
// TLS with a throwaway self-signed certificate, the browser's Host kept as it came, and
// X-Forwarded-For / -Proto / -Host written by the proxy itself (any value the client sent is
// overwritten, as Caddy does unless `trusted_proxies` is configured). Plain HTTP requests and
// websocket upgrades are both forwarded. It is not Caddy: it only pins down the contract the
// server relies on (see "HTTPS on a VPN address with a reverse proxy" in docs/operations.md).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type TlsProxy = {
  port: number;
  /** The certificate the proxy presents: the only authority a client of the test needs to trust. */
  ca: string;
  /** What a browser would send as Origin for this proxy. */
  origin: string;
  /** Every request the proxy forwarded, with the headers it sent upstream. */
  forwarded: Array<Record<string, string | string[] | undefined>>;
  stop: () => Promise<void>;
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade']);

function throwawayCertificate(directory: string): {key: string; cert: string} {
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], {stdio: 'ignore'});
  return {key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8')};
}

/** The headers sent upstream: the client's, minus hop-by-hop ones, with the three forwarded ones rewritten. */
function upstreamHeaders(request: http.IncomingMessage, keepUpgrade: boolean): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name) && !name.startsWith('x-forwarded-')) headers[name] = value;
  }
  if (keepUpgrade) { headers.connection = 'Upgrade'; headers.upgrade = request.headers.upgrade; }
  headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = request.headers.host;
  return headers;
}

export async function startTlsProxy(upstreamPort: number): Promise<TlsProxy> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-tlsproxy-'));
  const {key, cert} = throwawayCertificate(directory);
  const forwarded: TlsProxy['forwarded'] = [];
  const server = https.createServer({key, cert}, (request, response) => {
    const headers = upstreamHeaders(request, false);
    forwarded.push(headers as Record<string, string>);
    const upstream = http.request({host: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers},
      reply => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
    upstream.on('error', () => { response.writeHead(502).end(); });
    request.pipe(upstream);
  });
  server.on('upgrade', (request, clientSocket, head) => {
    const headers = upstreamHeaders(request, true);
    forwarded.push(headers as Record<string, string>);
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [String(value)]).map(each => `${name}: ${each}`));
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, ca: cert, origin: `https://127.0.0.1:${port}`, forwarded,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(directory, {recursive: true, force: true});
    },
  };
}

export type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer};

/** One HTTPS request to the proxy, trusting only its certificate. Redirects are not followed. */
export function viaProxy(proxy: TlsProxy, method: string, urlPath: string,
                         headers: Record<string, string> = {}, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = https.request({host: '127.0.0.1', port: proxy.port, method, path: urlPath, headers, ca: proxy.ca}, reply => {
      const chunks: Buffer[] = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => resolve({status: reply.statusCode ?? 0, headers: reply.headers, body: Buffer.concat(chunks)}));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** A websocket handshake through the proxy, on a connection of its own (a refused upgrade leaves this simple
 * proxy as a raw tunnel, so the socket must not be reused): the status of the answer (101 when upgraded), then the socket is closed. */
export function webSocketHandshake(proxy: TlsProxy, urlPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = https.request({host: '127.0.0.1', port: proxy.port, method: 'GET', path: urlPath, ca: proxy.ca, agent: false, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': Buffer.from('mesh-vpn-proxy-1').toString('base64'), ...headers}});
    request.on('upgrade', (reply, socket) => { socket.destroy(); resolve(reply.statusCode ?? 0); });
    request.on('response', reply => { reply.resume(); resolve(reply.statusCode ?? 0); });
    request.on('error', reject);
    request.end();
  });
}
