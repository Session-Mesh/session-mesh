// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Projects view: the open questions and an entry list of products and projects, a project view with five tabs and a
 * task detail pane, all read through POST /api/work/v1. Entry point of the built bundle (static/work-view.js). It owns the
 * content of one root element and nothing else of the page; the old workspace is not touched.
 */

import { failureOfKind } from './work-answer-form.ts';
import type { AnswerFailure, AnswerSender } from './work-answer-form.ts';
import { createWorkApi } from './work-api.ts';
import type { WorkApi, WorkError, WorkFetch, WorkResult } from './work-api.ts';
import { entryTree } from './work-derive.ts';
import { renderDetail } from './work-detail-view.ts';
import { button, el } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { renderEntry } from './work-entry-view.ts';
import { errorBlock, loadingBlock } from './work-error-view.ts';
import { renderProject } from './work-project-view.ts';
import type { ProjectView, TabKey } from './work-project-view.ts';
import { renderEntryQuestions } from './work-questions-view.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import type { OpenQuestionsDoc, ProductsDoc, ProjectsDoc } from './work-types.ts';

export type WorkViewOptions = Readonly<{
  root: HTMLElement;
  request: WorkFetch;
  translate: Translate;
  /** Called when the owner asks for the old workspace (from an empty state). */
  onLegacy: () => void;
  /** Called when the reader program is not installed; returns true when the host took over (the view then shows nothing more). */
  onNotAvailable?: () => boolean;
  /** The number of open questions of the tracker each time the view reads it (the entry screen, Refresh, an answer
   *  sent), or null when that read failed. The view never reads it on a timer. */
  onOpenQuestions?: (count: number | null) => void;
  now?: () => number;
  locale?: string;
}>;

export type WorkViewController = Readonly<{ open: () => void; close: () => void; destroy: () => void }>;

type EntryData = Readonly<{ products: ProductsDoc; projects: ProjectsDoc }>;
type OpenProject = Readonly<{ id: string; view: ProjectView }>;
/** After an answer: the question answered, and whether focus goes to it once the task is read again. */
type AfterAnswer = Readonly<{ question: string; focus: boolean }>;
/** Where an answer form was sent from: the task sheet, the Questions tab of a project, or the entry screen. */
type Surface = 'detail' | 'questions' | 'entry';

function markSelected(scope: HTMLElement, id: string | null): void {
  for (const node of scope.querySelectorAll<HTMLElement>('[data-task]')) {
    if (node.getAttribute('data-task') === id) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
  }
}

/** The unsent text under each question but `except` (the one just answered), by question id. */
function unsentDrafts(scope: HTMLElement, except: string): Map<string, string> {
  const drafts = new Map<string, string>();
  for (const slot of scope.querySelectorAll<HTMLElement>('[data-work-answer-slot]')) {
    const id = slot.dataset.workAnswerSlot, input = slot.querySelector<HTMLTextAreaElement>('.work-answer-input');
    if (id && id !== except && input?.value) drafts.set(id, input.value);
  }
  return drafts;
}

/** Put the drafts back under the questions that still offer the form. */
function restoreDrafts(scope: HTMLElement, drafts: ReadonlyMap<string, string>): void {
  for (const slot of scope.querySelectorAll<HTMLElement>('[data-work-answer-slot]')) {
    const draft = drafts.get(slot.dataset.workAnswerSlot ?? ''), input = slot.querySelector<HTMLTextAreaElement>('.work-answer-input');
    if (draft !== undefined && input) input.value = draft;
  }
}

function focusFirst(node: HTMLElement | null): void {
  if (!node) return;
  if (!node.matches('button, a, input, select, textarea, [tabindex]')) node.tabIndex = -1;
  node.focus();
}

class WorkView implements WorkViewController {
  private readonly api: WorkApi;
  private readonly t: Translate;
  private readonly content = el('div', 'work-content');
  private readonly expanded = new Set<string>();
  /** The context of the task sheet; `panelCtx` is the one of the project tabs and `entryCtx` the one of the entry screen,
   *  each with its own answer sender, so that the view knows where an answer was sent from. */
  private readonly ctx: ViewContext;
  private readonly panelCtx: ViewContext;
  private readonly entryCtx: ViewContext;
  private entry: EntryData | null = null;
  private entryQuestions: EntryQuestionsState = { kind: 'loading' };
  private entryQuestionsNode: HTMLElement | null = null;
  private project: OpenProject | null = null;
  private selected: string | null = null;
  private expandedSeeded = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private detailController: AbortController | null = null;
  private detailSequence = 0;
  private writeUnavailable = false;
  private readonly announcer = el('p', 'sr-only work-announcer');
  private readonly onEscape = (event: KeyboardEvent): void => this.closeDetailOnEscape(event);

