// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The project view: header, the four tabs (Reprise, Tableau, Frise, Dependances) and the detail pane slot. */

import { renderBoard } from './work-board-view.ts';
import { renderDependencies } from './work-deps-view.ts';
import { button, el, notice, progressBlock, setAttributes } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { renderFrise } from './work-frise-view.ts';
import { renderReprise } from './work-reprise-view.ts';
import type { ProjectDoc, ProjectHead } from './work-types.ts';

export const TAB_KEYS = ['reprise', 'board', 'frise', 'deps'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

const RENDERERS: Readonly<Record<TabKey, (ctx: ViewContext, doc: ProjectDoc) => HTMLElement>> = {
  reprise: renderReprise, board: renderBoard, frise: renderFrise, deps: renderDependencies,
};

export type ProjectView = Readonly<{
  root: HTMLElement;
  detailSlot: HTMLElement;
  showDetail: (open: boolean) => void;
  activate: (key: TabKey, focus: boolean) => void;
  current: () => TabKey;
}>;

function header(ctx: ViewContext, head: ProjectHead, back: () => void): HTMLElement {
  const counts = { open: head.openTasks, done: head.doneTasks, blockedTasks: head.blockedTasks, dependencyOpenTasks: head.dependencyOpenTasks,
    blockers: head.blockers, progress: head.progress };
  const crumb = el('h2', 'work-crumb', el('span', 'work-crumb-product', head.product), ' / ', el('span', 'work-crumb-title', head.title),
    head.quarter ? el('span', 'work-crumb-quarter', head.quarter) : null);
  const waiting = head.dependencyOpenTasks > 0 ? el('span', 'work-mute', ctx.t('work.dependencyOpen', { n: head.dependencyOpenTasks })) : null;
  return el('header', 'work-project-head', button('btn work-back', ctx.t('work.back'), back), crumb, progressBlock(ctx.t, counts), waiting);
}

function tabButton(ctx: ViewContext, key: TabKey): HTMLButtonElement {
  const tab = el('button', 'work-tab', ctx.t(`work.tab.${key}`));
  tab.type = 'button';
  setAttributes(tab, { role: 'tab', id: `work-tab-${key}`, 'aria-controls': `work-panel-${key}`, 'aria-selected': 'false', tabindex: '-1' });
  return tab;
}

function panelFor(key: TabKey): HTMLElement {
  const panel = el('div', 'work-panel');
  setAttributes(panel, { role: 'tabpanel', id: `work-panel-${key}`, 'aria-labelledby': `work-tab-${key}`, tabindex: '0' });
  panel.hidden = true;
  return panel;
}

function nextTab(key: TabKey, event: KeyboardEvent): TabKey | null {
  const index = TAB_KEYS.indexOf(key);
  const last = TAB_KEYS.length - 1;
  if (event.key === 'ArrowRight') return TAB_KEYS[index === last ? 0 : index + 1] ?? null;
  if (event.key === 'ArrowLeft') return TAB_KEYS[index === 0 ? last : index - 1] ?? null;
  if (event.key === 'Home') return TAB_KEYS[0];
  if (event.key === 'End') return TAB_KEYS[last] ?? null;
  return null;
}

export function renderProject(ctx: ViewContext, doc: ProjectDoc, initial: TabKey, back: () => void): ProjectView {
  const root = el('div', 'work-project');
  const tabs = el('div', 'work-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', ctx.t('work.tabsLabel'));
  const buttons = new Map<TabKey, HTMLButtonElement>(), panels = new Map<TabKey, HTMLElement>(), built = new Set<TabKey>();
  for (const key of TAB_KEYS) { buttons.set(key, tabButton(ctx, key)); panels.set(key, panelFor(key)); }
  let currentKey: TabKey = initial;
  const activate = (key: TabKey, focus: boolean): void => {
    currentKey = key;
    for (const [name, node] of buttons) {
      const selected = name === key;
      node.setAttribute('aria-selected', String(selected));
      node.tabIndex = selected ? 0 : -1;
      panels.get(name)!.hidden = !selected;
    }
    if (!built.has(key)) { panels.get(key)!.replaceChildren(RENDERERS[key](ctx, doc)); built.add(key); }
    if (focus) buttons.get(key)!.focus();
  };
  for (const [key, node] of buttons) {
    node.addEventListener('click', () => activate(key, false));
    node.addEventListener('keydown', event => {
      const target = nextTab(key, event);
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
  return { root, detailSlot, current: () => currentKey, activate,
    showDetail: open => { detailSlot.hidden = !open; split.classList.toggle('detail-open', open); } };
}
