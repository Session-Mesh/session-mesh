// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A throwaway server.py for Node tests: its own HOME, config dir and port, driven over HTTP
// like a browser or a CLI would. Nothing here touches the caller's real home.
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {OWNER_CHECK, listensFrom} from './helpers/listener-owner.ts';

export const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';

/** Delete a scratch directory: the hooks directories Mesh hands to Vibe are read-only (0500), so they are made writable first. */
export function removeScratch(directory: string): void {
  const writable = (entry: string): void => {
    const info = fs.lstatSync(entry, {throwIfNoEntry: false});
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      fs.chmodSync(entry, 0o700);
      for (const name of fs.readdirSync(entry)) writable(path.join(entry, name));
    }
  };
  writable(directory);
  fs.rmSync(directory, {recursive: true, force: true});
}

/** The variables that move an agent's data away from HOME: a developer's own values would point the server at their real conversations. */
export const AGENT_DATA_ENV = ['XDG_DATA_HOME', 'OPENCODE_DB', 'COPILOT_HOME', 'VIBE_HOME', 'GEMINI_CLI_HOME', 'PI_CODING_AGENT_DIR'];

export type Mesh = {
  scratch: string;
  home: string;
  confDir: string;
  base: string;
  port: number;
  output: () => string;
  token: () => string;
  // SIGTERM and wait for the exit; the folders stay readable (stop removes them). `hurry`: a second SIGTERM
  // while the server waits for its requests, which makes asyncio cancel them (the handlers see CancelledError).
  halt: (hurry?: boolean) => Promise<void>;
  stop: () => Promise<void>;
};

export type Scratch = {scratch: string; home: string; confDir: string; env: NodeJS.ProcessEnv; port: number};

export function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port}, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

/** The listener must belong to the still-running child on both sides of the connection probe. */
export async function listenerReady(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>, port: number,
  owns = listensFrom, connect = accepts): Promise<boolean> {
  const running = (): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (!running() || !owns(child.pid!, port) || !await connect(port)) return false;
  return running() && owns(child.pid!, port);
}

/** A fresh home and the environment that confines server.py to it. */
export async function scratchHome(prefix: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Scratch> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(scratch, 'home');
  const confDir = path.join(home, '.config', 'session-mesh');
  const runtime = path.join(home, 'run');
  fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
  const port = await freePort();
  const inherited = {...process.env};
  for (const name of AGENT_DATA_ENV) delete inherited[name];   // every location then falls back under the scratch HOME
  const env: NodeJS.ProcessEnv = {...inherited, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_CONF_DIR: confDir, MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'),
    MESH_PORT: String(port),
    // GET /api/sessions answers from the background state, waiting at most 2 s for the round it asks for; these
    // tests read it right after a change, on loaded machines too. tests/sessions-state.test.ts keeps the default.
    MESH_SESSIONS_WAIT: '60', MESH_TEST_SESSIONS_COMPLETE: '1',
    ...extraEnv};
  delete env.MESH_HOST;
  delete env.MESH_ALLOW_NON_LOOPBACK;
  if (extraEnv.PATH !== undefined) {
    // Keep a declared fake-agent PATH after the system's login profile runs.
    const quoted = "'" + extraEnv.PATH.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH=${quoted}\n`, {mode: 0o600});
  }
  return {scratch, home, confDir, env, port};
}

export type Exit = {code: number | null; output: string; listened: boolean};

/** Run server.py until it listens or exits; the caller decides which one is expected. */
export async function runServer(where: Scratch): Promise<{child: ChildProcess; result: Exit; output: () => string}> {
  if (!OWNER_CHECK) throw new Error('Cannot verify server listener ownership: /proc or lsof required');
  let output = '';
  const [program, ...args] = [PYTHON, 'server.py'];
  const child = spawn(program!, args, {cwd: REPO, env: where.env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  let exited = false;
  const closed = new Promise<void>(resolve => child.on('close', () => { exited = true; resolve(); }));
  try {
    for (let attempt = 0; attempt < 400 && !exited; attempt += 1) {
      if (await listenerReady(child, where.port))
        return {child, result: {code: null, output, listened: true}, output: () => output};
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) {
    if (!exited) child.kill('SIGKILL');
    await closed;
    throw error;
  }
  if (!exited) child.kill('SIGKILL');
  await closed;
  return {child, result: {code: child.exitCode, output, listened: false}, output: () => output};
}

export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.on('close', resolve));
  child.kill('SIGTERM');
  await closed;
}

export async function startMesh(prefix: string, extraEnv: NodeJS.ProcessEnv = {},
                                prepare?: (where: Scratch) => void): Promise<Mesh> {
  const where = await scratchHome(prefix, extraEnv);
  prepare?.(where);   // before the server reads anything: files it must find at start
  const {child, result, output} = await runServer(where);
  if (!result.listened) {
    removeScratch(where.scratch);
    throw new Error(`server.py did not listen:\n${result.output}`);
  }
  return {
    scratch: where.scratch, home: where.home, confDir: where.confDir, port: where.port,
    base: `http://127.0.0.1:${where.port}`, output,
    token: () => fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim(),
    halt: async (hurry = false) => {
      if (!hurry) return stopServer(child);
      const closed = new Promise(resolve => child.on('close', resolve));
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 700));
      child.kill('SIGTERM');
      await closed;
    },
    stop: async () => {
      await stopServer(child);
      removeScratch(where.scratch);
    },
  };
}
