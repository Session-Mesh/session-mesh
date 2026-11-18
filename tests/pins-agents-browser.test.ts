// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pinning a conversation: every agent the History index reads (claude, codex, pi, opencode, gemini, agy,
// copilot, vibe) can be pinned once Mesh knows a well-formed conversation id, and a closed pin opens that
// conversation's History card (h:<agent>:<id>), from which it is resumed. An id that could not be a
// conversation id, or a session without one, is refused. Run in headless Chromium against a throwaway server
// and PTY host; /api/sessions is answered by the real server with its session list replaced by the test's.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
// app.js script-scope names, used inside page functions (the page's policy refuses string eval).
declare function refresh(): Promise<void>;
declare function renderList(force?: boolean): void;
declare const data: {mesh: unknown[]};
declare function togglePin(agent: string, id: string, label: string): void;
declare function pinnedSessions(): {agent: string; id: string; label: string; guessed?: true}[];
declare function histCardHtml(d: Record<string, unknown>, live: unknown): string;
declare function menuEntries(id: string): {label: string}[];
declare const restoringWorkspace: boolean;

const UUID = '5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22';
const OPENCODE_ID = 'ses_2f8a9c1d4e7bAbCdEfGh';
const CODEX_ID = '01a162e0-89bf-75d2-93db-abc74e04973f';
const IDS: Record<string, string> = {claude: UUID, codex: CODEX_ID, pi: UUID, opencode: OPENCODE_ID, gemini: UUID, agy: UUID, copilot: UUID, vibe: UUID};
const CWD = '/tmp/pin project';

type Spec = {id: string; type: string; session_id: string | null; identity_source?: string; cwd?: string};

let lab: AgentMesh;
let browser: Browser;
const contexts: BrowserContext[] = [];
let sessions: Spec[] = [];

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  lab = await AgentMesh.start('pins-', []);
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  for (const context of contexts) {
    // A route handler still fetching when the page closes would reject with "Target page ... has been closed".
    await Promise.all(context.pages().map(page => page.unrouteAll({behavior: 'ignoreErrors'}).catch(() => undefined)));
    await context.close().catch(() => undefined);
  }
  await browser?.close();
  await lab?.stop();
});

async function board(specs: Spec[], locale = 'en'): Promise<{page: Page; errors: string[]}> {
  sessions = specs;
  const context = await browser.newContext({locale, viewport: {width: 1400, height: 900}});
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/api/sessions*', async route => {
    const real = await route.fetch();
    const body = await real.json() as {mesh: unknown[]};
    body.mesh = sessions.map(spec => ({
      id: spec.id, kind: 'mesh', name: spec.id, cwd: spec.cwd ?? CWD, cmd: spec.type, created: 1, state: 'idle',
      agent: {type: spec.type, session_id: spec.session_id, status: 'idle',
        ...(spec.identity_source ? {identity_source: spec.identity_source} : {})},
    }));
    await route.fulfill({response: real, json: body});
  });
  await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
  await page.goto('about:blank');
  await page.goto(`${lab.mesh.base}/`);
  await page.waitForFunction(() => !restoringWorkspace, undefined, {timeout: READY_TIMEOUT_MS});
  if (specs.length) await page.locator(`#list .item[data-id="${specs[0]!.id}"]`).waitFor({timeout: READY_TIMEOUT_MS});
  return {page, errors};
}

// The conversation is closed: the server lists nothing live that carries it.
async function closeAll(page: Page): Promise<void> {
  sessions = [];
  await page.evaluate(() => refresh());
  await page.waitForFunction(() => data.mesh.length === 0, undefined, {timeout: READY_TIMEOUT_MS});
  await page.evaluate(() => renderList(true));   // an explicit redraw: a focused item defers the passive one
}

async function menuLabels(page: Page, id: string): Promise<string[]> {
  return page.evaluate(sessionId => menuEntries(sessionId).map(entry => entry.label), id);
}

