// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {fixture,identityHeaders,request,until} from '../checks/dictation-fixture.ts';
import {Dictation,configuration,Fault} from '../backend/dictation.ts';

const insertedConfig=(extra={})=>configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed',...extra})!;
const insertedMeta=(extra={})=>({principal:'owner',client:randomUUID(),request:randomUUID(),session:'alpha',created:1,mime:'audio/webm',...extra});
async function* insertedAudio(){yield Buffer.from('audio');}
const insertedFault=(code:string)=>(error:unknown)=>error instanceof Fault&&error.code===code;

test('inserted settlement is owned, idempotent, text-free and releases only its slot with a fixed tombstone TTL',async()=>{
  let now=0;
  const d=new Dictation(insertedConfig({MESH_WHISPER_RESULT_TTL:'1'}),{now:()=>now,infer:async()=> 'private transcript'});
  try{
    const m=insertedMeta(),p=await d.prepare(m,insertedAudio()),id=p.job.job_id;
    d.commit(m,id,p.preparation);await until(()=>d.read(m,id).state==='ready');
    for(const foreign of [{...m,principal:'other'},{...m,client:randomUUID()}])
      assert.throws(()=>d.settle(foreign,id,'inserted'),insertedFault('not_found'));
    assert.equal(d.read(m,id).text,'private transcript');
    const settled=d.settle(m,id,'inserted');
    assert.deepEqual({...settled},{...p.job,state:'settled',text:null,outcome:'inserted'});
    assert.deepEqual(d.lookup(m,m.request),settled);
    now=999;assert.deepEqual(d.settle(m,id,'inserted'),settled);
    for(const outcome of ['submitted','discarded'] as const)
      assert.throws(()=>d.settle(m,id,outcome),insertedFault('invalid_state'));
    assert.deepEqual(d.cancel(m,id),settled);
    const next=insertedMeta();const replacement=await d.prepare(next,insertedAudio());
    assert.notEqual(replacement.job.job_id,id);
    now=1001;assert.throws(()=>d.read(m,id),insertedFault('not_found'));
    assert.throws(()=>d.lookup(m,m.request),insertedFault('not_found'));
    assert.equal(d.read(next,replacement.job.job_id).state,'queued');
    await assert.rejects(d.prepare(insertedMeta(),insertedAudio()),insertedFault('session_busy'));
    d.commit(next,replacement.job.job_id,replacement.preparation);
    await until(()=>d.read(next,replacement.job.job_id).state==='ready');
    d.settle(next,replacement.job.job_id,'submitted');
    assert.throws(()=>d.settle(next,replacement.job.job_id,'inserted'),insertedFault('invalid_state'));
  }finally{await d.close();}
});

test('settlement rejects values outside the closed outcome enumeration without changing a ready job',async()=>{
  const d=new Dictation(insertedConfig(),{infer:async()=> 'private transcript'});
  try{
    const m=insertedMeta(),p=await d.prepare(m,insertedAudio()),id=p.job.job_id;
    d.commit(m,id,p.preparation);await until(()=>d.read(m,id).state==='ready');
    const before=d.read(m,id),stats=d.stats();
    for(const outcome of ['INSERTED','',null,{},['inserted'],true]){
      assert.throws(()=>d.settle(m,id,outcome as 'inserted'),insertedFault('invalid_request'));
      assert.deepEqual(d.read(m,id),before);assert.deepEqual(d.stats(),stats);
    }
  }finally{await d.close();}
});

