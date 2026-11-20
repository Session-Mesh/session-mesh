// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Questions surfaces: the Questions tab of a project (its questions, open and answered, grouped by task, with a
 * "without a task" group) and the list of every open question on the entry screen (from `resume` without a scope).
 * Each question shows its text, what it is about, its age, who asked it, and the owner's answer form of the sheet.
 * Question text is tracker data written by agents: it only ever becomes text nodes.
 */

import type { WorkError } from './work-api.ts';
import { answerArea } from './work-detail-view.ts';
import { button, el, notice, omittedNote } from './work-dom.ts';
import type { Child, ViewContext } from './work-dom.ts';
import { errorBlock } from './work-error-view.ts';
import { ageOf, formatAge, groupProjectQuestions, splitEntryQuestions } from './work-questions.ts';
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
    el('p', 'work-question-text', question.text), metaLine(ctx, question, about));
  if (question.options.length > 0) item.append(el('p', 'work-qcard-extra', ctx.t('work.questions.options', { options: question.options.join(' · ') })));
  if (question.assumption) item.append(el('p', 'work-qcard-extra', ctx.t('work.questions.assumption', { text: question.assumption })));
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

export type EntryQuestionHandlers = Readonly<{
  /** The title of a project of the entry list, or null when it is not listed there. */
  projectTitle: (id: string) => string | null;
  openProject: (id: string) => void;
  openTask: (id: string) => void;
}>;

/** What the entry screen knows of the open questions: being read, read, or a failed read with its retry. */
export type EntryQuestionsState = Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'ready'; doc: OpenQuestionsDoc }>
  | Readonly<{ kind: 'failed'; error: WorkError; retry: () => void }>;

function aboutControl(ctx: ViewContext, handlers: EntryQuestionHandlers, about: string | null, task: boolean): Child {
  if (about === null) return null;
  if (task) {
    const open = button('work-qcard-about', ctx.t('work.questions.openTask', { id: about }), () => handlers.openTask(about));
    open.dataset.task = about;
    return open;
  }
  const title = handlers.projectTitle(about);
  if (title === null) return el('span', 'work-qcard-about', ctx.t('work.questions.project', { title: about }));
  const open = button('work-qcard-about', ctx.t('work.questions.openProject', { title }), () => handlers.openProject(about));
  open.dataset.project = about;
  return open;
}

function entryList(ctx: ViewContext, handlers: EntryQuestionHandlers, titleKey: string, questions: readonly Question[], task: boolean): HTMLElement | null {
  if (questions.length === 0) return null;
  const section = el('section', 'work-section work-qgroup', el('h3', 'work-section-title', ctx.t(titleKey), el('span', 'work-count', String(questions.length))));
  section.dataset.group = task ? 'with-task' : 'no-task';
  section.append(el('ul', 'work-qcard-list', ...questions.map(question => questionCard(ctx, question, aboutControl(ctx, handlers, question.about, task)))));
  return section;
}

function entryBody(ctx: ViewContext, handlers: EntryQuestionHandlers, state: EntryQuestionsState): Node[] {
  if (state.kind === 'loading') return [el('p', 'work-loading work-mute', ctx.t('work.questions.loading'))];
  if (state.kind === 'failed') return [errorBlock(ctx.t, state.error, { retry: state.retry })];
  const { doc } = state;
  if (doc.questions.length === 0 && doc.openQuestions === 0) return [el('p', 'work-entry-empty work-questions-none', ctx.t('work.questions.none'))];
  const lists = splitEntryQuestions(doc.questions);
  const nodes: Node[] = [];
  for (const block of [entryList(ctx, handlers, 'work.questions.noTask', lists.noTask, false),
    entryList(ctx, handlers, 'work.questions.withTask', lists.withTask, true)]) if (block) nodes.push(block);
  const left = Math.max(doc.omitted, doc.openQuestions - doc.questions.length);
  if (left > 0) nodes.push(notice('work-omitted', ctx.t('work.questions.more', { n: left })));
  return nodes;
}

/** The open questions block of the entry screen, above the products. */
export function renderEntryQuestions(ctx: ViewContext, handlers: EntryQuestionHandlers, state: EntryQuestionsState): HTMLElement {
  const count = state.kind === 'ready' ? el('span', 'work-count', String(state.doc.openQuestions)) : null;
  const heading = el('h2', 'work-entry-category-name', ctx.t('work.questions.title'), count);
  heading.id = 'work-entry-questions-title';
  const root = el('section', 'work-entry-questions', heading, ...entryBody(ctx, handlers, state));
  root.setAttribute('aria-labelledby', heading.id);
  return root;
}
