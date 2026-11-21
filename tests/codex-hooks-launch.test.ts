// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Codex launches carry Mesh's read-only project context hook as a per-run override (docs/agent-hooks.md,
// "Codex"): `-c hooks.SessionStart=[...]` naming `work-read context --format codex`, never a token or a session
// name, on the fresh launch of both presets, on a resume, and under an account alias (whose CODEX_HOME holds its
// own trust); none when MESH_PROJECT_HOOKS=0 or work-read is not installed. A fake `codex` on PATH records its
// arguments one per line. The alias and resume cases need `mesh-platform` (MESH_MESH_PLATFORM_CMD or the dune
// build), as tests/session-accounts.test.ts does; MESH_REQUIRE_MESH_PLATFORM=1 makes its absence a failure.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const NO_PLATFORM = fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;
const CODEX_CREDENTIALS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];

/** The one override Mesh adds for an installation whose programs are in ``bin``. */
const hookItem = (bin: string) =>
  `hooks.SessionStart=[{hooks=[{type="command",command="${bin}/work-read context --format codex",timeout=5}]}]`;

type Launch = {codexHome: string; token: string; credentials: string[]; args: string[]};

// The fake codex: one file per launch, named after the Mesh session, written once complete. Like
// tests/session-accounts.test.ts, it writes a rollout under its Codex home and keeps it open as a process named
// codex, so that the listing knows its conversation and a restart request resumes it.
const fakeCodex = (logs: string, real: string) => [
  '#!/bin/sh',
  `out='${logs}'/"$MESH_SESSION.$$"`,
  '{ printf "home=%s\\n" "${CODEX_HOME-unset}"; printf "token=%s\\n" "$MESH_SESSION_TOKEN"',
  `  env | cut -d= -f1 | grep -E '^(${CODEX_CREDENTIALS.join('|')})$' | sed 's/^/credential=/'`,
  '  for a in "$@"; do printf "arg=%s\\n" "$a"; done; } > "$out.tmp" && mv "$out.tmp" "$out.log"',
  'if [ "$1" = resume ]; then id=$2; else id=$(cat /proc/sys/kernel/random/uuid); fi',
  'folder="${CODEX_HOME:-$HOME/.codex}/sessions/2026/11/21"; mkdir -p "$folder"',
  'rollout="$folder/rollout-2026-11-21T10-00-00-$id.jsonl"',
  `printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\\n' "$id" "$PWD" >> "$rollout"`,
  `exec 3<"$rollout"; exec '${real}/codex' 300`, ''].join('\n');

type Rig = {mesh: Mesh; host: ChildProcess; bin: string; logs: string; root: string; cookie: string};

async function rig(prefix: string, extra: NodeJS.ProcessEnv): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(root, 'bin');          // MESH_BIN_DIR: stand-ins for work-read and the board bridge
  const fake = path.join(root, 'fake');
  const real = path.join(root, 'real');
  const logs = path.join(root, 'logs');
  for (const directory of [bin, fake, real, logs]) fs.mkdirSync(directory);
  for (const program of ['work-read', 'mesh-board-mcp']) fs.writeFileSync(path.join(bin, program), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.copyFileSync(fs.realpathSync('/bin/sleep'), path.join(real, 'codex'));
  fs.chmodSync(path.join(real, 'codex'), 0o755);
  fs.writeFileSync(path.join(fake, 'codex'), fakeCodex(logs, real), {mode: 0o755});
  const PATH = `${fake}:${process.env.PATH}`;
  const mesh = await startMesh(`${prefix}mesh-`, {PATH, MESH_BIN_DIR: bin, MESH_MESH_PLATFORM_CMD: PLATFORM,
    CODEX_HOME: undefined, MESH_PROJECT_HOOKS: undefined, ...extra});
  // The default account's credentials, exported by the login shell every session starts.
  fs.writeFileSync(path.join(mesh.home, '.profile'), CODEX_CREDENTIALS.map(name => `export ${name}=profile-${name}\n`).join('')
    + `export PATH='${fake.replace(/'/g, "'\\''")}':"$PATH"\n`);
  const [command, ...args] = ptyhostArgv();
  const host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: '/bin/sh'}});
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  return {mesh, host, bin, logs, root, cookie};
}

