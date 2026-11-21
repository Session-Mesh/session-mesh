// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The pending questions of the Projects view's entry screen as the view reads them: the state shown (drawn by
 * static/work-questions-triage-view.ts through the host), the reads (only the one started last is shown; a read the
 * owner did not ask for never redraws under the focus) and the questions answered meanwhile. static/work-view.ts says
 * when to read and where the block goes.
 */

import type { WorkApi, WorkResult } from './work-api.ts';
import { focusFirst } from './work-dom.ts';
import type { QuestionsChange } from './work-questions-sync.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import { withoutQuestion } from './work-questions.ts';
import type { OpenQuestionsDoc, Question } from './work-types.ts';

export type EntryQuestionsHost = Readonly<{
  api: WorkApi;
  /** The view's request generation: a read started under another one is not shown. */
  generation: () => number;
  /** The live signal of the view's requests. */
  signal: () => AbortSignal | undefined;
  /** True when the entry screen is not what the view shows (a project, a sheet, the view closed). */
  away: () => boolean;
  /** A read's count, for the badge and the session marker. */
  report: (result: WorkResult<OpenQuestionsDoc>) => void;
  /** The block for a state, with the view's handlers. */
  render: (state: EntryQuestionsState) => HTMLElement;
}>;

/** The questions of one page, and the most a read gives (work-read's `open-questions`). */
const PAGE = 20, MAX_PAGE = 100;

const opener = (scope: HTMLElement, question: string): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`.work-qrow[data-question-id="${CSS.escape(question)}"] .work-qrow-open`);

/** Where the focus is in `node` before a redraw: the question whose way in has it, '' elsewhere in the block, null
 *  when it is not in the block. */
function focusIn(node: HTMLElement): string | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !node.contains(focused)) return null;
  return focused.matches('.work-qrow-open') ? focused.closest<HTMLElement>('.work-qrow')?.dataset.questionId ?? '' : '';
}

export class EntryQuestions {
  private state: EntryQuestionsState = { kind: 'loading' };
  private node: HTMLElement | null = null;
  /** Numbers each read; only the one started last is shown. */
  private sequence = 0;
  /** The reads under way. */
  private reads = 0;

  constructor(private readonly host: EntryQuestionsHost) {}

  /** The block for the questions as last read, for an entry screen being drawn. */
  block(): HTMLElement {
    this.node = this.host.render(this.state);
    return this.node;
  }

  /** A new entry screen: its questions are being read. */
  loading(): void { this.state = { kind: 'loading' }; }

  /** An open question of the last read, or null. */
  question(id: string): Question | null {
    const shown = this.state;
    return shown.kind === 'ready' || shown.kind === 'stale' ? shown.doc.questions.find(question => question.id === id) ?? null : null;
  }

  /** A question answered anywhere leaves the list kept in memory, so a failed read never brings it back. */
  forgetAnswered(question: string): void {
    const shown = this.state;
    if (shown.kind === 'ready' || shown.kind === 'stale') this.state = { ...shown, doc: withoutQuestion(shown.doc, question) };
  }

  /** The marker read another count: the entry screen, when it shows the questions, is not reading them already (an
   *  answer's read would lose its notice and focus to a newer one) and the focus is not in the list, reads them again.
   *  Elsewhere the view reads again when the owner moves (Back, Refresh, a sheet). */
  heard(change: QuestionsChange): void {
    const node = this.node, shown = this.state;
    if (this.host.away() || this.reads > 0 || !node?.isConnected || shown.kind !== 'ready') return;
    if (typeof change.openQuestions !== 'number' || change.openQuestions === shown.doc.openQuestions) return;
    if (document.activeElement && node.contains(document.activeElement)) return this.whenLeft(node);
    void this.reread(false, undefined, true);
  }

  /** Read again once the focus has left `node` (the owner was in the list), unless a read is under way then. */
  private whenLeft(node: HTMLElement): void {
    node.addEventListener('focusout', event => {
      if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return this.whenLeft(node);
      if (node !== this.node || this.host.away() || this.reads > 0) return;
      void this.reread(false, undefined, true);
    }, { once: true });
  }