test('inserted settlement rejects every non-ready phase without freeing running audio or queue occupancy',async()=>{
  let release!:()=>void,resume!:()=>void,entered!:()=>void;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* receiving(){yield Buffer.from('a');entered();await new Promise<void>(resolve=>resume=resolve);yield Buffer.from('b');}
  const d=new Dictation(insertedConfig({MESH_WHISPER_QUEUE_SIZE:'1'}),{infer:async()=>{await new Promise<void>(resolve=>release=resolve);return 'late private text';}});
  try{
    const a=insertedMeta(),pending=d.prepare(a,receiving());void pending.catch(()=>{});await seen;
    const records=(d as unknown as {records:Map<string,{job:{job_id:string}}>}).records;
    const id=[...records.values()][0]!.job.job_id;
    assert.throws(()=>d.lookup(a,a.request),insertedFault('not_found'));
    const refuse=()=>{const before=d.stats();assert.throws(()=>d.settle(a,id,'inserted'),insertedFault('invalid_state'));assert.deepEqual(d.stats(),before);};
    refuse();resume();const p=await pending;refuse();
    d.commit(a,id,p.preparation);await until(()=>!!release);refuse();
    const b=insertedMeta({session:'beta'}),pb=await d.prepare(b,insertedAudio());d.commit(b,pb.job.job_id,pb.preparation);
    assert.throws(()=>d.settle(b,pb.job.job_id,'inserted'),insertedFault('invalid_state'));
    await assert.rejects(d.prepare(insertedMeta({session:'gamma'}),insertedAudio()),insertedFault('queue_full'));
    d.cancel(a,id);refuse();d.settle(a,id,'discarded');refuse();
    assert.deepEqual(d.stats(),{records:2,bytes:7,active:1,waiting:1});
    d.cancel(b,pb.job.job_id);release();await until(()=>d.stats().active===0);
    assert.equal(d.read(a,id).text,null);assert.equal(d.stats().bytes,0);
  }finally{resume?.();release?.();await d.close();}
  const failed=new Dictation(insertedConfig(),{infer:async()=>{throw Error('private upstream failure');}});
  try{
    const m=insertedMeta(),p=await failed.prepare(m,insertedAudio());failed.commit(m,p.job.job_id,p.preparation);
    await until(()=>failed.read(m,p.job.job_id).state==='error');
    assert.throws(()=>failed.settle(m,p.job.job_id,'inserted'),insertedFault('invalid_state'));
    await assert.rejects(failed.prepare(insertedMeta(),insertedAudio()),insertedFault('session_busy'));
    assert.equal(failed.settle(m,p.job.job_id,'discarded').outcome,'discarded');
  }finally{await failed.close();}
});

test('inserted tombstones retain the record cap and principal revocation removes their authority',async()=>{
  const d=new Dictation(insertedConfig(),{principal:'owner',infer:async()=> 'private transcript'});
  try{
    const m=insertedMeta(),p=await d.prepare(m,insertedAudio());d.commit(m,p.job.job_id,p.preparation);
    await until(()=>d.read(m,p.job.job_id).state==='ready');d.settle(m,p.job.job_id,'inserted');
    for(let i=1;i<256;i++){const n=insertedMeta(),r=await d.prepare(n,insertedAudio());d.cancel(n,r.job.job_id);}
    await assert.rejects(d.prepare(insertedMeta(),insertedAudio()),insertedFault('capacity_full'));
    d.activate('new',1);
    assert.throws(()=>d.settle(m,p.job.job_id,'inserted'),insertedFault('not_found'));
    assert.throws(()=>d.read({...m,principal:'new'},p.job.job_id),insertedFault('not_found'));
    assert.deepEqual(d.stats(),{records:0,bytes:0,active:0,waiting:0});
    await d.prepare(insertedMeta({principal:'new'}),insertedAudio());
  }finally{await d.close();}
});

