// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A throwaway server and PTY host whose launch settings file is the test's own, for the tests of
// the owner's editable launch settings. A fake `claude` records its session token, so a test can
// also speak as an agent. Nothing here touches the caller's mesh: HOME, configuration, runtime
// directory, port and settings file are all under one scratch directory.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {REPO, runServer, scratchHome, stopServer} from '../mesh-server-lib.ts';
import {waitFor} from '../ptyhost-wire-lib.ts';
import {nativePtyhost} from './native-ptyhost.ts';

export type Settings = {v: 1; workspace_roots: string[]; enabled_agents: string[]};

export class ConfigMesh {
  cookie = '';
  elevation = '';
  readonly base: string;
  readonly home: string;
  readonly outside: string;
  readonly settingsPath: string;
  readonly port: number;
  readonly confDir: string;
  readonly output: () => string;
  private readonly scratch: string;
  private readonly server: ChildProcess;
  private readonly host: ChildProcess;
  private constructor(scratch: string, port: number, confDir: string, home: string,
    server: ChildProcess, host: ChildProcess, output: () => string) {
    this.scratch = scratch; this.port = port; this.confDir = confDir; this.server = server; this.host = host; this.output = output;
    this.home = home; this.base = `http://127.0.0.1:${port}`;
    this.outside = path.join(scratch, 'outside');
    this.settingsPath = path.join(scratch, 'launch-settings.json');
  }

  static async start(prefix: string, initial: Settings | ((home: string) => Settings) | null, mode = 0o640): Promise<ConfigMesh> {
    const where = await scratchHome(prefix);
    const bin = path.join(where.scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s" "$MESH_SESSION_TOKEN" > ./token.tmp && mv ./token.tmp ./token\nexec sleep 120\n', {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 120\n', {mode: 0o755});
    const PATH = `${bin}:${process.env.PATH}`;
    where.env.PATH = PATH;
    const settingsPath = path.join(where.scratch, 'launch-settings.json');
    fs.mkdirSync(path.join(where.scratch, 'outside'));
    if (initial !== null) {
      for (const name of ['work', 'work2', 'work3']) fs.mkdirSync(path.join(where.home, name), {recursive: true});
      const value = typeof initial === 'function' ? initial(where.home) : initial;
      fs.writeFileSync(settingsPath, JSON.stringify(value), {mode});
      fs.chmodSync(settingsPath, mode);
      where.env.MESH_LAUNCH_SETTINGS = settingsPath;
    }
    const {child, result, output} = await runServer(where);
    assert.equal(result.listened, true, result.output);
    const nativeHost = nativePtyhost();
    const host = spawn(nativeHost[0], nativeHost.slice(1), {cwd: REPO, stdio: 'ignore',
      env: {PATH, HOME: where.home, XDG_RUNTIME_DIR: path.join(where.home, 'run'), LANG: 'C'}});
    await waitFor('ptyhost socket', 10000, () => fs.existsSync(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const mesh = new ConfigMesh(where.scratch, where.port, where.confDir, where.home, child, host, output);
    await mesh.signIn();
    return mesh;
  }

  token(): string { return fs.readFileSync(path.join(this.confDir, 'token'), 'utf8').trim(); }

  async signIn(): Promise<string> {
    const login = await fetch(`${this.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: this.token()})});
    this.cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(this.cookie, 'the owner signs in');
    return this.cookie;
  }

  /** Owner headers: the cookie (and the elevation cookie when `elevated`), a same-origin JSON request. */
  owner(elevated = true): Record<string, string> {
    const cookie = elevated && this.elevation ? `${this.cookie}; ${this.elevation}` : this.cookie;
    return {Cookie: cookie, Origin: this.base, 'Content-Type': 'application/json'};
  }

  async post(route: string, body: unknown, headers: Record<string, string> = this.owner()): Promise<Response> {
    return await fetch(`${this.base}${route}`, {method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body)});
  }

  /** Unlock editing with the master token; the elevation cookie is kept for `owner()`. */
  async elevate(): Promise<Response> {
    const response = await this.post('/api/config/elevate', {token: this.token()}, this.owner(false));
    const set = response.headers.get('set-cookie') ?? '';
    if (response.status === 200) this.elevation = set.split(';')[0]!;
    return response;
  }

  async config(): Promise<Record<string, any>> {
    const response = await fetch(`${this.base}/api/config`, {headers: this.owner()});
    assert.equal(response.status, 200);
    return await response.json() as Record<string, any>;
  }

  async revision(): Promise<string> { return (await this.config()).launch.revision; }

  file(): Settings { return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Settings; }

  async save(agents: string[], roots: string[], revision?: string): Promise<Response> {
    return await this.post('/api/config/launch', {revision: revision ?? await this.revision(), enabled_agents: agents, workspace_roots: roots});
  }

  /** The owner starts a session the way the page does; the master token is also accepted there. */
  async launch(preset: string, cwd: string, name: string): Promise<Response> {
    return await this.post('/api/new', {preset, cwd, name}, {Authorization: `Bearer ${this.token()}`, Origin: this.base, 'Content-Type': 'application/json'});
  }

  async stop(): Promise<void> {
    this.host.kill('SIGKILL');
    await stopServer(this.server);
    fs.rmSync(this.scratch, {recursive: true, force: true});
  }
}
