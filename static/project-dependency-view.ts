// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { ProviderSummary } from './project-catalog.ts';
import type { FollowupPreferences } from './project-followup-preferences.ts';
import type { FollowupRow } from './project-followup-model.ts';
import { rowGraph } from './project-followup-model.ts';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 208, HEIGHT = 148, COLUMN = 280, ROW = 184, INSET = 12;
let nextGraphId = 0;
type Position = { x: number; y: number };
function svg<K extends keyof SVGElementTagNameMap>(dom: ProjectDom, tag: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const element = dom.doc.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function lines(value: string, limit: number): string[] {
  let rest = Array.from(value.trim()); const result: string[] = [];
  while (rest.length && result.length < limit) {
    const head = rest.slice(0, 23).join('');
    const space = head.lastIndexOf(' ');
    const length = rest.length > 23 && space > 8 ? Array.from(head.slice(0, space)).length : Math.min(23, rest.length);
    result.push(rest.splice(0, length).join('').trim());
    while (rest[0] === ' ') rest.shift();
  }
  if (rest.length) result[result.length - 1] = Array.from(result.at(-1)!).slice(0, -1).join('') + '…';
  return result;
}
function text(dom: ProjectDom, parent: SVGElement, value: string, x: number, y: number, limit: number, className: string): void {
  const label = svg(dom, 'text', { x: String(x), y: String(y), class: className });
  for (const [index, line] of lines(value, limit).entries()) {
    const span = svg(dom, 'tspan', { x: String(x), dy: index ? '17' : '0' }); span.textContent = line; label.append(span);
  }
  parent.append(label);
}
function positions(rows: FollowupRow[], levels: Map<string, number | null>): Map<string, Position> {
  const known = [...new Set(rows.map(row => levels.get(row.id)).filter((level): level is number => typeof level === 'number'))].sort((a, b) => a - b);
  const counts = new Map<number | null, number>();
  return new Map(rows.map(row => {
    const level = levels.get(row.id) ?? null, index = counts.get(level) ?? 0; counts.set(level, index + 1);
    return [row.id, { x: INSET + (level === null ? known.length : known.indexOf(level)) * COLUMN, y: INSET + index * ROW }];
  }));
}
function path(from: Position, to: Position): string {
  const startX = from.x + WIDTH, startY = from.y + HEIGHT / 2, endY = to.y + HEIGHT / 2;
  if (to.x > from.x) {
    const middle = (startX + to.x) / 2;
    return `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${to.x} ${endY}`;
  }
  // Unknown levels share a column; route cycles and self-links outside the node ports.
  const loop = Math.max(startX, to.x + WIDTH) + 44;
  const start = from === to ? startY - 24 : startY, end = from === to ? endY + 24 : endY;
  return `M ${startX} ${start} C ${loop} ${start}, ${loop} ${end}, ${to.x + WIDTH} ${end}`;
}
function labelClip(dom: ProjectDom, definitions: SVGDefsElement, position: Position, id: string): void {
  const clip = svg(dom, 'clipPath', { id, clipPathUnits: 'userSpaceOnUse' });
  clip.append(svg(dom, 'rect', { x: String(position.x + 10), y: String(position.y + 6), width: String(WIDTH - 20), height: String(HEIGHT - 12) }));
  definitions.append(clip);
}
function node(dom: ProjectDom, row: FollowupRow, position: Position, level: number | null, state: FollowupPreferences, select: (key: string) => void, clipId: string): SVGGElement {
  const meaning = dom.t(`projects.followup.meaning.${row.meaning}`, { value: row.state });
  const status = dom.t('projects.followup.meaning.source-state', { value: row.state });
  const levelLabel = dom.t(level === null ? 'projects.followup.dependencyUnknown' : 'projects.followup.level', { value: level ?? '' });
  const label = `${row.id} · ${row.title} · ${status} · ${meaning} · ${levelLabel}`;
  const group = svg(dom, 'g', { class: 'project-dependency-node', role: 'button', tabindex: '0', 'aria-label': label, 'aria-pressed': String(row.key === state.selected) });
  group.dataset.state = row.state; group.dataset.taskId = row.id; group.dataset.followupKey = `node-${row.key}`;
  const title = svg(dom, 'title'); title.textContent = label;
  group.append(title, svg(dom, 'rect', { x: String(position.x), y: String(position.y), width: String(WIDTH), height: String(HEIGHT), rx: '10' }));
  const ink = svg(dom, 'g', { 'clip-path': `url(#${clipId})` });
  text(dom, ink, row.id, position.x + 12, position.y + 23, 1, 'project-dependency-id');
  text(dom, ink, row.title, position.x + 12, position.y + 47, 3, 'project-dependency-title');
  text(dom, ink, row.state, position.x + 12, position.y + 108, 1, 'project-dependency-status');
  text(dom, ink, levelLabel, position.x + 12, position.y + 133, 1, 'project-dependency-level');
  group.append(ink);
  group.addEventListener('click', () => select(row.key));
  group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.key); } });
  return group;
}
export function renderDependencyGraph(dom: ProjectDom, rows: FollowupRow[], summary: ProviderSummary, state: FollowupPreferences, select: (key: string) => void): HTMLElement {
  const chart = dom.element('div'); chart.className = 'project-followup-chart project-dependency-chart'; chart.dataset.followupKey = 'chart';
  chart.tabIndex = 0; chart.setAttribute('aria-label', dom.t('projects.followup.dependencyGraph'));
  const visible = rows.slice(state.page * 50, (state.page + 1) * 50), graph = rowGraph(rows, summary), points = positions(visible, graph.levels);
  const width = Math.max(360, ...[...points.values()].map(point => point.x + WIDTH + 72));
  const height = Math.max(240, ...[...points.values()].map(point => point.y + HEIGHT + INSET));
  const drawing = svg(dom, 'svg', { class: 'project-dependency-svg', width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': dom.t('projects.followup.dependencyGraph') });
  // Per-document unique marker IDs avoid collisions between independently mounted Work views.
  const markerId = `dependency-arrow-${nextGraphId++}`;
  const definitions = svg(dom, 'defs'), marker = svg(dom, 'marker', { id: markerId, viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' });
  marker.append(svg(dom, 'path', { d: 'M 0 0 L 10 5 L 0 10 Z' })); definitions.append(marker); drawing.append(definitions);
  const edges = svg(dom, 'g', { class: 'project-dependency-edges', 'aria-hidden': 'true' });
  const all = visible.flatMap(row => row.dependsOn.map(from => ({ from, to: row.id })));
  const drawable = all.filter(edge => points.has(edge.from) && points.has(edge.to)).slice(0, 200);
  for (const edge of drawable) {
    const line = svg(dom, 'path', { d: path(points.get(edge.from)!, points.get(edge.to)!), 'marker-end': `url(#${markerId})` });
    line.dataset.from = edge.from; line.dataset.to = edge.to; edges.append(line);
  }
  drawing.append(edges);
  for (const [index, row] of visible.entries()) {
    const position = points.get(row.id)!, clipId = `${markerId}-label-${index}`;
    labelClip(dom, definitions, position, clipId);
    drawing.append(node(dom, row, position, graph.levels.get(row.id) ?? null, state, select, clipId));
  }
  chart.append(drawing);
  if (all.length > drawable.length) chart.append(dom.element('p', dom.t('projects.followup.omittedEdges', { value: all.length - drawable.length })));
  return chart;
}
