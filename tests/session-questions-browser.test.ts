// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session marker (static/work-session-marker.ts wired by app.js) in headless Chromium against a throwaway server.py,
// native PTY host, real work-read and work-write, on a fictional tracker:
//   - a session row shows "? n" when the session has open questions (asked by it, about a task it is linked to, or
//     about the project of such a task); a session without any shows nothing;
//   - the session header has a "? n" button, named with its count, that opens the Projects view on the task sheet or
//     on the Questions tab of the project; it works from the keyboard and at phone width, where it is 44 px tall;
//   - an answer given there clears the marker once the Projects view is left;
//   - an idle page reads the tracker at most once a minute;
//   - a missing reader program shows no marker, no error, and is not asked again.
// Needs MESH_CHROMIUM, MESH_PTYHOST_CMD, MESH_PYTHON and built work-read and work-write (MESH_WORK_READ_CMD and
// MESH_WORK_WRITE_CMD, default the dune build outputs); skipped without them (MESH_REQUIRE_BROWSER=1 and
// MESH_REQUIRE_WORK_READ=1 make that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { REPO, TerminalMesh, skip as noBrowser } from './terminal-browser-lib.ts';

const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = noBrowser || (!process.env.MESH_PTYHOST_CMD && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_PTYHOST_CMD is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ && !process.env.CI
    ? 'built work-read and work-write are required' : false);
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const PROJECT = 'P-5e6f', OTHER_PROJECT = 'P-7a7a', TASK = 'T-7b7b';
const question = (ts: string, about: string, id: string, session: string): object =>
  ({ ts, task: about, type: 'question', id, text: `Fictional question ${id}?`, agent: 'claude', session });
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: OTHER_PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'created', title: 'Marker task', project: 'relay', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:02:00Z', task: TASK, type: 'set', field: 'project', to: OTHER_PROJECT },
  { ts: '2026-11-07T09:03:00Z', task: TASK, type: 'session_linked', agent: 'shell', session: 'qa-linked', host: 'testhost', repo: null, branch: null },
  // qa-linked: one question about its task, asked elsewhere; qa-asker: two of its own in one project; qa-none: nothing.
  question('2026-11-08T09:00:00Z', TASK, 'N-0000d001', 'far-away'),
  question('2026-11-08T09:01:00Z', PROJECT, 'N-0000d002', 'qa-asker'),
  question('2026-11-08T09:02:00Z', 'T-1a2b', 'N-0000d003', 'qa-asker'),
];

