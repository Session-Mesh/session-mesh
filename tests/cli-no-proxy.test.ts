// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The mesh CLIs carry a credential (master or session token) to 127.0.0.1: they must reach the
// mesh directly even when the environment names a proxy, never hand the token to that proxy, and never
// follow a redirection elsewhere (it would resend the Authorization header to another host).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, beforeEach, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const MASTER = 'master-token-for-the-test';
const SESSION = 'session-token-for-the-test';
const PROXY_VARIABLES = ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'https_proxy', 'HTTPS_PROXY'];

type Seen = {method: string; url: string; authorization: string};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-no-proxy-'));
const confDir = path.join(scratch, 'conf');
const runtimeDir = path.join(scratch, 'run');
const seenByMesh: Seen[] = [];
const seenByThirdParty: Seen[] = [];
let proxyConnections = 0;
let meshPort = 0;
let proxyPort = 0;
let thirdPartyPort = 0;
let redirectStatus = 0;

const REPLIES: Record<string, object> = {
  '/api/open': {target: 'shown'},
  '/api/organize': {ok: true},
  '/api/logout-all': {generation: 7},
  '/api/event': {ok: true},
};

const mesh = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    seenByMesh.push({method: request.method ?? '', url: request.url ?? '',
      authorization: String(request.headers.authorization ?? '')});
    if (redirectStatus) {
      response.writeHead(redirectStatus, {Location: `http://localhost:${thirdPartyPort}${request.url ?? '/'}`});
      response.end();
      return;
    }
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(REPLIES[request.url ?? ''] ?? {}));
  });
});

// Another host, as far as the CLI can tell (`localhost`, not 127.0.0.1): it answers like the mesh would.
const thirdParty = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    seenByThirdParty.push({method: request.method ?? '', url: request.url ?? '',
      authorization: String(request.headers.authorization ?? '')});
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(REPLIES[request.url ?? ''] ?? {}));
  });
});

const proxy = http.createServer((_request, response) => {
  response.writeHead(502);
  response.end();
});
proxy.on('connection', () => { proxyConnections += 1; });

// A ptyhost stand-in answering `list` with one session, for mesh-rename and mesh-open. Its shell
// is pid 1 (an ancestor of no CLI) unless a test names an ancestor of the CLI instead.
let sessionShellPid = 1;

function frame(kind: string, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

const ptyhost = net.createServer(socket => {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
      socket.end(frame('R', [{name: 's1', pid: sessionShellPid, cwd: '/', created: 0, activity: 0, attached: 0, meta: {}}]));
    }
  });
});

