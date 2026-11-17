// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, before, describe, run, test } from 'node:test';

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, 'package.json'));
let followupCatalog, roadmapObservation, roadmapTask, attemptObservation, translations;
let browser, server, origin;
const range = (likely) => ({ optimistic: likely, likely, pessimistic: likely });
const estimate = (id, likely) => ({ id, status: 'conditional', duration_minutes: range(likely), remaining_minutes: range(likely / 2), source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] });

async function start() {
  ({ followupCatalog, roadmapObservation, roadmapTask, attemptObservation } = await import(pathToFileURL(path.join(ROOT, 'tests/helpers/project-followup-fixtures.ts')).href));
  translations = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/i18n/en.json'), 'utf8'));
  if (!process.env.MESH_CHROMIUM) throw Error('MESH_CHROMIUM required for executable browser regressions');
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://local').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><section id="root"></section></body></html>'); return; }
    const file = path.resolve(ROOT, '.' + pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/plain'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: process.env.MESH_CHROMIUM, args: ['--no-sandbox', '--mute-audio'] });
}
async function mount(page, catalog, context) {
  await page.evaluate(async ({ catalog, context, translations }) => {
    const module = await import('/static/projects.js');
    window.component?.destroy();
    const project = catalog.projects[0], source = project.sources[0];
    const translate = (key, params = {}) => String(translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    window.component = module.mountProjectFollowup({ root: document.querySelector('#root'), machine: catalog.machine_id, project, source: source.id, summary: source.summary, translate, followupContext: context });
  }, { catalog, context, translations });
}
async function mountCatalog(page, catalog) {
  await page.evaluate(async ({ catalog, translations }) => {
    const module = await import('/static/projects.js');
    window.nextCatalog = catalog;
    const translate = (key, params = {}) => String(translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    window.catalogHost = module.mountProjects({ root: document.querySelector('#root'), origin: location.origin, translate, readPath: () => '/catalog.json', writePath: () => {},
      request: async url => new Response(JSON.stringify(url === '/api/view' ? { url: '/view/v2.f.regression/catalog.json' } : window.nextCatalog), { headers: { 'Content-Type': 'application/json' } }) });
    window.catalogHost.open();
  }, { catalog, translations });
  await refreshCatalog(page);
}
async function refreshCatalog(page, catalog) {
  if (catalog) await page.evaluate(value => { window.nextCatalog = value; }, catalog);
  await page.locator('.projects-load button').click();
  await page.waitForFunction(() => document.querySelector('#projects-status')?.textContent.includes('Snapshot generated'));
}
function linkedFixture() {
  const now = new Date().toISOString(), catalog = followupCatalog(roadmapObservation([roadmapTask({ state: 'active', attempts: 1, assignment: { id: 'attempt-1' },
    timeline: [attemptObservation(1, { outcome: 'active', ended_at: null })], progress: { status: 'unreported', sequence: 0 } })], { generated_at: now }));
  const other = followupCatalog(roadmapObservation([roadmapTask({ state: 'queued' })], { board_id: 'other-board', generated_at: now })).projects[0].sources[0];
  other.id = 'other';
  const report = { status: 'GO', round: 1, cycle: null, date: null, findings: { items: [], total: 0, truncated: false }, rounds_audit: { items: [], total: 0, truncated: false }, no_go_reason: null };
  const components = Object.fromEntries(['ledger', 'intake', 'spec', 'plan', 'implementation', 'review', 'qa_state', 'qa', 'manifest'].map(name => [name,
    { availability: ['ledger', 'review', 'qa_state', 'qa'].includes(name) ? 'valid' : 'absent', reason: null, truncated: false }]));
  catalog.projects[0].sources.push(other, { id: 'child', kind: 'roster', label: 'Child', status: 'available', observed_at: now, summary: { provider_schema: 'pipeline-task', provider_version: 1,
    source_generated_at: now, source_revision: 'b'.repeat(64), counts: {}, items: [], truncated: false, more: null, pipeline: { task: 'delivery', availability: 'valid', mode: 'full',
      latest_completed: { phase: 'qa', outcome: 'GO' }, verdict_disagreement: false, components, history: { items: [{ source_index: 0, phase: 'qa', outcome: 'GO', reason: null, reason_truncated: false,
        actor: { availability: 'unknown', value: null, truncated: false }, time: { availability: 'valid', value: now } }], total: 1, truncated: false }, review: report, qa: { ...report, qa_no_go_round: null }, qa_markdown_status: 'GO',
      coverage: ['checks', 'live-execution', 'session', 'attempt', 'full-report-history', 'standalone-acceptance'].map(id => ({ id, availability: 'unsupported', limitations: 'No canonical authority' })) } } });
  const context = { schema_version: 1, availability: 'provided', observed_at: now, revision: 'explicit-one', provenance: 'Explicit authored binding', reason: null,
    links: [{ parent: { kind: 'roadmap-task', machine_id: 'host', project_id: 'one', source_id: 'other', board_id: 'other-board', task_id: 'task', source_revision: null, contract_digest: null },
      child: { kind: 'pipeline-task', machine_id: 'host', project_id: 'one', source_id: 'child', task_id: 'delivery', source_revision: null } }] };
  return { catalog, context, now };
}
async function pageCase(body) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  try { await page.goto(origin); await body(page); } finally { await page.close(); }
}
let revisionSerial = 0;
function revisionCatalog(revision, options = {}) {
  const eta = { status: 'conditional', remaining_minutes: range(37),
    finish_at: { optimistic: '2026-11-14T12:37:00Z', likely: '2026-11-14T12:37:00Z', pessimistic: '2026-11-14T12:37:00Z' }, reasons: [] };
  const forecast = { schema_version: 1, as_of: '2026-11-14T12:00:00Z', estimate_revision: revision, based_on_state_revision: 1,
    tasks_eta: eta, global_eta: eta, assumptions: ['Prior forecast payload sentinel'] };
  if (options.unknownStatus) forecast.tasks_eta = forecast.global_eta = { status: 'unknown', remaining_minutes: null, finish_at: null, reasons: [] };
  if (options.gap === 'future') forecast.as_of = '2026-11-14T13:00:00Z';
  const estimates = options.gap === 'missing' ? undefined : options.gap === 'null' ? null : options.gap === 'invalid' ? { schema_version: 1, as_of: 'invalid' } : forecast;
  const catalog = followupCatalog(roadmapObservation([roadmapTask()], { estimates, version: options.version ?? 'revision-source',
    board_id: options.native === undefined ? 'delivery' : options.native, generated_at: options.renew ? '2026-11-14T12:01:00Z' : '2026-11-14T12:00:00Z' }));
  catalog.revision = 'revision-observation-' + (++revisionSerial);
  if (options.version === null) delete catalog.projects[0].sources[0].summary.source_revision;
  if (options.machine) catalog.machine_id = options.machine;
  if (options.project) catalog.projects[0].id = options.project;
  if (options.source) catalog.projects[0].sources[0].id = options.source;
  return catalog;
}
async function revisionSequence(page, steps, version) {
  for (const [revision, expected, options = {}] of steps) {
    const catalog = revisionCatalog(revision, { version, ...options }), family = catalog.projects[0].sources[0].summary.followup.forecast;
    const expectedAvailability = options.gap === 'missing' ? 'not-provided' : ['invalid', 'future'].includes(options.gap) ? 'invalid' : 'valid';
    assert.equal(family.availability, expectedAvailability, 'authored family precondition');
    await page.evaluate(value => { window.nextCatalog = value; document.querySelector('.projects-load').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }, catalog);
    await page.waitForFunction(revision => document.querySelector('#projects-status')?.textContent.includes(revision), catalog.revision);
    const text = await page.locator('.project-followup').innerText();
    assert.equal(text.includes(translations['projects.followup.revisionInconsistent']), expected, 'revision continuity ' + version + JSON.stringify(options));
    assert.equal(await page.locator('[data-followup-key="row-task"]').count(), 1, 'independent task retained');
    assert.match(await page.locator('.project-followup-age').innerText(), /Provider observation stale/);
    if (options.gap) {
      assert.equal(text.includes('Prior forecast payload sentinel'), false); assert.equal(text.includes('37 / 37 / 37'), false);
      assert.equal(text.includes('2026-11-14T12:37:00Z'), false);
      assert.equal(await page.locator('[data-followup-key="source-diagnostics"]').count(), 1, 'unknown-family diagnostic is present');
      assert.match(await page.locator('[data-followup-key="source-diagnostics"]').textContent(), new RegExp('forecast · ' + expectedAvailability));
    }
  }
}
const CASES = [
  ['estimate revision diagnostics survive unknown forecast coverage', () => pageCase(async page => {
    await page.clock.setFixedTime(new Date('2026-11-14T12:03:00Z'));
    await mountCatalog(page, revisionCatalog(1));
    for (const gap of ['missing', 'null', 'invalid', 'future']) {
      await revisionSequence(page, [[1, false], [1, false, { gap }], [2, true]], 'changed-' + gap);
      await revisionSequence(page, [[1, false], [1, false, { gap }], [1, false]], 'same-' + gap);
    }
    await revisionSequence(page, [[0, false], [0, false, { gap: 'missing' }], [1, true]], 'zero-changed');
    await revisionSequence(page, [[0, false], [0, false, { gap: 'missing' }], [0, false]], 'zero-same');
    await revisionSequence(page, [[1, false, { gap: 'null' }], [2, false]], 'first-known');
    await revisionSequence(page, [[1, false], [2, true], [2, true, { gap: 'missing' }], [1, true]], 'sticky');
    await revisionSequence(page, [[1, false], [2, false, { version: 'replacement-source', gap: 'missing' }], [2, false, { version: 'replacement-source' }]], 'changed-source');
    await revisionSequence(page, [[1, false], [2, false, { version: null }], [2, false]], 'unavailable-source');
    await revisionSequence(page, [[1, false], [1, false, { renew: true }]], 'renewed');
    await revisionSequence(page, [[1, false, { unknownStatus: true }], [1, false, { gap: 'invalid' }], [2, true]], 'known-unknown-status');
    for (const scope of [{ native: 'other-board' }, { machine: 'other-machine' }, { project: 'other-project' }, { source: 'other-source' }]) {
      const key = JSON.stringify(scope);
      await revisionSequence(page, [[1, false], [2, false, scope], [2, true]], 'return-' + key);
    }
    await revisionSequence(page, [[1, false], [2, false, { native: null }], [2, true]], 'unknown-native-return');
    await revisionSequence(page, [[1, false, { native: null }], [2, false, { native: null }]], 'unknown-native-fallback');
  })],
  ['display labels clip without weakening identifiers times or independent task facts', async () => {
    const limits = { assignee: 240, runtime: 80, role: 80, route: 80, model: 160 };
    const detail = (labels, overrides = {}) => followupCatalog(roadmapObservation([roadmapTask({
      state: 'active', attempts: 1, assignment: { id: 'attempt-1', ...labels },
      topology: Object.fromEntries(Object.entries(labels).filter(([key]) => key !== 'assignee')),
      timeline: [attemptObservation(1, { ...labels, role: undefined, outcome: 'active', ended_at: null })],
      progress: { status: 'reported', source: 'worker-reported', sequence: 1, recorded_at: '2026-11-14T10:01:00Z', message: 'Ready', current_step: null, reason: null }, ...overrides
    })])).projects[0].sources[0].summary.followup.task_details.items[0];
    for (const extra of [0, 1]) {
      const labels = Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, 'x'.repeat(limit + extra)]));
      const selected = detail(labels);
      for (const name of ['assignment', 'topology', 'timeline']) {
        assert.equal(selected[name].availability, 'valid', name); assert.equal(selected[name].text_truncated, Boolean(extra), name);
      }
      assert.equal(selected.progress.availability, 'valid');
      for (const [key, limit] of Object.entries(limits)) assert.equal(selected.assignment.value[key].length, limit, key);
    }
    const unicode = detail(Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, 'x'.repeat(limit - 1) + '😀'])));
    for (const [key, limit] of Object.entries(limits)) assert.equal(unicode.assignment.value[key], 'x'.repeat(limit - 1), key);
    assert.equal(detail({ assignee: 'x'.repeat(240) + '\u0001' }).assignment.availability, 'invalid');
    assert.equal(detail({}, { assignment: { id: 'x'.repeat(121) } }).assignment.availability, 'invalid');
    assert.equal(detail({}, { timeline: [attemptObservation(1, { outcome: 'active', ended_at: null, claimed_at: 'x'.repeat(81) })] }).timeline.availability, 'invalid');
    const reason = detail({}, { progress: { status: 'unavailable', sequence: null, reason: 'x'.repeat(241) } }).progress;
    assert.equal(reason.availability, 'valid'); assert.equal(reason.value.reason.length, 240); assert.equal(reason.text_truncated, true);
    const lineage = followupCatalog(roadmapObservation([roadmapTask({ kind: 'derived', derived: { parent: 'parent',
      cause: { task_id: 'parent', attempt_id: 'origin', assignee: 'x'.repeat(241) }, created_at: '2026-11-14T10:00:00Z' } })])).projects[0].sources[0].summary.followup.task_details.items[0].lineage;
    assert.equal(lineage.availability, 'valid'); assert.equal(lineage.value.cause.assignee.length, 240); assert.equal(lineage.text_truncated, true);
  }],
  ['same-root remount keeps focus only for the same known native identity', () => pageCase(async page => {
    const original = followupCatalog(), different = followupCatalog(roadmapObservation([roadmapTask()], { board_id: 'replacement-board' }));
    const unknown = followupCatalog(roadmapObservation([roadmapTask()], { board_id: null }));
    const pipeline = linkedFixture().catalog; pipeline.projects[0].sources = [pipeline.projects[0].sources[2]];
    const otherPipeline = structuredClone(pipeline); otherPipeline.projects[0].sources[0].summary.pipeline.task = 'replacement-task';
    const { parseProjectCatalog } = await import(pathToFileURL(path.join(ROOT, 'static/project-catalog.ts')).href);
    for (const value of [original, different, unknown, pipeline, otherPipeline]) assert.ok(parseProjectCatalog(value), 'valid selected fixture');
    for (const [before, after, same] of [[original, original, true], [original, different, false], [original, unknown, false], [pipeline, otherPipeline, false]]) {
      await mount(page, before); const row = page.locator('[data-followup-key^="row-"]').first();
      const key = await row.getAttribute('data-followup-key'); await row.focus();
      assert.equal(await page.evaluate(() => document.hasFocus()), true);
      await mount(page, after);
      assert.equal(await page.evaluate(key => document.activeElement?.dataset.followupKey === key, key), same, 'focus must follow known full identity');
      if (after === unknown) assert.equal(await page.locator('#root').getAttribute('data-followup-scope'), null, 'unknown identity clears stale marker');
    }
  })],
  ['invalid top-level families retain explicit diagnostics and independent task facts', () => pageCase(async page => {
    const catalog = followupCatalog(roadmapObservation([roadmapTask()], { board_id: null, estimates: { schema_version: 1, as_of: 'yesterday' } }));
    await mount(page, catalog);
    assert.equal(await page.locator('[data-followup-key="source-diagnostics"]').count(), 1);
    await page.locator('[data-followup-key="source-diagnostics"] > summary').click();
    assert.match(await page.locator('[data-followup-key="source-diagnostics"]').innerText(), /metadata · invalid/);
    assert.match(await page.locator('[data-followup-key="source-diagnostics"]').innerText(), /forecast · invalid/);
    assert.equal(await page.locator('[data-followup-key="row-task"]').count(), 1);
  })],
  ['qualified dependency numbers remain distinct from the source forecast', () => pageCase(async page => {
    const eta = { status: 'conditional', remaining_minutes: range(40), finish_at: { optimistic: '2026-11-14T12:40:00Z', likely: '2026-11-14T12:40:00Z', pessimistic: '2026-11-14T12:40:00Z' }, reasons: [] };
    const estimates = { schema_version: 1, as_of: '2026-11-14T12:00:00Z', estimate_revision: 1, based_on_state_revision: 2, tasks_eta: eta, global_eta: eta, assumptions: ['Source capacity-aware40-minute forecast'] };
    const tasks = ['first', 'second'].map(id => roadmapTask({ id, estimate: estimate(id, 40) }));
    await mount(page, followupCatalog(roadmapObservation(tasks, { estimates }))); await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
    assert.match(await page.locator('#root').innerText(), /dependency remaining span: 20 min; possible overlap: 2 tasks/);
    assert.match(await page.locator('#root').innerText(), /Remaining estimate: 40 \/ 40 \/ 40/);
    assert.match(await page.locator('#root').innerText(), /not observed workers/);
  })],
  ['prerequisite labels separate complete source gaps truncated source and another page', () => pageCase(async page => {
    await mount(page, followupCatalog(roadmapObservation([roadmapTask({ depends_on: ['absent'] })])));
    await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
    assert.match(await page.locator('#root').innerText(), /missing from complete source/);
    const tasks = Array.from({ length: 201 }, (_, i) => roadmapTask({ id: `task-${i}`, depends_on: i === 0 ? ['task-200'] : [] }));
    await mount(page, followupCatalog(roadmapObservation(tasks))); await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
    assert.match(await page.locator('#root').innerText(), /source task window truncated or unknown/);
    tasks[0].depends_on = ['task-59'];
    await mount(page, followupCatalog(roadmapObservation(tasks.slice(0, 60)))); await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
    assert.match(await page.locator('#root').innerText(), /Prerequisite on another page/);
  })],
  ['native identity changes isolate preferences while restoring a returning board', () => pageCase(async page => {
    const first = followupCatalog(), second = followupCatalog(roadmapObservation([roadmapTask()], { board_id: 'replacement-board' }));
    await mountCatalog(page, first); await page.locator('[data-followup-key="view-mode"]').selectOption('timeline'); await page.locator('[data-followup-key="row-task"]').click();
    await page.locator('[data-followup-key="row-task"]').focus();
    await page.evaluate(value => { window.nextCatalog = value; }, second);
    await page.locator('.projects-load').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.querySelector('#projects-status')?.textContent.includes('Snapshot generated'));
    assert.equal(await page.locator('[data-followup-key="view-mode"]').inputValue(), 'summary');
    assert.equal(await page.locator('.project-followup-detail').count(), 0);
    assert.equal(await page.locator('[data-followup-key="row-task"]').evaluate(value => value === document.activeElement), false);
    await refreshCatalog(page, first); assert.equal(await page.locator('[data-followup-key="view-mode"]').inputValue(), 'timeline');
    assert.equal(await page.locator('[data-followup-key="row-task"]').getAttribute('aria-pressed'), 'true');
  })],
  ['legacy pipeline disclosures keep their native source scope through refresh', () => pageCase(async page => {
    const { catalog } = linkedFixture(); await mountCatalog(page, catalog);
    await page.getByLabel('Detailed source', { exact: true }).selectOption('child');
    const details = page.locator('.projects-pipeline details');
    await details.evaluateAll(values => values.forEach(value => { value.open = true; }));
    await refreshCatalog(page);
    assert.equal(await details.evaluateAll(values => values.every(value => value.open)), true);
    await details.first().locator('summary').focus();
    await page.locator('.projects-load').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.locator('.projects-pipeline').waitFor();
    assert.equal(await details.first().locator('summary').evaluate(value => value === document.activeElement), true);
  })],
  ['estimate-only rows offer proportional total and remaining modes', () => pageCase(async page => {
      const tasks = [10, 20, null, 0].map((value, index) => roadmapTask({ id: `task-${index}`, estimate: value === null ? null : estimate(`task-${index}`, value) }));
      await mount(page, followupCatalog(roadmapObservation(tasks)));
      assert.equal(await page.locator('[data-followup-key="view-mode"] option[value="timeline-total"]').count(), 1);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline-total');
      const widths = await page.locator('.project-followup-bar').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
      assert.equal(widths[1] / widths[0], 2);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline-remaining');
      assert.match(await page.locator('#root').innerText(), /Remaining estimate.*5/);
    })],
  ['readiness reads the declared parent source when task IDs collide', () => pageCase(async page => {
      const { catalog, context } = linkedFixture(); await mount(page, catalog, context);
      assert.doesNotMatch(await page.locator('#root').innerText(), /waiting for coordinator receipt/);
    })],
  ['wall rollback cannot revive a stale display association', () => pageCase(async page => {
      const { catalog, context, now } = linkedFixture(); context.links[0].parent.source_id = 'roadmap'; context.links[0].parent.board_id = 'delivery';
      await page.clock.install({ time: new Date(Date.parse(now) + 59000) }); await mount(page, catalog, context);
      assert.match(await page.locator('#root').innerText(), /waiting for coordinator receipt/);
      await page.clock.runFor(61000); assert.doesNotMatch(await page.locator('#root').innerText(), /waiting for coordinator receipt/);
      await page.clock.setFixedTime(new Date(now)); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.doesNotMatch(await page.locator('#root').innerText(), /waiting for coordinator receipt/);
    })],
  ['claim paging keeps the focused keyboard control', () => pageCase(async page => {
      const catalog = followupCatalog(roadmapObservation([roadmapTask({ attempts: 60, timeline: Array.from({ length: 60 }, (_, i) => attemptObservation(i + 1)) })]));
      await mount(page, catalog); await page.locator('[data-followup-key="row-task"]').click(); await page.locator('[data-followup-key="attempts-task"] > summary').click();
      await page.getByRole('button', { name: 'Next claims', exact: true }).focus(); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Next claims');
    })],
  ['truncated task coverage withholds dependency timing', () => pageCase(async page => {
      const tasks = Array.from({ length: 201 }, (_, index) => roadmapTask({ id: `task-${index}`, estimate: estimate(`task-${index}`, 20) }));
      await mount(page, followupCatalog(roadmapObservation(tasks))); await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
      assert.match(await page.locator('#root').innerText(), /Dependency timing withheld/);
    })]
];
function register() {
  describe('recorded followup regression boundaries', { skip: !process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false }, () => {
    before(start); after(async () => { await browser?.close(); server?.close(); });
    for (const [name, body] of CASES) test(name, body);
  });
}
function assertion(error) { return error?.code === 'ERR_ASSERTION' || error?.failureType === 'testCodeFailure' && assertion(error.cause); }
async function execute() {
  let setup = false, failed = false, count = 0;
  for await (const event of run({ files: [import.meta.filename] })) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    if (data.details?.type === 'suite') continue;
    count++;
    console.log(JSON.stringify({ name: data.name, outcome: event.type, assertion: assertion(data.details?.error), failureType: data.details?.error?.failureType ?? null }));
    if (data.skip || data.todo) setup = true;
    if (event.type === 'test:fail') { if (assertion(data.details?.error)) failed = true; else setup = true; }
  }
  const code = setup || count !== CASES.length ? 2 : failed ? 1 : 0;
  console.log(JSON.stringify({ executed: count, code })); process.exitCode = code;
}
if (process.env.NODE_TEST_CONTEXT) register(); else execute().catch(error => { console.error(error); process.exitCode = 2; });
