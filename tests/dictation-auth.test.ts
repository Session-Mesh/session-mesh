// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {randomUUID, randomBytes, createHmac} from 'node:crypto';
import {configuration,Fault} from '../backend/dictation.ts';
import {liveInventory, startService} from '../backend/dictation-service.ts';
import {fixture,identityHeaders,request,until,processBirth,processState, staticDictationInventory} from '../checks/dictation-fixture.ts';

for(const [label,kind,malformed,expected] of [
  ['accepts a valid C inventory frame',67,false,true],
  ['rejects a valid inventory payload in a non-C frame',68,false,false],
  ['rejects the unsupported J reply kind',74,false,false],
  ['rejects malformed UTF-8 in a non-target inventory field',67,true,false],
] as const)test(`liveInventory ${label}`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-inventory-'));
  const socketPath=path.join(directory,'inventory.sock');
  const valid=Buffer.from(JSON.stringify([{name:'alpha',created:1,activity:1,pid:123,cwd:'INVALID_UTF8',attached:0,meta:{}}]));
  const marker=Buffer.from('INVALID_UTF8'),offset=valid.indexOf(marker);
  const payload=malformed?Buffer.concat([valid.subarray(0,offset),Buffer.from([0xff]),valid.subarray(offset+marker.length)]):valid;
  const commands:unknown[]=[],requestKinds:number[]=[];
  const server=net.createServer(socket=>{
    let input=Buffer.alloc(0),replied=false;
    socket.on('error',()=>{});
    socket.on('data',(chunk:Buffer)=>{
      input=Buffer.concat([input,chunk]);
      if(replied||input.length<5||input.length<input.readUInt32BE(1)+5)return;
      replied=true;requestKinds.push(input[0]!);commands.push(JSON.parse(input.subarray(5).toString('utf8')));
      const header=Buffer.alloc(5);header[0]=kind;header.writeUInt32BE(payload.length,1);
      socket.end(Buffer.concat([header,payload]));
    });
  });
  try{
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));
    const observed=liveInventory(socketPath,{principal:'owner',client:randomUUID(),request:randomUUID(),session:'alpha',created:1,mime:'audio/webm'});
    if(expected)assert.equal(await observed,true);
    else await assert.rejects(observed,error=>error instanceof Fault&&error.code==='unavailable');
    assert.deepEqual(commands,[{op:'list'}]);
    assert.deepEqual(requestKinds,[67],'inventory requests use the existing C control protocol');
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('liveInventory has a total deadline even while reply bytes arrive', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-inventory-'));
  const socketPath = path.join(directory, 'inventory.sock');
  let finishedSending = false;
  const server = net.createServer({allowHalfOpen: true}, socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      const header = Buffer.alloc(5);
      header[0] = 67;
      header.writeUInt32BE(4096, 1);
      socket.write(header);
      const drip = setInterval(() => socket.write(' '), 75);
      const end = setTimeout(() => {
        finishedSending = true;
        socket.end();
      }, 1800);
      socket.once('close', () => {
        clearInterval(drip);
        clearTimeout(end);
      });
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await assert.rejects(liveInventory(socketPath, {
      principal: 'owner', client: randomUUID(), request: randomUUID(),
      session: 'alpha', created: 1, mime: 'audio/webm',
    }), error => error instanceof Fault && error.code === 'unavailable');
    assert.equal(finishedSending, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('private Unix service requires bridge secret, opaque principal, exact headers/JSON; prepare never infers before commit',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-private-'));fs.chmodSync(directory,0o700);
  const secret=randomBytes(32).toString('hex'),socketPath=path.join(directory,'worker.sock');
  const inventory = await staticDictationInventory(directory);
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'})!,secret,socketPath,inventory.socketPath,'a'.repeat(64));
  try{
    assert.equal(fs.statSync(socketPath).mode&0o777,0o600);
    const base={'X-Mesh-Bridge':secret,'X-Mesh-Principal':'a'.repeat(64),...identityHeaders()};
    const call=(p:string,method='GET',headers:any=base,body='')=>request({socketPath,path:p,method,headers},body);
    assert.equal((await call('/api/transcribe/config','GET',{})).status,400);
    assert.equal((await call('/api/transcribe/config','GET',{'X-Mesh-Bridge':'wrong','X-Mesh-Principal':'a'.repeat(64)})).status,403);
    assert.equal((await call('/api/transcribe/config','GET',{...base,'X-Mesh-Principal':'cookie'})).status,400);
    assert.equal((await call('/api/transcribe?url=http://attacker','POST',base,'a')).status,400);
    assert.equal((await call('/api/transcribe','POST',{...base,'Content-Encoding':'gzip'},'a')).status,400);
    assert.equal((await call('/api/transcribe','POST',{...base,'X-Mesh-Created':['1','1']},'a')).status,400);
    const p=await call('/api/transcribe','POST',base,'a');assert.equal(p.status,202);assert.equal(p.body.job.state,'queued');
    const id=p.body.job.job_id;
    assert.equal(service.engine.stats().active,0);
    assert.equal((await call(`/api/transcribe/${id}`,'GET',{...base,'X-Mesh-Principal':'b'.repeat(64)})).status,404);
    assert.equal((await call(`/api/transcribe/${id}`,'GET',{...base,'X-Mesh-Dictation-Client':randomUUID()})).status,404);
    for(const [suffix,body] of [['cancel','{"extra":1}'],['settle','{"outcome":"submitted","x":1}'],['settle','{"outcome":false}'],['cancel','x'.repeat(1025)]])assert.equal((await call(`/api/transcribe/${id}/${suffix}`,'POST',{...base,'Content-Type':'application/json'},body)).status,400);
    const internal={...base,'Content-Type':'application/json','X-Mesh-Preparation':p.body.preparation};
    assert.equal((await call(`/internal/commit/${id}`,'POST',{...internal,'X-Mesh-Bridge':'wrong'},'{}')).status,403);
    assert.equal((await call(`/internal/commit/${id}`,'POST',internal,'{}')).status,200);
    assert.equal((await call(`/internal/commit/${id}`,'POST',internal,'{}')).status,200);
    await until(()=>service.engine.read({principal:base['X-Mesh-Principal'],client:base['X-Mesh-Dictation-Client']},id).state==='error');
    assert.equal((await call(`/api/transcribe/${id}`)).body.error.code,'upstream_unavailable');
  }finally{await service.close();await inventory.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual server default-off requires no Node; owner only config and safe disabled response',async()=>{
  const f=await fixture(false,true,'/nonexistent/node');
  try{
    assert.deepEqual((await f.call('/api/transcribe/config','GET',f.auth)).body,{enabled:false,disabled_reason:'not_configured'});
    assert.equal((await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'a')).body.error.code,'disabled');
    assert.equal(fs.readdirSync(f.directory).some(n=>n.startsWith('mesh-dictation-')),false);
  }finally{await f.close();}
});

test('actual server uses the configured absolute Node path with spaces and no ambient Node',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-node-'));
  const runtime=path.join(directory,'runtime node');
  fs.symlinkSync(process.execPath,runtime);
  try{
    const f=await fixture(true,true,runtime);
    try{assert.equal((await f.call('/api/transcribe/config','GET',f.auth)).body.enabled,true);}
    finally{await f.close();}
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('configured Node is a plain executable path, not a command or shell fragment',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-node-command-'));
  const marker=path.join(directory,'must-not-exist');
  try{
    for(const runtime of [`${process.execPath}; touch ${marker}`,'node --eval anything']){
      const f=await fixture(true,false,runtime);
      try{assert.equal((await f.call('/api/transcribe/config','GET',f.auth)).body.enabled,false);}
      finally{await f.close();}
    }
    assert.equal(fs.existsSync(marker),false);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual HTTP adapter denies session/document/Origin, discards forged private headers; generation and page isolation',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.call('/api/transcribe/config','GET',{...f.auth,Origin:'https://evil.test'})).status,403);
    const nonce='a'.repeat(32),key=createHmac('sha256',f.token).update('session-mesh/session-token/v1').digest();
    const mac=createHmac('sha256',key).update(`ms1\0alpha\0${nonce}`).digest('hex');
    const session={Authorization:`MeshSession ms1.alpha.${nonce}.${mac}`};
    assert.equal((await f.call('/api/transcribe/config','GET',session)).status,401);
    assert.equal((await f.call('/api/transcribe/config?view=forged')).status,401);
    assert.equal((await f.call('/api/transcribe/config?x=1','GET',f.auth)).status,400);
    const headers={...f.auth,...identityHeaders(),'X-Mesh-Bridge':'forged','X-Mesh-Principal':'b'.repeat(64),'X-Mesh-Preparation':randomUUID()};
    const p=await f.call('/api/transcribe','POST',headers,Buffer.alloc(1048577,1));assert.equal(p.status,202,JSON.stringify(p.body));
    assert.deepEqual(Object.keys(p.body).sort(),['job_id','request_id','session','created','state','text','error','outcome'].sort());
    const job=p.body.job_id;
    await until(async()=>(await f.call(`/api/transcribe/${job}`,'GET',headers)).body.state==='ready');
    assert.equal((await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).body.job_id,job);
    const repeat=await f.call('/api/transcribe','POST',headers,'x');
    assert.equal(repeat.status,202,JSON.stringify(repeat.body));
    assert.equal(repeat.body.job_id,job);
    assert.equal(f.upstreamCalls,1);
    assert.equal((await f.call(`/api/transcribe/${job}`,'GET',{...headers,'X-Mesh-Dictation-Client':randomUUID()})).status,404);
    assert.equal((await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'x')).body.error.code,'session_busy');
    assert.equal((await f.call(`/internal/commit/${job}`,'POST',headers,'{}')).status,404);
    assert.equal((await f.call(`/api/transcribe/${job}/settle`,'POST',{...headers,'Content-Type':'application/json'},'{"outcome":"submitted"}')).body.state,'settled');
    assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);
    assert.equal((await f.call(`/api/transcribe/${job}`,'GET',headers)).status,404);
    assert.ok(f.ops.every(op=>op==='list'),'no PTY mutation/input');
    assert.doesNotMatch(f.errors,/forged|bonjour|audio\.webm/);
  }finally{await f.close();}
});

test('logout preserves device-only semantics and closes bound sockets before retiring generation-owned dictation',async()=>{
  const f=await fixture();let socket:net.Socket|undefined;
  try{
    const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie=login.headers['set-cookie']![0]!.split(';')[0]!;
    const headers={Cookie:cookie,...identityHeaders()};
    const admitted=await f.call('/api/transcribe','POST',headers,'audio');assert.equal(admitted.status,202);
    const route=`/api/transcribe/${admitted.body.job_id}`;
    await until(async()=>(await f.call(route,'GET',headers)).body.state==='ready');
    const frames:{kind:number;data:Buffer}[]=[];
    socket=await new Promise<net.Socket>((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:f.port,path:'/ws/alpha?created=1&pty_size=1',headers:{Cookie:cookie,
        Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16,7).toString('base64')}});
      req.on('response',response=>{response.resume();reject(Error(`upgrade refused: ${response.statusCode}`));});
      req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('upgrade timeout')));
      req.on('upgrade',(_response,peer,head)=>{
        let bytes=Buffer.alloc(0);
        const receive=(part:Buffer)=>{
          bytes=Buffer.concat([bytes,part]);
          while(bytes.length>=2){
            let size=bytes[1]!&127,offset=2;
            if(size===126){if(bytes.length<4)return;size=bytes.readUInt16BE(2);offset=4;}
            assert.notEqual(size,127,'fixture frames stay small');if(bytes.length<offset+size)return;
            const frame={kind:bytes[0]!&15,data:bytes.subarray(offset,offset+size)};
            frames.push(frame);bytes=bytes.subarray(offset+size);
            if(frame.kind===8)peer.destroy();
          }
        };
        peer.on('error',()=>{});peer.on('data',receive);receive(head);resolve(peer);
      });req.end();
    });
    await until(()=>frames.some(frame=>frame.kind===2));
    assert.deepEqual(JSON.parse(frames[0]!.data.toString()),{t:'bound',name:'alpha',created:1});
    assert.equal((await f.call('/api/logout','POST',headers)).status,200);
    assert.equal(fs.readFileSync(path.join(f.config,'cookie-generation'),'utf8').trim(),'0');
    assert.equal((await f.call(route,'GET',headers)).body.state,'ready','other devices keep this generation');
    assert.equal(frames.some(frame=>frame.kind===8),false);
    assert.equal((await f.call('/api/logout-all','POST',{...f.auth,Origin:'https://evil.test'})).status,403);
    assert.equal((await f.call(route,'GET',headers)).body.state,'ready');
    const logout=await f.call('/api/logout-all','POST',f.auth);
    assert.deepEqual(logout.body,{ok:true,generation:1});
    assert.ok(logout.headers['set-cookie']!.some(value=>value.startsWith('mesh_auth=""')));
    await until(()=>frames.some(frame=>frame.kind===8));
    assert.equal(frames.find(frame=>frame.kind===8)!.data.readUInt16BE(0),1008);
    assert.equal((await f.call(route,'GET',headers)).status,401,'old cookie is revoked');
    assert.equal((await f.call(route,'GET',{...headers,...f.auth,Cookie:''})).status,404,'master auth survives, old job does not');
    assert.equal((await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'fresh audio')).status,202);
    assert.ok(f.ops.every(op=>op==='list'||op==='attach_if'),'no native input or mutation from retirement');
  }finally{socket?.destroy();await f.close();}
});

