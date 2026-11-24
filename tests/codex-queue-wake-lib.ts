// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared by the Codex `codex queue` wake tests: a real server, the native PTY host
// (MESH_PTYHOST_CMD) and a fake `codex` (a Node script run under the name codex) that:
// - as a session: holds its rollout file open (identity_source open_rollout), or only writes it and lets it go
//   (a guess, cwd_unique: never exact) when the folder holds a file named `closed`; a file named `rotate`
//   makes it switch to a new conversation (a new rollout); a file named `background` puts the holder in
//   a background process group of the terminal (the foreground one is a `sleep`); it leaves when its folder is gone;
// - as `codex queue ...`: records its argv and environment, then behaves as the mode file says.
// Nothing here runs the real codex or touches a real home: every path is under the OS temporary directory.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hostArgv} from './claude-wake-lib.ts';
import {approveMail} from './helpers/agent-mail-mesh.ts';
import {REPO, type Scratch, runServer, scratchHome, stopServer, removeScratch} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

export const NOTICE_TEXT = 'Mesh: new message(s) in your inbox; the user approved reading mail. '
  + 'Please check mail.inbox and read authorized entries without asking again.';
export const CANARIES = {OPENAI_API_KEY: 'sk-canary-secret', MESH_CANARY: 'mesh-canary-secret',
  ANTHROPIC_API_KEY: 'ak-canary-secret', SSH_AUTH_SOCK: '/tmp/canary-ssh-agent', EDITOR: 'canary-editor'};
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Approve only the deposited message under test, without granting future sends. */
export async function approveWakeMail(base: string, ownerToken: string, sent: Response): Promise<void> {
  const login = await fetch(`${base}/login`, {method: 'POST', redirect: 'manual',
    body: new URLSearchParams({token: ownerToken})});
  const cookie = login.headers.getSetCookie().find(item => item.startsWith('mesh_auth='))?.split(';')[0];
  assert.ok(cookie, 'the fixture owner cookie');
  await approveMail(base, cookie, sent);
}

export function fakeCodex(control: string): string {
  return [
    "const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');",
    `const control = ${JSON.stringify(control)};`,
    'const args = process.argv.slice(2);',
    "if (args[0] === 'queue') {",
    "  fs.appendFileSync(path.join(control, 'queue.log'), JSON.stringify({argv: args, env: process.env, cwd: process.cwd(), pid: process.pid}) + '\\n');",
    "  const mode = fs.readFileSync(path.join(control, 'mode'), 'utf8').trim();",
    "  if (mode === 'fail') { process.stderr.write('no such session\\n'); process.exit(1); }",
    "  if (mode === 'ambiguous') { process.stderr.write('ambiguous session name\\n'); process.exit(2); }",
    "  if (mode === 'huge') { process.stdout.write('x'.repeat(300000), () => process.exit(0)); }",
    "  else if (mode === 'endless') { const chunk = 'y'.repeat(8192); const pump = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', pump); }; pump(); }",
    "  else if (mode === 'slow') { setTimeout(() => process.exit(0), 3000); }",
    "  else if (mode === 'timeout') { setInterval(() => {}, 1000); } else process.exit(0);",
    '} else {',
    '  let fd = null;',
    '  const open = () => {',
    "    const id = require('node:crypto').randomUUID();",
    "    const day = path.join(process.env.HOME, '.codex', 'sessions', '2026', '11', '16');",
    '    fs.mkdirSync(day, {recursive: true});',
    "    const rollout = path.join(day, `rollout-2026-11-16T00-00-00-${id}.jsonl`);",
    "    const line = JSON.stringify({type: 'session_meta', payload: {id, cwd: process.cwd()}}) + '\\n';",
    "    if (fs.existsSync('./closed')) fs.writeFileSync(rollout, line); else { fd = fs.openSync(rollout, 'a'); fs.writeSync(fd, line); }",
    "    fs.writeFileSync('./uuid.tmp', id); fs.renameSync('./uuid.tmp', './uuid');",
    '  };',
    '  open();',
    "  setInterval(() => { if (!fs.existsSync('./uuid')) process.exit(0); if (fs.existsSync('./rotate')) { fs.unlinkSync('./rotate'); if (fd !== null) fs.closeSync(fd); open(); } }, 100);",
    "  readline.createInterface({input: process.stdin}).on('line', l => fs.appendFileSync('./input.log', l + '\\n'));",
    "  fs.writeFileSync('./token.tmp', process.env.MESH_SESSION_TOKEN ?? ''); fs.renameSync('./token.tmp', './token');",
    '}',
    '',
  ].join('\n');
}

