// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {test} from 'node:test';
import {TerminalMesh,skip} from './terminal-browser-lib.ts';
import {REPO,removeScratch} from './mesh-server-lib.ts';

test('current Work Projects attach canonical IDs, preserve receipts and detach after restart without Notes grants', {skip,timeout:90000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-tools-browser-'));
  const tracker=path.join(root,'tracker'),registration=path.join(root,'registration.json');
  fs.cpSync(path.join(REPO,'ocaml/worklog/test/fixture'),tracker,{recursive:true});
  fs.mkdirSync(path.join(tracker,'.git'),{mode:0o700});
  fs.appendFileSync(path.join(tracker,'events','2026-11.hosta.jsonl'),'\n'+JSON.stringify({
    ts:'2026-11-11T00:00:00Z',task:'P-aabb',type:'project_created',title:'Delivery rollout',product:'gateway',category:'platform'})+'\n');
  const stat=fs.statSync(tracker),git=fs.statSync(path.join(tracker,'.git'));
  fs.writeFileSync(registration,JSON.stringify({version:1,instance_id:'a'.repeat(64),
    root_dev:String(stat.dev),root_ino:String(stat.ino),git_dev:String(git.dev),git_ino:String(git.ino)}),{mode:0o600});
  const mesh=new TerminalMesh({WL_HOME:tracker,MESH_WORK_INSTANCE_REGISTRATION:registration,
    MESH_WORK_READ_CMD:process.env.MESH_WORK_READ_CMD || path.join(REPO,'ocaml/_build/default/work_read/bin/work_read_main.exe'),
    MESH_ARTIFACTS_CMD:process.env.MESH_ARTIFACTS_CMD || path.join(REPO,'ocaml/_build/default/bin/mesh_artifacts_main.exe')});
  try {
    await mesh.start();await mesh.newShell('canonical-first');await mesh.newShell('canonical-tools');
    const page=await mesh.openPage('canonical-tools',{width:1440,height:900},()=>{
      sessionStorage.setItem('mesh.workView',JSON.stringify({schema:2,place:{project:'P-5e6f',tab:'board'},drafts:{}}));
      const start=window.setTimeout.bind(window);
      window.setTimeout=((action:TimerHandler,delay=0,...args:unknown[])=>{
        const id=start(action,delay,...args);
        if(delay===15000)(window as any).runCanonicalProjectPoll=()=>{
          clearTimeout(id);if(typeof action==='function')action(...args);
        };
        return id;
      }) as typeof window.setTimeout;
    });
    await page.locator('#btn-projects').click();
    const tools=page.locator('.work-project > .work-session-tools');
    await tools.getByRole('button',{name:'Attach session tools',exact:true}).waitFor();
    const session = tools.getByLabel('Exact live Mesh session');
    const target = session.locator('option').filter({hasText: /^canonical-tools/});
    await target.waitFor({state:'attached'});
    await session.selectOption(await target.getAttribute('value') ?? '');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/sessions') &&
      response.request().method() === 'GET');
    await tools.getByRole('button',{name:'Refresh',exact:true}).click();
    await refreshed;
    await tools.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    assert.match(await session.locator('option:checked').innerText(), /^canonical-tools/);
    const saving=page.waitForResponse(response=>response.request().method()==='POST' &&
      response.url().endsWith('/api/projects/v1') && response.request().postDataJSON()?.action==='attach');
    await tools.getByRole('button',{name:'Attach session tools',exact:true}).click();
    const saved=await saving;assert.equal(saved.status(),200,await saved.text());
    const savedBody=await saved.json();assert.equal(savedBody.status,'confirmed',JSON.stringify(savedBody));
    await tools.getByRole('button',{name:'Detach session tools',exact:true}).waitFor();
    assert.equal(await tools.getByRole('button',{name:'Artifacts',exact:true}).isDisabled(),false,
      'identity object key order must not disable the exact live association');
    const file=path.join(mesh.home,'.config/session-mesh/work-session-tools.json');
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(stored.bindings.length,1);
    assert.deepEqual([stored.bindings[0].context.instance_id,stored.bindings[0].context.project_id,stored.bindings[0].context.product_id],
      ['a'.repeat(64),'P-5e6f','relay'],'same title in gateway never changes canonical scope');
    assert.equal(fs.existsSync(path.join(mesh.home,'.config/session-mesh/notes-grants.json')),false);
    const scope=stored.bindings[0].context;
    const denied=await page.request.post(mesh.base+'/api/projects/v1',{headers:{Authorization:`Bearer ${mesh.token()}`},
      data:{op:'work-tools',action:'read',context:scope,session:null,request_id:null,revision:null}});
    assert.equal(denied.status(),401,'master bearer is not an owner write credential');
    const restartedReads: {path: string; status: number; complete?: boolean}[] = [];
    page.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (!['/api/work/v1', '/api/projects/v1', '/api/sessions'].includes(pathname)) return;
      const body = await response.json().catch(() => null);
      restartedReads.push({path: pathname, status: response.status(), complete: body?.complete});
    });
    await mesh.restartServer();await page.reload();
    if(!await page.evaluate(()=>document.body.classList.contains('projecting')))await page.locator('#btn-projects').click();
    await tools.getByRole('button',{name:'Detach session tools',exact:true}).waitFor().catch(error => {
      throw new Error(`Attachment unavailable after restart: ${JSON.stringify(restartedReads.slice(0, 20))}`, {cause: error});
    });
    let drop=true;
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON();
      if(drop && body?.op==='work-tools' && body.action==='detach') {
        drop=false;await route.fetch();await route.abort();return;
      }
      await route.continue();
    });
    await tools.getByRole('button',{name:'Detach session tools',exact:true}).click();
    await tools.getByRole('button',{name:'Check uncertain save',exact:true}).click({trial:true});
    await page.evaluate(()=>(window as any).pendingAttachmentControl=document.querySelector('.work-project > .work-session-tools'));
    fs.appendFileSync(path.join(tracker,'events','2026-11.hosta.jsonl'),'\n'+JSON.stringify({
      ts:'2026-11-12T00:00:00Z',task:'P-5e6f',type:'set',field:'title',to:'Refreshed canonical project'})+'\n');
    await page.evaluate(()=>{
      const now=Date.now.bind(Date);Date.now=()=>now()+6000;
      (window as any).runCanonicalProjectPoll();
    });
    await page.locator('.work-crumb-title').filter({hasText:'Refreshed canonical project'}).waitFor();
    assert.equal(await page.evaluate(()=>(window as any).pendingAttachmentControl===
      document.querySelector('.work-project > .work-session-tools')),true,'background polling preserves the pending-intent control');
    assert.equal(await tools.getByRole('button',{name:'Attach session tools',exact:true}).isDisabled(),true);
    assert.equal(await tools.getByRole('button',{name:'Check uncertain save',exact:true}).isDisabled(),false);
    await tools.getByRole('button',{name:'Check uncertain save',exact:true}).click();
    await tools.getByRole('button',{name:'Detach session tools',exact:true}).waitFor({state:'detached'});
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).bindings.length,0,'receipt-bound detach rereads without replay');
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).revision,2,'one attach and one detach');
    fs.renameSync(path.join(tracker,'.git'),path.join(tracker,'.git-old'));fs.mkdirSync(path.join(tracker,'.git'));
    await tools.getByRole('button',{name:'Refresh',exact:true}).click();
    await tools.getByRole('button',{name:'Attach session tools',exact:true}).waitFor();
    assert.equal(await tools.getByRole('button',{name:'Attach session tools',exact:true}).isDisabled(),true);
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).revision,2,'replacement never rebinds or mutates saved metadata');
  }finally{await mesh.stop();removeScratch(root);}
});

