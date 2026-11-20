// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Projects view: the open questions and an entry list of products and projects, a project view with five tabs and a
 * task detail pane, all read through POST /api/work/v1. Entry point of the built bundle (static/work-view.js). It owns the
 * content of one root element and nothing else of the page; the old workspace is not touched. The entry screen's
 * questions are read by static/work-entry-questions.ts, the sheets they open without a project by
 * static/work-entry-sheets.ts.
 */

import type { AnswerSender } from './work-answer-form.ts';
import { createWorkApi } from './work-api.ts';
import type { WorkApi, WorkError, WorkResult } from './work-api.ts';
import { entryTree } from './work-derive.ts';
import { renderDetail } from './work-detail-view.ts';
import { mountDocPanel } from './work-doc-panel.ts';
import type { DocPanel } from './work-doc-panel.ts';
import { button, el, focusFirst, markSelected, restoreDrafts, unsentDrafts } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { EntryQuestions } from './work-entry-questions.ts';
import { EntrySheets } from './work-entry-sheets.ts';
import { entryFocusTarget, renderEntry, seedExpanded } from './work-entry-view.ts';
import { loadOperatorName } from './work-operator-label.ts';
import { errorBlock, loadingBlock, recordedButUnread } from './work-error-view.ts';
import { browserHistory, createWorkNav, scrollerOf, tabsHidden, upOnEscape, wentBack } from './work-nav.ts';
import type { LevelHost, WorkNav } from './work-nav.ts';
import type { ProjectAnswersHost } from './work-project-answers.ts';
import { TAB_KEYS, nameSheetBack, renderProject } from './work-project-view.ts';
import type { ProjectView, TabKey } from './work-project-view.ts';
import { createViewMemory } from './work-view-memory.ts';
import type { Scroll, ViewMemory } from './work-view-memory.ts';
import { sendAnswer } from './work-view-answer.ts';
import type { AnswerHost, Surface } from './work-view-answer.ts';
import type { WorkViewController, WorkViewOptions } from './work-view-options.ts';
import { sameSheet } from './work-view-state.ts';
import type { Place } from './work-view-state.ts';
import { pageQuestionsSync } from './work-questions-sync.ts';
import type { QuestionsSync } from './work-questions-sync.ts';
import { renderEntryQuestions } from './work-questions-triage-view.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import type { WorkTarget } from './work-session-questions.ts';
import type { OpenQuestionsDoc, ProductsDoc, ProjectsDoc, Question } from './work-types.ts';

export type { WorkViewController, WorkViewOptions } from './work-view-options.ts';

type EntryData = Readonly<{ products: ProductsDoc; projects: ProjectsDoc }>;
type OpenProject = Readonly<{ id: string; view: ProjectView }>;
/** After an answer (or on opening the sheet at a question, `fresh`): the question, and whether focus goes to it once
 *  the task is read. */
type AfterAnswer = Readonly<{ question: string; focus: boolean; fresh?: boolean }>;

class WorkView implements WorkViewController {
  private readonly api: WorkApi;
  private readonly t: Translate;
  private readonly content = el('div', 'work-content');
  private readonly expanded = new Set<string>();
  /** The context of the task sheet; `panelCtx` is the one of the project tabs and `sheetCtx` the one of the sheets opened
   *  from the entry screen, each with its own answer sender, so that the view knows where an answer was sent from. */
  private readonly ctx: ViewContext;
  private readonly panelCtx: ViewContext;
  private readonly sheetCtx: ViewContext;
  private entry: EntryData | null = null;
  /** The question of the entry screen last opened: focus goes back to it on the way back. */
  private lastQuestion: string | null = null;
  /** The pending questions of the entry screen unfolded (kept with the place). */
  private questionsOpen: boolean;
  private readonly questions: EntryQuestions;
  private readonly sheets: EntrySheets;
  private readonly projectAnswers: ProjectAnswersHost;
  private project: OpenProject | null = null;
  private selected: string | null = null;
  private expandedSeeded = false;
  private generation = 0;
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
  /** Escape and the browser's Back go up one level (static/work-nav.ts). */
  private readonly levels: LevelHost;
  private readonly onEscape = (event: KeyboardEvent): void => upOnEscape(this.levels, event);
  private readonly onPopState = (event: PopStateEvent): void => wentBack(this.levels, event.state);

