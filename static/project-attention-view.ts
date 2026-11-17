// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {Project} from './project-catalog.ts';
type Translate=(key:string,values?:Record<string,string|number>)=>string;
/** Only explicit published operator requests; no inference from sessions or issue labels. */
export function projectAttention(doc:Document,project:Project|undefined,t:Translate):HTMLElement|null {
  const sources=project?.sources.filter(source=>source.kind==='roster')??[];
  if(!sources.length)return null;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const card=el('section');card.className='cockpit-card cockpit-attention';
  const header=el('header'),heading=el('h3',t('projectAttention.title'));header.append(heading);card.append(header);
  const requests:{source:string;sourceId:string;id:string;title:string}[]=[],unavailable:string[]=[];
  let partial=false;
  for(const source of sources){
    const summary=source.summary;
    if(source.status!=='available'||!summary||!['valid','absent'].includes(summary.operator_status??'')){
      unavailable.push(source.label);continue;
    }
    const items=summary.operator_requests??[];
    const open=items.filter(item=>item.state==='open');
    for(const item of open)requests.push({source:source.label,sourceId:source.id,id:item.id,title:item.title});
    partial ||= summary.operator_truncated===true || items.some(item=>!['open','answered','withdrawn','archived'].includes(item.state))
      || summary.counts.operator_open!==undefined&&summary.counts.operator_open!==open.length;
  }
  card.classList.toggle('has-requests',requests.length>0);card.classList.toggle('has-unavailable',unavailable.length>0);
  const count=el('span',t('projectAttention.count',{count:Math.min(50,requests.length)}));count.className='cockpit-attention-count';header.append(count);
  const scope=el('p',t('projectAttention.scope'));scope.className='cockpit-attention-scope';card.append(scope);
  const shown=requests.slice(0,50),list=el('div');list.className='cockpit-attention-list';
  for(const item of shown){
    const row=el('details'),summary=el('summary');row.dataset.requestKey=JSON.stringify([item.sourceId,item.id]);summary.append(el('strong',item.title));
    summary.append(el('small',item.source+' · '+item.sourceId+' / '+item.id));row.append(summary,el('p',item.title));list.append(row);
  }
  card.classList.toggle('is-empty',requests.length===0&&!unavailable.length&&!partial);
  if(shown.length)card.append(list);
  else card.append(el('p',t(unavailable.length||partial?'projectAttention.noVisible':'projectAttention.empty')));
  if(partial||requests.length>50)card.append(el('p',t('projectAttention.partial')));
  if(unavailable.length){const note=el('p',t('projectAttention.unavailable',{sources:unavailable.join(', ')}));note.className='cockpit-attention-warning';card.append(note);}
  return card;
}
