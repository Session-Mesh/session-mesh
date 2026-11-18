// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {followupCatalog, roadmapObservation, roadmapTask} from './helpers/project-followup-fixtures.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
const root=path.resolve(import.meta.dirname,'..');
test('Chrome: recorded activity preserves source identity, partial history, keyboard focus and reading position',
 {skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM absent':false},async()=>{
 const bundle=await build({stdin:{contents:"export {ProjectCockpitView} from './static/project-cockpit-view.ts'",resolveDir:root},bundle:true,format:'iife',globalName:'ActivityProbe',write:false});
 const browser=await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM, ['--no-sandbox','--mute-audio']));
 try{for(const width of [1560,390])for(const lang of ['en','fr']){
  const page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.setContent(`<html lang="${lang}"><body><section id="root"></section></body></html>`);
   await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addStyleTag({content:'body{overflow:auto}#root{padding:20px;max-width:100%}'});
   await page.addScriptTag({content:bundle.outputFiles[0]!.text});
   const messages=JSON.parse(fs.readFileSync(path.join(root,`static/i18n/${lang}.json`),'utf8'));
   const summaryBase=followupCatalog(roadmapObservation([roadmapTask({id:'SAME',objective:'Read the task',state:'active'})])).projects[0]!.sources[0]!.summary!;
   await page.evaluate(({messages,summaryBase})=>{
    const el=document.querySelector('#root')!,host=document.createElement('section'),observations=document.createElement('section'),context=document.createElement('section'),legacy=document.createElement('section');el.append(host,observations,context,legacy);
    const t=(key:string,values:Record<string,string|number>={})=>Object.entries(values).reduce((text,[k,v])=>text.replaceAll('{'+k+'}',String(v)),messages[key]??key);
    const selected:any[]=[];const view=new (window as any).ActivityProbe.ProjectCockpitView(el,observations,context,legacy,t,(source:string,task:string)=>{selected.push({source,task});return true;});
    const detail={id:'project',title:'Project',folders_total:0,sources_total:4,sessions_total:0,participations_total:0};view.mount(host,detail,'machine','revision',false,'boot');
    const part=(items:any[],total:number|null,truncated:boolean)=>({availability:'valid',reason:null,text_truncated:false,truncated,value:{items,total,truncated}});
    const source=(id:string,events:any)=>({id,kind:'roster',label:'Same label',status:'available',observed_at:'2026-11-17T00:00:00Z',summary:{...structuredClone(summaryBase),followup:{...structuredClone(summaryBase.followup),events,metadata:{...structuredClone(summaryBase.followup!.metadata),value:{...summaryBase.followup!.metadata.value,board_id:'original-board'}}}}});
    const events=Array.from({length:20},(_,i)=>({action:i===0?'claim':'progress',task_id:'SAME',at:i===1?'2026-02-30T12:00:00Z':`2026-11-17T00:${String(i).padStart(2,'0')}:00Z`,reason:i===0?'<img src=x onerror=alert(1)>':('Long reason '+i+' ').repeat(60)}));
    const catalog={generated_at:'first',projects:[{id:'project',sources:[source('A',part(events,30,true)),source('B',part([events[0]],1,false)),source('empty',part([],0,false)),source('unknown',{availability:'invalid',reason:'malformed',value:null}),source('partialEmpty',part([],null,true)),{id:'offline',kind:'roster',label:'Offline',status:'unavailable',observed_at:'2026-11-17T00:00:00Z'}]}]};
    view.observed(catalog);(el.querySelector('[data-cockpit-tab="activity"]') as HTMLElement).click();
    (window as any).activity={view,catalog,selected};
   },{messages,summaryBase});
   const feed=page.locator('.project-activity-feed');assert.equal(await feed.locator('.project-activity-source').count(),6);
   assert.match(await feed.locator('[data-activity-source="A"]').innerText(),new RegExp(lang==='fr'?'Historique partiel':'Partial history'));
   assert.match(await feed.locator('[data-activity-source="empty"]').innerText(),new RegExp(lang==='fr'?'Aucun événement publié':'No events published'));
   assert.match(await feed.locator('[data-activity-source="unknown"]').innerText(),new RegExp(lang==='fr'?'indisponible':'unavailable'));
   assert.match(await feed.locator('[data-activity-source="partialEmpty"]').innerText(),new RegExp(lang==='fr'?'Aucun événement visible':'No events are visible'));
   assert.match(await feed.locator('[data-activity-source="offline"]').innerText(),new RegExp(lang==='fr'?'indisponible':'unavailable'));
   assert.equal(await feed.locator('time:not([datetime])').count(),1);assert.equal(await feed.locator('img,script,iframe').count(),0);
   const source=feed.locator('[data-activity-source="A"]'),summary=source.locator('details summary').first();await summary.focus();await page.keyboard.press('Enter');assert.equal(await source.locator('details').first().getAttribute('open'),'');
   const list=source.locator('.project-activity-list');await list.evaluate(node=>node.scrollTop=200);const top=await list.evaluate(node=>node.scrollTop);
   await page.evaluate(()=>{const {view,catalog}=(window as any).activity;view.observed({...catalog,generated_at:'second'});});
   assert.equal(await source.locator('details').first().getAttribute('open'),'');assert.equal(await list.evaluate(node=>node.scrollTop),top);assert.equal(await summary.evaluate(node=>document.activeElement===node),true);
   await page.evaluate(()=>{const {view,catalog}=(window as any).activity;const next=structuredClone(catalog);next.projects[0].sources[0].summary.followup.metadata.value.board_id='replacement-board';view.observed(next);});
   assert.notEqual(await source.locator('details').first().getAttribute('open'),'');assert.equal(await summary.evaluate(node=>document.activeElement===node),false);
   await feed.locator('[data-activity-source="B"] .project-activity-task').click();
   assert.deepEqual(await page.evaluate(()=>(window as any).activity.selected),[{source:'B',task:'SAME'}]);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.locator('[data-cockpit-tab="activity"]').click();await page.evaluate(()=>(window as any).activity.view.clearObserved());
   assert.match(await feed.innerText(),new RegExp(lang==='fr'?'En attente':'Waiting for'));
   assert.equal(await feed.locator('.project-activity-source').count(),0);
  }finally{await page.close();}
 }}finally{await browser.close();}
});
