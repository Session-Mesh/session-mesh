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
import {identityHeaders,until} from '../checks/dictation-fixture.ts';

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

for(const kind of ['json','empty','audio'] as const)test(`unfinished ${kind} rejection flushes a typed fault and closes without draining`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-body-'));fs.chmodSync(directory,0o700);
  const secret=randomBytes(32).toString('hex'),principal='a'.repeat(64),socketPath=path.join(directory,'worker.sock');
  const service=await startService(configuration({MESH_WHISPER_URL:'http://127.0.0.1:1/fixed',MESH_WHISPER_MAX_BYTES:'4'})!,secret,socketPath,path.join(directory,'missing'),principal);
  let upload:http.ClientRequest|undefined;
  try{
    const result=await new Promise<{status:number;headers:http.IncomingHttpHeaders;body:any}>((resolve,reject)=>{
      const headers={...identityHeaders(),'X-Mesh-Bridge':secret,'X-Mesh-Principal':principal,'Content-Length':'100000',Connection:'keep-alive'};
      if(kind==='json')headers['Content-Type']='application/json';
      upload=http.request({socketPath,method:kind==='empty'?'GET':'POST',path:kind==='empty'?'/api/transcribe/config':kind==='json'?`/api/transcribe/${randomUUID()}/cancel`:'/api/transcribe',headers,agent:false},res=>{
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
  }finally{upload?.destroy();await service.close();fs.rmSync(directory,{recursive:true,force:true});}
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
  const child=spawn(process.execPath,['--require',preload,worker],{env:{PATH:process.env.PATH,HOME:directory,MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'},stdio:['pipe','pipe','pipe']});
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