  constructor(private readonly options: WorkViewOptions) {
    this.t = options.translate;
    this.api = createWorkApi(options.request);
    this.nav = createWorkNav(options.history ?? browserHistory());
    this.sync = options.sync ?? pageQuestionsSync;
    this.ctx = { t: this.t, locale: options.locale ?? (document.documentElement.lang || undefined),
      nowMs: options.now ?? (() => Date.now()), selectedTask: () => this.selected, selectTask: id => void this.selectTask(id),
      answers: this.sender('detail') };
    this.panelCtx = { ...this.ctx, answers: this.sender('questions') };
    this.sheetCtx = { ...this.ctx, answers: this.sender('sheet'), answerScope: 'sheet-' };
    const refresh = button('btn work-refresh', this.t('work.refresh'), () => void this.reload());
    this.announcer.setAttribute('role', 'status');
    this.announcer.setAttribute('aria-live', 'polite');
    options.root.classList.add('work-root');
    options.root.replaceChildren(el('div', 'work-toolbar', refresh), this.content, this.announcer);
    this.docs = mountDocPanel({ root: options.root, request: options.request, translate: this.t });
    this.memory = createViewMemory({ root: options.root, scroller: () => scrollerOf(options.root), current: scroll => this.placeNow(scroll) });
    const { expanded: unfolded, questionsOpen } = this.memory.place();
    if (unfolded) { unfolded.forEach(id => this.expanded.add(id)); this.expandedSeeded = true; }
    this.questionsOpen = questionsOpen;
    const generation = (): number => this.generation, signal = (): AbortSignal | undefined => this.controller?.signal;
    this.questions = new EntryQuestions({ api: this.api, generation, signal, report: result => this.report(result),
      away: () => !this.active || this.project !== null || this.sheets.place() !== null, render: state => this.entryQuestionsBlock(state) });
    this.sheets = new EntrySheets({ ctx: this.sheetCtx, api: this.api, content: this.content, show: (...nodes) => this.show(...nodes),
      generation, signal, back: () => void this.backToEntry(), memory: this.memory });
    this.projectAnswers = { api: this.api, generation, signal, project: () => this.project, selected: () => this.selected,
      selectTask: (id, after) => this.selectTask(id, after) };
    this.levels = { nav: this.nav, root: options.root, active: () => this.active, inProject: () => this.project !== null,
      closeSheet: () => this.closeSheet(), toEntry: () => void this.backToEntry() };
    this.unsubscribe = this.sync.subscribe('view', change => this.questions.heard(change));
    window.addEventListener('popstate', this.onPopState);
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
    if (!place.project) return this.resumeEntry(place);
    const tab = TAB_KEYS.find(key => key === place.tab) ?? 'reprise';
    if (!(await this.openProject(place.project, tab, true))) return;
    const token = this.generation;
    if (place.task) await this.selectTask(place.task, undefined, true);
    // Unless the owner moved meanwhile (another project, another tab, another sheet) or the task is gone, the scroll
    // comes back.
    if (token === this.generation && place.task === this.selected && this.project?.view.current() === tab) {
      if (place.task !== null) this.tabScroll = place.tabScroll;
      this.scrollTo(place);
    }
    await this.refreshCount();
  }