test('actual HTTP inserted settlement validates ownership, exact JSON, readiness and conflicting repeats without leaking text',async()=>{
  const f=await fixture();
  try{
    f.holdUpstream();f.setResponse('application/json','{"text":"private inserted transcript"}');
    const headers={...f.auth,...identityHeaders()},json={...headers,'Content-Type':'application/json'};
    const admitted=await f.call('/api/transcribe','POST',headers,'audio');assert.equal(admitted.status,202);
    const route=`/api/transcribe/${admitted.body.job_id}`,settle=(body:unknown,h=json)=>f.call(`${route}/settle`,'POST',h,JSON.stringify(body));
    await until(()=>f.upstreamCalls===1);
    const nonready=await settle({outcome:'inserted'});assert.equal(nonready.status,409);assert.equal(nonready.body.error.code,'invalid_state');
    assert.equal((await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'audio')).body.error.code,'session_busy');
    f.releaseUpstream();await until(async()=>(await f.call(route,'GET',headers)).body.state==='ready');
    for(const body of [{outcome:'inserted',extra:true},{outcome:'INSERTED'},{outcome:null},{outcome:['inserted']},{outcome:true},{},['inserted']])
      assert.equal((await settle(body)).status,400,JSON.stringify(body));
    const foreign=await settle({outcome:'inserted'},{...json,'X-Mesh-Dictation-Client':randomUUID()});
    assert.equal(foreign.status,404);assert.equal(foreign.body.text,undefined);
    const settled=await settle({outcome:'inserted'});assert.equal(settled.status,200);
    assert.equal(settled.body.state,'settled');assert.equal(settled.body.outcome,'inserted');assert.equal(settled.body.text,null);
    assert.deepEqual((await settle({outcome:'inserted'})).body,settled.body);
    assert.deepEqual((await f.call(route,'GET',headers)).body,settled.body);
    assert.deepEqual((await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).body,settled.body);
    for(const outcome of ['submitted','discarded'])assert.equal((await settle({outcome})).status,409);
    const next=await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'fresh audio');
    assert.equal(next.status,202);assert.notEqual(next.body.job_id,admitted.body.job_id);
    assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);
    const revoked=await settle({outcome:'inserted'});assert.equal(revoked.status,404);assert.equal(revoked.body.text,undefined);
    assert.ok(f.ops.every(op=>op==='list'),'settlement never sends PTY input');
    assert.doesNotMatch(f.errors,/private inserted transcript/);
  }finally{await f.close();}
});

