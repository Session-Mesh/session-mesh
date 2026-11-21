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
import {REPO, type Mesh, startMesh} from '../tests/mesh-server-lib.ts';
import {ptyhostArgv} from '../tests/ptyhost-command.ts';

type Harness = {mesh: Mesh; host: ChildProcess; argvLog: string; cookie: string; elevation: string; output: () => string};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A mesh whose fake `pi` records its arguments, one per line, a `---` closing each launch. */
async function harness(prefix: string, enabled?: string[]): Promise<Harness> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(scratch, 'bin');
  const board = path.join(scratch, 'switch', '_opam', 'bin', 'mesh-board-mcp');
  fs.mkdirSync(bin, {recursive: true});
  fs.mkdirSync(path.dirname(board), {recursive: true});
  fs.writeFileSync(board, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const argvLog = path.join(scratch, 'argv.log');
  // `pi --version` is how pimcp checks the agent it is about to launch: answer it, record the rest.
  fs.writeFileSync(path.join(bin, 'pi'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.0; exit 0; fi\n` +
    `for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done\nprintf -- '---\\n' >> '${argvLog}'\nexec sleep 30\n`,
    {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 30\n', {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  const mesh = await startMesh(prefix, {PATH, MESH_OPAM_SWITCH: path.join(scratch, 'switch')}, (where) => {
    if (!enabled) return;
    const settings = path.join(where.scratch, 'launch-settings.json');
    fs.writeFileSync(settings, JSON.stringify({v: 1, workspace_roots: [where.home], enabled_agents: enabled}));
    where.env.MESH_LAUNCH_SETTINGS = settings;
  });
  const [hostCommand, ...hostArguments] = ptyhostArgv();
  const host = spawn(hostCommand!, hostArguments, {
    cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C'}});
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({token: mesh.token()})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('the owner could not sign in');
  const socket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
  for (let attempt = 0; attempt < 150 && !fs.existsSync(socket); attempt += 1) await sleep(100);
  if (!fs.existsSync(socket)) throw new Error(`PTY host did not start:\n${mesh.output().slice(-2000)}`);
  return {mesh, host, argvLog, cookie, elevation: '', output: mesh.output};
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

const CASES: Record<string, (h: Harness) => Promise<void>> = {
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
    const answer = await saveOptions(h, {codex: '--yolo'});
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
      await restricted.mesh.stop();
    }
  },
};

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
    h?.host.kill('SIGKILL');
    await h?.mesh.stop();
  }
}

process.exitCode = await main();
