// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A History resume must give back the name the owner chose. Shared by history-resume-name.test.ts: a real
// server.py, a real native PTY host (MESH_PTYHOST_CMD) and fake claude / codex / pi agents that only
// make themselves identifiable the way the real ones are (a pid file, an open rollout, a fresh transcript).
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isBindCollision} from './helpers/bind-retry.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {REPO, freePort, removeScratch, runServer, type Scratch, scratchHome, stopServer} from './mesh-server-lib.ts';
import {type Intercept, type Proxy, startProxy} from './ptyhost-proxy-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

export type Kind = 'claude' | 'codex' | 'pi';
export const KINDS: Kind[] = ['claude', 'codex', 'pi'];
// One prefix per test process: the fake agents of the files that run at the same time are seen by each other's
// listings (a process named claude, an open rollout), and must not hold the same conversation.
const RUN = crypto.randomBytes(4).toString('hex');
export const SIDS: Record<Kind, string> = {
  claude: `${RUN}-1111-2222-3333-444444444441`,
  codex: `${RUN}-1111-2222-3333-444444444442`,
  pi: `${RUN}-1111-2222-3333-444444444443`,
};

export type Mesh = {name: string; created: number; label: string | null;
  agent: {session_id?: string; identity_source?: string} | null};

const LOOP = 'while IFS= read -r line; do :; done';
const UUID = '????????-????-????-????-????????????';

function fakeAgents(bin: string): void {
  // the session token, which the session's own requests (a restart) carry
  const TOKEN = `[ -n "$MESH_SESSION" ] && printf '%s' "$MESH_SESSION_TOKEN" > "${bin}/token-$MESH_SESSION"`;
  const write = (name: string, lines: string[]): void =>
    fs.writeFileSync(path.join(bin, name), ['#!/bin/sh', TOKEN, ...lines, LOOP, ''].join('\n'), {mode: 0o755});
  write('claude-body', [
    '[ "$1" = "--version" ] && exit 0',
    'sid=""; prev=""; for a in "$@"; do [ "$prev" = "--resume" ] && sid="$a"; prev="$a"; done',
    `[ -n "$sid" ] || sid=$(cat "${bin}/sid-claude")`,
    'mkdir -p "$HOME/.claude/sessions"',
    'printf \'{"sessionId":"%s","status":"idle"}\' "$sid" > "$HOME/.claude/sessions/$$.json"',
  ]);
  // Started under the name claude, as the real one is: a restart or a restore reads its saved command, and refuses
  // one run through a launcher it cannot read (`sh <script>`). bash, not sh: dash has no `exec -a`.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash\nexec -a claude /bin/sh '${path.join(bin, 'claude-body')}' "$@"\n`,
    {mode: 0o755});
  write('codex', [
    '[ "$1" = "--version" ] && { echo "codex-cli 0.1.0"; exit 0; }',
    `sid=""; for a in "$@"; do case "$a" in ${UUID}) sid="$a";; esac; done`,
    `[ -n "$sid" ] || sid=$(cat "${bin}/sid-codex")`,
    'rollout=$(ls "$HOME"/.codex/sessions/*/*/*/rollout-*-"$sid".jsonl | head -1)',
    'exec 3< "$rollout"',
    // With a `hold-codex` file at the start, the rollout is let go once `release-codex` appears (a Codex after /new:
    // no rollout held open, so the server only guesses its conversation: identity_source cwd_unique).
    `if [ -e "${bin}/hold-codex" ]; then while [ ! -e "${bin}/release-codex" ]; do sleep 0.1; done; exec 3<&-; fi`,
  ]);
  write('pi', [
    '[ "$1" = "--version" ] && { echo 1.3.0; exit 0; }',
    'file=""; prev=""; for a in "$@"; do [ "$prev" = "--session" ] && file="$a"; prev="$a"; done',
    `[ -n "$file" ] || file=$(cat "${bin}/file-pi")`,
    'touch "$file"',
  ]);
}

// The ephemeral port can be claimed between discovery and the child binding it.
// Retry only a confirmed bind collision, never treat a foreign listener as ours.
export async function runHistoryServer(where: Scratch): ReturnType<typeof runServer> {
  for (let attempt = 0; ; attempt += 1) {
    const run = await runServer(where);
    if (run.result.listened || attempt === 4 ||
        !isBindCollision(run.result.output)) return run;
    where.port = await freePort();
    where.env.MESH_PORT = String(where.port);
  }
}

