// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
const chrome = process.env.MESH_CHROMIUM ?? '';
const skip = !chrome && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
let browser: Browser;
before(async () => {if (!skip) browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));});
after(async () => {await browser?.close();});
const root = path.resolve(import.meta.dirname, '..');
async function createPage(current: boolean, capture = false): Promise<Page> {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}, reducedMotion: 'reduce'});
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    (window as typeof window & {clockOffset: number}).clockOffset = 0;
    Date.now = () => realNow() + (window as typeof window & {clockOffset: number}).clockOffset;
  });
  await page.route('http://flow.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/flow-view.js') return route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'static/flow-view.js'))});
    if (url.pathname === '/flow.css') return route.fulfill({contentType: 'text/css', body: fs.readFileSync(path.join(root, 'static/flow.css'))});
    if (url.pathname === '/style.css') return route.fulfill({contentType: 'text/css', body: fs.readFileSync(path.join(root, 'static/style.css'))});
    const now = Math.floor(Date.now() / 1000);
    const main = {id:'session-mesh-codex',created:1,agent:'codex'};
    const peers = [{id:'ocaml-mcp-codex',created:2,agent:'codex'}, {id:'review-agent',created:3,agent:'claude'},
      {id:'test-agent',created:4,agent:'codex'}];
    const events = capture ? peers.flatMap((peer, i) => [
      {id:`create-${i}`,kind:'create',time:now - 220 + i * 35,source:main,target:peer},
      {id:`message-${i}`,kind:'message',time:now - 200 + i * 35,source:peer,target:main},
    ]) : [{id:'one',kind:'message',time:now,source:{id:'origin',created:1,agent:'codex'},target:{id:'<img src=x>',created:2,agent:'claude'}}];
    const translations = capture ? JSON.parse(fs.readFileSync(path.join(root, 'static/i18n/fr.json'), 'utf8')) : {};
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/flow.css"></head><body><main id="flow"></main><script>
      window.snapshot = {events:${JSON.stringify(events)},truncated:false}; window.catalog = ${JSON.stringify(translations)};
      window.current = ${current ? JSON.stringify(capture ? main : {id:'origin',created:1}) : 'null'};
      </script><script type="module">import {mountFlowView} from '/flow-view.js';
      window.requestCount = 0; window.serverOffset = 0;
      window.controller = mountFlowView({root:document.querySelector('#flow'),request:async()=>{window.requestCount++; return new Response(JSON.stringify(window.snapshot))},translate:(key,p)=>window.catalog[key] ? window.catalog[key].replace(/\\{(\\w+)\\}/g,(_,k)=>p?.[k] ?? '') : key+(p ? JSON.stringify(p) : ''),locale:()=> 'fr',now:()=>Date.now()/1000 + window.serverOffset,current:()=>window.current}); window.controller.open();</script></body></html>`});
  });
  await page.goto('http://flow.test/');
  await page.locator('.flow-event-list').waitFor({state: 'attached'});
  return page;
}
describe('agent flow views', {skip}, () => {
  test('focus is exact, the graph and sequence share selection, and text stays inert', async () => {
    const page = await createPage(true);
    try {
      await page.getByRole('button', {name: /flow.kind.message.*origin/}).first().waitFor();
      if (process.env.FLOW_UI_SCREENSHOT) await page.screenshot({path: process.env.FLOW_UI_SCREENSHOT});
      assert.equal(await page.locator('img').count(), 0);
      await page.locator('.flow-event-row').first().focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.flow-event-row[aria-pressed=true]').count(), 1);
      assert.equal(await page.locator('.flow-event-row[aria-pressed=true]').evaluate(el => el === document.activeElement), true);
      const expectedDate = await page.evaluate(() => {
        const global = window as typeof window & {snapshot: {events:Array<{time:number}>}};
        return new Date(global.snapshot.events[0]!.time * 1000).toLocaleString('fr');
      });
      assert.equal(await page.locator('.flow-detail-time').textContent(), expectedDate);
      await page.getByRole('button', {name: 'flow.graph', exact: true}).click();
      assert.equal(await page.locator('.flow-graph-node').count(), 2);
      assert.match(await page.locator('.flow-detail').innerText(), /origin/);
      assert.match(await page.locator('.flow-notice').innerText(), /flow.bestEffort/);
      await page.locator('.flow-graph-node').first().focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.flow-graph-node[aria-pressed=true]').count(), 1);
      assert.equal(await page.locator('.flow-graph-node[aria-pressed=true]').evaluate(el => el === document.activeElement), true);
      assert.match(await page.locator('.flow-detail').innerText(), /flow.sessionDetail/);
    } finally {await page.close();}
  });
  test('missing current session has an honest empty state; new motion honours reduced motion', async () => {
    const page = await createPage(false);
    try {
      await page.getByText('flow.noCurrent').waitFor();
      await page.getByRole('button', {name: 'flow.all', exact: true}).click();
      assert.equal(await page.locator('.flow-event-row').count(), 1);
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot: {events: Array<Record<string, unknown>>}};
        global.snapshot.events.push({...global.snapshot.events[0]!, id: 'two'});
      });
      await page.getByRole('button', {name: 'flow.refresh', exact: true}).click();
      await page.waitForSelector('.flow-spark', {state: 'attached'});
      assert.equal(await page.locator('.flow-spark').first().evaluate(el => getComputedStyle(el).display), 'none');
      assert.equal(await page.locator('.flow-event-row').count(), 2);
    } finally {await page.close();}
  });
  test('small screens keep the controls usable while the diagram scrolls', async () => {
    const page = await createPage(true);
    try {
      await page.setViewportSize({width: 375, height: 812});
      await page.locator('.flow-event-row').first().waitFor();
      const dimensions = await page.evaluate(() => ({document: document.documentElement.scrollWidth,
        viewport: window.innerWidth, diagram: document.querySelector('.flow-scroll')!.scrollWidth}));
      assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions));
      assert.ok(dimensions.diagram > dimensions.viewport, JSON.stringify(dimensions));
      assert.equal(await page.getByRole('button', {name: 'flow.graph', exact: true}).isVisible(), true);
    } finally {await page.close();}
  });
  test('live refresh preserves focus and scroll positions when events arrive', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot: {events: Array<Record<string, unknown>>}};
        const first = global.snapshot.events[0]!;
        global.snapshot.events = Array.from({length: 30}, (_, i) => ({...first, id: `event-${i}`,
          target: {id: `agent-${i}`, agent: 'codex', created: i + 2}}));
      });
      await page.getByRole('button', {name: 'flow.refresh', exact: true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.flow-event-row').length === 30);
      await page.setViewportSize({width: 375, height: 812});
      await page.evaluate(() => {
        const diagram = document.querySelector<HTMLElement>('.flow-scroll')!;
        const list = document.querySelector<HTMLElement>('.flow-event-list')!;
        diagram.scrollLeft = 230; diagram.scrollTop = 320; list.scrollTop = 100;
        document.querySelector<HTMLElement>('[data-flow-id="event-10"][data-flow-role="list"]')!.focus({preventScroll:true});
        const global = window as typeof window & {snapshot: {events: Array<Record<string, unknown>>}};
        global.snapshot.events.push({...global.snapshot.events[0]!, id:'fresh'});
      });
      const before = await page.evaluate(() => ({left:document.querySelector<HTMLElement>('.flow-scroll')!.scrollLeft,
        top:document.querySelector<HTMLElement>('.flow-scroll')!.scrollTop, list:document.querySelector<HTMLElement>('.flow-event-list')!.scrollTop}));
      await page.waitForFunction(() => document.querySelectorAll('.flow-event-row').length === 31, null, {timeout: 9000});
      const after = await page.evaluate(() => ({left:document.querySelector<HTMLElement>('.flow-scroll')!.scrollLeft,
        top:document.querySelector<HTMLElement>('.flow-scroll')!.scrollTop, list:document.querySelector<HTMLElement>('.flow-event-list')!.scrollTop,
        focus:(document.activeElement as HTMLElement)?.dataset.flowId}));
      assert.deepEqual(after, {...before, focus:'event-10'});
    } finally {await page.close();}
  });
  test('time filter expires events even if the polled snapshot has not changed', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => { (window as typeof window & {clockOffset:number}).clockOffset = 3_601_000; });
      await page.getByText('flow.empty').waitFor({timeout: 9000});
      assert.equal(await page.locator('.flow-event-row').count(), 0);
    } finally {await page.close();}
  });
  test('time filter follows the server clock when the browser clock is wrong', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {clockOffset:number; serverOffset:number};
        global.clockOffset = 86_400_000; global.serverOffset = -86_400;
      });
      await page.getByRole('button', {name:'flow.refresh', exact:true}).click();
      assert.equal(await page.locator('.flow-event-row').count(), 1);
      await page.evaluate(() => { (window as typeof window & {serverOffset:number}).serverOffset += 3601; });
      await page.getByText('flow.empty').waitFor({timeout: 9000});
    } finally {await page.close();}
  });
  test('opposite directions and both event kinds have distinct, labelled curves', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot:{events:Array<Record<string, unknown>>}};
        const original = global.snapshot.events[0]!;
        global.snapshot.events = [
          {...original,id:'forward-message',kind:'message'}, {...original,id:'forward-create',kind:'create'},
          {...original,id:'reverse-message',kind:'message',source:original.target,target:original.source},
          {...original,id:'reverse-create',kind:'create',source:original.target,target:original.source},
        ];
      });
      await page.getByRole('button', {name:'flow.refresh', exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.flow-event-row').length === 4);
      await page.getByRole('button', {name:'flow.graph', exact:true}).click();
      const curves = await page.locator('path[data-flow-kind]').evaluateAll(nodes => nodes.map(node => ({
        d:node.getAttribute('d'), from:node.getAttribute('data-flow-from'),
        to:node.getAttribute('data-flow-to'), kind:node.getAttribute('data-flow-kind')})));
      assert.equal(curves.length, 4);
      assert.equal(new Set(curves.map(curve => curve.d)).size, 4);
      assert.equal(new Set(curves.map(curve => `${curve.from}:${curve.to}`)).size, 2);
      assert.equal(new Set(curves.map(curve => curve.kind)).size, 2);
      const labels = await page.locator('.flow-graph-edge-button').allTextContents();
      assert.equal(labels.filter(label => label === 'flow.kind.message').length, 2);
      assert.equal(labels.filter(label => label === 'flow.kind.create').length, 2);
      const boxes = await page.locator('.flow-graph-edge-button').evaluateAll(buttons => buttons.map(button => {
        const b = button.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};
      }));
      const stage = await page.locator('.flow-graph').boundingBox(); assert.ok(stage);
      for (const box of boxes) assert.ok(box.left >= stage.x && box.right <= stage.x + stage.width
        && box.top >= stage.y && box.bottom <= stage.y + stage.height, `relation outside stage: ${JSON.stringify(box)}`);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
          `relation buttons ${i} and ${j} overlap: ${JSON.stringify([a, b])}`);
      }
      const forward = page.locator('[data-flow-id="forward-message"][data-flow-role="graph-edge"]');
      const box = await forward.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44);
      await forward.click();
      assert.equal(await page.locator('[data-flow-id="forward-message"][data-flow-role="graph-edge"]').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('.flow-detail').innerText(), /flow.kind.message/);
      const reverse = page.locator('[data-flow-id="reverse-create"][data-flow-role="graph-edge"]');
      await reverse.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-flow-id="reverse-create"][data-flow-role="graph-edge"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-flow-id="reverse-create"][data-flow-role="graph-edge"]').evaluate(el => el === document.activeElement), true);
      assert.match(await page.locator('.flow-detail').innerText(), /flow.kind.create/);
      for (const id of ['forward-message', 'forward-create', 'reverse-message', 'reverse-create']) {
        const button = page.locator(`[data-flow-id="${id}"][data-flow-role="graph-edge"]`);
        assert.equal(await button.isVisible(), true);
        await button.click();
        assert.equal(await page.locator(`[data-flow-id="${id}"][data-flow-role="graph-edge"]`).getAttribute('aria-pressed'), 'true');
      }
    } finally {await page.close();}
  });
  test('an aggregated relation opens its newest event and announces its count', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot:{events:Array<Record<string, unknown>>}};
        const first = global.snapshot.events[0]!;
        global.snapshot.events.push({...first,id:'latest',time:(first.time as number) + 1});
      });
      await page.getByRole('button', {name:'flow.refresh', exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.flow-event-row').length === 2);
      await page.getByRole('button', {name:'flow.graph', exact:true}).click();
      const relation = page.locator('[data-flow-id="latest"][data-flow-role="graph-edge"]');
      assert.match(await relation.innerText(), /×2/);
      assert.match((await relation.getAttribute('aria-label')) ?? '', /flow.latestOf/);
      await relation.click();
      assert.equal(await page.locator('[data-flow-id="latest"][data-flow-role="list"]').getAttribute('aria-pressed'), 'true');
    } finally {await page.close();}
  });
  test('parallel relation buttons stay separate for vertical lanes', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot:{events:Array<Record<string, unknown>>}};
        const original = global.snapshot.events[0]!;
        global.snapshot.events = [
          {...original,id:'vertical-1',kind:'message'}, {...original,id:'vertical-2',kind:'create'},
          {...original,id:'vertical-3',kind:'message',source:original.target,target:original.source},
          {...original,id:'vertical-4',kind:'create',source:original.target,target:original.source},
          {...original,id:'filler-1',target:{id:'aaa',agent:'codex',created:3}},
          {...original,id:'filler-2',target:{id:'zzz',agent:'codex',created:4}},
        ];
      });
      await page.getByRole('button', {name:'flow.refresh', exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.flow-event-row').length === 6);
      await page.getByRole('button', {name:'flow.graph', exact:true}).click();
      const buttons = page.locator('.flow-graph-edge-button[data-flow-id^="vertical-"]');
      const boxes = await buttons.evaluateAll(items => items.map(item => {
        const box = item.getBoundingClientRect(); return {left:box.left,right:box.right,top:box.top,bottom:box.bottom};
      }));
      assert.equal(boxes.length, 4);
      const stage = await page.locator('.flow-graph').boundingBox(); assert.ok(stage);
      for (const box of boxes) assert.ok(box.left >= stage.x && box.right <= stage.x + stage.width
        && box.top >= stage.y && box.bottom <= stage.y + stage.height, `vertical relation outside stage: ${JSON.stringify(box)}`);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
          `vertical relation buttons ${i} and ${j} overlap: ${JSON.stringify([a, b])}`);
      }
      for (let i = 1; i <= 4; i++) {
        const button = page.locator(`[data-flow-id="vertical-${i}"][data-flow-role="graph-edge"]`);
        assert.equal(await button.isVisible(), true);
        await button.click();
        assert.equal(await page.locator(`[data-flow-id="vertical-${i}"][data-flow-role="graph-edge"]`).getAttribute('aria-pressed'), 'true');
      }
    } finally {await page.close();}
  });
  test('closing the controller stops scheduled requests', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      const count = await page.evaluate(() => {
        const global = window as typeof window & {controller:{close:()=>void}; requestCount:number};
        global.controller.close(); return global.requestCount;
      });
      await page.waitForTimeout(5200);
      assert.equal(await page.evaluate(() => (window as typeof window & {requestCount:number}).requestCount), count);
    } finally {await page.close();}
  });
  test('older pages remain reachable and same-name incarnations are distinguishable', async () => {
    const page = await createPage(true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      await page.evaluate(() => {
        const global = window as typeof window & {snapshot: {events:Array<Record<string, unknown>>}};
        const first = global.snapshot.events[0]!;
        global.snapshot.events = Array.from({length: 100}, (_, i) => ({...first, id:`page-${i}`,
          time: Math.floor(Date.now()/1000) - 200 + i, target:{id:'peer',created:i % 2 ? 2 : 3,agent:'claude'}}));
      });
      await page.getByRole('button', {name:'flow.refresh', exact:true}).click();
      await page.getByRole('button', {name:'flow.older', exact:true}).waitFor();
      assert.equal(await page.locator('.flow-event-row').count(), 80);
      assert.equal(await page.locator('[data-flow-id="page-0"]').count(), 0);
      await page.getByRole('button', {name:'flow.older', exact:true}).click();
      assert.equal(await page.locator('.flow-event-row').count(), 20);
      assert.ok(await page.locator('[data-flow-id="page-0"]').count() > 0);
      await page.getByRole('button', {name:'flow.graph', exact:true}).click();
      const labels = await page.locator('.flow-graph-node[aria-label^="peer"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
      assert.equal(labels.length, 2); assert.notEqual(labels[0], labels[1]);
      assert.ok(labels.every(value => value?.includes('flow.started')));
      await page.getByRole('button', {name:'flow.newer', exact:true}).click();
      assert.equal(await page.locator('.flow-event-row').count(), 80);
    } finally {await page.close();}
  });
  test('captures sequence and connections on desktop and mobile with representative data', async () => {
    const page = await createPage(true, true);
    try {
      await page.locator('.flow-event-row').first().waitFor();
      const directory = process.env.MESH_FLOW_SCREENSHOTS;
      if (directory) fs.mkdirSync(directory, {recursive: true});
      const capture = async (name: string) => {
        const image = await page.screenshot();
        assert.ok(image.length > 1000, `${name} is a non-empty screenshot`);
        if (directory) fs.writeFileSync(path.join(directory, name), image);
      };
      await capture('sequence-desktop.png');
      await page.getByRole('button', {name:'Relations', exact:true}).click();
      assert.equal(await page.locator('.flow-graph-node').count(), 4);
      const contained = await page.locator('.flow-graph').evaluate(stage => {
        const bounds = stage.getBoundingClientRect();
        return [...stage.querySelectorAll('.flow-graph-edge-button')].every(button => {
          const box = button.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right;
        });
      });
      assert.equal(contained, true, 'relation controls stay within the diagram');
      await capture('relations-desktop.png');
      await page.setViewportSize({width:375,height:812});
      await capture('relations-mobile.png');
      await page.getByRole('button', {name:'Séquence', exact:true}).click();
      await capture('sequence-mobile.png');
    } finally {await page.close();}
  });
});
