// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';
declare const active: {send(s:string):void};
const helper=path.resolve(import.meta.dirname,'../ocaml/_build/default/bin/mesh_artifacts_main.exe');
const missingHelper=!fs.existsSync(helper) && !process.env.MESH_REQUIRE_ARTIFACTS
  ? 'built mesh-artifacts required; MESH_REQUIRE_ARTIFACTS=1 makes absence fail' : false;

// Auto-discovered by test-local-node.sh and the existing CI Node browser inventory
// (terminal-browser-lib import). No manual browser/macOS allow-list is required.
test('actual Info -> Artifacts, synthetic Notes, durable restart and restore, desktop/mobile EN/FR', {timeout:180000,skip:missingHelper || skip}, async () => {
  const calls:string[] = []; let outage=false; let failStorage=()=>{};
  const upstream=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-only');
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const rpc=JSON.parse(Buffer.concat(chunks).toString());
    if(rpc.method==='notifications/initialized') {res.writeHead(202).end();return;}
    let result:unknown={protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'synthetic',version:'1'}};
    if(rpc.method==='tools/call') {
      calls.push(rpc.params.name);
      if(rpc.params.arguments.label==='disk failure') failStorage();
      if(outage) {res.writeHead(503).end('synthetic outage');return;}
      result={isError:false,content:[],structuredContent:rpc.params.name==='mint_share'
        ? {id:'qa-share',share_url:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/s/qa#synthetic`,scope_path:'qa.md',scope_kind:'note',target_present:false}
        :rpc.params.name==='revoke_share'?{revoked:true}:{status:'ok'}};
    }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'artifacts-actual-'));
  const bearer=path.join(fixture,'synthetic-token');fs.writeFileSync(bearer,'synthetic-only',{mode:0o600});
  const mesh=new TerminalMesh({MESH_ARTIFACTS_CMD:helper,MESH_NOTES_TOKEN_FILE:bearer,MESH_NOTES_MCP_URL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/mcp`});
  try {
    await mesh.start();await mesh.newShell('qa-artifacts');
    let page=await mesh.openPage('qa-artifacts',{width:1440,height:900});
    const tokenFile=path.join(mesh.home,'session-token');
    await page.evaluate(f=>active.send(`printf %s "$MESH_SESSION_TOKEN" > '${f}'\r`),tokenFile);
    for(let n=0;n<100&&!fs.existsSync(tokenFile);n++) await new Promise(r=>setTimeout(r,50));
    let token=fs.readFileSync(tokenFile,'utf8');
    const grant=async()=>{
      const snapshot=await (await fetch(mesh.base+'/api/sessions',{headers:{Authorization:'Bearer '+mesh.token()}})).json();
      const session=snapshot.mesh.find((s:any)=>s.name==='qa-artifacts');assert.ok(session);
      fs.writeFileSync(path.join(mesh.home,'.config/session-mesh/notes-grants.json'),JSON.stringify({version:1,sessions:[{name:session.name,created:session.created,nonce:token.split('.')[2],tools:['create_note','replace_note','mint_share','revoke_share']}]}),{mode:0o600});
    };
    const denied=await fetch(mesh.base+'/api/session-artifacts/@self/notes',{method:'POST',headers:{Authorization:'MeshSession '+token,'Content-Type':'application/json'},body:JSON.stringify({tool:'create_note',arguments:{path:'qa.md',content:'synthetic'}})});
    assert.equal(denied.status,403);assert.equal(calls.length,0);await grant();
    const op=async(tool:string,args:unknown)=>{
      const res=await fetch(mesh.base+'/api/session-artifacts/@self/notes',{method:'POST',headers:{Authorization:'MeshSession '+token,'Content-Type':'application/json'},body:JSON.stringify({tool,arguments:args})});
      const text=await res.text();assert.equal(res.status,200,tool+' failed with status '+res.status);return JSON.parse(text);
    };
    const open=async()=>{
      await page.locator('.p-provenance summary').first().click();
      await page.locator('.p-provenance-body button').filter({hasText:/^(Artifacts|Artefacts)$/}).click();
      await page.locator('dialog.session-artifacts').waitFor();
    };
    const close=async()=>{await page.keyboard.press('Escape');await page.locator('dialog.session-artifacts').waitFor({state:'detached'});assert.match(await page.evaluate(()=>document.activeElement?.textContent||''),/Artifacts|Artefacts/);await page.locator('.p-provenance summary').first().click();};
    assert.equal((await op('create_note',{path:'qa.md',content:'synthetic'})).catalogue,'not-applicable');
    await open();await page.getByText('No confirmed share references for this session.',{exact:true}).waitFor();assert.equal(await page.locator('dialog.session-artifacts a').count(),0);await close();
    const minted=await op('mint_share',{path:'qa.md',label:'QA'});assert.equal(minted.catalogue,'recorded');
    for(const lang of ['en','fr']) for(const width of [1440,390]) {
      await page.close();
      page=await mesh.openPage('qa-artifacts',{width,height:844},()=>{},undefined,{phone:width===390});
      await page.evaluate(l=>localStorage.setItem('mesh.lang',JSON.stringify(l)),lang);await page.reload();
      await page.waitForFunction(l=>document.documentElement.lang===l,lang);
      await open();await page.locator('dialog.session-artifacts a').waitFor();
      assert.equal(await page.locator('dialog.session-artifacts a').getAttribute('rel'),'noopener noreferrer');
      assert.equal(await page.locator('dialog.session-artifacts a').getAttribute('href'),`http://127.0.0.1:${(upstream.address() as {port:number}).port}/s/qa#synthetic`);
      assert.ok((await page.locator('dialog.session-artifacts').boundingBox())!.width<=width);
      if(process.env.MESH_SHOT_DIR) await page.locator('dialog.session-artifacts').screenshot({path:path.join(process.env.MESH_SHOT_DIR,`dialog-${lang}-${width}.png`)});
      await close();
    }
    await mesh.restartServer();await page.reload();await page.locator('.p-provenance summary').first().waitFor();await open();await page.locator('dialog.session-artifacts a').waitFor();await close();
    // The full lifecycle sequence runs once; the display matrix above has four cells.
    const ownerHeaders={Authorization:'Bearer '+mesh.token(),'Content-Type':'application/json'};
    await fetch(mesh.base+'/api/sessions',{headers:ownerHeaders});
    await mesh.restartHost();await page.reload();
    await page.locator('#btn-menu').click();
    await page.locator('#restore-go').waitFor({timeout:30000});
    await page.locator('#restore-go').click();
    await page.waitForFunction(()=>!document.querySelector('#restore-go') || !(document.querySelector('#restore-go') as HTMLElement).offsetParent);
    await page.close();page=await mesh.openPage('qa-artifacts',{width:1440,height:900});
    await open();await page.locator('dialog.session-artifacts a').waitFor();await close();
    fs.rmSync(tokenFile);await page.evaluate(f=>active.send(`printf %s "$MESH_SESSION_TOKEN" > '${f}'\r`),tokenFile);
    for(let n=0;n<100&&!fs.existsSync(tokenFile);n++) await new Promise(r=>setTimeout(r,50));token=fs.readFileSync(tokenFile,'utf8');
    await grant();
    assert.equal((await op('revoke_share',{id:'qa-share'})).catalogue,'recorded');
    await open();await page.getByText(/revoked|révoqué/i).last().waitFor();assert.equal(await page.locator('dialog.session-artifacts a').count(),0);await close();
    const conf=path.join(mesh.home,'.config/session-mesh');failStorage=()=>fs.chmodSync(conf,0o755);
    const partial=await op('mint_share',{path:'qa.md',label:'disk failure'});
    assert.equal(partial.status,'success');assert.equal(partial.catalogue,'not-recorded');
    await open();await page.getByText('Artifact references unavailable. The terminal is unaffected.',{exact:true}).waitFor();assert.equal(await page.locator('dialog.session-artifacts a').count(),0);await close();fs.chmodSync(conf,0o700);
    outage=true;assert.notEqual((await op('mint_share',{path:'qa.md',label:'outage'})).status,'success');
    const terminalWitness=path.join(mesh.home,'terminal-witness');
    await page.evaluate(f=>active.send(`printf terminal-still-works > '${f}'\r`),terminalWitness);
    for(let n=0;n<100&&!fs.existsSync(terminalWitness);n++) await new Promise(r=>setTimeout(r,50));
    assert.equal(fs.readFileSync(terminalWitness,'utf8'),'terminal-still-works');
    const sessions=await (await fetch(mesh.base+'/api/sessions',{headers:ownerHeaders})).json();
    const old=sessions.mesh.find((s:any)=>s.name==='qa-artifacts');assert.ok(old);
    const killed=await fetch(mesh.base+'/api/kill/qa-artifacts',{method:'POST',headers:ownerHeaders,body:JSON.stringify({created:old.created})});assert.equal(killed.status,200);
    await mesh.newShell('qa-artifacts');await page.close();page=await mesh.openPage('qa-artifacts',{width:1440,height:900});
    await open();await page.getByText('No confirmed share references for this session.',{exact:true}).waitFor();assert.equal(await page.locator('dialog.session-artifacts a').count(),0);await close();
    assert.deepEqual(calls,['create_note','mint_share','revoke_share','mint_share','mint_share']);
  } finally {await mesh.stop();await new Promise<void>(r=>upstream.close(()=>r()));fs.rmSync(fixture,{recursive:true,force:true});}
});
