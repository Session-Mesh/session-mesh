// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectHTTP } from './project-host.ts';
export interface ArtifactScope { project_id:string; source_id:string; boot:string; machine_id:string; revision:string }
export interface ArtifactQuery { kind:'artifact-list'|'artifact-read'; roadmap_task_id?:string; ref?:string; cursor?:string }
export interface ArtifactItem { id:string; kind:string; format:string; body:{availability:string;ref:string|null;sha256:string|null;total_bytes:number|null} }
interface Envelope { kind:string; schema:{id:string;digest:string}; source:{id:string;scope:string;task:string|null}; data:Record<string,unknown> }
export type ArtifactRequest = (query:ArtifactQuery, signal:AbortSignal) => Promise<Envelope>;
export class ArtifactReaderNotConfigured extends Error {
  constructor(){super('not-configured');}
}
const MAX_BODY = 16 * 1024 * 1024;
export function artifactItem(value:unknown):ArtifactItem|null{
  if(!value||typeof value!=='object')return null;
  const item=value as ArtifactItem,body=item.body;
  if(typeof item.id!=='string'||!item.id||item.id.length>2000||!['spec','intake','spec-result','plan','plan-data','implementer-brief','reviewer-brief','qa-scope','implementation','review','qa-state','qa','ledger','manifest','agent-definition','agent-manifest'].includes(item.kind)||!['markdown','json','text'].includes(item.format)||!body||!['valid','absent','invalid'].includes(body.availability))return null;
  if(body.availability==='valid'&&(typeof body.ref!=='string'||!/^[A-Za-z0-9_-]{1,4096}$/.test(body.ref)||typeof body.sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.sha256)||!Number.isSafeInteger(body.total_bytes)||body.total_bytes!<0||body.total_bytes!>MAX_BODY))return null;
  return {id:item.id,kind:item.kind,format:item.format,body:{availability:body.availability,ref:body.availability==='valid'?body.ref:null,sha256:body.availability==='valid'?body.sha256:null,total_bytes:body.availability==='valid'?body.total_bytes:null}};
}
export async function replyBytes(response:Response):Promise<Uint8Array>{
  if(!response.body)throw Error('unavailable');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024+4096)throw Error('too-large');chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}return joined;
}
export function artifactRequest(request:ProjectHTTP, scope:ArtifactScope): ArtifactRequest {
  return async (query, signal) => {
    const response = await request('/api/projects/artifacts/v1', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,...query}),signal:AbortSignal.any([signal,AbortSignal.timeout(35000)]),cache:'no-store',redirect:'error'});
    if (!response.ok) throw Error('unavailable');
    const bytes = await replyBytes(response);
    const reply = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (reply.kind !== 'mesh-project-artifact-reply' || reply.version !== 1) throw Error('unavailable');
    for (const [key,value] of Object.entries({...scope,...(query.roadmap_task_id ? {roadmap_task_id:query.roadmap_task_id} : {})})) if (reply[key] !== value) throw Error('source-changed');
    if(reply.status==='unsupported')throw new ArtifactReaderNotConfigured();
    if(reply.status!=='ok')throw Error('unavailable');
    const artifact = reply.artifact as Envelope;
    if (!artifact || artifact.kind !== (query.kind === 'artifact-list' ? 'artifact-list':'artifact-page') || artifact.schema?.id !== 'https://github.com/mathiasbourgoin/roster/schema/artifact-observation/v1' || !/^[a-f0-9]{64}$/.test(artifact.schema.digest) || !/^[a-f0-9]{64}$/.test(artifact.source?.id) || !artifact.data) throw Error('invalid');
    return artifact;
  };
}
export async function readArtifact(request:ArtifactRequest, query:ArtifactQuery, item:ArtifactItem, signal:AbortSignal, progress:(bytes:number,total:number)=>void):Promise<string> {
  const total = item.body.total_bytes, digest = item.body.sha256;
  if (!Number.isSafeInteger(total) || total! < 0 || total! > MAX_BODY || !digest || !/^[a-f0-9]{64}$/.test(digest) || !item.body.ref) throw Error('invalid');
  const chunks:Uint8Array[] = []; let offset = 0, cursor:string|undefined, identity = '';
  for (let page = 0; page < 129; page++) {
    signal.throwIfAborted();
    const reply = await request({...query,kind:'artifact-read',ref:item.body.ref,...(cursor ? {cursor}: {})},signal), data = reply.data;
    const current = JSON.stringify([reply.schema,reply.source]); if (identity && identity !== current) throw Error('source-changed'); identity = current;
    const range = data.range as {start:number;end:number};
    if (data.ref !== item.body.ref || data.sha256 !== digest || data.total_bytes !== total || typeof data.text !== 'string' || !range || range.start !== offset) throw Error('source-changed');
    const bytes = new TextEncoder().encode(data.text);
    if (range.end !== offset + bytes.length || range.end > total! || (bytes.length === 0 && total !== 0)) throw Error('invalid');
    chunks.push(bytes); offset = range.end; progress(offset,total!);
    if (data.eof === true) {
      if (offset !== total || data.next_cursor !== null) throw Error('invalid');
      const joined = new Uint8Array(total!); let index = 0; for (const chunk of chunks) {joined.set(chunk,index);index+=chunk.length;}chunks.length=0;
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',joined))).map(value=>value.toString(16).padStart(2,'0')).join('');
      if (actual !== digest) throw Error('source-changed'); signal.throwIfAborted();
      return new TextDecoder('utf-8',{fatal:true}).decode(joined);
    }
    if (data.eof !== false || typeof data.next_cursor !== 'string' || !data.next_cursor || data.next_cursor === cursor || data.next_cursor.length > 8192) throw Error('invalid');
    cursor=data.next_cursor;
  }
  throw Error('too-large');
}
