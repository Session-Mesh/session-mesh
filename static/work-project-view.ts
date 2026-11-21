// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The project view: header, the five tabs (Reprise, Tableau, Frise, Dependances, Questions) and the detail pane slot. */

import { renderBoard } from './work-board-view.ts';
import { renderDependencies } from './work-deps-view.ts';
import { button, el, notice, progressBlock, setAttributes } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { renderFrise } from './work-frise-view.ts';
import { renderQuestionsTab } from './work-questions-view.ts';
import { renderReprise } from './work-reprise-view.ts';
import type { ProjectDoc, ProjectHead } from './work-types.ts';

export const TAB_KEYS = ['reprise', 'board', 'frise', 'deps', 'questions'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

const RENDERERS: Readonly<Record<TabKey, (ctx: ViewContext, doc: ProjectDoc) => HTMLElement>> = {
  reprise: renderReprise, board: renderBoard, frise: renderFrise, deps: renderDependencies, questions: renderQuestionsTab,
};

/** A view a task sheet opens over (static/work-task-sheet.ts): a project's, or a product's (static/work-product-page.ts). */
export type SheetView = Readonly<{
  root: HTMLElement;
  /** The project's (or product's) title, as the header shows it. */
  title: string;
  detailSlot: HTMLElement;
  showDetail: (open: boolean) => void;
  /** The tab shown, and its panel. */
  current: () => string;
  currentPanel: () => HTMLElement;
}>;

export type ProjectView = Omit<SheetView, 'current'> & Readonly<{
  activate: (key: TabKey, focus: boolean) => void;
  current: () => TabKey;
  /** The panel of a tab (built or not). */
  panel: (key: TabKey) => HTMLElement;
  /** Show a project document read again: the current panel and a Questions panel already built are rebuilt now, the
   *  others when next shown. The header and the detail pane are kept. */
  replaceDoc: (next: ProjectDoc) => void;
}>;

/** The task sheet's way back names the tab it returns to (and, for a screen reader, the project). */
export function nameSheetBack(t: Translate, back: HTMLElement, view: SheetView): void {
  const tab = t(`work.tab.${view.current()}`);
  back.textContent = t('work.detail.back', { tab });
  back.setAttribute('aria-label', t('work.detail.backLabel', { tab, project: view.title }));
}

function header(ctx: ViewContext, head: ProjectHead, back: () => void): HTMLElement {
  const counts = { open: head.openTasks, done: head.doneTasks, blockedTasks: head.blockedTasks, dependencyOpenTasks: head.dependencyOpenTasks,
    blockers: head.blockers, progress: head.progress };
  const crumb = el('h2', 'work-crumb', el('span', 'work-crumb-product', head.product), ' / ', el('span', 'work-crumb-title', head.title),
    head.quarter ? el('span', 'work-crumb-quarter', head.quarter) : null);
  const waiting = head.dependencyOpenTasks > 0 ? el('span', 'work-mute', ctx.t('work.dependencyOpen', { n: head.dependencyOpenTasks })) : null;
  return el('header', 'work-project-head', button('btn work-back', ctx.t('work.back'), back), crumb, progressBlock(ctx.t, counts), waiting);
}

export function tabButton(ctx: ViewContext, key: string): HTMLButtonElement {
  const tab = el('button', 'work-tab', ctx.t(`work.tab.${key}`));
  tab.type = 'button';
  setAttributes(tab, { role: 'tab', id: `work-tab-${key}`, 'aria-controls': `work-panel-${key}`, 'aria-selected': 'false', tabindex: '-1' });
  return tab;
}

export function panelFor(key: string): HTMLElement {
  const panel = el('div', 'work-panel');
  setAttributes(panel, { role: 'tabpanel', id: `work-panel-${key}`, 'aria-labelledby': `work-tab-${key}`, tabindex: '0' });
  panel.hidden = true;
  return panel;
}

/** The tab an arrow key, Home or End moves to from `key` among `keys`, or null for another key. */
export function nextTab<K extends string>(keys: readonly K[], key: K, event: KeyboardEvent): K | null {
  const index = keys.indexOf(key);
  const last = keys.length - 1;
  if (event.key === 'ArrowRight') return keys[index === last ? 0 : index + 1] ?? null;
  if (event.key === 'ArrowLeft') return keys[index === 0 ? last : index - 1] ?? null;
  if (event.key === 'Home') return keys[0] ?? null;
  if (event.key === 'End') return keys[last] ?? null;
  return null;
}

/** The context of a panel: the Questions tab gets its own prefix of answer form ids (the sheet may show the same question). */
const panelContext = (ctx: ViewContext, key: TabKey): ViewContext => (key === 'questions' ? { ...ctx, answerScope: 'tab-' } : ctx);

/** `onTab` hears each tab shown, the first one included (the sheet's way back names the tab it returns to). */
export function renderProject(ctx: ViewContext, initialDoc: ProjectDoc, initial: TabKey, back: () => void,
  onTab?: (key: TabKey) => void): ProjectView {
  let doc = initialDoc;
  const root = el('div', 'work-project');
  const tabs = el('div', 'work-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', ctx.t('work.tabsLabel'));
  const buttons = new Map<TabKey, HTMLButtonElement>(), panels = new Map<TabKey, HTMLElement>(), built = new Set<TabKey>();
  for (const key of TAB_KEYS) { buttons.set(key, tabButton(ctx, key)); panels.set(key, panelFor(key)); }
  let currentKey: TabKey = initial;
  const build = (key: TabKey): void => { panels.get(key)!.replaceChildren(RENDERERS[key](panelContext(ctx, key), doc)); built.add(key); };
  const activate = (key: TabKey, focus: boolean): void => {
    currentKey = key;
    for (const [name, node] of buttons) {
      const selected = name === key;
      node.setAttribute('aria-selected', String(selected));
      node.tabIndex = selected ? 0 : -1;
      panels.get(name)!.hidden = !selected;
    }
    if (!built.has(key)) build(key);
    if (focus) buttons.get(key)!.focus();
    onTab?.(key);
  };
  for (const [key, node] of buttons) {
    node.addEventListener('click', () => activate(key, false));
    node.addEventListener('keydown', event => {
      const target = nextTab(TAB_KEYS, key, event);
      if (target) { event.preventDefault(); activate(target, true); }
    });
    tabs.append(node);
  }
  const main = el('div', 'work-main', tabs, ...panels.values());
  const detailSlot = el('aside', 'work-detail-pane');
  detailSlot.hidden = true;
  detailSlot.setAttribute('aria-label', ctx.t('work.detail.label'));
  const split = el('div', 'work-split', main, detailSlot);
  root.append(header(ctx, doc.project, back));
  if (doc.truncated) root.append(notice('work-omitted', ctx.t('work.projectTruncated')));
  root.append(split);
  activate(initial, false);
  const title = doc.project.title;
  const replaceDoc = (next: ProjectDoc): void => {
    doc = next;
    // The Questions panel holds the owner's unsent answers: once built it is rebuilt now, even when hidden, so that
    // the caller can put them back.
    const keepQuestions = built.has('questions') && currentKey !== 'questions';
    built.clear();
    for (const [key, panel] of panels) if (key !== currentKey) panel.replaceChildren();
    if (keepQuestions) build('questions');
    activate(currentKey, false);
  };
  return { root, title, detailSlot, current: () => currentKey, currentPanel: () => panels.get(currentKey)!, activate, replaceDoc,
    panel: key => panels.get(key)!,
    showDetail: open => { detailSlot.hidden = !open; split.classList.toggle('detail-open', open); } };
}
