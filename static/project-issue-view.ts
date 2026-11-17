// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { IssueReader, IssuePage, IssueRecord } from './project-issue-client.ts';
import { renderKanban } from './project-kanban-view.ts';
import { renderProjectMarkdown } from './project-markdown.ts';
import { workLayout,workInspector,focusWorkCard } from './project-work-layout.ts';
interface ReadingPosition {
  pan:{left:number;top:number};
  inspectorKey:string|undefined;
  inspectorTop:number;
  focus:string|undefined;
}
export class ProjectIssueView {
  readonly root:HTMLElement;
  private dom:ProjectDom;
  private reader:IssueReader;
  private abort:AbortController|null=null;
  private page:IssuePage|null=null;
  private selected:string|null=null;
  private filter='';
  private stopped=false;
  private escape=(event:KeyboardEvent)=>{
    const target=event.target as HTMLElement;
    if(event.key!=='Escape')return;
    const inspectorOpen=this.root.querySelector('.project-work-inspector')!==null;
    if(target.matches('input,textarea,select,[contenteditable="true"]')){if(inspectorOpen)event.stopPropagation();return;}
    if(inspectorOpen){
      event.preventDefault();event.stopPropagation();this.closeDetail();
    }
  };
  constructor(dom:ProjectDom,reader:IssueReader){this.dom=dom;this.reader=reader;this.root=dom.element('section');this.root.className='project-issue-view';this.root.dataset.followupScope=reader.scopeKey;this.root.addEventListener('keydown',this.escape);this.paint();}
  destroy(){this.stopped=true;this.abort?.abort();this.root.removeEventListener('keydown',this.escape);}
  private closeDetail(){if(this.stopped)return;const key=this.selected;this.selected=null;this.paint();if(key!==null)focusWorkCard(this.root,key);}
  private button(key:string,action:()=>void){const button=this.dom.element('button',this.dom.t(`projects.issues.${key}`));button.type='button';button.className='btn';button.dataset.followupKey=`issues-${key}`;button.addEventListener('click',action);return button;}
  private async load(page:number){
    const samePage=this.page?.page===page;
    const position=samePage?this.readingPosition():undefined;
    this.abort?.abort();const abort=new AbortController();this.abort=abort;
    this.root.replaceChildren(this.dom.element('p',this.dom.t('projects.issues.loading')));
    try{const value=await this.reader.read(page,abort.signal);if(this.stopped||this.abort!==abort||abort.signal.aborted)return;this.page=value;
      if(!samePage){this.selected=null;this.filter='';}
      if(this.filter&&!value.items.some(item=>item.labels.some(label=>label.name===this.filter)))this.filter='';
      if(!value.items.some(item=>item.key===this.selected&&(!this.filter||item.labels.some(label=>label.name===this.filter))))this.selected=null;
      const doc=this.dom.doc;
      const restoreFocus=!doc.hidden&&doc.hasFocus()&&doc.activeElement===doc.body;
      this.paint(undefined,position?{...position,focus:restoreFocus?position.focus:undefined}:undefined);}
    catch(error){if(this.stopped||this.abort!==abort||abort.signal.aborted)return;this.page=null;this.paint(error instanceof Error&&error.message==='not-configured'?'notConfigured':'failed');}
  }
  private readingPosition():ReadingPosition {
    const chart=this.root.querySelector<HTMLElement>('.project-kanban');
    const inspector=this.root.querySelector<HTMLElement>('.project-work-inspector');
    const active=this.dom.doc.activeElement as HTMLElement|null;
    return {pan:{left:chart?.scrollLeft??0,top:chart?.scrollTop??0},inspectorTop:inspector?.scrollTop??0,
      inspectorKey:inspector?.dataset.workKey,focus:active&&this.root.contains(active)?active.dataset.followupKey:undefined};
  }
  private paint(error?:string,position=this.readingPosition()){
    const dom=this.dom,bar=dom.element('div');bar.className='project-followup-controls';
    const {pan,inspectorKey,inspectorTop,focus}=position;
    bar.append(this.button(this.page?'refresh':'load',()=>void this.load(this.page?.page??1)));
    this.root.replaceChildren(bar);
    if(error)this.root.append(dom.element('p',dom.t(`projects.issues.${error}`)));
    if(!this.page){this.root.append(dom.element('p',dom.t('projects.issues.explanation')));return;}
    const page=this.page;
    const back=this.button('previous',()=>void this.load(page.page-1)),next=this.button('next',()=>void this.load(page.page+1));
    back.disabled=page.page===1;next.disabled=!page.hasMore;bar.append(back,dom.element('span',dom.t('projects.issues.page',{value:page.page})),next);
    const label=dom.element('label',dom.t('projects.issues.labels')),filter=dom.element('select');filter.setAttribute('aria-label',dom.t('projects.issues.labels'));
    filter.dataset.followupKey='issues-labels';
    const all=dom.element('option',dom.t('projects.issues.allLabels'));all.value='';filter.append(all);
    for(const name of [...new Set(page.items.flatMap(item=>item.labels.map(label=>label.name)))].sort()){
      const option=dom.element('option',name);option.value=name;filter.append(option);
    }
    filter.value=this.filter;filter.addEventListener('change',()=>{this.filter=filter.value;this.selected=null;this.paint();});label.append(filter);bar.append(label);
    this.root.append(dom.element('p',dom.t('projects.issues.observed',{value:page.observed})));
    if(page.partial)this.root.append(dom.element('p',dom.t('projects.issues.partial')));
    const cards=page.items.filter(item=>!this.filter||item.labels.some(label=>label.name===this.filter));
    const chart=renderKanban(dom,cards,this.selected,key=>{
      if(this.selected===key){this.root.querySelector('.project-work-inspector')?.scrollIntoView({block:'nearest'});return;}
      this.selected=key;this.paint();this.root.querySelector('.project-issue-detail')?.scrollIntoView({block:'nearest'});
    });
    // Empty Markdown can clamp the saved position; preserve any subsequent reader movement.
    let initialInspectorTop=0;
    const layout=workLayout(dom,chart),selected=page.items.find(item=>item.key===this.selected);
    if(selected){
      const inspector=workInspector(dom,()=>this.closeDetail());
      inspector.dataset.workKey=selected.key;
      void this.detail(selected,inspector).then(()=>{
        if(!this.stopped&&this.root.contains(inspector)&&this.selected===selected.key&&inspectorKey===selected.key&&inspector.scrollTop===initialInspectorTop)inspector.scrollTop=inspectorTop;
      });
      layout.classList.add('has-inspector');layout.append(inspector);
    }
    this.root.append(layout);chart.scrollLeft=pan.left;chart.scrollTop=pan.top;
    const currentInspector=layout.querySelector<HTMLElement>('.project-work-inspector');if(currentInspector&&inspectorKey===selected?.key){currentInspector.scrollTop=inspectorTop;initialInspectorTop=currentInspector.scrollTop;}
    if(focus)Array.from(this.root.querySelectorAll<HTMLElement>('[data-followup-key]')).find(node=>node.dataset.followupKey===focus)?.focus({preventScroll:true});
  }
  private async detail(issue:IssueRecord,parent:HTMLElement){
    const dom=this.dom,section=dom.element('section');section.className='project-issue-detail project-artifact-document';
    section.append(dom.element('h3',`${issue.id} · ${issue.title}`));
    dom.link(section,dom.t('projects.issues.openSource'),issue.url);
    section.append(dom.element('p',`${issue.state}${issue.updated?' · '+issue.updated:''}`));
    let rendered:Promise<void>|undefined;
    if(issue.description!==null){const body=dom.element('div');body.className='project-artifact-markdown';rendered=renderProjectMarkdown(body,issue.description,{preserveFrontmatter:true});section.append(body);}
    else section.append(dom.element('p',dom.t('projects.issues.noDescription')));
    if(issue.descriptionTruncated)section.append(dom.element('p',dom.t('projects.issues.truncated')));
    parent.append(section);await rendered;
  }
}
