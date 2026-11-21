// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Pure derivations of the Questions surfaces: what a question is about, the groups of the project tab, the age of a
 * question, and the text of the counter on the Projects button (static/work-questions-triage.ts classifies the open
 * questions of the entry screen). No DOM here.
 */

import type { WorkResult } from './work-api.ts';
import type { OpenQuestionsDoc, Question, TaskRow } from './work-types.ts';

/** One read of open questions (work-read's `open-questions`): at most `limit`, after the question `after`. */
export type OpenQuestionsRead = (page: Readonly<{ after?: string; limit: number }>) => Promise<WorkResult<OpenQuestionsDoc>>;

/** The oldest `wanted` open questions, read a page of at most `max` at a time (one read gives at most 100), each
 *  once; the totals are the last page's. A page that fails fails the whole read. */
export async function readOpenQuestions(read: OpenQuestionsRead, wanted: number, max = 100): Promise<WorkResult<OpenQuestionsDoc>> {
  let result = await read({ limit: Math.min(max, wanted) });
  if (!result.ok) return result;
  const questions = [...result.value.questions], known = new Set(questions.map(question => question.id));
  while (questions.length > 0 && questions.length < Math.min(wanted, result.value.openQuestions)) {
    result = await read({ after: questions[questions.length - 1]!.id, limit: Math.min(max, wanted - questions.length) });
    if (!result.ok) return result;
    const added = result.value.questions.filter(question => !known.has(question.id));
    if (added.length === 0) break;
    for (const question of added) { known.add(question.id); questions.push(question); }
  }
  return { ok: true, value: { ...result.value, questions } };
}

/** What a question is about, from its `about` reference: a task (`T-`), a project (`P-`) or nothing. */
export type AboutKind = 'task' | 'project' | 'none';

export function aboutKind(about: string | null): AboutKind {
  if (about === null) return 'none';
  if (/^T-/i.test(about)) return 'task';
  if (/^P-/i.test(about)) return 'project';
  return 'none';
}

/** A group of the project tab: the questions about one task, or (task null) the ones about no task. */
export type QuestionGroup = Readonly<{ task: string | null; title: string | null; questions: readonly Question[] }>;

/** The newest `asked_at` first; a question without a date goes last. The sort is stable, so the reader's order
 *  (open first, then answered, each newest first) is kept between equal dates. */
function newestFirst(left: Question, right: Question): number {
  const a = Date.parse(left.askedAt ?? ''), b = Date.parse(right.askedAt ?? '');
  return (Number.isFinite(b) ? b : -Infinity) - (Number.isFinite(a) ? a : -Infinity) || 0;
}

/** Open questions first, then answered ones, each newest first. */
export function orderQuestions(questions: readonly Question[]): Question[] {
  return [...questions.filter(question => question.open).sort(newestFirst), ...questions.filter(question => !question.open).sort(newestFirst)];
}

/**
 * The groups of the project tab: one per task (titled from the project's task rows when the task is listed), the
 * task with the newest open question first, then the tasks with only answered questions; the group of questions
 * about no task (about the project itself) comes last.
 */
export function groupProjectQuestions(questions: readonly Question[], tasks: readonly TaskRow[]): QuestionGroup[] {
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  const byTask = new Map<string, Question[]>(), noTask: Question[] = [];
  for (const question of orderQuestions(questions)) {
    if (aboutKind(question.about) !== 'task') { noTask.push(question); continue; }
    const id = question.about!;
    byTask.set(id, [...(byTask.get(id) ?? []), question]);
  }
  const groups: QuestionGroup[] = [...byTask].map(([task, list]) => ({ task, title: titles.get(task) ?? null, questions: list }));
  // A group's first question is its newest open one when it has any (orderQuestions put it first).
  groups.sort((left, right) => Number(right.questions[0]!.open) - Number(left.questions[0]!.open)
    || newestFirst(left.questions[0]!, right.questions[0]!));
  if (noTask.length > 0) groups.push({ task: null, title: null, questions: noTask });
  return groups;
}

/** The open questions shown, less the one just answered (when it was listed); its total goes down with it. */
export function withoutQuestion(doc: OpenQuestionsDoc, id: string | null): OpenQuestionsDoc {
  const questions = doc.questions.filter(question => question.id !== id);
  if (questions.length === doc.questions.length) return doc;
  return { ...doc, questions, openQuestions: Math.max(questions.length, doc.openQuestions - (doc.questions.length - questions.length)) };
}

export type Age = Readonly<{ value: number; unit: 'minute' | 'hour' | 'day' }>;

/** How long ago a question was asked, in whole minutes, hours or days (never negative); null without a date. */
export function ageOf(askedAt: string | null, nowMs: number): Age | null {
  const at = Date.parse(askedAt ?? '');
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 60) return { value: minutes, unit: 'minute' };
  if (minutes < 24 * 60) return { value: Math.floor(minutes / 60), unit: 'hour' };
  return { value: Math.floor(minutes / (24 * 60)), unit: 'day' };
}

/** The age as a phrase of the locale ("3 days ago", "il y a 3 jours"); the raw date when the locale is unknown. */
export function formatAge(age: Age, locale: string | undefined): string {
  try { return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-age.value, age.unit); } catch {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-age.value, age.unit);
  }
}

/** The badge of the Projects button: nothing at zero or when the count is unknown, at most "99+". */
export function counterText(count: number | null): string {
  if (count === null || !Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}
