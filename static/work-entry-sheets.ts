// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The sheets the entry screen's questions open when there is no project view to open (static/work-question-sheet.ts
 * draws them): which one is shown, as the view's memory keeps it, the drafts put back into it, and what an answer
 * sent from it shows. static/work-view.ts opens them (one level above the entry screen) and closes them.
 */

import type { WorkApi, WorkError } from './work-api.ts';
import { button, el, focusFirst } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { recordedButUnread } from './work-error-view.ts';
import { renderAnsweredSheet, renderLoneTaskSheet, renderQuestionSheet } from './work-question-sheet.ts';
import { scrollerOf } from './work-nav.ts';
import { readOpenQuestions } from './work-questions.ts';
import type { Question, TaskDetail } from './work-types.ts';
import type { ViewMemory } from './work-view-memory.ts';
import { fillDrafts, unsentDrafts } from './work-view-drafts.ts';
import type { Draft, EntrySheetPlace } from './work-view-state.ts';

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

type Shown = Readonly<{ kind: 'question'; question: Question }> | Readonly<{ kind: 'task'; id: string }>
  | Readonly<{ kind: 'unavailable'; id: string }>;

const card = (scope: HTMLElement, question: string): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(question)}"]`);

export class EntrySheets {
  private shown: Shown | null = null;
  /** Numbers the reads of the task sheet after an answer: only the one started last is drawn, so two answers sent one
   *  after the other never show the older state last. */
  private rereads = 0;
  private snapshot: string | null = null;
  private answered = false;

  constructor(private readonly host: EntrySheetsHost) {}

  /** The sheet shown, as the place keeps it; null when none is. */
  place(): EntrySheetPlace | null {
    const shown = this.shown;
    if (!shown) return null;
    return shown.kind === 'question' ? { kind: 'question', id: shown.question.id }
      : { kind: shown.kind === 'task' ? 'task' : 'question', id: shown.id };
  }

  /** The view shows something else now. */
  clear(): void {
    this.shown = null;
    this.snapshot = null;
    this.rereads++;
  }

  /** The sheet of a question about no task or project, with its answer form (and the draft kept for it). */
  openQuestion(question: Question): void {
    this.shown = { kind: 'question', question };
    this.snapshot = JSON.stringify(question);
    this.answered = false;
    this.host.show(renderQuestionSheet(this.host.ctx, question, this.host.back));
    this.host.memory.fill(this.host.content);
    focusFirst(this.host.content.querySelector<HTMLElement>('.work-detail-heading'));
    this.host.memory.note();
  }

  /** Keep the place and its saved draft when the bounded lookup cannot establish the question's state. */
  openUnavailable(id: string): void {
    this.shown = { kind: 'unavailable', id };
    this.snapshot = null;
    const status = el('p', 'work-mute work-sheet-refresh-status', this.host.ctx.t('work.autoRefreshUnavailable'));
    status.setAttribute('role', 'status');
    this.host.show(el('div', 'work-qsheet', el('div', 'work-actions work-qsheet-actions',
      button('btn work-back', this.host.ctx.t('work.back'), this.host.back)),
      el('h2', 'work-detail-heading', id), status));
    focusFirst(this.host.content.querySelector<HTMLElement>('.work-detail-heading'));
    this.host.memory.note();
  }

  /** The sheet of a task in no project, at `question` when given (focus on it). */
  openTask(detail: TaskDetail, question: string | null): void {
    this.shown = { kind: 'task', id: detail.task.id };
    this.snapshot = JSON.stringify(detail);
    this.answered = false;
    this.drawTask(detail, question, new Map());
    this.host.memory.note();
  }

  /** The answer of `question` is recorded: a question's own sheet shows it answered, a task's sheet is read again
   *  (drafts of its other questions kept). False when the task could not be read again. */
  async recorded(question: string): Promise<boolean> {
    const shown = this.shown;
    if (shown?.kind === 'question') {
      this.answered = true;
      this.rereads++;
      this.host.show(renderAnsweredSheet(this.host.ctx, shown.question, this.host.back));
      focusFirst(card(this.host.content, question));
      return true;
    }
    return shown?.kind === 'task' ? this.reread(shown, question) : true;
  }