function listen(server: net.Server, where: number | string): Promise<number> {
  return new Promise(resolve => {
    server.listen(where, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

before(async () => {
  fs.mkdirSync(confDir, {recursive: true});
  fs.writeFileSync(path.join(confDir, 'token'), MASTER + '\n');
  fs.mkdirSync(path.join(runtimeDir, 'session-mesh'), {recursive: true, mode: 0o700});
  meshPort = await listen(mesh, 0);
  proxyPort = await listen(proxy, 0);
  thirdPartyPort = await listen(thirdParty, 0);
  await new Promise<void>(resolve => ptyhost.listen(path.join(runtimeDir, 'session-mesh', 'ptyhost.sock'), resolve));
});

after(() => {
  mesh.close();
  proxy.close();
  thirdParty.close();
  ptyhost.close();
  fs.rmSync(scratch, {recursive: true, force: true});
});

beforeEach(() => {
  seenByMesh.length = 0;
  seenByThirdParty.length = 0;
  proxyConnections = 0;
  redirectStatus = 0;
  sessionShellPid = 1;
});

function environment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, MESH_CONF_DIR: confDir, MESH_PORT: String(meshPort),
    XDG_RUNTIME_DIR: runtimeDir};
  for (const name of ['no_proxy', 'NO_PROXY', 'MESH_SESSION_TOKEN', 'MESH_SESSION', 'MESH_RUNTIME_DIR']) delete env[name];
  for (const name of PROXY_VARIABLES) env[name] = `http://127.0.0.1:${proxyPort}`;
  return {...env, ...extra};
}

function runCli(name: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{code: number | null; output: string}> {
  return new Promise(resolve => {
    const child = spawn(PYTHON, [path.join(REPO, 'bin', name), ...args],
      {cwd: scratch, env: environment(extra), stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({code, output}));
  });
}

function assertDirect(expected: Seen[]): void {
  assert.equal(proxyConnections, 0, 'the proxy received a connection');
  assert.deepEqual(seenByMesh, expected);
}

describe('mesh CLIs ignore proxy variables for the local mesh', () => {
  test('mesh-open sends the master token straight to the mesh', async () => {
    const result = await runCli('mesh-open', ['page.md']);
    assert.equal(result.code, 0, result.output);
    assertDirect([{method: 'POST', url: '/api/open', authorization: `Bearer ${MASTER}`}]);
  });

  test('mesh-open sends a session token straight to the mesh', async () => {
    const result = await runCli('mesh-open', ['page.md'], {MESH_SESSION_TOKEN: SESSION});
    assert.equal(result.code, 0, result.output);
    assertDirect([{method: 'POST', url: '/api/open', authorization: `MeshSession ${SESSION}`}]);
  });

  test('mesh-open refuses a web page before sending anything', async () => {
    const result = await runCli('mesh-open', ['https://example.invalid/page'], {MESH_SESSION_TOKEN: SESSION});
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /a web page does not open in a panel/);
    assertDirect([]);
  });

  test('mesh-rename sends the master token straight to the mesh', async () => {
    const result = await runCli('mesh-rename', ['-s', 's1', 'new', 'name']);
    assert.equal(result.code, 0, result.output);
    assertDirect([{method: 'POST', url: '/api/organize', authorization: `Bearer ${MASTER}`}]);
  });

  test('mesh-logout-all sends the master token straight to the mesh', async () => {
    const result = await runCli('mesh-logout-all', []);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /generation 7/);
    assertDirect([{method: 'POST', url: '/api/logout-all', authorization: `Bearer ${MASTER}`}]);
  });

  test('mesh-event sends the session token straight to the mesh', async () => {
    const turn = JSON.stringify({type: 'agent-turn-complete', 'turn-id': 't1'});
    const result = await runCli('mesh-event', ['codex', turn], {MESH_SESSION_TOKEN: SESSION});
    assert.equal(result.code, 0, result.output);
    assertDirect([{method: 'POST', url: '/api/event', authorization: `MeshSession ${SESSION}`}]);
  });
});

describe('mesh CLIs never follow a redirection', () => {
  for (const status of [301, 302, 303, 307]) {
    test(`mesh-open fails on a ${status} and sends nothing elsewhere`, async () => {
      redirectStatus = status;
      const result = await runCli('mesh-open', ['page.md']);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /redirect refused/);
      assert.deepEqual(seenByThirdParty, []);
    });
  }

  test('mesh-rename fails on a redirection and sends nothing elsewhere', async () => {
    redirectStatus = 302;
    const result = await runCli('mesh-rename', ['-s', 's1', 'new', 'name']);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /redirect refused/);
    assert.deepEqual(seenByThirdParty, []);
  });

  test('mesh-logout-all fails on a redirection instead of announcing success', async () => {
    redirectStatus = 303;
    const result = await runCli('mesh-logout-all', []);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /redirect refused/);
    assert.doesNotMatch(result.output, /signed out/);
    assert.deepEqual(seenByThirdParty, []);
  });

  test('mesh-event sends nothing elsewhere on a redirection', async () => {
    redirectStatus = 301;
    const turn = JSON.stringify({type: 'agent-turn-complete', 'turn-id': 't1'});
    const result = await runCli('mesh-event', ['codex', turn], {MESH_SESSION_TOKEN: SESSION});
    assert.equal(result.code, 0, result.output);
    assert.equal(seenByMesh.length, 1);
    assert.deepEqual(seenByThirdParty, []);
  });
});

