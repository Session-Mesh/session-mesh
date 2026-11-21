// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The main area of the Projects view away from a project: the overview of the entry screen (each zone with its
 * products and their progress) and the view of one product (its projects, its "no project" line and its child
 * products). The tree of the left rail (static/work-tree-view.ts) leads to the same places.
 */

import type { EntryCategory, EntryProduct } from './work-derive.ts';
import { button, el, progressBlock } from './work-dom.ts';
import type { Translate } from './work-dom.ts';
import type { ProjectSummary } from './work-types.ts';

export type EntryHandlers = Readonly<{
  t: Translate;
  openProduct: (id: string) => void;
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

/** A product as a row that opens its view. */
function productRow(handlers: EntryHandlers, node: EntryProduct): HTMLElement {
  const row = button('work-overview-product', '', () => handlers.openProduct(node.product.id),
    el('span', 'work-entry-name', node.product.id), progressBlock(handlers.t, node.product.tree));
  row.setAttribute('data-product', node.product.id);
  return row;
}

/** The overview of the entry screen: each zone with its products (a child product is reached from its parent's view). */
export function renderOverview(handlers: EntryHandlers, tree: readonly EntryCategory[]): HTMLElement {
  const root = el('div', 'work-entry');
  for (const category of tree) {
    if (category.products.length === 0) continue;
    const section = el('section', 'work-entry-category');
    section.setAttribute('aria-label', category.name || category.key);
    const list = el('div', 'work-entry-product', ...category.products.map(node => productRow(handlers, node)));
    section.append(el('h2', 'work-entry-category-name', category.name || category.key), list);
    root.append(section);
  }
  if (!root.firstChild) root.append(el('p', 'work-entry-empty', handlers.t('work.noProducts')));
  return root;
}

/** The view of one product: the way back, its name and progress, its projects, its "no project" line, its children. */
export function renderProductView(handlers: EntryHandlers & Readonly<{ back: () => void }>, node: EntryProduct): HTMLElement {
  const body = el('div', 'work-entry-product');
  for (const project of node.projects) body.append(projectRow(handlers, project));
  const other = noProjectRow(handlers.t, node);
  if (other) body.append(other);
  for (const child of node.children) body.append(productRow(handlers, child));
  if (body.childElementCount === 0) body.append(el('p', 'work-entry-empty', handlers.t('work.noProjectsHere')));
  const heading = el('h2', 'work-product-title', el('span', 'work-entry-name', node.product.id), progressBlock(handlers.t, node.product.tree));
  const root = el('div', 'work-product-view', el('div', 'work-actions', button('btn work-back', handlers.t('work.back'), handlers.back)), heading, body);
  root.setAttribute('data-product', node.product.id);
  return root;
}

/** Where focus goes when a product, a project or a sheet is left for the entry screen drawn in `scope`: the question
 *  row that opened it (when its list is unfolded), the row of that product, else the first product. */
export function entryFocusTarget(scope: HTMLElement, productId: string | null, question: string | null): HTMLElement | null {
  const opener = question ? scope.querySelector<HTMLElement>(`.work-qrow[data-question-id="${CSS.escape(question)}"] .work-qrow-open`) : null;
  if (opener && !opener.closest('[hidden]')) return opener;
  const row = productId ? scope.querySelector<HTMLElement>(`.work-overview-product[data-product="${CSS.escape(productId)}"]`) : null;
  if (row) return row;
  return scope.querySelector<HTMLElement>('.work-overview-product') ?? scope.querySelector<HTMLElement>('.work-entry-category-name');
}
