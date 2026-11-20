// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The sheets the entry screen's questions open when there is no project view to open (static/work-question-sheet.ts
 * draws them): which one is shown, as the view's memory keeps it, the drafts put back into it, and what an answer
 * sent from it shows. static/work-view.ts opens them (one level above the entry screen) and closes them.
 */

import type { WorkApi, WorkError } from './work-api.ts';
import { focusFirst, restoreDrafts, unsentDrafts } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { recordedButUnread } from './work-error-view.ts';
import { renderAnsweredSheet, renderLoneTaskSheet, renderQuestionSheet } from './work-question-sheet.ts';
import type { Question, TaskDetail } from './work-types.ts';
import type { ViewMemory } from './work-view-memory.ts';
import type { EntrySheetPlace } from './work-view-state.ts';

export type EntrySheetsHost = Readonly<{
  /** The context of the sheets, whose answer sender says the answer came from a sheet. */
  ctx: ViewContext;
  api: WorkApi;
  /** The view's content element, and showing nodes in it. */
  content: HTMLElement;
  show: (...nodes: Node[]) => void;
  /** The view's request generation and the live signal of its requests. */
  generation: () => number;
  signal: () => AbortSignal | undefined;
  /** The way back to the entry screen. */
  back: () => void;
  memory: Pick<ViewMemory, 'fill' | 'note'>;
}>;

type Shown = Readonly<{ kind: 'question'; question: Question }> | Readonly<{ kind: 'task'; id: string }>;

const card = (scope: HTMLElement, question: string): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(question)}"]`);

export class EntrySheets {
  private shown: Shown | null = null;
  /** Numbers the reads of the task sheet after an answer: only the one started last is drawn, so two answers sent one
   *  after the other never show the older state last. */
  private rereads = 0;

  constructor(private readonly host: EntrySheetsHost) {}

  /** The sheet shown, as the place keeps it; null when none is. */
  place(): EntrySheetPlace | null {
    const shown = this.shown;
    if (!shown) return null;
    return shown.kind === 'task' ? { kind: 'task', id: shown.id } : { kind: 'question', id: shown.question.id };
  }

  /** The view shows something else now. */
  clear(): void {
    this.shown = null;
    this.rereads++;
  }

  /** The sheet of a question about no task or project, with its answer form (and the draft kept for it). */
  openQuestion(question: Question): void {
    this.shown = { kind: 'question', question };
    this.host.show(renderQuestionSheet(this.host.ctx, question, this.host.back));
    this.host.memory.fill(this.host.content);
    focusFirst(this.host.content.querySelector<HTMLElement>('.work-detail-heading'));
    this.host.memory.note();
  }

  /** The sheet of a task in no project, at `question` when given (focus on it). */
  openTask(detail: TaskDetail, question: string | null): void {
    this.shown = { kind: 'task', id: detail.task.id };
    this.drawTask(detail, question, new Map());
    this.host.memory.note();
  }

  /** The answer of `question` is recorded: a question's own sheet shows it answered, a task's sheet is read again
   *  (drafts of its other questions kept). False when the task could not be read again. */
  async recorded(question: string): Promise<boolean> {
    const shown = this.shown;
    if (shown?.kind === 'question') {
      this.host.show(renderAnsweredSheet(this.host.ctx, shown.question, this.host.back));
      focusFirst(card(this.host.content, question));
      return true;
    }
    return shown?.kind === 'task' ? this.reread(shown, question) : true;
  }

  private drawTask(detail: TaskDetail, question: string | null, drafts: ReadonlyMap<string, string>): void {
    const content = this.host.content;
    this.host.show(renderLoneTaskSheet(this.host.ctx, detail, this.host.back));
    restoreDrafts(content, drafts);
    this.host.memory.fill(content);
    focusFirst((question ? card(content, question) : null) ?? content.querySelector<HTMLElement>('.work-detail-heading'));
  }

  private async reread(shown: Shown & { kind: 'task' }, question: string): Promise<boolean> {
    const token = this.host.generation(), sequence = ++this.rereads;
    const result = await this.host.api.task(shown.id, this.host.signal());
    if (token !== this.host.generation() || this.shown !== shown || sequence !== this.rereads) return true;
    if (!result.ok) {
      this.rereadFailed(shown, question, result.error);
      return false;
    }
    this.drawTask(result.value, question, unsentDrafts(this.host.content, question));
    return true;
  }

  /** The answer is recorded but the task could not be read again: "Answer recorded" in place of its form, and the way
   *  to read the task again (static/work-error-view.ts). */
  private rereadFailed(shown: Shown & { kind: 'task' }, question: string, error: WorkError): void {
    const content = this.host.content;
    recordedButUnread(this.host.ctx.t, content, question, error, () => void this.reread(shown, question),
      content.querySelector('.work-qsheet-actions'));
  }
}
