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
import {build} from 'esbuild';
import {configuration} from '../backend/dictation.ts';
import {startService} from '../backend/dictation-service.ts';
import {identityHeaders,request,staticDictationInventory,until} from '../checks/dictation-fixture.ts';

test('failed socket startup preserves the live worker and its close is shared', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-worker-'));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, 'worker.sock');
  const config = configuration({MESH_WHISPER_URL: 'http://127.0.0.1:1/fixed'})!;
  const start = () => startService(config, 'a'.repeat(64), socket,
    path.join(directory, 'inventory.sock'), 'b'.repeat(64));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const service = await start();
  try {
    await assert.rejects(start(), {code: 'EADDRINUSE'});
    assert.equal(service.server.listening, true);
    assert.equal(fs.lstatSync(socket).isSocket(), true);
    const stopped = service.close();
    assert.equal(service.close(), stopped);
    await stopped;
    assert.equal(fs.existsSync(socket), false);
  } finally {
    await service.close();
  }
});

test('typed listener startup rejects a pre-cancelled worker before binding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-start-abort-'));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, 'worker.sock');
  const config = configuration({MESH_WHISPER_URL: 'http://127.0.0.1:1/fixed'})!;
  const controller = new AbortController();
  controller.abort();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  await assert.rejects(
    startService(config, 'a'.repeat(64), socket, path.join(directory, 'inventory.sock'),
      'b'.repeat(64), controller.signal),
    {name: 'AbortError'},
  );
  assert.equal(fs.existsSync(socket), false);
});

test('worker closes and removes its directory when the listener closes before readiness', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-listen-close-'));
  const preload = path.join(directory, 'close.cjs');
  fs.writeFileSync(preload, `const http = require('node:http'), create = http.createServer;
http.createServer = function (...args) {
  const server = create.apply(this, args), listen = server.listen;
  server.listen = function (...address) {
    listen.apply(this, address);
    return this.close();
  };
  return server;
};`);
  const child = spawn(process.execPath, ['--require', preload, 'backend/dictation-service.cjs'], {
    env: {PATH: process.env.PATH, MESH_WHISPER_URL: 'http://127.0.0.1:1/fixed'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', closed = false, workerDirectory: string | undefined;
  child.stdout.on('data', part => output += part);
  child.once('close', () => { closed = true; });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await until(() => child.exitCode !== null || child.signalCode !== null);
    }
    if (workerDirectory) fs.rmSync(workerDirectory, {recursive: true, force: true});
    fs.rmSync(directory, {recursive: true, force: true});
  });
  child.stdin.write(JSON.stringify({secret: 'a'.repeat(64), principal: 'b'.repeat(64),
    inventory: path.join(directory, 'inventory.sock'), parent: process.pid}) + '\n');
  await until(() => output.includes('\n'));
  const owned = JSON.parse(output.split('\n')[0]).directory;
  assert.match(owned, /^\/tmp\/mesh-dictation-[a-zA-Z0-9]+$/);
  workerDirectory = owned;
  await until(() => closed);
  assert.equal(child.exitCode, 1, 'startup settles without closing the parent pipe or forcing a reap');
  assert.equal(output.trimEnd().split('\n').length, 1, 'no ready acknowledgement');
  assert.equal(fs.existsSync(owned), false, 'the worker cleans up its own private directory');
});

for(const kind of ['error','close'] as const)test(`post-ready typed listener ${kind} publishes one fatal event and retires its engine`,async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-listener-'));fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const socket=path.join(directory,'worker.sock'),principal='b'.repeat(64),secret='a'.repeat(64);
  const inventory=await staticDictationInventory(directory);
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'})!,
    secret,socket,inventory.socketPath,principal);
  try{
    const headers={...identityHeaders(),'X-Mesh-Bridge':secret,'X-Mesh-Principal':principal};
    assert.equal((await request({socketPath:socket,path:'/internal/relay/start',method:'POST',headers})).status,200);
    assert.equal((await request({socketPath:socket,path:'/internal/relay/start',method:'POST',
      headers:{...headers,'X-Mesh-Request-Id':randomUUID(),'X-Mesh-Created':'not-a-number'}})).status,400,
      'a malformed ordinary request is not a listener failure');
    const pending=service.failure;
    if(kind==='error'){
      service.server.emit('error',Error('synthetic listener fault'));
      service.server.emit('error',Error('second listener fault'));
    }
    else service.server.close();
    assert.equal(await pending,kind);
    assert.equal(service.close(),service.close(),'cleanup shares a single promise');
    await service.close();
    assert.deepEqual(service.engine.stats(),{records:0,bytes:0,active:0,waiting:0});
    assert.equal(service.server.listening,false);
  }finally{await service.close();await inventory.close();}
});

