#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Execute only the extracted runtime, outside the source tree and opam switch.
set -euo pipefail
archive=${1:?usage: smoke-bundle.sh ARCHIVE}
# Native runtime paths must be canonical and fit Darwin's 104-byte sun_path.
# The hosted macOS TMPDIR is both long and routed through /var -> /private/var.
scratch=$(mktemp -d /tmp/mesh-smoke.XXXXXX)
scratch=$(cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
tar -xzf "$archive" -C "$scratch"
launcher=$(find "$scratch" -maxdepth 3 -type f -name mesh -print)
[ -n "$launcher" ] && [ "$(printf '%s\n' "$launcher" | wc -l | tr -d ' ')" = 1 ]
bundle=$(dirname "$launcher")
mkdir -p "$scratch/home" "$scratch/run" "$scratch/work"
chmod 700 "$scratch/home" "$scratch/run"
# mesh-history carries its own pinned SQLite: on Linux it must not need a libsqlite3 shared library
# (readelf -d, which must succeed; when binutils is missing, the first libsqlite3 name found by
# searching the whole binary), and it must pass the History probe whatever the system's SQLite is.
history="$bundle/bin/mesh-history"
[ -x "$history" ] || { echo "smoke-bundle: $history is missing" >&2; exit 1; }
if [ "$(uname -s)" = Linux ]; then
  if command -v readelf >/dev/null 2>&1; then
    dynamic="$(readelf -d "$history")" || { echo "smoke-bundle: readelf -d failed on $history" >&2; exit 1; }
    needed="$(grep -F '(NEEDED)' <<<"$dynamic" || true)"
  else
    needed="$(grep -a -o 'libsqlite3[A-Za-z0-9._-]*' "$history" | head -n 1 || true)"
  fi
  if grep -q 'libsqlite3' <<<"$needed"; then
    echo "smoke-bundle: bin/mesh-history needs a libsqlite3 shared library: $needed" >&2
    exit 1
  fi
fi
mkdir -p "$scratch/history"
bash "$(dirname "$0")/smoke-history.sh" "$history" "$scratch/history"
cd "$scratch/work"
env -i HOME="$scratch/home" PATH=/usr/bin:/bin LANG=C \
  MESH_RUNTIME_DIR="$scratch/run" MESH_CONF_DIR="$scratch/home/config" \
  "$bundle/mesh" doctor
env -i HOME="$scratch/home" PATH=/usr/bin:/bin LANG=C \
  MESH_RUNTIME_DIR="$scratch/run" MESH_CONF_DIR="$scratch/home/config" \
  MESH_SMOKE_REQUIRE_ROSTER="${MESH_SMOKE_REQUIRE_ROSTER:-}" \
  "$bundle/runtime/node/bin/node" --input-type=module - "$bundle" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
const bundle = process.argv[2];
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
// A node first on PATH that always fails: the bundle must run its Node by absolute path (the
// project observation and its Roster CLIs included), even on a runner with a system node.
const noNode = path.join(process.env.HOME, 'no-system-node');
fs.mkdirSync(noNode, {recursive: true});
fs.writeFileSync(path.join(noNode, 'node'), '#!/bin/sh\nexit 97\n', {mode: 0o700});
const env = {...process.env, PATH: `${noNode}:${process.env.PATH}`, MESH_PORT: String(port), SHELL: '/bin/sh'};
// Keep the fixture's poisoned agent PATH through native login-shell invocation.
env.SHELL = path.join(env.HOME, 'smoke-shell');
fs.writeFileSync(env.SHELL, '#!/bin/sh\nexec /bin/sh\n', {mode: 0o700});
const logs = [];
const dictationAudio = Buffer.from('synthetic bundle audio');
function assertWhisperMultipart(contentType, body, audio) {
  const match = /^multipart\/form-data; boundary=([A-Za-z0-9_-]{1,70})$/.exec(contentType);
  assert.ok(match, 'multipart Content-Type with exactly one boundary');
  const boundary = match[1];
  const fields = `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nfr\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`;
  assert.deepEqual(body, Buffer.concat([Buffer.from(fields), audio, Buffer.from(`\r\n--${boundary}--\r\n`)]));
}
let app;
let mcp;
let session;
let whisper;
let whisperCalls = 0;
let whisperFailure;
const socketPath = path.join(env.MESH_RUNTIME_DIR, 'session-mesh', 'ptyhost.sock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, fn) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => false);
    if (result) return result;
    await delay(50);
  }
  throw new Error(`${label} timed out`);
}
async function control(body) {
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    connection.setTimeout(5000, () => connection.destroy(new Error('control timeout')));
    connection.on('error', reject);
    connection.on('connect', () => {
      const payload = Buffer.from(JSON.stringify(body));
      const head = Buffer.alloc(5);
      head.write('C'); head.writeUInt32BE(payload.length, 1);
      connection.write(Buffer.concat([head, payload]));
    });
    connection.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5 || buffer.length < 5 + buffer.readUInt32BE(1)) return;
      connection.destroy();
      resolve(JSON.parse(buffer.subarray(5, 5 + buffer.readUInt32BE(1)).toString()));
    });
  });
}
try {
  // Qualify the bundled Node collector and native catalog validator using an
  // actual Git repository, not an imported development node_modules tree.
  const repository = path.join(env.HOME, 'repository');
  fs.mkdirSync(repository);
  for (const args of [['init', '--quiet', repository], ['-C', repository, 'checkout', '--quiet', '-b', 'bundle-main']])
    assert.equal(spawnSync('/usr/bin/git', args, {env}).status, 0);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Bundle project\nA packaged observation.\n');
  assert.equal(spawnSync('/usr/bin/git', ['-C', repository, 'add', 'README.md'], {env}).status, 0);
  assert.equal(spawnSync('/usr/bin/git', ['-C', repository, '-c', 'user.name=Bundle smoke',
    '-c', 'user.email=smoke@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], {env}).status, 0);
  // Exercise the optional public Roster through the wrapper the project
  // observation runs (env.sh), with no usable node on PATH.
  const rosterCLI = path.join(bundle, 'libexec', 'mesh-roster-roadmap');
  const rosterSources = [];
  if (fs.existsSync(path.join(bundle, 'optional', 'roster', 'scripts', 'roster-roadmap.cjs'))) {
    fs.accessSync(rosterCLI, fs.constants.X_OK);
    const board = path.join(env.HOME, 'roster-board');
    const initialized = spawnSync(rosterCLI, ['init', board, '--id', 'bundle-roadmap'], {env, encoding: 'utf8', timeout: 10000});
    assert.equal(initialized.status, 0, initialized.stderr);
    rosterSources.push({id: 'bundle-roster', kind: 'roster', label: 'Bundle Roster', board_path: board});
  }
  // MESH_SMOKE_REQUIRE_ROSTER=1: a bundle that should carry Roster must not pass without it.
  if (process.env.MESH_SMOKE_REQUIRE_ROSTER === '1') {
    assert.ok(rosterSources.length > 0, 'MESH_SMOKE_REQUIRE_ROSTER=1: the bundle has no optional/roster');
  }
  fs.mkdirSync(env.MESH_CONF_DIR, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(env.MESH_CONF_DIR, 'projects.json'), JSON.stringify({
    kind: 'mesh-project-config', schema_version: 2,
    features: ['project-metadata/1', 'project-workspace/1', 'project-observation/1'], machine_id: 'bundle-host',
    projects: [{id: 'bundle-project', title: 'Bundle project', sessions: [], sources: rosterSources,
      repository: {url: 'https://example.invalid/bundle-project', local_path: repository, primary_ref: 'refs/heads/bundle-main'},
      observation: {repository: true, source_ids: rosterSources.map(source => source.id)}}],
  }), {mode: 0o600});
  // A worklog data repository where work-read finds it by default (~/worklog-data), holding only a
  // taxonomy: /api/work/v1 below must run the bundle's own bin/work-read.
  const worklog = path.join(env.HOME, 'worklog-data');
  fs.mkdirSync(worklog, {mode: 0o700});
  fs.writeFileSync(path.join(worklog, 'taxonomy.yaml'),
    'categories:\n  smoke:\n    name: Smoke\n    products:\n      - bundle-product\n');
  // Only this owned HTTP peer receives the declared synthetic clip; no model or microphone.
  whisper = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/fixed-whisper'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers['content-encoding'], undefined);
      const parts = []; let size = 0;
      for await (const part of req) {size += part.length; assert.ok(size <= 4096); parts.push(part);}
      assertWhisperMultipart(req.headers['content-type'], Buffer.concat(parts), dictationAudio);
      whisperCalls++; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({text: 'bundle transcription'}));
    } catch (error) {whisperFailure = error; res.writeHead(400); res.end();}
  });
  await new Promise(resolve => whisper.listen(0, '127.0.0.1', resolve));
  env.MESH_WHISPER_URL = `http://127.0.0.1:${whisper.address().port}/fixed-whisper`;
  app = spawn(path.join(bundle, 'mesh'), ['run'], {env, stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => logs.push(chunk.toString()));
  await until('HTTP server', async () => {
    assert.equal(app.exitCode, null, 'bundle exited before becoming ready');
    return (await fetch(`http://127.0.0.1:${port}/login`)).ok;
  });
  assert.deepEqual(await control({op: 'list'}), []);
  const inventory = await control({op: 'project_list', version: 1});
  assert.equal(inventory.status, 'ok');
  const requestId = '00000000-0000-4000-8000-000000000091';
  const observation = await control({op: 'project_observation_start', version: 1, boot: inventory.boot,
    machine_id: 'bundle-host', project_id: 'bundle-project', expected_revision: inventory.revision, request_id: requestId});
  assert.equal(observation.status, 'ok', JSON.stringify(observation));
  const observationRequest = {version: 1, boot: inventory.boot, machine_id: 'bundle-host', project_id: 'bundle-project',
    requested_revision: inventory.revision, request_id: requestId, observation_id: observation.observation_id};
  const status = await until('project observation', async () => {
    const result = await control({...observationRequest, op: 'project_observation_status'});
    if (['failed', 'cancelled', 'cleanup-pending'].includes(result.observation_state))
      throw new Error(`project observation refused: ${JSON.stringify(result)}`);
    return result.observation_state === 'complete' ? result : false;
  });
  assert.ok(status.descriptor);
  const page = await control({...observationRequest, op: 'project_observation_page', page_index: 0});
  const catalog = JSON.parse(Buffer.from(page.data_base64, 'base64').toString('utf8'));
  assert.equal(catalog.projects[0].repository.observation.status, 'valid');
  assert.equal(catalog.projects[0].repository.observation.readme.text, '# Bundle project\nA packaged observation.\n');
  if (rosterSources.length) {
    const roster = catalog.projects[0].sources.find(source => source.id === 'bundle-roster');
    assert.equal(roster?.status, 'available', JSON.stringify(roster));
    assert.equal(roster.summary.provider_schema, 'roster-roadmap-view');
  }
  const token = fs.readFileSync(path.join(env.MESH_CONF_DIR, 'token'), 'utf8').trim();
  assert.ok(token);
  // The Projects view's read path: a 503 here would mean that the bundle has no bin/work-read.
  const work = await fetch(`http://127.0.0.1:${port}/api/work/v1`, {
    method: 'POST', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({op: 'products', args: {}}),
  });
  const workText = await work.text();
  assert.equal(work.status, 200, workText);
  const products = JSON.parse(workText);
  assert.equal(products.command, 'products', workText);
  assert.equal(products.categories[0].products[0].id, 'bundle-product', workText);
  const tokenFile = path.join(env.HOME, 'session-token');
  const agentNodeFile = path.join(env.HOME, 'session-node');
  const script = path.join(env.HOME, 'smoke-session.sh');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s' "$MESH_SESSION_TOKEN" > '${tokenFile}'\ncommand -v node > '${agentNodeFile}'\nexec /bin/sleep 300\n`, {mode: 0o700});
  const response = await fetch(`http://127.0.0.1:${port}/api/new`, {
    method: 'POST', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'bundle-smoke', preset: 'custom', cwd: env.HOME, command: script}),
  });
  assert.equal(response.status, 200, await response.text().then(text => { logs.push(text); return text; }));
  session = 'bundle-smoke';
  const sessionToken = await until('session credential', async () => fs.readFileSync(tokenFile, 'utf8').trim());
  assert.match(sessionToken, /^ms1\./);
  const sessions = await control({op: 'list'});
  assert.ok(sessions.some(item => item.name === session));
  const agentNode = await until('session Node path', async () => fs.readFileSync(agentNodeFile, 'utf8').trim());
  assert.equal(agentNode, path.join(noNode, 'node'), 'agent PATH keeps user Node');
  const processes = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {env, encoding: 'utf8'});
  assert.equal(processes.status, 0, processes.stderr);
  const rows = processes.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean);
  const web = rows.find(row => Number(row[2]) === app.pid && row[3].includes(path.join(bundle, 'app', 'server.py')));
  assert.ok(web, 'owned bundle web process');
  const worker = rows.find(row => Number(row[2]) === Number(web[1])
    && row[3].includes(path.join(bundle, 'app', 'backend', 'dictation-service.cjs')));
  assert.ok(worker, 'owned enabled dictation worker');
  const bundledNode = path.join(bundle, 'runtime', 'node', 'bin', 'node');
  if (process.platform === 'linux') assert.equal(fs.realpathSync(`/proc/${worker[1]}/exe`), fs.realpathSync(bundledNode));
  else {
    const image = spawnSync('/bin/ps', ['-p', worker[1], '-o', 'comm='], {env, encoding: 'utf8'});
    assert.equal(image.status, 0, image.stderr); assert.equal(image.stdout.trim(), bundledNode);
  }
  const dictationHeaders = {Authorization: `Bearer ${token}`, 'Content-Type': 'audio/webm',
    'X-Mesh-Dictation-Client': randomUUID(), 'X-Mesh-Session': session,
    'X-Mesh-Created': String(sessions.find(item => item.name === session).created)};
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/transcribe/config`)).status, 401);
  const dictationConfig = await fetch(`http://127.0.0.1:${port}/api/transcribe/config`, {headers: dictationHeaders});
  assert.equal(dictationConfig.status, 200); assert.equal((await dictationConfig.json()).enabled, true);
  async function readyDictation() {
    const admitted = await fetch(`http://127.0.0.1:${port}/api/transcribe`, {method: 'POST',
      headers: {...dictationHeaders, 'X-Mesh-Request-Id': randomUUID()}, body: dictationAudio});
    assert.equal(admitted.status, 202);
    const jobURL = `http://127.0.0.1:${port}/api/transcribe/${(await admitted.json()).job_id}`;
    const job = await until('bundled dictation', async () => {
      const result = await fetch(jobURL, {headers: dictationHeaders}); assert.equal(result.status, 200);
      const value = await result.json(); return ['ready', 'error'].includes(value.state) ? value : false;
    });
    assert.ifError(whisperFailure); assert.equal(job.state, 'ready', JSON.stringify(job.error));
    assert.equal(job.text, 'bundle transcription'); return jobURL;
  }
  async function settleInserted(jobURL) {
    const result = await fetch(`${jobURL}/settle`, {method: 'POST', headers: {...dictationHeaders, 'Content-Type': 'application/json'},
      body: '{"outcome":"inserted"}'});
    assert.equal(result.status, 200); const job = await result.json();
    assert.equal(job.state, 'settled'); assert.equal(job.outcome, 'inserted');
  }
  await settleInserted(await readyDictation());
  assert.equal(whisperCalls, 1);
  const revokedJobURL = await readyDictation(); // Ready, deliberately unsettled across native logout.
  // Installation links must select our wrappers, including through ~/.local/bin,
  // rather than a source helper's /usr/bin/env python3 shebang.
  const commands = path.join(env.HOME, '.local', 'bin');
  fs.mkdirSync(commands, {recursive: true});
  for (const name of ['mesh-event', 'mesh-open', 'mesh-attach', 'mesh-rename']) {
    const wrapper = path.join(bundle, 'bin', name);
    assert.match(fs.readFileSync(wrapper, 'utf8'), /^#!\/usr\/bin\/env bash\n/);
    fs.symlinkSync(wrapper, path.join(commands, name));
  }
  // mesh-logout-all is the native program itself: an ELF or Mach-O executable, no wrapper.
  const logoutAll = path.join(bundle, 'bin', 'mesh-logout-all');
  const magic = fs.readFileSync(logoutAll).subarray(0, 4).toString('hex');
  assert.ok(['7f454c46', 'cffaedfe'].includes(magic), `bin/mesh-logout-all is not a native executable (${magic})`);
  fs.accessSync(logoutAll, fs.constants.X_OK);
  fs.symlinkSync(logoutAll, path.join(commands, 'mesh-logout-all'));
  const noPython = path.join(env.HOME, 'no-system-python');
  fs.mkdirSync(noPython);
  fs.writeFileSync(path.join(noPython, 'python3'), '#!/bin/sh\nexit 89\n', {mode: 0o700});
  const attached = spawnSync(path.join(commands, 'mesh-attach'), ['-l'], {
    env: {...env, PATH: `${noPython}:/usr/bin:/bin`}, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stdout, /bundle-smoke/);
  // Through ~/.local/bin, without any Python, against the running server: every login revoked.
  const loggedOut = spawnSync(path.join(commands, 'mesh-logout-all'), [], {
    env: {...env, PATH: `${noPython}:/usr/bin:/bin`}, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(loggedOut.status, 0, loggedOut.stderr);
  assert.equal(loggedOut.stderr, '');
  assert.match(loggedOut.stdout, /^All devices are signed out \(generation \d+\)\.$/m);
  assert.equal((await fetch(revokedJobURL, {headers: dictationHeaders})).status, 404,
    'native logout revokes the previous-principal result');
  await settleInserted(await readyDictation());
  assert.equal(whisperCalls, 3, 'old reservation retired without preventing a fresh insertion');
  mcp = spawn(path.join(bundle, 'bin', 'mesh-board-mcp'), [], {
    env: {...env, MESH_SESSION_TOKEN: sessionToken}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '';
  const replies = [];
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line.trim()) replies.push(JSON.parse(line));
    }
  });
  mcp.stderr.on('data', chunk => logs.push(chunk.toString()));
  mcp.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'bundle-smoke', version: '1'},
  }}) + '\n');
  const initialized = await until('MCP initialize', async () => replies.find(reply => reply.id === 1));
  assert.ok(initialized.result, JSON.stringify(initialized));
  mcp.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  mcp.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}) + '\n');
  const listed = await until('MCP tools', async () => replies.find(reply => reply.id === 2));
  assert.ok(listed.result?.tools?.some(tool => tool.name === 'agent_inbox'), JSON.stringify(listed));
  console.log(JSON.stringify({ok: true, platform: process.platform, arch: process.arch,
    http: true, nativePty: true, projectObservation: true, rosterObservation: rosterSources.length > 0,
    workRead: true, sessionCredential: true, bundledDictation: true, bundledNode: true,
    nativeLogoutDictationRevocation: true, mcpInitialize: true, mcpTools: listed.result.tools.length}));
} catch (error) {
  // Runtime diagnostics can contain session tokens: redact before CI output.
  console.error(logs.join('').replace(/ms1\.[A-Za-z0-9._-]+/g, '[redacted]'));
  throw error;
} finally {
  mcp?.kill('SIGTERM');
  if (session) await control({op: 'kill', name: session}).catch(() => {});
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await Promise.race([new Promise(resolve => app.once('exit', resolve)), delay(5000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
  }
  if (whisper) {whisper.closeAllConnections(); await new Promise(resolve => whisper.close(resolve));}
}
JS
