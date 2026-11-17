// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {parseHostReply} from '../static/project-host.ts';
import {followupCatalog,roadmapObservation} from './helpers/project-followup-fixtures.ts';

const root=path.resolve(import.meta.dirname,'..');
const skip=!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false;
const boot='a'.repeat(64),revision='cfg1_'+'b'.repeat(64);
const unsafe='<img src=x onerror="window.injected=true">'+ 'LongMetadata'.repeat(15);
const participations=Array.from({length:30},(_,i)=>({id:'member-'+i,label:'Same label',role_label:i===0?unsafe:'reviewer',recorded_relation:i===0?'active':'historical',
  target:i%2?{kind:'history',agent:'codex',conversation_id:'  conversation  '+i+'  '}:{kind:'mesh',name:'exact-'+i,created:1700000000.125+i,machine_id:'local'},
  work_refs:[{source_id:'roadmap',kind:'task',native_id:'VA',instance_id:'board'}]}));
const detail={id:'one',title:'Membership fixture',folders_total:0,sources_total:0,sessions_total:1,participations_total:30};
const owner=parseHostReply({kind:'mesh-project-reply',version:1,op:'project_read',status:'ok',boot,project:detail,
  membership:{sessions:[{name:'legacy-link\nsecond  line',created:123.25}],participations,complete:true,omitted_fields:[]}},'project_read').membership!;
const bundle=async()=> (await build({stdin:{contents:"export {ProjectCockpitView} from './static/project-cockpit-view.ts';export {mountProjectWorkspace} from './static/project-workspace.ts';",resolveDir:root},bundle:true,format:'iife',globalName:'MembershipTest',write:false})).outputFiles[0]!.text;

