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

type Harness = {mesh: Mesh; host: ChildProcess; argvLog: string; output: () => string};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A mesh whose fake `pi` records its arguments, one per line, a `---` closing each launch. */
async function harness(prefix: string): Promise<Harness> {
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
  const PATH = `${bin}:${process.env.PATH}`;
  const mesh = await startMesh(prefix, {PATH, MESH_OPAM_SWITCH: path.join(scratch, 'switch')});
  const [hostCommand, ...hostArguments] = ptyhostArgv();
  const host = spawn(hostCommand!, hostArguments, {
    cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C'}});
  const socket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
  for (let attempt = 0; attempt < 150 && !fs.existsSync(socket); attempt += 1) await sleep(100);
  if (!fs.existsSync(socket)) throw new Error(`PTY host did not start:\n${mesh.output().slice(-2000)}`);
  return {mesh, host, argvLog, output: mesh.output};
}

const headers = (mesh: Mesh) => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});

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
