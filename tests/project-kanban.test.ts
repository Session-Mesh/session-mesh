// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rosterWorkCard } from '../static/project-work-card.ts';
import { roadmapRows } from '../static/project-followup-model.ts';
import { FollowupPreferenceStore } from '../static/project-followup-preferences.ts';
import { followupCatalog, roadmapObservation, roadmapTask } from './helpers/project-followup-fixtures.ts';
import { ProjectsUiFixture } from './helpers/projects-ui.ts';
const root = path.resolve(import.meta.dirname, '..');
const tasks = () => ['queued', 'active', 'blocked', 'done'].map((state, index) => roadmapTask({ id: `task-${index}`, state,
  objective: index === 0 ? '<img src=x onerror=alert(1)> Same title 😀' : 'Same title', depends_on: index ? ['task-0'] : [] }));
test('Kanban retains distinct source identities, state uncertainty and preferences', () => {
  const catalog = followupCatalog(roadmapObservation(tasks())), summary = catalog.projects[0]!.sources[0]!.summary!;
  const rows = roadmapRows(summary), cards = rows.map(row => rosterWorkCard(row, 'machine/project/board'));
  assert.deepEqual(cards.map(card => card.column), ['todo', 'doing', 'blocked', 'done']);
  assert.equal(new Set(cards.map(card => card.key)).size, 4);
  assert.notEqual(cards[0]!.key, rosterWorkCard(rows[0]!, 'different-board').key);
  assert.equal(rosterWorkCard({ ...rows[0]!, state: 'new-provider-state' }, 'board').column, 'unknown');
  assert.deepEqual(cards[1]!.assignees, [], 'worker progress is not an inferred assignment');
  assert.equal(cards[3]!.meaning, 'source-done-unqualified', 'a done state is not an invented acceptance');
  const store = new FollowupPreferenceStore('test'); const preferences = store.read('scope'); preferences.mode = 'kanban';
  store.write('scope', preferences); assert.equal(store.read('scope').mode, 'kanban');
});
test('Kanban in Chrome: readable desktop/phone cards, safe titles, selection and Sessions continuity',
  { skip: !process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not configured' : false }, async () => {
    assert.ok(process.env.MESH_CHROMIUM); const fixture = new ProjectsUiFixture(root);
    try {
      await fixture.start();
      for (const width of [320, 390, 1560]) {
        const mobile = width < 850, { page, sockets, input } = await fixture.sessionPage(mobile);
        try {
          await page.setViewportSize({ width, height: 960 });
          await page.waitForTimeout(100); await page.evaluate('window.sessionViewport = active.term.buffer.active.viewportY');
          await page.route('**/api/view', route => route.fulfill({ json: { url: '/view/v2.f.authored/catalog.json' } }));
          await page.route('**/view/v2.f.authored/catalog.json', route => route.fulfill({ json: followupCatalog(roadmapObservation(tasks())) }));
          await fixture.enter(page, mobile); await page.locator('#projects-path').fill('/catalog.json'); await page.locator('.projects-load button').click();
          await page.locator('[data-followup-key="view-mode"]').selectOption('kanban');
          assert.equal(await page.locator('.project-kanban-lane').count(), 4);
          assert.equal(await page.locator('.project-work-card').count(), 4);
          assert.equal(await page.locator('.project-work-card img').count(), 0);
          assert.match(await page.locator('.project-work-title').first().textContent() ?? '', /<img/);
          const widths = await page.locator('.project-work-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().width));
          assert.ok(widths.every(value => value >= 190), `${width}: card widths ${widths}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const selected = page.locator('[data-followup-key="row-task-1"]'); await selected.focus(); await page.keyboard.press('Enter');
          assert.equal(await selected.getAttribute('aria-pressed'), 'true');
          await page.locator('[data-followup-key="view-mode"]').selectOption('summary');
          await page.locator('[data-followup-key="view-mode"]').selectOption('kanban');
          assert.equal(await selected.getAttribute('aria-pressed'), 'true', 'selection survives mode changes');
          const board = page.locator('.project-kanban'); await board.scrollIntoViewIfNeeded();
          await board.evaluate(element => { element.scrollLeft = 0; });
          const box = (await board.boundingBox())!, x = box.x + box.width - 15, y = box.y + 20;
          if (mobile) {
            const touch = await page.context().newCDPSession(page);
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y }] });
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 210, y }] });
            await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
          } else {
            await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 210, y, { steps: 6 }); await page.mouse.up();
          }
          assert.ok(await board.evaluate(element => element.scrollLeft > 50), 'actual pointer/touch gesture scrolls the board locally');
          await board.focus(); await board.evaluate(element => { element.scrollLeft = 0; }); await page.keyboard.press('ArrowRight');
          await page.waitForFunction(() => document.querySelector('.project-kanban')!.scrollLeft > 10);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          if (process.env.MESH_PROJECT_EVIDENCE) {
            fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE, { recursive: true });
            await page.locator('.project-kanban').evaluate(element => { element.scrollLeft = 0; });
            await page.screenshot({ path: path.join(process.env.MESH_PROJECT_EVIDENCE, `kanban-${width}.png`) });
          }
          await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
        } finally { await page.close(); }
      }
    } finally { await fixture.stop(); }
  });