export class HistoryLab {
  readonly where: Scratch;
  readonly bin: string;
  private server!: ChildProcess;
  private host!: ChildProcess;
  private proxy: Proxy | null = null;
  private output: () => string = () => '';
  private constructor(where: Scratch, bin: string) { this.where = where; this.bin = bin; }

  /** `intercept`: a man-in-the-middle on the PTY host control socket (see ptyhost-proxy-lib.ts). */
  static async start(intercept?: Intercept): Promise<HistoryLab> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hrn-bin-'));
    fakeAgents(bin);
    fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});   // Pi refuses to start without the MCP server it is given
    const PATH = `${bin}:${process.env.PATH}`;
    const where = await scratchHome('hrn-', {PATH, MESH_SESSION_TOKEN: undefined, MESH_SESSION: undefined,
      MESH_BIN_DIR: bin, MESH_HISTORY_RESUME_GRACE: '1'});
    assert.notEqual(where.port, 7690);
    const lab = new HistoryLab(where, bin);
    fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
    for (const kind of KINDS) {
      const dir = lab.workDir(kind);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(bin, `sid-${kind}`), SIDS[kind]);
      lab.writeTranscript(kind, dir);
    }
    const runtime = where.env.XDG_RUNTIME_DIR!;
    // With an intercept, the server talks to a proxy and the real host listens in a sub-directory.
    const hostRuntime = intercept ? path.join(runtime, 'real') : runtime;
    fs.mkdirSync(hostRuntime, {recursive: true, mode: 0o700});
    const hostSocket = await lab.startHost(hostRuntime);
    if (intercept) lab.proxy = await startProxy(path.join(runtime, 'session-mesh', 'ptyhost.sock'), hostSocket, intercept);
    try { await lab.startServer(); } catch (error) { await lab.stop(); throw error; }
    return lab;
  }

  /** Start the native PTY host listening in `hostRuntime`; its control socket once it answers. */
  private async startHost(hostRuntime: string): Promise<string> {
    const [command, ...args] = nativePtyhost();
    this.host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
      env: {PATH: this.where.env.PATH, HOME: this.where.home, XDG_RUNTIME_DIR: hostRuntime, LANG: 'C', SHELL: '/bin/bash'}});
    const hostSocket = path.join(hostRuntime, 'session-mesh', 'ptyhost.sock');
    await waitFor('ptyhost answering', 10000, () => fs.existsSync(hostSocket));
    return hostSocket;
  }

  /** Stop the PTY host (every session ends with it) and start another one: what a restart of its unit does.
   * Only without an intercept. */
  async restartHost(): Promise<void> {
    assert.equal(this.proxy, null, 'restartHost runs without an intercept');
    const gone = new Promise(resolve => this.host.once('close', resolve));
    this.host.kill('SIGTERM');
    await gone;
    fs.rmSync(path.join(this.where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock'), {force: true});
    await this.startHost(this.where.env.XDG_RUNTIME_DIR!);
  }

  workDir(kind: Kind): string { return path.join(this.where.home, `work-${kind}`); }

  /** The conversation of `kind` as its history index reads it; also what the fake agent holds open or touches. */
  private writeTranscript(kind: Kind, cwd: string): void {
    const sid = SIDS[kind];
    const home = this.where.home;
    const line = (value: object): string => JSON.stringify(value) + '\n';
    if (kind === 'claude') {
      const folder = path.join(home, '.claude', 'projects', '-home-x');
      fs.mkdirSync(folder, {recursive: true});
      fs.writeFileSync(path.join(folder, `${sid}.jsonl`), line({type: 'user', timestamp: '2026-10-01T10:00:00Z', cwd,
        message: {content: 'hello there'}}));
    } else if (kind === 'codex') {
      const folder = path.join(home, '.codex', 'sessions', '2026', '10', '01');
      fs.mkdirSync(folder, {recursive: true});
      fs.writeFileSync(path.join(folder, `rollout-2026-10-01T10-00-00-${sid}.jsonl`),
        line({type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: {id: sid, cwd, cli_version: '0.1', source: 'cli'}})
        + line({type: 'event_msg', timestamp: '2026-10-01T10:00:01Z', payload: {type: 'user_message', message: 'hello there'}}));
    } else {
      const folder = path.join(home, '.pi', 'agent', 'sessions', 'x');
      fs.mkdirSync(folder, {recursive: true});
      const file = path.join(folder, 'a.jsonl');
      fs.writeFileSync(file, line({type: 'session', version: 3, id: sid, cwd, timestamp: '2026-10-01T10:00:00Z'})
        + line({type: 'message', timestamp: '2026-10-01T10:00:01Z', message: {role: 'user', content: 'hello there'}}));
      fs.writeFileSync(path.join(this.bin, 'file-pi'), file);
    }
  }

  async startServer(): Promise<void> {
    const {child, result, output} = await runHistoryServer(this.where);
    this.output = output;
    assert.ok(result.listened, result.output);
    this.server = child;
  }

  /** Stop the web server (the PTY host and its sessions stay) and start it again: its memory is gone. */
  async restartServer(): Promise<void> {
    await stopServer(this.server);
    await this.startServer();
  }

  /** Everything the web server printed so far. */
  serverOutput(): string { return this.output(); }

  async stop(): Promise<void> {
    if (this.server) await stopServer(this.server);
    this.proxy?.close();
    const exited = this.host.exitCode !== null || this.host.signalCode !== null;
    const gone = new Promise(resolve => this.host.once('close', resolve));
    this.host.kill('SIGKILL');
    if (!exited) await gone;
    // The fake agents of the killed host may still be writing in their home for a moment: retry the removal.
    for (let attempt = 0; ; attempt += 1) {
      try { removeScratch(this.where.scratch); break; } catch (error) {
        if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    fs.rmSync(this.bin, {recursive: true, force: true});
  }

  async call(method: string, route: string, body?: unknown): Promise<{status: number; json: any; text: string}> {
    const token = fs.readFileSync(path.join(this.where.confDir, 'token'), 'utf8').trim();
    const base = `http://127.0.0.1:${this.where.port}`;
    const response = await fetch(base + route, {method, headers: {Authorization: `Bearer ${token}`, Origin: base,
      'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* a plain-text refusal */ }
    return {status: response.status, json, text};
  }

  async sessions(): Promise<Mesh[]> {
    const answer = await this.call('GET', '/api/sessions');
    assert.equal(answer.status, 200, answer.text);
    return answer.json.mesh;
  }

  /** A fresh session of `kind` ("New session"); returns it once the server identifies its conversation. */
  async create(kind: Kind): Promise<Mesh> {
    const made = await this.call('POST', '/api/new', {preset: kind, cwd: this.workDir(kind)});
    assert.equal(made.status, 200, made.text);
    let found: Mesh | undefined;
    await waitFor(`${kind} identified as ${SIDS[kind]}`, 15000, async () => {
      found = (await this.sessions()).find(s => s.name === made.json.id && s.agent?.session_id === SIDS[kind]);
      return found !== undefined;
    });
    return found!;
  }

  async shell(name: string, label?: string): Promise<void> {
    const made = await this.call('POST', '/api/new', {preset: 'shell', cwd: this.where.home, name});
    assert.equal(made.status, 200, made.text);
    if (label !== undefined) await this.rename(name, label);
  }

  async rename(name: string, label: string): Promise<void> {
    const done = await this.call('POST', '/api/organize', {op: 'rename', id: name, label});
    assert.equal(done.status, 200, done.text);
  }

  async kill(session: Mesh): Promise<void> {
    const done = await this.call('POST', `/api/kill/${session.name}`, {created: session.created});
    assert.equal(done.status, 200, done.text);
    await waitFor(`${session.name} gone`, 10000, async () => !(await this.sessions()).some(s => s.name === session.name));
  }

  /** POST /api/history/resume: the status and the name of the session started. */
  async resume(kind: Kind): Promise<{status: number; id: string | undefined; text: string}> {
    const answer = await this.call('POST', '/api/history/resume', {agent: kind, id: SIDS[kind]});
    return {status: answer.status, id: answer.json?.id, text: answer.text};
  }

  /** The session of `kind` the resume started, once the server identifies its conversation (never twice). */
  async resumed(kind: Kind, name: string): Promise<Mesh> {
    let found: Mesh | undefined;
    await waitFor(`${name} running ${kind}`, 15000, async () => {
      found = (await this.sessions()).find(s => s.name === name);
      return found?.agent?.session_id === SIDS[kind];
    });
    const running = (await this.sessions()).filter(s => s.agent?.session_id === SIDS[kind]);
    assert.deepEqual(running.map(s => s.name), [name], 'one session per conversation');
    return found!;
  }

  /** The Claude of `session` moves to another conversation, as after /clear: its pid file names the new one. */
  async claudeSwitchTo(session: Mesh, sid: string): Promise<void> {
    const folder = path.join(this.where.home, '.claude', 'sessions');
    for (const file of fs.readdirSync(folder)) {
      fs.writeFileSync(path.join(folder, file), JSON.stringify({sessionId: sid, status: 'idle'}));
    }
    await waitFor(`${session.name} in ${sid}`, 15000, async () =>
      (await this.sessions()).find(s => s.name === session.name)?.agent?.session_id === sid);
  }

  /** A second transcript written since the Pi process started (what /new leaves): its conversation is ambiguous. */
  async piBecomesAmbiguous(session: Mesh): Promise<void> {
    const folder = path.join(this.where.home, '.pi', 'agent', 'sessions', 'x');
    fs.writeFileSync(path.join(folder, 'b.jsonl'), [
      {type: 'session', version: 3, id: '0a1b2c3d-1111-2222-3333-444444444499', cwd: this.workDir('pi'), timestamp: '2026-10-01T11:00:00Z'},
      {type: 'message', timestamp: '2026-10-01T11:00:01Z', message: {role: 'user', content: 'a new topic'}},
    ].map(value => JSON.stringify(value) + '\n').join(''));
    await waitFor(`${session.name} ambiguous`, 15000, async () =>
      (await this.sessions()).find(s => s.name === session.name)?.agent?.session_id === undefined);
  }

  /** The next Codex started will let its rollout go when `codexStartsNew` is called. */
  holdCodexRollout(): void { fs.writeFileSync(path.join(this.bin, 'hold-codex'), ''); }

  /** The Codex of `session` starts a new conversation (/new): its first rollout is let go and a second one is
   * written, so the server can only guess (identity_source cwd_unique), here the second conversation. */
  async codexStartsNew(session: Mesh, sid: string): Promise<void> {
    fs.rmSync(path.join(this.bin, 'hold-codex'));
    const cwd = this.workDir('codex');
    const folder = path.join(this.where.home, '.codex', 'sessions', '2026', '10', '02');
    fs.mkdirSync(folder, {recursive: true});
    fs.writeFileSync(path.join(folder, `rollout-2026-10-02T10-00-00-${sid}.jsonl`),
      JSON.stringify({type: 'session_meta', timestamp: '2026-10-02T10:00:00Z', payload: {id: sid, cwd, cli_version: '0.1', source: 'cli'}}) + '\n'
      + JSON.stringify({type: 'event_msg', timestamp: '2026-10-02T10:00:01Z', payload: {type: 'user_message', message: 'a new topic'}}) + '\n');
    fs.writeFileSync(path.join(this.bin, 'release-codex'), '');
    await waitFor(`${session.name} guessed`, 15000, async () =>
      (await this.sessions()).find(s => s.name === session.name)?.agent?.identity_source === 'cwd_unique');
  }

  /** Back to one transcript, so that a resume of the first conversation is identified again. */
  piDropsSecondTranscript(): void {
    fs.rmSync(path.join(this.where.home, '.pi', 'agent', 'sessions', 'x', 'b.jsonl'));
  }

  /** The labels kept per conversation (the registry file), by conversation id; null for an unbound entry. */
  recordedLabels(): Record<string, string> {
    const entries = JSON.parse(fs.readFileSync(path.join(this.where.confDir, 'conversation-names.json'), 'utf8')) as
      {sid: string | null; label: string}[];
    return Object.fromEntries(entries.map(entry => [entry.sid ?? 'unbound', entry.label]));
  }

  /** A closed session: create, rename (each label in turn), stop. Returns the name it had. */
  async closedRenamed(kind: Kind, ...labels: string[]): Promise<string> {
    const session = await this.create(kind);
    for (const label of labels) await this.rename(session.name, label);
    await this.kill(session);
    return session.name;
  }
}

export async function withHistoryLab(body: (lab: HistoryLab) => Promise<void>, intercept?: Intercept): Promise<void> {
  const lab = await HistoryLab.start(intercept);
  try { await body(lab); } finally { await lab.stop(); }
}
