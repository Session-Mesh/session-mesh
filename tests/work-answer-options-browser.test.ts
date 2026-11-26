// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pre-built answers, the question kinds and the owner's edit of an answer (static/work-answer-choices.ts,
// work-answer-edit.ts) in headless Chromium against the real server, work-read and work-write on a fictional tracker
// (a copy of the worklog fixture plus questions). Free MESH_PORT, temporary home and MESH_CONF_DIR, WL_HOME in a
// temporary directory: nothing here touches the default port or a real data directory.
// Needs MESH_CHROMIUM, MESH_PYTHON and the built work-read and work-write (or MESH_WORK_READ_CMD, MESH_WORK_WRITE_CMD);
// skipped without them unless MESH_REQUIRE_BROWSER=1 / MESH_REQUIRE_WORK_READ=1. MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const TASK = 'T-8e8e';
const HOSTILE = '<img src=x onerror=window.__pwn=7> "q" & b';

const question = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ ts: '2026-11-08T09:00:00Z', task: TASK, type: 'question', id, text, agent: 'claude', session: 'asking-session', ...extra });
const ownerAnswer = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ ts: '2026-11-08T10:00:00Z', task: TASK, type: 'answer', question: id, text, by: 'owner', via: 'owner-web', ...extra });
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: TASK, type: 'created', title: 'Answer options task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'set', field: 'project', to: 'P-5e6f' },
  question('N-0000d0d1', 'Which transport?', { options: ['REST', 'gRPC', 'GraphQL'] }),
  question('N-0000d0d2', 'Which platforms?', { options: ['Linux', 'macOS', 'Windows'], kind: 'multi' }),
  question('N-0000d0d3', 'Ship on Friday?', { kind: 'yes_no' }),
  question('N-0000d0d4', 'Which one?', { options: [HOSTILE, 'plain'] }),
  question('N-0000d0d5', 'Name of the flag?'),
  question('N-0000d0d6', 'Which port?', { options: ['8443', '9443'], kind: 'single' }),
  question('N-0000d0d7', 'Which targets?', { options: ['Linux', 'macOS', 'Windows'], kind: 'multi' }),
  ownerAnswer('N-0000d0d5', 'first answer'),
  ownerAnswer('N-0000d0d7', 'Linux', { choices: ['Linux'] }),
  // The drafts of the pre-built answers and of a correction (static/work-view-drafts.ts).
  question('N-0000d0d8', 'Which regions?', { options: ['eu', 'us', 'ap'], kind: 'multi' }),
  question('N-0000d0d9', 'Which log level?', { options: ['info', 'debug'], kind: 'single' }),
  question('N-0000d0da', 'Which CI?', { options: ['GitHub', 'GitLab'], kind: 'multi' }),
  question('N-0000d0db', 'Rotate the keys?', { kind: 'yes_no' }),
  ownerAnswer('N-0000d0da', 'GitHub', { choices: ['GitHub'] }),
  // The French labels, on a question of their own: answered by the owner, then corrected once.
  question('N-0000d0e1', 'Which locale first?', { options: ['fr', 'en'], kind: 'single' }),
  ownerAnswer('N-0000d0e1', 'en', { choices: ['en'] }),
  ownerAnswer('N-0000d0e1', 'fr', { ts: '2026-11-08T11:00:00Z', choices: ['fr'] }),
  // One correction open in both the Questions tab and the task sheet, and a question answered meanwhile.
  question('N-0000d0e2', 'Which shell?', { options: ['bash', 'zsh'], kind: 'single' }),
  ownerAnswer('N-0000d0e2', 'bash', { choices: ['bash'] }),
  question('N-0000d0e3', 'Keep the logs?', { kind: 'yes_no' }),
  // About no task or project: the sheet the entry screen opens (static/work-question-sheet.ts), cued as a decision.
  { ts: '2026-11-08T09:00:00Z', task: 'N-0000d0dc', type: 'question', id: 'N-0000d0dc', text: 'Freeze the release branch?',
    kind: 'yes_no', agent: 'claude', session: 'asking-session' },
  { ts: '2026-11-08T09:00:00Z', task: 'N-0000d0dd', type: 'question', id: 'N-0000d0dd', text: 'Which name for the flag?',
    kind: 'text', agent: 'claude', session: 'asking-session' },
];
const KEY = 'mesh.workView';

