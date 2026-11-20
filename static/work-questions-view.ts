// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Questions surfaces: the Questions tab of a project (its questions, open and answered, grouped by task, with a
 * "without a task" group) and the question cards it shares with the sheet of a question about no task
 * (static/work-question-sheet.ts). Each question shows its text, its age, who asked it, and the owner's answer form.
 * The open questions of the entry screen are a classified list without forms (static/work-questions-triage-view.ts).
 * Question text is tracker data written by agents: it only ever becomes text nodes.
 */

import type { WorkError } from './work-api.ts';
import { answerArea } from './work-detail-view.ts';
import { button, el, notice, omittedNote } from './work-dom.ts';
import type { Child, ViewContext } from './work-dom.ts';
import { linkText } from './work-linkify.ts';
import { ageOf, formatAge, groupProjectQuestions } from './work-questions.ts';
import type { QuestionGroup } from './work-questions.ts';
import type { OpenQuestionsDoc, ProjectDoc, Question } from './work-types.ts';

function askedBy(ctx: ViewContext, question: Question): string | null {
  const { askedByAgent: agent, askedBySession: session } = question;
  if (session && agent) return ctx.t('work.questions.askedByBoth', { session, agent });
  const who = session ?? agent;
  return who ? ctx.t('work.questions.askedBy', { who }) : null;
}

function metaLine(ctx: ViewContext, question: Question, about: Child): HTMLElement {
  const age = ageOf(question.askedAt, ctx.nowMs());
  const parts: Child[] = [el('span', `work-qcard-state work-qcard-${question.open ? 'open' : 'answered'}`,
    ctx.t(question.open ? 'work.questions.stateOpen' : 'work.questions.stateAnswered'))];
  if (about) parts.push(about);
  if (age) {
    const when = el('time', 'work-qcard-age', formatAge(age, ctx.locale));
    when.dateTime = question.askedAt ?? '';
    parts.push(when);
  }
  const who = askedBy(ctx, question);
  if (who) parts.push(el('span', 'work-qcard-who', who));
  const line = el('p', 'work-qcard-meta work-mute');
  parts.forEach((part, index) => { if (index > 0) line.append(' · '); if (part) line.append(part); });
  return line;
}

/** One question: text, facts, options and assumption when the agent gave them, then answers and the answer form. */
export function questionCard(ctx: ViewContext, question: Question, about: Child = null): HTMLElement {
  const item = el('li', `work-qcard work-question-${question.open ? 'open' : 'answered'}`,
    el('p', 'work-question-text', linkText(ctx.t, question.text)), metaLine(ctx, question, about));
  if (question.options.length > 0) item.append(el('p', 'work-qcard-extra', ctx.t('work.questions.options', { options: question.options.join(' · ') })));
  if (question.assumption) item.append(el('p', 'work-qcard-extra', linkText(ctx.t, ctx.t('work.questions.assumption', { text: question.assumption }))));
  item.append(answerArea(ctx, question));
  item.dataset.questionId = question.id;
  return item;
}

function groupHeading(ctx: ViewContext, group: QuestionGroup, listed: boolean): HTMLElement {
  const heading = el('h3', 'work-section-title work-qgroup-title');
  if (group.task === null) heading.append(ctx.t('work.questions.noTask'));
  else if (listed) {
    const open = button('work-qgroup-task', '', () => ctx.selectTask(group.task!), el('span', 'work-dep-id', group.task), group.title ? ` ${group.title}` : null);
    open.dataset.task = group.task;
    heading.append(open);
  } else heading.append(ctx.t('work.questions.task', { id: group.task }));
  return heading;
}

/** The Questions tab of a project: the groups, the count of open questions, and a note when the list was cut. */
export function renderQuestionsTab(ctx: ViewContext, doc: ProjectDoc): HTMLElement {
  const root = el('div', 'work-questions');
  if (doc.questions.length === 0) {
    root.append(notice('work-empty', ctx.t('work.questions.emptyProject')));
    return root;
  }
  const open = doc.questions.filter(question => question.open).length;
  root.append(el('p', 'work-questions-summary work-mute', ctx.t('work.questions.openCount', { n: Math.max(doc.openQuestions, open) })));
  const listed = new Set(doc.tasks.map(task => task.id));
  for (const group of groupProjectQuestions(doc.questions, doc.tasks)) {
    const section = el('section', 'work-section work-qgroup', groupHeading(ctx, group, group.task !== null && listed.has(group.task)));
    section.dataset.group = group.task ?? 'no-task';
    section.append(el('ul', 'work-qcard-list', ...group.questions.map(question => questionCard(ctx, question))));
    root.append(section);
  }
  root.append(omittedNote(ctx.t, doc.omitted.questions));
  return root;
}

/** What the entry screen knows of the open questions: being read, read, a failed read with its retry, or a failed
 *  read again of questions already shown (they stay, with the error above them). */
export type EntryQuestionsState = Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'ready'; doc: OpenQuestionsDoc }>
  | Readonly<{ kind: 'failed'; error: WorkError; retry: () => void }>
  | Readonly<{ kind: 'stale'; doc: OpenQuestionsDoc; error: WorkError; retry: () => void }>;

