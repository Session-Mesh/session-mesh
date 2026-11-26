// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {configuration,Dictation,Fault,transcribe} from '../backend/dictation.ts';
import {liveInventory} from '../backend/dictation-service.ts';
import {until} from '../checks/dictation-fixture.ts';

const config=(url='http://localhost:1/fixed')=>configuration({MESH_WHISPER_URL:url})!;
const metadata=()=>({principal:'owner',client:randomUUID(),request:randomUUID(),session:'alpha',created:1,mime:'audio/webm'});
const fault=(code:string)=>(error:unknown)=>error instanceof Fault&&error.code===code;
async function* audio(){yield Buffer.from('synthetic audio');}

test('HTTP transport filters every DNS answer before giving an address to the connector',async t=>{
  let options:(http.RequestOptions&{autoSelectFamily?:boolean})|undefined;
  t.mock.method(http,'request',((_url:URL,next:http.RequestOptions)=>{options=next;throw Error('test transport: no socket created');}) as typeof http.request);
  await assert.rejects(transcribe(config(),[Buffer.from('synthetic')],metadata(),new AbortController().signal),fault('upstream_unavailable'));
  assert.equal(typeof options?.lookup,'function','HTTP must install the connection-time address guard');
  assert.equal(options?.autoSelectFamily,true);
  const lookup=options!.lookup!;
  let answers:dns.LookupAddress[]=[];
  t.mock.method(dns,'lookup',((...args:unknown[])=>{
    const callback=args.at(-1) as (error:null,addresses:dns.LookupAddress[])=>void;
    callback(null,answers);
  }) as typeof dns.lookup);
  const resolve=(all:boolean)=>new Promise<{error:NodeJS.ErrnoException|null;address:string|dns.LookupAddress[];family?:number}>(done=>lookup('localhost',{all},(error,address,family)=>done({error,address,family})));
  for(const address of ['192.0.2.1','0.0.0.0','2001:db8::1','::']){
    answers=[{address,family:net.isIP(address)}];
    for(const all of [false,true])assert.ok((await resolve(all)).error,'non-loopback answer must be rejected without a connection');
  }
  answers=[{address:'192.0.2.1',family:4},{address:'::1',family:6},{address:'127.23.45.67',family:4}];
  assert.deepEqual((await resolve(true)).address,answers.slice(1));
  assert.deepEqual(await resolve(false),{error:null,address:'::1',family:6});
});

test('HTTPS remote connections keep the normal TLS transport without the loopback DNS filter',async t=>{
  let options:http.RequestOptions|undefined;
  const https=await import('node:https');
  t.mock.method(https.default,'request',((_url:URL,next:http.RequestOptions)=>{options=next;throw Error('test transport: no socket created');}) as typeof https.default.request);
  await assert.rejects(transcribe(config('https://example.test/fixed'),[Buffer.from('synthetic')],metadata(),new AbortController().signal),fault('upstream_unavailable'));
  assert.equal(options?.lookup,undefined);
});

for(const family of [4,6] as const)test(`HTTP localhost uses only test-owned IPv${family} loopback servers`,async t=>{
  const address=family===4?'127.0.0.1':'::1';
  const server=http.createServer(async(req,res)=>{for await(const _ of req){/* synthetic multipart only */}res.setHeader('Content-Type','application/json');res.end('{"text":"ok"}');});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,address,resolve);});
  t.mock.method(dns,'lookup',((...args:unknown[])=>{
    const callback=args.at(-1) as (error:null,addresses:dns.LookupAddress[])=>void;
    // IPv6 first deliberately exercises local IPv4 fallback when no IPv6
    // listener exists. No host resolver or non-loopback socket is involved.
    callback(null,family===4?[{address:'::1',family:6},{address,family}]:[{address,family}]);
  }) as typeof dns.lookup);
  try{
    const port=(server.address() as net.AddressInfo).port;
    for(const host of ['localhost','localhost.',family===4?address:`[${address}]`])
      assert.equal(await transcribe(config(`http://${host}:${port}/fixed`),[Buffer.from('synthetic')],metadata(),new AbortController().signal),'ok');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('request lookup never presents a receiving or prepared reservation as queued work',async()=>{
  let entered!:()=>void,resume!:()=>void,calls=0;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* receiving(){yield Buffer.from('synthetic');entered();await new Promise<void>(resolve=>resume=resolve);}
  const d=new Dictation(config(),{infer:async()=>{calls++;return 'ok';}}),m=metadata();
  const pending=d.prepare(m,receiving());void pending.catch(()=>{});
  try{
    await seen;assert.throws(()=>d.lookup(m,m.request),fault('not_found'));
    resume();const prepared=await pending;
    assert.throws(()=>d.lookup(m,m.request),fault('not_found'));
    assert.throws(()=>d.commit(m,prepared.job.job_id,randomUUID()),fault('not_found'));
    assert.throws(()=>d.lookup(m,m.request),fault('not_found'),'failed commit cannot create a phantom queue entry');
    assert.equal(calls,0);
    d.commit(m,prepared.job.job_id,prepared.preparation);
    assert.equal(d.lookup(m,m.request).job_id,prepared.job.job_id);
    await until(()=>d.lookup(m,m.request).state==='ready');
    for(const other of [{...m,client:randomUUID()},{...m,principal:'other'}])assert.throws(()=>d.lookup(other,m.request),fault('not_found'));
    d.cancel(m,prepared.job.job_id);assert.equal(d.lookup(m,m.request).state,'cancelled');
    d.settle(m,prepared.job.job_id,'discarded');assert.equal(d.lookup(m,m.request).state,'settled');
    assert.equal(calls,1);
  }finally{resume?.();await d.close();}
});

for(const mode of ['absent','truncated','shape','utf8','timeout','shutdown'] as const)test(`worker inventory ${mode} is classified without inference`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-live-')),socketPath=path.join(directory,'inventory.sock');
  const peers=new Set<net.Socket>();
  let requested = false;
  const server=net.createServer({allowHalfOpen:true},socket=>{
    peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));
    socket.once('data',()=>{
      requested = true;
      if(mode==='timeout'||mode==='shutdown')return;
      if(mode==='truncated'){socket.end(Buffer.from([67,0]));return;}
      const body=mode==='utf8'?Buffer.from([0xff]):Buffer.from(mode==='shape'?'{}':'[]');
      const head=Buffer.alloc(5);head[0]=67;head.writeUInt32BE(body.length,1);socket.end(Buffer.concat([head,body]));
    });
  });
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  let calls=0, aborted=false;
  const d=new Dictation(config(),{isLive:(m, signal)=>{
    signal.addEventListener('abort', () => { aborted = true; }, {once:true});
    return liveInventory(socketPath,m,signal);
  },infer:async()=>{calls++;return 'must not run';}}),m=metadata();
  try{
    const p=await d.prepare(m,audio());d.commit(m,p.job.job_id,p.preparation);
    if(mode==='shutdown'){
      await until(()=>requested);
      await d.close();
      assert.equal(aborted,true);
      assert.equal(d.stats().active,0);
    }else{
      await until(()=>d.read(m,p.job.job_id).state==='error');
      assert.equal(d.read(m,p.job.job_id).error?.code,mode==='absent'?'stale_session':'unavailable');
    }
    assert.equal(calls,0);
  }finally{await d.close();for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});}
});
