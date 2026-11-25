// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Actual Mesh app/navigation + checked-in generated assets + real mesh-profile/SQLite.
// GET /api/config is intercepted to advertise the TEST capability account_settings:true;
// the real server at this base does NOT advertise it. The SIX /api/accounts/** routes are
// intercepted using the agreed fixed HTTP contract below. Lifecycle cases also serve a benign
// local-entry.js so the actual app can be tested before its real MeshUI.startLocalMesh() is
// called; every other case serves all real generated assets.
// This does NOT qualify the real server accounts routes/authentication, or provider launch/switching.
// MESH_BACKEND_ACCOUNT_HELPER explicitly selects a built mesh-profile (never MESH_PROFILE_CMD).
// Without that artifact/Chromium this qualification skips; MESH_REQUIRE_BACKEND_ACCOUNT_APP=1
// makes missing prerequisites a failure. MESH_REQUIRE_BROWSER=1 independently requires Chromium.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page, type Route} from 'playwright-core';
import {REPO, removeScratch, startMesh, type Scratch} from './mesh-server-lib.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const HELPER = process.env.MESH_BACKEND_ACCOUNT_HELPER || path.join(REPO, 'ocaml/_build/default/bin/mesh_profile_main.exe');
const CHROMIUM = process.env.MESH_CHROMIUM || '';
const required = process.env.MESH_REQUIRE_BACKEND_ACCOUNT_APP === '1';
const skip = !CHROMIUM
  ? (required || process.env.MESH_REQUIRE_BROWSER ? false : 'accounts app qualification: set MESH_CHROMIUM')
  : !fs.existsSync(HELPER) && !required ? 'accounts app qualification: built mesh-profile required (MESH_BACKEND_ACCOUNT_HELPER)' : false;
const BACKENDS = ['claude', 'codex', 'opencode-v2', 'pi'] as const;
const LABEL = '界'.repeat(24);
const catalogs = Object.fromEntries(['en', 'fr'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(REPO, 'static/i18n', `${lang}.json`), 'utf8')) as Record<string, string>]));
const ROUTES = {
  'GET /api/accounts/profiles': 'profiles.list',
  'GET /api/accounts/consent': 'consent.get',
  'POST /api/accounts/consent/set-global': 'consent.set_global',
  'POST /api/accounts/consent/set-pair': 'consent.set_pair',
  'POST /api/accounts/consent/remove-pair': 'consent.remove_pair',
  'POST /api/accounts/consent/reset': 'consent.reset',
} as const;
type Operation = typeof ROUTES[keyof typeof ROUTES];
type NativeReply = {version: number; ok: boolean; http_status: number; data?: {revision?: number; global?: string;
  pairs?: {a: {backend: string; id: string}; b: {backend: string; id: string}; confirmation: string}[];
  profiles?: Record<string, unknown>[]}; code?: string};
type Call = {op: Operation; body: Record<string, unknown>; reply?: NativeReply};
declare const MeshUI: {startLocalMesh(): Promise<{dispose(): void}>};
declare global { interface Window { backendAccountsTestRuntime?: {dispose(): void} } }
let browser: Browser;

