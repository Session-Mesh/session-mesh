// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProviderSummary } from './project-catalog.ts';
import type { ProjectDom } from './project-catalog-view.ts';
import type { FollowupPreferences } from './project-followup-preferences.ts';
import type { FollowupRow } from './project-followup-model.ts';
import { durationGeometry } from './project-followup-graph.ts';
import { rowGraph, estimateMinutes, taskCoverage } from './project-followup-model.ts';
import { renderClockGantt } from './project-gantt-view.ts';
import { renderDependencyGraph } from './project-dependency-view.ts';
import { renderKanban } from './project-kanban-view.ts';
import { rosterWorkCard } from './project-work-card.ts';
import { workLayout } from './project-work-layout.ts';
export interface FollowupActions { mode: (mode: string) => void; zoom: (amount: number) => void; page: (amount: number) => void;
  select: (key: string) => void; reveal: () => void }
export class FollowupView {
  readonly root: HTMLElement;
  readonly dom: ProjectDom;
  private actions: FollowupActions;
  private summary: ProviderSummary;
  private source: string;
  constructor(root: HTMLElement, dom: ProjectDom, actions: FollowupActions, summary: ProviderSummary, source = '') {
    this.root = root; this.dom = dom; this.actions = actions; this.summary = summary; this.source = source;
  }
  button(label: string, key: string, action: () => void): HTMLButtonElement {
    const button = this.dom.element('button', label); button.type = 'button'; button.className = 'btn'; button.dataset.followupKey = key;
    button.addEventListener('click', action); return button;
  }
  controls(state: FollowupPreferences, count: number): HTMLElement {
    const controls = this.dom.element('div'); controls.className = 'project-followup-controls';
    const label = this.dom.element('label', this.dom.t('projects.followup.view'));
    label.className = 'project-followup-mode-picker';
    const select = this.dom.element('select'); select.dataset.followupKey = 'view-mode';
    select.setAttribute('aria-label', this.dom.t('projects.followup.view'));
    for (const mode of ['summary', ...this.summary.pipeline ? [] : ['kanban'], 'timeline', 'timeline-total', 'timeline-remaining', 'dependencies']) {
      const option = this.dom.element('option', this.dom.t(`projects.followup.mode.${mode}`)); option.value = mode; select.append(option);
    }
    select.value = state.mode; select.addEventListener('change', () => this.actions.mode(select.value)); label.append(select); controls.append(label);
    if (state.mode.startsWith('timeline')) {
      const zoom = this.dom.element('div'); zoom.className = 'project-followup-zoom';
      zoom.append(this.button(this.dom.t('projects.followup.zoomOut'), 'zoom-out', () => this.actions.zoom(-0.25)),
        this.dom.element('output', `${state.zoom}×`), this.button(this.dom.t('projects.followup.zoomIn'), 'zoom-in', () => this.actions.zoom(0.25)));
      controls.append(zoom);
    }
    if (count > 50) {
      const pages = this.dom.element('div'); pages.className = 'project-followup-pages';
      const previous = this.button(this.dom.t('projects.followup.previous'), 'previous', () => this.actions.page(-1));
      const next = this.button(this.dom.t('projects.followup.next'), 'next', () => this.actions.page(1));
      previous.disabled = state.page === 0; next.disabled = state.page >= Math.ceil(count / 50) - 1;
      pages.append(previous, this.dom.element('span', this.dom.t('projects.followup.page', { value: state.page + 1, total: Math.ceil(count / 50) })), next);
      controls.append(pages);
    }
    return controls;
  }
  row(row: FollowupRow, selected: boolean): HTMLElement {
    const result = this.dom.element('div'); result.className = 'project-followup-row'; result.dataset.rowId = row.key;
    const button = this.button(`${row.id} · ${row.title}`, `row-${row.key}`, () => this.actions.select(row.key));
    button.title = `${row.id} · ${row.title}`;
    button.setAttribute('aria-pressed', String(selected)); result.append(button);
    result.append(this.dom.element('span', this.dom.t(`projects.followup.meaning.${row.meaning}`, { value: row.state })));
    if (row.worker) result.append(this.dom.element('span', this.dom.t('projects.followup.worker', { value: row.worker })));
    return result;
  }
  chart(rows: FollowupRow[], state: FollowupPreferences): HTMLElement {
    if (state.mode === 'kanban' && !this.summary.pipeline) return renderKanban(this.dom,
      rows.slice(state.page * 50, (state.page + 1) * 50).map(row => rosterWorkCard(row, this.source)), state.selected, this.actions.select);
    if (state.mode === 'dependencies') return this.dependencies(rows, state);
    if (state.mode === 'timeline') return renderClockGantt(this.dom, rows, this.summary, state, this.actions.select);
    const scroll = this.dom.element('div'); scroll.className = 'project-followup-chart'; scroll.dataset.followupKey = 'chart';
    scroll.tabIndex = 0; scroll.setAttribute('aria-label', this.dom.t(`projects.followup.mode.${state.mode}`));
    const plane = this.dom.element('div'); plane.className = 'project-followup-plane'; plane.style.width = `${Math.min(32768, 800 * state.zoom)}px`;
    const visible = rows.slice(state.page * 50, (state.page + 1) * 50), geometry = durationGeometry(rows.map(row => estimateMinutes(row, state.mode)), 500 * state.zoom);
    for (const row of visible) {
      const element = this.row(row, row.key === state.selected), shape = geometry[rows.indexOf(row)]!;
      if (state.mode === 'timeline-total' || state.mode === 'timeline-remaining') this.estimate(element, row, shape, state.mode);
      plane.append(element);
    }
    scroll.append(plane); return scroll;
  }
  private dependencies(rows: FollowupRow[], state: FollowupPreferences): HTMLElement {
    const layout = this.dom.element('div'); layout.className = 'project-dependencies';
    const list = this.dom.element('section'); list.className = 'project-dependency-list';
    list.append(this.dom.element('h5', this.dom.t('projects.followup.dependencyTasks')));
    const visible = rows.slice(state.page * 50, (state.page + 1) * 50), graph = rowGraph(rows, this.summary);
    for (const row of visible) {
      const element = this.row(row, row.key === state.selected);
      element.append(this.dom.element('span', this.dom.t('projects.followup.meaning.source-state', { value: row.state })));
      const level = graph.levels.get(row.id);
      element.append(this.dom.element('span', this.dom.t(level === null || level === undefined ? 'projects.followup.dependencyUnknown' : 'projects.followup.level', { value: level ?? '' })));
      element.append(this.dom.element('span', row.dependsOn.join(', ') || this.dom.t('projects.followup.noDependencies')));
      if (graph.unresolved.includes(row.id)) element.append(this.dom.element('span', this.dom.t('projects.followup.cycle')));
      if (row.dependsOn.includes(row.id)) element.append(this.dom.element('span', this.dom.t('projects.followup.selfDependency')));
      const missing = row.dependsOn.filter(id => !rows.some(candidate => candidate.id === id));
      const offPage = row.dependsOn.filter(id => rows.some(candidate => candidate.id === id) && !visible.some(candidate => candidate.id === id));
      if (missing.length) element.append(this.dom.element('span', this.dom.t(taskCoverage(this.summary) ? 'projects.followup.missingDependency' : 'projects.followup.truncatedDependency', { value: missing.join(', ') })));
      if (offPage.length) element.append(this.dom.element('span', this.dom.t('projects.followup.offPageDependency', { value: offPage.join(', ') })));
      list.append(element);
    }
    const graphPanel = this.dom.element('section'); graphPanel.className = 'project-dependency-panel';
    graphPanel.append(this.dom.element('h5', this.dom.t('projects.followup.dependencyGraph')),
      renderDependencyGraph(this.dom, rows, this.summary, state, this.actions.select));
    layout.append(list, graphPanel); return layout;
  }
  private minutes(value: number): string {
    return new Intl.NumberFormat(this.dom.doc.documentElement.lang || 'en', { maximumFractionDigits: 1, useGrouping: false }).format(value);
  }
  estimate(parent: HTMLElement, row: FollowupRow, shape: { width: number; kind: string }, mode: string): void {
    const minutes = estimateMinutes(row, mode), bar = this.dom.element('span');
    bar.className = 'project-followup-bar ' + shape.kind; bar.style.width = String(shape.width) + 'px';
    bar.dataset.duration = minutes === null ? '' : String(minutes);
    if (minutes !== null) bar.title = this.dom.t(mode === 'timeline-total' ? 'projects.followup.totalMinutes' : 'projects.followup.remainingMinutes', { value: this.minutes(minutes) }); parent.append(bar);
    parent.append(this.dom.element('span', this.dom.t(mode === 'timeline-total' ? 'projects.followup.totalMinutes' : 'projects.followup.remainingMinutes',
      { value: minutes === null ? this.dom.t('projects.followup.estimateUnscaled') : this.minutes(minutes) })));
    if (minutes === 0) parent.append(this.dom.element('span', this.dom.t('projects.followup.zeroEstimate')));
  }
  dependencyResult(rows: FollowupRow[]): void {
    const timing = rowGraph(rows, this.summary).timing;
    this.root.append(this.dom.element('p', this.dom.t(timing ? 'projects.followup.unlimited' : 'projects.followup.scheduleUnknown')));
    if (!timing) return;
    this.root.append(this.dom.element('p', this.dom.t('projects.followup.dependencyResult',
      { span: this.minutes(timing.span), overlap: timing.overlap, time: this.summary.source_generated_at ?? this.dom.t('projects.unknown') })));
    this.root.append(this.dom.element('p', this.dom.t('projects.followup.zeroSlack', { value: timing.zeroSlack.join(', ') || this.dom.t('projects.unknown') })));
  }
  paint(rows: FollowupRow[], state: FollowupPreferences): HTMLElement {
    const heading = this.dom.element('h4', this.dom.t('projects.followup.title')); heading.tabIndex = -1; heading.dataset.followupKey = 'heading';
    this.root.replaceChildren(heading, this.controls(state, rows.length), this.dom.element('p', this.dom.t('projects.followup.recordedOnly')));
    if (state.mode === 'dependencies') this.dependencyResult(rows);
    if (state.mode === 'timeline-total' || state.mode === 'timeline-remaining') this.root.append(this.dom.element('p', this.dom.t('projects.followup.estimateScale')));
    const chart = this.chart(rows, state); this.root.append(workLayout(this.dom,chart));
    return chart.querySelector<HTMLElement>('.project-followup-chart') ?? chart;
  }
}
