// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser} from 'playwright-core';
import {Lab} from './restore-exact-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
const executable = process.env.MESH_CHROMIUM ?? '';
const skip = !executable && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
let lab: Lab, browser: Browser;
before(async () => { if (!skip) { lab = await Lab.start(); browser = await chromium.launch(chromiumLaunchOptions(executable, ['--no-sandbox', '--mute-audio'])); } });
after(async () => { await browser?.close(); await lab?.stop(); });
describe('explicit restore profile binding', {skip}, () => {
  for (const width of [1400, 390]) test(`preview and explicit confirmation at ${width}px`, async () => {
    const context = await browser.newContext({locale:'en-US', viewport:{width,height:900}});
    try {
      const page = await context.newPage(); const actions: string[] = [];
      const expected = {name:'alpha',created:1,agent_kind:'codex',resume_id:'fake',cwd:'/project'};
      await page.route('**/api/accounts/profiles', route => route.fulfill({json:{data:{profiles:[{backend:'codex',id:'personal',label:'Personal',enabled:true}]}}}));
      await page.route('**/api/restore/rebind', async route => {
        if (route.request().method() === 'GET') return route.fulfill({json:{offers:[{expected,previous_account:'old'}]}});
        const body = route.request().postDataJSON(); actions.push(body.action);
        assert.deepEqual(body.expected, expected);
        if (body.action === 'confirm') { assert.equal(body.offer_digest,'offer-proof'); assert.equal(body.context_revision,'revision-proof'); }
        return route.fulfill({json:{ok:true,account:'personal',label:'Personal',config_root:'/profiles/personal',context_revision:'revision-proof',offer_digest:'offer-proof'}});
      });
      await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`); await page.goto(`${lab.mesh.base}/`);
      if (width < 700) await page.locator('#btn-menu').click();
      await page.getByRole('button',{name:'Link an old session to a profile'}).click();
      await page.getByRole('button',{name:'Review binding'}).click();
      await page.getByText('/profiles/personal',{exact:false}).waitFor();
      assert.deepEqual(actions,['preview']);
      assert.ok(await page.locator('dialog.restore-rebind').evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.getByRole('button',{name:'Confirm binding'}).click();
      await page.getByText('Profile linked. You can now choose whether to restore the session.').waitFor();
      assert.deepEqual(actions,['preview','confirm']);
    } finally { await context.close(); }
  });
  for (const status of [409, 408, 429, 500]) test(`confirmation HTTP ${status} is not retried`, async () => {
    const context = await browser.newContext({locale:'en-US', viewport:{width:1400,height:900}});
    try {
      const page = await context.newPage(); const actions: string[] = []; let reads = 0;
      const expected = {name:'alpha',created:1,agent_kind:'codex',resume_id:'fake',cwd:'/project'};
      await page.route('**/api/accounts/profiles', route => route.fulfill({json:{data:{profiles:[{backend:'codex',id:'personal',label:'Personal',enabled:true}]}}}));
      await page.route('**/api/restore/rebind', async route => {
        if (route.request().method() === 'GET') { reads++; return route.fulfill({json:{offers:[{expected,previous_account:'old'}]}}); }
        const body = route.request().postDataJSON(); actions.push(body.action);
        if (body.action === 'confirm') return route.fulfill({status,json:{ok:false}});
        return route.fulfill({json:{ok:true,account:'personal',label:'Personal',config_root:'/profiles/personal',context_revision:'revision-proof',offer_digest:'offer-proof'}});
      });
      await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`); await page.goto(`${lab.mesh.base}/`);
      await page.getByRole('button',{name:'Link an old session to a profile'}).click();
      await page.getByRole('button',{name:'Review binding'}).click();
      await page.getByRole('button',{name:'Confirm binding'}).click();
      await page.getByText(status === 409 ? 'The offer or profile changed, or the request was refused. Close and review it again.' : 'The result is unknown. Close and refresh before trying again; the request was not repeated.').waitFor();
      assert.equal(await page.getByRole('button',{name:'Confirm binding'}).count(),0);
      assert.deepEqual(actions,['preview','confirm']);
      assert.equal(reads, status === 409 ? 1 : 2, 'uncertain results are refreshed before another preview');
      await page.getByRole('button',{name:'Review binding'}).waitFor({state:'visible'});
      await page.getByRole('button',{name:'Review binding'}).click();
      assert.deepEqual(actions,['preview','confirm','preview']);
    } finally { await context.close(); }
  });

  test('uncertain confirmation with failed reload never offers a blind retry', async () => {
    const context = await browser.newContext({locale:'en-US', viewport:{width:1400,height:900}});
    try {
      const page = await context.newPage(); const actions: string[] = []; let reads = 0;
      const expected = {name:'alpha',created:1,agent_kind:'codex',resume_id:'fake',cwd:'/project'};
      await page.route('**/api/accounts/profiles', route => route.fulfill({json:{data:{profiles:[{backend:'codex',id:'personal',label:'Personal',enabled:true},{backend:'codex',id:'work',label:'Work',enabled:true}]}}}));
      await page.route('**/api/restore/rebind', async route => {
        if (route.request().method() === 'GET') return ++reads === 1 ? route.fulfill({json:{offers:[{expected,previous_account:'old'},{expected:{...expected,name:'bravo'},previous_account:'other'}]}}) : route.fulfill({status:503});
        const body = route.request().postDataJSON(); actions.push(body.action);
        if (body.action === 'confirm') return route.abort();
        return route.fulfill({json:{ok:true,account:'personal',label:'Personal',config_root:'/profiles/personal',context_revision:'revision-proof',offer_digest:'offer-proof'}});
      });
      await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`); await page.goto(`${lab.mesh.base}/`);
      await page.getByRole('button',{name:'Link an old session to a profile'}).click();
      await page.getByRole('button',{name:'Review binding'}).click();
      await page.getByRole('button',{name:'Confirm binding'}).click();
      await page.getByText('The result is unknown. Close and refresh before trying again; the request was not repeated.').waitFor();
      assert.equal(reads, 2); assert.deepEqual(actions,['preview','confirm']);
      assert.equal(await page.getByRole('button',{name:'Review binding'}).count(), 0);
      assert.equal(await page.getByRole('button',{name:'Confirm binding'}).count(), 0);
      const selects = page.locator('dialog.restore-rebind select');
      await selects.nth(0).selectOption('1');
      await selects.nth(1).selectOption('work');
      assert.equal(await page.getByRole('button',{name:'Review binding'}).count(), 0);
      await page.locator('dialog.restore-rebind button').filter({hasText:'Review binding'}).dispatchEvent('click');
      assert.deepEqual(actions,['preview','confirm'], 'selection and synthetic click cannot replay or preview stale offers');
      assert.equal(reads, 2);
    } finally { await context.close(); }
  });

});