test('intentional typed close remains a success, not a fatal listener event',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-listener-'));fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const inventory=await staticDictationInventory(directory);
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'})!,
    'a'.repeat(64),path.join(directory,'worker.sock'),inventory.socketPath,'b'.repeat(64));
  try{
    await service.close();
    assert.equal(service.failed,false);
  }finally{await service.close();await inventory.close();}
});

for(const kind of ['json','empty','audio'] as const)test(`unfinished ${kind} rejection flushes a typed fault and closes without draining`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-body-'));fs.chmodSync(directory,0o700);
  const secret=randomBytes(32).toString('hex'),principal='a'.repeat(64),socketPath=path.join(directory,'worker.sock');
  const inventory=await staticDictationInventory(directory);
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed',MESH_WHISPER_MAX_BYTES:'4'})!,secret,socketPath,inventory.socketPath,principal);
  let upload:http.ClientRequest|undefined;
  try{
    const headers:Record<string,string>={...identityHeaders(),'X-Mesh-Bridge':secret,'X-Mesh-Principal':principal,'Content-Length':'100000',Connection:'keep-alive'};
    if(kind==='audio'){
      const started=await request({socketPath,method:'POST',path:'/internal/relay/start',
        headers:{...headers,'Content-Length':'0'}});
      assert.equal(started.status,200);
      headers['X-Mesh-Relay-Claim']=started.body.claim;
    }
    const result=await new Promise<{status:number;headers:http.IncomingHttpHeaders;body:any}>((resolve,reject)=>{
      if(kind==='json')headers['Content-Type']='application/json';
      upload=http.request({socketPath,method:kind==='empty'?'GET':'POST',path:kind==='empty'?'/api/transcribe/config':kind==='json'?`/api/transcribe/${randomUUID()}/cancel`:'/internal/relay/upload',headers,agent:false},res=>{
        const parts:Buffer[]=[];res.on('data',part=>parts.push(part));res.on('error',reject);
        res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(Buffer.concat(parts).toString())}));
      });
      upload.on('error',reject);upload.setTimeout(3000,()=>upload!.destroy(Error('typed rejection timeout')));
      upload.write(kind==='json'?'x'.repeat(1025):kind==='audio'?'12345':'x');
    });
    assert.equal(result.status,kind==='audio'?413:400);
    assert.equal(result.body.error.code,kind==='audio'?'audio_too_large':'invalid_request');
    assert.equal(result.headers.connection,'close');
    await until(()=>upload!.destroyed);
    assert.deepEqual(service.engine.stats(),{records:0,bytes:0,active:0,waiting:0});
  }finally{upload?.destroy();await service.close();await inventory.close();fs.rmSync(directory,{recursive:true,force:true});}
});

for(const early of [true,false])test(`worker handles bootstrap stdin EOF ${early?'during':'after'} service startup with parent alive`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-boot-'));fs.chmodSync(directory,0o700);
  const worker=path.join(directory,'worker.cjs'),preload=path.join(directory,'hold.cjs'),release=path.join(directory,'release');
  const socket=path.join(directory,'worker.sock');
  // Hold the real startService at its first filesystem await, until stdin EOF
  // has actually been observed. The parent remains this test process throughout.
  fs.writeFileSync(preload,`const fs=require('node:fs'),promises=require('node:fs/promises'),original=promises.lstat;
promises.lstat=async(...args)=>{process.stdout.write('starting\\n');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,5));return original(...args);};
process.stdin.once('end',()=>process.stdout.write('eof\\n'));`);
  await build({entryPoints:['backend/dictation-main.ts'],outfile:worker,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});
  const child=spawn(process.execPath,['--require',preload,worker,'--worker'],{env:{PATH:process.env.PATH,HOME:directory,MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);
  try{
    child.stdin.write(JSON.stringify({secret:'a'.repeat(64),principal:'b'.repeat(64),socket,inventory:path.join(directory,'missing'),parent:process.pid})+'\n');
    await until(()=>output.includes('starting\n'));
    if(early){child.stdin.end();await until(()=>output.includes('eof\n'));}
    fs.writeFileSync(release,'go');
    if(!early){await until(()=>output.includes('ready\n'));child.stdin.end();}
    await until(()=>child.exitCode!==null);
    assert.equal(child.exitCode,0,errors);
    assert.equal(output.includes('ready\n'),!early,'no ready acknowledgement after bootstrap EOF');
    assert.equal(fs.existsSync(socket),false);
  }finally{
    if(child.exitCode===null){child.kill('SIGKILL');await until(()=>child.exitCode!==null||child.signalCode!==null);}
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
