// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// pi_mesh_wake.mjs sends the session token to 127.0.0.1: even with NODE_USE_ENV_PROXY=1 (Node then routes
// the default agent through HTTP_PROXY), its wake stream and its acknowledgement must reach the mesh
// directly and never hand the token to that proxy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SESSION = 'session-token-for-the-test';
const CONVERSATION = '22222222-2222-2222-2222-222222222222';
const NOTIFICATION = 'b'.repeat(32);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wake-no-proxy-'));

type Seen = {method: string; url: string; authorization: string};
const seenByMesh: Seen[] = [];
let proxyConnections = 0;
let resolveAck: () => void = () => {};
const acknowledged = new Promise<void>(resolve => { resolveAck = resolve; });
type Activity = {type: string; detail: {source: string; session: string; pid: number; seq: number; hook: string}};
const activities: Activity[] = [];
let resolveActivity: () => void = () => {};
const activityReported = new Promise<void>(resolve => { resolveActivity = resolve; });

const mesh = http.createServer((request, response) => {
  seenByMesh.push({method: request.method ?? '', url: request.url ?? '',
    authorization: String(request.headers.authorization ?? '')});
  if (request.method === 'GET') {
    response.writeHead(200, {'Content-Type': 'application/x-ndjson'});
    response.write(JSON.stringify({notification_id: NOTIFICATION, count: 1}) + '\n');
    return;
  }
  if (request.url === '/api/event') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      activities.push(JSON.parse(body));
      response.writeHead(200).end();
      if (activities.length === 3) resolveActivity();
    });
    return;
  }
  request.resume();
  request.on('end', () => { response.writeHead(200); response.end(); resolveAck(); });
});

const proxy = http.createServer((request, response) => {
  request.resume();
  response.writeHead(502);
  response.end();
});
proxy.on('connection', () => { proxyConnections += 1; });

// The child loads the extension with a minimal Pi stand-in: the steered message is written to the
// transcript, so the extension confirms it and sends its acknowledgement.
const CHILD = `
import { appendFile, writeFile } from "node:fs/promises";
const transcript = process.env.TEST_TRANSCRIPT;
await writeFile(transcript, "");
const { default: extension } = await import(process.env.TEST_EXTENSION);
const handlers = {};
const branch = [];
const ctx = { sessionManager: { getSessionFile: () => transcript, getBranch: () => branch,
  getSessionId: () => ${JSON.stringify(CONVERSATION)} },
  isIdle: () => true, hasPendingMessages: () => false };
extension({
  on: (name, callback) => { handlers[name] = callback; },
  sendUserMessage: text => {
    const entry = { type: "message", id: "m1", message: { role: "user", content: text } };
    branch.push(entry);
    void appendFile(transcript, JSON.stringify(entry) + "\\n").then(() => handlers.message_end({ message: entry.message }));
  },
});
handlers.session_start({}, ctx);
handlers.agent_start({}, ctx);
handlers.agent_end({}, ctx);
process.on("SIGTERM", () => { handlers.session_shutdown(); process.exit(0); });
`;

function listen(server: net.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

let meshPort = 0;
let proxyPort = 0;

before(async () => {
  meshPort = await listen(mesh);
  proxyPort = await listen(proxy);
});

after(() => {
  mesh.closeAllConnections();
  mesh.close();
  proxy.closeAllConnections();
  proxy.close();
  fs.rmSync(scratch, {recursive: true, force: true});
});

test('Pi activity reports and wake acknowledgements reach Mesh directly under NODE_USE_ENV_PROXY=1', async () => {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const env: NodeJS.ProcessEnv = {...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, MESH_SESSION_TOKEN: SESSION, MESH_PORT: String(meshPort),
    TEST_TRANSCRIPT: path.join(scratch, 'session.jsonl'),
    TEST_EXTENSION: new URL(`file://${path.join(REPO, 'pi_mesh_wake.mjs')}`).href};
  for (const name of ['NO_PROXY', 'no_proxy']) delete env[name];
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<void>(resolve => child.on('close', () => resolve()));
  const outcome = await Promise.race([Promise.all([acknowledged, activityReported]).then(() => 'acknowledged'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 4000))]);
  child.kill('SIGTERM');
  await exited;
  assert.equal(proxyConnections, 0, `the proxy received a connection (${output})`);
  assert.equal(outcome, 'acknowledged', output);
  assert.ok(seenByMesh.every(request => request.authorization === `MeshSession ${SESSION}`));
  assert.deepEqual(seenByMesh.filter(request => request.url !== '/api/event'), [
    {method: 'GET', url: '/api/agent-mail/@self/pi-wakes', authorization: `MeshSession ${SESSION}`},
    {method: 'POST', url: '/api/agent-mail/@self/pi-wake-ack', authorization: `MeshSession ${SESSION}`},
  ]);
  const ordered = activities.sort((a, b) => a.detail.seq - b.detail.seq);
  assert.deepEqual(ordered.map(({type}) => type), ['done', 'working', 'done']);
  for (const [index, event] of ordered.entries()) {
    assert.equal(event.detail.source, 'pi');
    assert.equal(event.detail.session, CONVERSATION);
    assert.equal(event.detail.pid, child.pid);
    assert.equal(event.detail.hook, 'pi_activity');
    assert.equal(event.detail.seq, ordered[0]!.detail.seq + index);
  }
});
