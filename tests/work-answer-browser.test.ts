// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The owner's answer form of the task sheet (static/work-answer-form.ts) in headless Chromium against the real server,
// the real work-read and the real work-write on a fictional tracker (a copy of the worklog fixture plus questions).
// Nothing here uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR,
// WL_HOME in a temporary directory.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default: the dune build outputs);
// skipped without a Chromium (MESH_REQUIRE_BROWSER=1 makes that a failure) or without the programs
// (MESH_REQUIRE_WORK_READ=1 makes that a failure). The credential suite needs a Chromium only: it uses stand-in
// programs (tests/helpers/placeholder-program.ts), so it runs in the browser jobs of public CI, which build no
// OCaml. MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';
import { placeholderProgram, type Placeholder } from './helpers/placeholder-program.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const credentialSkip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false;
const skip = credentialSkip
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ && !process.env.CI
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const TASK = 'T-8e8e';
const HOSTILE = '<img src=x onerror=window.__pwn=7> use 8443';
const VERIFIED = 'answered by the owner in this view (signed in)';

const question = (id: string, text: string) =>
  ({ ts: '2026-11-08T09:00:00Z', task: TASK, type: 'question', id, text, agent: 'claude', session: 'asking-session' });
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: TASK, type: 'created', title: 'Answer form task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'set', field: 'project', to: 'P-5e6f' },
  question('N-0000b0b1', 'Which port?'), question('N-0000b0b2', 'Keep the old endpoint?'), question('N-0000b0b3', 'Ship on Friday?'),
  question('N-0000b0b4', 'Spare one?'), question('N-0000b0b5', 'Close the view meanwhile?'),
  // A relayed answer, as a forged one would be: the owner can still answer.
  { ts: '2026-11-08T10:00:00Z', task: TASK, type: 'answer', question: 'N-0000b0b2', text: 'forged yes', by: 'owner', agent: 'claude', session: 'other-session' },
];

let browser: Browser;
const contexts: BrowserContext[] = [];
const meshes: Mesh[] = [];
const scratch: string[] = [];
let answering: Mesh, noWriter: Mesh;
let answeringTracker: string;

