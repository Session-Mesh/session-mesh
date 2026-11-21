// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Projects view: the open questions and an overview of the products, a product view, a project view with five tabs
 * and a task detail pane, all read through POST /api/work/v1, and the tree of zones, products and projects in the left
 * rail (static/work-tree-view.ts) that leads to them. Entry point of the built bundle (static/work-view.js). It owns the
 * content of one root element and of the rail element and nothing else of the page; the old workspace is not touched.
 * The entry screen's questions are read by static/work-entry-questions.ts, the sheets they open without a project by
 * static/work-entry-sheets.ts.
 */

import type { AnswerSender } from './work-answer-form.ts';
import { createWorkApi } from './work-api.ts';
import type { WorkApi, WorkError, WorkResult } from './work-api.ts';
import { entryTree } from './work-derive.ts';
import { mountDocPanel } from './work-doc-panel.ts';
import type { DocPanel } from './work-doc-panel.ts';
import { button, el, focusFirst } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { EntryQuestions } from './work-entry-questions.ts';
import { EntrySheets } from './work-entry-sheets.ts';
import { entryFocusTarget, renderOverview, renderProductView } from './work-entry-view.ts';
import type { EntryHandlers } from './work-entry-view.ts';
import { loadOperatorName } from './work-operator-label.ts';
import { errorBlock, loadingBlock } from './work-error-view.ts';
import { browserHistory, createWorkNav, scrollerOf, upOnEscape, wentBack } from './work-nav.ts';
import type { LevelHost, WorkNav } from './work-nav.ts';
import type { ProjectAnswersHost } from './work-project-answers.ts';
import { TAB_KEYS, renderProject } from './work-project-view.ts';
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
import { readOpenQuestions } from './work-questions.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import type { WorkTarget } from './work-session-questions.ts';
import { TaskSheet } from './work-task-sheet.ts';
import { ENTRY_KEY, findProduct, topProduct, treeKey } from './work-tree.ts';
import { WorkRail } from './work-tree-view.ts';
import type { RailChoice } from './work-tree-view.ts';
import type { OpenQuestionsDoc, ProductsDoc, ProjectsDoc, Question } from './work-types.ts';

export type { WorkViewController, WorkViewOptions } from './work-view-options.ts';

type EntryData = Readonly<{ products: ProductsDoc; projects: ProjectsDoc }>;
type OpenProject = Readonly<{ id: string; view: ProjectView }>;

