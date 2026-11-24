// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The runnable checks of specs/agent-launch-options.md, one named case per invocation:
//
//   node --experimental-strip-types tools/check-launch-options.ts pi-extension
//
// Exit codes are the red-command convention of the spec: 0 when the case's assertion holds, 1 when
// it fires, 2 when the case could not run at all (unknown name, server or PTY host did not start).
// A test runner cannot serve here: `node --test` exits 1 for an assertion failure and for a load
// error alike, so a red check and a broken harness would be indistinguishable.
//
// Each case drives the real server and PTY host with a fake `pi` on PATH that records its argv, the
// way tests/codex-presets.test.ts already does. The fake switch gives agentmcp the board binary a Pi
// launch requires, so this runs without the OCaml build.

import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REPO, type Mesh, startMesh} from '../tests/mesh-server-lib.ts';
import {ptyhostArgv} from '../tests/ptyhost-command.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';

type Harness = {mesh: Mesh; host: ChildProcess; argvLog: string; cookie: string; elevation: string; output: () => string};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A mesh whose fake `pi` records its arguments, one per line, a `---` closing each launch. */
async function harness(prefix: string, enabled?: string[]): Promise<Harness> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await startHarness(scratch, prefix, enabled);
  } catch (error) {
    fs.rmSync(scratch, {recursive: true, force: true});   // a setup that fails leaves nothing behind
    throw error;
  }
}

