// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Pure derivations over the parsed documents: no DOM, no clock of their own (the caller passes `nowMs`). */

import type {
  Counts, Dependency, DependencyState, NoProject, Product, ProductsDoc, ProjectsDoc, ProjectSummary, TaskRow,
} from './work-types.ts';

export const STATUSES = ['inbox', 'todo', 'in_progress', 'blocked', 'waiting', 'done', 'dropped'] as const;
export const isFinished = (status: string): boolean => status === 'done' || status === 'dropped';

/** The statuses the timeline legend lists (an untriaged task is drawn like a task to do). */
export const FRISE_LEGEND_STATUSES = ['todo', 'in_progress', 'waiting', 'blocked', 'done', 'dropped'] as const;

/** The class of a timeline bar and the theme variable that colours it: the variable of the status dot, except that
 *  to do and dropped use --mute (the dot's --off is below 3:1 against the track in the dark themes). */
export type FriseBarStyle = { cls: string; token: string };
const FRISE_BARS: Readonly<Record<string, FriseBarStyle>> = Object.freeze({
  inbox: { cls: 'work-bar-todo', token: '--mute' }, todo: { cls: 'work-bar-todo', token: '--mute' },
  in_progress: { cls: 'work-bar-in_progress', token: '--busy' }, waiting: { cls: 'work-bar-waiting', token: '--wait' },
  blocked: { cls: 'work-bar-blocked', token: '--danger' }, done: { cls: 'work-bar-done', token: '--accent' },
  dropped: { cls: 'work-bar-dropped', token: '--mute' },
});
const NEUTRAL_BAR: FriseBarStyle = { cls: 'work-bar-unknown', token: '--mute' };
export const friseBarStyle = (status: string): FriseBarStyle =>
  Object.hasOwn(FRISE_BARS, status) ? FRISE_BARS[status]! : NEUTRAL_BAR;

/** Done over open plus done, as a whole percentage rounded down; null when there is no task. */
export function progressPercent(counts: Counts): number | null {
  const total = counts.open + counts.done;
  if (total === 0) return null;
  return Math.floor((100 * counts.done) / total);   // never 100 while a task is open
}

export type EntryProduct = Readonly<{
  product: Product; projects: readonly ProjectSummary[]; noProject: NoProject | null; children: readonly EntryProduct[];
}>;
export type EntryCategory = Readonly<{ key: string; name: string; products: readonly EntryProduct[] }>;

function entryNode(product: Product, byParent: ReadonlyMap<string, Product[]>, projects: ReadonlyMap<string, ProjectSummary[]>,
  noProject: ReadonlyMap<string, NoProject>, seen: Set<string>): EntryProduct {
  seen.add(product.id);
  const children = (byParent.get(product.id) ?? []).filter(child => !seen.has(child.id))
    .map(child => entryNode(child, byParent, projects, noProject, seen));
  return { product, projects: projects.get(product.id) ?? [], noProject: noProject.get(product.id) ?? null, children };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Products as a tree (a child under its parent when the parent is listed), each with its projects and its "no project" line. */
export function entryTree(products: ProductsDoc, projects: ProjectsDoc): readonly EntryCategory[] {
  const known = new Set(products.categories.flatMap(category => category.products.map(product => product.id)));
  const byParent = groupBy(products.categories.flatMap(category => category.products)
    .filter(product => product.parent !== null && known.has(product.parent)), product => product.parent ?? '');
  const projectsByProduct = groupBy(projects.projects, project => project.product);
  const noProject = new Map(projects.noProject.map(entry => [entry.product, entry] as const));
  const seen = new Set<string>();
  return products.categories.map(category => ({
    key: category.key, name: category.name,
    products: category.products.filter(product => product.parent === null || !known.has(product.parent))
      .map(product => entryNode(product, byParent, projectsByProduct, noProject, seen)),
  }));
}

export function dateMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type FriseRow = Readonly<{
  task: TaskRow; start: number | null; end: number | null; due: number | null; eta: number | null;
}>;
export type Frise = Readonly<{ rows: readonly FriseRow[]; min: number; max: number; today: number }>;

/** Dates further than this from today (either way) do not stretch the axis; they are drawn at its edge and marked. */
export const AXIS_REACH_MS = 3 * 365 * 86_400_000;

/** An open task runs to today; a done one to its done date; a dropped one, or a done one with no date, has no length. */
function friseRow(task: TaskRow, nowMs: number): FriseRow {
  const start = dateMs(task.created);
  const finish = task.status === 'done' ? dateMs(task.doneAt) : null;
  const end = start === null ? null : Math.max(start, isFinished(task.status) ? finish ?? start : nowMs);
  return { task, start, end, due: dateMs(task.due), eta: dateMs(task.eta) };
}

/** Positions of a timeline: a bar from creation to done (or to today) and markers; no bar without a creation date.
 * The axis covers the dates within three years of today: an outlier (1970, 2099) cannot flatten every other bar. */
export function buildFrise(tasks: readonly TaskRow[], nowMs: number): Frise {
  const rows = tasks.map(task => friseRow(task, nowMs));
  const points = rows.flatMap(row => [row.start, row.end, row.due, row.eta]).filter((ms): ms is number => ms !== null);
  const near = points.filter(ms => Math.abs(ms - nowMs) <= AXIS_REACH_MS);
  const min = Math.min(nowMs, ...near), max = Math.max(nowMs, ...near);
  rows.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.task.id.localeCompare(b.task.id));
  return { rows, min, max, today: nowMs };
}