  /** The entry screen, or the sheet the owner opened from it: a task in no project read again, a question about
   *  nothing found among the open questions. A task gone, or a question answered, since shows the entry screen. */
  private async resumeEntry(place: Place): Promise<void> {
    const sheet = place.sheet;
    if (sheet?.kind === 'task') {
      await this.openTask(sheet.id, 'questions', null, true);
      await this.refreshCount();
    } else if (await this.loadEntry() && sheet) {
      const question = this.questions.question(sheet.id);
      if (question) this.openQuestionSheet(question);
    }
    // Not when the owner moved meanwhile, nor when the sheet left is not the one shown.
    if (this.project === null && this.reading === null && sameSheet(this.sheets.place(), sheet)) this.scrollTo(place);
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
    return { project: project?.id ?? reading?.id ?? null, tab: project?.view.current() ?? reading?.tab ?? null, task,
      sheet: project || reading ? null : this.sheets.place(), ...scroll, tabScroll: task ? this.tabScroll : null,
      expanded: this.expandedSeeded ? [...this.expanded] : null, questionsOpen: this.questionsOpen };
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

  forget = (): void => { this.memory.forget(); this.questionsOpen = false; };

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
    return { available: () => !this.writeUnavailable, submit: (question, answerText) => sendAnswer(this.answerHost(), question, answerText, surface) };
  }

  private stopRequests(): void {
    this.controller?.abort(); this.detailController?.abort();
    this.generation++; this.detailSequence++;
  }