function temporaryTracker(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-answer-tracker-'));
  scratch.push(directory);
  const tracker = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, tracker, { recursive: true });
  fs.writeFileSync(path.join(tracker, 'events', '2026-11.hostc.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  return tracker;
}

/** The answer events of a tracker (the fixture holds a malformed line on purpose). */
function answerEvents(tracker: string): Record<string, unknown>[] {
  const dir = path.join(tracker, 'events');
  return fs.readdirSync(dir).sort().flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(event => event !== null && event.type === 'answer');
}

async function start(prefix: string, extra: NodeJS.ProcessEnv): Promise<Mesh> {
  const mesh = await startMesh(prefix, { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90', ...extra });
  meshes.push(mesh);
  return mesh;
}

before(async () => {
  if (credentialSkip) return;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  if (skip) return;
  answeringTracker = temporaryTracker();
  gitInit(answeringTracker);
  answering = await start('workans-', { WL_HOME: answeringTracker });
  noWriter = await start('workans-none-', { WL_HOME: temporaryTracker(), MESH_WORK_WRITE_CMD: path.join(os.tmpdir(), 'work-answer-no-such-writer') });
});

/** A tracker under git, as a real one is: work-write's commit then succeeds and the reply has no `uncommitted`. */
function gitInit(tracker: string): void {
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    const run = spawnSync('git', ['-C', tracker, ...args], { stdio: 'ignore' });
    assert.equal(run.status, 0, `git ${args.join(' ')}`);
  }
}
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  for (const mesh of meshes) await mesh.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

/** The task sheet of the test task, opened from the board as the owner would. */
async function taskSheet(mesh: Mesh, width: number, locale = 'en-US', prepare?: (page: Page) => Promise<void>): Promise<{ page: Page; pane: Locator; problems: string[] }> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await prepare?.(page);
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
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

async function noOverflow(page: Page): Promise<void> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(wide, 0, 'nothing overflows horizontally');
}

describe('answering a question from the task sheet', { skip }, () => {
  test('the owner answers; a double submit sends once; the answer shows as the owner\'s, as text', { timeout: 900_000 }, async () => {
    const { page, pane, problems } = await taskSheet(answering, 1440);
    const open = item(pane, 'N-0000b0b1');
    await open.getByLabel('Your answer').fill(HOSTILE);
    const disabledAtOnce = await open.locator('form').evaluate((form: HTMLFormElement) => {
      form.requestSubmit(); form.requestSubmit();
      return (form.querySelector('.work-answer-send') as HTMLButtonElement).disabled;
    });
    assert.equal(disabledAtOnce, true, 'the button is disabled while sending');
    await item(pane, 'N-0000b0b1').locator('.work-answer-verified').waitFor();
    const answered = item(pane, 'N-0000b0b1');
    assert.equal(await answered.locator('.work-answer-text').textContent(), HOSTILE, 'shown as text, as recorded');
    assert.ok((await answered.locator('.work-answer-meta').textContent())!.startsWith(VERIFIED));
    assert.equal(await answered.locator('form').count(), 0, 'no form once the owner answered');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-question-id')), 'N-0000b0b1', 'focus on the question');
    await page.waitForFunction(() => document.querySelector('.work-announcer')?.textContent === 'Answer recorded.');
    assert.equal(answerEvents(answeringTracker).filter(event => event.question === 'N-0000b0b1').length, 1, 'one answer written');
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
    assert.equal(await pane.locator('img, script').count(), 0);
    await shot(page, 'answer-sent-1440');
    assert.deepEqual(problems, []);
  });

  test('at phone width the owner supersedes a relayed answer, which stays as replaced', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(answering, 390);
    const relayed = item(pane, 'N-0000b0b2');
    await noOverflow(page);
    await relayed.getByLabel('Your answer').fill('no, keep it');
    await relayed.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000b0b2').locator('.work-answer-verified').waitFor();
    const metas = await item(pane, 'N-0000b0b2').locator('.work-answer-meta').allTextContents();
    assert.ok(metas[0]!.includes("replaced by the owner's answer"), metas[0]!);
    assert.ok(metas[1]!.startsWith(VERIFIED), metas[1]!);
    await noOverflow(page);
    await shot(page, 'answer-supersede-390');
  });

  test('refused text, an empty answer and a conflict keep or explain the form', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(answering, 1440);
    const open = item(pane, 'N-0000b0b3');
    const input = open.getByLabel('Your answer'), send = open.getByRole('button', { name: 'Send answer' });
    // The bound counts characters, as the writer does: 1500 emoji (3000 UTF-16 units) fit in the field.
    await input.fill('\u{1F600}'.repeat(1500));
    assert.equal([...await input.inputValue()].length, 1500, 'no character is cut');
    await input.fill('');
    await send.click();
    assert.equal(await open.locator('.work-answer-status').textContent(), 'Write an answer first.');
    await input.fill('zero​width');
    await send.click();
    await open.locator('.work-answer-status[data-state="error"]', { hasText: 'not allowed' }).waitFor();
    assert.equal(await input.inputValue(), 'zero​width', 'the text is kept');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('work-answer-input')), true, 'focus back in the field');
    assert.equal(answerEvents(answeringTracker).filter(event => event.question === 'N-0000b0b3').length, 0);
    // Another tab answered meanwhile: "already answered" reads the task again and shows the recorded answer.
    const other = await page.evaluate(async () => (await fetch('/api/work/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'answer', args: { question: 'N-0000b0b3', text: 'from the other tab' } }) })).status);
    assert.equal(other, 200);
    await input.fill('from this tab');
    await send.click();
    await item(pane, 'N-0000b0b3').locator('.work-answer-verified').waitFor();
    assert.equal(await item(pane, 'N-0000b0b3').locator('.work-answer-text').textContent(), 'from the other tab');
    await page.waitForFunction(() => document.querySelector('.work-announcer')?.textContent?.startsWith('This question already has an answer from you'));
  });

  test('a draft under another question survives the reload that shows a sent answer', { timeout: 900_000 }, async () => {
    const { pane } = await taskSheet(answering, 1440);
    await item(pane, 'N-0000b0b5').getByLabel('Your answer').fill('a draft, not sent yet');
    const sent = item(pane, 'N-0000b0b4');
    await sent.getByLabel('Your answer').fill('sent');
    await sent.getByRole('button', { name: 'Send answer' }).click();
    await item(pane, 'N-0000b0b4').locator('.work-answer-verified').waitFor();
    assert.equal(await item(pane, 'N-0000b0b5').getByLabel('Your answer').inputValue(), 'a draft, not sent yet');
  });

  test('an answer that completes after the view was left shows nothing and reads nothing', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(answering, 1440);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const sent = new Promise<void>(resolve => { reached = resolve; });
    await page.route('**/api/work/v1', async route => {
      if (route.request().postData()?.includes('"op":"answer"')) { reached(); await held; }
      await route.continue();
    });
    const reads: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/work/v1') && request.postData()?.includes('"op":"task"')) reads.push(request.postData()!); });
    const open = item(pane, 'N-0000b0b5');
    await open.getByLabel('Your answer').fill('sent, then the view closed');
    await open.getByRole('button', { name: 'Send answer' }).click();
    await sent;
    await page.locator('#projects-return').click();
    await page.waitForFunction(() => !document.body.classList.contains('projecting'));
    release();
    await page.waitForResponse(response => response.url().endsWith('/api/work/v1') && response.request().postData()?.includes('"op":"answer"') === true);
    await page.waitForTimeout(1000);
    assert.deepEqual(reads, [], 'no task read after the view was left');
    assert.equal(answerEvents(answeringTracker).filter(event => event.question === 'N-0000b0b5').length, 1, 'the answer is written all the same');
  });

  test('a question the reader says the owner answered offers no form, even when no verified answer is listed', { timeout: 900_000 }, async () => {
    // A size bound can leave the owner's answer out of `answers`; `owner_answered` still says it exists.
    const { pane } = await taskSheet(noWriter, 1440, 'en-US', page => page.route('**/api/work/v1', async route => {
      if (!route.request().postData()?.includes('"op":"task"')) return route.continue();
      const response = await route.fetch();
      const task = await response.json();
      for (const q of task.questions ?? []) if (q.id === 'N-0000b0b2') q.owner_answered = true;
      return route.fulfill({ response, json: task });
    }));
    const relayedOnly = item(pane, 'N-0000b0b2');
    await relayedOnly.locator('.work-answer').first().waitFor();
    assert.equal(await relayedOnly.locator('.work-answer-verified').count(), 0, 'no verified answer in the list');
    assert.equal(await relayedOnly.locator('[data-work-answer-slot]').count(), 0, 'no reply slot');
    assert.equal(await relayedOnly.locator('form').count(), 0, 'no form');
    assert.equal(await item(pane, 'N-0000b0b4').locator('form').count(), 1, 'an open question keeps its form');
  });

  test('without work-write the form gives way to a short note', { timeout: 900_000 }, async () => {
    const { page, pane } = await taskSheet(noWriter, 390);
    const open = item(pane, 'N-0000b0b1');
    await open.getByLabel('Your answer').fill('yes');
    await open.getByRole('button', { name: 'Send answer' }).click();
    await open.locator('.work-answer-unavailable').waitFor();
    assert.match((await open.locator('.work-answer-unavailable').textContent())!, /needs work-write/);
    assert.equal(await open.locator('form').count(), 0);
    await noOverflow(page);
    await shot(page, 'answer-unavailable-390');
  });

  test('the form speaks French', { timeout: 900_000 }, async () => {
    const { pane } = await taskSheet(noWriter, 390, 'fr-FR');
    const open = item(pane, 'N-0000b0b4');
    assert.equal(await open.getByLabel('Votre réponse').count(), 1);
    assert.equal(await open.getByRole('button', { name: 'Envoyer la réponse' }).count(), 1);
  });
});

