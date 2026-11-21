// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared by the exact-restore tests: a real server.py, a real PTY host and a fake `claude` that logs its argv.
// The snapshot offers two lost sessions (an agent and a plain shell); each test starts its own mesh.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {type Intercept, type Proxy, startProxy} from './ptyhost-proxy-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

export const SID = '0a1b2c3d-1111-2222-3333-444444444444';
export const ALPHA_CREATED = 1700000000.25;
export const BRAVO_CREATED = 1700000001.5;
export const PI_SID = '0a1b2c3d-5555-6666-7777-888888888888';

/** A Claude transcript of conversation `id` in `cwd` under `home`, as the history index reads it. */
export function writeClaudeTranscript(home: string, id: string, cwd: string): void {
  const folder = path.join(home, '.claude', 'projects', '-home-x');
  fs.mkdirSync(folder, {recursive: true});
  const lines = [
    {type: 'user', timestamp: '2026-10-01T10:00:00Z', cwd, gitBranch: 'main', version: '2.0', message: {content: 'hello there'}},
    {type: 'assistant', timestamp: '2026-10-01T10:00:05Z', message: {id: 'm1', model: 'claude-x',
      content: [{type: 'text', text: 'hello'}], usage: {input_tokens: 3, output_tokens: 4}}},
  ];
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map(line => JSON.stringify(line) + '\n').join(''));
}

export type Offer = {name: string; created: number; agent_kind: string; resume_id: string | null; cwd: string};
export type Listed = {name: string; created: number};
export type LabOptions = {marker?: string; twin?: boolean; bare?: boolean; pi?: boolean; intercept?: Intercept;
  env?: NodeJS.ProcessEnv; identities?: object[]; noRegistry?: boolean; claudeLines?: string[];
  alphaExtra?: object; prepare?: (home: string, confDir: string) => void};

export class Lab {
  readonly mesh: Mesh;
  readonly argvLog: string;
  readonly offers: Record<'alpha' | 'bravo', Offer>;
  piOffer!: Offer;   // set by the `pi` option: an identified Pi agent whose transcript exists (the only `pi` is a stub that is too old)
  private readonly bin: string;
  private readonly host: ChildProcess;
  private readonly socketPath: string;
  private readonly proxy: Proxy | null;
  private constructor(mesh: Mesh, bin: string, host: ChildProcess, socketPath: string, argvLog: string,
                      offers: Record<'alpha' | 'bravo', Offer>, proxy: Proxy | null) {
    this.proxy = proxy;
    this.mesh = mesh;
    this.bin = bin;
    this.host = host;
    this.socketPath = socketPath;
    this.argvLog = argvLog;
    this.offers = offers;
  }

