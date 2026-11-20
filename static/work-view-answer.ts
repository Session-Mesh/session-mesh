// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The owner's answer sent from the Projects view (static/work-view.ts holds the surfaces it comes from): the write,
 * then what shows it read again (the sheet it came from, or in a project that surface first), the count, and what is
 * announced. Success is only announced when everything that shows the answer could be read again.
 */

import { failureOfKind } from './work-answer-form.ts';
import type { AnswerFailure } from './work-answer-form.ts';
import type { AnswerExtra, WorkApi } from './work-api.ts';
import type { Translate } from './work-dom.ts';
import { showRecordedInProject } from './work-project-answers.ts';
import type { ProjectAnswersHost, Unread } from './work-project-answers.ts';

/** Where an answer form was sent from: the task sheet, the Questions tab of a project, or a sheet opened from the
 *  entry screen (a question about nothing, a task in no project). */
export type Surface = 'detail' | 'questions' | 'sheet';

export type AnswerHost = Readonly<{
  api: WorkApi;
  t: Translate;
  /** The view's request generation: a view closed or moved since the answer was sent reads nothing. */
  generation: () => number;
  /** The task whose sheet is open in the project shown. */
  selected: () => string | null;
  /** The relay has no writer: the forms say so from now on. */
  writeUnavailable: () => void;
  /** The answer is recorded: its draft is dropped, the marker and the entry list forget the question. */
  recorded: (question: string) => void;
  /** The entry sheet shows the answer recorded; false when its task could not be read again. */
  sheetRecorded: (question: string) => Promise<boolean>;
  project: ProjectAnswersHost;
  refreshCount: () => Promise<void>;
  announce: (message: string) => void;
}>;

/** Send the owner's answer (`extra`: a correction of the owner's earlier answer, the options picked); on success or
 *  "already answered", read again what shows it, so it appears as recorded. */
export async function sendAnswer(host: AnswerHost, question: string, answerText: string, surface: Surface,
  extra?: AnswerExtra): Promise<AnswerFailure | null> {
  const task = host.selected(), token = host.generation();
  const result = await host.api.answer(question, answerText, extra);
  if (!result.ok && result.error.kind !== 'conflict') {
    if (result.error.kind === 'not-available') host.writeUnavailable();
    return failureOfKind(result.error.kind);
  }
  host.recorded(question);
  // The write stands whatever happened meanwhile; a view closed (or reloaded) since shows nothing and reads nothing.
  if (token !== host.generation()) return null;
  const t = host.t;
  const notice = t(!result.ok ? 'work.answer.already' : result.value.uncommitted ? 'work.answer.sentUncommitted'
    : extra?.edit ? 'work.answer.sentEdit' : 'work.answer.sent');
  const unread: Unread = surface === 'sheet' ? (await host.sheetRecorded(question) ? null : 'task')
    : await showRecordedInProject(host.project, question, surface === 'detail', task);
  await host.refreshCount();
  // The write stands; when what shows it could not be read again, the notice says that rather than only "recorded".
  const failed = unread === 'task' ? 'work.triage.rereadFailed' : 'work.questions.rereadFailed';
  if (token === host.generation()) host.announce(unread === null ? notice : t(failed));
  return null;
}
