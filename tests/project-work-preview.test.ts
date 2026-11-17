// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workPreview} from '../static/project-work-preview.ts';
import {followupCatalog,roadmapObservation,roadmapTask} from './helpers/project-followup-fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

test('overview does not hide later assigned work behind early queued or finished tasks',()=>{
  const summary=followupCatalog(roadmapObservation([
    roadmapTask({id:'first-queued'}),roadmapTask({id:'finished',state:'done'}),
    roadmapTask({id:'later-active',state:'active'}),roadmapTask({id:'later-blocked',state:'blocked'}),
  ])).projects[0]!.sources[0]!.summary!;
  const before=JSON.stringify(summary);
  assert.deepEqual(workPreview(summary).map(row=>row.id),['later-active','later-blocked']);
  assert.equal(JSON.stringify(summary),before,'read-only preview never reorders provider observations');
});
test('unknown source states are retained and equal priority keeps source order',()=>{
  const summary=followupCatalog(roadmapObservation([
    roadmapTask({id:'queued'}),roadmapTask({id:'opaque',state:'future-state'}),
    roadmapTask({id:'second-opaque',state:'custom-state'}),
  ])).projects[0]!.sources[0]!.summary!;
  assert.deepEqual(workPreview(summary).map(row=>[row.id,row.state]),[['opaque','future-state'],['second-opaque','custom-state']]);
});

test('Chrome overview keeps short status badges readable and long unknown states bounded',
 {timeout:30000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const bundle=await build({stdin:{contents:"export {ProjectCockpitView} from './static/project-cockpit-view.ts';",resolveDir:root},bundle:true,platform:'browser',format:'iife',globalName:'PreviewTest',write:false});
  const translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
  const browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--no-sandbox','--mute-audio']});
  try{for(const width of [1560,390])for(const state of ['active','queued','W'.repeat(80)]){
    const catalog=followupCatalog(roadmapObservation([roadmapTask({id:'opaque',objective:'Inspect this source state while preserving the complete project workflow and session relationship. '.repeat(2),state})]));
    const page=await browser.newPage({viewport:{width,height:1000}});
    try{
      await page.setContent('<main id="root"><section id="host"><header><h2>Project</h2></header></section><section id="observation"></section><section id="context"></section><section id="legacy"></section></main>');
      await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addScriptTag({content:bundle.outputFiles[0]!.text});
      await page.evaluate(({catalog,translations})=>{
        const q=(id:string)=>document.getElementById(id)!;
        const t=(key:string)=>String(translations[key]??key);
        const cockpit=new (window as any).PreviewTest.ProjectCockpitView(q('root'),q('observation'),q('context'),q('legacy'),t,(source:string,task:string)=>{(window as any).selected=[source,task];return true;});
        cockpit.mount(q('host'),{id:'one',title:'Delivery'},'host','config');cockpit.observed(catalog);
      },{catalog,translations});
      const row=page.locator('.cockpit-work-preview .cockpit-work-row');
      const geometry=await row.evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,title:node.querySelector('strong')!.getBoundingClientRect().width,badge:node.querySelector('.cockpit-badge')!.getBoundingClientRect().width}));
      assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));assert.ok(geometry.title>=100,JSON.stringify(geometry));assert.ok(geometry.badge<=geometry.width*.36,JSON.stringify(geometry));
      assert.equal(await row.locator('.cockpit-badge').innerText(),state);
      if(state.length<10){const line=await row.locator('.cockpit-badge').evaluate(node=>{const style=getComputedStyle(node),range=document.createRange();range.selectNodeContents(node);return {lines:range.getClientRects().length,height:node.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight)};});assert.equal(line.lines,1,JSON.stringify(line));}
      await row.focus();await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>(window as any).selected),['roadmap','opaque']);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }finally{await page.close();}
  }}finally{await browser.close();}
});