test('Chrome owner membership is independent, inert, bounded and distinct from observed sessions',{skip,timeout:30000},async()=>{
  const code=await bundle(),browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--no-sandbox','--mute-audio']});
  try{for(const width of [1560,390])for(const lang of ['en','fr']){
    const page=await browser.newPage({viewport:{width,height:1000}});
    try{
      await page.setContent(`<html lang="${lang}"><body><main id="root"><section id="host"><header><h2>Membership fixture</h2></header></section><section id="observation"><article class="projects-detail"><section data-cockpit-section="sessions">Observed identity must not merge</section></article></section><section id="context"></section><section id="legacy"></section></main></body></html>`);
      await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addScriptTag({content:code});
      const messages=JSON.parse(fs.readFileSync(path.join(root,'static/i18n',lang+'.json'),'utf8'));
      await page.evaluate(({owner,detail,messages,boot})=>{
        const q=(id:string)=>document.getElementById(id)!,t=(key:string)=>messages[key]??key;
        const view=new (window as any).MembershipTest.ProjectCockpitView(q('root'),q('observation'),q('context'),q('legacy'),t,()=>false);
        view.mount(q('host'),detail,'local','revision',false,boot,owner);(window as any).membershipFixture={view,owner,detail};
      },{owner,detail,messages,boot});
      await page.locator('[data-cockpit-tab="sessions"]').click();
      const membership=page.locator('.project-membership'),rows=membership.locator('.project-membership-row');assert.equal(await rows.count(),31);
      if(process.env.MESH_MEMBERSHIP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MESH_MEMBERSHIP_SCREENSHOTS,`membership-closed-${lang}-${width}.png`),fullPage:true});
      assert.equal(await page.locator('[data-cockpit-section="sessions"]').isVisible(),false,'no Roster observation needed; observed identities hidden');
      assert.equal(await membership.locator('button,a,img,script,iframe').count(),0,'metadata offers no action and uses text only');
      const first=rows.first().locator('summary');await first.focus();await page.keyboard.press('Enter');
      assert.equal(await rows.first().getAttribute('open'),'');assert.match(await rows.first().textContent(),/1700000000\.125/);assert.ok((await rows.first().textContent())!.includes(unsafe));
      await rows.nth(1).locator('summary').click();assert.equal(await rows.nth(1).locator('p').filter({hasText:messages['projectMembership.conversation']}).innerText(),messages['projectMembership.conversation']+':   conversation  1  ');assert.match(await rows.nth(1).textContent(),/codex/);
      const legacy=rows.last();await legacy.locator('summary').click();assert.equal(await legacy.locator('p').first().innerText(),messages['projectMembership.name']+': legacy-link\nsecond  line');assert.equal(await legacy.locator('summary').innerText(),'legacy-link\nsecond  line');
      assert.notEqual(await rows.first().getAttribute('data-membership-key'),await rows.nth(1).getAttribute('data-membership-key'));
      assert.ok((await membership.textContent())!.includes(messages['projectMembership.scope']));
      const list=membership.locator('.project-membership-list').first();await list.evaluate(node=>node.scrollTop=180);const top=await list.evaluate(node=>node.scrollTop);assert.ok(top>0);
      await first.evaluate(node=>node.focus({preventScroll:true}));await list.evaluate((node,top)=>node.scrollTop=top,top);assert.equal(await list.evaluate(node=>node.scrollTop),top,'fixture reading position set before observation');
      await page.evaluate(()=>{const s=(window as any).membershipFixture;s.old=document.querySelector('.project-membership');s.view.clearObserved();});
      assert.equal(await page.evaluate(()=>document.querySelector('.project-membership')===(window as any).membershipFixture.old),true);
      assert.equal(await first.evaluate(node=>node===document.activeElement),true);assert.equal(await list.evaluate(node=>node.scrollTop),top);assert.equal(await rows.first().getAttribute('open'),'');
      assert.ok(await first.evaluate(node=>node.getBoundingClientRect().height>=44));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.MESH_MEMBERSHIP_SCREENSHOTS){await page.screenshot({path:path.join(process.env.MESH_MEMBERSHIP_SCREENSHOTS,`membership-${lang}-${width}.png`),fullPage:true});}
      const partial=parseHostReply({kind:'mesh-project-reply',version:1,op:'project_read',status:'ok',boot,project:detail,membership:{sessions:owner.sessions,complete:false,omitted_fields:['participations']}},'project_read').membership;
      await page.evaluate(({partial,boot})=>{const s=(window as any).membershipFixture;document.getElementById('host')!.replaceChildren(document.createElement('header'));s.view.mount(document.getElementById('host'),s.detail,'local','revision',false,boot,partial);},{partial,boot});
      assert.equal(await membership.locator('.project-membership-warning').count(),1);assert.ok((await membership.textContent())!.includes(messages['projectMembership.omitted']));assert.equal(await membership.locator('.project-membership-row').count(),1);
      const empty=parseHostReply({kind:'mesh-project-reply',version:1,op:'project_read',status:'ok',boot,project:{...detail,sessions_total:0,participations_total:0},membership:{sessions:[],participations:[],complete:true,omitted_fields:[]}},'project_read').membership;
      await page.evaluate(({empty,boot})=>{const s=(window as any).membershipFixture;document.getElementById('host')!.replaceChildren(document.createElement('header'));s.view.mount(document.getElementById('host'),s.detail,'local','revision',false,boot,empty);},{empty,boot});
      assert.equal(await membership.locator('.project-membership-warning').count(),0);assert.equal(await membership.locator('.project-membership-row').count(),0);assert.ok((await membership.textContent())!.includes(messages['projectMembership.empty']));
      const catalog=followupCatalog(roadmapObservation([]));catalog.projects[0]!.sessions=[{name:'observed',created:42}];
      await page.evaluate(({catalog,boot})=>{const s=(window as any).membershipFixture;document.getElementById('host')!.replaceChildren(document.createElement('header'));s.view.mount(document.getElementById('host'),s.detail,'local','revision',false,boot);s.view.observed(catalog);},{catalog,boot});
      assert.equal(await membership.count(),0);assert.equal(await page.locator('[data-cockpit-section="sessions"]').isVisible(),true,'absent owner metadata retains existing observed presentation');
      await page.evaluate(({owner,boot})=>{const s=(window as any).membershipFixture;document.getElementById('host')!.replaceChildren(document.createElement('header'));s.view.mount(document.getElementById('host'),{...s.detail,id:'two'},'local','revision',false,boot,owner);},{owner,boot});
      await page.locator('[data-cockpit-tab="sessions"]').last().click();assert.equal(await page.locator('.project-membership details[open]').count(),0,'different project does not inherit expansion');
    }finally{await page.close();}
  }}finally{await browser.close();}
});