  private drawTask(detail: TaskDetail, question: string | null, drafts: ReadonlyMap<string, Draft>): void {
    this.snapshot = JSON.stringify(detail);
    const content = this.host.content;
    this.host.show(renderLoneTaskSheet(this.host.ctx, detail, this.host.back));
    fillDrafts(content, drafts);
    this.host.memory.fill(content);
    focusFirst((question ? card(content, question) : null) ?? content.querySelector<HTMLElement>('.work-detail-heading'));
  }

  /** Refresh an entry sheet without interrupting an answer or a control in use. */
  async refreshInBackground(signal: AbortSignal | undefined, idle: () => boolean): Promise<void> {
    const shown = this.shown, snapshot = this.snapshot;
    if (!shown || shown.kind === 'unavailable' || snapshot === null || this.answered || !idle()) return;
    const token = this.host.generation(), sequence = this.rereads;
    const result = shown.kind === 'task'
      ? await this.host.api.task(shown.id, signal)
      : await readOpenQuestions(page => this.host.api.openQuestions(signal, page), 100);
    if (token !== this.host.generation() || shown !== this.shown || sequence !== this.rereads || this.answered) return;
    const content = this.host.content, frame = content.querySelector<HTMLElement>('.work-qsheet');
    if (!frame) return;
    const status = (text: string | null): void => {
      let node = frame.querySelector<HTMLElement>('.work-sheet-refresh-status');
      if (!text) { node?.remove(); return; }
      if (!node) {
        node = el('p', 'work-mute work-sheet-refresh-status');
        node.setAttribute('role', 'status');
        frame.querySelector('.work-qsheet-actions')?.after(node);
      }
      node.textContent = text;
    };
    if (!result.ok) { status(this.host.ctx.t('work.autoRefreshUnavailable')); return; }
    const next = shown.kind === 'task' ? result.value as TaskDetail
      : (result.value as { questions: readonly Question[] }).questions.find(q => q.id === shown.question.id);
    if (!next) { status(this.host.ctx.t('work.autoRefreshUnavailable')); return; }
    const encoded = JSON.stringify(next);
    if (encoded === this.snapshot) { status(null); return; }
    const drafts = unsentDrafts(content, ''), focused = document.activeElement;
    const headingFocused = focused === frame.querySelector('.work-detail-heading');
    const backFocused = focused === frame.querySelector('.work-back');
    if (!idle() || (frame.contains(focused) && !headingFocused && !backFocused) || drafts.size || frame.querySelector('.work-answer-input[readonly]')) {
      status(this.host.ctx.t('work.sheetUpdatesPending'));
      return;
    }
    const opened = [...frame.querySelectorAll<HTMLDetailsElement>('.work-answer-history[open]')]
      .map(node => node.closest<HTMLElement>('[data-question-id]')?.dataset.questionId).filter((id): id is string => !!id);
    const scrollRoot = scrollerOf(content), scroll = scrollRoot.scrollTop;
    const replacement = shown.kind === 'task'
      ? renderLoneTaskSheet(this.host.ctx, next as TaskDetail, this.host.back)
      : renderQuestionSheet(this.host.ctx, next as Question, this.host.back);
    fillDrafts(replacement, drafts);
    this.host.memory.fill(replacement);
    for (const id of opened) {
      const details = card(replacement, id)?.querySelector<HTMLDetailsElement>('.work-answer-history');
      if (details) details.open = true;
    }
    frame.replaceWith(replacement);
    if (headingFocused) focusFirst(replacement.querySelector<HTMLElement>('.work-detail-heading'), true);
    if (backFocused) focusFirst(replacement.querySelector<HTMLElement>('.work-back'), true);
    scrollRoot.scrollTop = scroll;
    this.snapshot = encoded;
    if (shown.kind === 'question') this.shown = { kind: 'question', question: next as Question };
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
