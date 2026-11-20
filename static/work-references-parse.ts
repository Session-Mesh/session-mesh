// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The known ids of the tracker (`ids` of work-read, docs/work-read.md), for the references of the terminal: each id
 * with its kind, a short title and where it leads in the Projects view. Pure: no DOM, no request. The document comes
 * from tracker data, so every value is checked: an id must have the form of its kind, a title loses its control,
 * bidirectional and invisible characters and is cut, and nothing else of the document is kept (no folder, no session).
 */

import { isObj, text } from './work-parse.ts';
import type { WorkTarget } from './work-session-questions.ts';

export type ReferenceKind = 'task' | 'project' | 'question';

export type ReferenceEntry = Readonly<{ id: string; kind: ReferenceKind; title: string; target: WorkTarget }>;

export type KnownIds = ReadonlyMap<string, ReferenceEntry>;

/** A title is shown on hover only, as text; longer ones are cut. */
export const MAX_TITLE = 120;
/** The most ids kept (work-read lists at most 4000 tasks, 1000 projects and 1000 questions). */
const MAX_IDS = 6000;

const FORMS: Readonly<Record<ReferenceKind, RegExp>> = {
  task: /^T-[0-9a-f]{2,32}$/, project: /^P-[0-9a-f]{2,32}$/, question: /^N-[0-9a-f]{2,32}$/,
};
// C0 and C1 controls, bidirectional marks and overrides, zero-width and other invisible format characters, the
// combining grapheme joiner, variation selectors and tag characters.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u034f\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

function cleanTitle(value: unknown): string {
  const raw = (text(value) ?? '').slice(0, MAX_TITLE * 4).replace(UNSAFE, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(raw);
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('')}…` : raw;
}

/** Where a question leads: the sheet of the task it is about, the Questions tab of its project, or the entry screen. A task
 *  in no project has no sheet in the Projects view, so its question is answered from the entry screen (as the session
 *  marker does, markerTarget in static/work-session-questions.ts). */
function questionTarget(about: string | null, project: string | null): WorkTarget {
  if (about && FORMS.task.test(about)) return project && FORMS.project.test(project) ? { kind: 'task', id: about } : { kind: 'entry' };
  if (about && FORMS.project.test(about)) return { kind: 'project', id: about };
  return { kind: 'entry' };
}

function targetOf(kind: ReferenceKind, id: string, item: Record<string, unknown>): WorkTarget {
  if (kind === 'task') return { kind: 'task', id, tab: 'board' };
  if (kind === 'project') return { kind: 'project', id, tab: 'reprise' };
  return questionTarget(text(item.about), text(item.project));
}

/** The ids of a document, by id; the first entry of a repeated id is kept. Null when it is not an ids document. */
export function parseIds(body: unknown): KnownIds | null {
  if (!isObj(body)) return null;
  const lists: [ReferenceKind, unknown][] = [['task', body.tasks], ['project', body.projects], ['question', body.questions]];
  if (lists.some(([, list]) => !Array.isArray(list))) return null;
  const known = new Map<string, ReferenceEntry>();
  for (const [kind, list] of lists) {
    for (const item of list as unknown[]) {
      if (known.size >= MAX_IDS) return known;
      if (!isObj(item)) continue;
      const id = text(item.id);
      if (!id || !FORMS[kind].test(id) || known.has(id)) continue;
      known.set(id, { id, kind, title: cleanTitle(item.title), target: targetOf(kind, id, item) });
    }
  }
  return known;
}