export type Agent = {name: string; dir: string; token: string; created: number; uuid: string};
export type Call = {argv: string[]; env: Record<string, string>; cwd: string; pid: number};
export type RigOptions = {wake?: boolean; env?: NodeJS.ProcessEnv; prepare?: (where: Scratch) => void};

/** A server (own home and port), its PTY host and a fake codex on the PATH of both. */
export class Rig {
  readonly hosts: ChildProcess[] = [];
  readonly dirs: string[] = [];
  where!: Scratch;
  control = '';
  readonly agents: Record<string, Agent> = {};
  private server: ChildProcess | undefined;
  private runtime = '';
  private path = '';

  get base(): string { return `http://127.0.0.1:${this.where.port}`; }
  get confDir(): string { return this.where.confDir; }
  get home(): string { return this.where.home; }
  token = (): string => fs.readFileSync(path.join(this.where.confDir, 'token'), 'utf8').trim();
  private outputs: (() => string)[] = [];
  serverOutput = (): string => this.outputs.map(output => output()).join('');

  private ownerHeaders = () => ({Authorization: `Bearer ${this.token()}`, Origin: this.base, 'Content-Type': 'application/json'});
  private agentHeaders = (agent: Agent) => ({Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'});
  mode = (value: string) => fs.writeFileSync(path.join(this.control, 'mode'), value);

  calls = (): Call[] => {
    const log = path.join(this.control, 'queue.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  };
  forTarget = (agent: Agent) => this.calls().filter(call => call.argv.includes(agent.uuid));
  typed = (agent: Agent) => {
    const log = path.join(agent.dir, 'input.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('mail.inbox')).length : 0;
  };

  /** Start the server and the host. `wake` sets MESH_CODEX_QUEUE_WAKE=1; `prepare` runs before the server reads anything. */
  async start(prefix: string, options: RigOptions = {}): Promise<void> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cqw-bin-'));
    this.control = fs.mkdtempSync(path.join(os.tmpdir(), 'cqw-ctl-'));
    this.runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'cqw-run-'));
    this.dirs.push(bin, this.control, this.runtime);
    this.mode('ok');
    fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'fake-codex.js'), fakeCodex(this.control));
    // `background` in the folder: the holder of the rollout runs in a background process group of the terminal.
    // bash, not sh: `exec -a` is a bash builtin option that dash (Ubuntu's /bin/sh) refuses.
    fs.writeFileSync(path.join(bin, 'codex'), [
      '#!/bin/bash',
      `if [ -e ./background ]; then set -m; exec -a codex '${process.execPath}' '${path.join(bin, 'fake-codex.js')}' "$@" < /dev/null > /dev/null 2>&1 & exec sleep 100000; fi`,
      `exec -a codex '${process.execPath}' '${path.join(bin, 'fake-codex.js')}' "$@"`, ''].join('\n'), {mode: 0o755});
    this.path = `${bin}:${process.env.PATH}`;
    this.where = await scratchHome(prefix, {PATH: this.path, MESH_BIN_DIR: bin, MESH_CODEX_QUEUE_TIMEOUT_SECONDS: '2',
      MESH_RUNTIME_DIR: this.runtime, ...(options.wake === false ? {} : {MESH_CODEX_QUEUE_WAKE: '1'}), ...CANARIES, ...options.env});
    options.prepare?.(this.where);
    await this.listen();
    const hostSocket = path.join(this.runtime, 'session-mesh', 'ptyhost.sock');
    this.hosts.push(spawn(hostArgv()[0], hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
      env: {PATH: this.path, HOME: this.where.home, XDG_RUNTIME_DIR: path.join(this.where.home, 'run'),
        MESH_RUNTIME_DIR: this.runtime, LANG: 'C'}}));
    await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));
  }

  private async listen(): Promise<void> {
    const {child, result, output} = await runServer(this.where);
    if (!result.listened) throw new Error(`server.py did not listen:\n${result.output}`);
    this.server = child;
    this.outputs.push(output);
  }

  /** Stop and start the server again on the same home and port; the PTY host and the sessions stay. */
  async restart(prepare?: (where: Scratch) => void): Promise<void> {
    await stopServer(this.server!);
    prepare?.(this.where);
    await this.listen();
  }

  async stop(): Promise<void> {
    for (const host of this.hosts) host.kill('SIGKILL');
    await Promise.all(this.hosts.map(host => new Promise(resolve => {
      if (host.exitCode !== null || host.signalCode !== null) resolve(undefined); else host.once('close', resolve);
    })));
    if (this.server) await stopServer(this.server);
    for (const dir of this.dirs) fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    if (this.where) removeScratch(this.where.scratch);
  }

  async launch(name: string, closed = false, extra: string[] = []): Promise<Agent> {
    const dir = path.join(this.where.home, name);
    fs.mkdirSync(dir);
    if (closed) fs.writeFileSync(path.join(dir, 'closed'), '');
    for (const flag of extra) fs.writeFileSync(path.join(dir, flag), '');
    const response = await fetch(`${this.base}/api/new`, {method: 'POST', headers: this.ownerHeaders(),
      body: JSON.stringify({preset: 'codex', cwd: dir, name})});
    assert.equal(response.status, 200, await response.clone().text());
    await waitFor(`fake codex ${name}`, 20000, () => fs.existsSync(path.join(dir, 'token')));
    return {name, dir, token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(), created: 0,
      uuid: fs.readFileSync(path.join(dir, 'uuid'), 'utf8').trim()};
  }

  /** Make the session switch to a new conversation (a new rollout) and wait for its new uuid. */
  async rotate(agent: Agent): Promise<void> {
    const before = agent.uuid;
    fs.writeFileSync(path.join(agent.dir, 'rotate'), '');
    await waitFor(`${agent.name} switched`, 10000, () => fs.readFileSync(path.join(agent.dir, 'uuid'), 'utf8').trim() !== before);
    agent.uuid = fs.readFileSync(path.join(agent.dir, 'uuid'), 'utf8').trim();
  }

  async learnCreated(viewer: Agent, other: Agent): Promise<void> {
    const peers = await (await fetch(`${this.base}/api/agent-mail/@self/peers`, {headers: this.agentHeaders(viewer)}))
      .json() as {peers: {id: string; created: number; agent: string}[]};
    const found = peers.peers.find(item => item.id === other.name);
    assert.equal(found?.agent, 'codex');
    other.created = found!.created;
  }

  async send(from: Agent, to: Agent, text: string): Promise<void> {
    const response = await fetch(`${this.base}/api/agent-mail/@self/send`, {method: 'POST', headers: this.agentHeaders(from),
      body: JSON.stringify({target: to.name, target_created: to.created, kind: 'message', text})});
    assert.equal(response.status, 200, await response.clone().text());
    await approveWakeMail(this.base, this.token(), response);
  }

  async lookAtInbox(agent: Agent): Promise<number> {
    const response = await fetch(`${this.base}/api/agent-mail/@self/inbox`, {headers: this.agentHeaders(agent)});
    assert.equal(response.status, 200);
    return ((await response.json()) as {messages: unknown[]}).messages.length;
  }

  flagged = async (agent: Agent) => {
    const response = await fetch(`${this.base}/api/sessions`, {headers: this.ownerHeaders()});
    const data = await response.json() as {mesh: {name: string; wake_unconfirmed?: boolean}[]};
    return data.mesh.find(item => item.name === agent.name)?.wake_unconfirmed === true;
  };
}
