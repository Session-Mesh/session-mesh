// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * What the Projects view shows after an answer sent in a project (static/work-view.ts sends it): the surface it came
 * from read again first, with the focus on the question, then the other one (the task sheet, the Questions tab). The
 * owner's unsent drafts under the other questions survive the redraw.
 */

import type { WorkApi } from './work-api.ts';
import { focusFirst, markSelected, restoreDrafts, unsentDrafts } from './work-dom.ts';
import type { ProjectView } from './work-project-view.ts';

export type ProjectAnswersHost = Readonly<{
  api: WorkApi;
  /** The view's request generation and the live signal of its requests. */
  generation: () => number;
  signal: () => AbortSignal | undefined;
  /** The project shown, and the task whose sheet is open in it. */
  project: () => Readonly<{ id: string; view: ProjectView }> | null;
  selected: () => string | null;
  /** Read the task sheet again, at the question (focus on it when asked). */
  selectTask: (id: string, after: Readonly<{ question: string; focus: boolean }>) => Promise<void>;
}>;

/** The answer to `question` came from the task sheet of `task` (`fromSheet`) or from the Questions tab: read that one
 *  first, then the other. False when the project could not be read again. */
export async function showRecordedInProject(host: ProjectAnswersHost, question: string, fromSheet: boolean,
  task: string | null): Promise<boolean> {
  const sheet = async (focus: boolean): Promise<void> => {
    if (task !== null && task === host.selected()) await host.selectTask(task, { question, focus });
  };
  if (!fromSheet) {
    const shown = await rereadProject(host, question, true);
    await sheet(false);
    return shown;
  }
  await sheet(true);
  return rereadProject(host, question, false);
}

/** Read the open project again and show it (header and sheet kept); drafts of the tab survive, but the answered one's.
 *  False when the read failed (a view left meanwhile is not a failure). */
async function rereadProject(host: ProjectAnswersHost, question: string, focus: boolean): Promise<boolean> {
  const project = host.project(), token = host.generation();
  if (!project) return true;
  const result = await host.api.project(project.id, host.signal());
  if (token !== host.generation() || host.project() !== project) return true;
  if (!result.ok) return false;
  const panel = project.view.panel('questions');
  const drafts = unsentDrafts(panel, question);
  project.view.replaceDoc(result.value);
  restoreDrafts(panel, drafts);
  markSelected(project.view.root, host.selected());
  if (focus) focusFirst(panel.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(question)}"]`) ?? panel);
  return true;
}
