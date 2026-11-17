// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {Project} from './project-catalog.ts';
import {validValue} from './project-followup-model.ts';
import {recordedInstant} from './project-followup-time.ts';
type Translate=(key:string,values?:Record<string,string|number>)=>string;
/** Published history only: events do not assert current worker activity. */
export function projectActivity(doc:Document,project:Project|undefined,t:Translate,open:(source:string,task:string)=>void):HTMLElement {
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const labels=new Map([['accept',t('projectActivity.action.accept')],['claim',t('projectActivity.action.claim')],['finish',t('projectActivity.action.finish')],['progress',t('projectActivity.action.progress')],['estimate',t('projectActivity.action.estimate')],['verify',t('projectActivity.action.verify')],['reconcile',t('projectActivity.action.reconcile')],['revise',t('projectActivity.action.revise')],['cancel',t('projectActivity.action.cancel')],['record',t('projectActivity.action.record')],['release',t('projectActivity.action.release')],['derive',t('projectActivity.action.derive')],['withdraw-derived',t('projectActivity.action.withdrawDerived')],['complete',t('projectActivity.action.complete')]]);
  const root=el('section');root.className='project-activity-feed';root.append(el('h4',t('projectActivity.title')));
  if(!project){root.append(el('p',t('projectActivity.waiting')));return root;}
  const sources=project.sources.filter(source=>source.kind==='roster')??[];
  if(!sources.length)root.append(el('p',t('projectActivity.notProvided')));
  for(const source of sources){
    const board=validValue(source.summary?.followup?.metadata)?.board_id??null;
    const section=el('section');section.className='project-activity-source';section.dataset.activitySource=source.id;section.dataset.activityScope=JSON.stringify([project?.id,source.id,board]);
    const header=el('header');header.append(el('h5',source.label),el('small',source.id));section.append(header);
    const family=source.summary?.followup?.events,events=source.status==='available'?validValue(family):null;
    if(!events){section.append(el('p',t(source.status==='available'&&(!family||family.availability==='not-provided')?'projectActivity.notProvidedSource':'projectActivity.unavailable')));root.append(section);continue;}
    section.append(el('p',t('projectActivity.coverage',{count:events.items.length,total:events.total??t('projects.unknown')})));
    if(events.truncated||family?.truncated)section.append(el('p',t('projectActivity.partial')));
    if(!events.items.length)section.append(el('p',t(events.total===0&&!events.truncated&&!family?.truncated?'projectActivity.empty':'projectActivity.noVisible')));
    const list=el('ol');list.className='project-activity-list';list.setAttribute('aria-label',source.label+' · '+source.id);
    // Known recorded dates newest first; unknown dates last, ties retain provider order.
    const ordered=events.items.map((event,index)=>({event,index,time:recordedInstant(event.at)})).sort((a,b)=>a.time===null?(b.time===null?a.index-b.index:1):b.time===null?-1:b.time-a.time||a.index-b.index);
    const occurrences=new Map<string,number>();
    for(const {event} of ordered){
      const identity=JSON.stringify([project?.id,source.id,board,event.action,event.task_id,event.at,event.reason]);
      const occurrence=occurrences.get(identity)??0;occurrences.set(identity,occurrence+1);
      const key=JSON.stringify([identity,occurrence]);
      const item=el('li'),main=el('div');main.className='project-activity-event';
      main.append(el('strong',labels.get(event.action)??t('projectActivity.action.other',{value:event.action})));
      const instant=recordedInstant(event.at),time=el('time');
      time.textContent=instant===null?t('projectActivity.unknownDate'):new Intl.DateTimeFormat(doc.documentElement.lang||'en',{dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
      if(instant!==null&&event.at){time.dateTime=event.at;time.title=event.at;}main.append(time);
      if(event.task_id!==null){
        const task=source.summary?.items.find(item=>item.id===event.task_id);
        if(task){const button=el('button',task.id+' · '+task.title);button.type='button';button.className='project-activity-task';button.dataset.activityFocus=key;button.addEventListener('click',()=>open(source.id,task.id));main.append(button);}
        else main.append(el('span',t('projectActivity.taskUnavailable',{value:event.task_id})));
      }
      if(event.reason!==null){const detail=el('details'),summary=el('summary',t('projectActivity.reason'));detail.dataset.activityKey=key;summary.dataset.activityFocus=key+'-reason';detail.append(summary,el('p',event.reason));main.append(detail);}
      item.append(main);list.append(item);
    }
    section.append(list);root.append(section);
  }
  return root;
}

export function rememberActivity(root:HTMLElement|null){
  const active=root?.ownerDocument.activeElement as HTMLElement|null;
  return {opened:new Set(Array.from(root?.querySelectorAll<HTMLDetailsElement>('details[open]')??[]).map(node=>node.dataset.activityKey)),
    scroll:new Map(Array.from(root?.querySelectorAll<HTMLElement>('.project-activity-source')??[]).map(node=>[node.dataset.activityScope,node.querySelector('.project-activity-list')?.scrollTop??0])),
    focus:root?.ownerDocument.hasFocus()&&active&&root.contains(active)?active.dataset.activityFocus:undefined};
}
export function restoreActivity(root:HTMLElement,state:ReturnType<typeof rememberActivity>){
  for(const node of root.querySelectorAll<HTMLDetailsElement>('details'))node.open=state.opened.has(node.dataset.activityKey);
  for(const source of root.querySelectorAll<HTMLElement>('.project-activity-source')){const list=source.querySelector('.project-activity-list');if(list)list.scrollTop=state.scroll.get(source.dataset.activityScope)??0;}
  if(state.focus)for(const node of root.querySelectorAll<HTMLElement>('[data-activity-focus]'))if(node.dataset.activityFocus===state.focus){node.focus({preventScroll:true});break;}
}