test('authoritative logout succeeds through HTTP and native CLI while failed worker sync gates every dictation operation',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-logout-fault-'));
  const marker=path.join(directory,'unavailable'),trace=path.join(directory,'operations');
  const preload=path.join(directory,'fault.cjs'),runtime=path.join(directory,'node');
  const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
  fs.writeFileSync(preload,`const http=require('node:http'),fs=require('node:fs'),original=http.createServer;
http.createServer=function(options,listener){return original.call(this,options,(req,res)=>{
  fs.appendFileSync(${JSON.stringify(trace)},req.url+'\\n');
  if(req.url==='/internal/principal'&&fs.existsSync(${JSON.stringify(marker)})){
    const unavailable=()=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');};
    if(fs.readFileSync(${JSON.stringify(marker)},'utf8')==='slow'){
      const timer=setTimeout(unavailable,3500);
      res.once('close',()=>clearTimeout(timer));
    }else unavailable();
    return;
  }return listener(req,res);
});};`);
  fs.writeFileSync(runtime,`#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`,{mode:0o700});
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  try{
    f=await fixture(true,false,runtime);
    f.setResponse('application/json','{"text":"old private transcript"}');
    const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie=login.headers['set-cookie']![0]!.split(';')[0]!;
    const identity=identityHeaders();
    const headers={...f.auth,...identity},json={...headers,'Content-Type':'application/json'};
    const admitted=await f.call('/api/transcribe','POST',headers,'old audio');assert.equal(admitted.status,202);
    const route=`/api/transcribe/${admitted.body.job_id}`;
    await until(async()=>(await f!.call(route,'GET',headers)).body.state==='ready');
    fs.writeFileSync(trace,'');fs.writeFileSync(marker,'slow');
    const started = performance.now();
    const logout=await f.call('/api/logout-all','POST',f.auth);
    assert.ok(performance.now() - started < 3000, 'logout does not wait for the optional worker response');
    fs.writeFileSync(marker,'unavailable');
    assert.equal(logout.status,200,'the cookie generation was already revoked');
    assert.deepEqual(logout.body,{ok:true,generation:1});
    assert.ok(logout.headers['set-cookie']!.some(value=>value.startsWith('mesh_auth=""')));
    assert.equal((await f.call(route,'GET',{Cookie:cookie,...identityHeaders()})).status,401);
    const builtExecutable = path.resolve('ocaml/_build/default/bin/mesh_logout_all_main.exe');
    const executable = process.env.MESH_LOGOUT_ALL_CMD
      ?? (fs.existsSync(builtExecutable) ? builtExecutable : path.resolve('_opam/bin/mesh-logout-all'));
    assert.ok(path.isAbsolute(executable)&&fs.statSync(executable).isFile(),'select the fresh native logout executable');
    const cli=spawnSync(executable,[],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,
      HOME:path.join(f.directory,'home'),MESH_CONF_DIR:f.config,MESH_CACHE_DIR:path.join(f.directory,'cache'),
      MESH_PORT:String(f.port),XDG_RUNTIME_DIR:path.join(f.directory,'run')}});
    assert.equal(cli.error,undefined);assert.equal(cli.status,0,cli.stderr);
    assert.match(cli.stdout,/All devices are signed out \(generation 2\)\./);
    assert.doesNotMatch(cli.stdout,/not responding|on disk/,'the CLI succeeded through HTTP, not its disk fallback');
    assert.equal(fs.readFileSync(path.join(f.config,'cookie-generation'),'utf8').trim(),'2');
    const freshLogin=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const freshCookie=freshLogin.headers['set-cookie']![0]!.split(';')[0]!;
    for(const [method,target,body] of [['GET',route,''],['GET',`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,''],
      ['GET','/api/transcribe/config',''],['POST',`${route}/cancel`,'{}'],
      ['POST',`${route}/settle`,'{"outcome":"inserted"}'],['POST','/api/transcribe','audio']]){
      const result=await f.call(target,method,json,body);
      assert.equal(result.status,503,`${method} ${target}`);assert.equal(result.body.error.code,'unavailable');
      assert.equal(result.body.text,undefined);assert.doesNotMatch(JSON.stringify(result.body),/old private transcript/);
    }
    assert.equal((await f.call(route,'GET',{Cookie:freshCookie,...identity})).status,503);
    assert.equal(f.upstreamCalls,1,'no new inference while revocation is unconfirmed');
    const attempted=fs.readFileSync(trace,'utf8').trim().split('\n');
    assert.ok(attempted.length>=8);assert.ok(attempted.every(operation=>operation==='/internal/principal'),
      'no job/config/admission operation reaches the worker before successful sync');
    fs.unlinkSync(marker);
    assert.equal((await f.call(route,'GET',headers)).status,404,'restored sync retires rather than reveals the old ready job');
    assert.equal((await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).status,404);
    f.setResponse('application/json','{"text":"fresh transcript"}');
    const next={...f.auth,...identityHeaders()};
    const replacement=await f.call('/api/transcribe','POST',next,'new audio');assert.equal(replacement.status,202);
    assert.notEqual(replacement.body.job_id,admitted.body.job_id);
    const nextRoute=`/api/transcribe/${replacement.body.job_id}`;
    await until(async()=>(await f!.call(nextRoute,'GET',next)).body.state==='ready');
    assert.equal((await f.call(nextRoute,'GET',next)).body.text,'fresh transcript');
    assert.equal(f.upstreamCalls,2);assert.doesNotMatch(f.errors,/old private transcript|fresh transcript/);
  }finally{if(f)await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual pre/post-upload incarnation and malformed inventory fail closed without inference',async()=>{
  const f=await fixture();
  try{
    const headers={...f.auth,...identityHeaders()};
    f.setCreated(2);assert.equal((await f.call('/api/transcribe','POST',headers,'a')).body.error.code,'stale_session');
    f.setCreated(1);
    const before=f.inventoryCalls;
    const pending=new Promise<any>((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:f.port,path:'/api/transcribe',method:'POST',headers:{...headers,'Content-Length':'2'},agent:false},res=>{let text='';res.on('data',p=>text+=p);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.write('a');
      void until(()=>f.inventoryCalls>before).then(()=>{f.setCreated(2);req.end('b');},reject);
    });
    const response=await pending;assert.equal(response.status,409);assert.equal(response.body.error.code,'stale_session');
    assert.equal(f.upstreamCalls,0);
    f.setCreated(1);f.setMalformed(true);assert.equal((await f.call('/api/transcribe','POST',headers,'a')).status,503);assert.equal(f.upstreamCalls,0);
  }finally{await f.close();}
});

for(const external of [false,true])test(`actual ${external?'external generation change':'logout-all'} retires ready jobs without stranding session slots`,async()=>{
  const f=await fixture();
  try{
    const identity=identityHeaders();
    const headers={...f.auth,...identity};
    const admitted=await f.call('/api/transcribe','POST',headers,'old audio');assert.equal(admitted.status,202);
    const route=`/api/transcribe/${admitted.body.job_id}`;
    await until(async()=>(await f.call(route,'GET',headers)).body.state==='ready');
    if(external){
      const generation=path.join(f.config,'cookie-generation');
      fs.writeFileSync(generation,String(Number(fs.readFileSync(generation,'utf8'))+1));
    }else assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);
    const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie=login.headers['set-cookie']![0]!.split(';')[0]!;
    const next={Cookie:cookie,...identityHeaders()};
    const old=await f.call(route,'GET',{Cookie:cookie,...identity});assert.equal(old.status,404);assert.equal(old.body.text,undefined);
    const replacement=await f.call('/api/transcribe','POST',next,'new audio');
    assert.equal(replacement.status,202,JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.job_id,admitted.body.job_id);
  }finally{await f.close();}
});

test('logout-all frees a receiving reservation before old upload completes; late receiver cannot replace the new job',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-receiving-'));
  const preload=path.join(directory,'observe.cjs'),received=path.join(directory,'received');
  fs.writeFileSync(preload,`const http=require('node:http'),fs=require('node:fs'),create=http.createServer;
http.createServer=function(options,listener){return create.call(this,options,(req,res)=>{
 if(req.method==='POST'&&req.url==='/api/transcribe'){const iterator=req.iterator.bind(req);req.iterator=function(options){const source=iterator(options);return(async function*(){for await(const part of source){fs.writeFileSync(${JSON.stringify(received)},'received');yield part;}})();};}
 return listener(req,res);
});};`);
  const f=await fixture(true,false,undefined,{workerPreload:preload});let upload:http.ClientRequest|undefined;
  try{
    const headers={...f.auth,...identityHeaders()},before=f.inventoryCalls;
    const old=new Promise<number>((resolve,reject)=>{
      upload=http.request({hostname:'127.0.0.1',port:f.port,path:'/api/transcribe',method:'POST',headers:{...headers,'Content-Length':'2'},agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});
      upload.on('error',reject);upload.write('a');
    });void old.catch(()=>{});
    await until(()=>f.inventoryCalls>before);
    // Observe the actual worker iterator: public lookup now deliberately hides
    // receiving reservations, so it cannot be used as a readiness probe.
    await until(()=>fs.existsSync(received));
    assert.equal((await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).status,404);
    assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);
    const next={...f.auth,...identityHeaders()};
    const replacement=await f.call('/api/transcribe','POST',next,'new');assert.equal(replacement.status,202,JSON.stringify(replacement.body));
    upload!.end('b');assert.equal(await old,401);
    assert.equal((await f.call(`/api/transcribe/request/${next['X-Mesh-Request-Id']}`,'GET',next)).body.job_id,replacement.body.job_id);
    await until(async()=>(await f.call(`/api/transcribe/${replacement.body.job_id}`,'GET',next)).body.state==='ready');
    assert.equal(f.upstreamCalls,1);
  }finally{upload?.destroy();await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('private principal transition is strict, authenticated, bounded and rejects delayed old admissions even with full handlers',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-revoke-'));fs.chmodSync(directory,0o700);
  const secret=randomBytes(32).toString('hex'),socketPath=path.join(directory,'worker.sock'),old='a'.repeat(64),next='b'.repeat(64);
  const inventory = await staticDictationInventory(directory);
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed',MESH_WHISPER_QUEUE_SIZE:'64'})!,secret,socketPath,inventory.socketPath,old);
  const uploads:http.ClientRequest[]=[];
  const call=(principal:string,body:unknown,bridge=secret)=>request({socketPath,path:'/internal/principal',method:'POST',headers:{'X-Mesh-Bridge':bridge,'X-Mesh-Principal':principal,'Content-Type':'application/json'}},JSON.stringify(body));
  try{
    assert.equal((await call(next,{revision:1},'wrong')).status,403);
    for(const body of [{revision:1,extra:true},{revision:'1'},{revision:-1},{revision:0.5}])assert.equal((await call(next,body)).status,400);
    const pending=Array.from({length:32},(_,i)=>new Promise<number>((resolve,reject)=>{
      const req=http.request({socketPath,path:'/api/transcribe',method:'POST',headers:{...identityHeaders(),'X-Mesh-Session':`slow${i}`,'X-Mesh-Bridge':secret,'X-Mesh-Principal':old,'Content-Length':'2'},agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});
      uploads.push(req);req.on('error',reject);req.write('a');
    }));for(const result of pending)void result.catch(()=>{});
    await until(()=>service.engine.stats().records===32);
    assert.equal((await call(next,{revision:1})).status,200,'revocation has a reserved control lane');
    assert.deepEqual(service.engine.stats(),{records:0,bytes:0,active:0,waiting:0});
    assert.equal((await call(next,{revision:1})).status,200,'exact replay is idempotent');
    assert.equal((await call(old,{revision:0})).status,404);
    assert.equal((await call(old,{revision:1})).status,404);
    for(const req of uploads)req.end('b');assert.ok((await Promise.all(pending)).every(status=>[404,503].includes(status)));
    const headers={...identityHeaders(),'X-Mesh-Bridge':secret,'X-Mesh-Principal':old};
    assert.equal((await request({socketPath,path:'/api/transcribe',method:'POST',headers},'late')).status,404,'old request arriving after revocation must not reserve a slot');
    assert.equal((await request({socketPath,path:'/api/transcribe',method:'POST',headers:{...headers,'X-Mesh-Principal':next}},'new')).status,202);
    assert.equal(service.engine.stats().records,1);
  }finally{for(const req of uploads)req.destroy();await service.close();await inventory.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual logout-all retires queued work without oversubscribing a processing upstream',async()=>{
  const f=await fixture();f.holdUpstream();
  try{
    const running={...f.auth,...identityHeaders()};
    const first=await f.call('/api/transcribe','POST',running,'running');assert.equal(first.status,202);
    await until(()=>f.upstreamCalls===1);
    f.setCreated(2);
    const queued={...f.auth,...identityHeaders(),'X-Mesh-Created':'2'};
    const second=await f.call('/api/transcribe','POST',queued,'queued');assert.equal(second.status,202);
    assert.equal((await f.call(`/api/transcribe/${second.body.job_id}`,'GET',queued)).body.state,'queued');
    assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);
    f.setCreated(3);
    const next={...f.auth,...identityHeaders(),'X-Mesh-Created':'3'};
    for(const [id, original] of [[first.body.job_id,running],[second.body.job_id,queued]] as const){
      const old=await f.call(`/api/transcribe/${id}`,'GET',original);assert.equal(old.status,404);assert.equal(old.body.text,undefined);
    }
    assert.equal((await f.call('/internal/principal','POST',next,'{"revision":99}')).status,404);
    const replacement=await f.call('/api/transcribe','POST',next,'new');assert.equal(replacement.status,202);
    assert.equal((await f.call(`/api/transcribe/${replacement.body.job_id}`,'GET',next)).body.state,'queued');
    assert.equal(f.upstreamCalls,1,'old running request still occupies the actual worker');
    f.releaseUpstream();await until(()=>f.upstreamCalls===2);
    f.releaseUpstream();
    await until(async()=>(await f.call(`/api/transcribe/${replacement.body.job_id}`,'GET',next)).body.state==='ready');
    assert.equal(f.peakUpstream,1);assert.equal(f.upstreamCalls,2,'revoked queued work never reached upstream');
  }finally{await f.close();}
});

test('actual cookie adapter rejects stale login and revalidates authorization after upload',async()=>{
  const f=await fixture();
  try{
    const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie=login.headers['set-cookie']![0]!.split(';')[0]!;
    const headers={Cookie:cookie,...identityHeaders()};
    assert.equal((await f.call('/api/transcribe/config','HEAD',headers)).status,200);
    assert.equal((await f.call('/api/transcribe/config','GET',{...headers,Origin:'https://evil.test'})).status,403);
    assert.equal((await f.call('/api/transcribe/config','GET',{Cookie:'mesh_auth=revoked'})).status,401);
    const before=f.inventoryCalls;
    const pending=new Promise<number>((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:f.port,path:'/api/transcribe',method:'POST',headers:{...headers,'Content-Length':'2'},agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write('a');
      void until(()=>f.inventoryCalls>before).then(async()=>{
        assert.equal((await f.call('/api/logout-all','POST',f.auth,'{}')).status,200);req.end('b');
      }).catch(reject);
    });
    assert.equal(await pending,401);
    assert.equal(f.upstreamCalls,0);
    const replacement=await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'a');
    assert.equal(replacement.status,202,'rejected preparation releases its global session reservation');
  }finally{await f.close();}
});

test('logout during the post-upload inventory lookup prevents inference', async () => {
  const f = await fixture();
  try {
    const login = await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    let lookups = 0;
    let finishLookup: (() => void) | undefined;
    f.onInventory(reply => {
      if (++lookups === 2) finishLookup = reply;
      else reply();
    });
    const pending = f.call('/api/transcribe', 'POST', {
      Cookie: cookie, ...identityHeaders(),
    }, 'old audio');
    void pending.catch(() => {});
    await until(() => finishLookup !== undefined);
    assert.equal((await f.call('/api/logout-all', 'POST', f.auth, '{}')).status, 200);
    finishLookup!();
    assert.equal((await pending).status, 401);
    assert.equal(f.upstreamCalls, 0);
    f.onInventory(null);
    assert.equal((await f.call('/api/transcribe', 'POST', {
      ...f.auth, ...identityHeaders(),
    }, 'new audio')).status, 202);
  } finally {
    await f.close();
  }
});

test('actual adapter returns typed upload/MIME/metadata/body failures rather than transport errors',async()=>{
  const f=await fixture();
  try{
    const headers={...f.auth,...identityHeaders()};
    for(const [extra,status,code] of [
      [{'Content-Type':'application/octet-stream'},415,'unsupported_audio'],
      [{'Content-Encoding':'gzip'},400,'invalid_request'],
      [{'X-Mesh-Created':'NaN'},400,'invalid_request'],
      [{'X-Mesh-Created':''},400,'invalid_request'],
      [{'X-Mesh-Request-Id':['a','b']},400,'invalid_request'],
      [{'X-Mesh-Dictation-Client':'bad'},400,'invalid_request'],
    ] as const){const res=await f.call('/api/transcribe','POST',{...headers,...extra},'x');assert.equal(res.status,status);assert.equal(res.body.error.code,code);}
    const empty=await f.call('/api/transcribe','POST',headers,'');assert.equal(empty.status,400);assert.equal(empty.body.error.code,'invalid_request');
    const large=await f.call('/api/transcribe','POST',headers,Buffer.alloc(8388609,1));assert.equal(large.status,413,JSON.stringify(large.body));assert.equal(large.body.error.code,'audio_too_large');
    const valid=await f.call('/api/transcribe','POST',headers,'x');assert.equal(valid.status,202,JSON.stringify(valid.body));
  }finally{await f.close();}
});

test('actual adapter rejects ambiguous Origin and Host headers before admission',async()=>{
  const f=await fixture();
  try{
    const origin=`http://127.0.0.1:${f.port}`,headers={...f.auth,...identityHeaders()};
    for(const extra of [['Host',`127.0.0.1:${f.port}`,'Origin',origin,'Origin',origin],
      ['Host',`127.0.0.1:${f.port}`,'Host',`127.0.0.1:${f.port}`]]){
      const result=await f.call('/api/transcribe','POST',[...Object.entries(headers).flat(),...extra],'audio');
      assert.ok([400,403].includes(result.status),JSON.stringify(result));
    }
    assert.equal(f.upstreamCalls,0);
    assert.equal((await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).status,404);
    assert.equal((await f.call('/api/transcribe/config','GET',{...f.auth,Origin:origin})).status,200);
  }finally{await f.close();}
});