test('real pane Tools canonical selector fences delayed reads/saves and refreshes across both bundles', {skip,timeout:90000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-tools-races-'));
  const tracker=path.join(root,'tracker'),registration=path.join(root,'registration.json');
  fs.cpSync(path.join(REPO,'ocaml/worklog/test/fixture'),tracker,{recursive:true});
  fs.mkdirSync(path.join(tracker,'.git'),{mode:0o700});
  fs.appendFileSync(path.join(tracker,'events','2026-11.hosta.jsonl'),'\n'+JSON.stringify({
    ts:'2026-11-11T00:00:00Z',task:'P-aabb',type:'project_created',title:'Delivery rollout',product:'gateway',category:'platform'})+'\n');
  const stat=fs.statSync(tracker),git=fs.statSync(path.join(tracker,'.git'));
  fs.writeFileSync(registration,JSON.stringify({version:1,instance_id:'a'.repeat(64),
    root_dev:String(stat.dev),root_ino:String(stat.ino),git_dev:String(git.dev),git_ino:String(git.ino)}),{mode:0o600});
  const mesh=new TerminalMesh({WL_HOME:tracker,MESH_WORK_INSTANCE_REGISTRATION:registration,
    MESH_WORK_READ_CMD:process.env.MESH_WORK_READ_CMD || path.join(REPO,'ocaml/_build/default/work_read/bin/work_read_main.exe'),
    MESH_ARTIFACTS_CMD:process.env.MESH_ARTIFACTS_CMD || path.join(REPO,'ocaml/_build/default/bin/mesh_artifacts_main.exe')});
  let release=()=>{},releaseContext=()=>{},releaseSent=()=>{};
  const gateReady=async(p:Promise<void>,label:string)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([p,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(Error(`request gate not reached: ${label}`)),5000);
    })]);}finally{clearTimeout(timer);}
  };
  try {
    await mesh.start();await mesh.newShell('canonical-fixed');await mesh.newShell('canonical-other');
    const page=await mesh.openPage('canonical-fixed',{width:1440,height:900},()=>{
      sessionStorage.setItem('mesh.workView',JSON.stringify({schema:2,place:{project:'P-5e6f',tab:'reprise'},drafts:{}}));
    });
    // Mount Projects from work-view.js, then open Tools from pane-actions.js.
    await page.locator('#btn-projects').click();
    const project=page.locator('.work-project > .work-session-tools');
    await project.getByRole('button',{name:'Attach session tools',exact:true}).waitFor();
    await page.locator('#btn-sessions').click();
    await page.locator('.p-tools summary').first().click();
    await page.locator('.p-tools-body button').filter({hasText:'Project attachment'}).click();
    const dialog=page.locator('dialog.session-project-tools');
    const choose=dialog.getByLabel('Work project and product');
    const relay=await choose.locator('option').filter({hasText:'relay / P-5e6f — Delivery rollout'}).getAttribute('value');
    const gateway=await choose.locator('option').filter({hasText:'gateway / P-aabb — Delivery rollout'}).getAttribute('value');
    assert.ok(relay!==null && gateway!==null);
    await choose.selectOption(relay);
    const pane=dialog.locator('.work-session-tools');
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    assert.equal(await pane.getByLabel('Exact live Mesh session').locator('option').count(),1);
    assert.match(await pane.getByLabel('Exact live Mesh session').innerText(),/canonical-fixed/);
    assert.doesNotMatch(await pane.getByLabel('Exact live Mesh session').innerText(),/canonical-other/);
    // Keep the actual pane dialog mounted while the real Projects entry point
    // mounts the other generated bundle (the modal makes background clicks inert).
    await page.locator('#btn-projects').evaluate((b:HTMLButtonElement)=>b.click());
    await project.getByRole('button',{name:'Attach session tools',exact:true}).waitFor();

    // Hold the older Project read at revision 0. A pane save must invalidate that
    // busy view, even though it came from a separately bundled module instance.
    let held=false,reads=0;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let sawHeld=()=>{};
    const holding=new Promise<void>(resolve=>{sawHeld=resolve;});
    const writes:{context:{project_id:string;product_id:string};session:{name:string}}[]=[];
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON();
      if(body?.op==='work-tools' && ['attach','detach'].includes(body.action))writes.push(body);
      if(body?.op==='work-tools' && body.action==='read' && body.context.project_id==='P-5e6f') {
        reads++;
        if(!held) {held=true;const response=await route.fetch();sawHeld();await gate;await route.fulfill({response});return;}
      }
      await route.continue();
    });
    // The hidden mounted Project control is deliberately exercised without
    // changing selection or replacing its DOM.
    await page.waitForFunction((b:HTMLButtonElement)=>{
      if(!b.isConnected || b.disabled)return false;
      b.click();return true;
    },await project.getByRole('button',{name:'Refresh',exact:true}).elementHandle());
    await gateReady(holding,'older Projects read');
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click();
    await pane.getByRole('button',{name:'Detach session tools',exact:true}).waitFor();
    release();
    await project.getByRole('button',{name:'Detach session tools',exact:true}).waitFor({state:'attached',timeout:5000});
    assert.ok(reads>=3,'older busy projection drains the invalidation and rereads');
    assert.equal(writes.length,1);
    assert.equal(writes[0].context.project_id,'P-5e6f');
    assert.equal(writes[0].context.product_id,'relay');
    assert.equal(writes[0].session.name,'canonical-fixed');
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});

    // Delay a canonical context recheck before send, then change the selector.
    let contextHeld=false,sawContext=()=>{};
    const contextGate=new Promise<void>(resolve=>{releaseContext=resolve;});
    const contextSeen=new Promise<void>(resolve=>{sawContext=resolve;});
    await page.route('**/api/work/v1',async route=>{
      const body=route.request().postDataJSON();
      if(!contextHeld && body?.op==='attachment-context' && body.args.project==='P-5e6f') {
        contextHeld=true;const response=await route.fetch();sawContext();await contextGate;await route.fulfill({response});return;
      }
      await route.continue();
    });
    await pane.getByRole('button',{name:'Detach session tools',exact:true}).click();
    await gateReady(contextSeen,'pre-send context');await choose.selectOption(gateway);
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    releaseContext();
    await page.unroute('**/api/work/v1');
    // A subsequent canonical read is an ordering barrier, not a timed sleep.
    await pane.getByRole('button',{name:'Refresh',exact:true}).click();
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    assert.equal(writes.length,1,'old pre-send intent never redirects to the selected homonym');
    const file=path.join(mesh.home,'.config/session-mesh/work-session-tools.json');
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(stored.revision,1);
    assert.equal(stored.bindings[0].context.project_id,'P-5e6f');
    assert.equal(stored.bindings[0].session.name,'canonical-fixed');

    // A mutation already sent belongs to its original scope even if its reply
    // arrives after selection changes. The durable receipt must say the same.
    await choose.selectOption(relay);
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    let sent=false,sawSent=()=>{};
    const sentGate=new Promise<void>(resolve=>{releaseSent=resolve;});
    const sentSeen=new Promise<void>(resolve=>{sawSent=resolve;});
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON();
      if(!sent && body?.op==='work-tools' && body.action==='detach') {
        sent=true;writes.push(body);const response=await route.fetch();sawSent();
        await sentGate;await route.fulfill({response});return;
      }
      await route.fallback();
    });
    await pane.getByRole('button',{name:'Detach session tools',exact:true}).click();
    await gateReady(sentSeen,'sent detach response');await choose.selectOption(gateway);
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    releaseSent();
    await project.getByRole('button',{name:'Detach session tools',exact:true}).waitFor({state:'detached',timeout:5000});
    const afterSent=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(afterSent.revision,2);assert.deepEqual(afterSent.bindings,[]);
    assert.equal(afterSent.receipts[0].context.project_id,'P-5e6f');
    assert.equal(afterSent.receipts[0].context.product_id,'relay');
    assert.equal(writes.length,2,'no mutation is redirected to the newly selected project');

    // Preserve uncertain intent while another mounted view confirms a change.
    // The hint must wait, not clear the intent or replay it.
    await choose.selectOption(relay);
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    let drop=true;
    await page.route('**/api/projects/v1',async route=>{
      const body=route.request().postDataJSON();
      if(drop && body?.op==='work-tools' && body.action==='attach') {
        drop=false;writes.push(body);await route.fetch();await route.abort();return;
      }
      await route.fallback();
    });
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click();
    await pane.getByRole('button',{name:'Check uncertain save',exact:true}).click({trial:true});
    await project.getByRole('button',{name:'Refresh',exact:true}).evaluate((b:HTMLButtonElement)=>b.click());
    await project.getByRole('button',{name:'Detach session tools',exact:true}).waitFor({state:'attached'});
    await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.work-project > .work-session-tools > button:nth-last-child(3)')?.disabled);
    await project.getByRole('button',{name:'Detach session tools',exact:true}).evaluate((b:HTMLButtonElement)=>b.click());
    await project.getByRole('button',{name:'Detach session tools',exact:true}).waitFor({state:'detached'});
    assert.equal(await pane.getByRole('button',{name:'Attach session tools',exact:true}).isDisabled(),true);
    assert.equal(await pane.getByRole('button',{name:'Check uncertain save',exact:true}).isDisabled(),false);
    const recovered=page.waitForResponse(r=>r.url().endsWith('/api/projects/v1') && r.request().postDataJSON()?.action==='status');
    await pane.getByRole('button',{name:'Check uncertain save',exact:true}).click();
    const receipt=await (await recovered).json();
    assert.equal(receipt.receipt.action,'attach');assert.equal(receipt.receipt.context.project_id,'P-5e6f');
    await pane.getByRole('button',{name:'Attach session tools',exact:true}).click({trial:true});
    assert.equal(await pane.getByRole('button',{name:'Detach session tools',exact:true}).count(),0);
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).revision,4,'no uncertain mutation replay');
    assert.ok(writes.every(w=>w.context.project_id==='P-5e6f' && w.context.product_id==='relay'));
  }finally{release();releaseContext();releaseSent();await mesh.stop();removeScratch(root);}
});
