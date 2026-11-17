// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { before, after, describe, test } from 'node:test';
import { ProjectsUiFixture } from './helpers/projects-ui.ts';
import { followupCatalog, roadmapObservation, roadmapTask, attemptObservation } from './helpers/project-followup-fixtures.ts';
import type { Page } from 'playwright-core';
import { parseProjectCatalog } from '../static/project-catalog.ts';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const skip = !process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
async function load(page: Page, catalog: unknown, fixture: ProjectsUiFixture, mobile: boolean) {
  await page.route('**/api/view', route => route.fulfill({ json: { url: '/view/v2.f.authored/catalog.json' } }));
  await page.route('**/view/v2.f.authored/catalog.json', route => route.fulfill({ json: catalog }));
  await fixture.enter(page, mobile); await page.locator('#projects-path').fill('/catalog.json'); await page.locator('.projects-load button').click();
  await page.locator('.project-followup').waitFor();
}
function linkedFixture() {
  const now = new Date().toISOString();
  const catalog = followupCatalog(roadmapObservation([roadmapTask({ state: 'active', attempts: 1, assignment: { id: 'attempt-1' },
    timeline: [attemptObservation(1, { outcome: 'active', ended_at: null })], progress: { status: 'unreported', sequence: 0 } })], { generated_at: now }));
  const components = Object.fromEntries(['ledger', 'intake', 'spec', 'plan', 'implementation', 'review', 'qa_state', 'qa', 'manifest'].map(name => [name, { availability: ['ledger', 'review', 'qa_state', 'qa'].includes(name) ? 'valid' : 'absent', reason: null, truncated: false }]));
  const report = { status: 'GO', round: 1, cycle: null, date: null, findings: { items: [], total: 0, truncated: false }, rounds_audit: { items: [], total: 0, truncated: false }, no_go_reason: null };
  const child = { id: 'child', kind: 'roster', label: 'Delivery review', status: 'available', observed_at: now,
    summary: { provider_schema: 'pipeline-task', provider_version: 1, source_generated_at: now, source_revision: 'b'.repeat(64), counts: {}, items: [], truncated: false, more: null,
      pipeline: { task: 'delivery-review', availability: 'valid', mode: 'full', latest_completed: { phase: 'qa', outcome: 'GO' }, verdict_disagreement: false, components,
        history: { items: [{ source_index: 0, phase: 'qa', outcome: 'GO', reason: null, reason_truncated: false,
          actor: { availability: 'unknown', value: null, truncated: false }, time: { availability: 'valid', value: now } }], total: 1, truncated: false }, review: report, qa: { ...report, qa_no_go_round: null }, qa_markdown_status: 'GO',
        coverage: ['checks', 'live-execution', 'session', 'attempt', 'full-report-history', 'standalone-acceptance'].map(id => ({ id, availability: 'unsupported', limitations: 'No canonical authority' })) } } };
  const value = structuredClone(catalog) as unknown as { projects: { sources: unknown[] }[] }; value.projects[0]!.sources.push(child);
  assert.ok(parseProjectCatalog(value));
  return { now, value };
}
describe('native recorded followup', { skip }, () => {
  const fixture = new ProjectsUiFixture(root);
  before(() => fixture.start()); after(() => fixture.stop());
  test('short work lists retain every view with only relevant controls', async () => {
    const { page, sockets, input } = await fixture.sessionPage(true);
    try {
      await load(page, followupCatalog(), fixture, true);
      const view = page.getByLabel('View', { exact: true });
      assert.deepEqual(await view.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value)),
        ['summary','kanban','timeline','timeline-total','timeline-remaining','dependencies']);
      assert.equal(await page.locator('.project-followup-zoom,.project-followup-pages').count(), 0);
      for (const mode of ['timeline', 'timeline-total', 'timeline-remaining']) {
        await view.selectOption(mode);
        assert.equal(await page.locator('.project-followup-zoom').count(), 1);
      }
      await view.selectOption('dependencies');
      assert.equal(await page.locator('.project-followup-zoom').count(), 0);
      await view.selectOption('summary');
      assert.equal(await view.inputValue(), 'summary');
      await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
  test('pipeline sources recover an unsupported stored Kanban preference', async () => {
    const {page}=await fixture.sessionPage();
    try{
      await fixture.enter(page);
      const bundle=await build({stdin:{contents:"export {mountProjectFollowup} from './static/project-followup-controller.ts';export {FollowupPreferenceStore} from './static/project-followup-preferences.ts';export {followupScope} from './static/project-followup-context.ts';",resolveDir:root},bundle:true,platform:'browser',format:'esm',write:false});
      await page.route('**/__pipeline-preference.js',route=>route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0]!.text}));
      const catalog=linkedFixture().value,translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
      await page.evaluate(async({catalog,translations})=>{
        const {mountProjectFollowup,FollowupPreferenceStore,followupScope}=await import('/__pipeline-preference.js');
        const project=catalog.projects[0]!,source=project.sources[1]!;
        const preferences=new FollowupPreferenceStore('test'),scope=followupScope(catalog.machine_id,project.id,source.id,source.summary);
        preferences.write(scope,{...preferences.read(scope),mode:'kanban'});
        const root=document.createElement('section');root.id='pipeline-preference';document.querySelector('#projects')!.append(root);
        const translate=(key:string)=>String(translations[key]??key);
        (window as any).pipelinePreference=mountProjectFollowup({root,project,summary:source.summary,source:source.id,machine:catalog.machine_id,translate,preferences});
      },{catalog,translations});
      const view=page.locator('#pipeline-preference [data-followup-key="view-mode"]');
      assert.equal(await view.inputValue(),'summary');assert.equal(await view.locator('option[value="kanban"]').count(),0);
      await page.evaluate('window.pipelinePreference.destroy()');
    }finally{await page.close();}
  });
  test('clock bars preserve shared scale unknowns and zero without fake starts', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const tasks = [10, 20, null, 0].map((minutes, index) => roadmapTask({ id: `duration-${index}`, attempts: minutes === null ? 0 : 1,
        timeline: minutes === null ? [] : [attemptObservation(1, { claimed_at: '2026-11-14T10:00:00+01:00', ended_at: `2026-11-14T09:${String(minutes).padStart(2, '0')}:00Z` })] }));
      tasks.push(roadmapTask({ id: 'fractional', attempts: 1, timeline: [attemptObservation(1, { claimed_at: '2026-11-14T09:00:00Z', ended_at: '2026-11-14T09:26:23.851Z' })] }));
      await load(page, followupCatalog(roadmapObservation(tasks)), fixture, false); await page.locator('[data-followup-key="view-mode"]').selectOption('timeline');
      const bars = page.locator('.project-gantt-bar');
      const shapes = await bars.evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, kind: element.className })));
      assert.ok(Math.abs(shapes[1]!.width / shapes[0]!.width - 2) < .01);
      assert.equal(await page.locator('[data-row-id="duration-2"] .project-gantt-bar').count(), 0);
      assert.match(await page.locator('[data-row-id="duration-2"]').innerText(), /not estimated/);
      assert.match(shapes[2]!.kind, /point/);
      assert.equal(await bars.last().getAttribute('data-duration'), '26.397516666666668');
      assert.match(await bars.last().getAttribute('title') ?? '', /26\.4 min/);
      assert.ok(!(await page.locator('.project-followup').innerText()).includes('26.397516666666668'));
    } finally { await page.close(); }
  });
  test('dependency gaps and cycles retain selectable rows', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const tasks = [roadmapTask({ id: 'a', depends_on: ['b'] }), roadmapTask({ id: 'b', depends_on: ['a'] }), roadmapTask({ id: 'c', depends_on: ['b'] }), roadmapTask({ id: 'gap', depends_on: ['missing'] })];
      await load(page, followupCatalog(roadmapObservation(tasks)), fixture, false); await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
      assert.equal(await page.locator('.project-followup-row').count(), 4);
      assert.match(await page.locator('.project-followup').innerText(), /Cycle or blocked-by-cycle/); assert.match(await page.locator('.project-followup').innerText(), /Prerequisite missing from complete source/);
      assert.match(await page.locator('.project-followup').innerText(), /Dependency timing withheld/);
      await page.locator('[data-followup-key="row-c"]').click(); assert.match(await page.locator('.project-followup-detail h5').innerText(), /c ·/);
      assert.equal(await page.locator('.project-dependency-edges path').count(), 3, 'known prerequisite links remain visible despite withheld cycle timing');
    } finally { await page.close(); }
  });
  test('clock timeline separates failed retries on PC and phone and retains task details', async () => {
    for (const mobile of [false, true]) {
      const { page, sockets, input } = await fixture.sessionPage(mobile);
      try {
        const task = roadmapTask({ attempts: 2, timeline: [
          attemptObservation(1, { claimed_at: '2026-11-14T09:00:00Z', ended_at: '2026-11-14T09:10:00Z', outcome: 'blocked' }),
          attemptObservation(2, { claimed_at: '2026-11-14T10:00:00Z', ended_at: '2026-11-14T10:30:00Z', outcome: 'done' }),
        ] });
        await load(page, followupCatalog(roadmapObservation([task, roadmapTask({ id: 'future' })])), fixture, mobile);
        await page.getByLabel('View', { exact: true }).selectOption('timeline');
        const attempts = page.locator('[data-row-id="task"] .project-gantt-bar');
        assert.equal(await attempts.count(), 2);
        assert.equal(await attempts.nth(0).getAttribute('data-outcome'), 'blocked');
        assert.equal(await attempts.nth(1).getAttribute('data-outcome'), 'done');
        const positions = await attempts.evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, top: node.getBoundingClientRect().top })));
        assert.ok(positions[1]!.left > positions[0]!.left && positions[1]!.top > positions[0]!.top);
        assert.equal(await page.locator('[data-row-id="future"] .project-gantt-bar').count(), 0);
        assert.equal(await page.locator('.project-gantt-observed').count(), 2);
        assert.ok(await page.locator('.project-gantt-tick').count() > 0);
        await page.locator('[data-followup-key="row-task"]').click();
        await page.locator('[data-followup-key="attempts-task"] > summary').click();
        assert.match(await page.locator('.project-followup-detail').innerText(), /attempt-1/);
        assert.match(await page.locator('.project-followup-detail').innerText(), /attempt-2/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
      } finally { await page.close(); }
    }
  });
  test('total and remaining ranges preserve missing evidence', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const estimate = { id: 'task', status: 'conditional', duration_minutes: { optimistic: 10, likely: 20, pessimistic: 30 }, remaining_minutes: { optimistic: 2, likely: 4, pessimistic: 6 },
        source: 'planner-remaining', overdue: false, reestimate_needed: false, reasons: [] };
      await load(page, followupCatalog(roadmapObservation([roadmapTask({ estimate }), roadmapTask({ id: 'unknown' })])), fixture, false);
      await page.locator('[data-followup-key="row-task"]').click();
      assert.match(await page.locator('.project-followup-detail').innerText(), /Total estimate: 10 \/ 20 \/ 30/);
      assert.match(await page.locator('.project-followup-detail').innerText(), /Remaining estimate: 2 \/ 4 \/ 6/);
      await page.locator('[data-followup-key="row-unknown"]').click(); assert.match(await page.locator('.project-followup-detail').innerText(), /Total and remaining estimates unknown/);
    } finally { await page.close(); }
  });
  test('dependency calculations remain distinct from source forecasts', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const range = { optimistic: 20, likely: 20, pessimistic: 20 }, eta = { status: 'conditional', remaining_minutes: { optimistic: 40, likely: 40, pessimistic: 40 },
        finish_at: { optimistic: '2026-11-14T12:10:00Z', likely: '2026-11-14T12:40:00Z', pessimistic: '2026-11-14T12:50:00Z' }, reasons: [] };
      const estimate = { id: 'task', status: 'conditional', duration_minutes: range, remaining_minutes: range, source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] };
      const estimates = { schema_version: 1, as_of: '2026-11-14T12:00:00Z', estimate_revision: 1, based_on_state_revision: 1, tasks_eta: eta, global_eta: eta, assumptions: ['Capacity-aware source fixture forecast'] };
      await load(page, followupCatalog(roadmapObservation([roadmapTask({ estimate }), roadmapTask({ id: 'second', estimate: { ...estimate, id: 'second' } })], { estimates })), fixture, false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
      assert.match(await page.locator('.project-followup').innerText(), /unlimited capacity/); assert.match(await page.locator('.project-followup').innerText(), /Capacity-aware source fixture forecast/);
      assert.match(await page.locator('.project-followup').innerText(), /remaining span: 20 min; possible overlap: 2 tasks/);
      assert.match(await page.locator('.project-followup').innerText(), /Remaining estimate: 40 \/ 40 \/ 40 min/);
      assert.match(await page.locator('.project-followup').innerText(), /not observed workers/);
      assert.match(await page.locator('.project-followup').innerText(), /Conditional finish/); assert.match(await page.locator('.project-followup').innerText(), /Planner basis state revision: 1/);
    } finally { await page.close(); }
  });
  test('estimate geometry follows total and remaining controls without claims', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const range = (likely: number) => ({ optimistic: likely, likely, pessimistic: likely });
      const tasks = [10, 20, null, 0].map((value, index) => roadmapTask({ id: String(index), estimate: value === null ? null :
        { id: String(index), status: 'conditional', duration_minutes: range(value), remaining_minutes: index === 1 ? null : range(value / 2),
          source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] } }));
      await load(page, followupCatalog(roadmapObservation(tasks)), fixture, false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline-total');
      const shapes = await page.locator('.project-followup-bar').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, kind: element.className })));
      assert.equal(shapes[1]!.width / shapes[0]!.width, 2); assert.match(shapes[2]!.kind, /unknown/); assert.match(shapes[3]!.kind, /point/);
      assert.match(await page.locator('.project-followup').innerText(), /Estimate scale: likely minutes/);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline-remaining');
      assert.match(await page.locator('.project-followup-row').nth(0).innerText(), /Remaining estimate.*5 min/);
      assert.match(await page.locator('.project-followup-row').nth(1).innerText(), /unknown \(unscaled\)/);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline');
      assert.equal(await page.locator('.project-gantt-bar.recorded').count(), 0, 'estimates do not become recorded claims');
      assert.ok(await page.locator('.project-gantt-bar.forecast').count() > 0);
      assert.match(await page.locator('.project-followup').innerText(), /not the source global ETA/);
    } finally { await page.close(); }
  });
  test('source truncation and page external dependencies have distinct labels', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const tasks = Array.from({ length: 201 }, (_, index) => roadmapTask({ id: String(index), depends_on: index === 0 ? ['50', '200', 'absent'] : [] }));
      await load(page, followupCatalog(roadmapObservation(tasks)), fixture, false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
      const row = await page.locator('.project-followup-row').nth(0).innerText();
      assert.match(row, /Prerequisite on another page: 50/);
      assert.match(row, /source task window truncated or unknown: 200, absent/);
      assert.doesNotMatch(row, /missing from complete source/);
      assert.match(await page.locator('.project-followup').innerText(), /Dependency timing withheld/);
    } finally { await page.close(); }
  });
  test('source age survives clock rollback and hidden resume', async () => {
    const { page } = await fixture.sessionPage();
    try {
      await page.clock.install({ time: new Date('2026-11-14T12:01:00Z') });
      await load(page, followupCatalog(), fixture, false); assert.match(await page.locator('.project-followup-age').innerText(), /60 seconds/);
      await page.clock.runFor(90000); assert.match(await page.locator('.project-followup-age').innerText(), /stale/);
      await page.clock.setFixedTime(new Date('2026-11-14T12:00:00Z'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); assert.match(await page.locator('.project-followup-age').innerText(), /stale/);
    } finally { await page.close(); }
  });
  test('display links revalidate exact identities and observations', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const { now, value } = linkedFixture(); await load(page, value, fixture, false);
      const input = { schema_version: 1, availability: 'provided', observed_at: now, revision: 'binding-one', provenance: 'Explicit caller binding', reason: null,
        links: [{ parent: { kind: 'roadmap-task', machine_id: 'host', project_id: 'one', source_id: 'roadmap', board_id: 'delivery', task_id: 'task', source_revision: 'source-one', contract_digest: 'a'.repeat(64) },
          child: { kind: 'pipeline-task', machine_id: 'host', project_id: 'one', source_id: 'child', task_id: 'delivery-review', source_revision: 'b'.repeat(64) } }] };
      await fixture.mountFollowup(page, value, input); assert.match(await page.locator('#standalone-followup').innerText(), /waiting for coordinator receipt/);
      const stale = { ...input, observed_at: new Date(Date.now() - 121000).toISOString() };
      await fixture.mountFollowup(page, value, stale); assert.doesNotMatch(await page.locator('#standalone-followup').innerText(), /waiting for coordinator receipt/);
      assert.match(await page.locator('#standalone-followup').innerText(), /stale-or-unknown-observation/);
      await fixture.mountFollowup(page, value, { ...input, links: [...input.links, ...input.links] }); assert.match(await page.locator('#standalone-followup').innerText(), /invalid-display-association/);
      const mismatch = structuredClone(input); mismatch.links[0]!.child.source_revision = 'c'.repeat(64);
      await fixture.mountFollowup(page, value, mismatch); assert.match(await page.locator('#standalone-followup').innerText(), /observation-mismatch/);
    } finally { await page.close(); }
  });
  test('linked child reports preserve pending parent receipt', async () => {
    const { page } = await fixture.sessionPage();
    try {
      const { now, value } = linkedFixture();
      await load(page, value, fixture, false);
      await page.evaluate(async ({ value, now, translations }) => {
        const module = await import('/static/projects.js'), project = value.projects[0], source = project.sources[0];
        const translate = (key: string, params: Record<string, string | number> = {}) => String(translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
        const root = document.createElement('section'); root.id = 'linked-evidence'; document.querySelector('#projects')!.append(root);
        module.mountProjectFollowup({ root, summary: source.summary, machine: value.machine_id, project, source: source.id, translate,
          followupContext: { schema_version: 1, availability: 'provided', observed_at: now, revision: 'explicit-one', provenance: 'Explicit authored display binding', reason: null,
            links: [{ parent: { kind: 'roadmap-task', machine_id: 'host', project_id: 'one', source_id: 'roadmap', board_id: 'delivery', task_id: 'task', source_revision: 'source-one', contract_digest: 'a'.repeat(64) },
              child: { kind: 'pipeline-task', machine_id: 'host', project_id: 'one', source_id: 'child', task_id: 'delivery-review', source_revision: 'b'.repeat(64) } }] } });
      }, { value, now, translations: JSON.parse(fs.readFileSync(path.join(root, 'static/i18n/en.json'), 'utf8')) });
      assert.match(await page.locator('#linked-evidence').innerText(), /waiting for coordinator receipt/);
      assert.match(await page.locator('#linked-evidence').innerText(), /not accepted done/);
      assert.match(await page.locator('#linked-evidence').innerText(), /does not indicate continued coding/);
      assert.match(await page.locator('.projects-detail .project-followup').innerText(), /not-supplied/);
    } finally { await page.close(); }
  });
  for (const mobile of [false, true]) test(`large followup views preserve session continuity and bounds (${mobile ? 'phone' : 'desktop'})`, async () => {
    const { page, sockets, input } = await fixture.sessionPage(mobile);
    try {
      const tasks = Array.from({ length: 200 }, (_, index) => roadmapTask({ id: `task-${index}`, objective: `Mission ${index}`, state: 'active', attempts: 1,
        assignment: { id: `attempt-${index}` }, timeline: [attemptObservation(1, { attempt_id: `attempt-${index}`, outcome: 'active', ended_at: null })], progress: { status: 'unreported', sequence: 0 } }));
      await load(page, followupCatalog(roadmapObservation(tasks)), fixture, mobile);
      assert.equal(await page.locator('.project-followup-row').count(), 50);
      assert.equal(await page.locator('[data-followup-key="previous"]').isDisabled(), true);
      assert.equal(await page.locator('[data-followup-key="next"]').isDisabled(), false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline');
      assert.match(await page.locator('[data-followup-key="row-task-0"]').getAttribute('title') ?? '', /Mission open \/ assigned/);
      assert.match(await page.locator('.project-gantt-bar').first().getAttribute('title') ?? '', /includes waiting/);
      assert.ok(await page.locator('.project-followup *').count() <= 5000);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await page.locator('[data-followup-key="row-task-0"]').click();
      await page.locator('[data-followup-key="next"]').click();
      assert.match(await page.locator('.project-followup-detail h5').innerText(), /task-0/);
      await page.locator('[data-followup-key="reveal"]').click();
      assert.equal(await page.locator('[data-followup-key="row-task-0"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
  test('native touch pans work charts without script capture or scroll writes', async () => {
    const {page,sockets,input}=await fixture.sessionPage(true);
    try {
      const tasks=['queued','active','blocked','done'].map((state,index)=>roadmapTask({id:`touch-${index}`,state,
        objective:`Touch scrolling task ${index}`,depends_on:index?[`touch-${index-1}`]:[]}));
      await load(page,followupCatalog(roadmapObservation(tasks)),fixture,true);
      for(const mode of ['kanban','timeline','dependencies']) {
        try {
        await page.locator('[data-followup-key="view-mode"]').selectOption(mode);
        const chart=page.locator('.project-followup-chart');await chart.scrollIntoViewIfNeeded();
        assert.ok(await chart.evaluate(element=>element.scrollWidth>element.clientWidth+60),'fixture has useful local horizontal travel');
        const touchAction=await chart.evaluate(element=>getComputedStyle(element).touchAction);
        assert.ok(touchAction.includes('pan-x')||touchAction==='auto'||touchAction==='manipulation','browser may pan horizontally');
        await chart.evaluate(element=>{
          const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollLeft')!;
          const capture=element.setPointerCapture.bind(element),probe={writes:0,captures:0,ended:false};(element as any).touchProbe=probe;
          element.scrollLeft=0;
          element.addEventListener('scroll',()=>{probe.ended=false;},{passive:true});
          element.addEventListener('scrollend',()=>{probe.ended=true;},{passive:true});
          Object.defineProperty(element,'scrollLeft',{configurable:true,get(){return descriptor.get!.call(element);},set(value){probe.writes++;descriptor.set!.call(element,value);}});
          element.setPointerCapture=id=>{probe.captures++;capture(id);};
        });
        const box=(await chart.boundingBox())!,x=box.x+box.width-24,y=Math.max(100,Math.min(750,box.y+24));
        const cdp=await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(const distance of [20,50,90,130])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-distance,y}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
        await page.waitForFunction(()=>document.querySelector('.project-followup-chart')!.scrollLeft>30);
        await chart.evaluate(async element=>{
          const probe=(element as any).touchProbe;let previous=element.scrollLeft,stable=0;
          for(let frame=0;frame<180;frame++){
            await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
            const current=element.scrollLeft;stable=current===previous?stable+1:0;previous=current;
            if(stable>=(probe.ended?2:8))return;
          }
          throw new Error('native scrolling did not settle within180 animation frames');
        });
        assert.deepEqual(await chart.evaluate(element=>{const probe=(element as any).touchProbe;return{writes:probe.writes,captures:probe.captures};}),{writes:0,captures:0},`${mode}: native touch bypasses script scroll/capture`);
        assert.equal(await page.locator('.project-work-inspector').count(),0,'scroll gesture cannot select a task');
        await page.locator('[data-followup-key="row-touch-0"]').tap();
        assert.equal(await page.locator('.project-followup-detail h5').textContent(),'touch-0 · Touch scrolling task 0',`${mode}: the first clean tap after native rest selects the exact task`);
        await page.locator('[data-followup-key="close-detail"]').click();
        } catch(error) { throw new Error(`${mode}: ${String(error)}`,{cause:error}); }
      }
      await page.locator('#projects-return').click();await fixture.continuity(page,sockets,input);
    } finally {await page.close();}
  });
  test('pointer sequences suppress unintended row activation', async () => {
    const { page } = await fixture.sessionPage();
    try {
      await load(page, followupCatalog(), fixture, false);
      const button = page.locator('[data-followup-key="row-task"]');
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20 });
      await button.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 27, clientY: 20 });
      await button.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 27, clientY: 20 });
      await button.dispatchEvent('click', { detail: 1 }); assert.equal(await page.locator('.project-followup-detail').count(), 0);
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 20, clientY: 20 });
      await button.dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 2 });
      await button.dispatchEvent('click', { detail: 1 }); assert.equal(await page.locator('.project-followup-detail').count(), 0);
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 20, clientY: 20 });
      await button.dispatchEvent('lostpointercapture', { pointerType: 'touch', pointerId: 3 });
      await button.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 3 });
      await button.dispatchEvent('click', { detail: 1 }); assert.equal(await page.locator('.project-followup-detail').count(), 0);
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 4, clientX: 20, clientY: 20 });
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 5, clientX: 20, clientY: 20 });
      await button.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 4 }); await button.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 5 });
      await button.dispatchEvent('click', { detail: 1 }); assert.equal(await page.locator('.project-followup-detail').count(), 0);
      await button.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 6, clientX: 20, clientY: 20 });
      await button.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 6, clientX: 20, clientY: 20 });
      await button.dispatchEvent('click', { detail: 1 }); assert.equal(await page.locator('.project-followup-detail').count(), 1);
    } finally { await page.close(); }
  });
  test('attempt pages retain every selected claim and disclosure on refresh', async () => {
    const { page, sockets, input } = await fixture.sessionPage();
    try {
      const catalog = followupCatalog(roadmapObservation([roadmapTask({ attempts: 201, timeline: Array.from({ length: 201 }, (_, index) => attemptObservation(index + 1)) })]));
      await load(page, catalog, fixture, false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline'); await page.locator('[data-followup-key="zoom-in"]').click();
      await page.locator('[data-followup-key="row-task"]').click();
      await page.locator('[data-followup-key="attempts-task"] > summary').click();
      const ordinals: number[] = [];
      for (let index = 0; index < 4; index++) {
        ordinals.push(...await page.locator('[data-followup-key="attempts-task"] li').evaluateAll(elements => elements.map(element => Number(element.textContent?.split(' · ')[0]))));
        if (index < 3) await page.getByRole('button', { name: 'Next claims', exact: true }).click();
      }
      assert.deepEqual(ordinals, Array.from({ length: 200 }, (_, index) => index + 2));
      assert.match(await page.locator('.project-followup-detail').innerText(), /Older claims unavailable: 1/);
      await page.locator('[data-followup-key="row-task"]').focus();
      await page.locator('.projects-load').evaluate(element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await page.locator('.project-followup-detail').waitFor();
      assert.equal(await page.locator('[data-followup-key="view-mode"]').inputValue(), 'timeline');
      assert.equal(await page.locator('.project-followup output').textContent(), '1.25×');
      assert.equal(await page.locator('[data-followup-key="attempts-task"]').getAttribute('open'), '');
      assert.equal(await page.locator('[data-followup-key="row-task"]').evaluate(element => element === document.activeElement), true);
      await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
  test('keyboard focus stays with its owning document and instance', async () => {
    const { page, sockets, input } = await fixture.sessionPage();
    try {
      await load(page, followupCatalog(), fixture, false);
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline');
      await page.locator('[data-followup-key="view-mode"]').focus(); await page.keyboard.press('+');
      assert.equal(await page.locator('.project-followup output').textContent(), '1×', 'select typeahead must not trigger chart shortcuts');
      await page.locator('[data-followup-key="chart"]').focus(); await page.keyboard.press('+');
      assert.equal(await page.locator('.project-followup output').textContent(), '1.25×');
      assert.equal(await page.locator('[data-followup-key="chart"]').evaluate(element => element === document.activeElement), true);
      const catalog = followupCatalog();
      await page.evaluate(async ({ catalog, translations }) => {
        const frame = document.createElement('iframe'); frame.id = 'followup-frame'; frame.width = '320'; frame.height = '480';
        frame.style.position = 'fixed'; frame.style.right = '0'; frame.style.bottom = '0'; document.body.append(frame);
        const doc = frame.contentDocument!; doc.open(); doc.write('<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><section id="embedded"></section></body></html>'); doc.close();
        const module = await import('/static/projects.js');
        const translate = (key: string, params: Record<string, string | number> = {}) => String(translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
        const project = catalog.projects[0]!, source = project.sources[0]!;
        (window as unknown as { embedded: unknown }).embedded = module.mountProjectFollowup({ root: doc.querySelector('#embedded'), summary: source.summary, machine: catalog.machine_id, project, source: source.id, translate });
      }, { catalog, translations: JSON.parse(fs.readFileSync(path.join(root, 'static/i18n/en.json'), 'utf8')) });
      const frame = page.frameLocator('#followup-frame'); await frame.locator('[data-followup-key="row-task"]').click();
      await page.locator('#projects-return').click();
      assert.equal(await page.evaluate('active.term.focus(); window.parentFocus = document.activeElement; active.el.contains(window.parentFocus)'), true);
      await frame.locator('[data-followup-key="view-mode"]').evaluate(element => { (element as HTMLSelectElement).value = 'timeline'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(await page.evaluate('document.activeElement === window.parentFocus && active.el.contains(document.activeElement)'), true);
      assert.equal(await frame.locator('body').evaluate(element => element.ownerDocument.documentElement.scrollWidth <= element.ownerDocument.defaultView!.innerWidth), true);
      await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
});
