// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Actual existing PTY daemon and compiled worker; fake inference only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

async function until(check:()=>boolean|Promise<boolean>,milliseconds=8000):Promise<void> {
  const deadline=performance.now()+milliseconds;
  while(performance.now()<deadline){if(await check())return;await delay(10);}
  throw Error('Owned fixture readiness timeout');
}
const exited=(child:ChildProcessWithoutNullStreams):boolean=>child.exitCode!==null||child.signalCode!==null;
async function exitsWithin(child:ChildProcessWithoutNullStreams,milliseconds:number):Promise<boolean> {
  try{await until(()=>exited(child),milliseconds);return true;}catch{return false;}
}
const workerStops=new WeakMap<ChildProcessWithoutNullStreams,Promise<void>>();
async function stopWorker(child:ChildProcessWithoutNullStreams):Promise<void> {
  let stopping=workerStops.get(child);
  if(!stopping){stopping=(async()=>{
    child.stdin.end();if(await exitsWithin(child,250))return;
    child.kill('SIGTERM');child.kill('SIGCONT');if(await exitsWithin(child,750))return;
    child.kill('SIGKILL');await until(()=>exited(child),1500);
  })();workerStops.set(child,stopping);}
  try{await stopping;}finally{
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();if(!exited(child))child.unref();
  }
}
async function stopPty(child:ChildProcessWithoutNullStreams):Promise<void> {
  // Resume only our cleanup owner if stopped; let its existing finally reap
  // owned sessions. Never replace this with an early kill of the adapter.
  if(!exited(child))child.kill('SIGCONT');child.stdin.end();
  await until(()=>exited(child),10000);assert.equal(child.exitCode,0,'PTY cleanup must succeed');
}
async function control(socketPath:string,body:unknown):Promise<any> {
  return await new Promise((resolve,reject)=>{
    const socket=net.connect(socketPath);let data=Buffer.alloc(0);
    const deadline=setTimeout(()=>socket.destroy(Error('Owned control timeout')),3000);
    socket.once('close',()=>clearTimeout(deadline));socket.on('error',reject);
    socket.on('end',()=>reject(Error('Truncated owned control reply')));
    socket.on('connect',()=>{
      const payload=Buffer.from(JSON.stringify(body)),head=Buffer.alloc(5);
      head[0]=67;head.writeUInt32BE(payload.length,1);socket.write(Buffer.concat([head,payload]));
    });
    socket.on('data',(part:Buffer)=>{
      try{
        data=Buffer.concat([data,part]);assert.ok(data.length<=1048581);if(data.length<5)return;
        assert.ok(data.readUInt32BE(1)<=1048576);if(data.length<5+data.readUInt32BE(1))return;
        assert.equal(data[0],67,'real control reply is C');resolve(JSON.parse(data.subarray(5,5+data.readUInt32BE(1)).toString()));socket.destroy();
      }catch(error){socket.destroy();reject(error);}
    });
  });
}
async function startPty(directory:string,own:(child:ChildProcessWithoutNullStreams)=>void) {
  const shell=path.join(directory,'shell');fs.writeFileSync(shell,'#!/bin/sh\nexec /bin/cat\n',{mode:0o700});
   const child=spawn(process.execPath,['--experimental-strip-types',path.resolve('checks/dictation-ptyhost.ts')],{
    env:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory,SHELL:shell,PYTHONDONTWRITEBYTECODE:'1',
      XDG_CONFIG_HOME:path.join(directory,'config'),XDG_CACHE_HOME:path.join(directory,'cache'),
      XDG_DATA_HOME:path.join(directory,'data'),MESH_CONF_DIR:path.join(directory,'config'),MESH_CACHE_DIR:path.join(directory,'cache'),
      ...(process.env.MESH_PTYHOST_CMD?{MESH_PTYHOST_CMD:process.env.MESH_PTYHOST_CMD}:{})},
    stdio:['pipe','pipe','pipe']});
  own(child);child.stdin.on('error',()=>{});
  let output='',errors='';child.stdout.on('data',p=>output+=p.toString());child.stderr.on('data',p=>errors+=p.toString());
  try{
    await until(()=>{if(exited(child))throw Error('Owned PTY setup failed: '+errors);return output.includes('\n');});
    assert.ok(output.length<4096);const boot=JSON.parse(output.split('\n')[0]!);
    assert.ok(boot.home.startsWith(directory+'/'));assert.ok(boot.socket.startsWith(boot.home+'/'));
    return {child,socket:boot.socket as string,home:boot.home as string};
  }catch(error){await stopPty(child);throw error;}
}
async function privateCall(socketPath:string,headers:Record<string,string>,route:string,method='GET',body=''):Promise<{status:number;body:any}> {
  return await new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:route,method,headers,agent:false},res=>{
      let text='';res.on('data',part=>{text+=part.toString();if(text.length>131072)req.destroy(Error('Reply bound'));});
      res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});
    });
    const deadline=setTimeout(()=>req.destroy(Error('Owned worker timeout')),4000);
    req.once('close',()=>clearTimeout(deadline));req.on('error',reject);req.end(body);
  });
}
async function startWorker(directory:string,inventory:string,url:string,own:(child:ChildProcessWithoutNullStreams)=>void) {
  const socket=path.join(directory,'worker.sock'),secret=randomBytes(32).toString('hex');
  const child=spawn(process.execPath,[path.resolve('backend/dictation-service.cjs')],{
    env:{PATH:process.env.PATH,MESH_WHISPER_URL:url},stdio:['pipe','pipe','pipe']});
  own(child);child.stdin.on('error',()=>{});
  let output='',errors='';child.stdout.on('data',p=>output+=p.toString());child.stderr.on('data',p=>errors+=p.toString());
  child.stdin.write(JSON.stringify({secret,socket,inventory,parent:process.pid,principal:'a'.repeat(64)})+'\n');
  try{await until(()=>{if(exited(child))throw Error('Owned worker setup failed: '+errors);return output.includes('ready\n');});}
  catch(error){await stopWorker(child);throw error;}
  return {child,socket,headers:{'X-Mesh-Bridge':secret,'X-Mesh-Principal':'a'.repeat(64),'X-Mesh-Dictation-Client':randomUUID(),
    'X-Mesh-Request-Id':randomUUID(),'X-Mesh-Session':'protocolA','Content-Type':'audio/webm'}};
}