test('bundle smoke accepts only the exact multipart whitelist and synthetic audio it sends',()=>{
  const source=fs.readFileSync('scripts/smoke-bundle.sh','utf8');
  const validator=/^function assertWhisperMultipart\([^]*?^}/m.exec(source)?.[0];assert.ok(validator,'smoke multipart validator');
  const validate=vm.runInNewContext(`(${validator})`,{assert,Buffer}) as (type:string,body:Buffer,audio:Buffer)=>void;
  const audio=Buffer.from('synthetic bundle audio'),boundary='mesh-fixture';
  const type=`multipart/form-data; boundary=${boundary}`;
  const prefix=`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nfr\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`;
  const body=Buffer.concat([Buffer.from(prefix),audio,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  validate(type,body,audio);
  for(const invalid of [Buffer.from('anything'),body.subarray(1),Buffer.concat([body,Buffer.from('extra')]),
    Buffer.from(body.toString().replace('name="language"','name="extra"')),Buffer.from(body.toString().replace('\r\nfr\r\n','\r\nen\r\n')),
    Buffer.from(body.toString().replace('audio/webm','audio/wav')),Buffer.from(body.toString().replace('synthetic bundle audio','wrong audio')),
    Buffer.from(body.toString().replace('json\r\n','text\r\n')),Buffer.from(body.toString().replace(/\r\n/g,'\n'))])
    assert.throws(()=>validate(type,invalid,audio));
  for(const invalid of ['text/plain','multipart/form-data',`${type}; boundary=other`])assert.throws(()=>validate(invalid,body,audio));
});

test('current worker preserves replacement request mapping after delayed expired receiver cleanup',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-recovery-'));fs.chmodSync(directory,0o700);
  const clock=path.join(directory,'clock'),preload=path.join(directory,'clock.cjs'),socketPath=path.join(directory,'worker.sock'),received=path.join(directory,'received');
  fs.writeFileSync(clock,'0');
  // Test-owned child only: deterministic monotonic time, no production switch.
  fs.writeFileSync(preload,`Object.defineProperty(globalThis.performance,'now',{value:()=>Number(require('node:fs').readFileSync(${JSON.stringify(clock)},'utf8'))});
const http=require('node:http'),fs=require('node:fs'),create=http.createServer;
http.createServer=function(options,listener){return create.call(this,options,(req,res)=>{
 if(req.method==='POST'&&req.url==='/api/transcribe'){const iterator=req.iterator.bind(req);req.iterator=function(options){const source=iterator(options);return(async function*(){for await(const part of source){fs.writeFileSync(${JSON.stringify(received)},'received');yield part;}})();};}
 return listener(req,res);
});};`);
  const secret=randomBytes(32).toString('hex');
  const child=spawn(process.execPath,['--require',preload,path.resolve('backend/dictation-service.cjs')],{env:{PATH:process.env.PATH,MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',p=>output+=p);child.stderr.on('data',p=>errors+=p);
  child.stdin.write(JSON.stringify({secret,socket:socketPath,inventory:path.join(directory,'unused'),parent:process.pid,principal:'a'.repeat(64)})+'\n');
  let slow:http.ClientRequest|undefined;
  try{
    await until(()=>{if(child.exitCode!==null)throw Error(errors);return output.includes('ready\n');});
    const headers={...identityHeaders(),'X-Mesh-Bridge':secret,'X-Mesh-Principal':'a'.repeat(64)};
    const lookup=()=>request({socketPath,path:`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,headers});
    const old=new Promise<{status:number;body:any}>((resolve,reject)=>{
      slow=http.request({socketPath,path:'/api/transcribe',method:'POST',headers:{...headers,'Content-Length':'2'},agent:false},res=>{let body='';res.on('data',p=>body+=p);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));res.on('error',reject);});
      slow.on('error',reject);slow.write('a');
    });
    void old.catch(()=>{});
    await until(()=>fs.existsSync(received));
    assert.equal((await lookup()).status,404,'receiving reservation is not public queued work');
    fs.writeFileSync(clock,'15001');
    assert.equal((await lookup()).status,404,'expired receiving admission swept');
    const replacement=await request({socketPath,path:'/api/transcribe',method:'POST',headers},'b');
    assert.equal(replacement.status,202,JSON.stringify(replacement.body));
    slow!.end('b');assert.equal((await old).status,503,'late old receiver really unwound');
    assert.equal((await lookup()).status,404,'prepared replacement remains hidden until commit');
    const repeated=await request({socketPath,path:'/api/transcribe',method:'POST',headers},'c');
    assert.equal(repeated.status,202);assert.equal(repeated.body.job.job_id,replacement.body.job.job_id);
    const committed=await request({socketPath,path:`/internal/commit/${replacement.body.job.job_id}`,method:'POST',headers:{...headers,'Content-Type':'application/json','X-Mesh-Preparation':replacement.body.preparation}},'{}');
    assert.equal(committed.status,200);
    const recovered=await lookup();assert.equal(recovered.status,200);assert.equal(recovered.body.job_id,replacement.body.job.job_id);
  }finally{
    slow?.destroy();child.stdin.end();
    await until(()=>child.exitCode!==null||child.signalCode!==null);
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

for(const [label,type,text] of [
  ['JSON quotes','application/json','"'.repeat(32700)],
  ['plain backslashes','text/plain','\\'.repeat(32768)],
] as const)test(`actual adapter recovers full escaped transcript: ${label}`,async()=>{
  const f=await fixture();
  try{
    const upstream=type==='application/json'?JSON.stringify({text}):text;
    assert.ok(Buffer.byteLength(upstream)<=65536);
    assert.ok(Buffer.byteLength(text)<=32768);
    f.setResponse(type,upstream);
    const headers={...f.auth,...identityHeaders()};
    const admission=await f.call('/api/transcribe','POST',headers,'audio');
    assert.equal(admission.status,202,JSON.stringify(admission.body));
    // Exercise the actual worker and relay, including JSON escaping overhead.
    const failures:string[]=[];
    for(const route of [`/api/transcribe/${admission.body.job_id}`,`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`]){
      let result=await f.call(route,'GET',headers);
      await until(async()=>{
        if(result.status!==200)return true;
        if(result.body.state!=='processing'&&result.body.state!=='queued')return true;
        result=await f.call(route,'GET',headers);return false;
      });
      if(result.status!==200){failures.push(`${route}: ${result.status} ${JSON.stringify(result.body)}`);continue;}
      assert.equal(result.body.state,'ready');
      assert.equal(result.body.text,text);
      assert.ok(Buffer.byteLength(JSON.stringify(result.body))>65536);
      assert.equal(result.headers['cache-control'],'no-store');
    }
    assert.deepEqual(failures,[],'escaped ready result/lookup must both remain readable');
  }finally{await f.close();}
});

test('actual adapter isolates every public operation from decoded URL syntax',async()=>{
  const f=await fixture();
  try{
    const headers={...f.auth,...identityHeaders(),'X-Mesh-Session':'nonexistent'};
    const ordinary=await f.call('/api/transcribe','POST',headers,'audio');
    assert.equal(ordinary.status,409);assert.equal(ordinary.body.error.code,'stale_session');
    const attacks=[
      '%2e%2e%2f%2e%2e%2fapi%2ftranscribe%23',
      '%2E%2E%2F%2E%2E%2Fapi%2Ftranscribe%23',
      '..%2f..%2fapi%2ftranscribe%23',
      '%2e%2e%2f%2e%2e%2fapi%2ftranscribe%3fignored=',
      '%252e%252e%252f%252e%252e%252fapi%252ftranscribe%2523',
      `${randomUUID()}%23`,`${randomUUID()}%3fignored=`,
      '%2fapi%2ftranscribe','%5c..%5capi%5ctranscribe%23',
    ];
    const leaks:string[]=[];
    for(const id of attacks){
      for(const [method,route] of [
        ['GET',`/api/transcribe/${id}`],['GET',`/api/transcribe/request/${id}`],
        ['POST',`/api/transcribe/${id}/cancel`],['POST',`/api/transcribe/${id}/settle`],
        ['HEAD',`/api/transcribe/${id}`],['PUT',`/api/transcribe/${id}/cancel`],
        ['DELETE',`/api/transcribe/${id}`],['PATCH',`/api/transcribe/${id}/settle`],
        ['OPTIONS',`/api/transcribe/${id}`],
      ]){
        const result=await f.call(route,method,headers,method==='POST'?'audio':'');
        if(![400,404,405].includes(result.status)||result.body?.preparation||result.body?.job)leaks.push(`${method} ${route}: ${result.status} ${JSON.stringify(result.body)}`);
      }
    }
    assert.deepEqual(leaks,[],'encoded public route reached a different private operation');
    assert.equal(f.upstreamCalls,0);
    const valid={...f.auth,...identityHeaders()};
    const job=await f.call('/api/transcribe','POST',valid,'audio');assert.equal(job.status,202);
    const id=job.body.job_id.toUpperCase();
    assert.equal((await f.call(`/api/transcribe/${id}`,'GET',valid)).status,200);
    assert.equal((await f.call(`/api/transcribe/request/${valid['X-Mesh-Request-Id'].toUpperCase()}`,'GET',valid)).status,200);
    assert.equal((await f.call(`/api/transcribe/${id}/cancel`,'POST',{...valid,'Content-Type':'application/json'},'{}')).status,200);
    assert.equal((await f.call(`/api/transcribe/${id}/settle`,'POST',{...valid,'Content-Type':'application/json'},'{"outcome":"discarded"}')).status,200);
    await until(()=>f.ops.every(op=>op==='list'));
  }finally{await f.close();}
});

function physicalLength(file:string,name:string,language:'python'|'typescript'):number {
  const lines=fs.readFileSync(file,'utf8').split('\n');
  const pattern=language==='python'
    ?new RegExp(`^(?:async )?def ${name}\\(`)
    :new RegExp(`^(?:export )?(?:async )?function ${name}\\(`);
  const start=lines.findIndex(line=>pattern.test(line));
  assert.notEqual(start,-1,`${file}: missing ${name}`);
  let end=start+1;
  if(language==='typescript') {
    while(end<lines.length&&!/^}/.test(lines[end]!))end++;
    assert.ok(end<lines.length,`${file}: missing top-level function end`);
  } else {
    while(end<lines.length&&!/^[^\s#]/.test(lines[end]!))end++;
    while(end>start&&!/^\s+\S/.test(lines[end-1]!))end--;
    end--;
  }
  return end-start+1;
}
test('dictation compatibility boundary functions stay within 50 physical lines',()=>{
  for(const name of ['api_dictation','_dictation_exchange','_dictation_internal_headers','_dictation_transfer'])
    assert.ok(physicalLength('server.py',name,'python')<=50,`${name} exceeds 50 lines`);
});
test('typed dictation service functions stay within 50 physical lines',()=>{
  for(const name of ['startService','dispatch'])
    assert.ok(physicalLength('backend/dictation-service.ts',name,'typescript')<=50,`${name} exceeds 50 lines`);
});
