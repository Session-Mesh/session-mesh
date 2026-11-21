// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "What's new" in the update banner, end to end: the native PTY host runs the release check against a
// stand-in curl whose releases list carries the notes (no request leaves the machine), keeps the notes of the
// announced release, and answers `update_notes`; the server relays them (GET /api/update/notes) and proxies
// their images from a local stand-in for GitHub (MESH_UPDATE_IMAGE_TEST_HOSTS); the page renders them as
// Markdown in a dialog. Checked: the rich rendering (table, code, an image through the proxy) at desktop and
// phone width, hostile notes rendered inert, keyboard use, French, and check=0 removing the button.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the absence a
// failure). MESH_PTYHOST_CMD must name a host that knows `update_notes` (this tree's build).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {startFakeGithub, type FakeGithub} from './helpers/fake-github.ts';
import {startUpdateHost, NOTES, type UpdateHost} from './helpers/update-host.ts';
import {REPO, startMesh, type Mesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
// `mesh-platform update-image` fetches the images: this tree's build, or MESH_MESH_PLATFORM_CMD. Without it every
// image of the notes must become a link, which is then what is checked (MESH_REQUIRE_UPDATE_IMAGE=1: a failure).
const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD || path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const imaging = fs.existsSync(PLATFORM) || Boolean(process.env.MESH_REQUIRE_UPDATE_IMAGE);
const GH = 'https://github.com/user-attachments/assets';

const BODY = [
  '## Highlights', '',
  'Sessions now **survive** a restart. See [the pull request](https://github.com/Session-Mesh/session-mesh/pull/12).', '',
  '| Platform | State |', '|---|---|', '| Linux | supported |', '| macOS | best effort |', '',
  '```sh', 'mesh doctor --json', '```', '',
  `![A diagram of the relay](${GH}/ok)`, '',
  // hostile content: none of it may run, load from elsewhere, or reach the page's own elements
  ...[
    '<script>window.__pwned = "script"</script>',
    `<img src="${GH}/svg" alt="vector" onerror="window.__pwned = 'onerror'">`,
    '[a trap](javascript:window.__pwned=%22link%22)',
    `![a huge picture](${GH}/huge)`,
    '![a tracker](https://evil.example/pixel.png)',
    '<iframe src="/"></iframe><form action="/api/logout"><button>go</button></form>',
    '<div id="update-notice" class="update-notice" style="position:fixed;inset:0">clobber</div>',
    '<a href="https://example.com/x" onclick="window.__pwned = \'click\'">an external page</a>',
  ].flatMap(line => [line, '']),
  '## Every change', '',
  ...Array.from({length: 80}, (_, index) => `- change number ${index + 1}`),
].join('\n');

let mesh: Mesh;
let host: UpdateHost;
let github: FakeGithub;
let browser: Browser;
let scratch = '';

function answeringCurl(): string {
  const releases = path.join(scratch, 'releases.json');
  fs.writeFileSync(releases, JSON.stringify([
    {tag_name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-11-19T10:00:00Z', body: BODY},
    {tag_name: 'v0.1.0', draft: false, prerelease: false, body: ''},
  ]));
  return `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in -D) h=$2; shift ;; -o) o=$2; shift ;; esac
  shift
done
printf 'HTTP/2 200\\r\\netag: "t1"\\r\\n\\r\\n' > "$h"
cat '${releases}' > "$o"
printf 200
`;
}

const listing = async (): Promise<{update: Record<string, unknown> | null}> =>
  await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base}})).json() as
    {update: Record<string, unknown> | null};

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-notes-'));
  github = await startFakeGithub();
  mesh = await startMesh('upd-notes-b-', {MESH_MESH_PLATFORM_CMD: PLATFORM, MESH_UPDATE_IMAGE_TEST_HOSTS: `github.com=127.0.0.1:${github.port}`});
  host = startUpdateHost(mesh, {release: true, curl: answeringCurl()});
  for (let attempt = 0; attempt < 200 && (await listing()).update?.notes !== true; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await listing()).update?.notes, true, 'the host announced the release and its notes');
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  await browser?.close();
  await host?.stop();
  await mesh?.stop();
  await github?.stop();
  if (scratch) fs.rmSync(scratch, {recursive: true, force: true});
});