let browser: Browser;
const contexts: BrowserContext[] = [];
const meshes: Mesh[] = [];
const scratch: string[] = [];
let mesh: Mesh;
let tracker: string;

function temporaryTracker(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-options-tracker-'));
  scratch.push(directory);
  const copy = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'events', '2026-11.hostc.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  // Under git, as a real tracker is: work-write's commit succeeds and the notice is the plain "recorded" one.
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', copy, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return copy;
}

/** Answer events in time order. Host-shard filenames do not order events;
 * the fixture also holds a malformed line on purpose. */
function answersOf(id: string, dir = path.join(tracker, 'events')): Record<string, unknown>[] {
  return fs.readdirSync(dir).sort().flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(event => event !== null && event.type === 'answer' && event.question === id)
    .sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
}

test('answer observations follow event time across host shards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-answer-order-'));
  const id = 'N-0000f001';
  try {
    const first = ownerAnswer(id, 'first answer');
    const corrected = ownerAnswer(id, 'corrected answer', {ts: '2026-11-10T00:00:00Z'});
    fs.writeFileSync(path.join(dir, '2026-11.a.jsonl'), JSON.stringify(corrected) + '\n');
    fs.writeFileSync(path.join(dir, '2026-11.z.jsonl'), JSON.stringify(first) + '\n');
    const answers = answersOf(id, dir);
    assert.deepEqual(answers.map(event => [event.text, event.via]),
      [['first answer', 'owner-web'], ['corrected answer', 'owner-web']]);
    assert.equal(answers.at(-1)?.text, 'corrected answer');
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

before(async () => {
  if (skip) return;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  tracker = temporaryTracker();
  mesh = await startMesh('workopt-', { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90', WL_HOME: tracker });
  meshes.push(mesh);
});
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  for (const each of meshes) await each.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

async function taskSheet(width: number, locale = 'en-US'): Promise<{ page: Page; pane: Locator; problems: string[] }> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
  await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).click();
  await page.locator('.work-tab').nth(1).click();
  await page.locator(`#work-panel-board .work-card[data-task="${TASK}"]`).click();
  const pane = page.locator('.work-detail-pane');
  await pane.locator('.work-detail-heading').waitFor();
  return { page, pane, problems };
}

const item = (pane: Locator, id: string): Locator => pane.locator(`[data-question-id="${id}"]`);

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); }
}

async function noOverflow(page: Page): Promise<void> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(wide, 0, 'nothing overflows horizontally');
}

async function tallEnough(rows: Locator): Promise<void> {
  for (const box of await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) {
    assert.ok(box >= 44, `a choice is at least 44 px high (${box})`);
  }
}

