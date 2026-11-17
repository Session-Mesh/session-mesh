// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { WorkCard, WorkColumn } from './project-work-card.ts';

const columns: WorkColumn[] = ['todo', 'doing', 'blocked', 'done', 'cancelled', 'unknown'];
/** A read-only projection: moving a card must never silently mutate its provider. */
export function renderKanban(dom: ProjectDom, cards: WorkCard[], selected: string | null, select: (key: string) => void): HTMLElement {
  const board = dom.element('div'); board.className = 'project-followup-chart project-kanban';
  board.dataset.followupKey = 'chart'; board.tabIndex = 0;
  board.setAttribute('aria-label', dom.t('projects.followup.mode.kanban'));
  for (const column of columns) {
    const members = cards.filter(card => card.column === column);
    if (!members.length && (column === 'cancelled' || column === 'unknown')) continue;
    const lane = dom.element('section'); lane.className = `project-kanban-lane ${column}`;
    const heading = dom.element('h5', dom.t(`projects.kanban.${column}`));
    heading.append(dom.element('span', String(members.length))); lane.append(heading);
    if (!members.length) { const empty = dom.element('p', dom.t('projects.kanban.empty')); empty.className = 'project-kanban-empty'; lane.append(empty); }
    for (const card of members) lane.append(renderCard(dom, card, selected, select));
    board.append(lane);
  }
  return board;
}
function renderCard(dom: ProjectDom, card: WorkCard, selected: string | null, select: (key: string) => void): HTMLElement {
  const button = dom.element('button'); button.type = 'button'; button.className = 'project-work-card';
  button.dataset.followupKey = `row-${card.selection}`; button.dataset.workKey = card.key;
  button.setAttribute('aria-pressed', String(card.selection === selected));
  const identity = dom.element('span', `${card.provider} · ${card.id}`); identity.className = 'project-work-identity';
  const title = dom.element('strong', card.title); title.className = 'project-work-title';
  const meanings=['accepted-receipt','source-done-unqualified','mission-open','future-conditional','recorded-completion'];
  const status=dom.element('span',meanings.includes(card.meaning)?dom.t(`projects.work.meaning.${card.meaning}`):card.state);status.className='project-work-status';
  button.title=dom.t(`projects.followup.meaning.${card.meaning}`,{value:card.state});button.append(identity,title,status);
  if (card.labels.length) {
    const labels = dom.element('span'); labels.className = 'project-work-labels';
    for (const label of card.labels) {
      const chip = dom.element('span', label.name); chip.className = 'project-work-label';
      if (label.color && /^#[0-9a-f]{6}$/i.test(label.color)) chip.style.borderColor = label.color;
      labels.append(chip);
    }
    button.append(labels);
  }
  if (card.assignees.length) button.append(dom.element('span', dom.t('projects.kanban.assignees', { value: card.assignees.join(', ') })));
  if (card.priority) button.append(dom.element('span', dom.t('projects.kanban.priority', { value: card.priority })));
  if (card.prerequisites.length) button.append(dom.element('span', dom.t('projects.kanban.prerequisites', { value: card.prerequisites.join(', ') })));
  if (card.progress) { const progress = dom.element('span', card.progress); progress.className = 'project-work-progress'; button.append(progress); }
  button.addEventListener('click', () => select(card.selection)); return button;
}
