// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ArtifactItem, ArtifactQuery, ArtifactRequest } from './project-artifact-client.ts';
import { artifactItem,readArtifact,ArtifactReaderNotConfigured } from './project-artifact-client.ts';
import { artifactDocument } from './project-artifact-document.ts';
export interface ArtifactSource { id:string; label:string; tasks:{id:string;title:string}[] }
type Translate=(key:string, values?:Record<string,string|number>)=>string;

export class ProjectArtifactView {
  readonly root:HTMLElement;
  private source:HTMLSelectElement;
  private task:HTMLSelectElement;
  private list:HTMLElement;
  private body:HTMLElement;
  private status:HTMLElement;
  private heading:HTMLElement;
  private more:HTMLButtonElement;
  private controller=new AbortController();
  private reading=new AbortController();
  private cursor:string|undefined;
  private items:ArtifactItem[]=[];
  private request:ArtifactRequest|null=null;
  private query:ArtifactQuery={kind:'artifact-list'};
  private listing=false;
  private opened=false;
  private showAbsent=false;
  private readonly sources:ArtifactSource[];
  private readonly factory:(source:string)=>ArtifactRequest;
  private readonly t:Translate;
  constructor(doc:Document, sources:ArtifactSource[], factory:(source:string)=>ArtifactRequest, t:Translate) {
    this.sources=sources;this.factory=factory;this.t=t;
    this.root=doc.createElement('section'); this.root.className='project-artifact-browser';
    const controls=doc.createElement('div');controls.className='project-artifact-controls';
    this.source=doc.createElement('select');this.source.setAttribute('aria-label',t('projects.artifacts.source'));
    this.task=doc.createElement('select');this.task.setAttribute('aria-label',t('projects.artifacts.task'));
    for(const source of sources){const option=doc.createElement('option');option.value=source.id;option.textContent=source.label;this.source.append(option);}
    this.source.onchange=()=>this.selectSource();this.task.onchange=()=>this.reset();controls.append(this.source,this.task);
    const absent=doc.createElement('button');absent.type='button';absent.className='btn';absent.textContent=t('projects.artifacts.showAbsent');absent.setAttribute('aria-pressed','false');
    absent.onclick=()=>{this.showAbsent=!this.showAbsent;absent.setAttribute('aria-pressed',String(this.showAbsent));for(const button of this.list.querySelectorAll<HTMLButtonElement>('button:disabled'))button.hidden=!this.showAbsent;};controls.append(absent);
    const refresh=doc.createElement('button');refresh.type='button';refresh.className='btn';refresh.textContent=t('projects.artifacts.refresh');refresh.onclick=()=>this.reset();controls.append(refresh);
    const layout=doc.createElement('div');layout.className='project-artifact-layout';
    this.list=doc.createElement('nav');this.list.className='project-artifact-list';this.list.setAttribute('aria-label',t('projects.artifacts.documents'));
    const document=doc.createElement('section');document.className='project-artifact-document';
    this.heading=doc.createElement('h3');this.body=doc.createElement('div');this.body.className='project-artifact-content';
    this.status=doc.createElement('p');this.status.className='project-artifact-status';this.status.setAttribute('role','status');
    this.more=doc.createElement('button');this.more.type='button';this.more.className='btn';this.more.textContent=t('projects.artifacts.more');this.more.onclick=()=>void this.load();
    document.append(this.heading,this.status,this.body);layout.append(this.list,document);this.root.append(controls,layout,this.more);this.selectSource();
  }
  destroy(){this.controller.abort();this.reading.abort();this.root.remove();}
  private selectSource(){
    this.task.replaceChildren();const source=this.sources.find(value=>value.id===this.source.value);
    for(const task of source?.tasks??[]){const option=this.root.ownerDocument.createElement('option');option.value=task.id;option.textContent=`${task.id} · ${task.title}`;this.task.append(option);}
    this.task.hidden=!source?.tasks.length;this.reset();
  }
  private reset(){
    this.controller.abort();this.reading.abort();this.controller=new AbortController();this.reading=new AbortController();
    this.request=null;this.more.hidden=true;this.more.disabled=true;
    this.cursor=undefined;this.items=[];this.listing=false;this.opened=false;this.list.replaceChildren();this.body.replaceChildren();this.heading.textContent=this.t('projects.artifacts.documents');
    this.query={kind:'artifact-list',...(this.task.value?{roadmap_task_id:this.task.value}:{})};
    try{this.request=this.factory(this.source.value);void this.load();}catch(error){this.status.textContent=this.failure(error);}
  }
  private failure(error:unknown){return this.t(error instanceof ArtifactReaderNotConfigured?'projects.artifacts.notConfigured':'projects.artifacts.unavailable');}
  private async load(){
    const request=this.request;if(!request||this.listing||this.controller.signal.aborted)return;
    this.listing=true;const signal=this.controller.signal;this.more.disabled=true;if(!this.opened)this.status.textContent=this.t('projects.artifacts.loading');
    try{
      const reply=await request({...this.query,...(this.cursor?{cursor:this.cursor}:{})},signal);signal.throwIfAborted();
      if(!Array.isArray(reply.data.items)||reply.data.items.length>25)throw Error('invalid');
      const items=reply.data.items.map(artifactItem).filter((item):item is ArtifactItem=>item!==null);
      this.items=items;this.list.replaceChildren();for(const item of items)this.append(item);
      const next=reply.data.next_cursor;if(next!==null&&(typeof next!=='string'||!next||next.length>8192||next===this.cursor))throw Error('invalid');
      this.cursor=next===null?undefined:next as string;this.more.hidden=!this.cursor;
      if(!this.opened)this.status.textContent=this.t(this.items.some(item=>item.body.availability==='valid')?'projects.artifacts.choose':'projects.artifacts.empty');
      if(items.length!==reply.data.items.length){const warning=this.root.ownerDocument.createElement('p');warning.textContent=this.t('projects.artifacts.partial');this.list.append(warning);}
    }catch(error){if(!signal.aborted)this.status.textContent=this.failure(error);}
    finally{if(!signal.aborted){this.listing=false;this.more.disabled=false;}}
  }
  private append(item:ArtifactItem){
    const doc=this.root.ownerDocument,button=doc.createElement('button');button.type='button';button.className='project-artifact-item';button.dataset.artifactKind=item.kind;
    const title=doc.createElement('strong');title.textContent=this.t(`projects.artifacts.kind.${item.kind}`);
    const subtitle=doc.createElement('small');subtitle.textContent=item.id;button.append(title,subtitle);button.title=`${item.kind} · ${item.id}`;
    button.disabled=item.body.availability!=='valid'||!item.body.ref;button.setAttribute('aria-pressed','false');
    button.hidden=button.disabled&&!this.showAbsent;
    if(button.disabled){const absent=doc.createElement('small');absent.textContent=this.t('projects.artifacts.absent');button.append(absent);}
    button.onclick=()=>void this.open(item,button);this.list.append(button);
  }
  private async open(item:ArtifactItem,button:HTMLButtonElement){
    const request=this.request;if(!request)return;
    this.opened=true;this.reading.abort();this.reading=new AbortController();const signal=this.reading.signal;this.body.replaceChildren();
    for(const entry of this.list.querySelectorAll('button'))entry.setAttribute('aria-pressed',String(entry===button));
    this.heading.textContent=`${this.t(`projects.artifacts.kind.${item.kind}`)} · ${item.id}`;this.body.setAttribute('aria-busy','true');
    try{
      const text=await readArtifact(request,this.query,item,signal,(bytes,total)=>{if(!signal.aborted)this.status.textContent=this.t('projects.artifacts.reading',{value:Math.round(bytes/1024),total:Math.ceil(total/1024)});});
      signal.throwIfAborted();artifactDocument(this.body,text,item.format,this.t);this.status.textContent=this.t('projects.artifacts.complete',{value:item.body.total_bytes??0});
    }catch(error){if(!signal.aborted)this.status.textContent=this.failure(error);}
    finally{if(!signal.aborted)this.body.setAttribute('aria-busy','false');}
  }
}
