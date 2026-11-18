// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readProjectCatalog } from '../static/projects.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = '2026-11-14T12:00:00Z';
const catalog = (title = 'Configured project') => ({kind:'mesh-project-catalog',schema_version:1,
  machine_id:'owner-machine',revision:'a'.repeat(64),generated_at:NOW,projects:[{id:'stable-id',title,
    description:'<img src=x onerror="window.injected=true">',sessions:[{name:'session-one',created:1234,machine_id:'unverified'}],sources:[{
      id:'roster',kind:'roster',label:'Canonical Roster',status:'available',observed_at:NOW,
      summary:{provider_schema:'roster-roadmap-view',provider_version:1,global_accepted:false,
        counts:{total:25,done:25},items:[{id:'task-1',title:'Finished task',state:'done'}],truncated:true,more:24}},
      {id:'other-roadmap',kind:'roster',label:'Other roadmap',status:'unavailable',observed_at:NOW,error_code:'missing-executable'}]}]});
function pipelineCatalog(title = 'Pipeline project') {
  const c = catalog(title);
  const components = Object.fromEntries(['ledger','intake','spec','plan','implementation','review','qa_state','qa','manifest'].map(name =>
    [name, { availability: 'absent', reason: null, truncated: false }]));
  for (const name of ['ledger','review','qa_state','qa']) components[name].availability = 'valid';
  components.review.truncated = true;
  const report = status => ({ status, round: 2, cycle: null, date: 'round two, date unknown',
    findings: { items: [], total: null, truncated: false }, rounds_audit: { items: [], total: 0, truncated: false }, no_go_reason: null });
  const review = report('GO'); review.findings = { items: [{ severity: 'high', description: '<img src=x onerror="window.injected=true">'.padEnd(2000,'x'), status: 'open', specialist: null }], total: 1, truncated: false };
  const pair = { phase: 'implement', outcome: 'COMPLETED' };
  c.projects[0].sources[0].summary = { provider_schema: 'pipeline-task', provider_version: 1, source_generated_at: NOW, source_revision: 'b'.repeat(64),
    counts: {}, items: [], truncated: true, more: null, pipeline: { task: 'release-check', availability: 'valid', mode: 'full', latest_completed: pair,
      verdict_disagreement: true, components, review, qa: { ...report('NO-GO'), qa_no_go_round: null }, qa_markdown_status: 'NO-GO',
      history: { items: [
        { source_index: 0, phase: 'review', outcome: 'NO-GO', reason: null, reason_truncated: false, actor: { availability: 'unknown', value: null, truncated: false }, time: { availability: 'unknown', value: null } },
        { source_index: 1, ...pair, reason: 'Recorded correction', reason_truncated: false, actor: { availability: 'valid', value: 'implementer', truncated: false }, time: { availability: 'valid', value: 'November 14, 2026 10:00:00 GMT+0100' } },
      ], total: 2, truncated: false },
      coverage: ['checks','live-execution','session','attempt','full-report-history','standalone-acceptance'].map(id => ({ id, availability: 'unsupported', limitations: 'No canonical authority' })),
    } };
  return c;
}
const json = (value: unknown) => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});

test('signed JSON adapter renews file capability and rejects unsafe descriptors', async () => {
  const calls: {url:string;init?:RequestInit}[] = [];
  const request = async (url:string,init?:RequestInit) => {
    calls.push({url,init});
    return url === '/api/view' ? json({url:'/view/v2.f.test/catalog.json'}) : json(catalog());
  };
  const signal = new AbortController().signal;
  assert.equal((await readProjectCatalog('/catalog.json',request,signal,()=>true,'http://local')).projects.length,1);
  await readProjectCatalog('/catalog.json',request,signal,()=>true,'http://local');
  assert.equal(calls.filter(row=>row.url==='/api/view').length,2);
  assert.ok(calls.every(row=>row.init?.redirect==='error' && row.init?.cache==='no-store'));
  for (const url of ['https://other/view/v2.f.x/a.json','/view/v2.d.x/a.json','/api/sessions',
    'javascript:alert(1)','/view/v2.f.x/a.json?secret=x','/view/v2.f.x/a.json#x']) {
    await assert.rejects(readProjectCatalog('/catalog.json',async()=>json({url}),signal,()=>true,'http://local'));
  }
  for (const file of ['relative.json','/catalog.html','/bad\n.json'])
    await assert.rejects(readProjectCatalog(file,request,signal,()=>true,'http://local'));
});

