// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// An offer of more than 50 lost sessions (the most the restore routes take per request): "Restore" and
// "Ignore" send the names in batches of at most 50, one after the other, and the summary speaks of every
// batch. The offer (53 fictional sessions) and the answers of the restore routes are stubbed in the page;
// the server and the PTY host are real. Needs a Chromium: MESH_CHROMIUM (skipped without it;
// MESH_REQUIRE_BROWSER=1 makes the absence a failure).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page, type Route} from 'playwright-core';
import {Lab} from './restore-exact-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const LIMIT_TEXT = 'names: a list of at most 50 session names';

const offerOf = (count: number) => Array.from({length: count}, (_, index) => {
  const name = `lost-${String(index + 1).padStart(2, '0')}`;
  return {name, cwd: '/tmp', created: 1700000000 + index, agent: null, resumable: false, running: null};
});

let lab: Lab;
let browser: Browser;

before(async () => {
  if (skip) return;
  lab = await Lab.start();
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  await browser?.close();
  await lab?.stop();
});

type Answer = (names: string[], index: number) => Promise<{status: number; body: unknown}>;
type Posts = {restore: string[][]; discard: string[][]};

// The page with an offer of `count` sessions; `answer` replies to each POST of either restore route.
async function offered(count: number, answer: Answer): Promise<{page: Page; posts: Posts}> {
  const posts: Posts = {restore: [], discard: []};
  const context = await browser.newContext({locale: 'en-US', viewport: {width: 1400, height: 900}});
  const page = await context.newPage();
  const reply = (list: string[][]) => async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const names = (route.request().postDataJSON() as {names: string[]}).names;
    list.push(names);
    const {status, body} = await answer(names, list.length - 1);
    return route.fulfill({status, contentType: status === 200 ? 'application/json' : 'text/plain',
      body: typeof body === 'string' ? body : JSON.stringify(body)});
  };
  await page.route('**/api/restore', reply(posts.restore));
  await page.route('**/api/restore/discard', reply(posts.discard));
  await page.route(/\/api\/sessions(\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.restorable = offerOf(count);
    return route.fulfill({response, json: body});
  });
  await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
  await page.goto(`${lab.mesh.base}/`);
  await page.locator('#restore-go').waitFor({timeout: 30000});
  await page.locator('#restore .restore-name').nth(count - 1).waitFor();
  return {page, posts};
}

const restored = (names: string[]) => ({status: 200, body: {results: Object.fromEntries(names.map(name => [name, {ok: true, id: name, resumed: false}]))}});
const names = (from: number, to: number) => offerOf(to).slice(from - 1).map(entry => entry.name);

describe('an offer of more than 50 sessions is restored and ignored in batches', {skip}, () => {
  test('53 sessions: two requests of 50 then 3, in order, one summary for the 53', async () => {
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
    const {page, posts} = await offered(53, async (batch, index) => {
      if (index === 1) await secondHeld;
      return restored(batch);
    });
    assert.equal(await page.locator('#restore-go').innerText(), 'Restore 53 sessions');
    await page.locator('#restore-go').click();
    await waitForPosts(page, posts.restore, 2);
    assert.ok(await page.locator('#restore-go').isDisabled(), 'the button stays disabled until the last batch is answered');
    releaseSecond();
    const flash = page.locator('#flash');
    await flash.waitFor({state: 'visible'});
    assert.equal(await flash.innerText(), '53 sessions restored');
    assert.deepEqual(posts.restore, [names(1, 50), names(51, 53)]);
    await close(page);
  });

  test('a refused second batch still reports the first one, and the names not sent', async () => {
    const {page, posts} = await offered(53, async (batch, index) =>
      index === 0 ? restored(batch) : {status: 400, body: LIMIT_TEXT});
    await page.locator('#restore-go').click();
    const flash = page.locator('#flash');
    await flash.waitFor({state: 'visible'});
    assert.equal(await flash.innerText(), `50 sessions restored 3 sessions not sent: ${LIMIT_TEXT}`);
    assert.equal(posts.restore.length, 2);
    await close(page);
  });

  test('a refused first batch sends nothing more', async () => {
    const {page, posts} = await offered(53, async () => ({status: 400, body: LIMIT_TEXT}));
    await page.locator('#restore-go').click();
    const flash = page.locator('#flash');
    await flash.waitFor({state: 'visible'});
    assert.equal(await flash.innerText(), LIMIT_TEXT, 'nothing answered: the refusal alone, as for a single request');
    assert.deepEqual(posts.restore.map(batch => batch.length), [50]);
    await close(page);
  });

  test('50 sessions or fewer: a single request, as before', async () => {
    const {page, posts} = await offered(50, async batch => restored(batch));
    await page.locator('#restore-go').click();
    await page.locator('#flash').waitFor({state: 'visible'});
    assert.equal(await page.locator('#flash').innerText(), '50 sessions restored');
    assert.deepEqual(posts.restore, [names(1, 50)]);
    await close(page);
  });

  test('Ignore with 53 sessions discards them in two requests of 50 then 3', async () => {
    const {page, posts} = await offered(53, async () => ({status: 200, body: {ok: true}}));
    await page.locator('#restore-ignore').click();
    await waitForPosts(page, posts.discard, 2);
    assert.deepEqual(posts.discard, [names(1, 50), names(51, 53)]);
    assert.equal(posts.restore.length, 0);
    await close(page);
  });
});

async function waitForPosts(page: Page, list: string[][], count: number): Promise<void> {
  for (let tries = 0; list.length < count && tries < 200; tries++) await page.waitForTimeout(50);
  assert.equal(list.length, count, `${count} requests expected, ${list.length} seen`);
}

// A listing request still in flight must not outlive the page and fail the file.
async function close(page: Page): Promise<void> {
  await page.unrouteAll({behavior: 'ignoreErrors'});
  await page.context().close();
}