  constructor(private readonly options: WorkViewOptions) {
    this.t = options.translate;
    this.api = createWorkApi(options.request);
    this.ctx = { t: this.t, locale: options.locale ?? (document.documentElement.lang || undefined),
      nowMs: options.now ?? (() => Date.now()), selectedTask: () => this.selected, selectTask: id => void this.selectTask(id),
      answers: this.sender('detail') };
    this.panelCtx = { ...this.ctx, answers: this.sender('questions') };
    this.entryCtx = { ...this.ctx, answers: this.sender('entry'), answerScope: 'entry-' };
    const refresh = button('btn work-refresh', this.t('work.refresh'), () => void this.reload());
    this.announcer.setAttribute('role', 'status');
    this.announcer.setAttribute('aria-live', 'polite');
    options.root.classList.add('work-root');
    options.root.replaceChildren(el('div', 'work-toolbar', refresh), this.content, this.announcer);
  }

  open = (): void => void this.reload();

  close = (): void => {
    this.controller?.abort(); this.detailController?.abort();
    this.generation++; this.detailSequence++;
    document.removeEventListener('keydown', this.onEscape, true);
  };

  destroy = (): void => {
    this.close();
    this.options.root.classList.remove('work-root');
    this.options.root.replaceChildren();
  };

  private sender(surface: Surface): AnswerSender {
    return { available: () => !this.writeUnavailable, submit: (question, answerText) => this.submitAnswer(question, answerText, surface) };
  }

