// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The interface page (/), the sign-in page and the whiteboard carry a Content-Security-Policy
// (server.py: INDEX_CSP, LOGIN_CSP, BOARD_CSP), and nothing the interface really does trips it.
// A representative walk, in English and in French: sign in, a shell session in a terminal pane
// (xterm and its WebSocket), a Markdown document with a Mermaid diagram opened in a pane, the
// session's whiteboard, the history tab, the filter, the new-session dialog. Every
// `securitypolicyviolation` raised by one of those three documents fails the test (the documents
// framed under /view have their own, stricter policy, which a document may well trip).
// The other pages under /static carry the policy of the file they resolve to, whatever the URL
// spells (/static/index.html, /static/board.html/), and a malformed hash (/#%E0%A4%A) does not
// stop the interface from starting.
// The server and the PTY host run with a throwaway HOME.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Frame, type Page} from 'playwright-core';
import {ptyhostArgv} from './ptyhost-command.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const WATCHED = new Set(['/', '/login', '/static/board.html']);
const DOCUMENT = '# CSP walk\n\n```mermaid\ngraph TD\n  A[start] --> B[end]\n```\n\n```js\nconst x = 1;\n```\n';

type Violation = {page: string; directive: string; blocked: string; sample: string};
// app.js script-scope binding (a global `let`, not a property of window).
declare const panes: {id: string}[];
declare const restoringWorkspace: boolean;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-main-page-'));
const home = path.join(scratch, 'home');
const runtime = path.join(scratch, 'run');
const confDir = path.join(home, '.config', 'session-mesh');
const children: ChildProcess[] = [];
let output = '';
let base = '';

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