describe('pins of every History agent', {skip}, () => {
  for (const [type, id] of Object.entries(IDS)) {
    test(`a ${type} session with a conversation id is pinnable, and a closed pin opens its History card`, async () => {
      const {page, errors} = await board([{id: 's', type, session_id: id, identity_source: 'history_cwd'}]);
      await page.locator('#list .item[data-id="s"]').click({button: 'right'});
      await page.getByRole('menuitem', {name: 'Pin on this device', exact: true}).click();
      assert.deepEqual(await page.evaluate(() => pinnedSessions()), [{agent: type, id, label: 's', guessed: true}],
        'a pin from an id guessed out of the folder history is marked as guessed');
      assert.equal(await page.locator('.pinned-sessions .item').getAttribute('data-id'), 's', 'running: opens the terminal');
      await closeAll(page);
      const row = page.locator('.pinned-sessions .item');
      assert.equal(await row.getAttribute('data-id'), `h:${type}:${id}`);
      assert.equal((await row.locator('.meta').innerText()).trim(), 'Guessed from the folder · check the card');
      const card = await page.evaluate(([agent, sid]) => histCardHtml({agent, id: sid, cwd: '/tmp/pin project', title: 't', tin: 0, tcr: 0, tcw: 0}, null),
        [type, id]);
      assert.match(card, /derived from the newest conversation in the folder/, 'the card says the pin was guessed');
      assert.match(card, /data-hact="resume"/, 'resuming stays an explicit click on the card');
      await page.reload();
      await page.waitForFunction(() => !restoringWorkspace);
      assert.equal(await page.locator('.pinned-sessions .name').innerText(), 's', 'survives a reload');
      await page.getByRole('button', {name: 'Unpin s'}).click();
      assert.equal(await page.evaluate(() => pinnedSessions().length), 0);
      assert.deepEqual(errors, []);
    });
  }

  test('a pin from an id the agent reported or was launched with is not marked as guessed', async () => {
    const {page} = await board([{id: 's', type: 'claude', session_id: UUID, identity_source: 'claude_hook'}]);
    await page.locator('#list .item[data-id="s"]').click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Pin on this device', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => pinnedSessions()), [{agent: 'claude', id: UUID, label: 's'}]);
    await closeAll(page);
    assert.equal((await page.locator('.pinned-sessions .item .meta').innerText()).trim(), 'Open the card · availability to be checked');
  });

  test('a session without a conversation id, or with one that could not be an id, is refused', async () => {
    const {page} = await board([
      {id: 'gem-none', type: 'gemini', session_id: null},
      {id: 'cop-bad', type: 'copilot', session_id: '--yolo-not-an-id', identity_source: 'copilot_hooks'},
      {id: 'oc-short', type: 'opencode', session_id: 'ses_1', identity_source: 'opencode_hook'},
      {id: 'vibe-space', type: 'vibe', session_id: 'a b c d e f g h', identity_source: 'argv_resume'},
    ]);
    for (const id of ['gem-none', 'cop-bad', 'oc-short', 'vibe-space']) {
      assert.ok(!(await menuLabels(page, id)).includes('Pin on this device'), `${id} must not offer a pin`);
    }
    await page.evaluate(() => togglePin('copilot', '--yolo', 'x'));   // the guard, not only the menu
    await page.evaluate(() => togglePin('shell', 'aaaaaaaa-bbbb', 'x'));
    assert.equal(await page.evaluate(() => pinnedSessions().length), 0);
  });

  test('stored pins of the earlier format still open, an unknown agent or a bad id is ignored', async () => {
    const {page} = await board([]);
    await page.evaluate(({uuid, oc}) => localStorage.setItem('mesh.pinnedSessions', JSON.stringify([
      {agent: 'copilot', id: uuid, label: 'old copilot', cwd: '/tmp'}, {agent: 'opencode', id: oc, label: 'old opencode', cwd: '/tmp'},
      {agent: 'unknown', id: uuid, label: 'u'}, {agent: 'gemini', id: '--x', label: 'bad'}])), {uuid: UUID, oc: OPENCODE_ID});
    assert.deepEqual((await page.evaluate(() => pinnedSessions())).map(p => p.label), ['old copilot', 'old opencode']);
  });

  test('the French interface says it in French', async () => {
    const {page} = await board([{id: 'gem', type: 'gemini', session_id: UUID, identity_source: 'gemini_hook'}], 'fr');
    await page.locator('#list .item[data-id="gem"]').click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Épingler sur cet appareil'}).click();
    await closeAll(page);
    assert.equal((await page.locator('.pinned-sessions .meta').innerText()).trim(), 'Ouvrir la fiche · disponibilité à vérifier');
  });
});