test('repaired high-precision generation starts dictation and retires its old jobs', async () => {
  const f = await fixture(true, false, undefined, {
    beforeSpawn: config => fs.writeFileSync(path.join(config, 'cookie-generation'), 'invalid-generation\n'),
  });
  try {
    const generationFile = path.join(f.config, 'cookie-generation');
    const generation = BigInt(fs.readFileSync(generationFile, 'utf8').trim());
    assert.ok(generation > BigInt(Number.MAX_SAFE_INTEGER), 'native cookie-generation repair used time.time_ns()');
    assert.equal((await f.call('/api/transcribe/config', 'GET', f.auth)).body.enabled, true);
    const headers = {...f.auth, ...identityHeaders()};
    const admitted = await f.call('/api/transcribe', 'POST', headers, 'synthetic audio');
    assert.equal(admitted.status, 202);
    const route = `/api/transcribe/${admitted.body.job_id}`;
    await until(async () => (await f.call(route, 'GET', headers)).body.state === 'ready');
    fs.writeFileSync(generationFile, `${generation + 1n}\n`);
    assert.equal((await f.call(route, 'GET', headers)).status, 404, 'recheck retires the old principal');
    const fresh = await f.call('/api/transcribe', 'POST', {...f.auth, ...identityHeaders()}, 'fresh audio');
    assert.equal(fresh.status, 202);
    await until(() => f.upstreamCalls === 2);
    assert.equal(f.upstreamCalls, 2);
  } finally { await f.close(); }
});