let inertHandlers: string[] = [];

async function signedIn(locale: string, width: number, height = 900): Promise<{page: Page; problems: string[]}> {
  inertHandlers = [];
  const context = await browser.newContext({locale, viewport: {width, height}});
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => {
    if (!/Content Security Policy|violat/i.test(message.text())) return;
    // DOMPurify parses the notes in an inert document that inherits the page's CSP: Chromium reports each inline
    // handler of the notes there (and runs none: window.__pwned is checked); any other violation is a problem
    if (/inline event handler/.test(message.text()) && message.location().url.endsWith('/viewlib/purify.min.js')) inertHandlers.push(message.text());
    else problems.push(message.text());
  });
  page.on('request', request => {
    const url = request.url();
    if (/^(https?|wss?):/.test(url) && !url.startsWith(mesh.base) && !url.startsWith(mesh.base.replace('http', 'ws'))) problems.push(`request to ${url}`);
  });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.locator('#update-notice').waitFor({state: 'visible', timeout: READY_TIMEOUT_MS});
  return {page, problems};
}

const shots = process.env.UPDATE_NOTES_SHOTS;   // a directory: screenshots for a human look (optional)

describe('update notes panel', {skip}, () => {
  test('rich notes at desktop width, hostile parts inert, Escape gives the focus back', async () => {
    const {page, problems} = await signedIn('en-US', 1440);
    const banner = page.locator('#update-notice');
    assert.equal(await banner.locator('a').getAttribute('href'), NOTES, 'the GitHub link stays');
    const open = page.getByRole('button', {name: "What's new"});
    await open.click();
    const dialog = page.getByRole('dialog', {name: "What's new in Session Mesh v0.2.0"});
    await dialog.waitFor({state: 'visible'});
    const body = dialog.locator('.update-notes-markdown');
    await body.waitFor();
    assert.equal(await dialog.locator('time').getAttribute('datetime'), '2026-11-19T10:00:00Z');
    assert.match(await dialog.locator('time').innerText(), /Published November 19, 2026/);
    const github = dialog.getByRole('link', {name: 'Open on GitHub'});
    assert.equal(await github.getAttribute('href'), NOTES);
    assert.equal(await github.getAttribute('rel'), 'noopener noreferrer');
    // the rich parts
    assert.equal(await body.locator('h2').first().innerText(), 'Highlights');
    assert.equal(await body.locator('table td').nth(3).innerText(), 'best effort');
    assert.equal((await body.locator('pre code').innerText()).trim(), 'mesh doctor --json');
    if (imaging) {
      const picture = body.getByRole('img', {name: 'A diagram of the relay'});
      assert.match(await picture.getAttribute('src') ?? '', /^\/api\/update\/image\?url=https%3A%2F%2Fgithub\.com%2F/);
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('.update-notes-markdown img[alt="A diagram of the relay"]');
        return image?.complete && image.naturalWidth === 1;
      });
    }
    const pull = body.getByRole('link', {name: 'the pull request'});
    assert.equal(await pull.getAttribute('target'), '_blank');
    assert.equal(await pull.getAttribute('rel'), 'noopener noreferrer');
    // the hostile parts: nothing ran, nothing was asked of another origin, nothing reached the interface
    // (the images load lazily: bring each one into view until every one has loaded or been replaced by its link;
    // a refused image leaves the list as soon as its error arrives, so the list is read again at every step)
    await page.waitForFunction(() => {
      const waiting = [...document.querySelectorAll<HTMLImageElement>('.update-notes-markdown img')].find(image => !image.complete);
      waiting?.scrollIntoView({block: 'center'});
      return !waiting;
    });
    const fallbacks = [...(imaging ? [] : ['A diagram of the relay']), 'vector', 'a huge picture', 'a tracker'];
    await page.waitForFunction(count => document.querySelectorAll('.update-notes-markdown .update-notes-image').length === count,
      fallbacks.length);
    assert.equal(await page.evaluate(() => (window as unknown as {__pwned?: string}).__pwned), undefined);
    assert.ok(inertHandlers.length <= 2, 'at most the two handlers of the notes were seen, blocked');
    assert.equal(await body.locator('script, iframe, form, button, svg, [style], [id], [onerror], [onclick]').count(), 0);
    assert.match(await body.innerText(), /a trap/);
    assert.equal(await body.locator('a[href^="javascript" i]').count(), 0);
    assert.equal(await body.locator('a', {hasText: 'an external page'}).getAttribute('href'), 'https://example.com/x');
    assert.equal(await page.locator('[id="update-notice"]').count(), 1, 'no element of the notes takes an id of the page');
    const standIns = body.locator('.update-notes-image');
    assert.deepEqual(await standIns.allInnerTexts(), fallbacks);
    assert.equal(await standIns.last().getAttribute('href'), 'https://evil.example/pixel.png', 'a link, never loaded');
    if (shots) await page.screenshot({path: path.join(shots, 'notes-1440.png')});
    // long notes scroll inside the dialog
    const scroller = dialog.locator('.update-notes-body');
    assert.ok(await scroller.evaluate(node => node.scrollHeight > node.clientHeight));
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'detached'});
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'update-notice-whatsnew');
    // opened again from the keyboard
    await page.keyboard.press('Enter');
    await dialog.waitFor({state: 'visible'});
    await dialog.getByRole('button', {name: 'Close the release notes'}).click();
    await dialog.waitFor({state: 'detached'});
    assert.deepEqual(problems, []);
  });

  test('the whole screen on a phone, in French, without sideways scroll', async () => {
    const {page, problems} = await signedIn('fr-FR', 390, 844);
    await page.getByRole('button', {name: 'Nouveautés'}).click();
    const dialog = page.getByRole('dialog', {name: 'Nouveautés de Session Mesh v0.2.0'});
    await dialog.locator('.update-notes-markdown').waitFor();
    assert.match(await dialog.locator('time').innerText(), /Publiée le 19 novembre 2026/);
    const box = await dialog.boundingBox();
    assert.ok(box && box.width === 390 && box.height === 844, JSON.stringify(box));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), 'the dialog does not scroll sideways');
    assert.ok(await dialog.locator('.update-notes-body').evaluate(node => node.scrollHeight > node.clientHeight));
    if (imaging) await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.update-notes-markdown img')?.naturalWidth ?? 0) > 0);
    if (shots) await page.screenshot({path: path.join(shots, 'notes-390.png')});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'detached'});
    assert.deepEqual(problems, []);
  });

  test('check=0 removes the banner and its button; the notes route answers nothing', async () => {
    await host.stop();
    const settings = path.join(mesh.home, '.config', 'session-mesh', 'update-notice');
    fs.writeFileSync(settings, 'check=0\n', {mode: 0o600});
    host = startUpdateHost(mesh, {release: true, curl: answeringCurl()});
    try {
      for (let attempt = 0; attempt < 200 && !fs.existsSync(host.socket); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal((await listing()).update, null);
      const context = await browser.newContext({locale: 'en-US', viewport: {width: 1280, height: 800}});
      const page = await context.newPage();
      await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
      await page.goto(`${mesh.base}/`);
      await page.waitForFunction(() => document.querySelector('#update-notice')?.hasAttribute('hidden') === true);
      await page.waitForTimeout(2000);
      assert.equal(await page.getByRole('button', {name: "What's new"}).count(), 0);
      assert.equal(await page.evaluate(async () => (await fetch('/api/update/notes')).status), 404);
      await context.close();
    } finally {
      fs.rmSync(settings, {force: true});
    }
  });
});
