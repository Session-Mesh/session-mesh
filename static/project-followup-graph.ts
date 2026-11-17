// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Pure dependency ordering and unlimited-capacity early-start arithmetic. */
export interface GraphTask { id: string; dependsOn: string[]; length: number | null }
type Slot = { start: number; end: number };
export interface DependencyTiming { span: number; overlap: number; slack: Map<string, number>; zeroSlack: string[] }
export interface GraphResult { order: string[]; unresolved: string[]; missing: string[];
  levels: Map<string, number | null>; schedule: Map<string, Slot> | null; timing: DependencyTiming | null; completeCoverage: boolean }
export function dependencyGraph(tasks: GraphTask[], completeCoverage = true): GraphResult {
  const known = new Set(tasks.map(task => task.id));
  const missing = tasks.filter(task => task.dependsOn.some(id => !known.has(id))).map(task => task.id);
  const pending = new Map(tasks.map(task => [task.id, new Set(task.dependsOn.filter(id => known.has(id)))]));
  const order: string[] = [];
  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [id, waitingOn] of pending) {
      if (waitingOn.size > 0) continue;
      order.push(id); pending.delete(id);
      for (const other of pending.values()) other.delete(id);
      progressed = true;
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task])), levels = new Map<string, number | null>();
  for (const id of order) {
    const dependencies = byId.get(id)!.dependsOn;
    levels.set(id, dependencies.some(dep => !levels.has(dep) || levels.get(dep) === null) ? null : Math.max(-1, ...dependencies.map(dep => levels.get(dep)!)) + 1);
  }
  for (const id of pending.keys()) levels.set(id, null);
  const complete = completeCoverage && !pending.size && !missing.length && tasks.every(task => task.length !== null && Number.isFinite(task.length) && task.length >= 0);
  const schedule = complete ? earliestSchedule(tasks, order) : null;
  return { order, unresolved: [...pending.keys()], missing, levels, schedule, completeCoverage,
    timing: schedule ? dependencyTiming(tasks, order, schedule) : null };
}
function earliestSchedule(tasks: GraphTask[], order: string[]): Map<string, { start: number; end: number }> {
  const byId = new Map(tasks.map(task => [task.id, task])), schedule = new Map<string, { start: number; end: number }>();
  for (const id of order) {
    const task = byId.get(id)!;
    const start = Math.max(0, ...task.dependsOn.map(dep => schedule.get(dep)!.end));
    schedule.set(id, { start, end: start + task.length! });
  }
  return schedule;
}
/** Unknown rows stay unscaled without destroying known rows' shared time scale. */
export function durationGeometry(lengths: (number | null)[], width: number): ({ width: number; kind: 'duration' | 'point' | 'unknown' })[] {
  const maximum = Math.max(0, ...lengths.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0));
  return lengths.map(value => value === null || !Number.isFinite(value) || value < 0 ? { width: 0, kind: 'unknown' } :
    { width: maximum > 0 ? value / maximum * width : 0, kind: value === 0 ? 'point' : 'duration' });
}

/** Owner graph.mjs backward pass; parallel zero-slack tasks are not a single chain. */
function dependencyTiming(tasks: GraphTask[], order: string[], schedule: Map<string, Slot>): DependencyTiming {
  const span = Math.max(0, ...[...schedule.values()].map(slot => slot.end));
  const successors = new Map(order.map(id => [id, [] as string[]]));
  for (const task of tasks) for (const dep of task.dependsOn) successors.get(dep)!.push(task.id);
  const latestStart = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const slot = schedule.get(id)!, next = successors.get(id)!.map(successor => latestStart.get(successor)!);
    latestStart.set(id, (next.length ? Math.min(...next) : span) - (slot.end - slot.start));
  }
  const slack = new Map(order.map(id => [id, latestStart.get(id)! - schedule.get(id)!.start]));
  const zeroSlack = order.filter(id => Math.abs(slack.get(id)!) < 1e-9 && schedule.get(id)!.end - schedule.get(id)!.start > 1e-9);
  return { span, overlap: possibleOverlap(order, schedule), slack, zeroSlack };
}
/** Owner maxParallelism: count positive intervals between distinct endpoints. */
function possibleOverlap(order: string[], schedule: Map<string, Slot>): number {
  const bars = order.map(id => schedule.get(id)!).filter(bar => bar.end - bar.start > 1e-9);
  const points = [...new Set(bars.flatMap(bar => [bar.start, bar.end]))].sort((left, right) => left - right);
  let width = bars.length ? 1 : 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index]!, to = points[index + 1]!;
    width = Math.max(width, bars.filter(bar => bar.start < to - 1e-9 && bar.end > from + 1e-9).length);
  }
  return width;
}
