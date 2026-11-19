// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The entry list: products (expandable), each with its active projects and a "no project" line. */

import type { EntryCategory, EntryProduct } from './work-derive.ts';
import { button, el, progressBlock, setAttributes } from './work-dom.ts';
import type { Translate } from './work-dom.ts';
import type { ProjectSummary } from './work-types.ts';

export type EntryHandlers = Readonly<{
  t: Translate;
  expanded: Set<string>;
  openProject: (id: string) => void;
}>;

function projectRow(handlers: EntryHandlers, project: ProjectSummary): HTMLElement {
  const known = ['active', 'done', 'dropped'].includes(project.status);
  const detail = [project.quarter, known ? handlers.t(`work.projectStatus.${project.status}`) : project.status]
    .filter((part): part is string => !!part).join(' · ');
  const row = button('work-entry-project', '', () => handlers.openProject(project.id),
    el('span', 'work-entry-name', project.title), el('span', 'work-entry-sub', detail), progressBlock(handlers.t, project.counts));
  row.setAttribute('data-project', project.id);
  return row;
}

function noProjectRow(t: Translate, node: EntryProduct): HTMLElement | null {
  const open = node.noProject?.counts.open ?? node.product.noProjectOpen;
  if (open === 0) return null;
  return el('p', 'work-entry-noproject', el('span', 'work-entry-name', t('work.noProject')), el('span', 'work-entry-sub', t('work.openTasks', { n: open })));
}

function productBody(handlers: EntryHandlers, node: EntryProduct, depth: number): HTMLElement {
  const body = el('div', 'work-entry-body');
  body.id = `work-product-${depth}-${node.product.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  for (const project of node.projects) body.append(projectRow(handlers, project));
  const other = noProjectRow(handlers.t, node);
  if (other) body.append(other);
  if (node.projects.length === 0 && !other && node.children.length === 0) body.append(el('p', 'work-entry-empty', handlers.t('work.noProjectsHere')));
  for (const child of node.children) body.append(productBlock(handlers, child, depth + 1));
  return body;
}

function productBlock(handlers: EntryHandlers, node: EntryProduct, depth: number): HTMLElement {
  const block = el('div', 'work-entry-product');
  const body = productBody(handlers, node, depth);
  const open = handlers.expanded.has(node.product.id);
  const toggle = button('work-entry-toggle', '', () => {
    const now = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(now));
    body.hidden = !now;
    if (now) handlers.expanded.add(node.product.id); else handlers.expanded.delete(node.product.id);
  }, el('span', 'work-chev'), el('span', 'work-entry-name', node.product.id), progressBlock(handlers.t, node.product.tree));
  setAttributes(toggle, { 'aria-expanded': String(open), 'aria-controls': body.id });
  body.hidden = !open;
  block.append(toggle, body);
  return block;
}

export function renderEntry(handlers: EntryHandlers, tree: readonly EntryCategory[]): HTMLElement {
  const root = el('div', 'work-entry');
  for (const category of tree) {
    if (category.products.length === 0) continue;
    const section = el('section', 'work-entry-category');
    const heading = el('h2', 'work-entry-category-name', category.name || category.key);
    section.append(heading);
    section.setAttribute('aria-label', category.name || category.key);
    for (const node of category.products) section.append(productBlock(handlers, node, 0));
    root.append(section);
  }
  if (!root.firstChild) root.append(el('p', 'work-entry-empty', handlers.t('work.noProducts')));
  return root;
}