  /** Read the open questions again (or take the read `pending`) and redraw them in place. Focus goes to the block after
   *  a retry (`focus`); otherwise a focus that was in the block stays on the same control of the new one (the way in of
   *  the same question, else the section's line). */
  async reread(focus = true, pending?: Promise<WorkResult<OpenQuestionsDoc>>, passive = false): Promise<void> {
    const token = this.host.generation(), sequence = ++this.sequence;
    this.reads++;
    const result = await (pending ?? this.host.api.openQuestions(this.host.signal(), { limit: this.shownLimit() }))
      .finally(() => { this.reads--; });
    const node = this.node;
    if (token !== this.host.generation() || sequence !== this.sequence || this.host.away() || !node) return;
    this.host.report(result);
    // A read the owner did not ask for never redraws under the focus (a row being read): it waits for the focus to leave.
    if (passive && document.activeElement && node.contains(document.activeElement)) return this.whenLeft(node);
    const kept = focusIn(node);
    this.state = this.next(result);
    const next = this.host.render(this.state);
    node.replaceWith(next);
    this.node = next;
    const toggle = next.querySelector<HTMLElement>('.work-qsection-toggle');
    if (focus) focusFirst(toggle ?? next.querySelector<HTMLElement>('h2'));
    else if (kept !== null) focusFirst((kept ? opener(next, kept) : null) ?? toggle ?? next.querySelector<HTMLElement>('h2'));
  }

  /** As many questions as the list shows (pages read with "Show more" stay shown), between one page and the bound. The
   *  view reads as many for the counts of the rail. */
  shownLimit(): number {
    const shown = this.state;
    const count = shown.kind === 'ready' || shown.kind === 'stale' ? shown.doc.questions.length : 0;
    return Math.min(MAX_PAGE, Math.max(PAGE, count));
  }

  /** "Show more": the next page, after the last question shown, added under the others (a question already shown is
   *  not shown twice); focus goes to the first one added, else to the section's line. A failed read keeps the list
   *  with the error and its retry. */
  async more(): Promise<void> {
    const shown = this.state;
    if (shown.kind !== 'ready' && shown.kind !== 'stale') return;
    const token = this.host.generation(), sequence = ++this.sequence, last = shown.doc.questions.at(-1)?.id;
    this.reads++;
    const result = await this.host.api.openQuestions(this.host.signal(), last ? { after: last } : {})
      .finally(() => { this.reads--; });
    const node = this.node;
    if (token !== this.host.generation() || sequence !== this.sequence || this.host.away() || !node) return;
    this.host.report(result);
    const known = new Set(shown.doc.questions.map(question => question.id));
    const added = result.ok ? result.value.questions.filter(question => !known.has(question.id)) : [];
    this.state = result.ok ? { kind: 'ready', doc: { ...result.value, questions: [...shown.doc.questions, ...added] } }
      : { kind: 'stale', doc: shown.doc, error: result.error, retry: () => void this.more() };
    const next = this.host.render(this.state);
    node.replaceWith(next);
    this.node = next;
    const first = added[0] ? opener(next, added[0].id) : null;
    focusFirst(first ?? next.querySelector<HTMLElement>('.work-qsection-toggle') ?? next.querySelector<HTMLElement>('h2'));
  }

  /** What the block shows after a read. A failed read keeps the questions already shown (less those answered since)
   *  with the error and its retry. */
  private next(result: WorkResult<OpenQuestionsDoc>): EntryQuestionsState {
    if (result.ok) return { kind: 'ready', doc: result.value };
    const retry = (): void => void this.reread();
    const shown = this.state;
    if (shown.kind === 'ready' || shown.kind === 'stale') return { kind: 'stale', doc: shown.doc, error: result.error, retry };
    return { kind: 'failed', error: result.error, retry };
  }
}
