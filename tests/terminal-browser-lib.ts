// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A throwaway PTY host and server.py, and Chromium pages on them, for the terminal browser
// tests. Each run has its own HOME, configuration and runtime directory; nothing here reads
// the caller's MESH_* variables or reaches a running mesh.
// Host: the native one, named by MESH_PTYHOST_CMD (words separated by spaces).
// Chromium: MESH_CHROMIUM; without it the tests are skipped (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {removeScratch} from './mesh-server-lib.ts';
import {chromium, type Browser, type Page} from 'playwright-core';
import {BROWSER_LOCALE, chromiumLaunchOptions} from './helpers/browser-launch.ts';

export const REPO = path.resolve(import.meta.dirname, '..');
export const WITNESS = path.join(REPO, 'tests', 'fixtures', 'terminal-width-witness.mjs');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
export const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

// app.js script-scope bindings (global `let`/`const`, not properties of window), used inside
// page functions: the interface's policy refuses the eval a string expression needs.
type BufferLine = {isWrapped: boolean; translateToString(trim?: boolean): string};
export type PaneView = {
  id: string;
  term: {rows: number; cols: number; focus(): void; buffer: {active: {length: number; getLine(y: number): BufferLine | undefined}}};
  conn: {ws: WebSocket | null; replaying?: boolean; autoRedraw?: unknown; initialFollow?: unknown} | null;
  send(text: string): void;
};
declare global {
  // eslint-disable-next-line no-var
  var __sent: {t: string; rows?: number; cols?: number}[];
}

export type Viewport = {width: number; height: number};
export type PageOptions = {phone?: boolean; routes?: (page: Page) => Promise<void>};

export class TerminalMesh {
  /** Extra environment for the PTY host and the server (a test's own PATH entries, MESH_BIN_DIR…). */
  private readonly extraEnv: NodeJS.ProcessEnv;
  constructor(extraEnv: NodeJS.ProcessEnv = {}) {
    this.extraEnv = extraEnv;
  }
  readonly scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-term-'));
  readonly home = path.join(this.scratch, 'home');
  private readonly runtime = path.join(this.scratch, 'run');
  private readonly confDir = path.join(this.home, '.config', 'session-mesh');
  private readonly children: ChildProcess[] = [];
  private browser: Browser | null = null;
  output = '';
  base = '';

  get socketPath(): string {
    return path.join(this.runtime, 'session-mesh', 'ptyhost.sock');
  }

