// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { ProjectDom } from './project-catalog-view.ts';
import type { Translate } from './project-catalog-view.ts';
import type { Project, ProviderSummary } from './project-catalog.ts';
import { FollowupPreferenceStore } from './project-followup-preferences.ts';
import type { FollowupPreferences, FollowupMode } from './project-followup-preferences.ts';
import { FollowupView } from './project-followup-view.ts';
import { followupRows, validValue } from './project-followup-model.ts';
import type { FollowupRow } from './project-followup-model.ts';
import { workInspector,focusWorkCard } from './project-work-layout.ts';
import { renderFollowupDetail, formatRange } from './project-followup-detail.ts';
import { ObservationAge } from './project-followup-time.ts';
import { readFollowupContext, resolveFollowupLinks, followupScope, FollowupFreshness } from './project-followup-context.ts';
const FRESHNESS_TICK_MS = 1000;
export interface FollowupOptions { root: HTMLElement; summary: ProviderSummary; machine: string; project: Project;
  source: string; translate: Translate; preferences?: FollowupPreferenceStore; followupContext?: unknown; observationState?: FollowupObservationState }
export interface FollowupObservationState { age: ObservationAge; links: FollowupFreshness; sourceRevision: string | null; estimateRevision: number | null; inconsistent: boolean }
/** A local controller owns only its diagram and UI preferences. */
export class ProjectFollowupController {
  private options: FollowupOptions;
  private dom: ProjectDom;
  private view: FollowupView;
  private store: FollowupPreferenceStore;
  private scope: string;
  private state: FollowupPreferences;
  private rows: FollowupRow[];
  private age = new ObservationAge();
  private linkAges = new FollowupFreshness();
  private ageLabel: HTMLElement | null = null;
  private contextLabel: HTMLElement | null = null;
  private revisionInconsistent = false;
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private pointer: { id: number; type: string; x: number; y: number; left: number } | null = null;
  private pointers = new Set<number>();
  private invalidClick = false;
  private naturalRelease = false;
  private abort: AbortController;
  constructor(options: FollowupOptions) {
    this.options = options; this.dom = new ProjectDom(options.root.ownerDocument, options.translate);
    this.abort = new (options.root.ownerDocument.defaultView?.AbortController ?? AbortController)();
    const scope = followupScope(options.machine, options.project.id, options.source, options.summary);
    if (options.observationState) {
      this.age = options.observationState.age;
      this.linkAges = options.observationState.links;
      const forecast = validValue(options.summary.followup?.forecast), source = options.summary.source_revision ?? null;
      const identified = scope !== null && source !== null, sameSource = identified && source === options.observationState.sourceRevision;
      this.revisionInconsistent = sameSource && (options.observationState.inconsistent ||
        forecast !== null && options.observationState.estimateRevision !== null && forecast.estimate_revision !== options.observationState.estimateRevision);
      const revision = forecast?.estimate_revision ?? (sameSource ? options.observationState.estimateRevision : null);
      options.observationState.sourceRevision = identified ? source : null;
      options.observationState.estimateRevision = identified ? revision : null;
      options.observationState.inconsistent = this.revisionInconsistent;
    }
    const sameNativeScope = scope !== null && options.root.dataset.followupScope === scope;
    if (scope) options.root.dataset.followupScope = scope; else delete options.root.dataset.followupScope;
    this.store = scope ? options.preferences ?? new FollowupPreferenceStore('project-followup') : new FollowupPreferenceStore('project-followup');
    this.scope = scope ?? JSON.stringify(['unavailable-native', options.machine, options.project.id, options.source]); this.state = this.store.read(this.scope);
    if(options.summary.pipeline&&this.state.mode==='kanban')this.state.mode='summary';
    this.rows = followupRows(options.summary); options.root.className = 'project-followup';
    this.view = new FollowupView(options.root, this.dom, { mode: mode => this.changeMode(mode), zoom: delta => this.zoom(delta),
      page: amount => this.page(amount), select: key => this.select(key), reveal: () => this.reveal() }, options.summary,
      this.scope);
    this.bind(); this.paint(sameNativeScope); this.timer = setInterval(() => { if (!this.dom.doc.hidden && !this.stopped) this.freshness(); }, FRESHNESS_TICK_MS);
  }
  private bind() {
    const root = this.options.root, signal = this.abort.signal;
    root.addEventListener('pointerdown', event => this.pointerDown(event), { signal });
    root.addEventListener('pointermove', event => this.pointerMove(event), { signal });
    root.addEventListener('pointerup', event => { this.naturalRelease = true; this.pointers.delete(event.pointerId); this.pointer = null; }, { signal });
    root.addEventListener('pointercancel', event => { this.pointers.delete(event.pointerId); this.invalidate(); }, { signal });
    root.addEventListener('lostpointercapture', () => { if (!this.naturalRelease) this.invalidate(); }, { signal });
    root.addEventListener('click', event => { if (event.detail > 0 && this.invalidClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, { capture: true, signal });
    root.addEventListener('keydown', event => {
      const target = event.target as HTMLElement;
      const inspectorOpen=this.options.root.querySelector('.project-work-inspector')!==null;
      if (target.matches('input,textarea,select,[contenteditable="true"]')) {if(event.key==='Escape'&&inspectorOpen)event.stopPropagation();return;}
      if(event.key==='Escape'&&inspectorOpen){event.preventDefault();event.stopPropagation();this.closeDetail();return;}
      if (event.key === '+' || event.key === '-') { event.preventDefault(); this.zoom(event.key === '+' ? 0.25 : -0.25); }
    }, { signal });
    this.dom.doc.addEventListener('visibilitychange', () => { if (!this.dom.doc.hidden && !this.stopped) this.freshness(); }, { signal });
  }
  private pointerDown(event: PointerEvent) {
    if (this.pointers.size) { this.pointers.add(event.pointerId); this.invalidate(); return; }
    this.pointers.add(event.pointerId); this.invalidClick = false; this.naturalRelease = false;
    this.pointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, left: this.chart()?.scrollLeft ?? 0 };
  }
  private pointerMove(event: PointerEvent) {
    const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    if (distance < 6) return;
    this.invalidClick = true;
    const chart = this.chart();
    // Touch and pen keep native scrolling, inertia and pinch; tracking still suppresses drag clicks.
    if (pointer.type === 'mouse' && chart && Math.abs(event.clientX - pointer.x) > Math.abs(event.clientY - pointer.y)) {
      try { chart.setPointerCapture(event.pointerId); } catch { /* The browser may already have cancelled a native gesture. */ }
      chart.scrollLeft = pointer.left - (event.clientX - pointer.x);
    }
  }
  private invalidate() { this.invalidClick = true; this.pointer = null; }
  private chart(): HTMLElement | null { return this.options.root.querySelector('.project-followup-chart'); }
  private save() {
    const chart = this.chart(); if (chart) { this.state.left = chart.scrollLeft; this.state.top = chart.scrollTop; }
    const inspector=this.options.root.querySelector<HTMLElement>('.project-work-inspector');if(inspector)this.state.inspectorTop=inspector.scrollTop;
    const details = Array.from(this.options.root.querySelectorAll<HTMLDetailsElement>('details[data-followup-key]'));
    const present = new Set(details.map(item => item.dataset.followupKey!));
    this.state.disclosures = [...this.state.disclosures.filter(key => !present.has(key)), ...details.filter(item => item.open).map(item => item.dataset.followupKey!)];
    this.store.write(this.scope, this.state);
  }
  private paint(preserveFocus = true) {
    const active = this.dom.doc.activeElement as HTMLElement | null;
    const focus = preserveFocus && this.dom.doc.hasFocus() && active && this.options.root.contains(active) ? active.dataset.followupKey : undefined;
    this.state.page = Math.min(Math.max(0, Math.ceil(this.rows.length / 50) - 1), this.state.page);
    const chart = this.view.paint(this.rows, this.state);
    const selected = this.rows.find(row => row.key === this.state.selected);
    if (selected) {
      const inspector=workInspector(this.dom,()=>this.closeDetail());
      renderFollowupDetail(inspector, selected, this.state, this.dom, amount => this.attemptPage(amount));
      const layout=this.options.root.querySelector('.project-work-layout')!;layout.classList.add('has-inspector');layout.append(inspector);
    }
    else if (this.state.selected !== null) this.options.root.append(this.dom.element('p', this.dom.t('projects.followup.selectionMissing')));
    if (selected && !this.rows.slice(this.state.page * 50, (this.state.page + 1) * 50).includes(selected)) this.options.root.append(this.view.button(this.dom.t('projects.followup.reveal'), 'reveal', () => this.reveal()));
    this.observation(); this.restoreDisclosures(); chart.scrollLeft = this.state.left; chart.scrollTop = this.state.top;
    const inspector=this.options.root.querySelector<HTMLElement>('.project-work-inspector');if(inspector)inspector.scrollTop=this.state.inspectorTop;
    if (focus) {
      const controls = Array.from(this.options.root.querySelectorAll<HTMLElement>('[data-followup-key]'));
      const target=controls.find(control => control.dataset.followupKey === focus) ?? controls.find(control => control.dataset.followupKey?.startsWith('row-')) ?? controls[0];
      target?.focus({ preventScroll: true });
      if(target?.closest('.project-work-inspector'))target.scrollIntoView({block:'nearest',inline:'nearest'});
    }
  }
  private restoreDisclosures() {
    for (const item of this.options.root.querySelectorAll<HTMLDetailsElement>('details[data-followup-key]')) {
      item.open = this.state.disclosures.includes(item.dataset.followupKey!);
      const summary = item.querySelector('summary'); if (summary) summary.dataset.followupKey = `summary-${item.dataset.followupKey}`;
      item.addEventListener('toggle', () => { if (!this.stopped) this.save(); }, { signal: this.abort.signal });
    }
  }
  private observation() {
    this.ageLabel = this.dom.element('p'); this.ageLabel.className = 'project-followup-age'; this.options.root.append(this.ageLabel); this.freshness();
    const forecast = validValue(this.options.summary.followup?.forecast);
    if (forecast) {
      this.options.root.append(this.dom.element('p', this.dom.t('projects.followup.forecast', { value: forecast.status, time: forecast.as_of })));
      this.dom.paragraph(this.options.root, 'projects.followup.remainingRange', formatRange(forecast.global_eta.remaining_minutes, this.dom));
      if (forecast.global_eta.finish_at) this.dom.paragraph(this.options.root, 'projects.followup.finishRange',
        `${forecast.global_eta.finish_at.optimistic} / ${forecast.global_eta.finish_at.likely} / ${forecast.global_eta.finish_at.pessimistic}`);
      this.dom.paragraph(this.options.root, 'projects.followup.plannerBasis', forecast.based_on_state_revision ?? this.dom.t('projects.unknown'));
      this.options.root.append(this.dom.element('p', this.dom.t('projects.followup.capacityUnknown')));
      for (const assumption of forecast.assumptions.items) this.options.root.append(this.dom.element('p', assumption));
    }
    if (this.revisionInconsistent) this.options.root.append(this.dom.element('p', this.dom.t('projects.followup.revisionInconsistent')));
    this.sourceDiagnostics();
    this.events();
    this.contextLabel = this.dom.element('div'); this.options.root.append(this.contextLabel); this.associations();
  }
  private sourceDiagnostics() {
    const followup = this.options.summary.followup; if (!followup) return;
    const section = this.dom.disclosure(this.options.root, this.dom.t('projects.followup.diagnostics')); section.dataset.followupKey = 'source-diagnostics';
    for (const [name, family] of [['metadata', followup.metadata], ['forecast', followup.forecast]] as const) {
      section.append(this.dom.element('p', `${name} · ${family.availability}${family.reason ? ` · ${family.reason}` : ''}${family.truncated ? ` · ${this.dom.t('projects.followup.partial')}` : ''}`));
      if (family.availability === 'valid' && family.value === null) section.append(this.dom.element('p', this.dom.t('projects.unknown')));
    }
    if (followup.metadata.availability === 'valid' && followup.metadata.value) section.append(this.dom.element('p', followup.metadata.value.board_id));
    if (followup.truncated) section.append(this.dom.element('p', this.dom.t('projects.followup.partial')));
  }
  private events() {
    const family = this.options.summary.followup?.events;
    if (!family) return;
    const events = validValue(family), section = this.dom.disclosure(this.options.root, this.dom.t('projects.followup.events'));
    section.dataset.followupKey = 'source-events';
    if (!events) { section.append(this.dom.element('p', `${family.availability} · ${family.reason ?? ''}`)); return; }
    section.append(this.dom.element('p', this.dom.t('projects.followup.eventCoverage', { value: events.items.length, total: events.total ?? this.dom.t('projects.unknown') })));
    if (events.truncated) section.append(this.dom.element('p', this.dom.t('projects.followup.partial')));
    const list = this.dom.element('ol');
    for (const event of events.items) {
      const row = this.dom.element('li', `${event.action} · ${event.task_id ?? this.dom.t('projects.unknown')} · ${event.at ?? this.dom.t('projects.unknown')}`);
      if (event.reason !== null) row.append(this.dom.element('p', event.reason)); list.append(row);
    }
    section.append(list);
  }
  private associations() {
    if (!this.contextLabel) return;
    const context = readFollowupContext(this.options.followupContext);
    this.contextLabel.replaceChildren(this.dom.element('p', this.dom.t('projects.followup.association', { value: context.provenance ?? context.reason ?? context.availability })));
    const monotonic = this.dom.doc.defaultView?.performance.now() ?? 0;
    for (const binding of resolveFollowupLinks(context, this.options.machine, this.options.project, Date.now(), { ages: this.linkAges, monotonic })) {
      const child = binding.childPipeline, parent = binding.parentItem;
      const pending = binding.valid && parent?.state === 'active' && child?.qa?.status === 'GO' && child.review?.status === 'GO' && child.latest_completed?.phase === 'qa' && child.latest_completed.outcome === 'GO' && !child.verdict_disagreement;
      this.contextLabel.append(this.dom.element('p', this.dom.t(pending ? 'projects.followup.pendingReceipt' : 'projects.followup.linkDiagnostic', {
        parent: `${binding.link.parent.source_id}/${binding.link.parent.task_id}`, child: `${binding.link.child.source_id}/${binding.link.child.task_id}`, value: binding.reason })));
    }
  }
  private freshness() {
    if (!this.ageLabel) return;
    const window = this.dom.doc.defaultView;
    const age = this.age.age(this.options.summary.source_generated_at ?? null, Date.now(), window?.performance.now() ?? 0);
    this.ageLabel.textContent = this.dom.t(age === null ? 'projects.followup.ageUnknown' : age >= 120000 ? 'projects.followup.stale' : 'projects.followup.age', { value: age === null ? '' : Math.floor(age / 1000) });
    this.associations();
  }
  private changeMode(mode: string) { if (this.stopped) return; this.save(); this.state.mode = mode as FollowupMode; this.paint(); }
  private zoom(amount: number) { if (this.stopped) return; this.save(); this.state.zoom = Math.min(4, Math.max(0.5, this.state.zoom + amount)); this.paint(); }
  private page(amount: number) { if (this.stopped) return; this.save(); this.state.page = Math.max(0, this.state.page + amount); this.paint(); }
  private closeDetail(){
    if(this.stopped)return;const key=this.state.selected;this.save();this.state.selected=null;this.state.inspectorTop=0;this.paint();this.save();
    if(key!==null)focusWorkCard(this.options.root,key);
  }
  private revealDetail(){
    if(!this.dom.doc.hidden&&this.dom.doc.hasFocus())this.options.root.querySelector('.project-work-inspector')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  private select(key: string) { if (this.stopped) return; this.save(); if(this.state.selected!==key)this.state.inspectorTop=0;this.state.selected = key; this.state.attemptPage = 0; this.paint();this.revealDetail(); }
  /** Select a reported task across every page and presentation mode. */
  selectTask(id: string): boolean {
    if (this.stopped) return false;
    const index = this.rows.findIndex(row => row.id === id); if (index < 0) return false;
    this.save();if(this.state.selected!==this.rows[index]!.key)this.state.inspectorTop=0;this.state.selected = this.rows[index]!.key;
    this.state.page = Math.floor(index / 50); this.state.attemptPage = 0; this.paint();this.revealDetail();return true;
  }
  private reveal() { if (this.stopped) return; this.save(); this.state.page = Math.floor(this.rows.findIndex(row => row.key === this.state.selected) / 50); this.paint(); }
  private attemptPage(amount: number) {
    if (this.stopped) return;
    this.save(); const row = this.rows.find(row => row.key === this.state.selected), count = validValue(row?.detail?.timeline)?.items.length ?? 0;
    this.state.attemptPage = Math.min(Math.max(0, Math.ceil(count / 50) - 1), Math.max(0, this.state.attemptPage + amount)); this.paint();
  }
  destroy() { this.save(); this.stopped = true; clearInterval(this.timer); this.invalidate(); this.abort.abort(); }
}
export function mountProjectFollowup(options: FollowupOptions) { return new ProjectFollowupController(options); }
