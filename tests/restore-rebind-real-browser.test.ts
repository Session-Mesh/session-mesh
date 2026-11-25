// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {chromium, type Browser} from 'playwright-core';
import {Lab, SID} from './restore-exact-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
const executable = process.env.MESH_CHROMIUM ?? '';
const skip = !executable && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
let browser: Browser;
before(async () => { if (!skip) browser = await chromium.launch(chromiumLaunchOptions(executable, ['--no-sandbox', '--mute-audio'])); });
after(async () => { await browser?.close(); });
describe('real restore profile binding', {skip}, () => {
  for (const {width, stale} of [{width:1400,stale:false},{width:390,stale:false},{width:1400,stale:true}]) test(`real backend at ${width}px, stale=${stale}`, async () => {
    const lab = await Lab.start({alphaExtra:{account:'old'},
      env: {MESH_MESH_PROFILE_CMD: process.env.MESH_PROFILE_CMD || process.env.MESH_MESH_PROFILE_CMD}, prepare: (home, confDir) => {
      const config = path.join(home, 'profiles', 'work', 'claude');
      const history = path.join(home, 'profiles', 'work', 'history');
      fs.mkdirSync(config, {recursive:true, mode:0o700}); fs.mkdirSync(history, {recursive:true, mode:0o700});
      // A synthetic transcript only; never read a real account.
      const directory = path.join(config,'projects','project'); fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,`${SID}.jsonl`),'{}\n');
      fs.writeFileSync(path.join(confDir,'backend-profiles.json'),JSON.stringify({version:1,profiles:[
        {backend:'claude',id:'work',label:'Work',enabled:true,roots:{config,history}}]}),{mode:0o600});
    }});
    const context = await browser.newContext({locale:'en-US',viewport:{width,height:900}});
    try {
      const page = await context.newPage();
      const actions: string[] = [];
      page.on('request', request => {if (request.url().endsWith('/api/restore/rebind') && request.method()==='POST') actions.push(request.postDataJSON().action);});
      await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`); await page.goto(`${lab.mesh.base}/`);
      if (width < 700) await page.locator('#btn-menu').click();
      await page.getByRole('button',{name:'Link an old session to a profile'}).click();
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/restore/rebind') && response.request().method() === 'POST'),
        page.getByRole('button',{name:'Review binding'}).click({timeout:5000}),
      ]); assert.equal(response.status(),200,await response.text());
      await page.getByText('Work (work)',{exact:false}).waitFor({timeout:5000});
      assert.equal(lab.snapshotLost().find(item=>item.name==='alpha')?.account,'old');
      assert.equal(lab.starts(),0);
      if (stale) {
        const registry = path.join(lab.mesh.confDir,'backend-profiles.json');
        const contents = JSON.parse(fs.readFileSync(registry,'utf8'));
        const otherHistory = path.join(lab.mesh.home,'profiles','work','other-history'); fs.mkdirSync(otherHistory,{mode:0o700});
        contents.profiles[0].roots.history = otherHistory;
        fs.writeFileSync(registry,JSON.stringify(contents),{mode:0o600});
      }
      await page.getByRole('button',{name:'Confirm binding'}).click();
      if (stale) {
        await page.getByText('The offer or profile changed, or the request was refused. Close and review it again.').waitFor({timeout:5000});
        assert.equal(lab.snapshotLost().find(item=>item.name==='alpha')?.account,'old');
        assert.deepEqual(actions,['preview','confirm']); assert.equal(lab.starts(),0);
        return;
      }
      await page.getByText('Profile linked. You can now choose whether to restore the session.').waitFor();
      const bound = lab.snapshotLost().find(item=>item.name==='alpha');
      assert.equal(bound?.account,'work'); assert.match(bound?.account_context_revision,/^[0-9a-f]{64}$/);
      assert.deepEqual(actions,['preview','confirm']); assert.equal(lab.starts(),0);
      assert.deepEqual(await lab.listed(),[]);
    } finally { await context.close(); await lab.stop(); }
  });
});
