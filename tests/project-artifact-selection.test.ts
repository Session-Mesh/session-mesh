// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
const root=path.resolve(import.meta.dirname,'..');
test('Chrome: reader refuses obsolete source after factory failure and preserves focus on unchanged observation',{skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
  const result=await build({stdin:{contents:`export {ProjectArtifactView} from './static/project-artifact-view.ts';export {ProjectCockpitView} from './static/project-cockpit-view.ts';`,resolveDir:root},bundle:true,platform:'browser',format:'iife',globalName:'ReaderProbe',write:false});
  const browser=await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM, ['--mute-audio','--no-sandbox']));
  try{
    for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}});await page.setContent('<html lang="en"><body></body></html>');await page.addScriptTag({content:result.outputFiles[0]!.text});
    const failed=await page.evaluate(`(async()=>{
      let calls=0;const factory=source=>{if(source==='B')throw Error('unavailable');return async()=>{calls++;return {data:{items:[{id:'from-A',kind:'intake',format:'text',body:{availability:'absent'}}],next_cursor:'next-A'}};};};
      const view=new ReaderProbe.ProjectArtifactView(document,[{id:'A',label:'A',tasks:[]},{id:'B',label:'B',tasks:[]}],factory,key=>key);document.body.append(view.root);await new Promise(r=>setTimeout(r,0));
      const more=[...view.root.querySelectorAll('button')].find(button=>button.textContent==='projects.artifacts.more');const source=view.root.querySelector('select');source.value='B';source.dispatchEvent(new Event('change'));more.click();await new Promise(r=>setTimeout(r,0));
      const result={source:source.value,calls,hidden:more.hidden,disabled:more.disabled,list:view.root.querySelector('.project-artifact-list').textContent};view.destroy();return result;
    })()`);
    assert.deepEqual(failed,{source:'B',calls:1,hidden:true,disabled:true,list:''});
    const focused=await page.evaluate(`(async()=>{
      const root=document.createElement('section'),observation=document.createElement('section'),context=document.createElement('section'),legacy=document.createElement('section'),host=document.createElement('section');root.append(host,observation,context,legacy);document.body.append(root);let calls=0;
      const factory=()=>async()=>{calls++;return {data:{items:[],next_cursor:null}};};
      const view=new ReaderProbe.ProjectCockpitView(root,observation,context,legacy,key=>key,()=>false,factory);
      const detail={id:'one',title:'Project',folders_total:0,sources_total:1,sessions_total:0,participations_total:0};view.mount(host,detail,'machine','revision',false,'boot');
      const catalog={generated_at:'first',projects:[{id:'one',sources:[{id:'source',kind:'roster',label:'Source',summary:{items:[],counts:{}}}]}]};view.observed(catalog);root.querySelector('[data-cockpit-tab="roster"]').click();await new Promise(r=>setTimeout(r,0));const reader=root.querySelector('.project-artifact-browser'),select=reader.querySelector('select');select.focus();view.observed({...catalog,generated_at:'second'});
      const summary=root.querySelector('.project-roster-task-summary');const result={focus:document.activeElement===select,same:reader===root.querySelector('.project-artifact-browser'),calls,readerFirst:!!(reader.compareDocumentPosition(summary)&Node.DOCUMENT_POSITION_FOLLOWING),tasksCollapsed:summary.closest('details')?.open===false};view.clearObserved();root.remove();return result;
    })()`);
    assert.deepEqual(focused,{focus:true,same:true,calls:1,readerFirst:true,tasksCollapsed:true});
    await page.close();
    }
  }finally{await browser.close();}
});

test('Chrome: unavailable reader keeps Roster task navigation and a specific runtime status',{skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
  const result=await build({stdin:{contents:`export {ProjectCockpitView} from './static/project-cockpit-view.ts';export {artifactRequest} from './static/project-artifact-client.ts';`,resolveDir:root},bundle:true,platform:'browser',format:'iife',globalName:'ReaderProbe',write:false});
  const browser=await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM, ['--mute-audio','--no-sandbox']));
  try{
    const page=await browser.newPage();await page.setContent('<html lang="en"><body></body></html>');await page.addScriptTag({content:result.outputFiles[0]!.text});
    const state=await page.evaluate(`(async()=>{
      const root=document.createElement('section'),host=document.createElement('section'),observation=document.createElement('section'),context=document.createElement('section'),legacy=document.createElement('section');root.append(host,observation,context,legacy);document.body.append(root);const selected=[];
      const scope={project_id:'one',boot:'a'.repeat(64),machine_id:'host',revision:'cfg1_'+'b'.repeat(64)};
      const factory=source=>ReaderProbe.artifactRequest(async(_url,options)=>{const query=JSON.parse(options.body);return new Response(JSON.stringify({...scope,source_id:source,...(query.roadmap_task_id?{roadmap_task_id:query.roadmap_task_id}:{}),kind:'mesh-project-artifact-reply',version:1,status:'unsupported',code:'roster-runtime-unavailable'}));},{...scope,source_id:source});
      const view=new ReaderProbe.ProjectCockpitView(root,observation,context,legacy,key=>key,(source,task)=>{selected.push({source,task});return true;},factory);
      view.mount(host,{id:'one',title:'Project',folders_total:0,sources_total:1,sessions_total:0,participations_total:0},'host',scope.revision,false,scope.boot);
      const catalog={generated_at:'first',projects:[{id:'one',sources:[{id:'source',kind:'roster',label:'Source',summary:{items:[{id:'VA',title:'Original task',state:'active'}],counts:{}}}]}]};
      view.observed(catalog);root.querySelector('[data-cockpit-tab="roster"]').click();await new Promise(r=>setTimeout(r,0));
      const status=root.querySelector('.project-artifact-status').textContent,reader=root.querySelector('.project-artifact-browser'),source=reader.querySelector('select');source.focus();
      const updated=structuredClone(catalog);updated.projects[0].sources[0].summary.items[0].state='done';view.observed(updated);
      const task=root.querySelector('.project-roster-task-summary .cockpit-work-row'),stateText=task?.textContent,focus=document.activeElement===source,attached=reader===root.querySelector('.project-artifact-browser');
      task?.click();const result={status,stateText,focus,attached,selected,tab:root.dataset.cockpitView};view.clearObserved();root.remove();return result;
    })()`);
    assert.equal(state.status,'projects.artifacts.notConfigured');
    assert.match(state.stateText||'',/VA · Original taskdone/);
    assert.equal(state.focus,true);assert.equal(state.attached,true);
    assert.deepEqual(state.selected,[{source:'source',task:'VA'}]);assert.equal(state.tab,'work');
  }finally{await browser.close();}
});
