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
import { mountDocPanel } from './work-doc-panel.ts';
import type { DocPanel } from './work-doc-panel.ts';
import { button, el, focusFirst, markSelected, restoreDrafts, unsentDrafts } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { renderEntry } from './work-entry-view.ts';
import { loadOperatorName } from './work-operator-label.ts';
import { errorBlock, loadingBlock } from './work-error-view.ts';
import { browserHistory, createWorkNav, escapeKeepsField, scrollerOf, tabsHidden } from './work-nav.ts';
import type { HistoryPort, WorkNav } from './work-nav.ts';
import { TAB_KEYS, renderProject } from './work-project-view.ts';
import type { ProjectView, TabKey } from './work-project-view.ts';
import { createViewMemory } from './work-view-memory.ts';
import type { Scroll, ViewMemory } from './work-view-memory.ts';
import type { Place } from './work-view-state.ts';
import { pageQuestionsSync } from './work-questions-sync.ts';
import type { QuestionsChange, QuestionsSync } from './work-questions-sync.ts';
import { renderEntryQuestions } from './work-questions-view.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import { withoutQuestion } from './work-questions.ts';
import type { WorkTarget } from './work-session-questions.ts';
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
  /** The browser history (static/work-nav.ts); the page's by default. */
  history?: HistoryPort;
  /** The questions channel shared with the session marker (static/work-questions-sync.ts); the page's by default. */
  sync?: QuestionsSync;
}>;

/** `open` shows the view as the owner left it, in this page or before a reload of this tab (the entry screen the first
 *  time), or the place a target names: the sheet of a task in its project's Questions tab, the Questions tab of a
 *  project, or the entry screen. `forget` drops that memory and the unsent drafts (the browser signs out). */
export type WorkViewController = Readonly<{ open: (target?: WorkTarget) => void; close: () => void; destroy: () => void;
  forget: () => void }>;

