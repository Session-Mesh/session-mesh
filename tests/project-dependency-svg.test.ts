// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import { ProjectsUiFixture } from './helpers/projects-ui.ts';
import { followupCatalog, roadmapObservation, roadmapTask } from './helpers/project-followup-fixtures.ts';
import type { Page } from 'playwright-core';
const root = path.resolve(import.meta.dirname, '..');
async function load(page: Page, catalog: unknown, fixture: ProjectsUiFixture, mobile: boolean) {
  await page.route('**/api/view', route => route.fulfill({ json: { url: '/view/v2.f.authored/catalog.json' } }));
  await page.route('**/view/v2.f.authored/catalog.json', route => route.fulfill({ json: catalog }));
  await fixture.enter(page, mobile); await page.locator('#projects-path').fill('/catalog.json'); await page.locator('.projects-load button').click();
  await page.locator('.project-followup').waitFor();
}
async function dependencyViewport(fixture: ProjectsUiFixture, width: number, language: string) {
  const mobile = width < 850, { page, sockets, input } = await fixture.sessionPage(mobile);
  try {
    await page.setViewportSize({ width, height: 960 });
    await page.waitForTimeout(100); await page.evaluate('window.sessionViewport = active.term.buffer.active.viewportY');
    await page.evaluate(async code => { await (window as any).MeshI18n.use(code); }, language);
    const tasks = [roadmapTask({ id: 'prepare', objective: 'Prepare source inputs', state: 'done' }),
      roadmapTask({ id: 'build', objective: 'Implement dependency renderer', state: 'active', depends_on: ['prepare'] }),
      roadmapTask({ id: 'review', objective: 'Review arrows and recorded states', depends_on: ['build'] }),
      roadmapTask({ id: 'unknown', objective: 'a'.repeat(68) + '😀tail', state: 'blocked', depends_on: ['absent'] })];
    await load(page, followupCatalog(roadmapObservation(tasks)), fixture, mobile);
    await page.locator('[data-followup-key="view-mode"]').selectOption('dependencies');
    const chart = page.locator('.project-dependency-chart');
    assert.equal(await page.locator('.project-followup-chart').count(), 1, 'one mode scroll owner');
    assert.equal(await page.locator('.project-dependency-node').count(), tasks.length);
    assert.ok(await page.locator('.project-dependency-node tspan').evaluateAll(spans => spans.every(span => Array.from(span.textContent || '').every(character => character.length > 1 || character.charCodeAt(0) < 0xD800 || character.charCodeAt(0) > 0xDFFF))), 'truncated labels retain complete Unicode characters');
    assert.equal(await page.locator('.project-dependency-edges path').count(), 2);
    const ports = await page.locator('.project-dependency-edges path').evaluateAll(edges => edges.map(edge => {
      const line = edge as SVGPathElement;
      const from = document.querySelector<SVGRectElement>(`[data-task-id="${(edge as SVGElement).dataset.from}"] rect`)!.getBBox();
      const to = document.querySelector<SVGRectElement>(`[data-task-id="${(edge as SVGElement).dataset.to}"] rect`)!.getBBox();
      const start = line.getPointAtLength(0), end = line.getPointAtLength(line.getTotalLength());
      return Math.abs(start.x - from.x - from.width) < 1 && Math.abs(end.x - to.x) < 1 && !!line.getAttribute('marker-end');
    }));
    assert.ok(ports.every(Boolean), 'arrows connect actual SVG node ports');
    const fit = await chart.evaluate(element => ({ width: element.clientWidth, nodes: [...element.querySelectorAll<SVGRectElement>('.project-dependency-node rect')].map(rect => rect.getBBox().width) }));
    assert.ok(fit.nodes.every(nodeWidth => nodeWidth + 24 <= fit.width), `each readable node fits the chart width: ${JSON.stringify({ language, width, fit })}`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${language}/${width} page overflow`);
    const list = await page.locator('.project-dependency-list').boundingBox(), graph = await page.locator('.project-dependency-panel').boundingBox();
    assert.ok(graph!.y < list!.y || graph!.x >= list!.x + list!.width, 'graph is above the list or beside it, according to available content width');
    await chart.focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.followupKey), 'node-prepare');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-followup-key="row-prepare"]').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.followupKey), 'chart');
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!, x = box.x + box.width - 20, y = box.y + 12;
    if (mobile) {
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 70, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 140, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
    } else {
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 140, y, { steps: 8 }); await page.mouse.up();
    }
    assert.ok(await chart.evaluate(element => element.scrollLeft > 50), 'actual pointer pan moves local graph');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await chart.evaluate(element => { element.scrollLeft = 0; });
    if (process.env.MESH_PROJECT_EVIDENCE) {
      const directory = path.join(process.env.MESH_PROJECT_EVIDENCE, 'dependency-svg'); fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `${language}-${width}.png`) });
    }
    await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
  } finally { await page.close(); }
}
test('SVG dependencies in Chrome: desktop and phone, EN and FR, arrows and session continuity', {skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false}, async () => {
  assert.ok(process.env.MESH_CHROMIUM, 'An explicit Chrome executable is required');
  const fixture = new ProjectsUiFixture(root);
  try {
    await fixture.start();
    for (const language of ['en', 'fr']) for (const width of [320, 390, 1024, 1560]) await dependencyViewport(fixture, width, language);
  } finally { await fixture.stop(); }
});
