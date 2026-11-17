// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { ProviderSummary } from './project-catalog.ts';
import type { FollowupRow } from './project-followup-model.ts';
import type { FollowupPreferences } from './project-followup-preferences.ts';
import { clockGantt, clockPosition, clockTicks } from './project-gantt-model.ts';
import type { GanttSegment } from './project-gantt-model.ts';
import { ganttSegmentLabel, ganttLegend } from './project-gantt-label.ts';

/** Controlled DOM only: source labels are text, never markup or app attributes. */
export function renderClockGantt(dom: ProjectDom, rows: FollowupRow[], summary: ProviderSummary,
  state: FollowupPreferences, select: (key: string) => void): HTMLElement {
  const model = clockGantt(rows, summary), scroll = dom.element('div');
  scroll.className = 'project-followup-chart project-clock-gantt'; scroll.dataset.followupKey = 'chart'; scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', dom.t('projects.followup.mode.timeline'));
  const plane = dom.element('div'); plane.className = 'project-gantt-plane';
  const chartWidth = Math.min(32000, Math.max(500, 700 * state.zoom)); plane.style.width = `calc(${chartWidth}px + var(--project-gantt-label-width))`;
  const clock = (at: number) => new Intl.DateTimeFormat(dom.doc.documentElement.lang || 'en',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
  const header = dom.element('div'); header.className = 'project-gantt-header';
  header.append(dom.element('span', dom.t('projects.followup.gantt.task')));
  const axis = dom.element('div'); axis.className = 'project-gantt-axis';
  for (const instant of clockTicks(model, chartWidth)) {
    const tick = dom.element('span', clock(instant)); tick.className = 'project-gantt-tick';
    tick.style.left = `${clockPosition(instant, model)}%`; axis.append(tick);
  }
  header.append(axis); plane.append(header);
  const position = (element: HTMLElement, from: number, to: number) => {
    element.style.left = `${clockPosition(from, model)}%`;
    element.style.width = `${Math.max(0, (clockPosition(to, model) ?? 0) - (clockPosition(from, model) ?? 0))}%`;
  };
  const makeBar = (segment: GanttSegment, row: FollowupRow, lane: number): HTMLElement => {
    const button = dom.element('button'); button.type = 'button';
    const forecast = segment.kind === 'forecast', point = segment.start === segment.end;
    button.className = `project-gantt-bar ${forecast ? 'forecast' : 'recorded'} ${point ? 'point' : ''}`;
    const color = ['done', 'GO', 'COMPLETED', 'VALIDATED'].includes(segment.outcome) ? 'done' :
      ['blocked', 'NO-GO', 'BOUNCED', 'BLOCKED'].includes(segment.outcome) ? 'blocked' :
        segment.outcome === 'active' ? 'active' : 'released';
    button.dataset.outcome = color; button.dataset.segmentKind = segment.kind;
    button.dataset.followupKey = `segment-${row.key}-${segment.kind}-${segment.ordinal ?? 'point'}`;
    button.style.top = `${lane * 22 + 8}px`; position(button, segment.start, segment.end);
    button.dataset.duration = String((segment.end - segment.start) / 60000);
    const label = forecast ? dom.t('projects.followup.gantt.forecast') : segment.kind === 'completion' ?
      dom.t('projects.followup.gantt.completion') : dom.t('projects.followup.gantt.attempt', { value: segment.ordinal ?? '' });
    button.textContent = ganttSegmentLabel(dom, segment);
    const minutes = new Intl.NumberFormat(dom.doc.documentElement.lang || 'en', { maximumFractionDigits: 1, useGrouping: false }).format((segment.end - segment.start) / 60000);
    const duration = segment.kind === 'completion' ? '' : '\n' + dom.t(forecast ? 'projects.followup.remainingMinutes' : 'projects.followup.missionMinutes', { value: minutes });
    button.title = `${row.id} · ${label} · ${segment.outcome}\n${clock(segment.start)} → ${clock(segment.end)}${duration}`;
    button.title = `${button.textContent}\n${button.title}`;
    button.setAttribute('aria-label', button.title); button.addEventListener('click', () => select(row.key));
    return button;
  };
  const visible = model.rows.slice(state.page * 50, (state.page + 1) * 50);
  for (const value of visible) {
    const row = dom.element('div'); row.className = 'project-gantt-row'; row.dataset.rowId = value.row.key;
    const label = dom.element('button'); label.type = 'button';
    const taskTitle = dom.element('span', `${value.row.id} · ${value.row.title}`); taskTitle.className = 'project-gantt-task-title'; label.append(taskTitle);
    label.className = 'btn project-gantt-label'; label.dataset.followupKey = `row-${value.row.key}`;
    label.title = `${value.row.id} · ${value.row.title}\n${dom.t(`projects.followup.meaning.${value.row.meaning}`, { value: value.row.state })}`;
    if (value.row.worker) label.title += '\n' + dom.t('projects.followup.worker', { value: value.row.worker });
    label.setAttribute('aria-pressed', String(state.selected === value.row.key));
    label.addEventListener('click', () => select(value.row.key)); row.append(label);
    const lane = dom.element('div'); lane.className = 'project-gantt-lane';
    lane.style.minHeight = `${Math.max(44, value.segments.length * 22 + 16)}px`;
    if (model.observed !== null && model.from !== null) {
      const line = dom.element('span'); line.className = 'project-gantt-observed';
      line.style.left = `${clockPosition(model.observed, model)}%`; line.title = dom.t('projects.followup.gantt.observed', { value: clock(model.observed) }); lane.append(line);
    }
    for (const [index, segment] of value.segments.entries()) {
      if (segment.kind === 'forecast') {
        const range = dom.element('span'); range.className = 'project-gantt-range'; range.style.top = `${index * 22 + 8}px`;
        position(range, segment.earliest, segment.latest); lane.append(range);
      }
      lane.append(makeBar(segment, value.row, index));
    }
    if (value.unknown) { const unknown = dom.element('span', dom.t(`projects.followup.gantt.${value.unknown}`)); unknown.className = 'project-gantt-unknown'; lane.append(unknown); }
    if (value.unknownAttempts || value.truncated) {
      const warning = dom.element('span', dom.t(value.truncated ? 'projects.followup.gantt.truncated' : 'projects.followup.gantt.time-unknown'));
      warning.className = 'project-gantt-warning'; label.append(warning);
    }
    row.append(lane); plane.append(row);
  }
  scroll.append(ganttLegend(dom), plane);
  if (model.observed !== null) scroll.append(dom.element('p', dom.t('projects.followup.gantt.observed', { value: clock(model.observed) })));
  if (model.conditionalForecast) scroll.append(dom.element('p', dom.t('projects.followup.gantt.forecastAssumption')));
  return scroll;
}