async function release(rigged: Rig | undefined): Promise<void> {
  if (!rigged) return;
  rigged.host.kill('SIGKILL');
  await rigged.mesh.stop();
  fs.rmSync(rigged.root, {recursive: true, force: true});
}

const headers = (rigged: Rig) => ({Authorization: `Bearer ${rigged.mesh.token()}`, Origin: rigged.mesh.base,
  'Content-Type': 'application/json'});

function readLaunch(file: string): Launch {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const values = (key: string) => lines.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1));
  return {codexHome: values('home')[0]!, token: values('token')[0]!, credentials: values('credential'), args: values('arg')};
}

/** The launch the fake codex recorded for the Mesh session ``name`` (the ``index``-th one, in start order). */
async function launchOf(rigged: Rig, name: string, index = 0): Promise<Launch> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const files = fs.readdirSync(rigged.logs).filter(file => file.startsWith(`${name}.`) && file.endsWith('.log'))
      .map(file => path.join(rigged.logs, file)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    if (files[index]) return readLaunch(files[index]);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fake codex never started for ${name}`);
}

async function create(rigged: Rig, body: Record<string, unknown>): Promise<Launch> {
  const response = await fetch(`${rigged.mesh.base}/api/new`, {method: 'POST', headers: headers(rigged),
    body: JSON.stringify({cwd: rigged.mesh.home, ...body})});
  assert.equal(response.status, 200, await response.clone().text());
  return launchOf(rigged, String(body.name));
}

/** The values of every ``-c``/``--config`` item of argv that sets a ``hooks`` key. */
function hookItems(args: string[]): string[] {
  const items: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    const value = word === '-c' || word === '--config' ? args[index + 1] : word.startsWith('--config=') ? word.slice(9)
      : word.startsWith('-c') && word.length > 2 ? word.slice(2).replace(/^=/, '') : undefined;
    if (value !== undefined && /^\s*"?hooks"?\s*[.=]/.test(value)) items.push(value);
  }
  return items;
}

function assertNoSecret(launch: Launch): void {
  assert.ok(launch.token.length > 0, 'the session has a token');
  const text = launch.args.join('\n');
  assert.ok(!text.includes(launch.token), 'no token value on the command line');
  for (const name of ['MESH_SESSION_TOKEN', 'MESH_SESSION', 'WL_SESSION']) {
    assert.ok(!hookItems(launch.args).some(item => item.includes(name)), `no ${name} in the hook override`);
  }
}

describe('Codex launches carry the project context hook', () => {
  let rigged: Rig | undefined;
  before(async () => { rigged = await rig('codex-hooks-', {}); });
  after(async () => release(rigged));

  test('the Codex preset passes exactly the read-only SessionStart hook, after the other options', async () => {
    const launch = await create(rigged!, {preset: 'codex', name: 'h-fresh'});
    assert.deepEqual(hookItems(launch.args), [hookItem(rigged!.bin)]);
    const at = launch.args.indexOf(hookItem(rigged!.bin));
    assert.equal(launch.args[at - 1], '-c');
    assert.deepEqual(launch.args.slice(0, 4), ['--no-alt-screen', '-c', 'tui.raw_output_mode=false', '-c']);
    assertNoSecret(launch);
    assert.equal(launch.codexHome, 'unset', 'the default account keeps its own Codex home');
  });

  test('the no-approvals preset carries the same hook', async () => {
    const launch = await create(rigged!, {preset: 'codex-yolo', name: 'h-yolo'});
    assert.ok(launch.args.includes('--yolo'));
    assert.deepEqual(hookItems(launch.args), [hookItem(rigged!.bin)]);
    assertNoSecret(launch);
  });

  test('an alias launch and its resume carry it, with the alias\'s Codex home and its credentials unset',
    {skip: NO_PLATFORM}, async () => {
      const alias = path.join(rigged!.mesh.home, '.agent-accounts', 'work', '.codex');
      fs.mkdirSync(path.dirname(alias), {recursive: true, mode: 0o700});
      fs.chmodSync(path.dirname(path.dirname(alias)), 0o700);
      fs.writeFileSync(path.join(rigged!.mesh.confDir, 'accounts.json'),
        JSON.stringify({v: 1, accounts: [{id: 'work', label: 'Work', codex_home: alias}]}), {mode: 0o600});
      const launch = await create(rigged!, {preset: 'codex', name: 'h-alias', account: 'work'});
      assert.equal(launch.codexHome, alias);
      assert.deepEqual(launch.credentials, [], 'env -u removed the profile\'s Codex credentials');
      assert.deepEqual(hookItems(launch.args), [hookItem(rigged!.bin)]);
      assertNoSecret(launch);

      let sid = '';
      for (let attempt = 0; attempt < 100 && !sid; attempt += 1) {
        const data = await (await fetch(`${rigged!.mesh.base}/api/sessions`, {headers: headers(rigged!)})).json() as
          {mesh: {id: string; agent?: {session_id?: string} | null}[]};
        sid = data.mesh.find(item => item.id === 'h-alias')?.agent?.session_id ?? '';
        if (!sid) await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(sid, 'the fake codex is listed with its conversation');
      const owner = {Cookie: rigged!.cookie, Origin: rigged!.mesh.base, 'Content-Type': 'application/json'};
      const made = await fetch(`${rigged!.mesh.base}/api/session-actions/@self/request`, {method: 'POST',
        headers: {Authorization: `MeshSession ${launch.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'restart'})});
      assert.equal(made.status, 202, await made.clone().text());
      const {request} = await made.json() as {request: {id: string}};
      const claimed = await fetch(`${rigged!.mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST',
        headers: owner, body: JSON.stringify({tab_nonce: 'a'.repeat(32)})});
      const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
      const decided = await fetch(`${rigged!.mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST',
        headers: owner, body: JSON.stringify({approve: true, claim_nonce: claimNonce})});
      const result = (await decided.json() as {request: {result: {id?: string; error?: string}}}).request.result;
      assert.equal(result.id, 'h-alias', `restarted in the same session: ${JSON.stringify(result)}`);
      const resumed = await launchOf(rigged!, result.id, 1);   // the second launch of that session
      assert.deepEqual(resumed.args.slice(0, 2), ['resume', sid]);
      assert.equal(resumed.codexHome, alias, 'the resume runs under the alias\'s Codex home');
      assert.deepEqual(resumed.credentials, []);
      assert.deepEqual(hookItems(resumed.args), [hookItem(rigged!.bin)], 'exactly one hook item on the resume');
      assertNoSecret(resumed);
    });
});