  // `marker`: alpha's offer already carries this restore nonce; `twin`: a third offer shares alpha's conversation;
  // `pi`: one more offer, a Pi agent with its transcript; `identities`: the registry's entries; `claudeLines`: shell
  // lines the fake `claude` runs after logging its argv; `intercept`: the host is reached through a proxy that may delay, answer or react to a request.
  static async start(options: LabOptions = {}): Promise<Lab> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rcas-bin-'));
    const argvLog = path.join(bin, 'argv.log');
    // This fixture tests restore custody, not login profiles. Keep the fake agent
    // first on PATH even on machines whose /etc/profile resets it.
    const shell = path.join(bin, 'plain-bash');
    fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',   // the server's launch probe (claudewake) is not an agent
      `{ echo "--- start"; for a in "$@"; do echo "$a"; done; echo "--- end"; } >> "${argvLog}"`,
      ...options.claudeLines ?? [],   // what the fake agent does once started (a hook report, say)
      'while IFS= read -r line; do :; done',
      '',
    ].join('\n'), {mode: 0o755});
    // Hermetic Pi: whatever the ambient PATH holds, `pi` resolves to this stub first (the server looks in
    // $HOME/.local/bin, which is the empty scratch home, then in PATH), and a version below 1.3.0 is the
    // Pi that cannot carry the Mesh MCP: PiUnavailable on every machine, with or without a real `pi`.
    fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\necho 0.0.0\n', {mode: 0o755});
    const PATH = `${bin}:${process.env.PATH}`;
    let offers!: Record<'alpha' | 'bravo', Offer>;
    let piOffer: Offer | undefined;
    const mesh = await startMesh('rcas-', {PATH, MESH_SESSION_TOKEN: undefined, MESH_SESSION: undefined,
      MESH_BIN_DIR: undefined, ...options.env}, where => {
      const dirs = {alpha: path.join(where.home, 'alpha-dir'), bravo: path.join(where.home, 'bravo-dir')};
      for (const dir of Object.values(dirs)) fs.mkdirSync(dir, {recursive: true});
      offers = {
        alpha: {name: 'alpha', created: ALPHA_CREATED, agent_kind: 'claude', resume_id: SID, cwd: dirs.alpha},
        bravo: {name: 'bravo', created: BRAVO_CREATED, agent_kind: 'shell', resume_id: null, cwd: dirs.bravo},
      };
      const entry = (offer: Offer, extra: object = {}) => ({name: offer.name, cwd: offer.cwd, created: offer.created,
        cmd: null, lost_at: Date.now() / 1000, org: {label: null, folder: null, rank: null},
        agent: offer.agent_kind !== 'shell'
          ? {type: offer.agent_kind, session_id: offer.resume_id, argv: ['claude']} : null,
        ...extra});
      const lost = [entry(offers.alpha, {...options.alphaExtra, ...options.marker ? {restoring: {nonce: options.marker}} : {}}),
        entry(offers.bravo)];
      if (options.twin) {
        const twinDir = path.join(where.home, 'twin-dir');
        fs.mkdirSync(twinDir);
        lost.push(entry({...offers.alpha, name: 'twin', created: ALPHA_CREATED + 5, cwd: twinDir}));
      }
      if (options.bare) {   // an identified agent whose conversation id was never learnt
        const bareDir = path.join(where.home, 'bare-dir');
        fs.mkdirSync(bareDir);
        lost.push(entry({name: 'bare', created: ALPHA_CREATED + 9, agent_kind: 'claude', resume_id: null, cwd: bareDir}));
      }
      if (options.pi) {
        const piDir = path.join(where.home, 'pi-dir');
        fs.mkdirSync(piDir);
        piOffer = {name: 'pibo', created: ALPHA_CREATED + 11, agent_kind: 'pi', resume_id: PI_SID, cwd: piDir};
        lost.push(entry(piOffer));
        const transcripts = path.join(where.home, '.pi', 'agent', 'sessions', 'x');
        fs.mkdirSync(transcripts, {recursive: true});
        fs.writeFileSync(path.join(transcripts, 'a.jsonl'),
          JSON.stringify({type: 'session', version: 3, id: PI_SID, cwd: piDir}) + '\n');
      }
      writeClaudeTranscript(where.home, SID, dirs.alpha);   // the offered conversation exists: a restore checks it
      fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
      // An identity registry that knows none of these offers (no migration from the snapshot): a restore
      // resumes the snapshot's conversation, so a twin offer reaches the hold of a running conversation.
      // tests/identity-restore.test.ts covers what the registry itself decides.
      // `noRegistry`: no file at all, so the first listing migrates the snapshot (identity-restore.test.ts).
      if (!options.noRegistry) {
        fs.writeFileSync(path.join(where.confDir, 'session-identities.json'),
          JSON.stringify({version: 1, generation: 0, entries: options.identities ?? []}), {mode: 0o600});
      }
      fs.writeFileSync(path.join(where.confDir, 'sessions-snapshot.json'),
        JSON.stringify({version: 1, host: null, live: [], lost}));
      // These core restore scenarios have affirmative empty-source records. Missing or
      // unavailable catalogues are exercised separately by the artifact restore matrix.
      fs.writeFileSync(path.join(where.confDir, 'session-artifacts.json'),
        JSON.stringify({version: 1, sessions: lost.map(({name, created}) =>
          ({session: {name, created}, references: []}))}), {mode: 0o600});
      options.prepare?.(where.home, where.confDir);
    });
    const runtime = path.join(mesh.home, 'run');
    const [hostCommand, ...hostArgs] = nativePtyhost();   // MESH_PTYHOST_CMD: the host under test
    const hostRuntime = options.intercept ? path.join(runtime, 'real') : runtime;
    fs.mkdirSync(hostRuntime, {recursive: true, mode: 0o700});
    const host = spawn(hostCommand!, hostArgs, {cwd: REPO, stdio: 'ignore',
      env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: hostRuntime, LANG: 'C', SHELL: shell}});
    const hostSocket = path.join(hostRuntime, 'session-mesh', 'ptyhost.sock');
    await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    const proxy = options.intercept ? await startProxy(socketPath, hostSocket, options.intercept) : null;
    const lab = new Lab(mesh, bin, host, hostSocket, argvLog, offers, proxy);
    if (piOffer) lab.piOffer = piOffer;
    return lab;
  }

  async stop(): Promise<void> {
    this.proxy?.close();
    this.host.kill('SIGKILL');
    this.makeConfigReadOnly(false);
    await this.mesh.stop();
    fs.rmSync(this.bin, {recursive: true, force: true});
  }

  async post(body: unknown, headers: Record<string, string> = {}): Promise<{status: number; json: any; text: string}> {
    const response = await fetch(`${this.mesh.base}/api/restore`, {method: 'POST',
      headers: {Authorization: `Bearer ${this.mesh.token()}`, Origin: this.mesh.base,
        'Content-Type': 'application/json', ...headers},
      body: typeof body === 'string' ? body : JSON.stringify(body)});
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* a plain-text refusal */ }
    return {status: response.status, json, text};
  }

  /** The guarded restore of one offer: the HTTP status and its entry of `results` (null when there is none). */
  async exact(offer: Offer): Promise<{status: number; json: any; text: string}> {
    const answer = await this.post({names: [offer.name], expected: offer});
    return {...answer, json: answer.json?.results?.[offer.name] ?? null};
  }

  /** While on, no file can be created in the server's configuration folder: the snapshot cannot be rewritten
   *  (the file system fails the write, nothing in the server is switched). The lock files of the board, the
   *  organisation and the agent mail are created first: those stores only open them, and keep working. */
  makeConfigReadOnly(on: boolean): void {
    try {
      if (on) for (const store of ['board', 'mesh', 'agent-mail']) fs.closeSync(fs.openSync(path.join(this.mesh.confDir, `${store}.json.lock`), 'a', 0o600));
      fs.chmodSync(this.mesh.confDir, on ? 0o500 : 0o700);
    } catch { /* the folder is already gone */ }
  }

  /** GET /api/sessions: the status and the parsed answer. */
  async sessionsJson(): Promise<{status: number; json: any}> {
    const response = await fetch(`${this.mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${this.mesh.token()}`}});
    return {status: response.status, json: await response.json()};
  }

  /** While on, the configuration folder can be written but not read (mode 0300): the snapshot file is replaced
   *  and the write is complete, but the flush of the directory (which opens it for reading) fails. */
  denyDirectoryRead(on: boolean): void {
    try {
      if (on) for (const store of ['board', 'mesh', 'agent-mail']) fs.closeSync(fs.openSync(path.join(this.mesh.confDir, `${store}.json.lock`), 'a', 0o600));
      fs.chmodSync(this.mesh.confDir, on ? 0o300 : 0o700);
    } catch { /* the folder is already gone */ }
  }

  async listed(): Promise<Listed[]> {
    return (await request(this.socketPath, {op: 'list'})) as Listed[];   // the real host: never through the proxy
  }

  starts(): number {
    // An agent counts once its whole argv is logged: a reader after waitFor never sees a partial one.
    return fs.existsSync(this.argvLog) ? fs.readFileSync(this.argvLog, 'utf8').split('--- end').length - 1 : 0;
  }

  snapshotLost(): Record<string, any>[] {
    return JSON.parse(fs.readFileSync(path.join(this.mesh.confDir, 'sessions-snapshot.json'), 'utf8')).lost;
  }

  /** POST /api/history/resume: the HTTP status. */
  async historyResume(agent: string, id: string): Promise<number> {
    const response = await fetch(`${this.mesh.base}/api/history/resume`, {method: 'POST',
      headers: {Authorization: `Bearer ${this.mesh.token()}`, Origin: this.mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({agent, id})});
    await response.text();
    return response.status;
  }

  /** A Claude transcript of conversation `id` in `cwd`, as the history index reads it. */
  writeTranscript(id: string, cwd: string): void {
    writeClaudeTranscript(this.mesh.home, id, cwd);
  }

  async newShell(name: string): Promise<void> {
    const response = await fetch(`${this.mesh.base}/api/new`, {method: 'POST',
      headers: {Authorization: `Bearer ${this.mesh.token()}`, Origin: this.mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({preset: 'shell', cwd: this.mesh.home, name})});
    assert.equal(response.status, 200, await response.text());
  }
}

export async function withLab(body: (lab: Lab) => Promise<void>, options: LabOptions = {}): Promise<void> {
  const lab = await Lab.start(options);
  try { await body(lab); } finally { await lab.stop(); }
}