  /** Starts a request series: cancels the previous one and returns the token that tells a stale answer. */
  private begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort(); this.detailController?.abort();
    document.removeEventListener('keydown', this.onEscape, true);   // a new series discards the open detail
    this.controller = new AbortController();
    return { token: ++this.generation, signal: this.controller.signal };
  }

  private show(...nodes: Node[]): void { this.content.replaceChildren(...nodes); }

  private failure(error: WorkError, retry: () => void, back?: () => void): void {
    this.show(errorBlock(this.t, error, { retry, legacy: this.options.onLegacy, ...(back ? { back } : {}) }));
  }

  private async reload(): Promise<void> {
    if (!this.project) return this.loadEntry();
    await this.openProject(this.project.id, this.project.view.current());
    await this.refreshCount();
  }

  /** Report the open questions count, or null after a failed read: the badge never shows a number it did not read. */
  private report(result: WorkResult<OpenQuestionsDoc>): void {
    this.options.onOpenQuestions?.(result.ok ? result.value.openQuestions : null);
  }

  /** Read the count again for the badge (Refresh and answers in a project; the entry screen reads it with its list). */
  private async refreshCount(): Promise<void> {
    const token = this.generation;
    const result = await this.api.openQuestions(this.controller?.signal);
    if (token === this.generation) this.report(result);
  }

  private async loadEntry(): Promise<void> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null;
    this.show(loadingBlock(this.t));
    const [products, projects, questions] = await Promise.all([this.api.products(signal), this.api.projects(signal),
      this.api.openQuestions(signal)]);
    if (token !== this.generation) return;
    this.report(questions);
    if (!products.ok) return this.entryFailure(products.error);
    if (!projects.ok) return this.entryFailure(projects.error);
    this.entry = { products: products.value, projects: projects.value };
    this.entryQuestions = this.questionsState(questions);
    this.renderEntryScreen();
  }

  private questionsState(result: WorkResult<OpenQuestionsDoc>): EntryQuestionsState {
    return result.ok ? { kind: 'ready', doc: result.value }
      : { kind: 'failed', error: result.error, retry: () => void this.rereadEntryQuestions(null) };
  }

  /** A missing reader program lets the host show the old view (once); any other failure is shown here with its buttons. */
  private entryFailure(error: WorkError): void {
    if (error.kind === 'not-available' && this.options.onNotAvailable?.()) return;
    this.failure(error, () => void this.loadEntry());
  }

  private seedExpanded(data: EntryData): void {
    if (this.expandedSeeded) return;
    this.expandedSeeded = true;
    for (const category of data.products.categories) {
      for (const product of category.products) if (product.projects > 0) this.expanded.add(product.id);
    }
  }

  private renderEntryScreen(): void {
    if (!this.entry) return;
    this.seedExpanded(this.entry);
    const cut = this.entry.products.truncated || this.entry.projects.truncated;
    const handlers = { t: this.t, expanded: this.expanded, openProject: (id: string) => void this.openProject(id) };
    this.entryQuestionsNode = this.entryQuestionsBlock();
    this.show(this.entryQuestionsNode, renderEntry(handlers, entryTree(this.entry.products, this.entry.projects)),
      ...(cut ? [el('p', 'work-notice work-omitted', this.t('work.entryTruncated'))] : []));
  }

  private entryQuestionsBlock(): HTMLElement {
    const titles = new Map((this.entry?.projects.projects ?? []).map(project => [project.id, project.title]));
    return renderEntryQuestions(this.entryCtx, { projectTitle: id => titles.get(id) ?? null,
      openProject: id => void this.openProject(id, 'questions'), openTask: id => void this.openTask(id) }, this.entryQuestions);
  }

  /** Read the open questions of the entry screen again and redraw them in place, keeping unsent drafts (but the one of
   *  `answered`); focus goes to the answered question, or to the block after a retry. */
  private async rereadEntryQuestions(answered: string | null, focus = true): Promise<void> {
    const token = this.generation;
    const result = await this.api.openQuestions(this.controller?.signal);
    if (token !== this.generation || this.project || !this.entryQuestionsNode) return;
    this.report(result);
    const drafts = unsentDrafts(this.entryQuestionsNode, answered ?? '');
    this.entryQuestions = this.questionsState(result);
    const next = this.entryQuestionsBlock();
    restoreDrafts(next, drafts);
    this.entryQuestionsNode.replaceWith(next);
    this.entryQuestionsNode = next;
    if (!focus) return;
    const question = answered ? next.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(answered)}"]`) : null;
    focusFirst(question ?? next.querySelector<HTMLElement>('h2'));
  }

  private async openProject(id: string, tab: TabKey = 'reprise'): Promise<void> {
    const { token, signal } = this.begin();
    this.selected = null;
    this.show(loadingBlock(this.t));
    const result = await this.api.project(id, signal);
    if (token !== this.generation) return;
    if (!result.ok) return this.failure(result.error, () => void this.openProject(id, tab), () => void this.backToEntry());
    const view = renderProject(this.panelCtx, result.value, tab, () => void this.backToEntry());
    this.project = { id, view };
    this.show(view.root);
    focusFirst(view.root.querySelector<HTMLElement>('.work-back'));
  }

  /** From a question of the entry screen: read the task to learn its project, then open that project on its Questions
   *  tab with the task's sheet. A task outside any project says so, with the way back. */
  private async openTask(id: string): Promise<void> {
    const { token, signal } = this.begin();
    this.show(loadingBlock(this.t));
    const result = await this.api.task(id, signal);
    if (token !== this.generation) return;
    if (!result.ok) return this.failure(result.error, () => void this.openTask(id), () => void this.backToEntry());
    const project = result.value.task.project;
    if (!project) {
      const back = button('btn work-back', this.t('work.back'), () => void this.backToEntry());
      this.show(el('div', 'work-error', el('p', 'work-error-text', this.t('work.questions.taskNoProject', { id })), el('div', 'work-actions', back)));
      return focusFirst(back);
    }
    await this.openProject(project, 'questions');
    if (this.project?.id === project) await this.selectTask(id);
  }

  /** Back to the entry screen as it was, then its open questions read again (an answer may have closed some). */
  private async backToEntry(): Promise<void> {
    if (!this.entry) return this.loadEntry();
    this.close();
    const from = this.project?.id;
    this.project = null; this.selected = null;
    this.renderEntryScreen();
    focusFirst(this.entryFocusTarget(from));
    await this.rereadEntryQuestions(null, false);
  }

  /** Where focus goes when the project view is left: the row of that project, else the first product button. */
  private entryFocusTarget(projectId: string | undefined): HTMLElement | null {
    const row = projectId ? this.content.querySelector<HTMLElement>(`.work-entry-project[data-project="${CSS.escape(projectId)}"]`) : null;
    if (row && !row.closest('[hidden]')) return row;
    return this.content.querySelector<HTMLElement>('.work-entry-toggle') ?? this.content.querySelector<HTMLElement>('.work-entry-category-name');
  }

  /** Send the owner's answer; on success or "already answered", read again what shows it, so it appears as recorded. */
  private async submitAnswer(question: string, answerText: string, surface: Surface): Promise<AnswerFailure | null> {
    const task = this.selected, token = this.generation;
    const result = await this.api.answer(question, answerText);
    if (!result.ok && result.error.kind !== 'conflict') {
      if (result.error.kind === 'not-available') this.writeUnavailable = true;
      return failureOfKind(result.error.kind);
    }
    // The write stands whatever happened meanwhile; a view closed (or reloaded) since shows nothing and reads nothing.
    if (token !== this.generation) return null;
    const notice = this.t(!result.ok ? 'work.answer.already' : result.value.uncommitted ? 'work.answer.sentUncommitted' : 'work.answer.sent');
    if (surface === 'entry') await this.rereadEntryQuestions(question);
    else await this.showRecordedInProject(question, surface, task);
    if (token === this.generation) this.announce(notice);
    return null;
  }

  /** In a project, the surface the answer came from is read first (focus on the question), then the other, then the count. */
  private async showRecordedInProject(question: string, surface: Surface, task: string | null): Promise<void> {
    const sheet = async (focus: boolean): Promise<void> => {
      if (task !== null && task === this.selected) await this.selectTask(task, { question, focus });
    };
    if (surface === 'detail') {
      await sheet(true);
      await this.rereadProject(question, false);
    } else {
      await this.rereadProject(question, true);
      await sheet(false);
    }
    await this.refreshCount();
  }

  /** Read the open project again and show it (header and sheet kept); drafts of the tab survive, but the answered one's. */
  private async rereadProject(question: string, focus: boolean): Promise<void> {
    const project = this.project, token = this.generation;
    if (!project) return;
    const result = await this.api.project(project.id, this.controller?.signal);
    if (token !== this.generation || this.project !== project) return;
    if (!result.ok) return this.announce(this.t('work.questions.rereadFailed'));
    const panel = project.view.panel('questions');
    const drafts = unsentDrafts(panel, question);
    project.view.replaceDoc(result.value);
    restoreDrafts(panel, drafts);
    markSelected(project.view.root, this.selected);
    if (focus) focusFirst(panel.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(question)}"]`) ?? panel);
  }

  private announce(message: string): void {
    this.announcer.textContent = '';
    setTimeout(() => { this.announcer.textContent = message; }, 50);   // a new text node, so the same message is read again
  }

  private async selectTask(id: string, after?: AfterAnswer): Promise<void> {
    if (!this.project) return;
    const view = this.project.view;
    this.selected = id;
    markSelected(view.root, id);
    if (!after) view.detailSlot.replaceChildren(this.closeButton(view), loadingBlock(this.t));
    view.showDetail(true);
    document.addEventListener('keydown', this.onEscape, true);
    const token = this.generation, sequence = ++this.detailSequence;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const result = await this.api.task(id, this.detailController.signal);
    if (token !== this.generation || sequence !== this.detailSequence || this.selected !== id) return;
    if (!result.ok) {
      view.detailSlot.replaceChildren(this.closeButton(view), errorBlock(this.t, result.error, { retry: () => void this.selectTask(id) }));
      return;
    }
    const body = renderDetail(this.ctx, result.value);
    // The reload after an answer keeps what the owner was typing under the other questions.
    if (after) restoreDrafts(body, unsentDrafts(view.detailSlot, after.question));
    view.detailSlot.replaceChildren(this.closeButton(view), body);
    if (after && !after.focus) return;
    const question = after ? body.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(after.question)}"]`) : null;
    focusFirst(question ?? body.querySelector<HTMLElement>('.work-detail-heading'));
  }

  private closeButton(view: ProjectView): HTMLElement {
    return button('btn work-detail-close', this.t('work.detail.close'), () => this.closeDetail(view));
  }

  private closeDetail(view: ProjectView): void {
    const previous = this.selected;
    this.selected = null;
    this.detailController?.abort(); this.detailSequence++;
    document.removeEventListener('keydown', this.onEscape, true);
    markSelected(view.root, null);
    view.showDetail(false);
    view.detailSlot.replaceChildren();
    // The control that opened the sheet is in the tab shown (a card, or a task heading of the Questions tab).
    const selector = `[data-task="${CSS.escape(previous ?? '')}"]`;
    if (previous) focusFirst(view.panel(view.current()).querySelector<HTMLElement>(selector) ?? view.root.querySelector<HTMLElement>(selector));
  }

  private closeDetailOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.project || this.project.view.detailSlot.hidden) return;
    const target = event.target;
    if (target !== document.body && !(target instanceof Node && this.options.root.contains(target))) return;   // a dialog or field elsewhere keeps its own Escape
    event.stopPropagation();
    this.closeDetail(this.project.view);
  }
}

export { counterText } from './work-questions.ts';

export function mountWorkView(options: WorkViewOptions): WorkViewController {
  return new WorkView(options);
}
