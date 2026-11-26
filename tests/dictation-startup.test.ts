// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync, type ChildProcess} from 'node:child_process';
import {fixture, identityHeaders, processBirth, until} from '../checks/dictation-fixture.ts';

test('dictation bootstrap rejects malformed UTF-8 before creating its socket', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bootstrap-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const socket = path.join(directory, 'worker.sock');
  const line = JSON.stringify({
    secret: 'a'.repeat(64), principal: 'b'.repeat(64),
    parent: process.pid, socket, inventory: '/fixture/INVENTORY',
  });
  const input = Buffer.from(`${line}\n`);
  input[input.indexOf('INVENTORY')] = 0xff;
  const worker = spawnSync(process.execPath, ['backend/dictation-service.cjs'], {
    env: {...process.env, MESH_WHISPER_URL: 'http://127.0.0.1:1/fixed'},
    input, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(worker.error, undefined);
  assert.equal(worker.status, 1);
  assert.equal(worker.stdout, '');
  assert.equal(worker.stderr, 'Dictation worker unavailable.\n');
  assert.equal(fs.existsSync(socket), false);
});

async function disabled(f:Awaited<ReturnType<typeof fixture>>,reason:string){
  assert.equal((await f.call('/api/sessions','GET',f.auth)).status,200,'ordinary API remains healthy');
  const config=await f.call('/api/transcribe/config','GET',f.auth);
  assert.equal(config.status,200);
  assert.deepEqual(config.body,{enabled:false,disabled_reason:reason});
  assert.equal(config.headers['cache-control'],'no-store');
  const head=await f.call('/api/transcribe/config','HEAD',f.auth);
  assert.equal(head.status,200);assert.equal(head.body,'');
  assert.equal(head.headers['content-length'],config.headers['content-length']);
  assert.equal((await f.call('/api/transcribe/config')).status,401);
  assert.equal((await f.call('/api/transcribe/config','GET',{...f.auth,Origin:'https://evil.test'})).status,403);
  assert.equal((await f.call('/api/transcribe/config?extra=1','GET',f.auth)).status,400);
  assert.equal((await f.call('/api/transcribe','POST',{...f.auth,...identityHeaders()},'audio')).body.error.code,'disabled');
  assert.equal(f.upstreamCalls,0);
  const lines=f.errors.split('\n').filter(line=>line.startsWith('session-mesh: dictation disabled:'));
  assert.deepEqual(lines,reason==='not_configured'?[]:[`session-mesh: dictation disabled: ${reason}`]);
  assert.equal((await f.call('/api/logout-all','POST',f.auth)).status,200);
  assert.doesNotMatch(f.errors,/dictation principal sync unavailable/,'disabled dictation has no principal to synchronize');
  assert.doesNotMatch(f.errors,/PRIVATE_SENTINEL|Traceback|Task exception was never retrieved/);
}

for(const [label,enabled,noNode,runtime,whisperEnv,reason] of [
  ['unconfigured',false,true,'/missing/node',{},'not_configured'],
  ['missing PATH runtime',true,true,undefined,{},'runtime_unavailable'],
  ['missing explicit runtime',true,false,'/missing/PRIVATE_SENTINEL',{},'runtime_unavailable'],
  ['relative command',true,false,'node --eval PRIVATE_SENTINEL',{},'invalid_configuration'],
  ['invalid URL',true,false,undefined,{MESH_WHISPER_URL:'http://user:PRIVATE_SENTINEL@localhost/'},'invalid_configuration'],
  ['invalid limits',true,false,undefined,{MESH_WHISPER_WORKERS:'PRIVATE_SENTINEL'},'invalid_configuration'],
  ['invalid language',true,false,undefined,{MESH_WHISPER_LANGUAGE:'PRIVATE_SENTINEL\n'},'invalid_configuration'],
] as const)test(`optional dictation ${label} disables only dictation`,async()=>{
  const f=await fixture(enabled,noNode,runtime,{whisperEnv});
  try{await disabled(f,reason);}finally{await f.close();}
});

function workerFixture(t:TestContext,body:string){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-startup-'));
  fs.chmodSync(directory,0o700);
  const entry=path.join(directory,'worker.cjs'),marker=path.join(directory,'identity');
  fs.writeFileSync(entry,`const fs=require('node:fs');
process.stdin.once('data',part=>{
 const bootstrap=JSON.parse(part.toString().split('\\n')[0]);
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,socket:bootstrap.socket}));
 ${body}
});`);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {entry,hasIdentity:()=>fs.existsSync(marker),identity:()=>JSON.parse(fs.readFileSync(marker,'utf8')) as {pid:number;socket:string}};
}

test('a throwing startup callback still closes the fixture', {timeout: 10000}, async () => {
  const failure = new Error('fixture startup callback failed');
  let child: ChildProcess | undefined;
  await assert.rejects(fixture(false, false, undefined, {onSpawn: value => {
    child = value;
    throw failure;
  }}), error => error === failure);
  assert.ok(child?.pid);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('cancelling startup preserves shutdown and reaps the partial worker',{timeout:10000},async t=>{
  const c=workerFixture(t,'process.stdin.resume();setInterval(()=>{},1000);');
  let child:ChildProcess|undefined;
  const pending=fixture(true,false,undefined,{workerEntry:c.entry,onSpawn:value=>{child=value;}});
  void pending.catch(()=>{});
  t.after(async () => {
    const live = await pending.catch(() => undefined);
    await live?.close();
  });
  await until(c.hasIdentity);
  const identity=c.identity();
  assert.ok(child?.pid,'only signal the child created by this fixture');
  child.kill('SIGINT');
  await assert.rejects(pending,error=>{
    assert.match(String(error),/server fixture failed/);
    assert.doesNotMatch(String(error),/Dictation worker unavailable/);
    return true;
  });
  await until(()=>processBirth(identity.pid)===null);
  assert.equal(fs.existsSync(path.dirname(identity.socket)),false);
});

test('an early configuration rejection survives a closed bootstrap pipe',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-early-exit-'));
  fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const runtime=path.join(directory,'runtime');
  // This executable never consumes bootstrap input: close its read end before
  // emitting the closed private handshake and exiting. No Python test harness.
  fs.writeFileSync(runtime,"#!/bin/sh\nexec 0<&-\nprintf 'invalid_configuration\\n'\nexit 1\n",{mode:0o700});
  for(let attempt=0;attempt<12;attempt++){
    const f=await fixture(true,true,runtime);
    try{await disabled(f,'invalid_configuration');}finally{await f.close();}
  }
});

for(const mode of ['exit','bad handshake','timeout'] as const)test(`optional worker ${mode} has bounded cleanup`,{timeout:16000},async t=>{
  const c=workerFixture(t,mode==='exit'?"process.stderr.write('PRIVATE_SENTINEL');process.exit(1);":
    mode==='bad handshake'?"process.stdout.write('PRIVATE_SENTINEL\\n');process.stdin.resume();":
      "process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  const started=performance.now();
  const f=await fixture(true,false,undefined,{workerEntry:c.entry,startupWaitMs:12000});
  try{
    await disabled(f,mode==='timeout'?'startup_timeout':'worker_failed');
    assert.ok(performance.now()-started<12000,'startup + forced cleanup must be bounded');
    const identity=c.identity();
    await until(()=>processBirth(identity.pid)===null);
    assert.equal(fs.existsSync(path.dirname(identity.socket)),false,'private socket directory removed');
  }finally{await f.close();}
});

test('post-startup worker loss clears enabled config and repeated fixture lifecycles clean up',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-loss-'));
  fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const marker=path.join(directory,'identity'),preload=path.join(directory,'observe.cjs');
  fs.writeFileSync(preload,`process.stdin.once('data',part=>{
 const b=JSON.parse(part.toString().split('\\n')[0]);
 require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,socket:b.socket}));
});`);
  const sockets:string[]=[];
  for(let i=0;i<2;i++){
    const f=await fixture(true,false,undefined,{workerPreload:preload});
    try{
      const identity=JSON.parse(fs.readFileSync(marker,'utf8')) as {pid:number;socket:string};
      sockets.push(identity.socket);
      assert.equal((await f.call('/api/transcribe/config','GET',f.auth)).body.enabled,true);
      process.kill(identity.pid,'SIGKILL');
      await until(async()=>(await f.call('/api/transcribe/config','GET',f.auth)).body.enabled===false);
      await disabled(f,'worker_failed');
      await until(()=>!fs.existsSync(path.dirname(identity.socket))&&processBirth(identity.pid)===null);
    }finally{await f.close();await f.close();}
  }
  assert.notEqual(sockets[0],sockets[1],'fresh lifecycle has a fresh private socket');
});

test('interrupted shutdown still reaps a worker stopped during cleanup',{timeout:12000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-interrupted-stop-'));
  fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const marker=path.join(directory,'identity'),interrupted=path.join(directory,'interrupted');
  const preload=path.join(directory,'interrupt.cjs');
  fs.writeFileSync(preload,`const fs=require('node:fs');
process.stdin.once('data',part=>{
 const b=JSON.parse(part.toString().split('\\n')[0]);
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,socket:b.socket}));
});
process.stdin.once('end',()=>{
 fs.writeFileSync(${JSON.stringify(interrupted)},'cleanup reached child stdin close');
 process.kill(process.ppid,'SIGINT');
 process.kill(process.pid,'SIGSTOP');
});`);
  const f=await fixture(true,false,undefined,{workerPreload:preload});
  let ownedWorker: {pid: number; birth: string} | undefined;
  try{
    const identity=JSON.parse(fs.readFileSync(marker,'utf8')) as {pid:number;socket:string};
    const birth=processBirth(identity.pid);assert.ok(birth);
    ownedWorker = {pid: identity.pid, birth};
    f.child.kill('SIGTERM');
    await until(()=>fs.existsSync(interrupted));
    await until(()=>f.child.exitCode!==null||f.child.signalCode!==null);
    await until(()=>processBirth(identity.pid)!==birth);
    assert.equal(fs.existsSync(path.dirname(identity.socket)),false);
    assert.doesNotMatch(f.errors,/Task was destroyed|Task exception was never retrieved|Unclosed client session/);
  }finally{
    try {
      if (ownedWorker && processBirth(ownedWorker.pid) === ownedWorker.birth) {
        const {pid, birth} = ownedWorker;
        process.kill(pid, 'SIGKILL');
        await until(() => processBirth(pid) !== birth);
      }
    } finally {
      await f.close();
    }
  }
});
