// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {configuration} from './dictation.ts';
import {startService} from './dictation-service.ts';

async function main(){
  const config=configuration(process.env);if(!config)throw Error('Disabled worker');
  // Private inherited pipe: no secret in arguments, environment or output.
  let input='',ended=false;
  process.stdin.once('end',()=>{ended=true;});
  const bootstrap=await new Promise<{secret:string;socket:string;inventory:string;parent:number;principal:string}>((resolve,reject)=>{
    const receive=(part:Buffer)=>{
      input+=part.toString('utf8');if(input.length>4096){reject(Error('Bootstrap limit'));return;}
      const end=input.indexOf('\n');if(end<0)return;
      process.stdin.removeListener('data',receive);
      try{resolve(JSON.parse(input.slice(0,end)));}catch{reject(Error('Bootstrap invalid'));}input='';
    };
    process.stdin.on('data',receive);process.stdin.once('end',()=>reject(Error('Bootstrap closed')));
    setTimeout(()=>reject(Error('Bootstrap timeout')),5000).unref();
  });
  if(!/^[a-f0-9]{64}$/.test(bootstrap.secret)||!/^[a-f0-9]{64}$/.test(bootstrap.principal)||bootstrap.parent!==process.ppid||!bootstrap.socket.startsWith('/')||!bootstrap.inventory.startsWith('/'))throw Error('Bootstrap invalid');
  const service=await startService(config,bootstrap.secret,bootstrap.socket,bootstrap.inventory,bootstrap.principal);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;clearInterval(parentWatch);await service.close();process.exit(0);};
  const parentWatch=setInterval(()=>{if(process.ppid!==bootstrap.parent)void close();},250);
  process.stdin.on('end',()=>void close());process.stdin.resume();
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
  if(ended){await close();return;}
  process.stdout.write('ready\n');
}
void main().catch(()=>{process.stderr.write('Dictation worker unavailable.\n');process.exit(1);});
