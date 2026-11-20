// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared isolated real-server fixture. All services, credentials and paths are test-owned.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await delay(10);}throw Error('fixture readiness timeout');}
export function request(options:http.RequestOptions,body:string|Buffer=''){
  return new Promise<{status:number;body:any;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
    const req=http.request({...options,agent:false},res=>{const parts:Buffer[]=[];res.on('data',p=>parts.push(p));res.on('end',()=>{const text=Buffer.concat(parts).toString();let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode!,body,headers:res.headers});});res.on('error',reject);});
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('fixture timeout')));req.end(body);
  });
}
export const identityHeaders=()=>({'X-Mesh-Dictation-Client':randomUUID(),'X-Mesh-Request-Id':randomUUID(),'X-Mesh-Session':'alpha','X-Mesh-Created':'1','Content-Type':'audio/webm'});
export const python=()=>process.env.MESH_PYTHON??(fs.existsSync('.venv/bin/python')?path.resolve('.venv/bin/python'):
  (process.env.PATH??'').split(path.delimiter).map(dir=>path.resolve(dir,'python3')).find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true;}catch{return false;}})??'python3');
export function processBirth(pid:number):string|null {
  if(process.platform==='linux'){
    try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19]!;}catch{return null;}
  }
  const result=spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:2000});
  return result.status===0?result.stdout.trim()||null:null;
}
export function processState(pid:number):string|null {
  if(process.platform==='linux'){
    try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(') ')+2).split(' ')[0]!;}catch{return null;}
  }
  const result=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:2000});
  return result.status===0?result.stdout.trim().slice(0,1)||null:null;
}

interface FixtureOptions {childTempDepth?:number;workerEntry?:string;workerPreload?:string}
export async function fixture(enabled=true,noNode=false,nodePath?:string,options:FixtureOptions={}){
  const root=process.cwd();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-http-'));fs.chmodSync(directory,0o700);
  const home=path.join(directory,'home'),config=path.join(directory,'config'),run=path.join(directory,'run');
  for(const dir of [home,config,run,path.join(run,'session-mesh')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let created=1,malformed=false,upstreamCalls=0,inventoryCalls=0;
  let response={type:'application/json',body:'{"text":"bonjour"}'};
  let holdUpstream=false,activeUpstream=0,peakUpstream=0;
  const upstreamReleases:(()=>void)[]=[];
  const ops:string[]=[];
  let inventoryHandler:((reply:(incarnation?:number)=>void)=>void)|null=null;
  const peers=new Set<net.Socket>();
  const inventory=net.createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));let bytes=Buffer.alloc(0);socket.on('error',()=>{});socket.on('data',(part:Buffer)=>{
    bytes=Buffer.concat([bytes,part]);if(bytes.length<5||bytes.length<bytes.readUInt32BE(1)+5)return;
    if(bytes[0]!==67){socket.destroy();return;}
    const command=JSON.parse(bytes.subarray(5).toString());ops.push(command.op);inventoryCalls++;
    if(command.op==='attach_if'){
      socket.removeAllListeners('data');
      const body=Buffer.from(JSON.stringify({ok:command.name==='alpha'&&command.created===created}));
      const head=Buffer.alloc(5);head[0]=67;head.writeUInt32BE(body.length,1);
      socket.write(Buffer.concat([head,body,Buffer.from([68,0,0,0,0])]));return;
    }
    const listedCreated=created,listedMalformed=malformed;
    const reply=(incarnation=listedCreated)=>{
      if(socket.destroyed)return;
      const body=Buffer.from(JSON.stringify(listedMalformed?{bad:true}:[{name:'alpha',created:incarnation,activity:1,pid:123,cwd:home,attached:0,meta:{nonce:'a'.repeat(32)}}]));
      const head=Buffer.alloc(5);head[0]=67;head.writeUInt32BE(body.length,1);socket.end(Buffer.concat([head,body]));
    };
    if(inventoryHandler)inventoryHandler(reply);else reply();
  });});
  await new Promise<void>(r=>inventory.listen(path.join(run,'session-mesh','ptyhost.sock'),r));
  const upstream=http.createServer(async(req,res)=>{
    for await(const _ of req){/* drain fake audio */}
    upstreamCalls++;activeUpstream++;peakUpstream=Math.max(peakUpstream,activeUpstream);
    if(holdUpstream)await new Promise<void>(resolve=>upstreamReleases.push(resolve));
    activeUpstream--;res.setHeader('Content-Type',response.type);res.end(response.body);
  });
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const probe=net.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
  const env:NodeJS.ProcessEnv={PATH:noNode?'/nonexistent':process.env.PATH,HOME:home,MESH_CONF_DIR:config,MESH_CACHE_DIR:path.join(directory,'cache'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local','share'),XDG_RUNTIME_DIR:run,TMPDIR:directory,MESH_HOST:'127.0.0.1',MESH_PORT:String(port),PYTHONDONTWRITEBYTECODE:'1'};
  if(enabled)env.MESH_WHISPER_URL=`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/fixed`;
  if(options.childTempDepth){
    env.TMPDIR=path.join(directory,...Array.from({length:options.childTempDepth},()=> 'long-child-temp-segment'));
    fs.mkdirSync(env.TMPDIR,{recursive:true,mode:0o700});
  }
  if(options.workerEntry||options.workerPreload){
    const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
    nodePath=path.join(directory,'worker-node');
    fs.writeFileSync(nodePath,`#!/bin/sh\nexec ${quote(process.execPath)} ${options.workerPreload?'--require '+quote(options.workerPreload):''} ${options.workerEntry?quote(options.workerEntry):'"$@"'}\n`,{mode:0o700});
  }
  if(nodePath!==undefined)env.MESH_NODE=nodePath;
  const child=spawn(python(),['-B',path.join(root,'server.py')],{cwd:root,env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);
  const call=(p:string,method='GET',headers:any={},body:string|Buffer='')=>request({hostname:'127.0.0.1',port,path:p,method,headers},body);
  const close=async()=>{for(const release of upstreamReleases)release();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await until(()=>child.exitCode!==null||child.signalCode!==null);}child.stderr.destroy();for(const peer of peers)peer.destroy();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>inventory.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);fs.rmSync(directory,{recursive:true,force:true});};
  try{
    await until(async()=>{if(child.exitCode!==null)throw Error(`server fixture failed: ${errors}`);try{return [401,403].includes((await call('/api/transcribe/config')).status);}catch{return false;}});
  }catch(error){await close();throw error;}
  const token=fs.readFileSync(path.join(config,'token'),'utf8').trim();
  const auth={Authorization:`Bearer ${token}`};
  return {call,close,auth,token,config,directory,port,child,ops,onInventory:(handler:typeof inventoryHandler)=>inventoryHandler=handler,get errors(){return errors;},get upstreamCalls(){return upstreamCalls;},get peakUpstream(){return peakUpstream;},get inventoryCalls(){return inventoryCalls;},setCreated:(n:number)=>created=n,setMalformed:(v:boolean)=>malformed=v,setResponse:(type:string,body:string)=>response={type,body},holdUpstream:()=>{holdUpstream=true;},releaseUpstream:()=>{upstreamReleases.shift()!();}};
}