before(async () => {
  if (skip) return;
  assert.ok(CHROMIUM, 'required accounts app qualification needs MESH_CHROMIUM');
  fs.accessSync(HELPER, fs.constants.X_OK);
  assert.ok(fs.statSync(fs.realpathSync(HELPER)).isFile(), 'mesh-profile artifact must be an executable file');
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => { await browser?.close(); });

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
// Keep every cleanup stage independent: a rejected/timed-out browser close must not leave
// server.py alive. Its close receipt, not a timeout or a sent signal, permits scratch removal.
async function cleanupAccountsFixture(stages: {
  contexts(): Promise<unknown>; routes(): Promise<unknown>; helpers(): Promise<unknown>;
  halt(): Promise<unknown>; remove(): void; verify(): void;
}): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<unknown>, ms: number, label: string): Promise<boolean> => {
    try { await bounded(Promise.resolve().then(action), ms, label); return true; }
    catch (error) { failures.push(error); return false; }
  };
  await attempt(stages.contexts, 10_000, 'browser context cleanup');
  await attempt(stages.routes, 6000, 'accounts route cleanup');
  await attempt(stages.helpers, 2000, 'native helper cleanup');
  const stopped = await attempt(stages.halt, 10_000, 'throwaway Mesh shutdown');
  if (stopped) { try { stages.remove(); } catch (error) { failures.push(error); } }
  try { stages.verify(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'accounts fixture cleanup failed');
}
async function preserveFailure(run: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let failed = false, original: unknown;
  try { await run(); } catch (error) { failed = true; original = error; }
  try { await cleanup(); } catch (error) {
    if (failed) throw new AggregateError([original, error], 'accounts test and cleanup both failed');
    throw error;
  }
  if (failed) throw original;
}
function prepare(where: Scratch): void {
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700}); fs.chmodSync(where.confDir, 0o700);
  const root = fs.realpathSync(where.confDir);
  const profiles = BACKENDS.flatMap(backend => ['a', 'b', 'c'].map(id => {
    const roles = backend === 'opencode-v2' ? ['config', 'data', 'state', 'cache'] : backend === 'codex' ? ['config', 'state'] : ['config', 'history'];
    const roots = Object.fromEntries(roles.map(role => {
      const directory = path.join(root, 'test-profiles', backend, id, role);
      fs.mkdirSync(directory, {recursive: true, mode: 0o700}); fs.chmodSync(directory, 0o700);
      return [role, fs.realpathSync(directory)];
    }));
    return {backend, id, label: id === 'a' ? 'Work <img src=x>' : id === 'b' ? 'Personal' : LABEL, enabled: true, roots};
  }));
  fs.writeFileSync(path.join(root, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
}

async function fixture() {
  const mesh = await startMesh('backend-accounts-app-', {
    MESH_PROFILE_CMD: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined,
    XDG_STATE_HOME: undefined, XDG_DATA_HOME: undefined, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined,
  }, prepare);
  const children = new Set<ChildProcess>(), contexts = new Set<BrowserContext>(), tasks = new Set<Promise<void>>();
  const problems: string[] = [], calls: Call[] = [];
  let fault: {op: Operation; kind: 'private' | 'version' | 'helper-unavailable'} | null = null;
  const configRequests: string[] = [];
  const configHolds = new Set<ReturnType<typeof deferred<void>>>();
  type Hold = {committed: ReturnType<typeof deferred<NativeReply>>; release: ReturnType<typeof deferred<'reply' | 'drop'>>;
    finished: ReturnType<typeof deferred<void>>};
  let nextHold: Hold | null = null, nextProfilesHold: Hold | null = null;
  const holds = new Set<Hold>();
  async function native(op: Operation, body: Record<string, unknown> = {}): Promise<NativeReply> {
    assert.ok(Object.values(ROUTES).includes(op), 'helper operation is explicitly whitelisted');
    assert.equal(Object.hasOwn(body, 'version') || Object.hasOwn(body, 'op'), false, 'HTTP bodies omit version/op');
    const input = JSON.stringify(body); assert.ok(Buffer.byteLength(input) <= 131072);
    const child = spawn(HELPER, ['--http', op], {cwd: mesh.scratch, env: {
      HOME: mesh.home, MESH_CONF_DIR: mesh.confDir, XDG_CONFIG_HOME: path.join(mesh.home, '.config'),
      XDG_CACHE_HOME: path.join(mesh.home, '.cache'), XDG_RUNTIME_DIR: path.join(mesh.home, 'run'),
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', EIO_BACKEND: 'posix', TMPDIR: mesh.scratch,
    }, stdio: ['pipe', 'pipe', 'pipe']});
    children.add(child);
    let output = '', stderrBytes = 0, failure: Error | null = null, killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string) => {
      failure ??= new Error(reason); child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const timer = setTimeout(() => terminate('native accounts helper timed out'), 5000);
    child.on('error', () => { failure = new Error('native accounts helper could not start'); });
    child.stdin.on('error', () => { failure ??= new Error('native accounts helper stdin failed'); });
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 1048576) terminate('native reply exceeded bound'); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) terminate('native stderr exceeded bound'); });
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    child.stdin.end(input);
    try {
      const exit = await closed;
      if (failure) throw failure;
      const reply = JSON.parse(output) as NativeReply;
      assert.equal(reply.version, 1); assert.equal(typeof reply.ok, 'boolean');
      assert.ok([200, 400, 404, 409, 413, 503].includes(reply.http_status));
      assert.equal(exit, reply.ok ? 0 : 1, 'native process exit matches its real public reply');
      return reply;
    } finally { clearTimeout(timer); clearTimeout(killTimer); children.delete(child); }
  }
  async function handle(route: Route): Promise<void> {
    const request = route.request(), url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}` as keyof typeof ROUTES;
    assert.equal(url.origin, mesh.base); assert.equal(url.search, '');
    assert.ok(Object.hasOwn(ROUTES, key), `unexpected accounts route: ${key}`);
    const op = ROUTES[key];
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {};
    if (request.method() === 'POST') assert.match(request.headers()['content-type'] ?? '', /^application\/json/);
    const call: Call = {op, body}; calls.push(call);
    const hold = request.method() === 'POST' ? nextHold : op === 'profiles.list' ? nextProfilesHold : null;
    if (hold) { if (request.method() === 'POST') nextHold = null; else nextProfilesHold = null; }
    const reply = await native(op, body); call.reply = reply;
    if (hold) {
      hold.committed.resolve(reply);
      try {
        const action = await hold.release.promise;
        if (action === 'drop') { await route.abort('failed').catch(() => undefined); return; }
      } finally { holds.delete(hold); hold.finished.resolve(); }
    }
    if (fault?.op === op) {
      if (fault.kind === 'helper-unavailable') {
        fault = null;
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({
          version: 1, ok: false, http_status: 503, code: 'backend-helper-unavailable',
        })}); return;
      }
      if (fault.kind === 'version') reply.version = 2;
      else if (op === 'profiles.list') reply.data!.profiles![0]!.roots = {config: path.join(mesh.confDir, 'private-reply-marker')};
      else Object.assign(reply.data!, {credentials: path.join(mesh.confDir, 'private-reply-marker')});
      fault = null;
    }
    await route.fulfill({status: reply.http_status, contentType: 'application/json', headers: {'cache-control': 'no-store'}, body: JSON.stringify(reply)});
  }
  async function context(lang = 'en', width = 1440, config: {flag?: unknown; status?: number;
    hold?: ReturnType<typeof deferred<void>>} = {flag: true}): Promise<BrowserContext> {
    const context = await browser.newContext({locale: lang, viewport: {width, height: 900}, serviceWorkers: 'block'});
    contexts.add(context); context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(READY_TIMEOUT_MS);
    await context.route(`${mesh.base}/api/config`, route => {
      const task = (async () => {
        assert.equal(route.request().method(), 'GET'); configRequests.push(route.request().url());
        if (config.hold) { configHolds.add(config.hold); await config.hold.promise; configHolds.delete(config.hold); }
        // A private configuration value must never be rendered by this availability check.
        await route.fulfill({status: config.status ?? 200, contentType: 'application/json', body: JSON.stringify({
          private_marker: mesh.confDir, capabilities: config.flag === undefined ? {} : {account_settings: config.flag},
        })}).catch(() => undefined); // Disposal can abort a held config fetch.
      })();
      tasks.add(task); void task.finally(() => tasks.delete(task)); return task;
    });
    await context.route(`${mesh.base}/api/accounts/**`, route => {
      const task = handle(route).catch(async error => { problems.push(String(error)); await route.abort('failed').catch(() => undefined); });
      tasks.add(task); void task.finally(() => tasks.delete(task)); return task;
    });
    return context;
  }
  async function page(context: BrowserContext, lang = 'en', started = true, available = true): Promise<Page> {
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(String(error)));
    page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    const bundle = page.waitForResponse(response => new URL(response.url()).pathname === '/static/pane-actions.js');
    await page.goto(`${mesh.base}/`);
    assert.equal(await page.locator('link[href^="/static/backend-account-panel.css?v="]').count(), 1, 'the panel stylesheet is cache-versioned');
    assert.equal((await (await bundle).body()).toString(), fs.readFileSync(path.join(REPO, 'static/pane-actions.js'), 'utf8'), 'served generated bundle is the current worktree asset');
    if (started) {
      await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null && !meshStopped', undefined, {timeout: READY_TIMEOUT_MS});
      if (available) {
        await page.locator('dialog.backend-account-panel').waitFor({state: 'attached'});
        assert.equal(await page.locator('#btn-accounts').textContent(), text(lang, 'title'));
      }
    } else {
      await page.waitForFunction('typeof MeshUI !== "undefined" && typeof MeshUI.startLocalMesh === "function"', undefined, {timeout: READY_TIMEOUT_MS});
      assert.equal(await page.evaluate('meshContext === null && !meshStopped'), true, 'the actual Mesh runtime has not started');
    }
    return page;
  }
  async function dispose(): Promise<void> {
    for (const hold of holds) hold.release.resolve('drop');
    for (const hold of configHolds) hold.resolve();
    await cleanupAccountsFixture({
      contexts: () => Promise.all(Array.from(contexts, context => context.close())),
      routes: () => Promise.all(Array.from(tasks)),
      helpers: async () => {
        await Promise.all(Array.from(children, child => new Promise<void>(resolve => {
          child.once('close', () => resolve()); child.kill('SIGKILL');
        })));
        assert.equal(children.size, 0, 'all one-shot native helper children were reaped');
      },
      halt: () => mesh.halt(true),
      remove: () => { removeScratch(mesh.scratch); assert.equal(fs.existsSync(mesh.scratch), false, 'private fixture data removed after server exit'); },
      verify: () => assert.deepEqual(problems, [], 'no page/CSP/route fixture failures'),
    });
  }
  try {
    const profiles = await native('profiles.list'); assert.equal(profiles.ok, true); assert.equal(profiles.data?.profiles?.length, 12);
    const policy = await native('consent.get'); assert.equal(policy.ok, true); assert.equal(policy.data?.revision, 0);
  } catch (error) { await preserveFailure(async () => { throw error; }, dispose); throw error; }
  function newHold() {
    const hold: Hold = {committed: deferred<NativeReply>(), release: deferred<'reply' | 'drop'>(), finished: deferred<void>()}; holds.add(hold);
    return {hold, received: () => bounded(hold.committed.promise, 8000, 'native held reply'),
      release: (mode: 'reply' | 'drop') => hold.release.resolve(mode),
      finished: () => bounded(hold.finished.promise, 8000, 'held route completion')};
  }
  return {mesh, native, context, page, dispose, calls, configRequests,
    posts: () => calls.filter(call => call.op.startsWith('consent.') && call.op !== 'consent.get'),
    fault(op: Operation, kind: 'private' | 'version' | 'helper-unavailable') { fault = {op, kind}; },
    holdWrite() { const pending = newHold(); nextHold = pending.hold;
      return {committed: pending.received, release: pending.release}; },
    holdProfiles() { const pending = newHold(); nextProfilesHold = pending.hold;
      return {received: pending.received, release: pending.release, finished: pending.finished}; },
  };
}
async function withFixture(run: (lab: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const lab = await fixture(); await preserveFailure(() => run(lab), lab.dispose);
}

const dialog = (page: Page) => page.locator('dialog.backend-account-panel');
const control = (page: Page, name: string) => dialog(page).locator(`[data-focus="${name}"]`);
const text = (lang: string, key: string) => catalogs[lang]![`backendAccounts.${key}`]!;
async function status(page: Page, lang: string, phase: string) {
  await dialog(page).getByRole('status').filter({hasText: text(lang, `status.${phase}`)}).waitFor();
}
async function open(page: Page, lang = 'en', width = 1440) {
  if (width === 390) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-accounts"]').click();
    assert.equal(await page.locator('#mobile-actions-sheet').evaluate((node: HTMLDialogElement) => node.open), false);
  } else await page.locator('#btn-accounts').click();
  await status(page, lang, 'ready');
  assert.equal(await page.getByRole('dialog', {name: text(lang, 'title')}).count(), 1);
}
async function pair(page: Page, backend: typeof BACKENDS[number]) {
  await control(page, 'add-pair').click(); await control(page, 'pair-backend').selectOption(backend);
  await control(page, 'pair-a').selectOption('a'); await control(page, 'pair-b').selectOption('b');
}
async function fits(page: Page) {
  assert.deepEqual(await dialog(page).evaluate(box => {
    const bounds = box.getBoundingClientRect();
    return {page: document.documentElement.scrollWidth <= innerWidth, dialog: box.scrollWidth <= box.clientWidth,
      bounds: bounds.left >= 0 && bounds.right <= innerWidth,
      controls: Array.from(box.querySelectorAll('button, select, fieldset')).every(el => el.scrollWidth <= el.clientWidth)};
  }), {page: true, dialog: true, bounds: true, controls: true});
}

test('running app: EN/FR desktop/mobile navigation, explicit four-backend Ask exceptions and real SQLite persistence', {skip, timeout: 120_000}, async () => {
  await withFixture(async lab => {
    for (const lang of ['en', 'fr']) for (const width of [1440, 390]) {
      const context = await lab.context(lang, width); let page = await lab.page(context, lang);
      const before = lab.posts().length;
      await open(page, lang, width); assert.equal(lab.posts().length, before);
      assert.equal(await dialog(page).locator('img, script').count(), 0);
      assert.ok((await dialog(page).textContent())!.includes(LABEL), 'full native 24-character Unicode label retained');
      for (const backend of BACKENDS) assert.ok((await dialog(page).textContent())!.includes(text(lang, `backend.${backend}`)));
      await control(page, 'global-skip').check(); assert.equal(lab.posts().length, before);
      await control(page, 'save-global').click(); await status(page, lang, 'saved');
      for (const backend of BACKENDS) {
        const count = lab.posts().length; await pair(page, backend);
        assert.equal(lab.posts().length, count, 'opening and selecting never writes');
        assert.equal(await dialog(page).locator('[data-preview]').textContent(), text(lang, 'previewOverride'));
        await fits(page); await control(page, 'save-pair').click(); await status(page, lang, 'saved');
        const row = dialog(page).locator(`[data-rule="${backend}:a:b"]`);
        assert.ok((await row.textContent())!.includes(text(lang, 'effective').replace('{confirmation}', text(lang, 'ask'))));
      }
      const persisted = (await lab.native('consent.get')).data!;
      assert.equal(persisted.global, 'skip'); assert.equal(persisted.pairs?.length, 4);
      assert.deepEqual(persisted.pairs!.map(rule => [rule.a.backend, rule.a.id, rule.b.id, rule.confirmation]).sort(),
        BACKENDS.map(backend => [backend, 'a', 'b', 'ask']).sort());
      const db = path.join(lab.mesh.confDir, 'backend-accounts.sqlite');
      assert.equal(fs.readFileSync(db).subarray(0, 16).toString(), 'SQLite format 3\0');
      assert.equal(fs.statSync(db).mode & 0o777, 0o600);
      const writes = lab.posts().length;
      await page.close(); page = await lab.page(context, lang); await open(page, lang, width);
      assert.equal(await control(page, 'global-skip').isChecked(), true);
      assert.equal(await dialog(page).locator('[data-rule]').count(), 4);
      await page.reload(); await page.waitForFunction('meshContext !== null && !meshStopped', undefined, {timeout: READY_TIMEOUT_MS});
      await open(page, lang, width); assert.equal(lab.posts().length, writes, 'page replacement/reload only reads persisted policy');
      await fits(page); await control(page, 'reset').click(); await status(page, lang, 'saved');
      assert.deepEqual((await lab.native('consent.get')).data?.pairs, []);
      assert.equal((await lab.native('consent.get')).data?.global, 'ask');
      await control(page, 'close').click();
      assert.equal(await page.locator(width === 390 ? '#btn-mobile-actions' : '#btn-accounts').evaluate(el => el === document.activeElement), true);
      await context.close();
    }
  });
});

test('running app: two pages receive a real native revision conflict and must explicitly refresh/review', {skip, timeout: 60_000}, async () => {
  await withFixture(async lab => {
    const context = await lab.context(), first = await lab.page(context), second = await lab.page(context);
    await open(first); await open(second);
    await control(first, 'global-skip').check(); await control(first, 'save-global').click(); await status(first, 'en', 'saved');
    await pair(second, 'pi'); await control(second, 'save-pair').click(); await status(second, 'en', 'conflict');
    const refused = lab.posts().at(-1)!;
    assert.equal(refused.body.expected_revision, 0); assert.equal(refused.reply?.http_status, 409);
    assert.equal(refused.reply?.code, 'consent-revision-conflict');
    assert.equal(await control(second, 'save-global').isDisabled(), true);
    assert.equal(await control(second, 'add-pair').isDisabled(), true);
    const count = lab.posts().length;
    await control(second, 'refresh').click(); await status(second, 'en', 'ready');
    assert.equal(lab.posts().length, count, 'refresh never replays the refused mutation');
    assert.equal(await control(second, 'save-pair').count(), 0, 'stale draft requires a fresh review');
    assert.equal(await control(second, 'global-skip').isChecked(), true);
    await pair(second, 'pi'); await control(second, 'save-pair').click(); await status(second, 'en', 'saved');
    assert.equal(lab.posts().at(-1)!.body.expected_revision, 1);
    const actual = (await lab.native('consent.get')).data!;
    assert.equal(actual.revision, 2); assert.equal(actual.global, 'skip'); assert.equal(actual.pairs?.[0]?.confirmation, 'ask');
  });
});

test('running app: malformed/private native-route replies fail closed without displaying paths or retrying', {skip, timeout: 60_000}, async () => {
  await withFixture(async lab => {
    const context = await lab.context('fr', 390), page = await lab.page(context, 'fr');
    lab.fault('profiles.list', 'private');
    await page.locator('#btn-mobile-actions').click(); await page.locator('[data-mobile-action="btn-accounts"]').click();
    await status(page, 'fr', 'loadError');
    assert.equal(await control(page, 'save-global').count(), 0); assert.equal(lab.posts().length, 0);
    assert.ok(!(await dialog(page).textContent())!.includes(lab.mesh.confDir));
    await control(page, 'refresh').click(); await status(page, 'fr', 'ready');
    lab.fault('consent.get', 'version'); await control(page, 'refresh').click(); await status(page, 'fr', 'loadError');
    assert.equal(await control(page, 'add-pair').count(), 0); assert.equal(lab.posts().length, 0);
    await control(page, 'refresh').click(); await status(page, 'fr', 'ready');
    lab.fault('consent.set_global', 'private');
    await control(page, 'global-skip').check(); await control(page, 'save-global').click(); await status(page, 'fr', 'error');
    assert.equal(await control(page, 'save-global').isDisabled(), true);
    assert.ok(!(await dialog(page).textContent())!.includes('private-reply-marker'));
    assert.ok(!(await dialog(page).textContent())!.includes(lab.mesh.confDir));
    assert.equal((await lab.native('consent.get')).data?.global, 'skip', 'malformed ACK is not proof of an uncommitted write');
    await control(page, 'refresh').click(); await status(page, 'fr', 'ready');
    assert.equal(await control(page, 'global-skip').isChecked(), true); assert.equal(lab.posts().length, 1);
  });
});

test('running app: a native commit with held/lost ACK survives close/reopen/reload without automatic writes', {skip, timeout: 60_000}, async () => {
  await withFixture(async lab => {
    const context = await lab.context(); let page = await lab.page(context);
    await open(page); const hold = lab.holdWrite();
    await control(page, 'global-skip').check(); await control(page, 'save-global').click();
    assert.equal((await hold.committed()).data?.global, 'skip'); await status(page, 'en', 'saving');
    assert.equal(await control(page, 'reset').isDisabled(), true); assert.equal(await control(page, 'refresh').isDisabled(), true);
    assert.equal((await lab.native('consent.get')).data?.revision, 1, 'helper already exited with the SQLite commit durable');
    await control(page, 'close').click(); await open(page);
    assert.equal(await control(page, 'global-skip').isChecked(), true);
    await pair(page, 'codex'); hold.release('drop');
    assert.equal(await control(page, 'pair-a').inputValue(), 'a', 'lost old ACK cannot clear the current editor');
    assert.equal(lab.posts().length, 1);
    await page.reload(); await page.waitForFunction('meshContext !== null && !meshStopped', undefined, {timeout: READY_TIMEOUT_MS});
    await open(page); assert.equal(await control(page, 'global-skip').isChecked(), true); assert.equal(lab.posts().length, 1);
    const second = lab.holdWrite();
    await control(page, 'global-ask').check(); await control(page, 'save-global').click();
    assert.equal((await second.committed()).data?.revision, 2);
    await page.close(); second.release('drop');
    page = await lab.page(context); await open(page);
    assert.equal(await control(page, 'global-ask').isChecked(), true);
    assert.equal((await lab.native('consent.get')).data?.revision, 2); assert.equal(lab.posts().length, 2);
  });
});

test('running app: pre-start and post-dispose account clicks issue no requests; real disposal aborts a pending load', {skip, timeout: 60_000}, async () => {
  await withFixture(async lab => {
    const context = await lab.context();
    const requests: string[] = [];
    context.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/accounts/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    // This case alone withholds automatic startup. app.js, pane-actions.js and all other
    // assets still come from the actual server; no globals or lifecycle guards are forged.
    let entries = 0;
    await context.route(`${lab.mesh.base}/static/local-entry.js*`, async route => {
      entries++;
      await route.fulfill({contentType: 'text/javascript', headers: {'cache-control': 'no-store'}, body: '// Automatic entry held by the lifecycle qualification.\n'});
    });
    const page = await lab.page(context, 'en', false);
    assert.ok(entries > 0, 'the entry route, not app.js, withheld startup');
    assert.equal(await page.locator('#btn-accounts').getAttribute('hidden'), '');
    assert.equal(await page.locator('[data-mobile-action="btn-accounts"]').getAttribute('hidden'), '');
    await page.locator('#btn-accounts').dispatchEvent('click');
    await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 2000, 'pre-start click effects');
    assert.deepEqual(requests, []); assert.equal(lab.calls.length, 0); assert.equal(lab.posts().length, 0);
    assert.equal(lab.configRequests.length, 0, 'no config request before start');
    assert.equal(await dialog(page).count(), 0);
    await bounded(page.evaluate(async () => { window.backendAccountsTestRuntime = await MeshUI.startLocalMesh(); }), READY_TIMEOUT_MS, 'actual Mesh runtime startup');
    await page.locator('dialog.backend-account-panel').waitFor({state: 'attached'});
    const pending = lab.holdProfiles();
    const discovery = page.waitForRequest(r => new URL(r.url()).pathname === '/api/config');
    await page.locator('#btn-accounts').click(); await status(page, 'en', 'loading');
    await discovery;
    assert.equal((await pending.received()).ok, true);
    assert.deepEqual(requests, ['GET /api/accounts/profiles']);
    const aborted = page.waitForEvent('requestfailed', {predicate: request => new URL(request.url()).pathname === '/api/accounts/profiles', timeout: 8000});
    await page.evaluate(() => {
      if (!window.backendAccountsTestRuntime) throw new Error('actual Mesh runtime was not returned');
      window.backendAccountsTestRuntime.dispose();
    });
    assert.equal(await dialog(page).count(), 0, 'runtime disposal removed the real panel');
    assert.match((await aborted).failure()?.errorText ?? '', /ERR_ABORTED/, 'the real disposal aborted the fetch before the fixture dropped its late answer');
    pending.release('drop'); await pending.finished();
    const count = requests.length;
    const configCount = lab.configRequests.length;
    assert.equal(await page.locator('#btn-accounts').getAttribute('hidden'), '');
    assert.equal(await page.locator('[data-mobile-action="btn-accounts"]').getAttribute('hidden'), '');
    await page.locator('#btn-accounts').dispatchEvent('click');
    await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 2000, 'post-dispose click effects');
    assert.equal(requests.length, count); assert.equal(lab.calls.length, 1); assert.equal(lab.posts().length, 0);
    assert.equal(lab.configRequests.length, configCount, 'no config request after dispose');
    assert.equal(await dialog(page).count(), 0, 'neither the late answer nor the click recreated the disposed panel');
  });
});

test('running app: absent/false/nonboolean or refused config capability hides both entries without account probes', {skip, timeout: 120_000}, async () => {
  await withFixture(async lab => {
    for (const config of [{}, {flag: false}, {flag: 'true'}, {flag: true, status: 401}, {flag: true, status: 403}, {flag: true, status: 503}]) {
      const context = await lab.context('fr', 900, config);
      const response = context.waitForEvent('response', {predicate: r => new URL(r.url()).pathname === '/api/config'});
      const page = await lab.page(context, 'fr', true, false);
      const configResponse = await response;
      assert.equal(configResponse.status(), config.status ?? 200, 'this context received its configured response');
      await configResponse.finished();
      await page.locator('#btn-accounts').dispatchEvent('click');
      await page.locator('[data-mobile-action="btn-accounts"]').dispatchEvent('click');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#btn-accounts').getAttribute('hidden'), '');
      assert.equal(await page.locator('[data-mobile-action="btn-accounts"]').getAttribute('hidden'), '');
      assert.equal(await dialog(page).count(), 0); assert.deepEqual(lab.calls, []);
      await context.close();
    }
    // Each context awaited its own config response; other app features may also read it.
  });
});

test('running app: disposal aborts capability read and fences a late private config reply', {skip, timeout: 60_000}, async () => {
  await withFixture(async lab => {
    const hold = deferred<void>(), context = await lab.context('en', 1440, {flag: true, hold});
    await context.route(`${lab.mesh.base}/static/local-entry.js*`, route => route.fulfill({contentType: 'text/javascript', body: '// Startup held.\n'}));
    const page = await lab.page(context, 'en', false);
    assert.equal(lab.configRequests.length, 0);
    const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/config');
    await page.evaluate(async () => { window.backendAccountsTestRuntime = await MeshUI.startLocalMesh(); }); await requested;
    assert.equal(await page.locator('#btn-accounts').getAttribute('hidden'), '');
    assert.equal(await dialog(page).count(), 0);
    const aborted = page.waitForEvent('requestfailed', {predicate: r => new URL(r.url()).pathname === '/api/config'});
    await page.evaluate(() => window.backendAccountsTestRuntime!.dispose());
    assert.match((await aborted).failure()?.errorText ?? '', /ERR_ABORTED/);
    hold.resolve();
    await page.locator('#btn-accounts').dispatchEvent('click');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#btn-accounts').getAttribute('hidden'), '');
    assert.equal(await page.locator('[data-mobile-action="btn-accounts"]').getAttribute('hidden'), '');
    assert.equal(await dialog(page).count(), 0); assert.equal(lab.configRequests.length, 1); assert.deepEqual(lab.calls, []);
    assert.ok(!(await page.locator('body').textContent())!.includes(lab.mesh.confDir));
  });
});

test('running app: coded helper-unavailable after real SQLite commit remains uncertain and requires explicit review', {skip, timeout: 60_000}, async t => {
  await withFixture(async lab => {
    const context = await lab.context(), page = await lab.page(context); await open(page);
    lab.fault('consent.set_global', 'helper-unavailable');
    await control(page, 'global-skip').check(); await control(page, 'save-global').click(); await status(page, 'en', 'error');
    const persisted = (await lab.native('consent.get')).data!;
    const displayed = await dialog(page).getByRole('status').textContent();
    assert.equal(persisted.global, 'skip'); assert.equal(persisted.revision, 1);
    assert.equal(lab.posts()[0]!.reply?.ok, true, 'native success receipt precedes the simulated missing-ACK 503');
    assert.equal(await control(page, 'save-global').isDisabled(), true); assert.equal(lab.posts().length, 1);
    await control(page, 'refresh').click(); await status(page, 'en', 'ready');
    assert.equal(await control(page, 'global-skip').isChecked(), true); assert.equal(lab.posts().length, 1);
    t.diagnostic(JSON.stringify({native_write: lab.posts()[0]!.reply, persisted, displayed, mutation_count: lab.posts().length}));
  });
});

test('running app: French toolbar controls remain inside the bar at 390/900/1100/1300/1440px', {skip, timeout: 90_000}, async () => {
  await withFixture(async lab => {
    for (const width of [390, 900, 1100, 1300, 1440]) {
      const context = await lab.context('fr', width), page = await lab.page(context, 'fr');
      const clipped = await page.locator('.bar').evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        return Array.from(bar.querySelectorAll('button')).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .filter(el => { const b = el.getBoundingClientRect(); return b.left < bounds.left || b.right > bounds.right || b.top < bounds.top || b.bottom > bounds.bottom
            || b.right > innerWidth || el.scrollWidth > el.clientWidth; }).map(el => el.id);
      });
      assert.deepEqual(clipped, [], `French toolbar at ${width}px`);
      await open(page, 'fr', width); await fits(page); await control(page, 'close').click();
      assert.equal(lab.posts().length, 0); await context.close();
    }
  });
});

test('accounts fixture cleanup: failures/timeouts still attempt halt, retain the original error and require shutdown before removal', {timeout: 20_000}, async () => {
  const original = new Error('original test assertion'), contextError = new Error('context close rejected'), routeError = new Error('route close rejected');
  const order: string[] = [];
  await assert.rejects(preserveFailure(async () => { throw original; }, () => cleanupAccountsFixture({
    contexts: async () => { order.push('contexts'); throw contextError; },
    routes: async () => { order.push('routes'); throw routeError; },
    helpers: async () => { order.push('helpers'); },
    halt: async () => { order.push('halt'); },
    remove: () => { order.push('remove'); }, verify: () => { order.push('verify'); },
  })), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
    assert.ok(error.errors[1] instanceof AggregateError); assert.deepEqual(error.errors[1].errors, [contextError, routeError]); return true;
  });
  assert.deepEqual(order, ['contexts', 'routes', 'helpers', 'halt', 'remove', 'verify']);
  order.length = 0;
  const shutdownError = new Error('shutdown not confirmed');
  await assert.rejects(cleanupAccountsFixture({
    contexts: () => { order.push('contexts'); return new Promise(() => undefined); },
    routes: async () => { order.push('routes'); }, helpers: async () => { order.push('helpers'); },
    halt: async () => { order.push('halt'); throw shutdownError; },
    remove: () => { order.push('remove'); }, verify: () => { order.push('verify'); },
  }), error => {
    assert.ok(error instanceof AggregateError); assert.match(String(error.errors[0]), /browser context cleanup exceeded 10000ms/);
    assert.equal(error.errors[1], shutdownError); return true;
  });
  assert.deepEqual(order, ['contexts', 'routes', 'helpers', 'halt', 'verify'], 'unconfirmed shutdown preserves the scratch directory');
});
