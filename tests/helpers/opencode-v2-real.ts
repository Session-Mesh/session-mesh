// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared setup for the tests that run the REAL OpenCode 2 binary (MESH_OPENCODE_V2_BIN) against a scripted
// OpenAI-compatible provider (fake-openai-provider.ts). The binary only ever sees a temporary HOME and temporary
// XDG_* directories: it never reads or writes the user's ~/.opencode, ~/.config/opencode or ~/.local/share/opencode.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {providerConfig, startFakeProvider, type FakeProvider} from './fake-openai-provider.ts';

export const REAL_BINARY = process.env.MESH_OPENCODE_V2_BIN ?? '';
export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const skipReal = REAL_BINARY && fs.existsSync(REAL_BINARY) ? false : 'MESH_OPENCODE_V2_BIN not set';

export type Result = {code: number | null; sessionID: string | null; texts: string[]; tools: {tool: string; output: unknown}[];
  stderr: string};

export class RealOpencode {
  readonly scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc2-real-'));
  readonly home = path.join(this.scratch, 'home');
  readonly work = path.join(this.scratch, 'work');
  readonly bin = path.join(this.scratch, 'bin');
  provider!: FakeProvider;

  async start(): Promise<void> {
    for (const dir of [this.home, this.work, this.bin, this.xdg('config', 'opencode'), this.xdg('data'), this.xdg('cache'),
      this.xdg('state'), path.join(this.scratch, 'run')]) fs.mkdirSync(dir, {recursive: true});
    fs.symlinkSync(REAL_BINARY, path.join(this.bin, 'opencode'));
    this.provider = await startFakeProvider();
  }

  async stop(): Promise<void> {
    await this.provider?.close();
    fs.rmSync(this.scratch, {recursive: true, force: true});
  }

  xdg(kind: 'config' | 'data' | 'cache' | 'state', ...rest: string[]): string {
    return path.join(this.scratch, 'xdg', kind, ...rest);
  }

  /** The environment of a process confined to this scratch (HOME, XDG_*, no variable of the caller). */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {PATH: `${this.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: this.home,
      XDG_CONFIG_HOME: this.xdg('config'), XDG_DATA_HOME: this.xdg('data'), XDG_CACHE_HOME: this.xdg('cache'),
      XDG_STATE_HOME: this.xdg('state'), XDG_RUNTIME_DIR: path.join(this.scratch, 'run'), TMPDIR: this.scratch,
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', ...extra};
  }

  /** The user's own OpenCode configuration file. */
  writeUserConfig(config: object | null): void {
    const file = this.xdg('config', 'opencode', 'opencode.json');
    if (config === null) fs.rmSync(file, {force: true});
    else fs.writeFileSync(file, JSON.stringify(config));
  }

  /** `opencode run --standalone` with `config` as OPENCODE_CONFIG_CONTENT (the provider is added to it). */
  run(prompt: string, config: object, extra: Record<string, string> = {}, args: string[] = []): Promise<Result> {
    const inline = JSON.stringify({...config, ...providerConfig(this.provider.port)});
    const child = spawn(REAL_BINARY, ['run', '--standalone', '--format', 'json', ...args, prompt], {
      cwd: this.work, stdio: ['ignore', 'pipe', 'pipe'], env: this.env({OPENCODE_CONFIG_CONTENT: inline, ...extra})});
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    return new Promise(resolve => child.on('close', code => {
      clearTimeout(timer);
      const result: Result = {code, sessionID: null, texts: [], tools: [], stderr: err};
      for (const line of out.split('\n')) {
        try {
          const event = JSON.parse(line);
          result.sessionID ??= event.sessionID ?? null;
          if (event.type === 'text') result.texts.push(event.part.text);
          if (event.type === 'tool_use') result.tools.push({tool: event.part.tool, output: event.part.state.output});
        } catch { /* not a JSON event line */ }
      }
      resolve(result);
    }));
  }
}

/** A local HTTP endpoint that records every request (the mesh's /api/event, for the plugin). */
export async function startListener(): Promise<{port: number; requests: {auth: string | undefined; body: any}[]; close(): Promise<void>}> {
  const requests: {auth: string | undefined; body: any}[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try { requests.push({auth: request.headers.authorization, body: JSON.parse(body)}); } catch { /* ignored */ }
      response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {port: (server.address() as {port: number}).port, requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })};
}
