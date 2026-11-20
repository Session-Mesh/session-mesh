// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A local stand-in for the GitHub hosts that release notes take their images from. The server reaches it
// only through MESH_UPDATE_IMAGE_TEST_HOSTS (name=127.0.0.1:port), so no test request leaves the machine.
// Each path answers one case; every request is recorded.
import http from 'node:http';
import type net from 'node:net';

// A 1x1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

export type FakeGithub = {port: number; requests: string[]; stop: () => Promise<void>};

const ROUTES: Record<string, (response: http.ServerResponse) => void> = {
  '/user-attachments/assets/ok': response => { response.writeHead(200, {'Content-Type': 'image/png'}); response.end(PNG); },
  // GitHub's attachments redirect to a signed private-user-images URL
  '/user-attachments/assets/moved': response => {
    response.writeHead(302, {Location: 'https://private-user-images.githubusercontent.com/signed.png?jwt=x'}); response.end();
  },
  '/signed.png': response => { response.writeHead(200, {'Content-Type': 'image/png; charset=binary'}); response.end(PNG); },
  '/user-attachments/assets/away': response => { response.writeHead(302, {Location: 'https://example.com/x.png'}); response.end(); },
  '/user-attachments/assets/plain': response => { response.writeHead(301, {Location: 'http://github.com/user-attachments/assets/ok'}); response.end(); },
  '/user-attachments/assets/loop': response => { response.writeHead(302, {Location: '/user-attachments/assets/loop'}); response.end(); },
  '/user-attachments/assets/svg': response => { response.writeHead(200, {'Content-Type': 'image/svg+xml'}); response.end(SVG); },
  '/user-attachments/assets/html': response => { response.writeHead(200, {'Content-Type': 'text/html'}); response.end('<script>alert(1)</script>'); },
  '/user-attachments/assets/liar': response => { response.writeHead(200, {'Content-Type': 'image/png'}); response.end('<html><script>alert(1)</script>'); },
  '/user-attachments/assets/huge': response => {
    response.writeHead(200, {'Content-Type': 'image/png'});
    response.end(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
  },
  '/user-attachments/assets/huge-declared': response => {
    response.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': String(6 * 1024 * 1024)});
    response.end(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024 - PNG.length)]));
  },
  '/user-attachments/assets/missing': response => { response.writeHead(404); response.end(); },
};

export async function startFakeGithub(): Promise<FakeGithub> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    requests.push(`${request.headers['user-agent']} ${request.headers.cookie ?? '-'} ${request.headers.authorization ?? '-'} ${request.url}`);
    const route = ROUTES[new URL(request.url ?? '/', 'http://stand-in').pathname];
    if (route) route(response);
    else { response.writeHead(404); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as net.AddressInfo;
  return {
    port, requests,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
