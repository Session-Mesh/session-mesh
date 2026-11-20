// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The open questions of each session (`session-questions` of work-read, docs/work-read.md), joined to the page's
 * sessions by name: the marker of a session row and of a session header, and where its button leads in the Projects
 * view. Pure: no DOM, no request. The document comes from tracker data, so every value is checked and every string is
 * kept as received (the page shows them as text only).
 */

import { isObj, text } from './work-parse.ts';

/** One open question of a session: what it is about (a task or a project id, or nothing) and the project it falls in. */
export type SessionQuestion = Readonly<{ id: string; about: string | null; project: string | null }>;

/** A session's open questions: `count` counts them all, `questions` lists at most 20 (`omitted` the others). */
export type SessionEntry = Readonly<{ name: string; count: number; questions: readonly SessionQuestion[]; omitted: number }>;

export type SessionQuestionsDoc = Readonly<{
  /** Every open question of the tracker (the count of the Projects button). */
  openQuestions: number;
  sessions: readonly SessionEntry[];
  /** Sessions the reader left out (it lists at most 500). */
  omitted: number;
}>;

/** Where the marker's button opens the Projects view: the task sheet, the Questions tab of a project, or the entry
 *  screen and its list of open questions. */
export type WorkTarget = Readonly<{ kind: 'task'; id: string }> | Readonly<{ kind: 'project'; id: string }> | Readonly<{ kind: 'entry' }>;

export type SessionMarker = Readonly<{ count: number; target: WorkTarget }>;

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const objects = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isObj) : []);
const TASK = /^T-/i, PROJECT = /^P-/i;

function parseQuestions(value: unknown): SessionQuestion[] {
  const seen = new Set<string>(), questions: SessionQuestion[] = [];
  for (const source of objects(value)) {
    const id = text(source.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    questions.push({ id, about: text(source.about), project: text(source.project) });
  }
  return questions;
}

function parseEntry(source: Record<string, unknown>): SessionEntry | null {
  const name = text(source.name);
  if (!name) return null;
  const questions = parseQuestions(source.questions), omitted = count(source.questions_omitted);
  return { name, count: Math.max(count(source.open_questions), questions.length + omitted), questions, omitted };
}

/** The document, or null when it is not one; a session without a name is dropped, a repeated name keeps its first entry. */
export function parseSessionQuestions(value: unknown): SessionQuestionsDoc | null {
  if (!isObj(value) || !Array.isArray(value.sessions)) return null;
  const names = new Set<string>(), sessions: SessionEntry[] = [];
  for (const entry of objects(value.sessions).map(parseEntry)) {
    if (!entry || names.has(entry.name)) continue;
    names.add(entry.name);
    sessions.push(entry);
  }
  return { openQuestions: count(value.open_questions), sessions, omitted: count(value.sessions_omitted) };
}

/**
 * Where the button of a session leads. All its questions about one task of a project: that task's sheet. All in one project (about
 * the project or its tasks): the project's Questions tab. Anything else (a question about nothing, several projects,
 * questions left out of the list): the entry screen, which lists the open questions with and without a task.
 */
export function markerTarget(entry: SessionEntry): WorkTarget {
  const [first] = entry.questions;
  if (!first || entry.omitted > 0) return { kind: 'entry' };
  // A task in no project has no sheet in the Projects view: its question is answered from the entry screen.
  if (first.about && TASK.test(first.about) && first.project && entry.questions.every(question => question.about === first.about)) {
    return { kind: 'task', id: first.about };
  }
  const project = first.project;
  if (project && PROJECT.test(project) && entry.questions.every(question => question.project === project)) {
    return { kind: 'project', id: project };
  }
  return { kind: 'entry' };
}

/** The markers by session name: only the sessions with at least one open question. */
export function markerIndex(doc: SessionQuestionsDoc): ReadonlyMap<string, SessionMarker> {
  const index = new Map<string, SessionMarker>();
  for (const entry of doc.sessions) if (entry.count > 0) index.set(entry.name, { count: entry.count, target: markerTarget(entry) });
  return index;
}