class WorkView implements WorkViewController {
  private readonly api: WorkApi;
  private readonly t: Translate;
  private readonly content = el('div', 'work-content');
  /** The tree of the left rail (static/work-tree-view.ts). */
  private readonly rail: WorkRail;
  /** The product whose view is shown (no project, no sheet). */
  private product: string | null = null;
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
  /** The task sheet over the project's tab (static/work-task-sheet.ts): it holds the selected task. */
  private readonly sheet: TaskSheet;
  private get selected(): string | null { return this.sheet.selected; }
  private set selected(id: string | null) { this.sheet.selected = id; }
  private generation = 0;
  private controller: AbortController | null = null;
  /** The read of the rail's documents under way (readRail). */
  private railRead: AbortController | null = null;
  private writeUnavailable = false;
  private readonly announcer = el('p', 'sr-only work-announcer');
  /** The document panel of the references in tracker text (static/work-doc-panel.ts). */
  private readonly docs: DocPanel;
  /** Between `open` and `close`: Escape and the browser's Back act on the view only then. */
  private active = false;
  private readonly nav: WorkNav;
  private readonly sync: QuestionsSync;
  private readonly unsubscribe: () => void;
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
      nowMs: options.now ?? (() => Date.now()), selectedTask: () => this.selected, selectTask: id => void this.sheet.select(id),
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
    const { rail, questionsOpen } = this.memory.place();
    this.rail = new WorkRail({ root: options.rail ?? el('div', ''), t: this.t, open: rail, folded: () => this.memory.note(),
      choose: choice => this.chosen(choice) });
    this.questionsOpen = questionsOpen;
    this.sheet = new TaskSheet({ api: this.api, t: this.t, ctx: this.ctx, nav: this.nav, memory: this.memory,
      generation: () => this.generation, view: () => this.project?.view ?? null });
    const generation = (): number => this.generation, signal = (): AbortSignal | undefined => this.controller?.signal;
    this.questions = new EntryQuestions({ api: this.api, generation, signal, report: result => this.report(result),
      away: () => !this.active || this.project !== null || this.product !== null || this.sheets.place() !== null,
      render: state => this.entryQuestionsBlock(state) });
    this.sheets = new EntrySheets({ ctx: this.sheetCtx, api: this.api, content: this.content, show: (...nodes) => this.show(...nodes),
      generation, signal, back: () => void this.backToEntry(), memory: this.memory });
    this.projectAnswers = { api: this.api, generation, signal, project: () => this.project, selected: () => this.selected,
      selectTask: (id, after) => this.sheet.select(id, after), fillDrafts: (scope, read) => this.memory.fill(scope, read) };
    this.levels = { nav: this.nav, root: options.root, rail: options.rail, active: () => this.active, inProject: () => this.project !== null || this.product !== null,
      closeSheet: () => this.sheet.closeShown(), toEntry: () => void this.backToEntry() };
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
    if (this.active && opening === this.openings && !this.rail.hasEntry()) await this.readRail();
  }

  /** The products and projects for the rail, when the view opened on a project without the entry screen. A read the
   *  view no longer waits for (it closed, or a newer read started) is dropped, and the entry screen may read them first. */
  private async readRail(): Promise<void> {
    this.railRead?.abort();
    const read = this.railRead = new AbortController();
    const [products, projects] = await Promise.all([this.api.products(read.signal), this.api.projects(read.signal)]);
    if (read !== this.railRead || read.signal.aborted || !products.ok || !projects.ok || this.rail.hasEntry()) return;
    this.entry = { products: products.value, projects: projects.value };
    this.rail.entry(products.value, projects.value);
  }

  /** The owner chose an item of the rail: a step like the same choice in the main area. On a phone the drawer closes. */
  private chosen(choice: RailChoice): void {
    // The drawer of a phone closed over the rail: the focus goes to the main area (focusMain).
    if (this.options.onRailChoice?.() && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (choice.kind === 'entry') void this.backToEntry();
    else if (choice.kind === 'product') this.openProduct(choice.id);
    else void this.openProject(choice.id);
  }

  /** Back to where the owner left the view: the project and its tab read again, then the sheet, the scroll and the
   *  drafts put back. A project gone since shows the entry screen, a task gone since its tab. */
  private async resume(): Promise<void> {
    const place = this.memory.place();
    if (!place.project) return this.resumeEntry(place);
    const tab = TAB_KEYS.find(key => key === place.tab) ?? 'reprise';
    if (!(await this.openProject(place.project, tab, true))) return;
    const token = this.generation;
    if (place.task) await this.sheet.select(place.task, undefined, true);
    // Unless the owner moved meanwhile (another project, another tab, another sheet) or the task is gone, the scroll
    // comes back.
    if (token === this.generation && place.task === this.selected && this.project?.view.current() === tab) {
      if (place.task !== null) this.sheet.tabScroll = place.tabScroll;
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
    } else if (await this.loadEntry()) {
      const question = sheet ? this.questions.question(sheet.id) : null;
      if (question) this.openQuestionSheet(question);
      else if (place.product && !sheet) this.openProduct(place.product);
    }
    // Not when the owner moved meanwhile, nor when the sheet or product left is not the one shown.
    if (this.project === null && this.reading === null && this.product === place.product && sameSheet(this.sheets.place(), sheet)) {
      this.scrollTo(place);
    }
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
    return { project: project?.id ?? reading?.id ?? null, product: project || reading ? null : this.product,
      tab: project?.view.current() ?? reading?.tab ?? null, task, sheet: project || reading ? null : this.sheets.place(), ...scroll,
      tabScroll: task ? this.sheet.tabScroll : null, rail: this.rail.openKeys(), questionsOpen: this.questionsOpen };
  }

  /** Leaving the view takes back its entries of the browser history; the place and the drafts stay in memory. */
  close = (): void => {
    this.memory.listen(false);
    this.stopRequests();
    this.railRead?.abort();
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
    return { available: () => !this.writeUnavailable, submit: (question, answerText, extra) =>
      sendAnswer(this.answerHost(), question, answerText, surface, extra) };
  }

  private stopRequests(): void {
    this.controller?.abort(); this.sheet.stop();
    this.generation++;
  }

  /** Starts a request series: cancels the previous one and returns the token that tells a stale answer. */
  private begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort(); this.sheet.stop();
    this.controller = new AbortController();
    this.sheets.clear();
    return { token: ++this.generation, signal: this.controller.signal };
  }

  private show(...nodes: Node[]): void { this.content.replaceChildren(...nodes); }

  private failure(error: WorkError, retry: () => void, back?: () => void): void {
    this.show(errorBlock(this.t, error, { retry, legacy: this.options.onLegacy, ...(back ? { back } : {}) }));
  }

  private async reload(): Promise<void> {
    const product = this.product;
    if (!this.project) { if (await this.loadEntry() && product) this.openProduct(product); return; }
    await this.openProject(this.project.id, this.project.view.current());
    await this.refreshCount();
  }

  /** Report the open questions count, or null after a failed read: the badge never shows a number it did not read. */
  private report(result: WorkResult<OpenQuestionsDoc>): void {
    const count = result.ok ? result.value.openQuestions : null;
    this.options.onOpenQuestions?.(count);
    this.sync.publish({ source: 'view', openQuestions: count });   // the marker reads again when the count moved
  }

  /** Read the count again for the badge (Refresh and answers in a project; the entry screen reads it with its list),
   *  with as many questions as the entry screen shows ("Show more" pages included), for the counts of the rail. */
  private async refreshCount(): Promise<void> {
    const token = this.generation, signal = this.controller?.signal;
    const result = await readOpenQuestions(page => this.api.openQuestions(signal, page), this.questions.shownCount());
    if (token !== this.generation) return;
    this.report(result);
    if (result.ok) this.rail.questions(result.value.questions);
  }

  /** The products and projects first (the page reads two documents at a time, see work-api.ts), then the open
   *  questions, drawn in place when they arrive. True when the entry screen is still shown then. */
  private async loadEntry(): Promise<boolean> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null; this.reading = null; this.product = null;
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
    const cut = this.entry.products.truncated || this.entry.projects.truncated;
    this.rail.entry(this.entry.products, this.entry.projects);
    this.rail.select(ENTRY_KEY);
    this.show(this.questions.block(), renderOverview(this.entryHandlers(), entryTree(this.entry.products, this.entry.projects)),
      ...(cut ? [el('p', 'work-notice work-omitted', this.t('work.entryTruncated'))] : []));
    this.memory.note();
  }

  private entryHandlers(): EntryHandlers {
    return { t: this.t, openProduct: id => this.openProduct(id), openProject: id => void this.openProject(id) };
  }

  /** A product's view, one level above the entry screen (like a project); a product gone shows the entry screen. */
  private openProduct(id: string): void {
    const node = this.entry ? findProduct(entryTree(this.entry.products, this.entry.projects), id) : null;
    if (!node) { void this.backToEntry(); return; }
    this.begin();
    this.docs.close();
    this.project = null; this.selected = null; this.reading = null; this.product = id;
    this.nav.at(1);
    const view = renderProductView({ ...this.entryHandlers(), back: () => void this.backToEntry() }, node);
    this.show(view);
    this.rail.select(treeKey('product', id));
    this.focusMain(view.querySelector<HTMLElement>('.work-back'));
    this.memory.note();
  }

  /** Focus a control of the main area, unless the owner moves in the rail: the focus stays on its item. */
  private focusMain(node: HTMLElement | null): void {
    if (!this.options.rail?.contains(document.activeElement)) focusFirst(node);
  }

  /** The entry screen's questions. No answer form here (the operator answers where the context is): no draft. */
  private entryQuestionsBlock(state: EntryQuestionsState): HTMLElement {
    const titles = new Map((this.entry?.projects.projects ?? []).map(project => [project.id, project.title]));
    const zones = (this.entry?.products.categories ?? []).map(category => ({ key: category.key, name: category.name }));
    const from = (question: string): void => { this.lastQuestion = question; };
    if (state.kind === 'ready' || state.kind === 'stale') this.rail.questions(state.doc.questions);   // the rail counts these
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
    this.project = null; this.selected = null; this.reading = null; this.product = null;
    this.nav.at(1);
    this.rail.select(null);
    open();
  }

  /** True when the project is shown. `resuming` (the place the owner left): a project gone since shows the entry screen. */
  private async openProject(id: string, tab: TabKey = 'reprise', resuming = false): Promise<boolean> {
    const { token, signal } = this.begin();
    this.project = null; this.selected = null; this.product = null;   // the view shown before is gone: Escape now goes to the entry screen
    this.reading = { id, tab };   // the place while it is read: a reload meanwhile comes back to it
    this.nav.at(1);
    this.rail.select(treeKey('project', id));
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
    this.focusMain(view.root.querySelector<HTMLElement>('.work-back'));
    this.memory.note();
    return true;
  }

  /** A tab shown: the sheet's way back names it, a panel just built gets the drafts back, and the place is noted. */
  private tabShown(key: TabKey): void {
    const view = this.project?.view;
    if (!view) return;
    this.sheet.tabShown(view);
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
    if (this.project?.id === project) await this.sheet.select(id, question ? { question, focus: true, fresh: true } : undefined);
  }

  /** Back to the entry screen as it was, then its open questions read again (an answer may have closed some). */
  private async backToEntry(): Promise<void> {
    if (!this.entry) { await this.loadEntry(); return; }
    this.stopRequests();
    this.docs.close();
    this.nav.at(0);
    this.controller = new AbortController();   // the project's signal is aborted; the questions read needs a live one
    const project = this.project?.id, question = this.lastQuestion;
    const from = this.product ?? this.entry.projects.projects.find(summary => summary.id === project)?.product ?? null;
    this.project = null; this.selected = null; this.reading = null; this.lastQuestion = null; this.product = null;
    this.sheets.clear();
    this.renderEntryScreen();
    // The row of the overview holding the place left; a project of no listed product has its group in the rail only.
    const top = from === null ? null : topProduct(entryTree(this.entry.products, this.entry.projects), from);
    const orphan = from !== null && top === null ? this.rail.shownItem(treeKey('zone', '')) : null;
    this.focusMain(entryFocusTarget(this.content, top, question, orphan));
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
