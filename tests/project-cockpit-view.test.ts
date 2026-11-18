// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { followupCatalog, roadmapObservation, roadmapTask } from './helpers/project-followup-fixtures.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const chromiumPath = process.env.MESH_CHROMIUM ?? '';
test('cockpit task navigation crosses pages and remembered modes; config revision removes old observations',
  { skip: !chromiumPath && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false }, async () => {
    const code = buildSync({ absWorkingDir: new URL('..', import.meta.url).pathname,
      stdin: { contents: `export { ProjectCockpitView } from './static/project-cockpit-view.ts';
        export { ProjectCatalogView, ProjectDom } from './static/project-catalog-view.ts';`, resolveDir: new URL('..', import.meta.url).pathname },
      bundle: true, format: 'iife', globalName: 'CockpitTest', write: false }).outputFiles[0]!.text;
    const catalog = followupCatalog(roadmapObservation(Array.from({ length: 61 }, (_, i) =>
      roadmapTask({ id: 'task-' + i, objective: 'Task ' + i, state: i < 50 ? 'done' : 'queued' }))));
    const browser = await chromium.launch(chromiumLaunchOptions(chromiumPath, ['--no-sandbox', '--mute-audio']));
    try {
      const page = await browser.newPage();
      await page.setContent('<main id="root"><section id="host"><header><h2>Project</h2></header></section><section id="observation"><article class="projects-detail"></article></section><section id="context"></section><section id="legacy"></section></main>');
      await page.addScriptTag({ content: code });
      await page.evaluate(value => {
        const { ProjectCatalogView, ProjectDom, ProjectCockpitView } = window.CockpitTest;
        const root = document.querySelector('#root'), host = document.querySelector('#host'), observation = document.querySelector('#observation');
        const view = new ProjectCatalogView(new ProjectDom(document, key => key), document.createElement('p'), document.createElement('nav'), observation.querySelector('article'), undefined, true);
        view.render(value);
        const cockpit = new ProjectCockpitView(root, observation, document.querySelector('#context'), document.querySelector('#legacy'), key => key, (source, task) => view.selectTask(source, task));
        cockpit.mount(host, { id: 'one', title: 'Project' }, 'host', 'config-one'); cockpit.observed(value);
        window.cockpitFixture = { cockpit, host };
      }, catalog);
      assert.equal(await page.locator('.cockpit-work-row small').first().textContent(), 'task-50');
      await page.locator('.cockpit-work-row').first().click();
      assert.equal(await page.locator('[data-followup-key="row-task-50"]').getAttribute('aria-pressed'), 'true');
      await page.locator('[data-followup-key="view-mode"]').selectOption('timeline');
      await page.locator('[data-cockpit-tab="overview"]').click();
      await page.locator('.cockpit-work-row').nth(1).click();
      assert.equal(await page.locator('[data-followup-key="row-task-51"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-followup-key="view-mode"]').inputValue(), 'timeline');
      await page.locator('[data-cockpit-tab="overview"]').click();
      await page.evaluate(() => {
        const { cockpit, host } = window.cockpitFixture;
        host.replaceChildren(document.createElement('header'));
        cockpit.mount(host, { id: 'one', title: 'Context removed', sources: [] }, 'host', 'config-two');
      });
      assert.equal(await page.locator('.cockpit-work-row').count(), 0, 'same project with changed settings cannot retain removed source data');
      assert.equal(await page.locator('.cockpit-source-title').count(), 0);
      await page.locator('[data-cockpit-tab="work"]').click();
      assert.equal(await page.locator('.project-followup').isVisible(), false, 'old underlying Work controller is not exposed after config changes');
      await page.evaluate(() => {
        const oldRepository = document.createElement('section'); oldRepository.dataset.cockpitSection = 'repository'; oldRepository.textContent = 'Old repository';
        document.querySelector('.projects-detail').append(oldRepository);
      });
      await page.locator('[data-cockpit-tab="repository"]').click();
      assert.equal(await page.getByText('Old repository', { exact: true }).isVisible(), false);
    } finally { await browser.close(); }
  });
