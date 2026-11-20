// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fixture,identityHeaders,until} from '../checks/dictation-fixture.ts';

async function controlled(t:TestContext,childTempDepth=0){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-admission-'));
  fs.chmodSync(directory,0o700);
  const worker=path.join(directory,'worker.cjs'),preload=path.join(directory,'hold.cjs');
  const control=path.join(directory,'control'),release=path.join(directory,'release'),trace=path.join(directory,'trace'),bootstrap=path.join(directory,'bootstrap');
  // This preload runs only in our own worker. It pauses private HTTP replies,
  // without patching Python or adding a route to the application.
  fs.writeFileSync(preload,`const fs=require('node:fs'),http=require('node:http'),create=http.createServer;
const trace=${JSON.stringify(trace)},control=${JSON.stringify(control)},release=${JSON.stringify(release)};
const log=row=>fs.appendFileSync(trace,JSON.stringify(row)+'\\n');
process.stdin.once('data',part=>{const value=JSON.parse(part.toString().split('\\n')[0]);fs.writeFileSync(${JSON.stringify(bootstrap)},JSON.stringify({socket:value.socket}));});
http.createServer=function(options,listener){return create.call(this,options,(req,res)=>{
 log({event:'request',path:req.url});
 const rule=fs.existsSync(control)?JSON.parse(fs.readFileSync(control,'utf8')):null;
 if(rule&&rule.path===req.url){const end=res.end;res.end=function(...args){
  log({event:'held',path:req.url});const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);end.apply(res,args);}},5);return res;
 };}return listener(req,res);
});};`);
  await build({entryPoints:['backend/dictation-main.ts'],outfile:worker,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  t.after(async()=>{try{if(f)await f.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}});
  f=await fixture(true,false,undefined,{workerEntry:worker,workerPreload:preload,childTempDepth});
  const events=():{event:string;path:string}[]=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  return {f,events,pause:(route:string)=>fs.writeFileSync(control,JSON.stringify({path:route})),release:()=>fs.writeFileSync(release,'go'),clearTrace:()=>fs.writeFileSync(trace,''),socket:()=>JSON.parse(fs.readFileSync(bootstrap,'utf8')).socket as string};
}

for(const mode of ['initial liveness','preparation reply','final liveness','commit reply'] as const)
for(const credential of ['cookie','master'] as const)test(`HTTP admission rechecks ${credential} generation after ${mode}`,async t=>{
  const c=await controlled(t),f=c.f;
  const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
  const auth=credential==='cookie'?{Cookie:login.headers['set-cookie']![0]!.split(';')[0]!}:f.auth;
  const headers={...auth,...identityHeaders()};
  if(mode==='commit reply'){
    f.setResponse('application/json','{"text":"synthetic retained text"}');
    const admitted=await f.call('/api/transcribe','POST',headers,'synthetic audio');assert.equal(admitted.status,202);
    await until(async()=>(await f.call(`/api/transcribe/${admitted.body.job_id}`,'GET',headers)).body.state==='ready');
    c.pause(`/internal/commit/${admitted.body.job_id}`);
  }else if(mode==='preparation reply')c.pause('/api/transcribe');
  let held:((created?:number)=>void)|undefined,calls=0;
  if(mode==='initial liveness'||mode==='final liveness')f.onInventory(reply=>{
    calls++;
    if(calls===(mode==='initial liveness'?1:2))held=reply;else reply();
  });
  c.clearTrace();
  const pending=f.call('/api/transcribe','POST',headers,'synthetic audio');
  void pending.catch(()=>{});
  await until(()=>held!==undefined||c.events().some(event=>event.event==='held'));
  const generation=path.join(f.config,'cookie-generation');
  fs.writeFileSync(generation,String(Number(fs.readFileSync(generation,'utf8'))+1));
  if(held)held();else c.release();
  const response=await pending;
  assert.equal(response.status,401,JSON.stringify(response.body));
  assert.doesNotMatch(JSON.stringify(response.body),/synthetic retained text/);
  const operations=c.events().filter(event=>event.event==='request').map(event=>event.path);
  assert.equal(operations.filter(route=>route==='/api/transcribe').length,mode==='initial liveness'?0:1);
  assert.equal(operations.filter(route=>route.startsWith('/internal/commit/')).length,mode==='commit reply'?1:0);
  assert.equal(f.upstreamCalls,mode==='commit reply'?1:0);
});

test('one matching HTTP retry failing liveness cannot abort its successful peer',async t=>{
  const c=await controlled(t),f=c.f,headers={...f.auth,...identityHeaders()};
  const initial:((created?:number)=>void)[]=[],final:((created?:number)=>void)[]=[];
  let calls=0;
  f.onInventory(reply=>{
    calls++;
    if(calls<=2){initial.push(reply);if(initial.length===2)for(const send of initial)send();}
    else if(calls<=4)final.push(reply);
    else reply();
  });
  const one=f.call('/api/transcribe','POST',headers,'synthetic audio');
  const two=f.call('/api/transcribe','POST',headers,'synthetic retry');
  void one.catch(()=>{});void two.catch(()=>{});
  await until(()=>final.length===2);
  assert.equal(f.upstreamCalls,0);
  final[0]!(2);
  const failed=await Promise.race([one,two]);assert.equal(failed.status,409);
  assert.equal(f.upstreamCalls,0,'no inference before the remaining attempt commits');
  final[1]!();
  const responses=await Promise.all([one,two]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[202,409]);
  const accepted=responses.find(response=>response.status===202)!;
  await until(async()=>(await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).body.state==='ready');
  assert.equal((await f.call(`/api/transcribe/${accepted.body.job_id}`,'GET',headers)).body.state,'ready');
  assert.equal(f.upstreamCalls,1);
  assert.equal(c.events().some(event=>event.path.startsWith('/internal/abort/')),false);
});

test('HTTP lookup hides a prepared reservation before and after failed final admission',async t=>{
  const c=await controlled(t),f=c.f,headers={...f.auth,...identityHeaders()};
  let calls=0,final:((created?:number)=>void)|undefined;
  f.onInventory(reply=>{if(++calls===2)final=reply;else reply();});
  const pending=f.call('/api/transcribe','POST',headers,'synthetic audio');
  void pending.catch(()=>{});
  await until(()=>final!==undefined);
  const lookup=()=>f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers);
  assert.equal((await lookup()).status,404,'private preparation is not admitted work');
  final!(2);assert.equal((await pending).status,409);
  assert.equal((await lookup()).status,404,'failed admission cannot leave a public queued job');
  assert.equal(f.upstreamCalls,0);
});

test('deep child TMPDIR does not lengthen the private worker socket or break the connector',async t=>{
  const c=await controlled(t,8),f=c.f;
  assert.equal((await f.call('/api/transcribe/config','GET',f.auth)).body.enabled,true);
  const socket=c.socket();assert.ok(Buffer.byteLength(socket)<100,socket);
  assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
  const headers={...f.auth,...identityHeaders()};
  const admitted=await f.call('/api/transcribe','POST',headers,'synthetic audio');assert.equal(admitted.status,202);
  await until(async()=>(await f.call(`/api/transcribe/${admitted.body.job_id}`,'GET',headers)).body.state==='ready');
  assert.equal(f.upstreamCalls,1);
});
