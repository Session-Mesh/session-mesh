// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {followupCatalog,roadmapObservation,roadmapTask} from './helpers/project-followup-fixtures.ts';
import {parseProjectCatalog} from '../static/project-catalog.ts';
const root=path.resolve(import.meta.dirname,'..');
test('Chrome: every roadmap has its own lifecycle and exact source navigation, including empty and stale boards',
 {skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM absent':false},async()=>{
 const raw=followupCatalog(roadmapObservation([],{phase:'ready',board_id:'board-A'}));
 raw.projects[0]!.sources=[];
 for(const [id,phase,global,accepted] of [['A','ready',false,true],['B','active',false,true],['C','complete',true,true],['D','draft',false,false],['E','blocked',false,true],['F','global-verification-needed',false,true],['G','canceled',false,true],['H','complete',false,true]] as const){
  const source=followupCatalog(roadmapObservation(id==='B'?[roadmapTask()]:[],{phase,board_id:'board-'+id,global:{accepted:global},accepted})).projects[0]!.sources[0]!;
  source.id=id;source.label='Same roadmap';raw.projects[0]!.sources.push(source);
 }
 raw.projects[0]!.sources.push({id:'offline',kind:'roster',label:'Offline source',status:'unavailable',observed_at:'2026-11-14T12:01:00Z',error_code:'missing-executable'});
 const catalog=parseProjectCatalog(raw);assert.ok(catalog);
 const bundle=await build({stdin:{contents:"export {ProjectCockpitView} from './static/project-cockpit-view.ts';export {ProjectCatalogView,ProjectDom} from './static/project-catalog-view.ts';",resolveDir:root},bundle:true,format:'iife',globalName:'RoadmapProbe',write:false});
 const browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--no-sandbox','--mute-audio']});
 try{for(const width of [1560,390])for(const lang of ['en','fr']){
  const page=await browser.newPage({viewport:{width,height:1000}});
  try{
   await page.setContent(`<html lang="${lang}"><body><main id="root"></main></body></html>`);await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addStyleTag({content:'body{overflow:auto}#root{max-width:100%}'});await page.addScriptTag({content:bundle.outputFiles[0]!.text});
   const messages=JSON.parse(fs.readFileSync(path.join(root,`static/i18n/${lang}.json`),'utf8'));
   await page.evaluate(({catalog,messages})=>{
    const root=document.querySelector('#root')!,host=document.createElement('section'),observation=document.createElement('section'),context=document.createElement('section'),legacy=document.createElement('section');root.append(host,observation,context,legacy);
    const status=document.createElement('p'),list=document.createElement('div'),detail=document.createElement('div');detail.className='projects-detail';observation.append(status,list,detail);
    const t=(key:string,values:Record<string,string|number>={})=>Object.entries(values).reduce((text,[k,v])=>text.replaceAll('{'+k+'}',String(v)),messages[key]??key);
    const api=(window as any).RoadmapProbe,view=new api.ProjectCatalogView(new api.ProjectDom(document,t),status,list,detail,undefined,true);view.render(catalog);
    const cockpit=new api.ProjectCockpitView(root,observation,context,legacy,t,(s:string,id:string)=>view.selectTask(s,id),undefined,(s:string,board:string|null)=>view.selectSource(s,board));
    cockpit.mount(host,{id:'one',title:'Delivery',folders_total:0,sources_total:9,sessions_total:0,participations_total:0},'host','cfg',false,'boot');cockpit.observed(catalog);
    (window as any).roadmap={view,cockpit,catalog};
   },{catalog,messages});
   const cards=page.locator('.project-roadmaps');assert.equal(await cards.locator('.project-roadmap').count(),8);
   assert.deepEqual(await cards.locator('[data-lifecycle]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.lifecycle)),['ready','active','complete','draft','blocked','global-verification-needed','unknown','inconsistent']);
   assert.match(await cards.innerText(),/offline/);assert.equal(await cards.locator('[data-lifecycle="complete"]').count(),1);
   await cards.locator('[data-roadmap-source="A"] button').click();assert.equal(await page.locator('select[aria-label]').first().inputValue(),'A');assert.equal(await page.locator('[data-followup-key="row-task"]').count(),0);assert.equal(await page.evaluate(()=>(document.activeElement as HTMLElement)?.dataset.followupKey),'heading');
   await page.locator('[data-cockpit-tab="overview"]').click();const second=cards.locator('[data-roadmap-source="B"] button');await second.focus();
   const list=cards.locator('.project-roadmap-list');await list.evaluate(node=>node.scrollTop=200);const position=await list.evaluate(node=>node.scrollTop);
   await page.evaluate(()=>{const {view,cockpit,catalog}=(window as any).roadmap;view.render(catalog);cockpit.observed({...catalog,generated_at:'2026-11-14T12:02:00Z'});});
   assert.equal(await second.evaluate(node=>document.activeElement===node),true);assert.equal(await list.evaluate(node=>node.scrollTop),position);
   const denied=await page.evaluate(()=>{const {view,catalog}=(window as any).roadmap;const changed=structuredClone(catalog);changed.projects[0].sources[1].summary.followup.metadata.value.board_id='replacement-board';view.render(changed);return view.selectSource('B','board-B');});assert.equal(denied,false);
   await second.click();assert.equal(await page.locator('.project-cockpit').getAttribute('data-cockpit-view'),'overview');assert.match(await cards.locator('[role="status"]').innerText(),new RegExp(lang==='fr'?'changé':'changed'));
   await page.evaluate(()=>{const {view,catalog}=(window as any).roadmap;view.render(catalog);});await second.click();assert.equal(await page.locator('select[aria-label]').first().inputValue(),'B');assert.equal(await page.evaluate(()=>(document.activeElement as HTMLElement)?.dataset.followupKey),'heading');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }finally{await page.close();}
 }}finally{await browser.close();}
});
