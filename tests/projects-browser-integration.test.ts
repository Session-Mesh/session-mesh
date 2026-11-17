// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { ProjectsUiFixture } from './helpers/projects-ui.ts';
const skip = !process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const boot = 'a'.repeat(64), revision = `cfg1_${'b'.repeat(64)}`;
async function nativeFixture(page: Page) {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/projects/v1', async route => {
    const value = route.request().postDataJSON(); requests.push(value);
    const base = { kind: 'mesh-project-reply', version: 1, op: value.op, boot, status: 'ok', revision, machine_id: 'host' };
    const project = { id: 'one', title: 'One', folders_total: 0, sources_total: 1, sessions_total: 0, participations_total: 0,
      repository: { url: 'https://example.com/repo' }, sources: [{ id: 'roadmap', kind: 'roster', label: 'Board' }] };
    if (value.op === 'project_list') return route.fulfill({ json: { ...base, projects: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], complete: true, total: 2 } });
    if (value.op === 'project_read') {
      let observation_settings;
      if (value.settings?.kind === 'project') observation_settings = { kind: 'project', plan: { repository: false, source_ids: ['roadmap'] },
        repository: { url: 'https://example.com/repo', local_path: '/saved\npath', primary_ref: 'refs/heads/main' },
        source_summaries: [{ id: 'roadmap', kind: 'roster', label: 'Board', selector_configured: true }] };
      if (value.settings?.kind === 'source') observation_settings = { kind: 'source', source: { id: 'roadmap', kind: 'roster', label: 'Board', selector: { kind: 'board', path: '/board\nfile.json' } } };
      return route.fulfill({ json: { ...base, project: { ...project, id: value.project_id, title: value.project_id === 'two' ? 'Two' : 'One' }, ...(observation_settings ? { observation_settings } : {}) } });
    }
    if (value.op === 'project_settings') return route.fulfill({ json: { ...base, status: 'conflict', code: 'revision-conflict' } });
    return route.fulfill({ json: base });
  });
  return requests;
}
describe('integrated Projects typed settings and intentional edge navigation', { skip }, () => {
  const fixture = new ProjectsUiFixture(path.resolve(import.meta.dirname, '..'));
  before(() => fixture.start()); after(() => fixture.stop());
  test('lazy source projection preserves raw DOM-unrepresentable locators on unrelated edit and conflict draft', async () => {
    const { page, input, sockets } = await fixture.sessionPage();
    try {
      const requests = await nativeFixture(page); await fixture.enter(page);
      await page.locator('#project-overview h2').filter({ hasText: 'One' }).waitFor();
      await page.getByRole('button', { name: 'Project settings', exact: true }).click();
      await page.getByRole('button', { name: 'Configure Board', exact: true }).click();
      await page.getByLabel('Local board file or pipeline root', { exact: true }).waitFor();
      await page.getByLabel('Project name', { exact: true }).fill('Renamed');
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('dialog[open] [role=status]')?.textContent?.includes('changed'));
      const mutation = requests.find(value => value.op === 'project_settings'); assert.ok(mutation);
      assert.deepEqual(mutation.patch, { title: 'Renamed' });
      assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Renamed');
      assert.equal(requests.filter(value => value.op === 'project_read' && (value.settings as { kind?: string })?.kind === 'source').length, 1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('#projects-return').click(); await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
  test('edge intents switch only list/mode while excluded controls and clean taps retain access', async () => {
    const { page, input, sockets } = await fixture.sessionPage(true);
    try {
      await nativeFixture(page);
      const swipe = async (from: number, to: number, dy = 0, selector = '#main') => page.evaluate(({ from, to, dy, selector }) => {
        const target = document.querySelector(selector)!;
        target.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 71, pointerType: 'touch', isPrimary: true, button: 0, clientX: from, clientY: 240, bubbles: true }));
        target.dispatchEvent(new PointerEvent('pointermove', { pointerId: 71, pointerType: 'touch', isPrimary: true, clientX: to, clientY: 240 + dy, bubbles: true, cancelable: true }));
        target.dispatchEvent(new PointerEvent('pointerup', { pointerId: 71, pointerType: 'touch', isPrimary: true, clientX: to, clientY: 240 + dy, bubbles: true }));
      }, { from, to, dy, selector });
      await swipe(388, 320); await page.waitForFunction(() => document.body.classList.contains('projecting') && document.body.classList.contains('drawer'));
      await page.getByRole('button', { name: 'Two', exact: true }).click();
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false);
      await swipe(1, 80, 40); assert.equal(await page.evaluate(() => document.body.classList.contains('projecting')), true);
      await swipe(1, 80); assert.equal(await page.evaluate(() => document.body.classList.contains('projecting')), false);
      await swipe(388, 320); assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false);
      await page.locator('#btn-menu').click(); assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), true);
      await page.locator('#btn-sessions').click();
      await page.evaluate(() => document.body.classList.remove('drawer'));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 388, y: 240 }] });
      for (const x of [378, 368, 358, 348, 338, 328, 318]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 240 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      assert.equal(await page.evaluate(() => document.body.classList.contains('projecting') && document.body.classList.contains('drawer')), true, 'incremental actual touch must survive browser pointer cancellation before horizontal navigation intent');
      await page.locator('#btn-sessions').click(); await fixture.continuity(page, sockets, input);
    } finally { await page.close(); }
  });
});
