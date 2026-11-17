// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { followupCatalog } from './helpers/project-followup-fixtures.ts';

const chromiumPath = process.env.MESH_CHROMIUM ?? '';
for (const width of [1280, 390]) test(`unsupported collection stays honest and recovers in a new scope at ${width}px`,
  { skip: !chromiumPath ? 'MESH_CHROMIUM not set' : false }, async () => {
    const code = buildSync({ stdin: { contents: `export { mountProjectWorkspace } from './static/project-workspace.ts';`,
      resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'iife', globalName: 'WorkspaceTest', write: false }).outputFiles[0]!.text;
    const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<main id="root"></main><nav id="sidebar"></nav><button id="sessions">Sessions</button>'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox', '--mute-audio', '--disable-gpu'] });
    try {
      const page = await browser.newPage({ viewport: {width, height: 900} }); page.setDefaultTimeout(5000);
      await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
      await page.addStyleTag({content:fs.readFileSync(new URL('../static/style.css',import.meta.url),'utf8')});
      await page.addScriptTag({content: code});
      const catalog = followupCatalog(); catalog.features.push('project-metadata/1');
      const bytes = Buffer.from(JSON.stringify(catalog));
      await page.evaluate(({data, digest, length, labels}) => {
        const boot = 'a'.repeat(64), revision = `cfg1_${'b'.repeat(64)}`;
        const fixture = { paused: true, onlyOther: false, calls: [] as Record<string, string>[], machine: 'host', refusal: null as null | {status:number;body:string}, workspace: null as any };
        const request = async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(init?.body as string); fixture.calls.push(body);
          if (body.op === 'project_observation_start' && fixture.paused)
            // The actual paused aiohttp handler returns this exact plaintext HTTP400.
            return fixture.refusal ? new Response(fixture.refusal.body, {status:fixture.refusal.status}) : new Response('Unsupported project operation', {status: 400});
          const base = {kind:'mesh-project-reply', version:1, op:body.op, boot, revision, machine_id:fixture.machine, status:'ok'};
          const project = {id: body.project_id ?? 'one', title:'Delivery', folders_total:0, sources_total:1, sessions_total:0, participations_total:0};
          if (body.op === 'project_capabilities') return Response.json(base);
          if (body.op === 'project_list') return Response.json({...base,
            projects:fixture.onlyOther ? [{id:'two',title:'Other'}] : [{id:'one',title:'Delivery'},{id:'two',title:'Other'}],
            complete:true,total:fixture.onlyOther ? 1 : 2});
          if (body.op === 'project_read') return Response.json({...base,project,
            ...(body.settings ? {observation_settings:{kind:'project',plan:{repository:false,source_ids:['roadmap']},repository:null,source_summaries:[]}} : {})});
          const descriptor = {observation_id:'c'.repeat(64),boot,machine_id:fixture.machine,project_id:body.project_id,captured_revision:revision,
            byte_length:length,page_count:1,raw_page_bytes:131072,sha256:digest,captured_at:'2026-11-15T12:00:00Z',published_at:'2026-11-15T12:00:01Z'};
          return Response.json({kind:base.kind,version:1,op:body.op,boot,status:'ok',request_id:body.request_id,observation_id:'c'.repeat(64),requested_scope:{machine_id:fixture.machine,project_id:body.project_id,revision},
            observation_state:'complete',identity_retention_ms:120000,remaining_ms:120000,descriptor,
            ...(body.op === 'project_observation_start' ? {cancel_token:'d'.repeat(64),replayed:false} : {page_index:body.page_index,data_base64:data})});
        };
        const workspace = window.WorkspaceTest.mountProjectWorkspace({root:document.querySelector('#root'),sidebar:document.querySelector('#sidebar'),request,
          translate:(key: string) => labels[key] ?? key, availability:() => {},mountArtifact:() => ({open(){},close(){}})});
        fixture.workspace = workspace; window.collectionFixture = fixture;
        document.querySelector('#sessions').addEventListener('click', () => {workspace.close(); document.body.dataset.sessions = 'open';});
        workspace.open();
      }, {data:bytes.toString('base64'),digest:createHash('sha256').update(bytes).digest('hex'),length:bytes.length,
        labels:JSON.parse(fs.readFileSync(new URL('../static/i18n/en.json',import.meta.url),'utf8'))});
      const starts = () => page.evaluate(() => window.collectionFixture.calls.filter(x => x.op === 'project_observation_start').length);
      const empty = 'Collection is unavailable on this server. No observation snapshot is displayed. Reopen Projects after collection becomes available.';
      await page.getByText(empty, {exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Refresh project context',exact:true}).isDisabled(),true);
      assert.ok(!(await page.locator('#root').textContent())!.includes('sources are loading'));
      if (process.env.MESH_PROJECT_EVIDENCE) { fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true}); await page.screenshot({path:`${process.env.MESH_PROJECT_EVIDENCE}/collection-empty-${width}.png`,fullPage:true}); }
      await page.clock.install(); await page.clock.fastForward(600000);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.equal(await starts(),1);
      await page.getByRole('button',{name:'Other',exact:true}).click();
      await page.waitForFunction(() => window.collectionFixture.calls.filter(x => x.op === 'project_observation_start').length === 2);
      await page.clock.fastForward(600000); assert.equal(await starts(),2);
      await page.clock.resume();
      await page.evaluate(() => { window.collectionFixture.paused = false; window.collectionFixture.workspace.close(); window.collectionFixture.workspace.open(); });
      await page.locator('#sidebar').getByRole('button',{name:'Delivery',exact:true}).click();
      await page.locator('.cockpit-source-title').waitFor();
      assert.equal(await page.getByRole('button',{name:'Refresh project context',exact:true}).isEnabled(),true);
      await page.evaluate(() => {window.collectionFixture.paused = true;});
      await page.getByRole('button',{name:'Refresh project context',exact:true}).click();
      await page.getByText('Collection is unavailable on this server. The displayed snapshot is retained and stale. Reopen Projects after collection becomes available.',{exact:true}).waitFor();
      assert.equal(await page.locator('.cockpit-source-title').count(),1);
      const count = await starts(); await page.clock.fastForward(600000); assert.equal(await starts(),count);
      assert.equal(await page.evaluate(() => window.collectionFixture.calls.some(x => x.op === 'project_observation_cancel')),false);
      await page.getByRole('button',{name:'Project settings',exact:true}).click(); assert.equal(await page.locator('dialog[open]').count(),1);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true);
      if (process.env.MESH_PROJECT_EVIDENCE) { fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true}); await page.screenshot({path:`${process.env.MESH_PROJECT_EVIDENCE}/collection-unavailable-${width}.png`,fullPage:true}); }
      await page.locator('#sessions').click(); assert.equal(await page.locator('body').getAttribute('data-sessions'),'open');
      await page.evaluate(() => {window.collectionFixture.machine = 'other-host'; window.collectionFixture.workspace.open();});
      await page.getByText(empty,{exact:true}).waitFor();
      assert.equal(await page.locator('.cockpit-source-title').count(),0);
      // A registry refresh can choose another project without a sidebar click:
      // the old selected project was removed by a different client.
      await page.evaluate(() => {
        const fixture = window.collectionFixture; fixture.machine = 'host'; fixture.paused = false;
        fixture.workspace.close(); fixture.workspace.open();
      });
      await page.locator('.cockpit-source-title').waitFor();
      await page.evaluate(() => {
        const fixture = window.collectionFixture; fixture.paused = true; fixture.onlyOther = true;
        fixture.workspace.open();
      });
      await page.waitForFunction(() => document.querySelector('#root')?.textContent?.includes('Collection is unavailable'));
      assert.ok((await page.locator('#root').textContent())!.includes(empty), 'another project cannot claim the removed project snapshot is retained');
      assert.equal(await page.locator('.cockpit-source-title').count(),0);
      await page.getByRole('button',{name:'Work',exact:true}).click();
      assert.equal(await page.locator('.project-followup').count(),0, 'removed project work is cleared, not merely hidden');
      for (const refusal of [{status:401,body:'denied'}, {status:403,body:'denied'},
        {status:500,body:'{"error":"Unsupported project operation"}'}, {status:400,body:'{'}]) {
        await page.evaluate(value => {
          const fixture = window.collectionFixture; fixture.refusal = value;
          fixture.workspace.close(); fixture.calls = []; fixture.workspace.open();
        }, refusal);
        await page.waitForFunction(() => window.collectionFixture.calls.some(x => x.op === 'project_observation_start'));
        assert.equal(await page.getByRole('button',{name:'Refresh project context',exact:true}).isEnabled(),true);
        await page.clock.fastForward(60001);
        await page.waitForFunction(() => window.collectionFixture.calls.filter(x => x.op === 'project_observation_start').length === 2);
        const requests = await page.evaluate(() => window.collectionFixture.calls.filter(x => x.op === 'project_observation_start'));
        assert.equal(requests[0]!.request_id,requests[1]!.request_id,'ambiguous start retries keep the same admission identity');
      }
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
