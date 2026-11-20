// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The classification of the open questions of the entry screen (pure, no DOM): by zone (the category of the
 * product), then product, project and task, each group with its count, the oldest question first inside a group and
 * the group of the oldest question first. A question about no task or project, or about one the tracker does not know
 * (it has no `context`), is "unattached": it is grouped by the session that asked it. Where a question stands comes
 * from its `context` (work-read's `open-questions`): a task in a project stands under the project's product.
 */

import { aboutKind } from './work-questions.ts';
import type { Question } from './work-types.ts';

/** A cue for the operator: a choice among the options the agent offered, or an open question. */
export type QuestionKind = 'choice' | 'open';

export function questionKind(question: Question): QuestionKind {
  return question.options.length > 0 ? 'choice' : 'open';
}

/** The questions of one task, or (task null) the ones about the project itself. */
export type TriageTask = Readonly<{ task: string | null; title: string | null; questions: readonly Question[] }>;
/** The questions of one project, or (project null) of the tasks in no project. */
export type TriageProject = Readonly<{ project: string | null; title: string | null; count: number; tasks: readonly TriageTask[] }>;
export type TriageProduct = Readonly<{ product: string | null; count: number; projects: readonly TriageProject[] }>;
/** A zone: a category of the taxonomy (key and name), or (key null) the questions whose category is not known. */
export type TriageZone = Readonly<{ key: string | null; name: string | null; count: number; products: readonly TriageProduct[] }>;
/** The unattached questions one session asked (session null: the asker is not recorded). */
export type TriageSession = Readonly<{ session: string | null; questions: readonly Question[] }>;
export type Triage = Readonly<{ zones: readonly TriageZone[]; unattached: readonly TriageSession[]; unattachedCount: number }>;

export type ZoneName = Readonly<{ key: string; name: string }>;

const time = (question: Question): number => {
  const at = Date.parse(question.askedAt ?? '');
  return Number.isFinite(at) ? at : Infinity;
};

/** The oldest first; a question without a date goes last. Stable between equal dates. */
export function oldestFirst(questions: readonly Question[]): Question[] {
  return [...questions].sort((left, right) => {
    const a = time(left), b = time(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}

/** Whether a question is about a task or a project the tracker knows (else it is shown under the session that asked
 *  it, and answered on its own sheet). Only a known task or project has a `context`. */
export function isAttached(question: Question): boolean {
  return aboutKind(question.about) !== 'none' && question.context !== undefined;
}

/** A map that keeps the order in which its keys were first seen (the oldest question first). */
function bucket<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

function taskGroups(questions: readonly Question[]): TriageTask[] {
  const byTask = new Map<string | null, Question[]>();
  for (const question of questions) bucket(byTask, aboutKind(question.about) === 'task' ? question.about : null, question);
  return [...byTask].map(([task, list]) => ({ task, title: task ? list[0]!.context?.taskTitle ?? null : null, questions: list }));
}

function projectGroups(questions: readonly Question[], projectTitle: (id: string) => string | null): TriageProject[] {
  const byProject = new Map<string | null, Question[]>();
  for (const question of questions) {
    const project = question.context?.project ?? (aboutKind(question.about) === 'project' ? question.about : null);
    bucket(byProject, project, question);
  }
  return [...byProject].map(([project, list]) => ({
    project, count: list.length, tasks: taskGroups(list),
    title: project ? list.find(question => question.context?.projectTitle)?.context?.projectTitle ?? projectTitle(project) : null,
  }));
}

function productGroups(questions: readonly Question[], projectTitle: (id: string) => string | null): TriageProduct[] {
  const byProduct = new Map<string | null, Question[]>();
  for (const question of questions) bucket(byProduct, question.context?.product ?? null, question);
  return [...byProduct].map(([product, list]) => ({ product, count: list.length, projects: projectGroups(list, projectTitle) }));
}

/**
 * Classify the open questions. `zones` gives the order and the names of the categories (the products document);
 * a category it does not list comes after them, named by its key, and an unknown one last. `projectTitle` names a
 * project the question's context does not name.
 */
export function triageQuestions(questions: readonly Question[], zones: readonly ZoneName[],
  projectTitle: (id: string) => string | null = () => null): Triage {
  const open = oldestFirst(questions.filter(question => question.open));
  const byZone = new Map<string | null, Question[]>(), bySession = new Map<string | null, Question[]>();
  for (const question of open) {
    if (isAttached(question)) bucket(byZone, question.context?.category ?? null, question);
    else bucket(bySession, question.askedBySession ?? question.askedByAgent, question);
  }
  const rank = (key: string | null): number => {
    if (key === null) return zones.length + 1;
    const index = zones.findIndex(zone => zone.key === key);
    return index < 0 ? zones.length : index;
  };
  const grouped = [...byZone].map(([key, list]): TriageZone => ({
    key, name: key === null ? null : zones.find(zone => zone.key === key)?.name || key, count: list.length,
    products: productGroups(list, projectTitle),
  }));
  grouped.sort((left, right) => rank(left.key) - rank(right.key));   // stable: unlisted keys keep the oldest-first order
  const unattached = [...bySession].map(([session, list]) => ({ session, questions: list }));
  return { zones: grouped, unattached, unattachedCount: unattached.reduce((sum, group) => sum + group.questions.length, 0) };
}

/** A text long enough to be folded in a list row (its start is shown, "Show more" shows it all). */
export function isLongText(text: string, limit = 280): boolean {
  return [...text].length > limit || text.split('\n').length > 4;
}
