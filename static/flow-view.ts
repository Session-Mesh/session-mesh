// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {filterEvents, identityKey, parseSnapshot} from './flow-model.ts';
import type {FlowEvent, FlowSnapshot, Identity} from './flow-model.ts';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Options = { root: HTMLElement; request: (url: string, init?: RequestInit) => Promise<Response>;
  translate: Translate; current: () => Pick<Identity, 'id' | 'created'> | null; locale: () => string; now: () => number };
const SVG = 'http://www.w3.org/2000/svg';
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const result = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value); return result;
}
function nodeIds(events: FlowEvent[]): Identity[] {
  const map = new Map<string, Identity>();
  for (const event of events) { map.set(identityKey(event.source), event.source); map.set(identityKey(event.target), event.target); }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id) || a.created - b.created);
}
export function mountFlowView(options: Options) {
  const {root, request, translate: t} = options;
  let scope: 'current' | 'all' = 'current', view: 'sequence' | 'graph' = 'sequence', windowSeconds = 3600, kind = 'all';
  let data: FlowSnapshot | null = null, selected = '', selectedNode = '', opened = false, running = false, generation = 0, timer = 0;
  let known = new Set<string>(), fresh = new Set<string>(), hasLoaded = false;
  let lastSignature = '';
  let renderedFilterSignature = '', pageIndex = 0, ambiguousNames = new Set<string>();
  let abort: AbortController | null = null;
  const controls = el('div', 'flow-toolbar'), status = el('p', 'flow-status'), notice = el('p', 'flow-notice');
  const canvas = el('div', 'flow-canvas'), detail = el('aside', 'flow-detail'), list = el('div', 'flow-event-list');
  const count = el('p', 'flow-count');
  const pagination = el('div', 'flow-pagination');
  const region = el('div', 'flow-layout'); region.append(canvas, detail);
  status.setAttribute('role', 'status'); notice.setAttribute('role', 'status');
  const title = el('div', 'flow-intro'); title.append(el('p', 'flow-eyebrow', t('flow.eyebrow')),
    el('h1', '', t('flow.title')), el('p', 'flow-subtitle', t('flow.description')));
  const heading = el('div', 'flow-heading'); const close = el('button', 'btn ghost', t('flow.back'));
  close.type = 'button'; close.addEventListener('click', () => root.dispatchEvent(new CustomEvent('flow-close', {bubbles: true})));
  heading.append(title, close);
  root.replaceChildren(heading, controls, status, notice, region, count, list, pagination);
  function clock(time: number): string { return new Date(time * 1000).toLocaleTimeString(options.locale(), {hour: '2-digit', minute: '2-digit', second: '2-digit'}); }
  function displayIdentity(person: Identity): string {
    return ambiguousNames.has(person.id) ? `${person.id} · ${t('flow.started')} ${new Date(person.created * 1000).toLocaleString(options.locale())} [${person.created}]` : person.id;
  }
  function label(event: FlowEvent): string {
    return `${clock(event.time)} · ${t(`flow.kind.${event.kind}`)} · ${displayIdentity(event.source)} → ${displayIdentity(event.target)}`;
  }
  const segment = (items: Array<[string, string]>, selectedValue: string, change: (value: string) => void) => {
    const group = el('div', 'flow-segment');
    for (const [value, text] of items) {
      const button = el('button', 'flow-toggle', text); button.type = 'button';
      button.setAttribute('aria-pressed', String(value === selectedValue));
      button.addEventListener('click', () => { change(value); render();
        [...controls.querySelectorAll('button')].find(item => item.textContent === text)?.focus(); }); group.append(button);
    } return group;
  };
  function makeSelect(labelText: string, values: Array<[string, string]>, value: string, change: (value: string) => void) {
    const wrap = el('label', 'flow-select'); wrap.append(el('span', '', labelText)); const select = el('select');
    for (const [v, text] of values) { const option = el('option', '', text); option.value = v; select.append(option); }
    select.value = value; select.addEventListener('change', () => {change(select.value); render();
      [...controls.querySelectorAll('label')].find(item => item.textContent?.startsWith(labelText))?.querySelector('select')?.focus();}); wrap.append(select); return wrap;
  }
  function selectEvent(id: string, role: string) {
    selected = id; selectedNode = ''; render();
    [...root.querySelectorAll<HTMLButtonElement>('[data-flow-id]')]
      .find(button => button.dataset.flowId === id && button.dataset.flowRole === role)?.focus();
  }
  function renderControls() {
    const refresh = el('button', 'btn flow-refresh', t('flow.refresh')); refresh.type = 'button';
    refresh.addEventListener('click', () => void load());
    controls.replaceChildren(
      segment([['current', t('flow.current')], ['all', t('flow.all')]], scope, value => {scope = value as typeof scope; pageIndex = 0;}),
      segment([['sequence', t('flow.sequence')], ['graph', t('flow.graph')]], view, value => {view = value as typeof view;}),
      makeSelect(t('flow.period'), [['3600', t('flow.hour')], ['86400', t('flow.day')], ['0', t('flow.everything')]], String(windowSeconds), value => {windowSeconds = Number(value); pageIndex = 0;}),
      makeSelect(t('flow.types'), [['all', t('flow.allTypes')], ['message', t('flow.kind.message')], ['create', t('flow.kind.create')]], kind, value => {kind = value; pageIndex = 0;}), refresh);
  }
  function showDetail(event: FlowEvent | undefined) {
    detail.replaceChildren(el('p', 'flow-eyebrow', t('flow.inspector')), el('h2', '', t('flow.detail')));
    if (!event) { detail.append(el('p', 'flow-muted', t('flow.selectEvent'))); return; }
    const badge = el('span', `flow-kind flow-kind-${event.kind}`, t(`flow.kind.${event.kind}`));
    const time = el('p', 'flow-detail-time', new Date(event.time * 1000).toLocaleString(options.locale()));
    const paths = el('div', 'flow-detail-path');
    for (const [name, value] of [[t('flow.from'), event.source], [t('flow.to'), event.target]] as const) {
      const row = el('div', 'flow-detail-person'); row.append(el('span', 'flow-muted', name), el('strong', '', displayIdentity(value)), el('small', 'flow-muted', value.agent)); paths.append(row);
    }
    detail.append(badge, time, paths);
    if (event.kind === 'message') detail.append(el('p', 'flow-detail-note', t('flow.depositMeaning')));
    detail.append(el('p', 'flow-detail-note', t('flow.metadataOnly')));
  }
  function marker() {
    const defs = svg('defs', {}), mark = svg('marker', {id: 'flow-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse'});
    mark.append(svg('path', {d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor'})); defs.append(mark); return defs;
  }
  function drawSequence(events: FlowEvent[]) {
    const nodes = nodeIds(events), width = Math.max(680, 88 + nodes.length * 190), rowHeight = 52, height = 84 + events.length * rowHeight;
    const wrap = el('div', 'flow-scroll'); wrap.setAttribute('tabindex', '0'); wrap.setAttribute('aria-label', t('flow.sequence'));
    const stage = el('div', 'flow-stage'); stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    const surface = svg('svg', {viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), 'aria-hidden': 'true'}); surface.append(marker());
    const positions = new Map<string, number>();
    nodes.forEach((node, i) => {
      const x = 145 + i * 190; positions.set(identityKey(node), x);
      const header = el('div', 'flow-lane-head'); header.style.left = `${x}px`;
      const name = el('strong', '', node.id); name.title = displayIdentity(node);
      const glyph = el('span', 'flow-node-dot'); glyph.setAttribute('aria-hidden', 'true');
      header.append(glyph, name, el('small', '', ambiguousNames.has(node.id) ? displayIdentity(node) : node.agent)); stage.append(header);
      surface.append(svg('line', {x1: String(x), y1: '69', x2: String(x), y2: String(height), class: 'flow-lifeline'}));
    });
    events.forEach((event, index) => {
      const from = positions.get(identityKey(event.source))!, to = positions.get(identityKey(event.target))!, y = 98 + index * rowHeight;
      surface.append(svg('line', {x1: String(from), y1: String(y), x2: String(to), y2: String(y), class: `flow-edge flow-edge-${event.kind}${selected === event.id ? ' selected' : ''}`, 'marker-end': 'url(#flow-arrow)'}));
      if (fresh.has(event.id) && event.kind === 'message') {
        const dot = svg('circle', {cx: String(from), cy: String(y), r: '3', class: 'flow-spark'});
        dot.style.setProperty('--flow-dx', `${to - from}px`); surface.append(dot);
      }
      const when = el('span', 'flow-when', clock(event.time)); when.style.top = `${y - 7}px`; stage.append(when);
      const button = el('button', 'flow-edge-button', t(`flow.kind.${event.kind}`)); button.type = 'button'; button.style.left = `${(from + to) / 2}px`; button.style.top = `${y}px`;
      button.dataset.flowId = event.id; button.dataset.flowRole = 'edge';
      button.setAttribute('aria-label', label(event)); button.setAttribute('aria-pressed', String(selected === event.id));
      button.addEventListener('click', () => selectEvent(event.id, 'edge')); stage.append(button);
    });
    stage.prepend(surface); wrap.append(stage); canvas.append(wrap);
  }
  function drawGraph(events: FlowEvent[]) {
    const nodes = nodeIds(events), cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const width = Math.max(840, canvas.clientWidth, 520 + (cols - 1) * 230);
    // At most four directed/type combinations join a pair. A quadratic curve
    // reaches half its control-point offset; reserve that extreme plus the
    // full 44px control and extra breathing room at both stage boundaries.
    const laneGap = 144, margin = Math.ceil(3 * laneGap / 4) + 66;
    const rows = Math.ceil(nodes.length / cols);
    const height = Math.max(540, 2 * margin + Math.max(0, rows - 1) * 240), wrap = el('div', 'flow-scroll');
    wrap.setAttribute('tabindex', '0'); wrap.setAttribute('aria-label', t('flow.graph'));
    const stage = el('div', 'flow-stage flow-graph'); stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    const surface = svg('svg', {viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), 'aria-hidden': 'true'}); surface.append(marker());
    const positions = new Map<string, {x: number; y: number}>();
    nodes.forEach((node, i) => {
      const x = cols === 1 ? width / 2 : 260 + (i % cols) * ((width - 520) / (cols - 1));
      const y = margin + Math.floor(i / cols) * 240; positions.set(identityKey(node), {x, y});
      const card = el('button', 'flow-graph-node'); card.type = 'button'; card.style.left = `${x}px`; card.style.top = `${y}px`;
      const key = identityKey(node); card.dataset.flowNode = key; card.setAttribute('aria-pressed', String(selectedNode === key));
      card.addEventListener('click', () => { selectedNode = key; selected = ''; render();
        [...root.querySelectorAll<HTMLButtonElement>('[data-flow-node]')].find(button => button.dataset.flowNode === key)?.focus(); });
      card.setAttribute('aria-label', displayIdentity(node));
      const glyph = el('span', 'flow-node-dot'); glyph.setAttribute('aria-hidden', 'true');
      card.append(glyph, el('strong', '', node.id), el('small', '', ambiguousNames.has(node.id) ? displayIdentity(node) : node.agent)); stage.append(card);
    });
    const edges = new Map<string, FlowEvent>(), counts = new Map<string, number>();
    for (const event of events) {
      const key = JSON.stringify([identityKey(event.source), identityKey(event.target), event.kind]);
      edges.set(key, event); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const pairs = new Map<string, FlowEvent[]>();
    for (const event of edges.values()) {
      const key = JSON.stringify([identityKey(event.source), identityKey(event.target)].sort());
      const group = pairs.get(key) ?? []; group.push(event); pairs.set(key, group);
    }
    for (const group of pairs.values()) {
      group.sort((a, b) => JSON.stringify([identityKey(a.source), a.kind]).localeCompare(JSON.stringify([identityKey(b.source), b.kind])));
      for (const [index, event] of group.entries()) {
      const a = positions.get(identityKey(event.source))!, b = positions.get(identityKey(event.target))!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const inset = Math.min(dx ? 83 / Math.abs(dx) : Infinity, dy ? 27 / Math.abs(dy) : Infinity, 0.45);
      const startX = a.x + dx * inset, startY = a.y + dy * inset, endX = b.x - dx * inset, endY = b.y - dy * inset;
      // Offset is measured against a canonical node order, so the reverse
      // direction never folds the curve back onto the forward direction.
      const sign = identityKey(event.source) < identityKey(event.target) ? 1 : -1;
      const length = Math.hypot(dx, dy), offset = (index - (group.length - 1) / 2) * laneGap;
      const controlX = (startX + endX) / 2 - sign * dy / length * offset;
      const controlY = (startY + endY) / 2 + sign * dx / length * offset;
      const path = `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`;
      const linked = selectedNode && (identityKey(event.source) === selectedNode || identityKey(event.target) === selectedNode);
      const chosen = events.find(item => item.id === selected);
      const chosenRelation = chosen && identityKey(chosen.source) === identityKey(event.source)
        && identityKey(chosen.target) === identityKey(event.target) && chosen.kind === event.kind;
      surface.append(svg('path', {d: path, fill: 'none', 'data-flow-kind': event.kind,
        'data-flow-from': identityKey(event.source), 'data-flow-to': identityKey(event.target),
        class: `flow-edge flow-edge-${event.kind}${chosenRelation || linked ? ' selected' : ''}`, 'marker-end': 'url(#flow-arrow)'}));
      const vertical = Math.abs(dy) > Math.abs(dx);
      const centerX = (startX + endX) / 2, curveX = (startX + 2 * controlX + endX) / 4;
      const count = counts.get(JSON.stringify([identityKey(event.source), identityKey(event.target), event.kind])) ?? 1;
      const caption = el('button', 'flow-graph-edge-button', t(`flow.kind.${event.kind}`) + (count > 1 ? ` ×${count}` : ''));
      caption.type = 'button'; caption.style.left = `${vertical ? curveX + (controlX < centerX ? -6 : 6) : curveX}px`;
      caption.style.top = `${vertical ? (startY + endY) / 2 + (index - (group.length - 1) / 2) * 52 : (startY + 2 * controlY + endY) / 4}px`;
      if (vertical) caption.classList.add(controlX < centerX ? 'flow-caption-left' : 'flow-caption-right');
      caption.dataset.flowId = event.id; caption.dataset.flowRole = 'graph-edge';
      caption.setAttribute('aria-label', label(event) + (count > 1 ? ` · ${t('flow.latestOf', {n: count})}` : ''));
      caption.setAttribute('aria-pressed', String(!!chosenRelation));
      caption.addEventListener('click', () => selectEvent(event.id, 'graph-edge')); stage.append(caption);
      if (fresh.has(event.id) && event.kind === 'message') {
        const dot = svg('circle', {r: '3', class: 'flow-spark flow-graph-spark'});
        dot.append(svg('animateMotion', {path, dur: '1.1s', fill: 'freeze'}),
          svg('animate', {attributeName: 'opacity', values: '1;0', dur: '1.1s', fill: 'freeze'})); surface.append(dot);
      }
      }
    }
    stage.prepend(surface); wrap.append(stage); canvas.append(wrap);
  }
  function render() {
    if (!opened) return;
    // A live refresh rebuilds the diagram. Retain the user's viewport and the
    // semantic control that had focus when that control still exists.
    const oldDiagram = canvas.querySelector<HTMLElement>('.flow-scroll');
    const positions = {rootTop: root.scrollTop, rootLeft: root.scrollLeft, diagramTop: oldDiagram?.scrollTop ?? 0,
      diagramLeft: oldDiagram?.scrollLeft ?? 0, listTop: list.scrollTop};
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focus = active ? {tag: active.tagName, text: active.textContent, id: active.dataset.flowId,
      role: active.dataset.flowRole, node: active.dataset.flowNode, page: active.dataset.flowPage,
      diagram: active.classList.contains('flow-scroll')} : null;
    renderControls(); const current = options.current();
    const matching = data ? filterEvents(data.events, current, scope, windowSeconds ? options.now() - windowSeconds : 0, kind) : [];
    renderedFilterSignature = matching.map(event => event.id).join('\0');
    const names = new Map<string, Set<string>>();
    for (const person of nodeIds(matching)) { const ids = names.get(person.id) ?? new Set<string>(); ids.add(identityKey(person)); names.set(person.id, ids); }
    ambiguousNames = new Set([...names].filter(([, ids]) => ids.size > 1).map(([name]) => name));
    pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(matching.length / 80) - 1));
    const end = matching.length - pageIndex * 80, start = Math.max(0, end - 80), events = matching.slice(start, end);
    notice.textContent = data?.truncated ? t('flow.truncated') : t('flow.bestEffort');
    const chosen = events.find(event => event.id === selected); showDetail(chosen);
    const node = view === 'graph' ? nodeIds(events).find(item => identityKey(item) === selectedNode) : undefined;
    if (node) {
      detail.replaceChildren(el('p', 'flow-eyebrow', t('flow.inspector')), el('h2', '', t('flow.sessionDetail')),
        el('strong', '', displayIdentity(node)), el('p', 'flow-muted', node.agent),
        el('p', 'flow-detail-note', t('flow.sessionEvents', {n: events.filter(event => identityKey(event.source) === selectedNode || identityKey(event.target) === selectedNode).length})));
    }
    canvas.replaceChildren(); list.replaceChildren();
    if (!data) { count.textContent = ''; pagination.replaceChildren(); return; }
    if (scope === 'current' && !current) canvas.append(el('p', 'flow-empty', t('flow.noCurrent')));
    else if (!events.length) canvas.append(el('p', 'flow-empty', t('flow.empty')));
    else if (view === 'sequence') drawSequence(events); else drawGraph(events);
    count.textContent = t('flow.eventRange', {start: events.length ? start + 1 : 0, end, total: matching.length});
    for (const event of [...events].reverse()) {
      const button = el('button', 'flow-event-row', label(event)); button.type = 'button'; button.setAttribute('aria-pressed', String(selected === event.id));
      button.dataset.flowId = event.id; button.dataset.flowRole = 'list';
      button.addEventListener('click', () => selectEvent(event.id, 'list')); list.append(button);
    }
    pagination.replaceChildren();
    if (matching.length > 80) {
      const newer = el('button', 'btn', t('flow.newer')), older = el('button', 'btn', t('flow.older'));
      newer.type = older.type = 'button'; newer.disabled = pageIndex === 0; older.disabled = start === 0;
      newer.dataset.flowPage = 'newer'; older.dataset.flowPage = 'older';
      newer.addEventListener('click', () => {pageIndex--; render(); pagination.querySelector<HTMLButtonElement>('[data-flow-page="newer"]:not(:disabled)')?.focus();});
      older.addEventListener('click', () => {pageIndex++; render(); pagination.querySelector<HTMLButtonElement>('[data-flow-page="older"]:not(:disabled)')?.focus();});
      pagination.append(older, newer);
    }
    const diagram = canvas.querySelector<HTMLElement>('.flow-scroll');
    if (diagram) { diagram.scrollTop = positions.diagramTop; diagram.scrollLeft = positions.diagramLeft; }
    list.scrollTop = positions.listTop; root.scrollTop = positions.rootTop; root.scrollLeft = positions.rootLeft;
    if (focus) {
      const candidates = [...root.querySelectorAll<HTMLElement>('button, select, .flow-scroll')];
      const next = candidates.find(item => focus.id ? item.dataset.flowId === focus.id && item.dataset.flowRole === focus.role
        : focus.node ? item.dataset.flowNode === focus.node
        : focus.page ? item.dataset.flowPage === focus.page && !(item instanceof HTMLButtonElement && item.disabled)
        : focus.diagram ? item.classList.contains('flow-scroll')
        : item.tagName === focus.tag && item.textContent === focus.text);
      next?.focus({preventScroll: true});
    }
    fresh = new Set();
  }
  async function load() {
    if (!opened || running) return; running = true; const turn = generation; abort = new AbortController();
    if (!data) status.textContent = t('flow.loading');
    try {
      const response = await request('/api/flow/events', {cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw new Error('unavailable');
      const value: unknown = await response.json(), parsed = parseSnapshot(value);
      if (!parsed) throw new Error('invalid');
      if (!opened || turn !== generation) return;
      const signature = JSON.stringify(parsed);
      if (signature === lastSignature && data) {
        status.textContent = '';
        const current = options.current();
        const filtered = filterEvents(data.events, current, scope, windowSeconds ? options.now() - windowSeconds : 0, kind);
        if (filtered.map(event => event.id).join('\0') !== renderedFilterSignature) render();
        return;
      }
      lastSignature = signature;
      const ids = new Set(parsed.events.map(event => event.id));
      fresh = hasLoaded ? new Set(parsed.events.filter(event => !known.has(event.id)).slice(-2).map(event => event.id)) : new Set();
      known = ids; hasLoaded = true; data = parsed; status.textContent = ''; render();
    } catch { if (opened && turn === generation) status.textContent = t('flow.unavailable'); }
    finally { running = false; }
  }
  return {
    open() { if (opened) return; opened = true; generation++; lastSignature = ''; render(); void load(); timer = window.setInterval(() => void load(), 5000); },
    close() { opened = false; generation++; abort?.abort(); window.clearInterval(timer); },
  };
}
