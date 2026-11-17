// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {projectMembership} from './project-membership-view.ts';
import type {ProjectMembership} from './project-host.ts';
import {projectRoadmaps} from './project-roadmap-view.ts';
import {workPreview} from './project-work-preview.ts';
import {displayProjectTime} from './project-display-time.ts';
import type { Project, ProjectCatalog } from './project-catalog.ts';
import type { ProjectDetail } from './project-host.ts';
import { projectPreferences } from './project-followup-preferences.ts';
import { ProjectArtifactView } from './project-artifact-view.ts';
import type { ArtifactRequest } from './project-artifact-client.ts';
import {projectAttention} from './project-attention-view.ts';
import {projectActivity,rememberActivity,restoreActivity} from './project-activity-view.ts';

type Tab = 'overview' | 'work' | 'roster' | 'repository' | 'sessions' | 'activity' | 'sources';
type Translate = (key: string, values?: Record<string, string | number>) => string;
const tabs: Tab[] = ['overview', 'work', 'roster', 'repository', 'sessions', 'activity', 'sources'];

/** Read-only presentation of runner observations. No filesystem or execution capability. */
export class ProjectCockpitView {
  private tab: Tab = 'overview';
  private membership: ProjectMembership | undefined;
  private membershipKey = '';
  private membershipView: HTMLElement | null = null;
  private identity: string | null = null;
  private preferenceKey = '';
  private configRevision = '';
  private project: Project | undefined;
  private generated: string | undefined;
  private unavailable = false;
  private panel: HTMLElement | null = null;
  private navigation: HTMLElement | null = null;
  private readonly root: HTMLElement;
  private readonly observation: HTMLElement;
  private readonly context: HTMLElement;
  private readonly legacy: HTMLElement;
  private readonly t: Translate;
  private readonly selectTask: (source: string, task: string) => boolean;
  private readonly selectSource:((source:string,board:string|null)=>boolean)|undefined;
  private readonly readArtifacts: ((source:string)=>ArtifactRequest)|undefined;
  private artifactView:ProjectArtifactView|null=null;
  private artifactKey='';
  private artifactBoot='';
  constructor(root: HTMLElement, observation: HTMLElement, context: HTMLElement, legacy: HTMLElement, t: Translate,
    selectTask: (source: string, task: string) => boolean, readArtifacts?: (source:string)=>ArtifactRequest, selectSource?: (source:string,board:string|null)=>boolean) {
    this.root = root; this.observation = observation; this.context = context; this.legacy = legacy; this.t = t;
    this.selectTask = selectTask; this.readArtifacts = readArtifacts;this.selectSource=selectSource;
    root.classList.add('project-cockpit');
    const observer = new MutationObserver(() => this.apply());
    observer.observe(observation, { childList: true, subtree: true });
  }
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
    const node = this.root.ownerDocument.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private label(key: string) { return this.t(`projectCockpit.${key}`); }
  private button(text: string, action: () => void) {
    const button = this.el('button', text); button.type = 'button'; button.addEventListener('click', action); return button;
  }
  mount(host: HTMLElement, detail: ProjectDetail, machine: string, revision: string, unavailable = false, boot='', membership?:ProjectMembership) {
    const membershipKey=JSON.stringify([machine,detail.id,boot,membership]);
    if(this.membershipKey!==membershipKey){this.membershipKey=membershipKey;this.membership=membership;this.membershipView=membership?projectMembership(this.root.ownerDocument,membership,this.t):null;}
    if(this.artifactBoot!==boot){this.closeArtifacts();this.artifactBoot=boot;}
    this.unavailable = unavailable;
    const key = JSON.stringify(['cockpit', machine, detail.id]);
    if (this.preferenceKey !== key) {
      this.preferenceKey = key; this.identity = detail.id; this.project = undefined; this.generated = undefined;
      const selected = projectPreferences(this.root.ownerDocument).read(key).selected;
      this.tab = tabs.includes(selected as Tab) ? selected as Tab : 'overview';
    }
    if (this.configRevision !== revision) { this.configRevision = revision; this.project = undefined; this.generated = undefined; }
    const heading = host.querySelector('header');
    if (heading) { const actions = this.el('div'); actions.className = 'cockpit-actions';
      for (const button of Array.from(host.querySelectorAll(':scope > button, :scope > header > button'))) actions.append(button);
      heading.append(actions);
    }
    const kicker = this.el('p', this.label('kicker')); kicker.className = 'cockpit-kicker'; host.prepend(kicker);
    if (detail.description) { const description = this.el('p', detail.description); description.className = 'cockpit-description'; host.append(description); }
    const nav = this.el('nav'); nav.className = 'cockpit-tabs'; nav.setAttribute('aria-label', this.label('navigation'));
    for (const tab of tabs) { const button = this.button(this.label(tab), () => this.select(tab)); button.dataset.cockpitTab = tab; nav.append(button); }
    this.navigation = nav; host.append(nav);
    this.panel = this.el('section'); this.panel.className = 'cockpit-panel'; host.append(this.panel); this.render();
  }
  clearObserved() { this.closeArtifacts();this.project = undefined; this.generated = undefined; this.render(); }
  observed(catalog: ProjectCatalog) {
    this.project = catalog.projects.find(project => project.id === this.identity);
    this.generated = catalog.generated_at;
    if(this.tab==='roster'&&this.artifactView&&this.artifactKey===this.readerKey()){
      this.panel?.querySelector('.project-roster-task-summary')?.replaceWith(this.rosterTasks());this.apply();return;
    }
    this.render();
  }
  private select(tab: Tab) {
    if(tab!=='roster')this.closeArtifacts();
    this.tab = tab;
    const owner = projectPreferences(this.root.ownerDocument), preference = owner.read(this.preferenceKey);
    preference.selected = tab; owner.write(this.preferenceKey, preference); this.render();
  }
  private openSource(source:string,board:string|null):boolean {
    if(!this.selectSource?.(source,board))return false;
    this.select('work');
    const target=this.observation.querySelector<HTMLElement>('[data-followup-key="heading"]')??this.observation.querySelector<HTMLElement>('select')??this.navigation?.querySelector<HTMLElement>('[data-cockpit-tab="work"]');
    target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});return true;
  }
  private openWork(source: string, task: string) {
    this.select('work');
    this.selectTask(source, task); this.apply();
  }
  private card(title: string, target: Tab) {
    const card = this.el('section'); card.className = 'cockpit-card';
    const header = this.el('header'); header.append(this.el('h3', this.label(title)), this.button(this.label('open') + ' →', () => this.select(target))); card.append(header); return card;
  }
  private empty(parent: HTMLElement, key: string) { const note = this.el('p', this.label(this.unavailable && !this.project && key !== 'activityScope' ? 'collectionUnavailable' : key)); note.className = 'cockpit-empty'; parent.append(note); }
  private workCard() {
    const card = this.card('workMotion', 'work');
    card.classList.add('cockpit-work-preview');
    const scope=this.el('p',this.label('workScope'));scope.className='cockpit-empty';card.append(scope);
    const sources = this.project?.sources.filter(source => source.summary) ?? [];
    if (!sources.length) this.empty(card, 'noWork');
    for (const source of sources.slice(0, 2)) {
      const summary = source.summary!;
      const head = this.el('div'); head.className = 'cockpit-source-title'; head.append(this.el('strong', source.label), this.el('span', this.t('projects.status.' + source.status))); card.append(head);
      for (const item of workPreview(summary)) {
        const row = this.button('', () => this.openWork(source.id, item.id)); row.className = 'cockpit-work-row';
        const text = this.el('span'); text.append(this.el('strong', item.title), this.el('small', item.id));
        if(item.worker){const step=this.el('small',item.worker);step.className='cockpit-work-step';text.append(step);}
        const state = this.el('span', item.state); state.className = 'cockpit-badge'; row.append(text, state); card.append(row);
      }
      const metrics = this.el('dl'); metrics.className = 'cockpit-metrics'; const counts = summary.counts;
      for (const key of [counts.tasks_total === undefined ? 'total' : 'tasks_total', counts.tasks_done === undefined ? 'done' : 'tasks_done', 'active', 'queued']) {
        if (counts[key] === undefined) continue;
        const metric = this.el('div'); metric.append(this.el('dd', String(counts[key])), this.el('dt', this.t('projects.count.' + key))); metrics.append(metric);
      }
      card.append(metrics);
    }
    if (this.generated) { const stamp = this.el('small', this.label('snapshot') + ' · ' + displayProjectTime(this.generated,this.root.ownerDocument,this.t('projects.unknown'))); stamp.className = 'cockpit-stamp'; card.append(stamp); }
    return card;
  }
  private repositoryCard() {
    const card = this.card('repository', 'repository'); const repository = this.project?.repository;
    if (!repository) { this.empty(card, 'noRepository'); return card; }
    card.append(this.el('strong', repository.url)); const observed = repository.observation;
    if (observed?.ref) { const ref = this.el('p', observed.ref); ref.className = 'cockpit-ref'; card.append(ref); }
    if (observed?.commit) card.append(this.el('code', observed.commit.slice(0, 12)));
    if (observed?.readme.status === 'valid') card.append(this.el('p', this.label('readmeAvailable'))); else this.empty(card, 'noReadme');
    return card;
  }
  private sessionsCard() {
    const card = this.card('sessions', 'sessions');
    if(this.membership!==undefined){card.append(this.el('p',this.t('projectMembership.available')));return card;}
    const participants = this.project?.participations ?? [];
    if (!participants.length) this.empty(card, 'noSessions');
    for (const person of participants.slice(0, 4)) {
      const row = this.el('div'); row.className = 'cockpit-list-row';
      row.append(this.el('strong', person.label ?? (person.target.kind === 'mesh' ? person.target.name : person.target.agent)), this.el('small', person.role_label ?? person.recorded_relation)); card.append(row);
    }
    return card;
  }
  private sourcesCard() {
    const card = this.card('sources', 'sources'); if (!this.project?.sources.length) this.empty(card, 'noSources');
    for (const source of this.project?.sources ?? []) { const row = this.el('div'); row.className = 'cockpit-list-row'; row.append(this.el('strong', source.label), this.el('small', this.t('projects.status.' + source.status))); card.append(row); }
    return card;
  }
  private roster() {
    const card = this.card('roster', 'work'); const sources = this.project?.sources.filter(source => source.kind === 'roster') ?? [];
    if (!sources.length) {this.closeArtifacts();this.empty(card, 'noRoster');}
    if(this.readArtifacts&&sources.length){
      const choices=this.readerChoices(),key=this.readerKey();
      if(key!==this.artifactKey){this.closeArtifacts();this.artifactKey=key;this.artifactView=new ProjectArtifactView(this.root.ownerDocument,choices,this.readArtifacts,this.t);}
      if(this.artifactView)card.append(this.artifactView.root);
    }
    const tasks=this.rosterTasks();
    if(this.artifactView){
      const disclosure=this.el('details');disclosure.className='project-roster-tasks-disclosure';
      disclosure.append(this.el('summary',this.label('rosterTasks')),tasks);card.append(disclosure);
    }else card.append(tasks);
    return card;
  }
  private rosterTasks(){
    const summary=this.el('section');summary.className='project-roster-task-summary';
    for(const source of this.project?.sources.filter(source=>source.kind==='roster')??[]){
      summary.append(this.el('h4',source.label));if(!source.summary){this.empty(summary,'noWork');continue;}
      summary.append(this.el('p',this.label('rosterScope')));
      for(const item of source.summary.items){const row=this.button('',()=>this.openWork(source.id,item.id));row.className='cockpit-work-row';row.append(this.el('strong',item.id+' · '+item.title),this.el('span',item.state));summary.append(row);}
    }
    return summary;
  }
  private readerChoices(){return (this.project?.sources??[]).filter(source=>source.kind==='roster').map(source=>({id:source.id,label:source.label,tasks:source.summary?.pipeline?[]:(source.summary?.items??[]).map(item=>({id:item.id,title:item.title}))}));}
  private readerKey(){return JSON.stringify([this.preferenceKey,this.configRevision,this.readerChoices()]);}
  private closeArtifacts(){this.artifactView?.destroy();this.artifactView=null;this.artifactKey='';}
  private render() {
    if (!this.panel) return;
    if(this.tab==='sessions'&&this.membershipView?.parentElement===this.panel){this.apply();return;}
    const membershipActive=this.root.ownerDocument.activeElement as HTMLElement|null;
    const membershipFocus=this.root.ownerDocument.hasFocus()&&membershipActive&&this.membershipView?.contains(membershipActive)?membershipActive:null;
    const membershipScroll=Array.from(this.membershipView?.querySelectorAll<HTMLElement>('.project-membership-list')??[]).map(list=>list.scrollTop);
    const activityState=rememberActivity(this.panel.querySelector('.project-activity-feed'));
    const previousRoadmaps=this.panel.querySelector('.project-roadmaps');
    const roadmapScroll=previousRoadmaps?.querySelector('.project-roadmap-list')?.scrollTop??0;
    const roadmapActive=this.root.ownerDocument.activeElement as HTMLElement|null;
    const roadmapFocus=this.root.ownerDocument.hasFocus()&&roadmapActive&&previousRoadmaps?.contains(roadmapActive)?roadmapActive.dataset.roadmapKey:undefined;
    const previousAttention=this.panel.querySelector('.cockpit-attention');
    const openRequests=new Set(Array.from(previousAttention?.querySelectorAll<HTMLDetailsElement>('details[open]')??[]).map(row=>row.dataset.requestKey));
    const active=this.root.ownerDocument.activeElement as HTMLElement|null;
    const focusedRequest=this.root.ownerDocument.hasFocus()?active?.closest<HTMLElement>('.cockpit-attention details')?.dataset.requestKey:undefined;
    const requestScroll=previousAttention?.querySelector('.cockpit-attention-list')?.scrollTop??0;
    this.panel.replaceChildren();
    if (this.tab === 'overview') {
      const attention=projectAttention(this.root.ownerDocument,this.project,this.t);
      if(attention){
        this.panel.append(attention);
        for(const row of attention.querySelectorAll<HTMLDetailsElement>('details')){
          row.open=openRequests.has(row.dataset.requestKey);
          if(focusedRequest&&row.dataset.requestKey===focusedRequest)row.querySelector('summary')?.focus({preventScroll:true});
        }
        const list=attention.querySelector('.cockpit-attention-list');if(list)list.scrollTop=requestScroll;
      }
      const grid = this.el('div'); grid.className = 'cockpit-overview-grid';
      const main = this.el('div'), side = this.el('div');
      const roadmaps=projectRoadmaps(this.root.ownerDocument,this.project,this.t,this.selectSource?(source,board)=>this.openSource(source,board):undefined);
      if(roadmaps)main.append(roadmaps);main.append(this.workCard(), this.repositoryCard()); side.append(this.sessionsCard(), this.sourcesCard()); grid.append(main, side); this.panel.append(grid);
      if(roadmaps){const list=roadmaps.querySelector('.project-roadmap-list');if(list)list.scrollTop=roadmapScroll;if(roadmapFocus)for(const button of roadmaps.querySelectorAll<HTMLButtonElement>('button'))if(button.dataset.roadmapKey===roadmapFocus){button.focus({preventScroll:true});break;}}
    } else if (this.tab === 'roster') this.panel.append(this.roster());
    else if (this.tab === 'activity') {
      const card = this.card('activity', 'work'); this.empty(card, 'activityScope');
      card.append(projectActivity(this.root.ownerDocument,this.project,this.t,(source,task)=>this.openWork(source,task)));
      const observations=this.el('details');observations.className='project-activity-observations';
      observations.append(this.el('summary',this.t('projectActivity.observations')));
      for (const source of this.project?.sources ?? []) { const row = this.el('div'); row.className = 'cockpit-list-row'; row.append(this.el('strong', source.label), this.el('small', displayProjectTime(source.observed_at,this.root.ownerDocument,this.t('projects.unknown')))); observations.append(row); }
      card.append(observations);this.panel.append(card);
      restoreActivity(card,activityState);
    } else if(this.tab==='sessions'&&this.membershipView){
      this.panel.append(this.membershipView);
      Array.from(this.membershipView.querySelectorAll<HTMLElement>('.project-membership-list')).forEach((list,i)=>list.scrollTop=membershipScroll[i]??0);
      if(membershipFocus&&membershipFocus.isConnected&&this.root.ownerDocument.activeElement===this.root.ownerDocument.body)membershipFocus.focus({preventScroll:true});
    } else if (!this.project && this.tab !== 'sources') this.empty(this.panel, 'observeFirst');
    else if (this.tab === 'sessions' && !this.project?.sessions.length && !this.project?.participations?.length) this.empty(this.panel, 'noSessions');
    else if (this.tab === 'work' && !this.project?.sources.some(source => source.summary?.followup || source.summary?.pipeline || ['github','gitlab'].includes(source.kind)&&source.url)) this.empty(this.panel, 'noWork');
    else if (this.tab === 'repository' && !this.project?.repository) this.empty(this.panel, 'noRepository');
    this.apply();
  }
  private apply() {
    this.root.dataset.cockpitView = this.tab;
    for (const button of Array.from(this.navigation?.querySelectorAll<HTMLButtonElement>('[data-cockpit-tab]') ?? [])) button.setAttribute('aria-current', String(button.dataset.cockpitTab === this.tab));
    this.context.hidden = this.tab !== 'sources'; this.legacy.hidden = this.tab !== 'sources';
    // Capture status/cancellation remains reachable even when all detail sections are hidden.
    this.observation.hidden = false;
    const detail = this.observation.querySelector('.projects-detail'); if (!detail) return;
    for (const child of Array.from(detail.children)) {
      if (!(child instanceof this.root.ownerDocument.defaultView!.HTMLElement)) continue;
      child.hidden = (this.tab==='sessions'&&this.membership!==undefined)||!this.project || (child.dataset.cockpitSection ?? 'work') !== this.tab;
    }
  }
}
