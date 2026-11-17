// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { FollowupRow } from './project-followup-model.ts';
import type { FollowupPreferences } from './project-followup-preferences.ts';
import { validValue } from './project-followup-model.ts';
export function renderFollowupDetail(parent: HTMLElement, row: FollowupRow, state: FollowupPreferences, dom: ProjectDom, page: (amount: number) => void): void {
  const section = dom.element('section'); section.className = 'project-followup-detail'; section.dataset.followupKey = 'detail';
  section.append(dom.element('h5', `${row.id} · ${row.title}`), dom.element('p', dom.t(`projects.followup.meaning.${row.meaning}`, { value: row.state })));
  if (!row.detail) { section.append(dom.element('p', dom.t('projects.followup.completionUnknown'))); parent.append(section); return; }
  const detail = row.detail, budget = validValue(detail.budget), result = validValue(detail.last_result), estimate = validValue(detail.estimate);
  const assignment = validValue(detail.assignment);
  if(row.worker){const progress=dom.element('p',dom.t('projects.followup.worker',{value:row.worker}));progress.className='project-selected-progress';section.append(progress);}
  const blocker=validValue(detail.blocker);if(blocker!==null){const warning=dom.element('p',dom.t('projects.followup.blocker',{value:blocker}));warning.className='project-selected-blocker';section.append(warning);}
  if (assignment) dom.paragraph(section, 'projects.followup.assignment', [assignment.assignee, assignment.runtime, assignment.role].map(value => value ?? dom.t('projects.unknown')).join(' · '));
  dom.paragraph(section, 'projects.followup.budget', `${row.item?.attempts ?? dom.t('projects.unknown')} / ${budget?.max_attempts ?? dom.t('projects.unknown')}`);
  if (row.item?.attempts !== undefined && budget?.max_attempts !== null && budget?.max_attempts !== undefined && row.item.attempts >= budget.max_attempts) section.append(dom.element('p', dom.t('projects.followup.exhausted')));
  if (result) dom.paragraph(section, 'projects.followup.result', `${result.result} · ${result.summary}`);
  if (estimate) {
    dom.paragraph(section, 'projects.followup.totalRange', formatRange(estimate.duration_minutes, dom));
    dom.paragraph(section, 'projects.followup.remainingRange', formatRange(estimate.remaining_minutes, dom));
    if (estimate.reestimate_needed) section.append(dom.element('p', dom.t('projects.followup.reestimate')));
    for (const reason of estimate.reasons.items) section.append(dom.element('p', reason));
  } else section.append(dom.element('p', dom.t('projects.followup.estimateUnknown')));
  renderAttempts(section, row, state, dom, page);
  const families=dom.disclosure(section,dom.t('projects.work.validation'));families.dataset.followupKey=`validation-${row.key}`;
  renderFamilies(families, row, dom);
  parent.append(section);
}
export function formatRange(range: { optimistic: number; likely: number; pessimistic: number } | null, dom: ProjectDom): string {
  return range ? dom.t('projects.followup.range', { optimistic: range.optimistic, likely: range.likely, pessimistic: range.pessimistic }) : dom.t('projects.unknown');
}
function renderAttempts(parent: HTMLElement, row: FollowupRow, state: FollowupPreferences, dom: ProjectDom, page: (amount: number) => void): void {
  const timeline = validValue(row.detail!.timeline);
  if (!timeline) { parent.append(dom.element('p', dom.t('projects.followup.attemptsUnknown'))); return; }
  const section = dom.disclosure(parent, dom.t('projects.followup.attempts', { value: timeline.total ?? dom.t('projects.unknown') }));
  section.dataset.followupKey = `attempts-${row.key}`;
  if (timeline.truncated) section.append(dom.element('p', dom.t('projects.followup.attemptsPartial', { value: timeline.total === null ? dom.t('projects.unknown') : timeline.total - timeline.items.length })));
  for (const amount of [-1, 1]) {
    const button = dom.element('button', dom.t(amount < 0 ? 'projects.followup.previousAttempts' : 'projects.followup.nextAttempts'));
    button.dataset.followupKey = `claims-${amount < 0 ? 'previous' : 'next'}-${row.key}`;
    button.type = 'button'; button.className = 'btn'; button.addEventListener('click', () => page(amount)); section.append(button);
  }
  const list = dom.element('ol');
  for (const attempt of timeline.items.slice(state.attemptPage * 50, (state.attemptPage + 1) * 50)) {
    const item = dom.element('li', `${attempt.attempt} · ${attempt.outcome} · ${attempt.attempt_id ?? dom.t('projects.unknown')}`);
    item.append(dom.element('p', `${attempt.claimed_at ?? dom.t('projects.unknown')} → ${attempt.ended_at ?? dom.t('projects.followup.openEnd')}`)); list.append(item);
  }
  section.append(list);
}
function renderFamilies(parent: HTMLElement, row: FollowupRow, dom: ProjectDom): void {
  const detail = row.detail!, lineage = validValue(detail.lineage), checks = validValue(detail.checks), recovery = validValue(detail.recovery);
  if (lineage) {
    dom.paragraph(parent, 'projects.followup.lineage', `${lineage.kind} · ${lineage.parent ?? dom.t('projects.unknown')}`);
    if (lineage.cause) dom.paragraph(parent, 'projects.followup.cause', `${lineage.cause.task_id} · ${lineage.cause.attempt_id ?? dom.t('projects.unknown')}`);
    if (lineage.corrections.items.length) dom.paragraph(parent, 'projects.followup.corrections', lineage.corrections.items.join(', '));
  }
  for (const check of checks?.items ?? []) dom.paragraph(parent, 'projects.followup.check', `${check.id} · ${check.assurance} · ${check.accepted_evidence_count ?? '?'} / ${check.reported_evidence_count ?? '?'}`);
  if (recovery) dom.paragraph(parent, 'projects.followup.recovery', `${recovery.status} · ${recovery.threshold}`);
  const diagnostics = dom.disclosure(parent, dom.t('projects.followup.diagnostics')); diagnostics.dataset.followupKey = `diagnostics-${row.key}`;
  for (const [name, family] of Object.entries(detail)) if (name !== 'id' && typeof family === 'object' && family !== null && 'availability' in family) {
    diagnostics.append(dom.element('p', `${name} · ${family.availability}${family.reason ? ` · ${family.reason}` : ''}${family.truncated ? ` · ${dom.t('projects.followup.partial')}` : ''}`));
  }
}