/** Position on the axis as a percentage, clamped to 0..100; a flat axis puts everything at 0. */
export function axisPercent(frise: Frise, ms: number): number {
  const span = frise.max - frise.min;
  return span <= 0 ? 0 : Math.min(100, Math.max(0, (100 * (ms - frise.min)) / span));
}

/** Which side of the axis a date falls on: -1 before it, 1 after it, 0 on it. */
export function axisSide(frise: Frise, ms: number): -1 | 0 | 1 {
  return ms < frise.min ? -1 : ms > frise.max ? 1 : 0;
}

export type DependencyNode = Readonly<{
  id: string; title: string | null; status: string | null; state: DependencyState; inProject: boolean;
  blockedBy: readonly Dependency[];
}>;
/** `cycle`: the tasks of this group wait on each other (there is no level 0 to start from); `level` is then 0. */
export type DependencyLevel = Readonly<{ level: number; cycle: boolean; nodes: readonly DependencyNode[] }>;

/** The ids that sit on a dependency cycle (strongly connected groups of more than one task, or a task waiting on itself).
 * Tarjan with an explicit stack: a long chain must not exhaust the call stack. */
function cyclicIds(ids: readonly string[], edges: ReadonlyMap<string, Dependency[]>): Set<string> {
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const cyclic = new Set<string>();
  const enter = (id: string): void => { index.set(id, index.size); low.set(id, index.get(id)!); stack.push(id); onStack.add(id); };
  const lower = (id: string, value: number): void => { low.set(id, Math.min(low.get(id)!, value)); };
  const finish = (id: string): void => {
    if (low.get(id) !== index.get(id)) return;
    const group: string[] = [];
    for (let top = stack.pop()!; ; top = stack.pop()!) { onStack.delete(top); group.push(top); if (top === id) break; }
    if (group.length > 1 || (edges.get(id) ?? []).some(edge => edge.to === id)) for (const member of group) cyclic.add(member);
  };
  for (const root of ids) {
    if (index.has(root)) continue;
    const frames: { id: string; next: number }[] = [{ id: root, next: 0 }];
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const out = edges.get(frame.id) ?? [];
      if (frame.next < out.length) {
        const target = out[frame.next++]!.to;
        if (!index.has(target)) { enter(target); frames.push({ id: target, next: 0 }); }
        else if (onStack.has(target)) lower(frame.id, index.get(target)!);
        continue;
      }
      frames.pop();
      finish(frame.id);
      const parent = frames[frames.length - 1];
      if (parent) lower(parent.id, low.get(frame.id)!);
    }
  }
  return cyclic;
}

/** One level after the deepest thing waited on; a cyclic task counts as level 0 (its group is shown apart).
 * Post-order with an explicit stack; `memo` holds the answer for every task already settled. */
function levelOf(root: string, edges: ReadonlyMap<string, Dependency[]>, memo: Map<string, number>): number {
  const pending: string[] = [root];
  while (pending.length > 0) {
    const id = pending[pending.length - 1]!;
    if (memo.has(id)) { pending.pop(); continue; }
    const targets = (edges.get(id) ?? []).map(edge => edge.to);
    const unsettled = targets.filter(target => !memo.has(target));
    if (unsettled.length > 0) { pending.push(...unsettled); continue; }
    memo.set(id, Math.max(-1, ...targets.map(target => memo.get(target)!)) + 1);
    pending.pop();
  }
  return memo.get(root)!;
}

/**
 * Tasks involved in a dependency, by level: level 0 waits on nothing, and a task at level n waits on tasks of level n-1 at
 * most. Tasks on a cycle form a separate group (`cycle`) before level 0, and what waits on them sits at level 1 or later.
 */
export function dependencyLevels(dependencies: readonly Dependency[], tasks: readonly TaskRow[]): readonly DependencyLevel[] {
  const edges = groupBy(dependencies, edge => edge.from);
  const byId = new Map(tasks.map(task => [task.id, task] as const));
  const info = new Map(dependencies.map(edge => [edge.to, edge] as const));
  const ids = [...new Set(dependencies.flatMap(edge => [edge.from, edge.to]))];
  const cyclic = cyclicIds(ids, edges);
  const memo = new Map<string, number>([...cyclic].map(id => [id, 0] as const));
  const nodes = ids.map(id => {
    const task = byId.get(id), edge = info.get(id);
    const node: DependencyNode = { id, title: task?.title ?? edge?.toTitle ?? null, status: task?.status ?? edge?.toStatus ?? null,
      state: edge?.state ?? (task && isFinished(task.status) ? 'finished' : 'open'), inProject: task !== undefined || edge?.toInProject === true,
      blockedBy: edges.get(id) ?? [] };
    return { node, level: levelOf(id, edges, memo), cycle: cyclic.has(id) };
  });
  const groups = groupBy(nodes, entry => `${entry.cycle ? 'c' : 'l'}${entry.level}`);
  return [...groups.values()].map(entries => ({ level: entries[0]!.level, cycle: entries[0]!.cycle,
    nodes: entries.map(entry => entry.node).sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.level - b.level || Number(b.cycle) - Number(a.cycle));
}