describe('pre-built answers, question kinds and the owner\'s edit', { skip }, () => {
  test('a click on an option fills the answer; Send records it with its choice', { timeout: 900_000 }, async () => {
    const { page, pane, problems } = await taskSheet(1440);
    const single = item(pane, 'N-0000d0d1');
    const group = single.getByRole('group', { name: 'Pick an answer' });
    assert.deepEqual(await group.getByRole('radio').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)), ['REST', 'gRPC', 'GraphQL']);
    await tallEnough(single.locator('.work-answer-choice'));
    await group.getByText('gRPC').click();
    assert.equal(await single.locator('textarea').inputValue(), 'gRPC', 'the choice is shown in the answer box');
    assert.equal(answersOf('N-0000d0d1').length, 0, 'a click alone sends nothing');
    await single.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0d1').locator('.work-answer-verified').waitFor();
    assert.equal(await item(pane, 'N-0000d0d1').locator('.work-answer-text').textContent(), 'gRPC');
    assert.deepEqual(answersOf('N-0000d0d1').map(event => event.choices), [['gRPC']]);
    await page.waitForFunction(() => document.querySelector('.work-announcer')?.textContent === 'Answer recorded.');
    await shot(page, 'options-single-1440');
    assert.deepEqual(problems, []);
  });

  test('at phone width, checkboxes pick several answers, with a free note', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(390);
    const multi = item(pane, 'N-0000d0d2');
    const group = multi.getByRole('group', { name: 'Pick every answer that applies' });
    await noOverflow(page);
    await tallEnough(multi.locator('.work-answer-choice'));
    await group.getByRole('checkbox', { name: 'Linux' }).check();
    await group.getByRole('checkbox', { name: 'Windows' }).check();
    await multi.getByLabel('Other answer or comment (optional)').fill('ARM later');
    await shot(page, 'options-multi-390');
    await multi.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0d2').locator('.work-answer-verified').waitFor();
    assert.equal(await item(pane, 'N-0000d0d2').locator('.work-answer-text').textContent(), 'Linux\nWindows\nARM later');
    assert.deepEqual(answersOf('N-0000d0d2').map(event => event.choices), [['Linux', 'Windows']]);
    await noOverflow(page);
  });

  test('a yes/no question offers two answers and records the choice as yes or no', { timeout: 900_000 }, async () => {
    const { pane } = await taskSheet(1440);
    const yesNo = item(pane, 'N-0000d0d3');
    assert.deepEqual(await yesNo.getByRole('radio').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)), ['yes', 'no']);
    await yesNo.getByText('Yes', { exact: true }).click();
    assert.equal(await yesNo.locator('textarea').inputValue(), 'Yes');
    await yesNo.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0d3').locator('.work-answer-verified').waitFor();
    assert.deepEqual(answersOf('N-0000d0d3').map(event => [event.text, event.choices]), [['Yes', ['yes']]]);
  });

  test('a hostile option is text; the keyboard moves between radios; a changed field drops the choice', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(1440);
    const hostile = item(pane, 'N-0000d0d4');
    assert.equal(await hostile.locator('.work-answer-choice-text').first().textContent(), HOSTILE);
    assert.equal(await pane.locator('img, script').count(), 0);
    await hostile.getByRole('radio').first().check();
    await hostile.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0d4').locator('.work-answer-verified').waitFor();
    assert.deepEqual(answersOf('N-0000d0d4').map(event => event.choices), [[HOSTILE]]);
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);

    const port = item(pane, 'N-0000d0d6');
    await port.getByRole('radio', { name: '8443' }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    assert.equal(await port.getByRole('radio', { name: '9443' }).isChecked(), true, 'the arrow key picks the next answer');
    const field = port.locator('textarea');
    assert.equal(await field.inputValue(), '9443');
    await field.fill('9443, behind the proxy');
    assert.equal(await port.getByRole('radio', { name: '9443' }).isChecked(), false, 'the owner\'s own text is no longer the option');
    await port.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0d6').locator('.work-answer-verified').waitFor();
    assert.deepEqual(answersOf('N-0000d0d6').map(event => [event.text, event.choices]), [['9443, behind the proxy', undefined]]);
  });

  test('at phone width the owner edits an answer: a new answer supersedes it, the earlier one stays folded', { timeout: 900_000 }, async () => {
    const { page, pane, problems } = await taskSheet(390);
    const answered = item(pane, 'N-0000d0d5');
    assert.equal(await answered.locator('form').count(), 0, 'no form until Edit');
    await answered.getByRole('button', { name: 'Edit answer' }).click();
    const field = answered.getByLabel('Your answer');
    assert.equal(await field.inputValue(), 'first answer', 'the form starts from the current answer');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('work-answer-input')), true);
    await answered.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await answered.locator('form').count(), 0, 'Cancel closes the form');
    await answered.getByRole('button', { name: 'Edit answer' }).click();
    await answered.getByLabel('Your answer').fill('corrected answer');
    await noOverflow(page);
    await answered.getByRole('button', { name: 'Send corrected answer' }).click();
    const edited = item(pane, 'N-0000d0d5');
    await edited.locator('.work-answer-edited').waitFor();
    assert.equal(await edited.locator('.work-answer-edited .work-answer-text').textContent(), 'corrected answer');
    assert.match((await edited.locator('.work-answer-edited .work-answer-meta').textContent())!, /edited/);
    const history = edited.locator('details.work-answer-history');
    assert.equal(await history.evaluate((node: HTMLDetailsElement) => node.open), false, 'the earlier answer is folded');
    assert.equal(await history.locator('summary').textContent(), 'Earlier answers (1)');
    await history.locator('summary').click();
    assert.equal(await history.locator('.work-answer-text').textContent(), 'first answer');
    assert.match((await history.locator('.work-answer-meta').textContent())!, /replaced by a correction/);
    // A name saved in the Configuration dialog rewrites the operator labels in place: the "edited" mark stays.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mesh:operator-name', { detail: 'Camille' })));
    assert.match((await edited.locator('.work-answer-edited .work-answer-meta').textContent())!, /Camille.*edited/s);
    assert.match((await history.locator('.work-answer-meta').textContent())!, /earlier answer by .Camille. in this view, replaced/);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mesh:operator-name', { detail: '' })));
    assert.deepEqual(answersOf('N-0000d0d5').map(event => [event.text, event.via]), [['first answer', 'owner-web'], ['corrected answer', 'owner-web']]);
    await page.waitForFunction(() => document.querySelector('.work-announcer')?.textContent === 'Corrected answer recorded.');
    await noOverflow(page);
    await shot(page, 'options-edit-390');
    assert.deepEqual(problems, []);
  });

  test('an edit of a multi answer starts from its choices', { timeout: 900_000 }, async () => {
    const { pane } = await taskSheet(1440);
    const answered = item(pane, 'N-0000d0d7');
    await answered.getByRole('button', { name: 'Edit answer' }).click();
    assert.equal(await answered.getByRole('checkbox', { name: 'Linux' }).isChecked(), true);
    await answered.getByRole('checkbox', { name: 'macOS' }).check();
    await answered.getByRole('button', { name: 'Send corrected answer' }).click();
    await item(pane, 'N-0000d0d7').locator('.work-answer-edited').waitFor();
    assert.deepEqual(answersOf('N-0000d0d7').map(event => event.choices), [['Linux'], ['Linux', 'macOS']]);
  });

  test('the choices speak French', { timeout: 900_000 }, async () => {
    const { pane } = await taskSheet(390, 'fr-FR');
    // Its own question (N-0000d0e1), answered and corrected in the fixture: the test holds alone (--test-name-pattern).
    const edit = item(pane, 'N-0000d0e1').getByRole('button', { name: 'Modifier la réponse' });
    assert.equal(await edit.count(), 1, 'an answered question offers Edit');
    assert.match((await item(pane, 'N-0000d0e1').locator('.work-answer-edited .work-answer-meta').textContent())!, /réponse modifiée/);
    await edit.click();
    assert.equal(await item(pane, 'N-0000d0e1').getByRole('button', { name: 'Envoyer la réponse corrigée' }).count(), 1);
    assert.equal(await item(pane, 'N-0000d0e1').getByRole('group', { name: 'Choisissez une réponse' }).count(), 1);
    const earlier = item(pane, 'N-0000d0e1').locator('summary');
    assert.equal(await earlier.textContent(), 'Réponses antérieures (1)');
  });

  test('ticked answers and a correction are drafts: back after leaving, kept over another answer, gone once sent', { timeout: 900_000 }, async () => {
    const { page, pane, problems } = await taskSheet(1440);
    const stored = (): Promise<string> => page.evaluate(key => sessionStorage.getItem(key) ?? '', KEY);
    await item(pane, 'N-0000d0d8').getByRole('checkbox', { name: 'us' }).check();
    await item(pane, 'N-0000d0d9').getByRole('radio', { name: 'debug' }).check();
    const ci = item(pane, 'N-0000d0da');
    await ci.getByRole('button', { name: 'Edit answer' }).click();
    await ci.getByRole('checkbox', { name: 'GitLab' }).check();
    await ci.getByLabel('Other answer or comment (optional)').fill('draft correction');
    await page.waitForFunction(([key, text]) => (sessionStorage.getItem(key) ?? '').includes(text), [KEY, 'draft correction'] as const);

    // To the sessions and back: the sheet, its ticks, its radio and the open correction with its own ticks.
    await page.locator('#btn-sessions').click();
    await page.waitForFunction(() => !document.body.classList.contains('projecting'));
    await page.locator('#btn-projects').click();
    await item(pane, 'N-0000d0da').locator('.work-answer-form-edit').waitFor();
    const drafted = async (when: string): Promise<void> => {
      assert.equal(await item(pane, 'N-0000d0d8').getByRole('checkbox', { name: 'us' }).isChecked(), true, `${when}: the tick`);
      assert.equal(await item(pane, 'N-0000d0d9').getByRole('radio', { name: 'debug' }).isChecked(), true, `${when}: the radio`);
      assert.equal(await item(pane, 'N-0000d0d9').locator('textarea').inputValue(), 'debug', `${when}: the radio's text`);
      const correction = item(pane, 'N-0000d0da');
      assert.deepEqual(await correction.getByRole('checkbox').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked)),
        [true, true], `${when}: the correction's ticks`);
      assert.equal(await correction.locator('textarea').inputValue(), 'draft correction', `${when}: the correction's text`);
    };
    await drafted('back in the view');

    // Another question answered: the sheet is read again and the drafts of the others stay as they were.
    const keys = item(pane, 'N-0000d0db');
    await keys.getByText('Yes', { exact: true }).click();
    await keys.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0db').locator('.work-answer-verified').waitFor();
    await drafted('after another answer');

    // The correction sent: a new owner answer, the draft gone from the tab's storage; the others stay.
    await item(pane, 'N-0000d0da').getByRole('button', { name: 'Send corrected answer' }).click();
    await item(pane, 'N-0000d0da').locator('.work-answer-edited').waitFor();
    assert.deepEqual(answersOf('N-0000d0da').map(event => [event.text, event.choices]),
      [['GitHub', ['GitHub']], ['GitHub\nGitLab\ndraft correction', ['GitHub', 'GitLab']]]);
    await page.waitForFunction(([key, text]) => !(sessionStorage.getItem(key) ?? '').includes(text), [KEY, 'draft correction'] as const);
    assert.ok((await stored()).includes('debug'), 'the other drafts stay');
    assert.deepEqual(problems, []);
  });

  test('in the Questions tab a ticked answer survives the answer of another question', { timeout: 900_000 }, async () => {
    const { page } = await taskSheet(1440);
    await page.locator('#work-tab-questions').click();
    const tab = page.locator('#work-panel-questions');
    await item(tab, 'N-0000d0d8').getByRole('checkbox', { name: 'eu' }).check();
    const level = item(tab, 'N-0000d0d9');
    await level.getByRole('radio', { name: 'info' }).check();
    await level.getByRole('button', { name: 'Send answer' }).click();
    await item(tab, 'N-0000d0d9').locator('.work-answer-verified').waitFor();
    assert.equal(await item(tab, 'N-0000d0d8').getByRole('checkbox', { name: 'eu' }).isChecked(), true);
    assert.deepEqual(answersOf('N-0000d0d9').map(event => event.choices), [['info']]);
  });

  test('a correction open in the Questions tab and in the task sheet shows the newest draft in both after a redraw', { timeout: 900_000 }, async () => {
    const { page, pane, problems } = await taskSheet(1440);
    await page.locator('#work-tab-questions').click();
    const tab = page.locator('#work-panel-questions');
    await item(tab, 'N-0000d0e2').getByRole('button', { name: 'Edit answer' }).click();
    await item(tab, 'N-0000d0e2').locator('textarea').fill('older in the tab');
    await page.waitForFunction(([key, text]) => (sessionStorage.getItem(key) ?? '').includes(text), [KEY, 'older in the tab'] as const);
    const sheet = item(pane, 'N-0000d0e2');
    await sheet.getByRole('button', { name: 'Edit answer' }).click();
    await sheet.locator('textarea').fill('newer in the sheet');
    await page.waitForFunction(([key, text]) => (sessionStorage.getItem(key) ?? '').includes(text), [KEY, 'newer in the sheet'] as const);
    // Another question answered from the sheet: the sheet and the tab are both read again.
    const logs = item(pane, 'N-0000d0e3');
    await logs.getByText('Yes', { exact: true }).click();
    await logs.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000d0e3').locator('.work-answer-verified').waitFor();
    await item(tab, 'N-0000d0e3').locator('.work-answer-verified').waitFor();
    // One draft per question (the tab's storage): both forms show the newest one.
    assert.equal(await item(pane, 'N-0000d0e2').locator('textarea').inputValue(), 'newer in the sheet', 'the sheet');
    assert.equal(await item(tab, 'N-0000d0e2').locator('textarea').inputValue(), 'newer in the sheet', 'the tab');
    assert.deepEqual(answersOf('N-0000d0e2').length, 1, 'nothing sent for the correction');
    assert.deepEqual(problems, []);
  });

  test('a question about nothing: its cue is the kind of its form, its sheet offers the choices and keeps the draft', { timeout: 900_000 }, async () => {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    const toProjects = async (): Promise<void> => {
      await page.locator('#btn-mobile-actions').click();
      await page.locator('[data-mobile-action="btn-projects"]').click();
    };
    await toProjects();
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    const toggle = page.locator('.work-qsection-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const row = (id: string): Locator => page.locator(`.work-qrow[data-question-id="${id}"]`);
    // One source for the cue and the form (the kind): a yes / no, which has no options, is a decision.
    assert.equal(await row('N-0000d0dc').locator('.work-qkind').textContent(), 'Decision');
    assert.equal(await row('N-0000d0dd').locator('.work-qkind').textContent(), 'Open question');
    await row('N-0000d0dc').locator('.work-qrow-open').click();
    const sheet = page.locator('.work-qsheet');
    await sheet.getByRole('radio', { name: 'No' }).check();
    await page.waitForFunction(key => (sessionStorage.getItem(key) ?? '').includes('N-0000d0dc'), KEY);
    await page.locator('#projects-return').click();
    await page.waitForFunction(() => !document.body.classList.contains('projecting'));
    await toProjects();
    assert.equal(await page.locator('.work-qsheet').getByRole('radio', { name: 'No' }).isChecked(), true, 'the draft is back');
    await noOverflow(page);
    await shot(page, 'options-sheet-390');
    await page.locator('.work-qsheet').getByText('Yes', { exact: true }).click();
    await page.locator('.work-qsheet').getByRole('button', { name: 'Send answer' }).click();
    await page.locator('.work-qsheet .work-answer-recorded').waitFor();
    assert.deepEqual(answersOf('N-0000d0dc').map(event => [event.text, event.choices]), [['Yes', ['yes']]]);
    // The sheet of a free-text question offers no choice.
    await page.locator('.work-qsheet .work-back').click();
    await row('N-0000d0dd').locator('.work-qrow-open').click();
    await page.locator('.work-qsheet .work-answer-input').waitFor();
    assert.equal(await page.locator('.work-qsheet .work-answer-choices').count(), 0);
  });

  // The master token, under either scheme; an agent's own session token with `edit` and `choices` is refused in
  // tests/work-write-api.test.ts (a real session, started on the PTY host).
  test('the master token cannot answer or edit through the owner route', { timeout: 300_000 }, async () => {
    const { page } = await taskSheet(1440);
    const before = answersOf('N-0000d0d5').length;
    const send = (authorization: string): Promise<number> => page.evaluate(async header => (await fetch('/api/work/v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: header },
      body: JSON.stringify({ op: 'answer', args: { question: 'N-0000d0d5', text: 'agent edit', edit: true } }) })).status, authorization);
    assert.deepEqual([await send(`MeshSession ${mesh.token()}`), await send(`Bearer ${mesh.token()}`)], [401, 401]);
    assert.equal(answersOf('N-0000d0d5').length, before, 'nothing written');
  });
});