test('compiled worker commits transcription against the actual C-control PTY daemon',{timeout:30000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mdp-'));fs.chmodSync(directory,0o700);
  let pty:ChildProcessWithoutNullStreams|null=null,ownedWorker:ChildProcessWithoutNullStreams|null=null,worker:Awaited<ReturnType<typeof startWorker>>|null=null,calls=0;
  const upstream=http.createServer(async(req,res)=>{for await(const _ of req){/* synthetic bytes only */}calls++;res.setHeader('Content-Type','application/json');res.end('{"text":"bonjour"}');});
  t.after(async()=>{
    try{if(ownedWorker)await stopWorker(ownedWorker);}finally{
      try{if(pty)await stopPty(pty);}finally{
        upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
        fs.rmSync(directory,{recursive:true,force:true});
      }
    }
  },{timeout:15000});
  const daemon=await startPty(directory,child=>{pty=child;});
  assert.equal((await control(daemon.socket,{op:'new',name:'protocolA',cwd:daemon.home})).ok,true);
  const list=await control(daemon.socket,{op:'list'}),session=list.find((item:any)=>item.name==='protocolA');assert.ok(session);
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  worker=await startWorker(directory,daemon.socket,`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/fixed`,child=>{ownedWorker=child;});
  const headers={...worker.headers,'X-Mesh-Created':String(session.created)};
  const prepared=await privateCall(worker.socket,headers,'/api/transcribe','POST','synthetic fixture');assert.equal(prepared.status,202);
  const id=prepared.body.job.job_id;
  assert.equal((await privateCall(worker.socket,{...headers,'Content-Type':'application/json','X-Mesh-Preparation':prepared.body.preparation},`/internal/commit/${id}`,'POST','{}')).status,200);
  let job:any;await until(async()=>{job=(await privateCall(worker!.socket,headers,`/api/transcribe/${id}`)).body;return !['queued','processing'].includes(job.state);});
  assert.equal(job.state,'ready',JSON.stringify({state:job.state,error:job.error,actualControlKind:'C',calls}));
  assert.equal(job.text,'bonjour');assert.equal(calls,1);
});