describe('mesh CLIs without a token', () => {
  // A session whose shell lost MESH_SESSION_TOKEN must not act with the master token instead.
  test('mesh-open in a mesh session without its session token refuses and sends nothing', async () => {
    const result = await runCli('mesh-open', ['page.md'], {MESH_SESSION: 's1'});
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^mesh-open: .*MESH_SESSION_TOKEN/m);
    assert.doesNotMatch(result.output, /Traceback/);
    assert.ok(!result.output.includes(MASTER), 'the master token was printed');
    assertDirect([]);
  });

  // An agent tool may run commands with a stripped environment: neither MESH_SESSION nor
  // MESH_SESSION_TOKEN. The process ancestry still shows the session; this test process is the
  // CLI's parent, standing in for the session's shell.
  test('mesh-open below a session shell without any mesh variable refuses and sends nothing', async () => {
    sessionShellPid = process.pid;
    const result = await runCli('mesh-open', ['page.md']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^mesh-open: .*mesh session s1.*MESH_SESSION_TOKEN/m);
    assert.doesNotMatch(result.output, /Traceback/);
    assert.ok(!result.output.includes(MASTER), 'the master token was printed');
    assertDirect([]);
  });

  // MESH_SESSION alone decides, even when no PTY host answers to confirm the session (an agent
  // tool that strips variables named like a token keeps MESH_SESSION).
  test('mesh-open with MESH_SESSION and no PTY host answering refuses and sends nothing', async () => {
    const elsewhere = path.join(scratch, 'run-without-ptyhost-session');
    fs.mkdirSync(elsewhere, {recursive: true});
    const result = await runCli('mesh-open', ['page.md'], {MESH_SESSION: 's1', XDG_RUNTIME_DIR: elsewhere});
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^mesh-open: MESH_SESSION is set but MESH_SESSION_TOKEN is not/m);
    assert.ok(!result.output.includes(MASTER), 'the master token was printed');
    assertDirect([]);
  });

  test('mesh-open with no PTY host answering still uses the master token', async () => {
    const elsewhere = path.join(scratch, 'run-without-ptyhost');
    fs.mkdirSync(elsewhere, {recursive: true});
    const result = await runCli('mesh-open', ['page.md'], {XDG_RUNTIME_DIR: elsewhere});
    assert.equal(result.code, 0, result.output);
    assertDirect([{method: 'POST', url: '/api/open', authorization: `Bearer ${MASTER}`}]);
  });

  test('mesh-rename names the missing token instead of printing a trace', async () => {
    const empty = path.join(scratch, 'conf-without-token');
    fs.mkdirSync(empty, {recursive: true});
    const result = await runCli('mesh-rename', ['-s', 's1', 'new', 'name'], {MESH_CONF_DIR: empty});
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^mesh-rename: session-mesh token not found .*is session-mesh installed for this user\?$/m);
    assert.doesNotMatch(result.output, /Traceback/);
    assertDirect([]);
  });
});

// MESH_PORT is put in the URL the credential is sent to: `7690@evil.example` would make
// 127.0.0.1:7690 the user-info part of a URL for another host. Only a port number is accepted.
describe('mesh CLIs accept only a port number in MESH_PORT', () => {
  const turn = JSON.stringify({type: 'agent-turn-complete', 'turn-id': 't1'});
  const CLIS: [string, string[], NodeJS.ProcessEnv][] = [
    ['mesh-open', ['page.md'], {}],
    ['mesh-open', ['page.md'], {MESH_SESSION_TOKEN: SESSION}],
    ['mesh-rename', ['-s', 's1', 'new', 'name'], {}],
    ['mesh-logout-all', [], {}],
    ['mesh-event', ['codex', turn], {MESH_SESSION_TOKEN: SESSION, MESH_EVENT_DEBUG: '1'}],
  ];
  const badPorts = (): string[] => [`${meshPort}@localhost:${thirdPartyPort}`, `${meshPort}@localhost`,
    `${thirdPartyPort}/x`, `${meshPort}#`, `${meshPort}?`, ` ${meshPort}`, '0', '65536', '-1', '1e3', '٧٦٩٠', 'http'];

  for (const [name, args, extra] of CLIS) {
    test(`${name}${extra.MESH_SESSION_TOKEN && name === 'mesh-open' ? ' (session token)' : ''} sends nothing with a malformed MESH_PORT`, async () => {
      for (const port of badPorts()) {
        const generationBefore = fs.existsSync(path.join(confDir, 'cookie-generation'))
          ? fs.readFileSync(path.join(confDir, 'cookie-generation'), 'utf8') : null;
        const result = await runCli(name, args, {...extra, MESH_PORT: port});
        assert.deepEqual(seenByThirdParty, [], `MESH_PORT=${port}: the credential went to another host`);
        assert.deepEqual(seenByMesh, [], `MESH_PORT=${port}`);
        assert.equal(proxyConnections, 0);
        assert.match(result.output, /MESH_PORT must be a port number/, `MESH_PORT=${port}`);
        assert.doesNotMatch(result.output, /Traceback/);
        // a hook never fails its agent; every other CLI reports the error
        if (name === 'mesh-event') assert.equal(result.code, 0);
        else assert.notEqual(result.code, 0, `MESH_PORT=${port}: ${result.output}`);
        if (name === 'mesh-logout-all') {
          const generationAfter = fs.existsSync(path.join(confDir, 'cookie-generation'))
            ? fs.readFileSync(path.join(confDir, 'cookie-generation'), 'utf8') : null;
          assert.equal(generationAfter, generationBefore, 'the offline fallback ran on a malformed port');
        }
      }
    });
  }

  test('an empty MESH_PORT means the default port, not an error', async () => {
    const result = await runCli('mesh-open', ['page.md'], {MESH_PORT: ''});
    assert.doesNotMatch(result.output, /MESH_PORT must be/);
    assert.deepEqual(seenByThirdParty, []);
  });
});
