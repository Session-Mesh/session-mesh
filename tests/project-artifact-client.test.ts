// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readArtifact,artifactItem,artifactRequest,type ArtifactItem,type ArtifactRequest} from '../static/project-artifact-client.ts';
const pages=['Résumé 😀\n','Second page é\nEND'],full=pages.join(''),total=Buffer.byteLength(full),digest=createHash('sha256').update(full).digest('hex');
const item:ArtifactItem={id:'brief',kind:'intake',format:'markdown',body:{availability:'valid',ref:'reference',sha256:digest,total_bytes:total}};
function request(change:(page:Record<string,unknown>,index:number)=>void=()=>{}):ArtifactRequest{let index=0,offset=0;return async()=>{const text=pages[index]!,end=offset+Buffer.byteLength(text);const data={ref:'reference',sha256:digest,total_bytes:total,range:{start:offset,end},text,next_cursor:index===0?'next':null,eof:index===1};const value={kind:'artifact-page',schema:{id:'schema',digest:'a'.repeat(64)},source:{id:'source',scope:'task',task:'brief'},data};change(value,index);index++;offset=end;return value;};}
test('complete Unicode body is assembled and verified across real byte ranges',async()=>{assert.equal(await readArtifact(request(),{kind:'artifact-list'},item,new AbortController().signal,()=>{}),full);});
test('source changes between pages cannot publish a mixed document',async()=>{await assert.rejects(readArtifact(request((value,index)=>{if(index)(value.source as {id:string}).id='other';}),{kind:'artifact-list'},item,new AbortController().signal,()=>{}),/source-changed/);});
test('noncontiguous pages and false byte ranges fail closed',async()=>{await assert.rejects(readArtifact(request((value,index)=>{if(index)((value.data as {range:{start:number}}).range).start++;}),{kind:'artifact-list'},item,new AbortController().signal,()=>{}),/source-changed/);});
test('matching metadata cannot substitute for a verified body digest',async()=>{await assert.rejects(readArtifact(request((value,index)=>{if(index)(value.data as {text:string}).text='x'.repeat(Buffer.byteLength(pages[1]!));}),{kind:'artifact-list'},item,new AbortController().signal,()=>{}),/source-changed/);});
test('oversized bodies are rejected before the first read',async()=>{let calls=0;await assert.rejects(readArtifact(async()=>{calls++;throw Error('unexpected');},{kind:'artifact-list'},{...item,body:{...item.body,total_bytes:16777217}},new AbortController().signal,()=>{}),/invalid/);assert.equal(calls,0);});
test('an aborted selection performs no page requests',async()=>{let calls=0;const controller=new AbortController();controller.abort();await assert.rejects(readArtifact(async()=>{calls++;throw Error('unexpected');},{kind:'artifact-list'},item,controller.signal,()=>{}));assert.equal(calls,0);});

test('malformed artifact entries stay local to that entry',()=>{assert.deepEqual(artifactItem(item),item);for(const value of [null,{}, {...item,kind:'<script>'},{...item,body:{...item.body,total_bytes:Infinity}},{...item,body:{...item.body,ref:'../escape'}}])assert.equal(artifactItem(value),null);const absent=artifactItem({...item,body:{availability:'absent',ref:{malformed:true}}});assert.equal(absent?.body.ref,null);assert.equal(absent?.body.availability,'absent');});

test('actual unsupported runtime reply has a dedicated reason after scope validation',async()=>{
  const scope={project_id:'one',source_id:'source',boot:'a'.repeat(64),machine_id:'host',revision:'cfg1_'+'b'.repeat(64)};
  const reply={...scope,kind:'mesh-project-artifact-reply',version:1,status:'unsupported',code:'roster-runtime-unavailable'};
  const request=artifactRequest(async()=>new Response(JSON.stringify(reply)),scope);
  await assert.rejects(request({kind:'artifact-list'},new AbortController().signal),error=>error instanceof Error&&error.message==='not-configured');
  const changed=artifactRequest(async()=>new Response(JSON.stringify({...reply,revision:'cfg1_'+'c'.repeat(64)})),scope);
  await assert.rejects(changed({kind:'artifact-list'},new AbortController().signal),/source-changed/);
});