  /** Starts a request series: cancels the previous one and returns the token that tells a stale answer. */
  private begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort(); this.detailController?.abort();
    this.controller = new AbortController();
    this.sheets.clear();
    return { token: ++this.generation, signal: this.controller.signal };
  }

  private show(...nodes: Node[]): void { this.content.replaceChildren(...nodes); }

  private failure(error: WorkError, retry: () => void, back?: () => void): void {
    this.show(errorBlock(this.t, error, { retry, legacy: this.options.onLegacy, ...(back ? { back } : {}) }));
  }

  private async reload(): Promise<void> {
    if (!this.project) { await this.loadEntry(); return; }
    await this.openProject(this.project.id, this.project.view.current());
    await this.refreshCount();
  }

  /** Report the open questions count, or null after a failed read: the badge never shows a number it did not read. */
  private report(result: WorkResult<OpenQuestionsDoc>): void {
    const count = result.ok ? result.value.openQuestions : null;
    this.options.onOpenQuestions?.(count);
    this.sync.publish({ source: 'view', openQuestions: count });   // the marker reads again when the count moved
  }

  /** Read the count again for the badge (Refresh and answers in a project; the entry screen reads it with its list). */
  private async refreshCount(): Promise<void> {
    const token = this.generation;
    const result = await this.api.openQuestions(this.controller?.signal);
    if (token === this.generation) this.report(result);
  }

  /** The products and projects first (the page reads two documents at a time, see work-api.ts), then the open
   *  questions, drawn in place when they arrive. True when the entry screen is still shown then. */
  private async loadEntry(): Promise<boolean> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null; this.reading = null;
    this.nav.at(0);
    this.show(loadingBlock(this.t));
    const reads = [this.api.products(signal), this.api.projects(signal)] as const;
    const questions = this.api.openQuestions(signal);   // waits for a free slot
    const [products, projects] = await Promise.all(reads);
    if (token !== this.generation) return false;
    if (!products.ok) { this.entryFailure(products.error); return false; }
    if (!projects.ok) { this.entryFailure(projects.error); return false; }
    this.entry = { products: products.value, projects: projects.value };
    this.questions.loading();
    this.renderEntryScreen();
    await this.questions.reread(false, questions);
    return token === this.generation;
  }

  /** A missing reader program lets the host show the old view (once); any other failure is shown here with its buttons. */
  private entryFailure(error: WorkError): void {
    if (error.kind === 'not-available' && this.options.onNotAvailable?.()) return;
    this.failure(error, () => void this.loadEntry());
  }

  private renderEntryScreen(): void {
    if (!this.entry) return;
    if (!this.expandedSeeded) seedExpanded(this.expanded, this.entry.products);
    this.expandedSeeded = true;
    const cut = this.entry.products.truncated || this.entry.projects.truncated;
    const handlers = { t: this.t, expanded: this.expanded, openProject: (id: string) => void this.openProject(id) };
    this.show(this.questions.block(), renderEntry(handlers, entryTree(this.entry.products, this.entry.projects)),
      ...(cut ? [el('p', 'work-notice work-omitted', this.t('work.entryTruncated'))] : []));
    this.memory.note();
  }

  /** The entry screen's questions. No answer form here (the operator answers where the context is): no draft. */
  private entryQuestionsBlock(state: EntryQuestionsState): HTMLElement {
    const titles = new Map((this.entry?.projects.projects ?? []).map(project => [project.id, project.title]));
    const zones = (this.entry?.products.categories ?? []).map(category => ({ key: category.key, name: category.name }));
    const from = (question: string): void => { this.lastQuestion = question; };
    return renderEntryQuestions(this.ctx, { zones, projectTitle: id => titles.get(id) ?? null, sectionOpen: this.questionsOpen,
      sectionToggled: open => { this.questionsOpen = open; this.memory.note(); }, showMore: () => void this.questions.more(),
      openProject: (id, question) => { from(question); void this.openProject(id, 'questions'); },
      openTask: (id, question) => { from(question); void this.openTask(id, 'questions', question); },
      openQuestion: question => { from(question.id); this.openQuestionSheet(question); } }, state);
  }

  /** A question about no task or project: its own sheet, one level above the entry screen, where it is answered. */
  private openQuestionSheet(question: Question): void {
    this.begin();
    this.showEntrySheet(() => this.sheets.openQuestion(question));
  }

  /** A sheet opened from the entry screen, one level above it. A project shown before (the view opened on a target)
   *  is gone: Refresh and Escape no longer act on it. */
  private showEntrySheet(open: () => void): void {
    this.project = null; this.selected = null; this.reading = null;
    this.nav.at(1);
    open();
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
    const view = this.project?.view;
    if (!view) return;
    if (this.sheetBack) nameSheetBack(this.t, this.sheetBack, view);
    this.memory.fill(view.panel(key));
    this.memory.note();
  }

  /** From a question of the entry screen (or a terminal reference): read the task to learn its project, then open that
   *  project on its Questions tab (or `tab`) with the task's sheet, at `question` when given. A task outside any project
   *  opens its sheet alone for its questions; from a reference it says so, with the way back. `resuming` (the sheet
   *  the owner left): a task gone since shows the entry screen. */
  private async openTask(id: string, tab: TabKey = 'questions', question: string | null = null, resuming = false): Promise<void> {
    const { token, signal } = this.begin();
    this.show(loadingBlock(this.t));
    const result = await this.api.task(id, signal);
    if (token !== this.generation) return;
    if (!result.ok && resuming && result.error.kind === 'missing') { await this.loadEntry(); return; }
    if (!result.ok) return this.failure(result.error, () => void this.openTask(id, tab, question), () => void this.backToEntry());
    const project = result.value.task.project;
    // A task in no project has no project view: its sheet alone, at `question`.
    if (!project && tab === 'questions') return this.showEntrySheet(() => this.sheets.openTask(result.value, question));
    if (!project) {
      const back = button('btn work-back', this.t('work.back'), () => void this.backToEntry());
      this.show(el('div', 'work-error', el('p', 'work-error-text', this.t('work.references.taskNoProject', { id })), el('div', 'work-actions', back)));
      return focusFirst(back);
    }
    await this.openProject(project, tab);
    if (this.project?.id === project) await this.selectTask(id, question ? { question, focus: true, fresh: true } : undefined);
  }

  /** Back to the entry screen as it was, then its open questions read again (an answer may have closed some). */
  private async backToEntry(): Promise<void> {
    if (!this.entry) { await this.loadEntry(); return; }
    this.stopRequests();
    this.docs.close();
    this.nav.at(0);
    this.controller = new AbortController();   // the project's signal is aborted; the questions read needs a live one
    const from = this.project?.id, question = this.lastQuestion;
    this.project = null; this.selected = null; this.reading = null; this.lastQuestion = null;
    this.sheets.clear();
    this.renderEntryScreen();
    focusFirst(entryFocusTarget(this.content, from, question));
    await this.questions.reread(false);   // the focus stays on that row's way in when the row is still there
  }

  /** What an answer sent from the view needs (static/work-view-answer.ts sends it). */
  private answerHost(): AnswerHost {
    return { api: this.api, t: this.t, generation: () => this.generation, selected: () => this.selected,
      writeUnavailable: () => { this.writeUnavailable = true; },
      recorded: question => {
        this.memory.sent(question);   // its draft is not kept, nor put back by the reads that follow
        this.sync.publish({ source: 'view', answered: question });   // the marker drops it now, wherever the view is
        this.questions.forgetAnswered(question);
      },
      sheetRecorded: question => this.sheets.recorded(question), project: this.projectAnswers,
      refreshCount: () => this.refreshCount(), announce: message => this.announce(message) };
  }

  private announce(message: string): void {
    this.announcer.textContent = '';
    setTimeout(() => { this.announcer.textContent = message; }, 50);   // a new text node, so the same message is read again
  }

  /** `resuming` (the sheet the owner left): a task gone since closes the sheet. False when the task could not be read
   *  (a view moved meanwhile is not a failure); after an answer the sheet then says it is recorded, with "Try again". */
  private async selectTask(id: string, after?: AfterAnswer, resuming = false): Promise<boolean> {
    if (!this.project) return true;
    const view = this.project.view;
    this.selected = id;
    markSelected(view.root, id);
    if (view.detailSlot.hidden) this.tabScroll = scrollerOf(view.root).scrollTop;
    if (!after || after.fresh) view.detailSlot.replaceChildren(this.closeButton(view), loadingBlock(this.t));
    view.showDetail(true);
    this.nav.at(2);
    this.memory.note();
    const token = this.generation, sequence = ++this.detailSequence;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const result = await this.api.task(id, this.detailController.signal);
    if (token !== this.generation || sequence !== this.detailSequence || this.selected !== id) return true;
    if (!result.ok && resuming && result.error.kind === 'missing') { this.closeDetail(view); return true; }
    if (!result.ok && after && !after.fresh) {
      const slot = view.detailSlot;
      recordedButUnread(this.t, slot, after.question, result.error, () => void this.selectTask(id, after), slot.querySelector('.work-detail-close'));
    } else if (!result.ok) {
      view.detailSlot.replaceChildren(this.closeButton(view), errorBlock(this.t, result.error, { retry: () => void this.selectTask(id) }));
    }
    if (!result.ok) return false;
    const body = renderDetail(this.ctx, result.value);
    // The reload after an answer keeps what the owner was typing under the other questions; the drafts kept while
    // away (this sheet's, or one typed in another place) come back too.
    if (after && !after.fresh) restoreDrafts(body, unsentDrafts(view.detailSlot, after.question));
    this.memory.fill(body);
    view.detailSlot.replaceChildren(this.closeButton(view), body);
    if (after && !after.focus) return true;
    const question = after ? body.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(after.question)}"]`) : null;
    focusFirst(question ?? body.querySelector<HTMLElement>('.work-detail-heading'));
    return true;
  }

  /** The sheet's way back: it names the tab it returns to (and, for a screen reader, the project). */
  private closeButton(view: ProjectView): HTMLElement {
    this.sheetBack = button('btn work-detail-close', '', () => this.closeDetail(view));
    nameSheetBack(this.t, this.sheetBack, view);
    return this.sheetBack;
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

  /** Close the task sheet shown over the project's tab (Escape, Back); false when none is shown. */
  private closeSheet(): boolean {
    const view = this.project?.view, shown = view !== undefined && !view.detailSlot.hidden;
    if (shown) this.closeDetail(view);
    return shown;
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