test('signed JSON adapter bounds bytes and refuses malformed, invalid UTF8 and stale results', async () => {
  const signal = new AbortController().signal;
  for (const body of ['{',JSON.stringify({...catalog(),schema_version:9}), 'x'.repeat(2*1024*1024+1)]) {
    await assert.rejects(readProjectCatalog('/catalog.json',async url=>url==='/api/view'
      ?json({url:'/view/v2.f.test/catalog.json'}):new Response(body),signal,()=>true,'http://local'));
  }
  await assert.rejects(readProjectCatalog('/catalog.json',async url=>url==='/api/view'
    ?json({url:'/view/v2.f.test/catalog.json'}):new Response(new Uint8Array([0xff])),signal,()=>true,'http://local'));
  await assert.rejects(readProjectCatalog('/catalog.json',async()=>json({url:'/view/v2.f.test/catalog.json'}),signal,()=>false,'http://local'));
});

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
describe('native Projects isolation with mounted Sessions', {skip}, () => {
  let browser: Browser;
  let server: http.Server;
  let origin = '';
  before(async () => {
    server = http.createServer((request,response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/sessions') {
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({mesh:[{id:'session-one',name:'session-one',kind:'mesh',created:1234,
          cwd:'/tmp/project',pid:123,label:'Session one'}],external:[],home:'/tmp',now:Date.now()/1000,management:{state:'observed',sessions:[]}})); return;
      }
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify(url.pathname==='/api/history'?{sessions:[],full:true,gen:'test'}:{available:false})); return;
      }
      const renderer = ['marked.min.js', 'purify.min.js'].find(name => url.pathname === '/viewlib/' + name);
      const file = path.resolve(ROOT, renderer ? 'static/vendor/' + renderer : url.pathname==='/' ? 'static/index.html' : '.'+url.pathname);
      if (!file.startsWith(ROOT+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {response.writeHead(404).end();return;}
      const ext=path.extname(file);
      response.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css'} as Record<string,string>)[ext] ?? 'application/octet-stream');
      response.end(fs.readFileSync(file));
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser=await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox','--mute-audio']));
  });
  after(async()=>{await browser?.close();server?.close();});

  async function sessionPage(mobile=false,catalogOverride?:Record<string,string>,twoSessions=false,projectBundle?:string) {
    const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900},locale:'en-US',hasTouch:mobile});
    let sockets=0; const input:(string|Buffer)[]=[]; let inventories=0;const projectRequests:string[]=[];
    let output = (_value:string) => { throw new Error('socket not ready'); };
    page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(pathname==='/api/sessions') inventories++;if(pathname==='/static/projects.js'||pathname==='/api/view')projectRequests.push(pathname);});
    await page.routeWebSocket('**/ws/**',socket=>{
      sockets++; socket.onMessage(message=>input.push(message));
      output = value => socket.send(Buffer.from(value));
      socket.send(Buffer.from('Ready\r\n'+Array.from({length:80},(_,i)=>`line ${i}\r\n`).join('')));
    });
    if(catalogOverride) await page.route('**/static/i18n/en.json*',route=>route.fulfill({json:catalogOverride}));
    if(twoSessions) await page.route('**/api/sessions',route=>route.fulfill({json:{mesh:[
      {id:'session-one',name:'session-one',kind:'mesh',created:1234,cwd:'/tmp/project',pid:123,label:'Session one'},
      {id:'session-two',name:'session-two',kind:'mesh',created:5678,cwd:'/tmp/second',pid:124,label:'Session two'},
    ],external:[],home:'/tmp',now:Date.now()/1000,management:{state:'observed',sessions:[]}}}));
    if(projectBundle)await page.route('**/static/projects.js*',route=>route.fulfill({body:projectBundle,contentType:'text/javascript'}));
    await page.goto(origin);
    await page.waitForFunction(expected=>typeof meshContext !== 'undefined' && panes.length > 0 && data.mesh.length===expected,twoSessions?2:1);
    await page.evaluate('openSession("session-one")');
    await page.waitForFunction('active?.conn?.terminal?.isOpen() && active.term.buffer.active.length > 80');
    await page.evaluate(`(() => {
      window.sessionEvidence={pane:active,term:active.term,conn:active.conn,terminal:active.conn.terminal};
      observePaneActions(active);
      window.sessionEvidence.target=paneTargets.capture(active,true);
      window.sessionEvidence.id=active.id;
      window.sessionEvidence.created=data.mesh.find(row=>row.id===active.id||row.name===active.id).created;
      document.querySelector('#line-text').value='pending draft';
      document.querySelector('#line-text').dispatchEvent(new Event('input',{bubbles:true}));
      active.noteUserScroll(false);
      active.term.scrollToLine(20);
      window.sessionViewport=active.term.buffer.active.viewportY;
    })()`);
    assert.ok(await page.evaluate('window.sessionViewport') > 0, 'nontrivial terminal viewport captured');
    assert.equal(await page.evaluate('!!sessionEvidence.target && paneTargets.valid(sessionEvidence.target)'),true,'exact action target captured from observed fixture inventory');
    assert.deepEqual(projectRequests,[], 'Sessions boot does not load Projects module or artifact');
    return {page,input,sockets:()=>sockets,inventories:()=>inventories,output:(value:string)=>output(value)};
  }
  async function enter(page:Page,mobile=false) {
    if(mobile){await page.locator('#btn-mobile-actions').click();await page.locator('[data-mobile-action="btn-projects"]').click();}
    else await page.locator('#btn-projects').click();
    await page.locator('#projects').waitFor({state:'visible'});
  }
  async function readableText(page:Page, selector:string) {
    const geometries=await page.locator(selector).evaluateAll(elements=>elements.map(element=>{
      const range=document.createRange();range.selectNodeContents(element);
      const box=element.getBoundingClientRect();
      return {text:element.textContent,client:element.clientWidth,scroll:element.scrollWidth,
        left:box.left,right:box.right,viewport:innerWidth,
        fragments:[...range.getClientRects()].map(rect=>({left:rect.left,right:rect.right}))};
    }));
    assert.ok(geometries.length>0, `expected visible text at ${selector}`);
    for(const geometry of geometries){
      assert.ok(geometry.scroll<=geometry.client+1, `${selector} scroll ${geometry.scroll} exceeds client ${geometry.client}`);
      assert.ok(geometry.left>=-1 && geometry.right<=geometry.viewport+1, `${selector} element outside viewport`);
      for(const fragment of geometry.fragments)
        assert.ok(fragment.left>=geometry.left-1 && fragment.right<=geometry.right+1, `${selector} text outside its element`);
    }
  }
  async function continuity(page:Page, sockets:()=>number,input:(string|Buffer)[],sameViewport=true) {
    assert.equal(await page.evaluate(`active===window.sessionEvidence.pane && active.term===window.sessionEvidence.term
      && active.conn===window.sessionEvidence.conn && active.conn.terminal===window.sessionEvidence.terminal
      && active.conn.terminal.isOpen()`),true);
    assert.equal(await page.locator('#line-text').inputValue(),'pending draft');
    if(sameViewport) assert.equal(await page.evaluate('active.term.buffer.active.viewportY === window.sessionViewport'),true);
    assert.equal(await page.evaluate('paneTargets.valid(sessionEvidence.target) && active.id===sessionEvidence.id && data.mesh.find(row=>row.id===active.id||row.name===active.id).created===sessionEvidence.created'),true);
    assert.equal(sockets(),1);
    await page.evaluate('active.conn.terminal.queueInput(new TextEncoder().encode("continuity"))');
    await page.waitForTimeout(30);
    assert.ok(input.some(value=>Buffer.isBuffer(value)&&value.toString()==='continuity'));
  }
  for(const width of [1280,390]) test(`membership capability gates actual workspace read bytes at ${width}px`,async()=>{
    const {build}=await import('esbuild');
    const built=await build({absWorkingDir:ROOT,entryPoints:['static/projects.ts'],bundle:true,format:'esm',platform:'browser',
      minify:true,write:false,target:['es2022'],outfile:path.join(ROOT,'static/projects.js')});
    const {page,input,sockets}=await sessionPage(width===390,undefined,false,built.outputFiles[0].text);
    const bodies:string[]=[];let advertised=false,capBoot='a'.repeat(64),listBoot=capBoot,refused=false,failMembership=false;
    const project={id:'p',title:'Capability project',folders_total:0,sources_total:0,sessions_total:0,participations_total:0};
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON();bodies.push(route.request().postData()!);
      const base={kind:'mesh-project-reply',version:1,op:body.op,boot:listBoot,status:'ok',machine_id:'local',revision:'cfg1_'+'b'.repeat(64)};
      if(body.op==='project_capabilities')return route.fulfill({json:{...base,boot:capBoot,status:refused?'unavailable':'ok',
        features:advertised?['project-registry/1','project-memberships/1']:['project-registry/1']}});
      if(body.op==='project_list')return route.fulfill({json:{...base,projects:[{id:project.id,title:project.title}],complete:true,total:1}});
      assert.equal(body.op,'project_read','no owner write or lifecycle operation');
      if(body.memberships===true&&failMembership)return route.fulfill({status:400,body:'invalid request'});
      await route.fulfill({json:{...base,project,...(body.settings?{observation_settings:{kind:'project',plan:null,repository:null,source_summaries:[]}}:{}),
        ...(body.memberships===true?{membership:{sessions:[],participations:[],complete:true,omitted_fields:[]}}:{})}});
    });
    const open=async()=>{
      const delivered=page.waitForResponse(response=>response.url().endsWith('/api/projects/v1')&&
        response.request().postDataJSON()?.settings?.kind==='project');
      await enter(page,width===390);await delivered;
      await page.locator('#project-overview h2').filter({hasText:project.title}).waitFor();
    };
    const detailBodies=()=>bodies.filter(body=>{const row=JSON.parse(body);return row.op==='project_read'&&!row.settings;});
    try{
      await open();assert.deepEqual(detailBodies(),['{"op":"project_read","version":1,"project_id":"p"}']);
      await page.locator('#projects-return').click();await continuity(page,sockets,input,false);
      advertised=true;await open();assert.equal(JSON.parse(detailBodies().at(-1)!).memberships,true,'synthetic exact capability enables flag');
      await page.locator('#projects-return').click();
      listBoot='c'.repeat(64);await open();assert.equal(detailBodies().at(-1),'{"op":"project_read","version":1,"project_id":"p"}','stale-boot capability cannot authorize flag');
      await page.locator('#projects-return').click();
      capBoot=listBoot;advertised=false;await open();assert.equal(detailBodies().at(-1),'{"op":"project_read","version":1,"project_id":"p"}','absence retires prior advertised support');
      await page.locator('#projects-return').click();
      const before=detailBodies().length;refused=true;await enter(page,width===390);
      await page.waitForFunction(()=>document.querySelector('#project-workspace-status')?.textContent?.includes('unavailable'));
      assert.equal(detailBodies().length,before,'failed capability cannot reuse previous admission');
      await page.locator('#projects-return').click();
      advertised=true;refused=false;failMembership=true;
      const attempted=detailBodies().length;await enter(page,width===390);
      await page.waitForFunction(()=>document.querySelector('#project-workspace-status')?.textContent?.includes('unavailable'));
      assert.equal(detailBodies().length,attempted+1,'failed strong read is not repeated or downgraded');
      assert.equal(JSON.parse(detailBodies().at(-1)!).memberships,true);
      await page.locator('#projects-return').click();await continuity(page,sockets,input,false);
      assert.ok(bodies.filter(body=>JSON.parse(body).settings).every(body=>!Object.hasOwn(JSON.parse(body),'memberships')));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    }finally{await page.close();}
  });

  test('confirmed creation settles without replay while uncertain status preserves the original intent',async()=>{
    for(const mobile of [false,true])for(const mode of ['confirmed','unknown','wrong-kind','wrong-boot']){
      const {page,input,sockets}=await sessionPage(mobile);let created=null,writes=0;
      await page.route('**/api/projects/v1',async route=>{
        const body=route.request().postDataJSON(),op=body.op,boot='a'.repeat(64),revision='cfg1_'+'b'.repeat(64);
        const base={kind:'mesh-project-reply',version:1,op,boot,status:'ok',machine_id:'local',revision};
        if(op==='project_create'){writes++;created=body.request_id;return route.fulfill({json:writes===1?{...base,status:'uncertain'}:{...base,request_id:created,project_id:created,result:'replayed'}});}
        if(op==='project_status')return route.fulfill({json:{...base,boot:mode==='wrong-boot'?'c'.repeat(64):boot,
          request_id:body.request_id,project_id:body.project_id,intent_state:mode==='unknown'?'unknown':'confirmed',
          intent_kind:mode==='unknown'?null:mode==='wrong-kind'?'settings':'create'}});
        if(op==='project_read')return route.fulfill({json:{...base,project:{id:created,title:'New context',folders_total:0,sources_total:0,sessions_total:0,participations_total:0},omitted_fields:[]}});
        if(op==='project_list')return route.fulfill({json:{...base,projects:created?[{id:created,title:'New context'}]:[],complete:true,total:created?1:0}});
        if(op==='project_capabilities')return route.fulfill({json:{...base,features:['project-registry/1']}});
        return route.fulfill({json:{...base,status:'unsupported'}});
      });
      try{
        await enter(page,mobile);if(mobile)await page.locator('#btn-menu').click();await page.locator('#btn-new').click();
        const dialog=page.getByRole('dialog');await dialog.getByLabel('Project name',{exact:true}).fill('New context');await dialog.getByRole('button',{name:'Create project',exact:true}).click();
        await page.getByRole('button',{name:'Check saved state',exact:true}).waitFor();assert.equal(writes,1);
        await page.getByRole('button',{name:'Check saved state',exact:true}).click();
        if(mode==='confirmed'){await page.locator('.project-overview-heading h2').getByText('New context',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Check saved state',exact:true}).count(),0);}
        else if(mode==='wrong-boot'){
          // A host restart cannot confirm the write: the owner is offered Keep / Retry, never an automatic resend.
          await page.getByRole('button',{name:'Retry original creation',exact:true}).waitFor();
          await page.getByRole('button',{name:'Keep current saved state',exact:true}).waitFor();
        }
        else {await page.waitForFunction(()=>document.querySelector('#project-workspace-status')?.textContent?.match(/unavailable|pending|confirm/i));assert.equal(await page.getByRole('button',{name:'Check saved state',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Retry original creation',exact:true}).count(),0);}
        assert.equal(writes,1,mode+' must not repeat the uncertain creation');
        await page.locator('#projects-return').click();await continuity(page,sockets,input,mobile);
      }finally{await page.close();}
    }
  });

  test('a stored uncertain write without a boot is reviewed, never resent or left blocked',async()=>{
    const {page}=await sessionPage(false);let created:string|null=null,writes=0;
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON(),op=body.op,boot='a'.repeat(64),revision='cfg1_'+'b'.repeat(64);
      const base={kind:'mesh-project-reply',version:1,op,boot,status:'ok',machine_id:'local',revision};
      if(op==='project_create'){writes++;created=body.request_id;return route.fulfill({json:{...base,status:'uncertain'}});}
      if(op==='project_status')return route.fulfill({json:{...base,request_id:body.request_id,project_id:body.project_id,intent_state:'absent',intent_kind:null}});
      if(op==='project_read')return route.fulfill({json:{...base,project:{id:created,title:'New context',folders_total:0,sources_total:0,sessions_total:0,participations_total:0},omitted_fields:[]}});
      if(op==='project_list')return route.fulfill({json:{...base,projects:[],complete:true,total:0}});
      if(op==='project_capabilities')return route.fulfill({json:{...base,features:['project-registry/1']}});
      return route.fulfill({json:{...base,status:'unsupported'}});
    });
    try{
      await enter(page);await page.locator('#btn-new').click();
      const dialog=page.getByRole('dialog');await dialog.getByLabel('Project name',{exact:true}).fill('New context');
      await dialog.getByRole('button',{name:'Create project',exact:true}).click();
      await page.getByRole('button',{name:'Check saved state',exact:true}).waitFor();
      await page.evaluate(()=>{const key='mesh.projects.pending.v1',item=JSON.parse(sessionStorage.getItem(key)!);delete item.boot;sessionStorage.setItem(key,JSON.stringify(item));});
      await page.reload();await enter(page);
      await page.getByRole('button',{name:'Check saved state',exact:true}).click();
      await page.getByRole('button',{name:'Retry original creation',exact:true}).waitFor();
      await page.getByRole('button',{name:'Keep current saved state',exact:true}).waitFor();
      assert.equal(writes,1,'reviewing must not resend the uncertain creation');
    }finally{await page.close();}
  });

  test('Projects contextual New asks for a project name without changing the terminal', async () => {
    const {page,input,sockets}=await sessionPage();
    await page.route('**/api/projects/v1', async route => {
      const op=route.request().postDataJSON().op;
      await route.fulfill({json:{kind:'mesh-project-reply',version:1,op,boot:'a'.repeat(64),
        status:op==='project_list'?'uninitialized':'ok',revision:'cfg1_missing',projects:[],total:0,complete:true,
        features:['project-registry/1'],mode:'normal',store:'unchecked',operations:[],limits:{}}});
    });
    try {
      await enter(page);
      await page.locator('#btn-new').click();
      assert.equal(await page.getByRole('dialog').getByLabel('Project name', {exact:true}).count(),1,
        'Projects New must create project context rather than open a session dialog');
      await page.keyboard.press('Escape');
      await page.locator('#projects-return').click();
      await continuity(page,sockets,input,false);
    } finally {await page.close();}
  });

  test('native whole-field omissions cannot be replaced by title-only settings', async () => {
    const {page,input,sockets}=await sessionPage();
    let submitted;
    await page.route('**/api/projects/v1', async route => {
      const body=route.request().postDataJSON(), op=body.op;
      if(op==='project_settings') submitted=body;
      await route.fulfill({json:{kind:'mesh-project-reply',version:1,op,boot:'a'.repeat(64),status:'ok',
        revision:'cfg1_'+'b'.repeat(64),projects:[{id:'large',title:'Large context'}],total:1,complete:true,
        project:{id:'large',title:'Large context',folders_total:20,sources_total:20,sessions_total:0,participations_total:0},
        omitted_fields:['description','folders','repository','sources']}});
    });
    try {
      await enter(page);
      await page.getByRole('button',{name:'Project settings',exact:true}).click();
      const dialog=page.getByRole('dialog');
      assert.equal(await dialog.getByLabel('Description',{exact:false}).isDisabled(),true);
      assert.equal(await dialog.getByLabel('Local folders',{exact:false}).isDisabled(),true);
      assert.equal(await dialog.getByLabel('Repository URL',{exact:false}).isDisabled(),true);
      assert.equal(await dialog.getByRole('button',{name:'+ Source or workflow',exact:true}).count(),0);
      await dialog.getByLabel('Project name',{exact:true}).fill('Renamed context');
      await dialog.getByRole('button',{name:'Save settings',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
      assert.deepEqual(submitted.patch,{title:'Renamed context'});
      await page.locator('#projects-return').click();
      await continuity(page,sockets,input,false);
    } finally {await page.close();}
  });

  test('unrepresentable folder lines remain read-only while independent settings are editable', async () => {
    const {page,input,sockets}=await sessionPage();
    let submitted;
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON(),op=body.op;
      if(op==='project_settings') submitted=body;
      await route.fulfill({json:{kind:'mesh-project-reply',version:1,op,boot:'a'.repeat(64),status:'ok',
        revision:'cfg1_'+'b'.repeat(64),projects:[{id:'unrepresented',title:'Folder context'}],total:1,complete:true,
        project:{id:'unrepresented',title:'Folder context',folders:['/line\nfolder'],folders_total:1,
          sources_total:0,sessions_total:0,participations_total:0},omitted_fields:[]}});
    });
    try {
      await enter(page);await page.getByRole('button',{name:'Project settings',exact:true}).click();
      const dialog=page.getByRole('dialog');
      assert.equal(await dialog.getByLabel('Local folders',{exact:false}).isDisabled(),true);
      await dialog.getByText('These folder references cannot be edited as separate lines.',{exact:false}).waitFor();
      await dialog.getByLabel('Project name',{exact:true}).fill('Renamed context');
      await dialog.getByRole('button',{name:'Save settings',exact:true}).click();await dialog.waitFor({state:'hidden'});
      assert.deepEqual(submitted.patch,{title:'Renamed context'});
      await page.locator('#projects-return').click();await continuity(page,sockets,input,false);
    } finally {await page.close();}
  });

  for (const width of [390, 800, 850, 900, 1280]) test(`Projects navigation fits and preserves Sessions at ${width}px`, async () => {
    const mobile = width < 760;
    const {page,input,sockets} = await sessionPage(mobile);
    try {
      await page.setViewportSize({width,height:900});
      assert.equal(await page.locator('#btn-sessions').getAttribute('aria-label'),'Sessions mode');
      assert.equal(await page.locator('#btn-projects').getAttribute('aria-label'),'Projects mode');
      if (!mobile) {
        await readableText(page, '.bar-actions button');
        assert.ok(await page.locator('#btn-projects').getAttribute('title'));
      }
      await enter(page,mobile);
      assert.equal(await page.locator('#btn-projects').evaluate(el=>el.classList.contains('on')),true);
      if (!mobile) assert.notEqual(await page.locator('#btn-projects').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
      await page.locator('#projects-return').click();
      assert.equal(await page.locator('#btn-projects').evaluate(el=>el.classList.contains('on')),false);
      await continuity(page,sockets,input,false);
    } finally { await page.close(); }
  });

  for (const mobile of [false, true]) test(`reload preserves Projects mode; explicit session links win (${mobile ? 'phone' : 'desktop'})`, async () => {
    const {page} = await sessionPage(mobile);
    try {
      await enter(page, mobile);
      await page.evaluate(() => { document.querySelector<HTMLInputElement>('#line-text')!.value = ''; });
      await Promise.all([
        page.waitForEvent('load'),
        page.locator('#btn-reload').evaluate((button: HTMLButtonElement) => button.click()),
      ]);
      await page.waitForFunction(() => document.body.classList.contains('projecting'));
      assert.equal(await page.locator('#btn-projects').getAttribute('aria-pressed'), 'true');
      await page.goto(origin + '/?open=session-one');
      await page.waitForFunction('panes.length > 0 && active?.id === "session-one"');
      assert.equal(await page.locator('#btn-sessions').getAttribute('aria-pressed'), 'true');
      await enter(page, mobile);
      await page.locator('#projects-return').click();
      await page.reload();
      await page.waitForFunction('panes.length > 0');
      assert.equal(await page.locator('#btn-sessions').getAttribute('aria-pressed'), 'true');
    } finally { await page.close(); }
  });

  for(const mobile of [false,true]) test(`catalog/detail and return preserve Sessions (${mobile?'phone':'desktop'})`,async()=>{
    const {page,input,sockets,inventories}=await sessionPage(mobile);
    try{
      const descriptors:string[]=[];
      await page.route('**/api/view',async route=>{descriptors.push(route.request().postData()??'');await route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}});});
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:catalog()}));
      await enter(page,mobile);
      await page.locator('#projects-path').fill('/catalog.json');await page.locator('.projects-load button').click();
      await page.locator('.projects-detail h2').waitFor();
      assert.equal(await page.locator('.projects-detail h2').textContent(),'Configured project');
      assert.match(await page.locator('.projects-detail').innerText(),/Roster global acceptance: not accepted/);
      assert.match(await page.locator('.projects-detail').innerText(),/Source total\s+25/);
      assert.match(await page.locator('.projects-detail').innerText(),/additional items: 24/);
      assert.equal(await page.locator('.projects-detail img').count(),0);
      assert.match(await page.locator('.projects-detail').innerText(),/Unresolved references/);
      assert.equal(await page.locator('.projects-detail button').count(),0);
      assert.equal(await page.evaluate('window.injected'),undefined);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
      assert.match(await page.locator('#projects-status').innerText(), /a{64}/);
      await readableText(page,'#projects-status');
      await page.locator('.projects-load button').click();await page.waitForFunction('document.querySelector("#projects-status").textContent.includes("Snapshot generated")');
      assert.equal(descriptors.length,2);
      assert.equal(await page.evaluate('JSON.stringify(localStorage).includes("/view/v2.")'),false);
      const before=inventories(); await page.evaluate('refresh()');assert.ok(inventories()>before);
      await page.locator('#projects-return').click();await continuity(page,sockets,input);
    }finally{await page.close();}
  });

  for(const mobile of [false,true]) test(`pipeline history and current reports stay separate and inert (${mobile?'phone':'desktop'})`,async()=>{
    const {page,input,sockets}=await sessionPage(mobile);
    try{
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:pipelineCatalog()}));
      await enter(page,mobile);await page.locator('#projects-path').fill('/catalog.json');await page.locator('.projects-load button').click();
      await page.locator('.projects-pipeline').waitFor();
      assert.match(await page.locator('.projects-pipeline').innerText(),/Current verdict comparison: disagreement/);
      await page.locator('.projects-pipeline summary').filter({hasText:'Recorded phase history'}).click();
      assert.match(await page.locator('.projects-pipeline').innerText(),/review · NO-GO/);
      assert.match(await page.locator('.projects-pipeline').innerText(),/November 14, 2026 10:00:00 GMT\+0100/);
      await page.locator('.projects-pipeline summary').filter({hasText:'Current review'}).click();
      await page.locator('.projects-pipeline summary').filter({hasText:'Current QA JSON'}).click();
      assert.match(await page.locator('.projects-pipeline').innerText(),/Canonical component summary partial/);
      assert.match(await page.locator('.projects-pipeline').innerText(),/Findings total: unknown/);
      assert.match(await page.locator('.projects-pipeline').innerText(),/round two, date unknown/);
      await page.locator('.projects-pipeline summary').filter({hasText:'Canonical observer coverage'}).click();
      assert.match(await page.locator('.projects-pipeline').innerText(),/standalone-acceptance · unsupported/);
      assert.doesNotMatch(await page.locator('.projects-pipeline').innerText(),/Roster global acceptance/);
      assert.equal(await page.locator('.projects-pipeline img,.projects-pipeline a,.projects-pipeline button').count(),0);
      assert.equal(await page.evaluate('window.injected'),undefined);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      await page.locator('#projects-return').click();await continuity(page,sockets,input);
    }finally{await page.close();}
  });

  test('pipeline disclosure refresh preferences stay scoped to source, project, task and machine',async()=>{
    const {page}=await sessionPage();
    try {
      const current=pipelineCatalog();
      current.projects[0].sources[1]=structuredClone(current.projects[0].sources[0]);
      current.projects[0].sources[1].id='other-roadmap';
      current.projects.push({...structuredClone(current.projects[0]),id:'project_other',title:'Other project'});
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:current}));
      await enter(page);await page.locator('#projects-path').fill('/catalog.json');await page.locator('.projects-load button').click();
      await page.locator('.projects-pipeline').first().waitFor();
      const disclosures=(index:number)=>page.locator('.projects-source').nth(index).locator('details');
      assert.equal(await disclosures(0).count(),5);
      await disclosures(0).evaluateAll(nodes=>nodes.forEach(node=>{(node as HTMLDetailsElement).open=true;}));
      current.projects[0].title='Refreshed title';
      await page.locator('.projects-load button').click();
      await page.waitForFunction(()=>document.querySelector('.projects-detail h2')?.textContent==='Refreshed title');
      assert.deepEqual(await disclosures(0).evaluateAll(nodes=>nodes.map(node=>(node as HTMLDetailsElement).open)),[true,true,true,true,true]);
      assert.deepEqual(await disclosures(1).evaluateAll(nodes=>nodes.map(node=>(node as HTMLDetailsElement).open)),[false,false,false,false,false]);
      await page.locator('[data-project-id="project_other"]').click();
      assert.equal(await page.locator('.projects-pipeline details[open]').count(),0);
      await disclosures(0).first().evaluate(node=>{(node as HTMLDetailsElement).open=true;});
      await page.locator('[data-project-id="stable-id"]').click();
      assert.deepEqual(await disclosures(0).evaluateAll(nodes=>nodes.map(node=>(node as HTMLDetailsElement).open)),[true,true,true,true,true]);
      current.projects[0].sources[0].summary.pipeline.task='other-check';current.projects[0].title='Other task';
      await page.locator('.projects-load button').click();
      await page.waitForFunction(()=>document.querySelector('.projects-detail h2')?.textContent==='Other task');
      assert.equal(await page.locator('.projects-pipeline details[open]').count(),0);
      await disclosures(0).first().evaluate(node=>{(node as HTMLDetailsElement).open=true;});
      await page.locator('[data-project-id="project_other"]').click();
      current.projects[1].title='Other project refreshed';
      await page.locator('.projects-load button').click();
      await page.waitForFunction(()=>document.querySelector('.projects-detail h2')?.textContent==='Other project refreshed');
      current.machine_id='other-machine';current.projects[0].title='Other machine';current.generated_at='2026-11-14T12:01:00Z';
      await page.locator('.projects-load button').click();
      await page.waitForFunction(()=>document.querySelector('.projects-detail h2')?.textContent==='Other machine');
      assert.equal(await page.locator('.projects-detail h2').textContent(),'Other machine');
      assert.equal(await page.locator('.projects-pipeline details[open]').count(),0);
    } finally {await page.close();}
  });

  for(const mobile of [false,true]) test(`recorded participation and channel metadata stay inert (${mobile?'phone':'desktop'})`,async()=>{
    const {page,input,sockets}=await sessionPage(mobile);
    try {
      const value: any = catalog(); value.schema_version = 2; value.features = ['project-metadata/1'];
      value.projects[0].participations = [
        { id: 'link_A', label: '<img src=x onerror="window.injected=true">', recorded_relation: 'saved',
          target: { kind: 'mesh', name: 'session-one', created: 1234.125, machine_id: 'foreign_machine' },
          work_refs: [{ source_id: 'missing_source', kind: 'task', native_id: 'Original:Task-ID' }] },
        { id: 'link_B', recorded_relation: 'historical', target: { kind: 'history', agent: 'codex', conversation_id: 'Original:Conversation-ID' } },
      ];
      value.projects[0].sources[0].channels = [{ id: 'channel_A', label: '#planning', workspace_id: 'workspace_A', native_id: 'Original:Channel-ID' }];
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:value}));
      await enter(page,mobile); await page.locator('#projects-path').fill('/catalog.json'); await page.locator('.projects-load button').click();
      await page.locator('.projects-participations').waitFor({timeout:2000});
      const text = await page.locator('.projects-participations').innerText();
      for (const expected of ['link_A','link_B','foreign_machine','1234.125','Original:Task-ID','Original:Conversation-ID','Runtime target not verified','Source not configured']) assert.ok(text.includes(expected), expected);
      assert.match(await page.locator('.projects-channels').innerText(), /workspace_A/);
      assert.match(await page.locator('.projects-channels').innerText(), /Original:Channel-ID/);
      assert.equal(await page.locator('.projects-participations button,.projects-participations a,.projects-participations img').count(),0);
      await page.locator('.projects-participations h4').first().click();
      assert.equal(await page.evaluate('window.injected'),undefined);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      await page.locator('#projects-return').click(); await continuity(page,sockets,input);
    } finally { await page.close(); }
  });

  for(const mobile of [false,true]) test(`rendered README is secondary, sanitized and retains view preferences (${mobile?'phone':'desktop'})`,async()=>{
    const {page,input,sockets}=await sessionPage(mobile);
    try {
      const value: any = catalog(); value.schema_version = 2; value.features = ['project-metadata/1'];
      const text = '# Project README\n\n<img src=x onerror="window.injected=true">\n' +
        '<button id="btn-new" class="project-followup" data-mobile-action="btn-sessions">Fake control</button>\n\n' +
        '[Safe documentation](https://example.test/docs) [Unsafe](javascript:alert(1)) [Relative](guide.md)\n\n' +
        Array.from({length:100},(_,i)=>`Paragraph ${i}\n\n`).join('');
      const imageRequests: string[] = [];
      page.on('request', request => { if (new URL(request.url()).pathname === '/x') imageRequests.push(request.url()); });
      value.projects[0].repository = { url:'https://example.test/repository', observation: {
        status:'valid',assembled_at:NOW,method:'local-origin-head',reason:null,ref:'refs/remotes/origin/release',commit:'a'.repeat(40),
        readme:{status:'valid',reason:null,path:'README.md',blob:'b'.repeat(40),size:Buffer.byteLength(text),text,truncated:false},
      } };
      value.projects.push({...structuredClone(value.projects[0]),id:'second',title:'Second metadata'});
      let reads=0;
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>{reads++;if(reads>1)value.projects[1].title='Updated metadata';return route.fulfill({json:value});});
      await enter(page,mobile); await page.locator('#projects-path').fill('/catalog.json'); await page.locator('.projects-load button').click();
      await page.locator('[data-project-id="second"]').click();
      await page.locator('.projects-readme-disclosure').waitFor({timeout:2000});
      assert.equal(await page.locator('.projects-readme-disclosure').evaluate((el: HTMLDetailsElement) => el.open), false);
      await page.locator('.projects-readme-disclosure summary').click();
      await page.locator('.projects-readme-preview[data-markdown-state="rendered"]').waitFor();
      assert.equal(await page.locator('.projects-readme-preview h1').textContent(), 'Project README');
      assert.equal(await page.locator('.projects-readme-preview img,.projects-readme-preview script,.projects-readme-preview button,.projects-readme-preview [id],.projects-readme-preview [class],.projects-readme-preview [data-mobile-action]').count(),0);
      assert.equal(await page.locator('.projects-readme-preview a[href]').count(),1);
      assert.equal(await page.locator('.projects-readme-preview a[href]').getAttribute('href'), 'https://example.test/docs');
      assert.deepEqual(imageRequests, []);
      await page.locator('.projects-readme-preview').evaluate(el=>{el.scrollTop=50;});
      assert.equal(await page.locator('.projects-readme-preview').evaluate(el=>el.scrollTop),50);
      await page.locator('.projects-readme-disclosure summary').focus();
      await page.locator('.projects-load').evaluate((el:HTMLFormElement)=>el.requestSubmit());
      await page.waitForFunction('document.querySelector(".projects-detail h2")?.textContent==="Updated metadata"');
      await page.locator('.projects-readme-preview[data-markdown-state="rendered"]').waitFor();
      assert.equal(await page.locator('.projects-readme-disclosure').evaluate((el:HTMLDetailsElement)=>el.open),true);
      assert.equal(await page.locator('.projects-readme-preview').evaluate(el=>el.scrollTop),50);
      assert.equal(await page.locator('.projects-readme-disclosure summary').evaluate(el=>el===document.activeElement),true);
      assert.equal(await page.evaluate('window.injected'),undefined);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      await page.locator('#projects-return').click(); await continuity(page,sockets,input);
    } finally { await page.close(); }
  });

  test('partial and malformed pipeline catalogs preserve exact target, polling and independent output/resize',async()=>{
    const {page,input,sockets,inventories,output}=await sessionPage(true);
    try{
      let current=pipelineCatalog();const p=current.projects[0].sources[0].summary.pipeline;
      Object.assign(p.components.ledger,{availability:'invalid',reason:'domain'});p.mode=null;p.latest_completed=null;p.history={items:[],total:null,truncated:false};
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:current}));
      await enter(page,true);await page.locator('#projects-path').fill('/catalog.json');await page.locator('.projects-load button').click();
      await page.locator('.projects-pipeline').waitFor();
      await page.locator('.projects-pipeline summary').filter({hasText:'Recorded phase history'}).click();
      assert.match(await page.locator('.projects-pipeline').innerText(),/Recorded history is unknown/);
      assert.match(await page.locator('.projects-pipeline').innerText(),/Current review · observed · GO/);
      const before=inventories();output('\r\nPIPELINE_INDEPENDENT_OUTPUT\r\n');
      await page.evaluate('refresh()');assert.ok(inventories()>before);
      await page.waitForFunction(()=>{const b=active.term.buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i)?.translateToString().includes('PIPELINE_INDEPENDENT_OUTPUT'))return true;return false;});
      await page.setViewportSize({width:414,height:896});
      current=pipelineCatalog();current.projects[0].sources[0].summary.pipeline.history.items[0].source_index=99;
      await page.locator('.projects-load button').click();await page.waitForFunction('document.querySelector("#projects-status").textContent.includes("unavailable")');
      assert.equal(await page.locator('.projects-pipeline').count(),0);
      await page.locator('#projects-return').click();await continuity(page,sockets,input,false);
    }finally{await page.close();}
  });

  for(const mobile of [false,true]) test(`long labels and local errors stay readable (${mobile?'phone':'desktop'})`,async()=>{
    // Translation strings can grow independently of provider/schema limits.
    const pageLocale=JSON.parse(fs.readFileSync(path.join(ROOT,'static/i18n/en.json'),'utf8'));
    pageLocale['projects.path']='CatalogPath'.repeat(24);
    pageLocale['projects.unavailable']='Unavailable_'.repeat(24);
    const {page,input,sockets}=await sessionPage(mobile,pageLocale);
    try{
      await enter(page,mobile);
      await page.locator('#projects-path').fill('/catalog.json');
      await page.route('**/api/view',route=>route.fulfill({status:403,body:'refused'}));
      await page.locator('.projects-load button').click();
      await page.waitForFunction('document.querySelector("#projects-status").textContent.startsWith("Unavailable_")');
      await readableText(page,'#projects-status');
      await readableText(page,'.projects-load label');
      assert.equal(await page.locator('#projects-return').isVisible(),true);
      const controls=await page.locator('.projects-load input,.projects-load button,#projects-return').evaluateAll(elements=>elements.map(element=>{
        const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width};}));
      assert.ok(controls.every(rect=>rect.left>=0 && rect.right<=(mobile?390:1280) && rect.width>=44));
      await page.unroute('**/api/view');
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      const value=catalog('ProjectLabel'.repeat(20));value.projects[0].sources[0].label='SourceLabel'.repeat(20);
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({json:value}));
      await page.locator('.projects-load button').click();await page.locator('.projects-detail h2').waitFor();
      await readableText(page,'#projects-status');await readableText(page,'.projects-list button');
      await readableText(page,'.projects-detail h2');await readableText(page,'.projects-source h3');
      await page.locator('#projects-return').click();
      await continuity(page,sockets,input);
    }finally{await page.close();}
  });

  test('module failure and delayed import keep static return and sidebar Sessions navigation',async()=>{
    const {page,input,sockets}=await sessionPage();
    try{
      await page.route('**/static/projects.js?*',route=>route.abort());
      await enter(page);await page.locator('#projects-module-retry').waitFor({state:'visible'});
      await page.locator('#projects-return').click();await continuity(page,sockets,input);
      await page.unroute('**/static/projects.js?*');
      await enter(page);await page.locator('#projects-path').waitFor();
      await page.evaluate('openSession("session-one")');
      assert.equal(await page.locator('#projects').isVisible(),false);await continuity(page,sockets,input);
      // A fresh page avoids the browser cache of a failed module evaluation.
      await page.reload();await page.waitForFunction('panes.length > 0');
      await page.route('**/static/projects.js?*',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue().catch(()=>{});});
      await enter(page);await page.locator('#projects-return').click();await page.waitForTimeout(400);
      assert.equal(await page.locator('#projects').isVisible(),false);
      assert.equal(await page.locator('#projects-path').count(),0);
    }finally{await page.close();}
  });

  for(const mobile of [false,true]) for(const kind of ['artifact','module']) test(`late pipeline ${kind} spans close/reopen and preserves another pane focus (${mobile?'phone':'desktop'})`,async()=>{
    for(const releaseWhileOpen of [true,false]) {
      const {page,input,sockets}=await sessionPage(mobile,undefined,true);
      let release=()=>{},finished=()=>{},requests=0;
      const delayed=new Promise<void>(resolve=>{release=resolve;});
      const done=new Promise<void>(resolve=>{finished=resolve;});
      try{
        await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
        await page.route('**/view/v2.f.test/catalog.json',async route=>{
          if(kind==='artifact') {
            const index=++requests;
            if(index===1){await delayed;await route.fulfill({json:pipelineCatalog('Stale A')}).catch(()=>{});finished();return;}
          }
          await route.fulfill({json:pipelineCatalog('Current B')});
        });
        if(kind==='module') await page.route('**/static/projects.js?*',async route=>{
          const index=++requests;if(index===1){await delayed;await route.continue().catch(()=>{});finished();return;}
          await route.continue();
        });
        await enter(page,mobile);
        if(kind==='artifact'){await page.locator('#projects-path').fill('/a.json');await page.locator('.projects-load button').click();}
        for(let i=0;i<50&&requests===0;i++)await page.waitForTimeout(10);
        assert.equal(requests,1,'first generation is actually pending');
        await page.locator('#projects-return').click();
        // Explicitly select a second mounted terminal while the old generation is pending.
        // Programmatic pane setup follows the same existing fixture pattern as openSession.
        await page.evaluate(()=>{const line=document.querySelector('#line-text');line.value='';line.dispatchEvent(new Event('input',{bubbles:true}));addPane('session-two');});
        await page.waitForFunction('active?.id==="session-two" && active.conn?.terminal?.isOpen()');
        await page.evaluate(()=>{
          const line=document.querySelector('#line-text');line.value='second pane draft';line.dispatchEvent(new Event('input',{bubbles:true}));
          active.focus();observePaneActions(active);window.lateEvidence={pane:active,term:active.term,conn:active.conn,terminal:active.conn.terminal,target:paneTargets.capture(active,true),compose:composeOwner?.target};
        });
        assert.equal(await page.evaluate('!!lateEvidence.target && paneTargets.valid(lateEvidence.target)'),true);
        await enter(page,mobile);await page.locator('#projects-path').fill('/b.json');await page.locator('.projects-load button').click();
        await page.waitForFunction('document.querySelector(".projects-detail h2")?.textContent==="Current B"');
        await page.locator('.projects-pipeline summary').filter({hasText:'Current review'}).click();
        if(releaseWhileOpen) await page.locator('#projects-path').click();
        else {await page.locator('#projects-return').click();await page.evaluate('active.focus()');}
        await page.evaluate(()=>{lateEvidence.focus=document.activeElement;lateEvidence.detail=document.querySelector('.projects-detail h2');});
        release();await done;await page.waitForTimeout(150);
        assert.equal(await page.evaluate(`active===lateEvidence.pane && active.term===lateEvidence.term && active.conn===lateEvidence.conn
          && active.conn.terminal===lateEvidence.terminal && active.id==='session-two' && paneTargets.valid(lateEvidence.target)
          && lateEvidence.target.created===5678 && document.activeElement===lateEvidence.focus
          && composeOwner?.target===lateEvidence.compose && document.querySelector('.projects-detail h2')===lateEvidence.detail`),true);
        assert.equal(await page.locator('.projects-detail h2').textContent(),'Current B');
        assert.equal(await page.locator('#projects').isVisible(),releaseWhileOpen);
        assert.equal(await page.locator('#line-text').inputValue(),'second pane draft');assert.equal(sockets(),2);
        if(releaseWhileOpen) await page.locator('#projects-return').click();
        await page.evaluate('active.conn.terminal.queueInput(new TextEncoder().encode("SECOND_TARGET_CONTINUITY"))');await page.waitForTimeout(30);
        assert.ok(input.some(value=>Buffer.isBuffer(value)&&value.toString()==='SECOND_TARGET_CONTINUITY'));
      }finally{release();await page.close();}
    }
  });

  test('refused/malformed artifacts and late loads remain local and cannot overwrite current selection',async()=>{
    const {page,input,sockets}=await sessionPage();
    try{
      await page.route('**/api/view',route=>route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}));
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({status:403,body:'refused'}));
      await enter(page);await page.locator('#projects-path').fill('/catalog.json');
      await page.locator('.projects-load button').click();await page.waitForFunction('document.querySelector("#projects-status").textContent.includes("unavailable")');
      await page.unroute('**/view/v2.f.test/catalog.json');
      await page.route('**/view/v2.f.test/catalog.json',route=>route.fulfill({body:'{',contentType:'application/json'}));
      await page.locator('.projects-load button').click();await page.waitForFunction('document.querySelector("#projects-status").textContent.includes("unavailable")');
      await page.unroute('**/view/v2.f.test/catalog.json');
      let release:()=>void=()=>{};const delayed=new Promise<void>(resolve=>{release=resolve;});let n=0;
      await page.route('**/view/v2.f.test/catalog.json',async route=>{
        const index=++n;if(index===1)await delayed;
        await route.fulfill({json:pipelineCatalog(index===1?'Stale A':'Current B')}).catch(()=>{});
      });
      await page.locator('.projects-load button').click();await page.waitForTimeout(40);
      await page.locator('.projects-load button').click();await page.waitForFunction('document.querySelector(".projects-detail h2")?.textContent==="Current B"');
      release();await page.waitForTimeout(60);assert.equal(await page.locator('.projects-detail h2').textContent(),'Current B');
      await page.locator('#projects-return').click();await continuity(page,sockets,input);
    }finally{await page.close();}
  });

  test('hung artifact times out while Sessions refresh and return remain available',async()=>{
    const {page,input,sockets,inventories}=await sessionPage();
    try{
      await page.route('**/api/view',async route=>{await new Promise(resolve=>setTimeout(resolve,5500));await route.fulfill({json:{url:'/view/v2.f.test/catalog.json'}}).catch(()=>{});});
      await enter(page);await page.locator('#projects-path').fill('/catalog.json');await page.locator('.projects-load button').click();
      const before=inventories();
      await page.waitForFunction('document.querySelector("#projects-status").textContent.includes("unavailable")',null,{timeout:6500});
      assert.ok(inventories()>before,'normal Sessions polling continues during hung Projects request');
      await page.locator('#projects-return').click();await continuity(page,sockets,input);
    }finally{await page.close();}
  });
});