describe('MESH_PROJECT_HOOKS=0', () => {
  let rigged: Rig | undefined;
  before(async () => { rigged = await rig('codex-hooks-off-', {MESH_PROJECT_HOOKS: '0'}); });
  after(async () => release(rigged));

  test('a Codex launch carries no hook override', async () => {
    for (const [preset, name] of [['codex', 'o-fresh'], ['codex-yolo', 'o-yolo']]) {
      const launch = await create(rigged!, {preset, name});
      assert.deepEqual(hookItems(launch.args), [], preset);
      assert.ok(launch.args.includes('tui.raw_output_mode=false'), 'the launch is otherwise the usual one');
    }
  });
});

// The generator itself (agentmcp.inject), on argv a saved or restored command can hold.
function inject(argv: string[], env: Record<string, string>): string[] {
  const script = String.raw`
import json, os, sys
sys.path.insert(0, os.environ["REPO"])
import agentmcp
print(json.dumps(agentmcp.inject("codex", json.loads(sys.argv[1]))))
`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script, JSON.stringify(argv)], {
    encoding: 'utf8', env: {PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: process.env.TMPDIR ?? '/tmp', REPO, ...env},
  })) as string[];
}

describe('agentmcp.inject for Codex', () => {
  let root = '';
  let bin = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-inject-'));
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const program of ['work-read', 'mesh-board-mcp']) fs.writeFileSync(path.join(bin, program), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  });
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  const earlier = (directory: string) =>
    `hooks.SessionStart=[{hooks=[{type="command",command="${directory}/work-read context --format codex",timeout=5}]}]`;

  test('an earlier Mesh hook (this or another installation) is replaced by the current one', () => {
    for (const saved of [earlier('/old/install/bin'), earlier(bin)]) {
      const argv = inject(['codex', 'resume', 'x', '-c', saved, `--config=${saved}`], {MESH_BIN_DIR: bin});
      assert.deepEqual(hookItems(argv), [hookItem(bin)], saved);
    }
  });

  test('the switch off, or work-read absent, removes every Mesh hook, also one a saved command carried', () => {
    for (const env of [{MESH_BIN_DIR: bin, MESH_PROJECT_HOOKS: '0'}, {MESH_BIN_DIR: bin, MESH_PROJECT_HOOKS: 'off'},
      {MESH_BIN_DIR: path.join(root, 'absent')}]) {
      const argv = inject(['codex', '-c', earlier(bin)], env);
      assert.deepEqual(hookItems(argv), [], JSON.stringify(env));
    }
  });

  test('a user\'s own SessionStart override is kept and Mesh does not replace it', () => {
    const own = 'hooks.SessionStart=[{hooks=[{type="command",command="/home/u/own-start"}]}]';
    assert.deepEqual(hookItems(inject(['codex', '-c', own], {MESH_BIN_DIR: bin})), [own]);
    const table = 'hooks={SessionStart=[{hooks=[{type="command",command="/home/u/own-start"}]}]}';
    assert.deepEqual(hookItems(inject(['codex', '-c', table], {MESH_BIN_DIR: bin})), [table]);
    const other = 'hooks.Stop=[{hooks=[{type="command",command="/home/u/own-stop"}]}]';
    assert.deepEqual(hookItems(inject(['codex', '-c', other], {MESH_BIN_DIR: bin})), [other, hookItem(bin)]);
  });

  test('the hook command is stable: no session name, token or environment value in it', () => {
    const one = inject(['codex'], {MESH_BIN_DIR: bin, MESH_SESSION: 'one', MESH_SESSION_TOKEN: 'secret-one'});
    const two = inject(['codex'], {MESH_BIN_DIR: bin, MESH_SESSION: 'two', MESH_SESSION_TOKEN: 'secret-two'});
    assert.deepEqual(hookItems(one), hookItems(two));
    assert.ok(!one.join(' ').includes('secret'));
  });

  // TOML allows only Unicode scalar values in \u escapes: a character outside the BMP must be written as is,
  // never as a JSON surrogate pair, or Codex refuses the override.
  test('an installation path outside the BMP gives a valid TOML override, read back as the same command', () => {
    const odd = path.join(root, 'inst-\u{1F680}é', 'bin');
    fs.mkdirSync(odd, {recursive: true});
    fs.writeFileSync(path.join(odd, 'work-read'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    const [item] = hookItems(inject(['codex'], {MESH_BIN_DIR: odd}));
    assert.ok(item && !item.includes('\\u'), item);
    const script = String.raw`
import json, sys, tomllib
key, _, value = sys.argv[1].partition("=")
print(json.dumps(tomllib.loads("value = " + value)["value"][0]["hooks"][0]["command"]))
`;
    const command = JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script, item],
      {encoding: 'utf8'})) as string;
    assert.equal(command, `'${odd}/work-read' context --format codex`);
  });
});
