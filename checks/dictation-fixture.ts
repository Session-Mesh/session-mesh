// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared isolated real-server fixture. All services, credentials and paths are test-owned.
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

export async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await delay(10);}throw Error('fixture readiness timeout');}
export function request(options:http.RequestOptions,body:string|Buffer=''){
  return new Promise<{status:number;body:any;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
    const req=http.request({...options,agent:false},res=>{const parts:Buffer[]=[];res.on('data',p=>parts.push(p));res.on('end',()=>{const text=Buffer.concat(parts).toString();let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode!,body,headers:res.headers});});res.on('error',reject);});
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('fixture timeout')));req.end(body);
  });
}