test('Chrome workspace forwards only selected same-boot owner read membership and suppresses late selection',{skip,timeout:30000},async()=>{
  const code=await bundle(),browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--no-sandbox','--mute-audio']});
  try{for(const width of [1560,390]){
    const page=await browser.newPage({viewport:{width,height:1000}});try{
      await page.setContent('<html lang="en"><body><aside id="sidebar"></aside><main id="root"></main></body></html>');await page.addStyleTag({path:path.join(root,'static/style.css')});await page.addScriptTag({content:code});
      const messages=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
      await page.evaluate(({owner,detail,messages,boot,revision})=>{
        const state:any={calls:[],held:false,mismatch:false};(window as any).workspaceFixture=state;
        const request=async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));state.calls.push(body);let reply:any={kind:'mesh-project-reply',version:1,op:body.op,status:'ok',boot,machine_id:'local',revision};
          if(body.op==='project_capabilities')reply.features=['project-memberships/1'];
          else if(body.op==='project_list'){reply.projects=[{id:'one',title:'One'},{id:'two',title:'Two'}];reply.total=2;reply.complete=true;}
          else {if(body.op!=='project_read')throw Error('unexpected write');if(state.held&&!body.settings){state.held=false;await new Promise(resolve=>state.release=resolve);}
            reply.project={...detail,id:body.project_id,title:body.project_id==='one'?'One':'Two'};
            if(body.settings)reply.observation_settings={kind:'project',plan:null,repository:null,source_summaries:[]};
            else{reply.membership=owner;if(body.project_id==='two')reply.membership={sessions:[],participations:[],complete:true,omitted_fields:[]};if(body.project_id==='two'){reply.project.sessions_total=0;reply.project.participations_total=0;}if(state.mismatch)reply.boot='c'.repeat(64);}}
          return new Response(JSON.stringify(reply));};
        state.workspace=(window as any).MembershipTest.mountProjectWorkspace({root:document.getElementById('root'),sidebar:document.getElementById('sidebar'),request,translate:(key:string)=>messages[key]??key,availability:()=>{},mountArtifact:()=>({open(){},close(){}})});state.workspace.open();
      },{owner,detail,messages,boot,revision});
      await page.locator('#project-overview h2').filter({hasText:'One'}).waitFor();await page.locator('[data-cockpit-tab="sessions"]').click();assert.equal(await page.locator('.project-membership-row').count(),31);
      await page.evaluate(()=>{const s=(window as any).workspaceFixture;s.held=true;s.workspace.close();s.workspace.open();});
      await page.waitForFunction(()=>typeof (window as any).workspaceFixture.release==='function');
      await page.locator('#sidebar button').filter({hasText:'Two'}).click();await page.locator('#project-overview h2').filter({hasText:'Two'}).waitFor();await page.locator('[data-cockpit-tab="sessions"]').click();assert.equal(await page.locator('.project-membership-row').count(),0);
      await page.evaluate(()=>(window as any).workspaceFixture.release());await page.waitForTimeout(30);assert.equal(await page.locator('#project-overview h2').textContent(),'Two');assert.equal(await page.locator('.project-membership-row').count(),0);
      await page.evaluate(()=>{const s=(window as any).workspaceFixture;s.mismatch=true;s.workspace.close();s.workspace.open();});await page.locator('#project-overview h2').filter({hasText:'Two'}).waitFor();await page.locator('[data-cockpit-tab="sessions"]').click();assert.equal(await page.locator('.project-membership').count(),0,'foreign boot metadata is not forwarded');
      await page.evaluate(()=>(window as any).workspaceFixture.workspace.close());
    }finally{await page.close();}
  }}finally{await browser.close();}
});
