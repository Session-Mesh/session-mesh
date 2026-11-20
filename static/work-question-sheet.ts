// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The sheets the entry screen's questions open when there is no project view to open: the sheet of a question about
 * no task or project (the question, who asked it, a hint that it should be attached, and the answer form), and the
 * sheet of a task in no project (the task sheet itself, with its notes, blockers, timeline and questions). Each has
 * a way back to the entry screen. Tracker text only ever becomes text nodes (the cards and the task sheet do that).
 */

import { renderDetail } from './work-detail-view.ts';
import { button, el } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { linkText } from './work-linkify.ts';
import { questionCard } from './work-questions-view.ts';
import type { Question, TaskDetail } from './work-types.ts';

function frame(ctx: ViewContext, back: () => void, ...content: HTMLElement[]): HTMLElement {
  const backButton = button('btn work-back', ctx.t('work.back'), back);
  return el('div', 'work-qsheet', el('div', 'work-actions work-qsheet-actions', backButton), ...content);
}

/** The sheet of a question about no task or project, with its answer form. */
export function renderQuestionSheet(ctx: ViewContext, question: Question, back: () => void): HTMLElement {
  const heading = el('h2', 'work-detail-heading', ctx.t('work.triage.sheetTitle'));
  return frame(ctx, back, heading, el('p', 'work-qzone-hint work-mute', ctx.t('work.triage.unattachedHint')),
    el('ul', 'work-qcard-list', questionCard(ctx, question)));
}

/** The same sheet once the operator's answer is recorded: the question stays, the form is gone. */
export function renderAnsweredSheet(ctx: ViewContext, question: Question, back: () => void): HTMLElement {
  const card = el('div', 'work-qcard', el('p', 'work-question-text', linkText(ctx.t, question.text)),
    el('p', 'work-answer-recorded', ctx.t('work.answer.sent')));
  card.dataset.questionId = question.id;
  return frame(ctx, back, el('h2', 'work-detail-heading', ctx.t('work.triage.sheetTitle')), card);
}

/** The sheet of a task in no project: the task sheet, where its questions are answered. */
export function renderLoneTaskSheet(ctx: ViewContext, detail: TaskDetail, back: () => void): HTMLElement {
  return frame(ctx, back, el('p', 'work-qzone-hint work-mute', ctx.t('work.triage.loneTask')), renderDetail(ctx, detail));
}