function tracker(scratch: string): string {
  const directory = path.join(scratch, 'tracker');
  fs.cpSync(FIXTURE, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'events', '2026-11.hostq.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', directory, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return directory;
}

let scratch = '';
let mesh: TerminalMesh;
let missing: TerminalMesh;
const errors: string[] = [];
const ops: string[] = [];

/** A page that records its errors and the ops it sends to /api/work/v1. */
const watch = (into: string[]) => (page: Page): void => {
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (request.url().endsWith('/api/work/v1')) into.push(String(JSON.parse(request.postData() ?? '{}').op));
  });
};

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rsq-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  for (const name of ['qa-linked', 'qa-asker', 'qa-none']) await mesh.newShell(name);
  missing = new TerminalMesh({ WL_HOME: path.join(scratch, 'tracker'), MESH_WORK_READ_CMD: path.join(scratch, 'no-such-work-read') });
  await missing.start();
  await missing.newShell('qa-linked');
});
after(async () => {
  await mesh?.stop();
  await missing?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

const row = (page: Page, name: string) => page.locator(`#list .item[data-id="${name}"]`);
const rowBadge = (page: Page, name: string) => row(page, name).locator('.question-badge');
// app.js script-scope bindings, read inside page functions.
declare const active: { id: string } | null;
declare const sessionMarker: unknown;const headerButton = (page: Page) => page.locator('.pane.active [data-act="questions"]');

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

async function noOverflow(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0,
    'nothing overflows horizontally');
}

/** Show the session in the active pane and wait for its header. */
async function openSession(page: Page, name: string, phone = false): Promise<void> {
  if (phone && !(await row(page, name).isVisible())) await page.locator('#btn-menu').click();
  await row(page, name).click();
  await page.waitForFunction(id => active?.id === id, name);
}

describe('the session marker', { skip }, () => {
  test('the Sessions button reads the tracker only when it closes the Projects view', { timeout: 600_000 }, async () => {
    const sent: string[] = [];
    const page = await mesh.signIn({ width: 1440, height: 900 }, undefined, watch(sent));
    await rowBadge(page, 'qa-asker').waitFor({ timeout: 60_000 });
    const reads = (): number => sent.filter(op => op === 'session-questions').length;

    const first = reads();
    for (let click = 0; click < 8; click++) { await page.locator('#btn-sessions').click(); await page.waitForTimeout(500); }
    assert.equal(reads(), first, 'eight clicks on Sessions while it is the view in use: no read');

    await page.locator('#btn-projects').click();
    await page.locator('#work-root .work-detail-pane, #work-root .work-entry, #work-root [data-question-id]').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await page.locator('#btn-projects .projects-question-badge').textContent(), '3');

    await page.locator('#btn-sessions').click();
    await page.waitForTimeout(8_000);
    assert.equal(reads(), first + 1, 'leaving Projects reads once');
    assert.equal(await page.locator('#btn-projects .projects-question-badge').textContent(), '3', 'the marker count shows again');
    await page.context().close();
  });

  test('rows and headers at 1440 px: counts, names, where the button leads, keyboard, answer, idle reads', { timeout: 600_000 }, async () => {
    const sent: string[] = [];
    const page = await mesh.signIn({ width: 1440, height: 900 }, undefined, watch(sent));
    await rowBadge(page, 'qa-linked').waitFor({ timeout: 60_000 });
    assert.equal(await rowBadge(page, 'qa-linked').textContent(), '? 1');
    assert.equal(await rowBadge(page, 'qa-linked').getAttribute('aria-label'), '1 open question for this session');
    assert.equal(await rowBadge(page, 'qa-asker').textContent(), '? 2');
    assert.equal(await rowBadge(page, 'qa-asker').getAttribute('aria-label'), '2 open questions for this session');
    assert.equal(await rowBadge(page, 'qa-none').count(), 0, 'a session without questions shows nothing');
    assert.equal(await page.locator('#btn-projects .projects-question-badge').textContent(), '3', 'the Projects button counts them all');

    // Idle: the listing comes every few seconds, the tracker is read at most once a minute.
    const before = sent.length;
    await page.waitForTimeout(25_000);
    assert.deepEqual(sent.slice(before), [], 'no read of the tracker while idle within the minute');

    await openSession(page, 'qa-none');
    assert.equal(await headerButton(page).isHidden(), true, 'no button for a session without questions');
    await openSession(page, 'qa-asker');
    await headerButton(page).waitFor();
    assert.match(await headerButton(page).innerText(), /^\?\s*2$/);
    assert.equal(await headerButton(page).getAttribute('aria-label'), '2 open questions for this session: open them in Projects');
    await shot(page, 'session-marker-1440');
    await headerButton(page).click();
    await page.locator('#work-tab-questions[aria-selected="true"]').waitFor();
    assert.match(await page.locator('.work-project-head').innerText(), /Delivery rollout/, 'the project of its questions');
    assert.equal(await page.locator('#work-panel-questions [data-question-id="N-0000d002"]').count(), 1);

    // Back to the sessions; the other session's button, from the keyboard, opens its task sheet with the answer form.
    await page.locator('#btn-sessions').click();
    await openSession(page, 'qa-linked');
    await headerButton(page).focus();
    await page.keyboard.press('Enter');
    const sheet = page.locator('.work-detail-pane');
    await sheet.locator('.work-detail-heading', { hasText: 'Marker task' }).waitFor();
    const card = sheet.locator('[data-question-id="N-0000d001"]');
    await card.getByLabel('Your answer').fill('fictional answer');
    await card.getByRole('button', { name: 'Send answer' }).click();
    await card.locator('.work-answer-verified').waitFor({ timeout: 60_000 });

    // Leaving Projects reads the markers again: the question is answered, the marker goes.
    await page.locator('#btn-sessions').click();
    await rowBadge(page, 'qa-linked').waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await headerButton(page).isHidden(), true);
    assert.equal(await rowBadge(page, 'qa-asker').textContent(), '? 2', 'the other session keeps its marker');
    await page.context().close();
  });

  test('at 390 px the row badge and the header button fit, the button is 44 px tall and opens the questions', { timeout: 600_000 }, async () => {
    const page = await mesh.signIn({ width: 390, height: 844 }, undefined, watch([]), { phone: true });
    await page.locator('#btn-menu').click();
    await rowBadge(page, 'qa-asker').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(400);   // the drawer slides in
    await noOverflow(page);
    await shot(page, 'session-marker-list-390');
    await openSession(page, 'qa-asker', true);
    await headerButton(page).waitFor();
    await page.waitForFunction(() => !document.body.classList.contains('drawer'));
    await page.waitForTimeout(400);   // the drawer slides out
    const box = await headerButton(page).boundingBox();
    assert.ok(box && box.height >= 44 && box.width >= 44, `a 44 px target, got ${JSON.stringify(box)}`);
    assert.ok(box.x + box.width <= 390, 'inside the screen');
    await noOverflow(page);
    await shot(page, 'session-marker-header-390');
    await headerButton(page).click();
    await page.locator('#work-tab-questions[aria-selected="true"]').waitFor();
    await noOverflow(page);
    await page.context().close();
  });

  test('without a reader program: no marker, no error, and no second request', { timeout: 600_000 }, async () => {
    const sent: string[] = [];
    const page = await missing.signIn({ width: 1440, height: 900 }, undefined, watch(sent));
    await page.waitForFunction(() => document.querySelector('#list .item[data-id="qa-linked"]') !== null);
    await page.waitForFunction(() => sessionMarker !== null, undefined, { timeout: 60_000 });
    await page.waitForTimeout(10_000);
    // The terminal references read their ids once too (static/work-references.ts), refused the same way.
    assert.deepEqual(sent.filter(op => op !== 'ids'), ['session-questions'], 'one request, refused, then none');
    assert.ok(sent.filter(op => op === 'ids').length <= 1, 'the ids are not asked again');
    assert.equal(await page.locator('#list .question-badge').count(), 0);
    await openSession(page, 'qa-linked');
    assert.equal(await headerButton(page).isHidden(), true);
    assert.equal(await page.locator('#btn-projects .projects-question-badge').isHidden(), true);
    await page.context().close();
  });
});
