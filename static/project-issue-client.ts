// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectHTTP } from './project-host.ts';
import { replyBytes } from './project-artifact-client.ts';
import type { ArtifactScope } from './project-artifact-client.ts';
import type { WorkCard } from './project-work-card.ts';
export interface IssueIdentity { host:'github.com'|'gitlab.com'; issueId:string; nodeId:string|null; projectId:string|null }
export interface IssueRecord extends WorkCard { nativeIdentity:IssueIdentity|null; url:string; description:string|null; descriptionTruncated:boolean; updated:string }
export interface IssuePage { items:IssueRecord[]; page:number; hasMore:boolean; partial:boolean; observed:string }
export interface IssueReader { scopeKey:string; read:(page:number,signal:AbortSignal)=>Promise<IssuePage> }
const label=(value:unknown,max=1000):value is string=>typeof value==='string'&&value.length<=max;
function nativeIdentity(value:unknown,provider:'github'|'gitlab'):IssueIdentity|null {
  if(!value||typeof value!=='object')return null;
  const row=value as Record<string,unknown>;
  const stableId=(id:unknown):id is string=>typeof id==='string'&&/^[1-9][0-9]{0,19}$/.test(id)&&BigInt(id)<2n**64n;
  if(row.host!==`${provider}.com`||!stableId(row.issue_id))return null;
  return {host:row.host as IssueIdentity['host'],issueId:row.issue_id,
    nodeId:provider==='github'&&typeof row.node_id==='string'&&/^[A-Za-z0-9_+/=:-]{1,240}$/.test(row.node_id)?row.node_id:null,
    projectId:provider==='gitlab'&&stableId(row.project_id)?row.project_id:null};
}
export function readIssue(value:unknown,scope:string,provider:'github'|'gitlab',repository:string):IssueRecord|null {
  if(!value||typeof value!=='object')return null;
  const row=value as Record<string,unknown>;
  if(!label(row.id,40)||!/^\d+$/.test(row.id)||!label(row.title)||!label(row.state,80)||!['todo','doing','blocked','done','cancelled','unknown'].includes(String(row.column)))return null;
  const labels=Array.isArray(row.labels)?row.labels.slice(0,32).flatMap(value=>{
    if(!value||typeof value!=='object'||!label(value.name,480))return [];
    return [{name:value.name,...(typeof value.color==='string'&&/^#[a-f0-9]{6}$/i.test(value.color)?{color:value.color}:{})}];
  }):[];
  const key=JSON.stringify([scope,provider,repository,row.id]);
  return {nativeIdentity:nativeIdentity(row.native_identity,provider),key,selection:key,source:scope,provider,id:row.id,title:row.title,state:row.state,column:row.column as WorkCard['column'],meaning:'source-state',labels,
    assignees:Array.isArray(row.assignees)?row.assignees.filter((value):value is string=>label(value,480)).slice(0,20):[],
    priority:label(row.priority,240)?row.priority:null,prerequisites:[],progress:null,
    url:`https://${provider}.com/${repository}/${provider==='github'?'issues':'-/issues'}/${row.id}`,
    description:label(row.description,65536)?row.description:null,descriptionTruncated:row.description_truncated===true,updated:label(row.updated_at,80)?row.updated_at:''};
}
export function issueReader(request:ProjectHTTP,scope:ArtifactScope):IssueReader {
  const scopeKey=JSON.stringify(scope);
  return {scopeKey,read:async(page,signal)=>{
    const response=await request('/api/projects/issues/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,page}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(25000)]),cache:'no-store',redirect:'error'});
    if(!response.ok)throw Error('unavailable');
    const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await replyBytes(response)));
    if(reply.kind!=='mesh-project-issues-reply'||reply.version!==1||reply.page!==page)throw Error('invalid');
    for(const [key,value]of Object.entries(scope))if(reply[key]!==value)throw Error('source-changed');
    if(reply.status!=='ok')throw Error(reply.status==='unsupported'?'not-configured':'unavailable');
    const data=reply.issues;
    if(!data||!['github','gitlab'].includes(data.provider)||!label(data.repository,1000)||!Array.isArray(data.items)||data.items.length>25||data.page!==page||typeof data.has_more!=='boolean'||!label(data.observed_at,80))throw Error('invalid');
    const items=data.items.map((value:unknown)=>readIssue(value,scopeKey,data.provider,data.repository)).filter((value:IssueRecord|null):value is IssueRecord=>value!==null);
    return {items,page,hasMore:data.has_more,partial:data.partial===true||items.length!==data.items.length,observed:data.observed_at};
  }};
}
