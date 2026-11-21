// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The `product` document of `POST /api/work/v1` (ocaml/work_read/lib/wr_product.ml): every task of a product and of
 * its child products, for the Board and Timeline tabs of the product's view. Parsed as defensively as the other
 * documents (static/work-parse.ts): a wrong type is dropped, a missing field gets a neutral value, never a throw.
 */

import { isObj, parseProjectSummary, parseTaskRow, text } from './work-parse.ts';
import type { ColumnKey, ProjectSummary, TaskRow } from './work-types.ts';

export type ProductDoc = Readonly<{
  product: string;
  /** The product and its descendants: the scope of the product's `tree` counts, as the rail shows them. */
  scope: readonly string[];
  projects: readonly ProjectSummary[];
  tasks: readonly TaskRow[];
  /** The board column of each task, as the server places it (never computed again here). */
  columnOf: ReadonlyMap<string, ColumnKey>;
  tagsOf: ReadonlyMap<string, readonly string[]>;
  /** The title of each project a task names, from the task rows. */
  projectTitles: ReadonlyMap<string, string>;
  /** Every task of the scope per column, the ones the list left out included. */
  columnCounts: Readonly<Record<ColumnKey, number>>;
  /** The tasks the list left out (`tasks_omitted`). */
  omittedTasks: number;
  truncated: boolean;
}>;

const COLUMN_OF_NAME: Readonly<Record<string, ColumnKey>> = Object.freeze({
  todo: 'todo', in_progress: 'inProgress', blocked: 'blocked', done: 'done', other: 'other',
});
export const columnKey = (name: unknown): ColumnKey =>
  typeof name === 'string' && Object.hasOwn(COLUMN_OF_NAME, name) ? COLUMN_OF_NAME[name]! : 'other';

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string');

function parseColumnCounts(value: unknown): Record<ColumnKey, number> {
  const source = isObj(value) ? value : {};
  return { todo: count(source.todo), inProgress: count(source.in_progress), blocked: count(source.blocked),
    done: count(source.done), other: count(source.other) };
}

type Rows = { tasks: TaskRow[]; columnOf: Map<string, ColumnKey>; tagsOf: Map<string, string[]>; titles: Map<string, string> };

/** The rows, each task once (a repeated id keeps its first row). */
function parseRows(value: unknown): Rows {
  const rows: Rows = { tasks: [], columnOf: new Map(), tagsOf: new Map(), titles: new Map() };
  for (const source of Array.isArray(value) ? value : []) {
    const row = isObj(source) ? parseTaskRow(source) : null;
    if (!row || rows.columnOf.has(row.id)) continue;
    rows.tasks.push(row);
    rows.columnOf.set(row.id, columnKey((source as Record<string, unknown>).column));
    rows.tagsOf.set(row.id, [...new Set(strings((source as Record<string, unknown>).tags))]);
    const title = text((source as Record<string, unknown>).project_title);
    if (row.project && title && !rows.titles.has(row.project)) rows.titles.set(row.project, title);
  }
  return rows;
}

export function parseProductDoc(value: unknown): ProductDoc | null {
  if (!isObj(value) || !Array.isArray(value.tasks)) return null;
  const product = text(value.product);
  if (!product) return null;
  const rows = parseRows(value.tasks);
  const seen = new Set<string>();
  const projects = (Array.isArray(value.projects) ? value.projects : []).filter(isObj).map(parseProjectSummary)
    .filter((project): project is ProjectSummary => project !== null && !seen.has(project.id) && seen.add(project.id) !== null);
  for (const project of projects) if (!rows.titles.has(project.id)) rows.titles.set(project.id, project.title);
  const scope = strings(value.scope);
  return { product, scope: scope.length > 0 ? scope : [product], projects, tasks: rows.tasks, columnOf: rows.columnOf,
    tagsOf: rows.tagsOf, projectTitles: rows.titles, columnCounts: parseColumnCounts(value.column_counts),
    omittedTasks: count(value.tasks_omitted), truncated: value.truncated === true };
}