type EntryData = Readonly<{ products: ProductsDoc; projects: ProjectsDoc }>;
type OpenProject = Readonly<{ id: string; view: ProjectView }>;
/** After an answer: the question answered, and whether focus goes to it once the task is read again. */
type AfterAnswer = Readonly<{ question: string; focus: boolean }>;
/** Where an answer form was sent from: the task sheet, the Questions tab of a project, or the entry screen. */
type Surface = 'detail' | 'questions' | 'entry';

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
  /** Numbers each read of the entry screen's open questions; only the last one started is shown. */
  private questionsSequence = 0;
  /** The reads of the entry screen's open questions under way. */
  private entryReads = 0;
  private controller: AbortController | null = null;
  private detailController: AbortController | null = null;
  private detailSequence = 0;
  private writeUnavailable = false;
  private readonly announcer = el('p', 'sr-only work-announcer');
  /** The document panel of the references in tracker text (static/work-doc-panel.ts). */
  private readonly docs: DocPanel;
  /** Between `open` and `close`: Escape and the browser's Back act on the view only then. */
  private active = false;
  private readonly nav: WorkNav;
  private readonly sync: QuestionsSync;
  private readonly unsubscribe: () => void;
  /** Where the tab was scrolled when the sheet covered it (a phone), put back when the sheet closes. */
  private tabScroll: number | null = null;
  private sheetBack: HTMLElement | null = null;
  /** The owner's place and unsent drafts while away (static/work-view-memory.ts); `openings` numbers each `open`. */
  private readonly memory: ViewMemory;
  private openings = 0;
  /** The project being read (shown once read), until the view moves elsewhere. */
  private reading: Readonly<{ id: string; tab: TabKey }> | null = null;
  private readonly onEscape = (event: KeyboardEvent): void => this.upOnEscape(event);
  private readonly onPopState = (event: PopStateEvent): void => this.wentBack(event.state);

  constructor(private readonly options: WorkViewOptions) {
    this.t = options.translate;
    this.api = createWorkApi(options.request);
    this.nav = createWorkNav(options.history ?? browserHistory());
    this.sync = options.sync ?? pageQuestionsSync;
    this.unsubscribe = this.sync.subscribe('view', change => this.heard(change));
    window.addEventListener('popstate', this.onPopState);
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
    this.docs = mountDocPanel({ root: options.root, request: options.request, translate: this.t });
    this.memory = createViewMemory({ root: options.root, scroller: () => scrollerOf(options.root), current: scroll => this.placeNow(scroll) });
    const unfolded = this.memory.place().expanded;
    if (unfolded) { unfolded.forEach(id => this.expanded.add(id)); this.expandedSeeded = true; }
  }

  open = (target?: WorkTarget): void => void this.openAt(target);

  private async openAt(target?: WorkTarget): Promise<void> {
    this.active = true;
    const opening = ++this.openings;
    document.addEventListener('keydown', this.onEscape, true);
    if (!target) await this.resume();
    else if (target.kind === 'entry') await this.loadEntry();
    else {
      if (target.kind === 'task') await this.openTask(target.id, target.tab);
      else await this.openProject(target.id, target.tab ?? 'questions');
      await this.refreshCount();   // the entry screen, which reads the count with its list, was not shown
    }
    if (this.active && opening === this.openings) this.memory.listen(true);   // from now on the owner's moves are noted
  }

  /** Back to where the owner left the view: the project and its tab read again, then the sheet, the scroll and the
   *  drafts put back. A project gone since shows the entry screen, a task gone since its tab. */
  private async resume(): Promise<void> {
    const place = this.memory.place();
    if (!place.project) { await this.loadEntry(); return this.scrollTo(place); }
    const tab = TAB_KEYS.find(key => key === place.tab) ?? 'reprise';
    if (!(await this.openProject(place.project, tab, true))) return;
    if (place.task) await this.selectTask(place.task, undefined, true);
    if (place.task !== null && place.task === this.selected) this.tabScroll = place.tabScroll;
    this.scrollTo(place);
    await this.refreshCount();
  }

  private scrollTo(place: Place): void {
    if (!this.active) return;
    scrollerOf(this.options.root).scrollTop = place.scroll;
    const sheet = this.project?.view.detailSlot;
    if (sheet && !sheet.hidden) sheet.scrollTop = place.sheetScroll;
  }

  /** The place the view shows, as the memory keeps it. */
  private placeNow(scroll: Scroll): Place {
    const project = this.project, task = project ? this.selected : null, reading = project ? null : this.reading;
    return { project: project?.id ?? reading?.id ?? null, tab: project?.view.current() ?? reading?.tab ?? null, task, ...scroll,
      tabScroll: task ? this.tabScroll : null, expanded: this.expandedSeeded ? [...this.expanded] : null };
  }

  /** Leaving the view takes back its entries of the browser history; the place and the drafts stay in memory. */
  close = (): void => {
    this.memory.listen(false);
    this.stopRequests();
    this.active = false;
    document.removeEventListener('keydown', this.onEscape, true);
    this.docs.close();
    this.nav.at(0);
  };

  forget = (): void => this.memory.forget();

  destroy = (): void => {
    this.close();
    this.memory.dispose();
    this.docs.destroy();
    window.removeEventListener('popstate', this.onPopState);
    this.unsubscribe();
    this.options.root.classList.remove('work-root');
    this.options.root.replaceChildren();
  };

  private sender(surface: Surface): AnswerSender {
    return { available: () => !this.writeUnavailable, submit: (question, answerText) => this.submitAnswer(question, answerText, surface) };
  }

  private stopRequests(): void {
    this.controller?.abort(); this.detailController?.abort();
    this.generation++; this.detailSequence++;
  }

  /** Starts a request series: cancels the previous one and returns the token that tells a stale answer. */
  private begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort(); this.detailController?.abort();
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
    const count = result.ok ? result.value.openQuestions : null;
    this.options.onOpenQuestions?.(count);
    this.sync.publish({ source: 'view', openQuestions: count });   // the marker reads again when the count moved
  }

  /** The marker read another count: the entry screen, when it shows the questions, is not reading them already (an
   *  answer's read would lose its notice and focus to a newer one) and the owner is not answering one of them, reads
   *  them again. Elsewhere the view reads again when the owner moves (Back, Refresh, a sheet). */
  private heard(change: QuestionsChange): void {
    const node = this.entryQuestionsNode, shown = this.entryQuestions;
    if (!this.active || this.project || this.entryReads > 0 || !node?.isConnected || shown.kind !== 'ready') return;
    if (typeof change.openQuestions !== 'number' || change.openQuestions === shown.doc.openQuestions) return;
    if (document.activeElement && node.contains(document.activeElement)) return this.whenLeft(node);
    void this.rereadEntryQuestions(null, false, undefined, true);
  }

  /** Read the entry screen's questions again once the focus has left `node` (the owner was answering there), unless
   *  a read is under way then (an answer's): it shows the questions itself and must not be replaced. */
  private whenLeft(node: HTMLElement): void {
    node.addEventListener('focusout', event => {
      if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return this.whenLeft(node);
      if (node !== this.entryQuestionsNode || this.project || this.entryReads > 0) return;
      void this.rereadEntryQuestions(null, false, undefined, true);
    }, { once: true });
  }

  /** Read the count again for the badge (Refresh and answers in a project; the entry screen reads it with its list). */
  private async refreshCount(): Promise<void> {
    const token = this.generation;
    const result = await this.api.openQuestions(this.controller?.signal);
    if (token === this.generation) this.report(result);
  }

  /** The products and projects first (the page reads two documents at a time, see work-api.ts), then the open
   *  questions, drawn in place when they arrive. */
  private async loadEntry(): Promise<void> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null; this.reading = null;
    this.nav.at(0);
    this.show(loadingBlock(this.t));
    const reads = [this.api.products(signal), this.api.projects(signal)] as const;
    const questions = this.api.openQuestions(signal);   // waits for a free slot
    const [products, projects] = await Promise.all(reads);
    if (token !== this.generation) return;
    if (!products.ok) return this.entryFailure(products.error);
    if (!projects.ok) return this.entryFailure(projects.error);
    this.entry = { products: products.value, projects: projects.value };
    this.entryQuestions = { kind: 'loading' };
    this.renderEntryScreen();
    await this.rereadEntryQuestions(null, false, questions);
  }

  /** What the entry screen shows after a read of the open questions. A failed read keeps the questions already shown
   *  (and so the drafts under them) with the error and its retry; the one just answered leaves the list. */
  private nextQuestionsState(result: WorkResult<OpenQuestionsDoc>, answered: string | null): EntryQuestionsState {
    if (result.ok) return { kind: 'ready', doc: result.value };
    const retry = (): void => void this.rereadEntryQuestions(null);
    const shown = this.entryQuestions;
    if (shown.kind === 'ready' || shown.kind === 'stale') return { kind: 'stale', doc: withoutQuestion(shown.doc, answered), error: result.error, retry };
    return { kind: 'failed', error: result.error, retry };
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
    this.memory.note();
  }

  /** The entry screen's questions, with the owner's unsent drafts. */
  private entryQuestionsBlock(): HTMLElement {
    const titles = new Map((this.entry?.projects.projects ?? []).map(project => [project.id, project.title]));
    const block = renderEntryQuestions(this.entryCtx, { projectTitle: id => titles.get(id) ?? null,
      openProject: id => void this.openProject(id, 'questions'), openTask: id => void this.openTask(id) }, this.entryQuestions);
    this.memory.fill(block);
    return block;
  }

  /** Read the open questions of the entry screen again (or take the read `pending`) and redraw them in place, keeping
   *  unsent drafts (but the one of `answered`); focus goes to the answered question, or to the block after a retry.
   *  Only the read started last is shown, so an older answer never replaces a newer one. False when the read failed. */
  private async rereadEntryQuestions(answered: string | null, focus = true,
    pending?: Promise<WorkResult<OpenQuestionsDoc>>, passive = false): Promise<boolean> {
    const token = this.generation, sequence = ++this.questionsSequence;
    this.entryReads++;
    const result = await (pending ?? this.api.openQuestions(this.controller?.signal)).finally(() => { this.entryReads--; });
    const node = this.entryQuestionsNode;
    if (token !== this.generation || sequence !== this.questionsSequence || this.project || !node) return true;
    this.report(result);
    // A read the owner did not ask for never redraws under a field being typed in: it waits for the focus to leave.
    if (passive && document.activeElement && node.contains(document.activeElement)) { this.whenLeft(node); return true; }
    const drafts = unsentDrafts(node, answered ?? '');
    this.entryQuestions = this.nextQuestionsState(result, answered);
    const next = this.entryQuestionsBlock();
    restoreDrafts(next, drafts);
    node.replaceWith(next);
    this.entryQuestionsNode = next;
    if (focus) {
      const question = answered ? next.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(answered)}"]`) : null;
      focusFirst(question ?? next.querySelector<HTMLElement>('h2'));
    }
    return result.ok;
  }

  /** True when the project is shown. `resuming` (the place the owner left): a project gone since shows the entry screen. */
  private async openProject(id: string, tab: TabKey = 'reprise', resuming = false): Promise<boolean> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null;   // the view shown before is gone: Escape now goes to the entry screen
    this.reading = { id, tab };   // the place while it is read: a reload meanwhile comes back to it
    this.nav.at(1);
    this.show(loadingBlock(this.t));
    this.memory.note();
    const result = await this.api.project(id, signal);
    if (token !== this.generation) return false;
    this.reading = null;
    if (!result.ok && resuming && result.error.kind === 'missing') { await this.loadEntry(); return false; }
    if (!result.ok) { this.failure(result.error, () => void this.openProject(id, tab), () => void this.backToEntry()); return false; }
    const view = renderProject(this.panelCtx, result.value, tab, () => void this.backToEntry(), key => this.tabShown(key));
    this.project = { id, view };
    this.memory.fill(view.root);
    this.show(view.root);
    focusFirst(view.root.querySelector<HTMLElement>('.work-back'));
    this.memory.note();
    return true;
  }

  /** A tab shown: the sheet's way back names it, a panel just built gets the drafts back, and the place is noted. */
  private tabShown(key: TabKey): void {
    this.nameSheetBack();
    const view = this.project?.view;
    if (!view) return;
    this.memory.fill(view.panel(key));
    this.memory.note();
  }

  /** From a question of the entry screen (or a terminal reference): read the task to learn its project, then open that
   *  project on its Questions tab (or `tab`) with the task's sheet. A task outside any project says so, with the way back. */
  private async openTask(id: string, tab: TabKey = 'questions'): Promise<void> {
    const { token, signal } = this.begin();
    this.show(loadingBlock(this.t));
    const result = await this.api.task(id, signal);
    if (token !== this.generation) return;
    if (!result.ok) return this.failure(result.error, () => void this.openTask(id, tab), () => void this.backToEntry());
    const project = result.value.task.project;
    if (!project) {
      const back = button('btn work-back', this.t('work.back'), () => void this.backToEntry());
      const why = tab === 'questions' ? 'work.questions.taskNoProject' : 'work.references.taskNoProject';
      this.show(el('div', 'work-error', el('p', 'work-error-text', this.t(why, { id })), el('div', 'work-actions', back)));
      return focusFirst(back);
    }
    await this.openProject(project, tab);
    if (this.project?.id === project) await this.selectTask(id);
  }

  /** Back to the entry screen as it was, then its open questions read again (an answer may have closed some). */
  private async backToEntry(): Promise<void> {
    if (!this.entry) return this.loadEntry();
    this.stopRequests();
    this.docs.close();
    this.nav.at(0);
    this.controller = new AbortController();   // the project's signal is aborted; the questions read needs a live one
    const from = this.project?.id;
    this.project = null; this.selected = null; this.reading = null;
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
    this.memory.sent(question);   // recorded: its draft is not kept, nor put back by the reads that follow
    this.sync.publish({ source: 'view', answered: question });   // the marker drops it now, wherever the view is
    // The write stands whatever happened meanwhile; a view closed (or reloaded) since shows nothing and reads nothing.
    if (token !== this.generation) return null;
    const notice = this.t(!result.ok ? 'work.answer.already' : result.value.uncommitted ? 'work.answer.sentUncommitted' : 'work.answer.sent');
    const shown = surface === 'entry' ? await this.rereadEntryQuestions(question) : await this.showRecordedInProject(question, surface, task);
    // The write stands; when what shows it could not be read again, the notice says that rather than only "recorded".
    const failed = surface === 'entry' ? 'work.questions.entryRereadFailed' : 'work.questions.rereadFailed';
    if (token === this.generation) this.announce(shown ? notice : this.t(failed));
    return null;
  }

  /** In a project, the surface the answer came from is read first (focus on the question), then the other, then the
   *  count. False when the project could not be read again. */
  private async showRecordedInProject(question: string, surface: Surface, task: string | null): Promise<boolean> {
    const sheet = async (focus: boolean): Promise<void> => {
      if (task !== null && task === this.selected) await this.selectTask(task, { question, focus });
    };
    let shown: boolean;
    if (surface === 'detail') {
      await sheet(true);
      shown = await this.rereadProject(question, false);
    } else {
      shown = await this.rereadProject(question, true);
      await sheet(false);
    }
    await this.refreshCount();
    return shown;
  }

  /** Read the open project again and show it (header and sheet kept); drafts of the tab survive, but the answered one's.
   *  False when the read failed (a view left meanwhile is not a failure). */
  private async rereadProject(question: string, focus: boolean): Promise<boolean> {
    const project = this.project, token = this.generation;
    if (!project) return true;
    const result = await this.api.project(project.id, this.controller?.signal);
    if (token !== this.generation || this.project !== project) return true;
    if (!result.ok) return false;
    const panel = project.view.panel('questions');
    const drafts = unsentDrafts(panel, question);
    project.view.replaceDoc(result.value);
    restoreDrafts(panel, drafts);
    markSelected(project.view.root, this.selected);
    if (focus) focusFirst(panel.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(question)}"]`) ?? panel);
    return true;
  }

  private announce(message: string): void {
    this.announcer.textContent = '';
    setTimeout(() => { this.announcer.textContent = message; }, 50);   // a new text node, so the same message is read again
  }

  /** `resuming` (the sheet the owner left): a task gone since closes the sheet. */
  private async selectTask(id: string, after?: AfterAnswer, resuming = false): Promise<void> {
    if (!this.project) return;
    const view = this.project.view;
    this.selected = id;
    markSelected(view.root, id);
    if (view.detailSlot.hidden) this.tabScroll = scrollerOf(view.root).scrollTop;
    if (!after) view.detailSlot.replaceChildren(this.closeButton(view), loadingBlock(this.t));
    view.showDetail(true);
    this.nav.at(2);
    this.memory.note();
    const token = this.generation, sequence = ++this.detailSequence;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const result = await this.api.task(id, this.detailController.signal);
    if (token !== this.generation || sequence !== this.detailSequence || this.selected !== id) return;
    if (!result.ok && resuming && result.error.kind === 'missing') return this.closeDetail(view);
    if (!result.ok) {
      view.detailSlot.replaceChildren(this.closeButton(view), errorBlock(this.t, result.error, { retry: () => void this.selectTask(id) }));
      return;
    }
    const body = renderDetail(this.ctx, result.value);
    // The reload after an answer keeps what the owner was typing under the other questions; the drafts kept while
    // away (this sheet's, or one typed in another place) come back too.
    if (after) restoreDrafts(body, unsentDrafts(view.detailSlot, after.question));
    this.memory.fill(body);
    view.detailSlot.replaceChildren(this.closeButton(view), body);
    if (after && !after.focus) return;
    const question = after ? body.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(after.question)}"]`) : null;
    focusFirst(question ?? body.querySelector<HTMLElement>('.work-detail-heading'));
  }

  /** The sheet's way back: it names the tab it returns to (and, for a screen reader, the project). */
  private closeButton(view: ProjectView): HTMLElement {
    this.sheetBack = button('btn work-detail-close', '', () => this.closeDetail(view));
    this.nameSheetBack();
    return this.sheetBack;
  }

  private nameSheetBack(): void {
    const view = this.project?.view;
    if (!view || !this.sheetBack) return;
    const tab = this.t(`work.tab.${view.current()}`);
    this.sheetBack.textContent = this.t('work.detail.back', { tab });
    this.sheetBack.setAttribute('aria-label', this.t('work.detail.backLabel', { tab, project: view.title }));
  }

  /** Back from the sheet to the tab it covered, scrolled where it was, focus on the control that opened it. */
  private closeDetail(view: ProjectView): void {
    const previous = this.selected, restore = tabsHidden(view.root) ? this.tabScroll : null;
    this.selected = null; this.tabScroll = null; this.sheetBack = null;
    this.detailController?.abort(); this.detailSequence++;
    this.nav.at(1);
    markSelected(view.root, null);
    view.showDetail(false);
    view.detailSlot.replaceChildren();
    if (restore !== null) scrollerOf(view.root).scrollTop = restore;
    this.memory.note();
    // The control that opened the sheet is in the tab shown (a card, or a task heading of the Questions tab).
    const selector = `[data-task="${CSS.escape(previous ?? '')}"]`;
    if (previous) focusFirst(view.panel(view.current()).querySelector<HTMLElement>(selector) ?? view.root.querySelector<HTMLElement>(selector), restore !== null);
  }

  /** The browser's Back (or a phone's back gesture) went to an entry of the view: show that level. */
  private wentBack(state: unknown): void {
    const level = this.nav.popped(state), project = this.project;
    if (level === null || !this.active) return;
    if (level === 0) void this.backToEntry();
    else if (project && !project.view.detailSlot.hidden) this.closeDetail(project.view);
  }

  /** Escape goes up one level: sheet to tab, project to the entry screen; on the entry screen the page's own Escape
   *  leaves Projects. A text field holding text keeps it (nothing happens). */
  private upOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.active) return;
    const target = event.target;
    if (target !== document.body && !(target instanceof Node && this.options.root.contains(target))) return;   // a dialog or field elsewhere keeps its own Escape
    const project = this.project;
    if (escapeKeepsField(target)) { event.stopPropagation(); return; }
    if (!project && this.nav.level() === 0) return;   // a project still read (or that failed) is level 1 already
    event.stopPropagation();
    if (project && !project.view.detailSlot.hidden) this.closeDetail(project.view); else void this.backToEntry();
  }
}

export { counterText } from './work-questions.ts';
export { createSessionMarker as mountSessionMarker } from './work-session-marker.ts';
export { createReferences as mountReferences } from './work-references.ts';

export function mountWorkView(options: WorkViewOptions): WorkViewController {
  const view = new WorkView(options);
  // Each opening also reads the operator's display name again (work-operator-label.ts).
  return { close: view.close, destroy: view.destroy, forget: view.forget, open: (...args: Parameters<WorkViewController['open']>) => {
    void loadOperatorName(options.request);
    view.open(...args);
  } };
}
