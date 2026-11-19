// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Projects view: an entry list of products and projects, a project view with four tabs and a task detail pane, all read
 * through POST /api/work/v1. Entry point of the built bundle (static/work-view.js). It owns the content of one root element
 * and nothing else of the page; the old workspace is not touched.
 */

import { failureOfKind } from './work-answer-form.ts';
import type { AnswerFailure } from './work-answer-form.ts';
import { createWorkApi } from './work-api.ts';
import type { WorkApi, WorkError, WorkFetch } from './work-api.ts';
import { entryTree } from './work-derive.ts';
import { renderDetail } from './work-detail-view.ts';
import { button, el } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { renderEntry } from './work-entry-view.ts';
import { errorBlock, loadingBlock } from './work-error-view.ts';
import { renderProject } from './work-project-view.ts';
import type { ProjectView, TabKey } from './work-project-view.ts';
import type { ProductsDoc, ProjectsDoc } from './work-types.ts';

export type WorkViewOptions = Readonly<{
  root: HTMLElement;
  request: WorkFetch;
  translate: Translate;
  /** Called when the owner asks for the old workspace (from an empty state). */
  onLegacy: () => void;
  /** Called when the reader program is not installed; returns true when the host took over (the view then shows nothing more). */
  onNotAvailable?: () => boolean;
  now?: () => number;
  locale?: string;
}>;

export type WorkViewController = Readonly<{ open: () => void; close: () => void; destroy: () => void }>;

type EntryData = Readonly<{ products: ProductsDoc; projects: ProjectsDoc }>;
type OpenProject = Readonly<{ id: string; view: ProjectView }>;
/** After an answer: the question to focus once the task is read again, and the message to announce. */
type AfterAnswer = Readonly<{ question: string; notice: string }>;

function markSelected(scope: HTMLElement, id: string | null): void {
  for (const node of scope.querySelectorAll<HTMLElement>('[data-task]')) {
    if (node.getAttribute('data-task') === id) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
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
  private readonly ctx: ViewContext;
  private entry: EntryData | null = null;
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
      answers: { available: () => !this.writeUnavailable, submit: (question, answerText) => this.submitAnswer(question, answerText) } };
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
    if (this.project) return this.openProject(this.project.id, this.project.view.current());
    return this.loadEntry();
  }

  private async loadEntry(): Promise<void> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null;
    this.show(loadingBlock(this.t));
    const [products, projects] = await Promise.all([this.api.products(signal), this.api.projects(signal)]);
    if (token !== this.generation) return;
    if (!products.ok) return this.entryFailure(products.error);
    if (!projects.ok) return this.entryFailure(projects.error);
    this.entry = { products: products.value, projects: projects.value };
    this.renderEntryScreen();
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
    this.show(renderEntry(handlers, entryTree(this.entry.products, this.entry.projects)),
      ...(cut ? [el('p', 'work-notice work-omitted', this.t('work.entryTruncated'))] : []));
  }

  private async openProject(id: string, tab: TabKey = 'reprise'): Promise<void> {
    const { token, signal } = this.begin();
    this.selected = null;
    this.show(loadingBlock(this.t));
    const result = await this.api.project(id, signal);
    if (token !== this.generation) return;
    if (!result.ok) return this.failure(result.error, () => void this.openProject(id, tab), () => void this.backToEntry());
    const view = renderProject(this.ctx, result.value, tab, () => void this.backToEntry());
    this.project = { id, view };
    this.show(view.root);
    focusFirst(view.root.querySelector<HTMLElement>('.work-back'));
  }

  private async backToEntry(): Promise<void> {
    if (!this.entry) return this.loadEntry();
    this.close();
    const from = this.project?.id;
    this.project = null; this.selected = null;
    this.renderEntryScreen();
    focusFirst(this.entryFocusTarget(from));
  }

  /** Where focus goes when the project view is left: the row of that project, else the first product button. */
  private entryFocusTarget(projectId: string | undefined): HTMLElement | null {
    const row = projectId ? this.content.querySelector<HTMLElement>(`[data-project="${CSS.escape(projectId)}"]`) : null;
    if (row && !row.closest('[hidden]')) return row;
    return this.content.querySelector<HTMLElement>('.work-entry-toggle') ?? this.content.querySelector<HTMLElement>('.work-entry-category-name');
  }

  /** Send the owner's answer; on success or "already answered", read the task again so the answer shows as recorded. */
  private async submitAnswer(question: string, answerText: string): Promise<AnswerFailure | null> {
    const task = this.selected, token = this.generation;
    const result = await this.api.answer(question, answerText);
    if (!result.ok && result.error.kind !== 'conflict') {
      if (result.error.kind === 'not-available') this.writeUnavailable = true;
      return failureOfKind(result.error.kind);
    }
    // The write stands whatever happened meanwhile; a view closed (or reloaded) since shows nothing and reads nothing.
    if (token !== this.generation) return null;
    const notice = this.t(!result.ok ? 'work.answer.already' : result.value.uncommitted ? 'work.answer.sentUncommitted' : 'work.answer.sent');
    if (task !== null && task === this.selected) await this.selectTask(task, { question, notice });
    else this.announce(notice);
    return null;
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
    if (after) this.announce(after.notice);
    if (!result.ok) {
      view.detailSlot.replaceChildren(this.closeButton(view), errorBlock(this.t, result.error, { retry: () => void this.selectTask(id) }));
      return;
    }
    const body = renderDetail(this.ctx, result.value);
    view.detailSlot.replaceChildren(this.closeButton(view), body);
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
    if (previous) focusFirst(view.root.querySelector<HTMLElement>(`[data-task="${CSS.escape(previous)}"]`));
  }

  private closeDetailOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.project || this.project.view.detailSlot.hidden) return;
    const target = event.target;
    if (target !== document.body && !(target instanceof Node && this.options.root.contains(target))) return;   // a dialog or field elsewhere keeps its own Escape
    event.stopPropagation();
    this.closeDetail(this.project.view);
  }
}

export function mountWorkView(options: WorkViewOptions): WorkViewController {
  return new WorkView(options);
}
