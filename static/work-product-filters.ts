// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The filters of a product's Board and Timeline (pure, no DOM): project, status, priority, owner and tag, each a set
 * of values (empty: no filter), and a text searched in the id and title. A task passes when it matches every filter
 * set. Also the choices each filter offers, the columns and counters of the board, and the tasks grouped by project
 * for the timeline. The values come from the browser's storage or from tracker text: they are read without ever
 * throwing, bounded in number and length.
 */

import { STATUSES } from './work-derive.ts';
import type { ProductDoc } from './work-product-parse.ts';
import type { ColumnKey, TaskRow } from './work-types.ts';

export const FILTER_KEYS = ['projects', 'statuses', 'priorities', 'owners', 'tags'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Readonly<Record<FilterKey, readonly string[]> & { text: string }>;

/** The value of the project filter for the tasks in no project. */
export const NO_PROJECT = '';
export const MAX_FILTER_VALUES = 50;
export const MAX_FILTER_VALUE_CHARS = 100;
export const MAX_FILTER_TEXT = 200;

export const EMPTY_FILTERS: Filters = Object.freeze({ projects: [], statuses: [], priorities: [], owners: [], tags: [], text: '' });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** No control, bidirectional or invisible character: such a value was not chosen in the view. */
const PLAIN = /^[^\p{Cc}\p{Cf}]*$/u;
const plainValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_FILTER_VALUE_CHARS && PLAIN.test(value);

function values(value: unknown, key: FilterKey): string[] {
  if (!Array.isArray(value)) return [];
  const known = key === 'statuses' ? (item: string) => (STATUSES as readonly string[]).includes(item)
    : key === 'projects' ? () => true : (item: string) => item !== '';
  return [...new Set(value.filter(plainValue).filter(known))].slice(0, MAX_FILTER_VALUES);
}

/** The filters a stored value holds; the empty filters for anything else. Never throws. */
export function readFilters(value: unknown): Filters {
  if (!isRecord(value)) return EMPTY_FILTERS;
  const text = typeof value.text === 'string' && PLAIN.test(value.text) ? value.text.slice(0, MAX_FILTER_TEXT) : '';
  return { projects: values(value.projects, 'projects'), statuses: values(value.statuses, 'statuses'),
    priorities: values(value.priorities, 'priorities'), owners: values(value.owners, 'owners'), tags: values(value.tags, 'tags'), text };
}

export const filtersActive = (filters: Filters): boolean =>
  filters.text.trim() !== '' || FILTER_KEYS.some(key => filters[key].length > 0);

/** The value of filter `key` for a task (several for its tags). */
function taskValues(doc: ProductDoc, task: TaskRow, key: FilterKey): readonly string[] {
  if (key === 'projects') return [task.project ?? NO_PROJECT];
  if (key === 'statuses') return [task.status];
  if (key === 'priorities') return task.priority ? [task.priority] : [];
  if (key === 'owners') return task.owner ? [task.owner] : [];
  return doc.tagsOf.get(task.id) ?? [];
}

/** Whether a task passes every filter: one value of each filter set, and the words of the text in its id or title. */
export function matches(doc: ProductDoc, task: TaskRow, filters: Filters): boolean {
  for (const key of FILTER_KEYS) {
    const wanted = filters[key];
    if (wanted.length > 0 && !taskValues(doc, task, key).some(value => wanted.includes(value))) return false;
  }
  const words = filters.text.toLocaleLowerCase().split(/\s+/).filter(word => word !== '');
  if (words.length === 0) return true;
  const haystack = `${task.id} ${task.title}`.toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}

export const filterTasks = (doc: ProductDoc, filters: Filters): TaskRow[] =>
  filtersActive(filters) ? doc.tasks.filter(task => matches(doc, task, filters)) : [...doc.tasks];

/** One choice of a filter: its value, what to show (null: the view names it), and how many tasks have it. */
export type Choice = Readonly<{ value: string; label: string | null; count: number }>;

/** The project of a task as a short label: the project's title, its id when the title is unknown, null in no project. */
export const projectLabel = (doc: ProductDoc, task: TaskRow): string | null =>
  task.project === null ? null : doc.projectTitles.get(task.project) ?? task.project;

function tally(doc: ProductDoc, key: FilterKey): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of doc.tasks) for (const value of taskValues(doc, task, key)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** The choices of each filter, from the tasks read: statuses in their order, projects in the order of the document
 *  (then the ones only tasks name, then "no project"), the others alphabetically. A value chosen before that no task
 *  has any more is kept (with 0) so that it can be unticked. */
export function choices(doc: ProductDoc, key: FilterKey, chosen: Filters = EMPTY_FILTERS): Choice[] {
  const counts = tally(doc, key);
  for (const value of chosen[key]) if (!counts.has(value)) counts.set(value, 0);
  const label = (value: string): string | null =>
    key === 'projects' ? (value === NO_PROJECT ? null : doc.projectTitles.get(value) ?? value) : key === 'statuses' ? null : value;
  const order = key === 'statuses' ? [...STATUSES as readonly string[]] : key === 'projects' ? doc.projects.map(project => project.id) : [];
  const rank = (value: string): number => {
    if (key === 'projects' && value === NO_PROJECT) return Infinity;
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  return [...counts].map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => rank(a.value) - rank(b.value) || (a.label ?? a.value).localeCompare(b.label ?? b.value));
}

export const BOARD_COLUMNS: readonly ColumnKey[] = ['todo', 'inProgress', 'blocked', 'done', 'other'];

export type BoardColumn = Readonly<{ key: ColumnKey; rows: readonly TaskRow[]; count: number; missing: number }>;

/**
 * The columns of the board, each with its tasks in the order read and its counter. Without a filter the counter is
 * the server's count of the column (every task of the scope, the ones the list left out included: the open columns
 * add up to the product's `tree.open`, the number of the rail) and `missing` the tasks of the column not read; with
 * a filter it is the number of tasks read that pass.
 */
export function boardColumns(doc: ProductDoc, filters: Filters): BoardColumn[] {
  const shown = filterTasks(doc, filters), active = filtersActive(filters);
  return BOARD_COLUMNS.map(key => {
    const rows = shown.filter(task => (doc.columnOf.get(task.id) ?? 'other') === key);
    const count = active ? rows.length : Math.max(doc.columnCounts[key], rows.length);
    return { key, rows, count, missing: active ? 0 : count - rows.length };
  });
}

/** The open tasks the board counts without a filter (every column but Done). */
export const openOnBoard = (columns: readonly BoardColumn[]): number =>
  columns.filter(column => column.key !== 'done').reduce((total, column) => total + column.count, 0);

export type ProjectGroup = Readonly<{ project: string; title: string | null; tasks: readonly TaskRow[] }>;

/** The tasks by project for the timeline: the document's projects in order, then the projects only tasks name (by
 *  title), then the tasks in no project; a group with no task is left out. */
export function groupByProject(doc: ProductDoc, tasks: readonly TaskRow[]): ProjectGroup[] {
  const groups = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const key = task.project ?? NO_PROJECT;
    const group = groups.get(key);
    if (group) group.push(task); else groups.set(key, [task]);
  }
  const order = doc.projects.map(project => project.id);
  const rank = (key: string): number => (key === NO_PROJECT ? Infinity : order.includes(key) ? order.indexOf(key) : order.length);
  return [...groups].map(([project, rows]) => ({ project, title: project === NO_PROJECT ? null : doc.projectTitles.get(project) ?? project, tasks: rows }))
    .sort((a, b) => rank(a.project) - rank(b.project) || (a.title ?? '').localeCompare(b.title ?? ''));
}

/** The filters of each product the operator filtered, newest last, at most this many products. */
export const MAX_FILTERED_PRODUCTS = 20;
export type ProductFilters = readonly (readonly [string, Filters])[];

/** The stored filters of the products: hostile entries dropped, each product once (its last entry), bounded. */
export function readProductFilters(value: unknown, isProduct: (id: unknown) => id is string): ProductFilters {
  if (!Array.isArray(value)) return [];
  const kept = new Map<string, Filters>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isProduct(entry[0])) continue;
    const filters = readFilters(entry[1]);
    kept.delete(entry[0]);
    if (filtersActive(filters)) kept.set(entry[0], filters);
  }
  return [...kept].slice(-MAX_FILTERED_PRODUCTS);
}

export const filtersOf = (all: ProductFilters, product: string): Filters =>
  all.find(([id]) => id === product)?.[1] ?? EMPTY_FILTERS;

/** The filters of `product` set (moved last, the newest), or removed when none is active. */
export function withFilters(all: ProductFilters, product: string, filters: Filters): ProductFilters {
  const others = all.filter(([id]) => id !== product);
  return (filtersActive(filters) ? [...others, [product, readFilters(filters)] as const] : others).slice(-MAX_FILTERED_PRODUCTS);
}