  async start(): Promise<void> {
    const port = await freePort();
    fs.mkdirSync(this.runtime, {recursive: true, mode: 0o700});
    fs.mkdirSync(this.home, {recursive: true});
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: this.home, SHELL: '/bin/bash',
      XDG_RUNTIME_DIR: this.runtime, XDG_CONFIG_HOME: path.join(this.home, '.config'),
      XDG_CACHE_HOME: path.join(this.home, '.cache'), MESH_CONF_DIR: this.confDir,
      MESH_CACHE_DIR: path.join(this.home, '.cache', 'session-mesh'), MESH_PORT: String(port), ...this.extraEnv};
    this.hostEnv = env;
    this.spawn(nativePtyhost(), env);
    await this.waitUntil('the PTY host', () => accepts({path: this.socketPath}));
    this.spawn([PYTHON, 'server.py'], env);
    await this.waitUntil('server.py', () => accepts({host: '127.0.0.1', port}));
    this.base = `http://127.0.0.1:${port}`;
    this.browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  }

  private hostEnv: NodeJS.ProcessEnv = {};

  /** Kill the PTY host (the first child) and start another on the same socket: what a host restart is for the sessions. */
  async restartHost(): Promise<void> {
    const old = this.children[0];
    const closed = new Promise(resolve => old.on('close', resolve));
    old.kill('SIGKILL');
    await closed;
    fs.rmSync(this.socketPath, {force: true});
    const index = this.children.length;
    this.spawn(nativePtyhost(), this.hostEnv);
    const [fresh] = this.children.splice(index, 1);
    this.children[0] = fresh;
    await this.waitUntil('the new PTY host', () => accepts({path: this.socketPath}));
  }

  /** Stop server.py (SIGTERM: it closes the pages' sockets with 1012) and start it again on the same port. */
  async restartServer(downMs = 0): Promise<void> {
    const old = this.children[1];
    const closed = new Promise(resolve => old.on('close', resolve));
    old.kill('SIGTERM');
    await closed;
    await new Promise(resolve => setTimeout(resolve, downMs));
    const index = this.children.length;
    this.spawn([PYTHON, 'server.py'], this.hostEnv);
    const [fresh] = this.children.splice(index, 1);
    this.children[1] = fresh;
    const port = Number(new URL(this.base).port);
    await this.waitUntil('server.py again', () => accepts({host: '127.0.0.1', port}));
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    for (const child of this.children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise(resolve => child.on('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    removeScratch(this.scratch);
  }

  token(): string {
    return fs.readFileSync(path.join(this.confDir, 'token'), 'utf8').trim();
  }

  async newShell(name: string): Promise<void> {
    const response = await fetch(`${this.base}/api/new`, {method: 'POST',
      body: JSON.stringify({preset: 'shell', cwd: this.home, name}),
      headers: {Authorization: `Bearer ${this.token()}`, 'Content-Type': 'application/json'}});
    assert.equal(response.status, 200, `${await response.text()}\n${this.output}`);
  }

  /** A signed-in page with `name` open in its pane, its replay and automatic redraw settled.
   * `init` runs in the page before app.js; `watch` gets the page before it loads. `options.phone`
   * emulates a touch phone (hover: none and a sidebar behind the Sessions button);
   * `options.routes` runs on the page before it loads. */
  async openPage(name: string, viewport: Viewport, init?: () => void, watch?: (page: Page) => void,
    options: PageOptions = {}): Promise<Page> {
    const page = await this.signIn(viewport, init, watch, options);
    if (options.phone === true) await page.locator('#btn-menu').click();
    // Status sections and pins can show the same session as the main list.
    await page.locator(`#list .item[data-id="${name}"]:not(.todo .item, .pin-row .item)`).click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 30000});
    await settle(page);
    return page;
  }

  /** A signed-in page showing the session list, no session open yet (on a phone, the sidebar
   * is still closed). Same arguments as `openPage` after the session name. */
  async signIn(viewport: Viewport, init?: () => void, watch?: (page: Page) => void,
    options: PageOptions = {}): Promise<Page> {
    assert.ok(this.browser, 'start() first');
    const phone = options.phone === true;
    const context = await this.browser.newContext({locale: BROWSER_LOCALE, viewport, hasTouch: phone, isMobile: phone});
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    watch?.(page);
    await options.routes?.(page);
    await page.goto(`${this.base}/login?token=${encodeURIComponent(this.token())}`);
    await page.goto(`${this.base}/`);
    await page.waitForFunction(() => document.querySelector('#list .item[data-id]') !== null, undefined, {timeout: 30000});
    return page;
  }

  private spawn(argv: string[], env: NodeJS.ProcessEnv): void {
    const child = spawn(argv[0], argv.slice(1), {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout?.on('data', chunk => { this.output += chunk; });
    child.stderr?.on('data', chunk => { this.output += chunk; });
    this.children.push(child);
  }

  private async waitUntil(what: string, ready: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (this.children.some(child => child.exitCode !== null)) break;
      if (await ready()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${what} did not start:\n${this.output}`);
  }
}

declare const active: PaneView | null;

/** A listing URL without `since`: the server then answers every session (`full: true`), not only the
 * rows changed since. For a route that rewrites rows, which a delta answer may not carry. */
export function withoutSince(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('since');
  return parsed.toString();
}

/** The replay is parsed and the automatic redraw (and the program's answer to it) is over. */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => active?.conn?.replaying === false && !active.conn.autoRedraw
    && !active.conn.initialFollow, undefined, {timeout: 30000});
  await page.waitForTimeout(600);
}

/** Every buffer row of the active pane, "w|" before a row that continues the one above. */
export function rows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const buffer = active!.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!;
      out.push((line.isWrapped ? 'w|' : ' |') + line.translateToString(true));
    }
    while (out.length && out[out.length - 1] === ' |') out.pop();
    return out;
  });
}

/** The program's rows: each terminal-wrapped row joined to the one it continues. */
export function logicalLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const buffer = active!.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!;
      const next = buffer.getLine(y + 1);
      const text = line.translateToString(!next?.isWrapped);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.map(text => text.trimEnd());
  });
}

export function countRows(lines: string[], wanted: string): number {
  return lines.filter(line => line.slice(2) === wanted).length;
}

export async function typeLine(page: Page, command: string): Promise<void> {
  await page.evaluate(text => active!.send(`${text}\r`), command);
}

/** Wait until a row of the active pane reads exactly `wanted`. */
export async function waitForRow(page: Page, wanted: string, timeout = 20000): Promise<void> {
  await page.waitForFunction(text => {
    const buffer = active!.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true) === text) return true;
    return false;
  }, wanted, {timeout});
}

/** Record every control message the page's sockets send, in window.__sent. */
export function recordControlMessages(): void {
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') window.__sent.push(JSON.parse(data));
    return send.call(this, data);
  };
}

/** recordControlMessages, in a browser set to the manual size mode (the client store key
 * sizeTakeover, static/size-takeover.ts): the banner and its button, no automatic take-over.
 * Self-contained, as it runs in the page. */
export function recordControlMessagesManual(): void {
  localStorage.setItem('mesh.sizeTakeover', '"manual"');
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') window.__sent.push(JSON.parse(data));
    return send.call(this, data);
  };
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function accepts(target: net.NetConnectOpts): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(target, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