// The relay refuses before any program runs, so stand-ins are enough: this suite needs no OCaml build.
describe('the write op from the signed-in page refuses tokens', { skip: credentialSkip }, () => {
  let mesh: Mesh;
  let writer: Placeholder;
  before(async () => {
    const programs = fs.mkdtempSync(path.join(os.tmpdir(), 'work-answer-stand-ins-'));
    scratch.push(programs);
    writer = placeholderProgram(programs, 'work-write');
    mesh = await start('workans-cred-', { WL_HOME: temporaryTracker(), MESH_WORK_WRITE_CMD: writer.command,
      MESH_WORK_READ_CMD: placeholderProgram(programs, 'work-read').command });
  });

  test('a session token or the master token cannot write, even with the page\'s cookie; the cookie alone reaches the writer', { timeout: 300_000 }, async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    const send = (authorization: string | null): Promise<number> => page.evaluate(async header => (await fetch('/api/work/v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(header ? { authorization: header } : {}) },
      body: JSON.stringify({ op: 'answer', args: { question: 'N-0000b0b4', text: 'agent says yes' } }) })).status, authorization);
    assert.deepEqual([await send(`MeshSession ${mesh.token()}`), await send(`Bearer ${mesh.token()}`)], [401, 401]);
    assert.equal(writer.ran(), false, 'the writer never ran');
    assert.equal(await send(null), 200, 'the page\'s own cookie reaches the stand-in');
    assert.equal(writer.ran(), true);
  });
});