test('owned worker retires after actual parent death, leaving no listening socket',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-worker-socket-'));
  const preload=path.join(directory,'observe.cjs'),bootstrap=path.join(directory,'socket');
  fs.writeFileSync(preload,`const fs=require('node:fs'),write=process.stdout.write;
process.stdout.write=function(part){if(String(part).startsWith('{"socket":'))fs.writeFileSync(${JSON.stringify(bootstrap)},JSON.stringify({socket:JSON.parse(String(part)).socket,pid:process.pid,parent:process.ppid}));return write.apply(this,arguments);};`);
  const f=await fixture(true,false,undefined,{workerPreload:preload});
  try{
    const identity=JSON.parse(fs.readFileSync(bootstrap,'utf8')) as {socket:string;pid:number;parent:number};
    const socket=identity.socket;assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
    // Resolve only this fixture's direct child; never identify it by a global
    // executable-name search. Keep birth identity across the parent's death.
    let worker:number|undefined;
    if(process.platform==='linux'){
      const children=fs.readFileSync(`/proc/${f.child.pid}/task/${f.child.pid}/children`,'utf8').trim().split(/\s+/);
      worker=Number(children.find(pid=>fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('dictation-service.cjs')));
      assert.equal(worker,identity.pid,'the typed child is the direct reap target');
      assert.equal(identity.parent,f.child.pid);
      assert.deepEqual(fs.readFileSync(`/proc/${worker}/cmdline`,'utf8').split('\0').filter(Boolean).slice(1),['--require',preload,path.resolve('backend/dictation-service.cjs')],'only the fixture preload and worker path, no credential arguments');
    }else{
      const result=spawnSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:2000});
      assert.equal(result.status,0);
      for(const line of result.stdout.split('\n')){
        const row=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if(row&&Number(row[2])===f.child.pid&&/dictation-service\.cjs$/.test(row[3]!))worker=Number(row[1]);
      }
      assert.equal(worker,identity.pid);
    }
    assert.ok(worker,'actual app-owned Node child with no credential arguments');
    const birth=processBirth(worker);assert.ok(birth);
    f.child.kill('SIGKILL');
    await until(()=>!fs.existsSync(path.dirname(socket)));
    await until(()=>processBirth(worker!)!==birth||processState(worker!)==='Z');
  }finally{await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});
