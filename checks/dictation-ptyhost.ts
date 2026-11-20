// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A native-only fixture owner. Every signal and request targets this fixture's private runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const directory=process.env.TMPDIR!;
assert.ok(path.isAbsolute(directory));
const home=fs.mkdtempSync(path.join(directory,'pty-'));
fs.chmodSync(home,0o700);
const socket=path.join(home,'session-mesh','ptyhost.sock');
const configured=process.env.MESH_PTYHOST_CMD;
if(configured)assert.ok(path.isAbsolute(configured)&&fs.statSync(configured).isFile()&&(fs.statSync(configured).mode&0o111),
  'MESH_PTYHOST_CMD must be one absolute executable path, without arguments');
const daemon=spawn(configured||'mesh-ptyhost',[],{
  env:{...process.env,HOME:home,XDG_RUNTIME_DIR:home,MESH_RUNTIME_DIR:home},stdio:['ignore','ignore','pipe']});
let failure='';daemon.stderr.on('data',part=>failure+=part);
daemon.on('error',error=>{failure=error.message;});
const exited=()=>daemon.exitCode!==null||daemon.signalCode!==null;
async function control(body:unknown):Promise<any>{
  return await new Promise((resolve,reject)=>{
    const connection=net.connect(socket);let bytes=Buffer.alloc(0);
    connection.setTimeout(1000,()=>connection.destroy(Error('Private native fixture timeout')));
    connection.on('error',reject);connection.on('end',()=>reject(Error('Truncated fixture reply')));
    connection.on('connect',()=>{
      const data=Buffer.from(JSON.stringify(body)),head=Buffer.alloc(5);head[0]=67;head.writeUInt32BE(data.length,1);
      connection.write(Buffer.concat([head,data]));
    });
    connection.on('data',(part:Buffer)=>{
      bytes=Buffer.concat([bytes,part]);
      if(bytes.length<5)return;
      if(bytes[0]!==67||bytes.readUInt32BE(1)>1048576){connection.destroy();reject(Error('Invalid fixture reply'));return;}
      if(bytes.length<5+bytes.readUInt32BE(1))return;
      try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(5,5+bytes.readUInt32BE(1)))));}
      catch(error){reject(error);}finally{connection.destroy();}
    });
  });
}
async function waitExit(milliseconds:number){
  const deadline=performance.now()+milliseconds;
  while(!exited()&&performance.now()<deadline)await delay(10);
  return exited();
}
let closing=false;
async function close(){
  if(closing)return;closing=true;
  let sessions:any[]=[];
  try{sessions=await control({op:'list'});assert.ok(Array.isArray(sessions));}
  catch{sessions=[];}
  for(const item of sessions){
    if(typeof item.name==='string')await control({op:'kill',name:item.name}).catch(()=>{});
    if(Number.isInteger(item.pid)&&item.pid>0){try{process.kill(-item.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
  }
  if(!exited())daemon.kill('SIGTERM');
  if(!await waitExit(2000)){daemon.kill('SIGKILL');assert.ok(await waitExit(2000),'native fixture did not exit');}
  fs.rmSync(home,{recursive:true,force:true});
}
try{
  const deadline=performance.now()+5000;let ready=false;
  while(performance.now()<deadline){
    if(exited()||failure)throw Error('Native fixture unavailable: '+failure);
    try{assert.deepEqual(await control({op:'list'}),[]);ready=true;break;}catch{await delay(10);}
  }
  assert.ok(ready,'set MESH_PTYHOST_CMD to the built native executable');
  process.stdout.write(JSON.stringify({home,socket})+'\n');
  await new Promise<void>(resolve=>{process.stdin.resume();process.stdin.once('end',resolve);process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
}catch(error){console.error(error);process.exitCode=1;}
finally{process.stdin.destroy();await close();}