async function waitUntil(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (children.some(child => child.exitCode !== null)) break;
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${what} did not start:\n${output}`);
}

function start(argv: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(argv[0], argv.slice(1), {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  children.push(child);
}

const token = (): string => fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim();

async function api(route: string, body: object): Promise<void> {
  const response = await fetch(`${base}${route}`, {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, `${route}: ${await response.text()}\n${output}`);
}

// Records the violations of the watched documents, whatever frame they are in.
async function watchViolations(context: BrowserContext): Promise<Violation[]> {
  const violations: Violation[] = [];
  await context.exposeBinding('__meshCspViolation', (_source, violation: Violation) => {
    if (WATCHED.has(violation.page)) violations.push(violation);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      const report = (window as unknown as {__meshCspViolation: (v: object) => void}).__meshCspViolation;
      report({page: location.pathname, directive: event.effectiveDirective, blocked: event.blockedURI,
        sample: event.sample});
    });
  });
  return violations;
}

function policyOf(headers: Record<string, string>): Map<string, string[]> {
  const policy = headers['content-security-policy'] ?? '';
  return new Map(policy.split(';').map(part => part.trim().split(/\s+/)).filter(words => words[0])
    .map(([name, ...values]) => [name, values]));
}

async function signIn(page: Page): Promise<void> {
  const response = await page.goto(`${base}/login`);
  const policy = policyOf(response?.headers() ?? {});
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.deepEqual(policy.get('style-src'), ["'self'"]);
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
  await page.locator('input[name="token"]').fill(token());
  await Promise.all([page.waitForURL(`${base}/`), page.locator('form button').click()]);
}

async function frameWhere(page: Page, accept: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = page.frames().find(accept);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`no such frame among ${page.frames().map(frame => frame.url()).join(', ')}`);
}

// The shell's prompt reaches xterm over the terminal WebSocket; xterm has inserted its <style>.
async function useTerminal(page: Page): Promise<void> {
  await page.locator('.xterm').first().waitFor();
  await page.waitForFunction(() => /\S/.test(document.querySelector('.xterm-rows')?.textContent ?? ''));
  await page.locator('.xterm').first().click();
}

async function openDocument(page: Page, file: string): Promise<void> {
  await api('/api/open', {target: file});
  const frame = await frameWhere(page, candidate => new URL(candidate.url(), base).pathname.startsWith('/view/'));
  await frame.locator('pre.mermaid svg').waitFor({timeout: 15000});
}

async function openBoard(page: Page): Promise<void> {
  await page.locator('[data-act="board"]').first().click();
  const frame = await frameWhere(page, candidate => candidate.url().includes('/static/board.html'));
  await frame.locator('[data-testid="toolbar-selection"]').waitFor({state: 'attached', timeout: 15000});
}

async function browseTheSidebar(page: Page): Promise<void> {
  await page.locator('#tab-hist').click();
  await page.locator('#tab-live').click();
  await page.locator('#filter').fill('csp');
  await page.locator('#filter').fill('');
  await page.locator('#btn-new').click();
  await page.keyboard.press('Escape');
}

describe('the interface pages run under their Content-Security-Policy', {skip}, () => {
  let browser: Browser;

  before(async () => {
    const port = await freePort();
    fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
    fs.mkdirSync(home, {recursive: true});
    const env: NodeJS.ProcessEnv = {...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      MESH_CONF_DIR: confDir, MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'), MESH_PORT: String(port),
      SHELL: '/bin/bash', LANG: 'C.UTF-8'};
    delete env.MESH_HOST;
    delete env.MESH_ALLOW_NON_LOOPBACK;
    start(ptyhostArgv(), env);
    await waitUntil('the PTY host', () => accepts({path: path.join(runtime, 'session-mesh', 'ptyhost.sock')}));
    start([PYTHON, 'server.py'], env);
    await waitUntil('server.py', () => accepts({host: '127.0.0.1', port}));
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  });

  after(async () => {
    await browser?.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise(resolve => child.on('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  test('the sign-in assets are public, and the whiteboard may only be framed by the interface', async () => {
    for (const asset of ['/static/login.js', '/static/login.css']) {
      assert.equal((await fetch(`${base}${asset}`, {redirect: 'manual'})).status, 200, asset);
    }
    assert.equal((await fetch(`${base}/static/app.js`, {redirect: 'manual'})).status, 302);
    const board = await fetch(`${base}/static/board.html`, {headers: {Authorization: `Bearer ${token()}`}});
    const policy = policyOf(Object.fromEntries(board.headers));
    assert.deepEqual(policy.get('frame-ancestors'), ["'self'"]);
    assert.deepEqual(policy.get('object-src'), ["'none'"]);
  });

  // Every page under /static carries the policy of the file it resolves to,
  // whatever the URL spells; and a malformed hash does not stop the interface from starting.
  async function signedIn(): Promise<{page: Page; errors: string[]; close: () => Promise<void>}> {
    const context = await browser.newContext({viewport: {width: 1400, height: 900}});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/login?token=${encodeURIComponent(token())}`);
    return {page, errors, close: () => context.close()};
  }

  test('/static/index.html runs no injected inline script nor onerror attribute', async () => {
    const {page, close} = await signedIn();
    const response = await page.goto(`${base}/static/index.html`);
    assert.equal(response?.status(), 200);
    const ran = await page.evaluate(async () => {
      const flags = window as unknown as {__meshInline?: boolean; __meshOnerror?: boolean};
      const script = document.createElement('script');
      script.textContent = 'window.__meshInline = true';
      document.head.append(script);
      const holder = document.createElement('div');
      holder.innerHTML = '<img src="/static/absent.png" onerror="window.__meshOnerror = true">';
      document.body.append(holder);
      await new Promise(resolve => setTimeout(resolve, 300));
      return {inline: flags.__meshInline === true, onerror: flags.__meshOnerror === true};
    });
    assert.deepEqual(ran, {inline: false, onerror: false});
    const policy = policyOf(response?.headers() ?? {});
    assert.deepEqual(policy.get('script-src'), ["'self'"], output);
    assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
    await close();
  });

  for (const url of ['/static/board.html', '/static/board.html/', '/static/./board.html']) {
    test(`${url} carries BOARD_CSP`, async () => {
      const {page, close} = await signedIn();
      const response = await page.goto(`${base}${url}`);
      assert.equal(response?.status(), 200);
      const policy = policyOf(response?.headers() ?? {});
      assert.deepEqual(policy.get('frame-ancestors'), ["'self'"], url);
      assert.deepEqual(policy.get('form-action'), ["'none'"], url);
      assert.deepEqual(policy.get('script-src'), ["'self'"], url);
      await close();
    });
  }

  test('any other file under /static, opened as a document, runs nothing', async () => {
    for (const url of ['/static/code.html', '/static/markdown.html', '/static/favicon.svg', '/static/login.html/']) {
      const response = await fetch(`${base}${url}`, {headers: {Authorization: `Bearer ${token()}`}});
      assert.equal(response.status, 200, url);
      const policy = policyOf(Object.fromEntries(response.headers));
      if (url.startsWith('/static/login.html')) {
        assert.deepEqual(policy.get('script-src'), ["'self'"], url);
        assert.deepEqual(policy.get('style-src'), ["'self'"], url);
      } else {
        assert.deepEqual(policy.get('default-src'), ["'none'"], url);
        assert.ok(policy.has('sandbox'), url);
      }
    }
  });

  test('a malformed escape in the hash does not stop the interface from starting', async () => {
    const {page, errors, close} = await signedIn();
    await page.goto('about:blank');
    await page.goto(`${base}/#%E0%A4%A`);
    // A function, not a string: the policy refuses the eval a string predicate needs.
    await page.waitForFunction(() => panes.length > 0 && !restoringWorkspace, undefined, {timeout: READY_TIMEOUT_MS});
    assert.deepEqual(errors, []);
    await close();
  });

  for (const locale of ['en-US', 'fr-FR']) {
    test(`a walk through the interface in ${locale} trips no policy`, async () => {
      const name = `csp-${locale.slice(0, 2)}`;
      const file = path.join(home, `${name}.md`);
      fs.writeFileSync(file, DOCUMENT);
      await api('/api/new', {preset: 'shell', cwd: home, name});
      const context = await browser.newContext({locale, viewport: {width: 1400, height: 900}});
      const violations = await watchViolations(context);
      const page = await context.newPage();
      await signIn(page);
      await page.goto('about:blank'); // a full load of /, not a same-document hash change
      const response = await page.goto(`${base}/#${name}`);
      const policy = policyOf(response?.headers() ?? {});
      assert.deepEqual(policy.get('script-src'), ["'self'"]);
      assert.deepEqual(policy.get('object-src'), ["'none'"]);
      assert.deepEqual(policy.get('base-uri'), ["'none'"]);
      assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
      // A function, not a string: the policy refuses the eval a string predicate needs.
      await page.waitForFunction(expected => panes.some(pane => pane.id === expected), name);
      await useTerminal(page);
      await openDocument(page, file);
      await openBoard(page);
      await browseTheSidebar(page);
      assert.deepEqual(violations, [], output);

      // The watch itself works, and an injected inline script does not run.
      const ran = await page.evaluate(() => {
        const script = document.createElement('script');
        script.textContent = 'window.__meshInlineRan = true';
        document.head.append(script);
        return (window as unknown as {__meshInlineRan?: boolean}).__meshInlineRan === true;
      });
      assert.equal(ran, false);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(violations.map(violation => [violation.page, violation.directive]), [['/', 'script-src-elem']]);
      await context.close();
    });
  }
});
