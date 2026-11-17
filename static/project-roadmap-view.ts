// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {Project} from './project-catalog.ts';
import {validValue} from './project-followup-model.ts';
import {roadmapLifecycle} from './project-roadmap-lifecycle.ts';
import {displayProjectTime} from './project-display-time.ts';
type Translate=(key:string,values?:Record<string,string|number>)=>string;
export function projectRoadmaps(doc:Document,project:Project|undefined,t:Translate,open?: (source:string,board:string|null)=>boolean):HTMLElement|null {
  if(!project)return null;
  const roster=project.sources.filter(source=>source.kind==='roster');
  const sources=roster.filter(source=>source.summary?.provider_schema==='roster-roadmap-view');
  const unresolved=roster.filter(source=>!source.summary);
  if(!sources.length&&!unresolved.length)return null;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const root=el('section');root.className='cockpit-card project-roadmaps';
  const header=el('header');header.append(el('h3',t('projectRoadmaps.title')),el('small',t('projectRoadmaps.count',{count:sources.length})));root.append(header);
  root.append(el('p',t('projectRoadmaps.scope')));
  const list=el('div');list.className='project-roadmap-list';
  for(const source of sources){
    const summary=source.summary!,metadata=validValue(summary.followup?.metadata),state=roadmapLifecycle(source);
    const row=el('article');row.className='project-roadmap';row.dataset.roadmapSource=source.id;
    const identity=JSON.stringify([project.id,source.id,metadata?.board_id??null]);
    const top=el('div');top.className='project-roadmap-heading';
    if(open&&source.status==='available'&&summary.followup){
      const button=el('button',source.label);button.type='button';button.className='project-roadmap-open';button.dataset.roadmapKey=identity;button.setAttribute('aria-label',source.label+' · '+source.id);
      button.addEventListener('click',()=>{if(!open(source.id,metadata?.board_id??null))notice.textContent=t('projectRoadmaps.openUnavailable');});top.append(button);
    }else top.append(el('strong',source.label));
    const badge=el('span',t(`projectRoadmaps.state.${state}`));badge.className='project-roadmap-state';badge.dataset.lifecycle=state;top.append(badge);row.append(top);
    row.append(el('small',source.id+(metadata?' · '+metadata.board_id:'')));
    const time=el('small',t('projectRoadmaps.observed',{time:displayProjectTime(source.observed_at,doc,t('projects.unknown'))}));row.append(time);
    if(metadata)row.append(el('small',t('projectRoadmaps.revision',{value:metadata.state_revision})));
    if(state==='inconsistent')row.append(el('p',t('projectRoadmaps.inconsistent')));
    list.append(row);
  }
  root.append(list);
  for(const source of unresolved)root.append(el('p',t('projectRoadmaps.unresolved',{source:source.label,id:source.id})));
  const notice=el('p');notice.setAttribute('role','status');root.append(notice);return root;
}