async function startHarness(scratch: string, prefix: string, enabled?: string[]): Promise<Harness> {
  // Ownership of whatever is started stays with this function until it returns: a failure anywhere
  // below (a missing PTY host command, a refused sign-in, a socket that never appears) stops the
  // server and the host it started, so a red case never leaves a process behind.
  let mesh: Mesh | undefined;
  let host: ChildProcess | undefined;
  try {
    return await setUp();
  } catch (error) {
    host?.kill('SIGKILL');
    await mesh?.stop().catch(() => undefined);
    throw error;
  }

  async function setUp(): Promise<Harness> {
    const bin = path.join(scratch, 'bin');
    const board = path.join(scratch, 'switch', '_opam', 'bin', 'mesh-board-mcp');
    fs.mkdirSync(bin, {recursive: true});
    fs.mkdirSync(path.dirname(board), {recursive: true});
    fs.writeFileSync(board, '#!/bin/sh\nexit 0\n', {mode: 0o755});
    const argvLog = path.join(scratch, 'argv.log');
    // `pi --version` is how pimcp checks the agent it is about to launch: answer it, record the rest.
    fs.writeFileSync(path.join(bin, 'pi'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.0; exit 0; fi\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done\nprintf -- '---\\n' >> '${argvLog}'\nexec sleep 5\n`,
      {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'codex'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}.codex'; done\nprintf -- '---\\n' >> '${argvLog}.codex'\n` +
      `printf "%s" "$MESH_SESSION_TOKEN" > ./token.tmp && mv ./token.tmp ./token\nexec sleep 5\n`, {mode: 0o755});
    const PATH = `${bin}:${process.env.PATH}`;
    const started = await startMesh(prefix, {PATH, MESH_OPAM_SWITCH: path.join(scratch, 'switch')}, (where) => {
      if (!enabled) return;
      const settings = path.join(where.scratch, 'launch-settings.json');
      fs.writeFileSync(settings, JSON.stringify({v: 1, workspace_roots: [where.home], enabled_agents: enabled}));
      where.env.MESH_LAUNCH_SETTINGS = settings;
    });
    const [hostCommand, ...hostArguments] = ptyhostArgv();
    host = spawn(hostCommand!, hostArguments, {
      cwd: REPO, stdio: 'ignore',
      env: {PATH, HOME: started.home, XDG_RUNTIME_DIR: path.join(started.home, 'run'), LANG: 'C'}});
    const login = await fetch(`${started.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token: started.token()})});
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!cookie) throw new Error('the owner could not sign in');
    const socket = path.join(started.home, 'run', 'session-mesh', 'ptyhost.sock');
    for (let attempt = 0; attempt < 150 && !fs.existsSync(socket); attempt += 1) await sleep(100);
    if (!fs.existsSync(socket)) throw new Error(`PTY host did not start:\n${started.output().slice(-2000)}`);
    mesh = started;   // from here on the harness owns both processes
    return {mesh: started, host, argvLog, cookie, elevation: '', output: started.output};
  }
}

const headers = (mesh: Mesh) => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const ownerHeaders = (h: Harness, elevated = true) => ({Cookie: elevated && h.elevation ? `${h.cookie}; ${h.elevation}` : h.cookie,
  Origin: h.mesh.base, 'Content-Type': 'application/json'});

async function elevate(h: Harness): Promise<void> {
  const response = await fetch(`${h.mesh.base}/api/config/elevate`, {method: 'POST', headers: ownerHeaders(h, false),
    body: JSON.stringify({token: h.mesh.token()})});
  if (response.status !== 200) throw new Error(`elevation refused: ${response.status}`);
  h.elevation = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (!h.elevation) throw new Error('no elevation cookie');
}

async function launchProjection(h: Harness): Promise<Record<string, any>> {
  const response = await fetch(`${h.mesh.base}/api/config`, {headers: ownerHeaders(h)});
  if (response.status !== 200) throw new Error(`config refused: ${response.status}`);
  return ((await response.json()) as {launch: Record<string, any>}).launch;
}

async function saveOptions(h: Harness, agentOptions: Record<string, string>, revision?: string): Promise<{status: number; body: Record<string, any>; text: string}> {
  const current = revision ?? (await launchProjection(h)).agent_options_revision;
  const response = await fetch(`${h.mesh.base}/api/config/launch-options`, {method: 'POST', headers: ownerHeaders(h),
    body: JSON.stringify({revision: current, agent_options: agentOptions})});
  const text = await response.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text) as Record<string, any>; } catch { body = {}; }
  return {status: response.status, body, text};
}


async function agentToken(h: Harness, name: string): Promise<string> {
  const folder = path.join(h.mesh.home, name);
  fs.mkdirSync(folder, {recursive: true});
  const answer = await launch(h.mesh, {preset: 'codex', name, cwd: folder});
  assert.equal(answer.status, 200, answer.text);
  const file = path.join(folder, 'token');
  for (let attempt = 0; attempt < 200 && !fs.existsSync(file); attempt += 1) await sleep(100);
  if (!fs.existsSync(file)) throw new Error('the fake codex did not record a session token');
  return fs.readFileSync(file, 'utf8').trim();
}

async function requestCreate(h: Harness, token: string, body: Record<string, unknown>): Promise<{status: number; text: string; request?: Record<string, any>}> {
  const response = await fetch(`${h.mesh.base}/api/session-actions/@self/request`, {method: 'POST',
    headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = {}; }
  return {status: response.status, text, request: (parsed.request as Record<string, any>) ?? undefined};
}

/** The owner approves a pending request the way the page does: claim (renewing an existing lease with
 *  its nonce), then decide with the options revision the confirmation showed. */
async function approve(h: Harness, id: string, optionsRevision?: string,
                       claimNonce?: string): Promise<{status: number; nonce: string}> {
  const claim = await fetch(`${h.mesh.base}/api/session-actions/${id}/claim`, {method: 'POST', headers: ownerHeaders(h, false),
    body: JSON.stringify({tab_nonce: 'c'.repeat(32), ...(claimNonce ? {claim_nonce: claimNonce} : {})})});
  const nonce = ((await claim.json()) as {claim_nonce?: string}).claim_nonce;
  if (!nonce) throw new Error(`claim refused: ${claim.status}`);
  const decided = await fetch(`${h.mesh.base}/api/session-actions/${id}/decision`, {method: 'POST', headers: ownerHeaders(h, false),
    body: JSON.stringify({approve: true, claim_nonce: nonce,
      ...(optionsRevision === undefined ? {} : {options_revision: optionsRevision})})});
  return {status: decided.status, nonce};
}

/** The pending requests the page receives with a listing. */
async function pendingRequests(h: Harness): Promise<Record<string, any>[]> {
  const response = await fetch(`${h.mesh.base}/api/sessions`, {headers: headers(h.mesh)});
  const data = await response.json() as {sessionRequests?: Record<string, any>[]};
  return data.sessionRequests ?? [];
}

async function launch(mesh: Mesh, body: Record<string, unknown>): Promise<{status: number; text: string}> {
  const cwd = fs.mkdtempSync(path.join(mesh.home, 'folder-'));
  const response = await fetch(`${mesh.base}/api/new`, {
    method: 'POST', headers: headers(mesh), body: JSON.stringify({cwd, ...body})});
  return {status: response.status, text: await response.text()};
}

/** The argv blocks the fake `pi` recorded so far. */
function recorded(file: string): string[][] {
  if (!fs.existsSync(file)) return [];
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line === '---') { blocks.push(current); current = []; } else if (line) current.push(line);
  }
  return blocks;
}

async function waitRecorded(file: string, count: number): Promise<string[][]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocks = recorded(file);
    if (blocks.length >= count) return blocks;
    await sleep(100);
  }
  throw new Error(`the fake pi recorded ${recorded(file).length} launch(es), expected ${count}`);
}

/** The text the owner's confirmation shows for a pending request, from the page's own module. */
async function described(request: Record<string, any>): Promise<string> {
  setTranslator((key: string, params?: Record<string, string | number>) => {
    const templates: Record<string, string> = {
      'paneActions.sessionRequest.create': 'Create a {preset} session for {agent}',
      'paneActions.sessionRequest.createWithModel': 'Create a {preset} session for {agent} with model {model}',
      'paneActions.sessionRequest.withOptions': '{text} (options: {options})',
      'paneActions.sessionRequest.confirm': '{description}',
    };
    const template = templates[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''));
  });
  let shown = '';
  const gate = createSessionRequestGate({claim: async () => ({kind: 'claimed', claimNonce: 'n'.repeat(32)}),
    confirm: (message: string) => { shown = message; return false; }, decide: async () => 'settled', notify: () => {}});
  await gate.consider([{id: 'x', action: 'create', state: 'pending', preset: request.preset, model: request.model ?? null,
    options: request.options, source: {id: request.source?.id ?? 'agent'}}]);
  return shown;
}

export const CASES: Record<string, (h: Harness) => Promise<void>> = {
  // CHECK-1 [AC-1]: the owner's extension composes with the two the server injects.
  async 'pi-extension'(h) {
    const answer = await launch(h.mesh, {preset: 'pi', options: '-e /tmp/ext.mjs'});
    assert.equal(answer.status, 200, answer.text);
    const [argv] = await waitRecorded(h.argvLog, 1);
    const wake = argv!.indexOf('--extension');
    assert.notEqual(wake, -1, `no --extension in ${JSON.stringify(argv)}`);
    assert.ok(argv![wake + 1]!.endsWith('pi_mesh_wake.mjs'), argv![wake + 1]);
    assert.deepEqual(argv!.slice(-4), ['-e', 'builtin:mcp', '-e', '/tmp/ext.mjs'], JSON.stringify(argv));
  },

  // CHECK-5 [AC-5]: the field is bounded, and an empty one changes nothing.
  async 'token-bounds'(h) {
    const tooMany = Array.from({length: 33}, (_, index) => `--flag${index}`).join(' ');
    for (const [options, why] of [
      ['-e /tmp/a.mjs\nrm -rf ~', 'a newline'],
      [tooMany, '33 tokens'],
      [`--name ${'x'.repeat(520)}`, 'a 513-byte token'],
      ['-e "/tmp/unbalanced', 'an unbalanced quote'],
      ['--name ""', 'an empty token, which the options file refuses to load'],
    ] as const) {
      const answer = await launch(h.mesh, {preset: 'pi', options});
      assert.equal(answer.status, 400, `${why}: ${answer.status} ${answer.text}`);
    }
    const empty = await launch(h.mesh, {preset: 'pi', options: ''});
    assert.equal(empty.status, 200, empty.text);
    const [argv] = await waitRecorded(h.argvLog, 1);
    assert.equal(argv!.filter(token => token === '/tmp/ext.mjs').length, 0, JSON.stringify(argv));
    assert.ok(argv!.includes('builtin:mcp'), JSON.stringify(argv));
  },

  // CHECK-6 [AC-6]: every form of the refused class stops the launch, and nothing is spawned.
  async 'refused-forms'(h) {
    for (const [preset, options, mention] of [
      ['codex', '--yolo', '--yolo'],
      ['codex', 'hello --yolo', '--yolo'],
      ['codex', 'hello -a never', '-a'],
      ['codex', '--sandbox=danger-full-access', '--sandbox'],
      ['codex', '-a=never', '-a'],
      ['codex', '-c approval_policy="never"', '-c'],
      ['claude', '--session-id 6f1e6f9c-0000-4000-8000-000000000000', '--session-id'],
      ['pi', '--session abc', '--session'],
    ] as const) {
      const answer = await launch(h.mesh, {preset, options});
      assert.equal(answer.status, 400, `${preset} ${options}: ${answer.status} ${answer.text}`);
      assert.ok(answer.text.includes(mention), `${preset} ${options}: ${answer.text}`);
    }
    const subcommand = await launch(h.mesh, {preset: 'codex', options: 'resume'});
    assert.equal(subcommand.status, 400, `resume: ${subcommand.text}`);
    assert.equal(recorded(h.argvLog).length, 0, 'a refused option must not spawn anything');
  },

  // CHECK-7 [AC-7]: a token with a space stays one argument through the Pi rewrite.
  async 'pi-quoting'(h) {
    const answer = await launch(h.mesh, {preset: 'pi', options: '--name "two words"'});
    assert.equal(answer.status, 200, answer.text);
    const [argv] = await waitRecorded(h.argvLog, 1);
    const name = argv!.indexOf('--name');
    assert.notEqual(name, -1, JSON.stringify(argv));
    assert.equal(argv![name + 1], 'two words', JSON.stringify(argv));
    assert.equal(argv!.filter(token => token === 'two words').length, 1, JSON.stringify(argv));
  },

  // CHECK-8 [AC-8]: the refused class cannot be stored, and a refused write leaves the file alone.
  async 'refuse-yolo-write'(h) {
    await elevate(h);
    const file = path.join(h.mesh.confDir, 'agent-launch-options.json');
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const answer = await saveOptions(h, {codex: 'hello --yolo'});
    assert.equal(answer.status, 400, `status ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.text, /--yolo/, answer.text);
    const after = fs.existsSync(file) ? fs.readFileSync(file) : null;
    assert.deepEqual(after, before, 'a refused write must not touch the file');
  },

  // CHECK-16 [AC-16]: the stored default runs on the next launch with an empty field.
  async 'default-applies'(h) {
    await elevate(h);
    const saved = await saveOptions(h, {pi: '-e /tmp/stored.mjs'});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.launch.agent_options.pi, '-e /tmp/stored.mjs');
    const answer = await launch(h.mesh, {preset: 'pi'});
    assert.equal(answer.status, 200, answer.text);
    const [argv] = await waitRecorded(h.argvLog, 1);
    assert.ok(argv!.includes('builtin:mcp'), JSON.stringify(argv));
    assert.deepEqual(argv!.slice(-2), ['-e', '/tmp/stored.mjs'], JSON.stringify(argv));
    assert.equal(argv!.filter(token => token === '/tmp/stored.mjs').length, 1,
      `the stored default must reach the argv once: ${JSON.stringify(argv)}`);
    // And a launch that also types options adds them after the stored ones, not instead.
    const withExtra = await launch(h.mesh, {preset: 'pi', options: '-e /tmp/extra.mjs'});
    assert.equal(withExtra.status, 200, withExtra.text);
    const launches = await waitRecorded(h.argvLog, 2);
    assert.deepEqual(launches[1]!.slice(-4), ['-e', '/tmp/stored.mjs', '-e', '/tmp/extra.mjs'], JSON.stringify(launches[1]));
  },

  // CHECK-4 [AC-4]: two writers from the same revision; the second is refused and the first value stays.
  async 'stale-revision'(h) {
    await elevate(h);
    const first = await saveOptions(h, {pi: '-e /tmp/one.mjs'}, '');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await saveOptions(h, {pi: '-e /tmp/two.mjs'}, '');
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error, 'stale-revision');
    assert.ok(typeof second.body.revision === 'string' && second.body.revision.length === 64, JSON.stringify(second.body));
    assert.equal((await launchProjection(h)).agent_options.pi, '-e /tmp/one.mjs');
  },

  // CHECK-9 [AC-9]: owner cookie, elevation and a bounded body, in that order.
  async 'write-authorization'(h) {
    const withoutElevation = await saveOptions(h, {pi: '-e /tmp/x.mjs'});
    assert.equal(withoutElevation.status, 403, JSON.stringify(withoutElevation.body));
    assert.equal(withoutElevation.body.error, 'elevation-required');
    const bearer = await fetch(`${h.mesh.base}/api/config/launch-options`, {method: 'POST',
      headers: headers(h.mesh), body: JSON.stringify({revision: '', agent_options: {pi: '-e /tmp/x.mjs'}})});
    assert.equal(bearer.status, 401, await bearer.text());
    const foreign = await fetch(`${h.mesh.base}/api/config/launch-options`, {method: 'POST',
      headers: {...ownerHeaders(h), Origin: 'https://evil.example'}, body: JSON.stringify({revision: '', agent_options: {}})});
    assert.equal(foreign.status, 403, await foreign.text());
    await elevate(h);
    const oversized = await saveOptions(h, {pi: `-e /tmp/${'x'.repeat(40000)}.mjs`});
    assert.equal(oversized.status, 413, JSON.stringify(oversized.body));
  },

  // CHECK-3 [AC-3]: a default that cannot be written does not stop the launch.
  async 'default-write-fails'(h) {
    await elevate(h);
    const mode = fs.statSync(h.mesh.confDir).mode & 0o777;
    fs.chmodSync(h.mesh.confDir, 0o500);
    try {
      const answer = await launch(h.mesh, {preset: 'codex', options: '--search'});
      assert.equal(answer.status, 200, `the launch must not depend on the save: ${answer.text}`);
      const saved = await saveOptions(h, {pi: '-e /tmp/x.mjs'});
      assert.equal(saved.status, 500, JSON.stringify(saved.body));
      assert.equal(saved.body.error, 'unwritable');
    } finally {
      fs.chmodSync(h.mesh.confDir, mode);
    }
    assert.equal(recorded(h.argvLog).length, 0, 'the Pi fake recorded nothing: only Codex started');
  },

  // CHECK-13 [AC-13]: an entry for a preset the settings do not enable is stored but never applied.
  async 'disabled-preset-entry'() {
    // A mesh whose launch settings enable Claude only: the stored entry for Pi stays on disk but must
    // never be applied, and Pi stays refused to the owner.
    const restricted = await harness('check-launch-options-disabled-', ['claude']);
    try {
      await elevate(restricted);
      const saved = await saveOptions(restricted, {pi: '-e /tmp/stored.mjs'});
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const refused = await launch(restricted.mesh, {preset: 'pi'});
      assert.equal(refused.status, 400, refused.text);
      assert.match(refused.text, /Unknown or disabled preset/);
      assert.equal(recorded(restricted.argvLog).length, 0, 'nothing may be spawned for a disabled preset');
    } finally {
      restricted.host.kill('SIGKILL');
      await Promise.race([restricted.mesh.halt(true).catch(() => undefined), sleep(15_000)]);
      fs.rmSync(path.dirname(restricted.mesh.confDir), {recursive: true, force: true});
    }
  },

  // CHECK-11 [AC-11]: an agent cannot supply option tokens; the body is refused and nothing is queued.
  async 'agent-supplied-options'(h) {
    const token = await agentToken(h, 'requester-options');
    const answer = await requestCreate(h, token, {action: 'create', preset: 'pi', options: '-e /tmp/x.mjs'});
    assert.equal(answer.status, 400, answer.text);
    assert.equal((await pendingRequests(h)).length, 0, 'no request may be created');
    assert.equal(recorded(h.argvLog).length, 0, 'nothing may be launched');
  },

  // CHECK-10 [AC-10]: the owner's confirmation names the tokens, and the approved launch runs them.
  async 'consent-projection'(h) {
    await elevate(h);
    const saved = await saveOptions(h, {pi: '-e /tmp/stored.mjs'});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const token = await agentToken(h, 'requester-consent');
    const asked = await requestCreate(h, token, {action: 'create', preset: 'pi', name: 'wanted-pi'});
    assert.equal(asked.status, 202, asked.text);
    const pending = (await pendingRequests(h)).find(item => item.id === asked.request?.id);
    assert.ok(pending, 'the pending request reaches the page');
    assert.equal(pending.options, '-e /tmp/stored.mjs', JSON.stringify(pending));
    const text = await described(pending);
    assert.match(text, /-e \/tmp\/stored\.mjs/, text);
    assert.equal((await approve(h, asked.request!.id, pending.options_revision)).status, 200);
    const [argv] = await waitRecorded(h.argvLog, 1);
    assert.deepEqual(argv!.slice(-2), ['-e', '/tmp/stored.mjs'], JSON.stringify(argv));
  },

  // CHECK-2 [AC-2]: a model the agent asks for wins over a stored --model.
  async 'requested-model-wins'(h) {
    await elevate(h);
    const saved = await saveOptions(h, {codex: '--model old'});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const token = await agentToken(h, 'requester-model');
    const asked = await requestCreate(h, token, {action: 'create', preset: 'codex', model: 'gpt-5', name: 'wanted-codex'});
    assert.equal(asked.status, 202, asked.text);
    assert.equal((await approve(h, asked.request!.id)).status, 200);
    for (let attempt = 0; attempt < 200 && recorded(`${h.argvLog}.codex`).length < 2; attempt += 1) await sleep(100);
    const launches = recorded(`${h.argvLog}.codex`);
    const argv = launches[launches.length - 1]!;
    const model = argv!.indexOf('--model');
    assert.notEqual(model, -1, JSON.stringify(argv));
    assert.equal(argv![model + 1], 'gpt-5', JSON.stringify(argv));
    assert.ok(!argv!.includes('old'), JSON.stringify(argv));
  },

  // CHECK-16 [AC-16]: an approval names the options revision it saw. A save in between makes the
  // server refuse (409) instead of launching arguments the confirmation did not show; the request
  // stays claimed, and approving again with the current revision runs exactly the new tokens.
  async 'approval-bound-to-options'(h) {
    await elevate(h);
    assert.equal((await saveOptions(h, {pi: '-e /tmp/before.mjs'})).status, 200);
    const token = await agentToken(h, 'requester-revision');
    const asked = await requestCreate(h, token, {action: 'create', preset: 'pi', name: 'revision-pi'});
    assert.equal(asked.status, 202, asked.text);
    const shown = (await pendingRequests(h)).find(item => item.id === asked.request?.id);
    assert.ok(shown, 'the pending request reaches the page');
    assert.equal(shown.options, '-e /tmp/before.mjs', JSON.stringify(shown));
    // The owner saves another default after the confirmation was shown.
    const changed = await saveOptions(h, {pi: '-e /tmp/after.mjs'}, shown.options_revision);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.notEqual(changed.body.launch.agent_options_revision, shown.options_revision);
    const refused = await approve(h, asked.request!.id, shown.options_revision);
    assert.equal(refused.status, 409, 'an approval whose options changed must be refused');
    assert.equal(recorded(h.argvLog).length, 0, 'nothing may be launched by the refused approval');
    const fresh = (await pendingRequests(h)).find(item => item.id === asked.request?.id);
    assert.equal(fresh?.options, '-e /tmp/after.mjs', JSON.stringify(fresh));
    assert.equal((await approve(h, asked.request!.id, fresh!.options_revision, refused.nonce)).status, 200);
    const [argv] = await waitRecorded(h.argvLog, 1);
    assert.deepEqual(argv!.slice(-2), ['-e', '/tmp/after.mjs'], JSON.stringify(argv));
  },

  // CHECK-17 [AC-5]: an argument that shlex empties ("--name \"\"") is refused before it is stored,
  // so the file can never hold what the startup parser rejects.
  async 'empty-token'(h) {
    await elevate(h);
    for (const options of ['--name ""', "-e ''"]) {
      const answer = await saveOptions(h, {pi: options});
      assert.equal(answer.status, 400, `${options}: ${answer.status} ${answer.text}`);
    }
    const launched = await launch(h.mesh, {preset: 'pi', options: '--name ""'});
    assert.equal(launched.status, 400, launched.text);
    assert.equal(fs.existsSync(path.join(h.mesh.confDir, 'agent-launch-options.json')), false,
      'a refused save writes nothing');
  },

  // CHECK-18 [AC-6]: every agent's conversation-selection options are refused, and a Codex subcommand
  // hidden behind a valueless flag (--search resume) is still read as a subcommand.
  async 'conversation-options-per-agent'(h) {
    for (const [preset, options] of [['opencode', '--session ses_12'], ['opencode', '--continue'],
      ['gemini', '--resume'], ['copilot', '--resume'], ['agy', '--conversation x'],
      ['codex', '--search resume'], ['codex', '--debug exec']] as const) {
      const answer = await launch(h.mesh, {preset, options});
      assert.equal(answer.status, 400, `${preset} ${options}: ${answer.status} ${answer.text}`);
    }
    const allowed = await launch(h.mesh, {preset: 'codex', options: '--search'});
    assert.equal(allowed.status, 200, allowed.text);
  },

  // CHECK-15 [AC-15]: the stored options cannot reach a reopen. The reopen paths (resume, restore,
  // move-in) rebuild a conversation's own argv and read AGENT_PRESETS; the compositor is the only
  // place owner options enter a launch, so this asserts it is called from the two fresh-launch sites
  // and from nowhere near a reopen. It is a source invariant, not a runtime observation: the resume
  // path needs a real provider conversation, which this harness cannot produce.
  async 'resume-untouched'() {
    const source = fs.readFileSync(path.join(REPO, 'server.py'), 'utf8').split('\n');
    const calls = source.map((line, index) => ({line, number: index + 1}))
      .filter(({line}) => /\beffective_launch\(/.test(line) && !/^def /.test(line));
    assert.equal(calls.length, 2, `effective_launch is called ${calls.length} time(s): ${JSON.stringify(calls)}`);
    for (const {line, number} of calls) {
      assert.ok(!/resum|respawn|new_session\(/.test(line), `line ${number} reopens a conversation: ${line.trim()}`);
    }
    const presets = source.filter((line) => /AGENT_PRESETS\s*=/.test(line));
    assert.ok(presets.length >= 1, 'AGENT_PRESETS is assigned somewhere');
    assert.ok(!presets.some((line) => /AGENT_OPTIONS|stored_options/.test(line)),
      `the stored options must never be spliced into AGENT_PRESETS: ${JSON.stringify(presets)}`);
  },
};

/** One named case, with its own throwaway mesh; a failure is the assertion that fired. */
export async function runCase(name: string): Promise<void> {
  const run = CASES[name];
  if (!run) throw new Error(`unknown case: ${name}`);
  const h = await harness(`check-launch-options-${name}-`);
  try {
    await run(h);
  } finally {
    await teardown(h);
  }
}

/** Stop what a case started, in bounded time: the PTY host first (nothing new to run), then the web
 *  server with the hurry signal, so a request that is still in flight cannot keep it alive. A test
 *  runner that waits forever on a stopped process is what made this suite hang in CI. */
async function teardown(h: Harness): Promise<void> {
  h.host.kill('SIGKILL');
  const stopped = h.mesh.halt(true).catch(() => undefined);
  await Promise.race([stopped, sleep(15_000)]);
  fs.rmSync(path.dirname(h.mesh.confDir), {recursive: true, force: true});
}

async function main(): Promise<number> {
  const name = process.argv[2] ?? '';
  const run = CASES[name];
  if (!run) {
    console.error(`unknown case: ${name || '(none)'}\nknown cases: ${Object.keys(CASES).join(', ')}`);
    return 2;
  }
  let h: Harness | undefined;
  try {
    h = await harness(`check-launch-options-${name}-`);
    await run(h);
    console.log(`ok ${name}`);
    return 0;
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      console.error(`red ${name}: ${error.message}`);
      return 1;
    }
    console.error(`error ${name}: ${(error as Error)?.message ?? error}`);
    console.error(h ? h.output().slice(-3000) : '');
    return 2;
  } finally {
    if (h) await teardown(h);
  }
}

// Only when run as a program: tests/launch-options-checks.test.ts imports the cases.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
