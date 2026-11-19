// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The "Reprise" tab: where things stand and what to unblock, from the `reprise` sections of the project document. */

import { el, notice, omittedNote } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { taskList } from './work-task-card.ts';
import type { ProjectDoc, Question, TaskRow } from './work-types.ts';

type Section = Readonly<{ key: 'inProgress' | 'blocked' | 'due' | 'stale'; omittedKey: string; title: string }>;

const SECTIONS: readonly Section[] = [
  { key: 'inProgress', omittedKey: 'reprise.in_progress', title: 'work.reprise.inProgress' },
  { key: 'blocked', omittedKey: 'reprise.blocked', title: 'work.reprise.blocked' },
  { key: 'due', omittedKey: 'reprise.due', title: 'work.reprise.due' },
  { key: 'stale', omittedKey: 'reprise.stale', title: 'work.reprise.stale' },
];

function section(ctx: ViewContext, doc: ProjectDoc, spec: Section): HTMLElement | null {
  const rows: readonly TaskRow[] = doc.reprise[spec.key];
  if (rows.length === 0) return null;
  const block = el('section', 'work-section');
  block.append(el('h3', 'work-section-title', ctx.t(spec.title), el('span', 'work-count', String(rows.length))));
  block.append(taskList(ctx, rows));
  block.append(omittedNote(ctx.t, doc.omitted[spec.omittedKey]));
  return block;
}

function questionItem(ctx: ViewContext, question: Question): HTMLElement {
  const item = el('li', 'work-question', el('span', 'work-question-text', question.text));
  if (question.about) item.append(el('span', 'work-question-about', ctx.t('work.questionAbout', { id: question.about })));
  return item;
}

function questionsSection(ctx: ViewContext, doc: ProjectDoc): HTMLElement | null {
  const open = doc.questions.filter(question => question.open);
  if (open.length === 0) return null;
  const block = el('section', 'work-section');
  block.append(el('h3', 'work-section-title', ctx.t('work.reprise.questions'), el('span', 'work-count', String(doc.openQuestions || open.length))));
  const list = el('ul', 'work-question-list');
  for (const question of open) list.append(questionItem(ctx, question));
  block.append(list, omittedNote(ctx.t, doc.omitted.questions));
  return block;
}

function listSection(title: string, items: readonly string[]): HTMLElement | null {
  if (items.length === 0) return null;
  const block = el('section', 'work-section');
  block.append(el('h3', 'work-section-title', title));
  const list = el('ul', 'work-plain-list');
  for (const item of items) list.append(el('li', '', item));
  block.append(list);
  return block;
}

export function renderReprise(ctx: ViewContext, doc: ProjectDoc): HTMLElement {
  const root = el('div', 'work-reprise');
  const sections = SECTIONS.map(spec => section(ctx, doc, spec));
  for (const block of sections) if (block) root.append(block);
  if (sections.every(block => block === null)) root.append(notice('work-empty', ctx.t('work.reprise.empty')));
  for (const block of [questionsSection(ctx, doc), listSection(ctx.t('work.milestones'), doc.project.milestones),
    listSection(ctx.t('work.risks'), doc.project.risks)]) if (block) root.append(block);
  return root;
}
