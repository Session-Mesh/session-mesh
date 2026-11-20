// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Fault only the fixture's own worker; never freeze an existing owner process.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {processBirth} from '../checks/dictation-fixture.ts';

function sameProcess(pid:number,start:string):boolean {return processBirth(pid)===start;}
async function recover(pid:number,start:string):Promise<void> {
  if(!sameProcess(pid,start))return;
  try{process.kill(pid,'SIGCONT');process.kill(pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  for(let i=0;i<50&&sameProcess(pid,start);i++)await delay(10);
  if(sameProcess(pid,start))try{process.kill(pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  for(let i=0;i<200&&sameProcess(pid,start);i++)await delay(10);
  assert.equal(sameProcess(pid,start),false,'recovery must remove the original process, not merely change its parent');
}
test('a frozen fixture worker fails and is reaped within the scenario bound',{timeout:22000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mdf-'));fs.chmodSync(directory,0o700);
  const marker=path.join(directory,'pid'),preload=path.join(directory,'freeze.cjs');
  const executable=path.resolve('backend/dictation-service.cjs');
  fs.writeFileSync(preload,`const cp=require('node:child_process'),fs=require('node:fs'),spawnSync=cp.spawnSync;
const birth=${processBirth.toString()};
const original=cp.spawn;let used=false;cp.spawn=function(file,args,options){
 const child=original.call(this,file,args,options);
 if(!used&&file===process.execPath&&args[0]===${JSON.stringify(executable)}){
  used=true;const stopped=child.kill('SIGSTOP'),start=birth(child.pid);
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,stopped,parent:process.pid,start}));
 }return child;};`);
  const runner=spawn(process.execPath,['--require',preload,'--experimental-strip-types',path.resolve('tests/dictation-service-protocol.test.ts')],{
    env:{PATH:process.env.PATH,MESH_PYTHON:process.env.MESH_PYTHON,MESH_PTYHOST_CMD:process.env.MESH_PTYHOST_CMD},stdio:['ignore','pipe','pipe']});
  let output='',pid=0,start='',ended=false;runner.stdout.on('data',p=>output+=p.toString());runner.stderr.on('data',p=>output+=p.toString());runner.on('exit',()=>{ended=true;});
  const deadline=performance.now()+13000;
  try{
    while(!fs.existsSync(marker)&&!ended&&performance.now()<deadline)await delay(20);
    assert.ok(fs.existsSync(marker),'fault must reach our actual worker: '+output.slice(-1600));
    const fault=JSON.parse(fs.readFileSync(marker,'utf8'));pid=fault.pid;start=fault.start;
    assert.ok(Number.isInteger(pid)&&pid>0&&fault.stopped&&fault.parent===runner.pid&&typeof start==='string'&&start.length>0&&sameProcess(pid,start));
    while(!ended&&performance.now()<deadline)await delay(20);
    assert.ok(ended,'frozen owned worker kept its check runner alive: '+output.slice(-1600));
    assert.equal(runner.exitCode,1,'the intentionally frozen scenario must fail, not pass');
    assert.equal(sameProcess(pid,start),false,'original worker must already be absent/reaped, even after reparenting');
  }finally{
    if(!pid&&fs.existsSync(marker)){const fault=JSON.parse(fs.readFileSync(marker,'utf8'));if(fault.parent===runner.pid){pid=fault.pid;start=fault.start;}}
    if(pid&&typeof start==='string'&&start.length)await recover(pid,start);
    for(let i=0;i<200&&!ended;i++)await delay(10);
    if(!ended)runner.kill('SIGTERM');
    for(let i=0;i<200&&!ended;i++)await delay(10);
    if(!ended){runner.kill('SIGKILL');for(let i=0;i<100&&!ended;i++)await delay(10);}
    runner.stdout.destroy();runner.stderr.destroy();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('retained birth identity recognizes an orphan until that same worker exits',{timeout:6000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mdo-'));fs.chmodSync(directory,0o700);
  const marker=path.join(directory,'identity'),executable=path.resolve('backend/dictation-service.cjs');
  const code=`const cp=require('node:child_process'),fs=require('node:fs'),spawnSync=cp.spawnSync;
const birth=${processBirth.toString()};
const child=cp.spawn(process.execPath,[${JSON.stringify(executable)}],{env:{PATH:process.env.PATH,MESH_WHISPER_URL:'http://127.0.0.1:1/fixed'},stdio:['pipe','ignore','ignore']});
child.stdin.on('error',()=>{});child.kill('SIGSTOP');
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,parent:process.pid,start:birth(child.pid)}));
process.stdin.resume();process.stdin.once('end',()=>process.exit(1));`;
  const parent=spawn(process.execPath,['-e',code],{env:{PATH:process.env.PATH},stdio:['pipe','ignore','ignore']});
  let identity:{pid:number;parent:number;start:string}|null=null,ended=false;parent.on('exit',()=>{ended=true;});
  try{
    for(let i=0;i<100&&!fs.existsSync(marker);i++)await delay(10);
    assert.ok(fs.existsSync(marker));identity=JSON.parse(fs.readFileSync(marker,'utf8'));
    assert.equal(identity!.parent,parent.pid);assert.ok(sameProcess(identity!.pid,identity!.start));
    parent.stdin.end();for(let i=0;i<100&&!ended;i++)await delay(10);assert.ok(ended);
    assert.ok(sameProcess(identity!.pid,identity!.start),'changed PPID is not evidence of process absence');
  }finally{
    if(!identity&&fs.existsSync(marker))identity=JSON.parse(fs.readFileSync(marker,'utf8'));
    if(identity&&identity.parent===parent.pid)await recover(identity.pid,identity.start);
    parent.stdin.end();for(let i=0;i<100&&!ended;i++)await delay(10);
    if(!ended)parent.kill('SIGTERM');fs.rmSync(directory,{recursive:true,force:true});
  }
});
