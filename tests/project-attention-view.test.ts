// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {followupCatalog} from './helpers/project-followup-fixtures.ts';
const root=path.resolve(import.meta.dirname,'..');
test('Chrome overview requests: explicit open states, scoped identities, unavailable sources and bounded readable cards',
 {timeout:30000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
  const code=await build({stdin:{contents:"export {ProjectCockpitView} from './static/project-cockpit-view.ts';",resolveDir:root},bundle:true,platform:'browser',format:'iife',globalName:'AttentionTest',write:false});
  const browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--mute-audio','--no-sandbox']});
  try{for(const width of [1560,390]){
    const page=await browser.newPage({viewport:{width,height:1000}});
    try{
      await page.setContent('<main id="root"><section id="host"><header><h2>Project</h2></header></section><section id="observation"></section><section id="context"></section><section id="legacy"></section></main>');
      await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addScriptTag({content:code.outputFiles[0]!.text});
      const catalog=followupCatalog(),project=catalog.projects[0]!,source=project.sources[0]!;
      source.label='Current roadmap';source.summary!.operator_status='valid';source.summary!.operator_requests=[{id:'decision',title:'Choose the next delivery milestone — <img src=x onerror=alert(1)> '+ 'Detailed request text. '.repeat(20),state:'open'},{id:'closed',title:'Already answered request',state:'answered'}];source.summary!.counts.operator_open=1;
      project.sources.push({...source,id:'second',label:'Current roadmap',summary:{...source.summary!,operator_requests:[{id:'decision',title:'Same identifier, separate roadmap request',state:'open'}]}});
      project.sources.push({...source,id:'broken',label:'Unreadable roadmap',summary:{...source.summary!,operator_status:'invalid'}});
      const translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
      await page.evaluate(({catalog,translations})=>{
        const t=(key:string,values:Record<string,string|number>={})=>String(translations[key]??key).replace(/\{(\w+)\}/g,(_:string,name:string)=>String(values[name]??''));
        const q=(id:string)=>document.getElementById(id)!;
        const cockpit=new (window as any).AttentionTest.ProjectCockpitView(q('root'),q('observation'),q('context'),q('legacy'),t,()=>false);
        cockpit.mount(q('host'),{id:'one',title:'Delivery'},'host','config');cockpit.observed(catalog);(window as any).attention={cockpit,catalog};
      },{catalog,translations});
      const panel=page.locator('.cockpit-attention');assert.equal(await panel.count(),1);assert.equal(await panel.locator('details').count(),2);
      assert.match(await panel.locator('details').nth(1).textContent()??'',/second \/ decision/);
      assert.match(await panel.textContent()??'',/Unreadable roadmap/);assert.doesNotMatch(await panel.textContent()??'',/Already answered request/);
      assert.equal(await panel.locator('img,script').count(),0);
      await panel.locator('summary').first().focus();await page.keyboard.press('Enter');assert.equal(await panel.locator('details').first().evaluate((el:HTMLDetailsElement)=>el.open),true);
      assert.match(await panel.locator('details').first().textContent()??'',/Detailed request text/);
      await page.evaluate(()=>{const state=(window as any).attention;state.cockpit.observed(state.catalog);});assert.equal(await panel.locator('details').first().evaluate((el:HTMLDetailsElement)=>el.open),true,'automatic observation keeps the question expanded');assert.equal(await panel.locator('summary').first().evaluate(el=>document.activeElement===el),true,'automatic observation retains question keyboard focus');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.MESH_PROJECT_EVIDENCE){fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,`requests-${width}.png`)});}
      await page.evaluate(()=>{const state=(window as any).attention;for(const source of state.catalog.projects[0].sources){source.summary.operator_status='absent';source.summary.operator_requests=[];source.summary.counts.operator_open=0;}state.cockpit.observed(state.catalog);});
      assert.match(await panel.textContent()??'',/No open request published/);assert.equal(await panel.locator('details').count(),0);
      for(const variant of ['count','truncated','unknown']){
        await page.evaluate(variant=>{const state=(window as any).attention;for(const source of state.catalog.projects[0].sources){source.summary.operator_status='valid';source.summary.operator_requests=variant==='unknown'?[{id:'unrecognized',title:'Request with an unknown state',state:'future-state'}]:[];source.summary.counts.operator_open=variant==='count'?1:0;source.summary.operator_truncated=variant==='truncated';}state.cockpit.observed(state.catalog);},variant);
        assert.match(await panel.textContent()??'',/No open request is available to display/);assert.match(await panel.textContent()??'',/list is incomplete/);assert.doesNotMatch(await panel.textContent()??'',/No open request published/);
      }
      await page.evaluate(()=>{const state=(window as any).attention;for(const source of state.catalog.projects[0].sources){source.summary.operator_status='valid';source.summary.operator_requests=Array.from({length:60},(_,i)=>({id:'request-'+i,title:'Request '+i,state:'open'}));source.summary.counts.operator_open=60;}state.cockpit.observed(state.catalog);});
      assert.equal(await panel.locator('details').count(),50);assert.match(await panel.textContent()??'',/list is incomplete/);
      await panel.locator('.cockpit-attention-list').evaluate(el=>el.scrollTop=200);const pan=await panel.locator('.cockpit-attention-list').evaluate(el=>el.scrollTop);assert.ok(pan>0);await page.evaluate(()=>{const state=(window as any).attention;state.cockpit.observed(state.catalog);});assert.equal(await panel.locator('.cockpit-attention-list').evaluate(el=>el.scrollTop),pan,'automatic observation keeps local list scroll');
      await page.evaluate(()=>{const state=(window as any).attention;state.catalog.projects[0].sources=[];state.cockpit.observed(state.catalog);});assert.equal(await panel.count(),0,'Roster stays optional');
    }finally{await page.close();}
  }}finally{await browser.close();}
});
