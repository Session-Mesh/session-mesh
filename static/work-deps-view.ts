// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The "Dependances" tab: the `dependencies` edges ("blocked by") grouped by level, plain DOM, no drawing library.
 * Level 0 waits on nothing; a task sits one level after the deepest task it waits on (a cycle is a group of its own). The state of every target is a word.
 */

import { dependencyLevels } from './work-derive.ts';
import type { DependencyLevel, DependencyNode } from './work-derive.ts';
import { button, el, notice, omittedNote, statusBadge } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { Dependency, ProjectDoc } from './work-types.ts';

function targetLine(ctx: ViewContext, edge: Dependency, titles: ReadonlyMap<string, string | null>): HTMLElement {
  const title = titles.get(edge.to) ?? edge.toTitle;
  return el('li', `work-dep-target work-dep-${edge.state}`, el('span', 'work-dep-id', edge.to),
    title ? el('span', 'work-dep-title', title) : null, el('span', 'work-dep-state', ctx.t(`work.dep.${edge.state}`)),
    edge.toInProject ? null : el('span', 'work-dep-outside', ctx.t('work.dep.outside')));
}

function nodeCard(ctx: ViewContext, node: DependencyNode, titles: ReadonlyMap<string, string | null>): HTMLElement {
  const head = el('span', 'work-card-head', node.status ? statusBadge(ctx.t, node.status) : null,
    el('span', 'work-card-title', node.title ?? node.id), el('span', 'work-dep-id', node.id));
  const item = el('li', 'work-dep-node');
  const control = node.inProject ? button('work-card', '', () => ctx.selectTask(node.id), head) : el('div', 'work-card work-card-static', head);
  if (node.inProject) control.setAttribute('data-task', node.id);
  if (node.inProject && ctx.selectedTask() === node.id) control.setAttribute('aria-current', 'true');
  item.append(control);
  if (node.blockedBy.length > 0) {
    const list = el('ul', 'work-dep-targets');
    list.setAttribute('aria-label', ctx.t('work.dep.blockedBy'));
    for (const edge of node.blockedBy) list.append(targetLine(ctx, edge, titles));
    item.append(el('span', 'work-dep-lead', ctx.t('work.dep.blockedBy')), list);
  }
  return item;
}

function levelHeading(ctx: ViewContext, level: DependencyLevel): string {
  if (level.cycle) return ctx.t('work.dep.cycle');
  return level.level === 0 ? ctx.t('work.dep.level0') : ctx.t('work.dep.level', { n: level.level, prev: level.level - 1 });
}

function levelSection(ctx: ViewContext, level: DependencyLevel, titles: ReadonlyMap<string, string | null>): HTMLElement {
  const root = el('section', 'work-section work-dep-level');
  root.append(el('h3', 'work-section-title', levelHeading(ctx, level),
    el('span', 'work-count', String(level.nodes.length))));
  const list = el('ul', 'work-dep-list');
  for (const node of level.nodes) list.append(nodeCard(ctx, node, titles));
  root.append(list);
  return root;
}

export function renderDependencies(ctx: ViewContext, doc: ProjectDoc): HTMLElement {
  if (doc.dependencies.length === 0) return notice('work-empty', ctx.t('work.dep.empty'));
  const root = el('div', 'work-deps');
  const titles = new Map(doc.tasks.map(task => [task.id, task.title] as const));
  for (const level of dependencyLevels(doc.dependencies, doc.tasks)) root.append(levelSection(ctx, level, titles));
  root.append(omittedNote(ctx.t, doc.omitted.dependencies));
  return root;
}
