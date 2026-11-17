// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import { ProjectsUiFixture } from './helpers/projects-ui.ts';
import { followupCatalog, roadmapObservation, roadmapTask, attemptObservation } from './helpers/project-followup-fixtures.ts';

test('Chrome shows elapsed assignment lifetime distinctly from forecasts and preserves Sessions', {skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false}, async () => {
  assert.ok(process.env.MESH_CHROMIUM, 'Chrome executable required');
  const fixture = new ProjectsUiFixture(path.resolve(import.meta.dirname, '..'));
  try {
    await fixture.start();
    for (const width of [1560, 390]) {
      const mobile = width === 390, { page, sockets, input } = await fixture.sessionPage(mobile);
      try {
        await page.setViewportSize({width, height:1000});
        await page.waitForTimeout(100); await page.evaluate("window.sessionViewport = active.term.buffer.active.viewportY");
        await fixture.enter(page, mobile);
        const tasks = [roadmapTask({ id:'closed', objective:'Completed assignment', state:'done', attempts:1, timeline:[attemptObservation(1,{outcome:'done'})] }),
          roadmapTask({id:'open', objective:'An open assignment includes waiting', state:'active', attempts:1, assignment:{id:'attempt-1'}, progress:{status:'unreported',sequence:0}, timeline:[attemptObservation(1,{outcome:'active',ended_at:null})] }), roadmapTask({id:'queued',objective:'No invented schedule'})];
        await fixture.mountFollowup(page, followupCatalog(roadmapObservation(tasks)));
        const work = page.locator('#standalone-followup');
        await work.locator('[data-followup-key="view-mode"]').selectOption('timeline');
        const open = work.locator('.project-gantt-bar[data-outcome="active"]');
        assert.equal(await open.textContent(), 'Open assignment · 120 min');
        assert.equal(await open.getAttribute('data-duration'), '120');
        assert.match(await open.getAttribute('title') || '', /Attempt 1/);
        assert.equal(await work.locator('.project-gantt-bar[data-outcome="done"]').textContent(), 'Recorded · 10 min');
        assert.equal(await work.locator('.project-gantt-legend span').count(), 3);
        const durations = await work.locator('.project-gantt-bar').evaluateAll(elements => elements.map(element => Number((element as HTMLElement).dataset.duration)));
        assert.deepEqual(durations, [10,120]);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await work.locator('.project-clock-gantt').evaluate(element => {element.scrollLeft=0;});
        await open.click({position:{x:8,y:8}}); assert.equal(await work.locator('[data-followup-key="row-open"]').getAttribute('aria-pressed'), 'true');
        if (process.env.MESH_PROJECT_EVIDENCE) {fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await work.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,`gantt-${width}.png`)});}
        await page.locator('#projects-return').click();await fixture.continuity(page,sockets,input);
      } finally {await page.close();}
    }
  } finally {await fixture.stop();}
});
