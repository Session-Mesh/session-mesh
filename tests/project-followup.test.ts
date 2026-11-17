// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { window, part } from '../static/project-followup-primitives.ts';
import { recordedInstant, observedInterval, ObservationAge } from '../static/project-followup-time.ts';
import { dependencyGraph, durationGeometry } from '../static/project-followup-graph.ts';
import { readFollowupContext, resolveFollowupLinks } from '../static/project-followup-context.ts';
import { ProjectFollowupController } from '../static/project-followup-controller.ts';
import { FollowupPreferenceStore } from '../static/project-followup-preferences.ts';
import { acceptedReceipt, roadmapRows, estimateMinutes, rowGraph, taskCoverage } from '../static/project-followup-model.ts';
import { followupCatalog, roadmapObservation, roadmapTask, attemptObservation } from './helpers/project-followup-fixtures.ts';

test('followup fields enforce closed family boundaries', () => {
  const read = (value: unknown) => { assert.equal(typeof value, 'string'); return value as string; };
  assert.deepEqual(window({ items: [], total: 0, truncated: false }, 2, read), { items: [], total: 0, truncated: false });
  assert.throws(() => window({ items: [], total: 3, truncated: true }, 2, read));
  assert.throws(() => window({ items: [], total: null, truncated: false }, 2, read));
  assert.throws(() => part({ availability: 'not-provided', reason: 'not-in-source', text_truncated: false, truncated: false, value: 'unsafe' }, read));
  assert.throws(() => part({ availability: 'valid', reason: null, text_truncated: false, truncated: true, value: 'text' }, read));
  assert.throws(() => part({ availability: 'valid', reason: null, text_truncated: false, truncated: false, value: null }, read));
});
test('recorded instants qualify arithmetic without rewriting text', () => {
  assert.equal(observedInterval('2026-11-14T10:00:00+01:00', null, '2026-11-14T09:10:00Z'), 10);
  for (const value of ['2026-02-30T10:00:00Z', '2026-11-14', '2026-11-14T10:00:00', '2026-11-14T10:00:60Z', '2026-11-14T10:00:00.1234Z']) assert.equal(recordedInstant(value), null);
  assert.equal(recordedInstant('2024-02-29T10:00:00Z'), Date.parse('2024-02-29T10:00:00Z'));
  assert.equal(observedInterval('2026-11-14T10:00:00Z', null, '2026-11-14T09:00:00Z'), null);
});
test('source age survives clock rollback and hidden resume', () => {
  const age = new ObservationAge(), observation = '2026-11-14T09:00:00Z', wall = Date.parse(observation);
  assert.equal(age.age(observation, wall + 60000, 0), 60000);
  assert.equal(age.age(observation, wall, 90000), 150000);
  assert.equal(age.age(observation, wall + 100000, 100000), 160000);
  assert.equal(new ObservationAge().age(observation, wall - 1, 0), null);
  assert.equal(age.age(observation, wall - 1, 110000), null);
  assert.equal(age.age(observation, wall + 100000, 120000), 180000);
});
test('duration bars preserve known scale unknowns and zero', () => {
  const [ten, twenty, unknown, zero] = durationGeometry([10, 20, null, 0], 1000);
  assert.equal(ten?.width, 500); assert.equal(twenty?.width, 1000);
  assert.equal(unknown?.kind, 'unknown'); assert.equal(zero?.kind, 'point');
});
test('dependency gaps and cycles retain selectable rows', () => {
  const graph = dependencyGraph([{ id: 'a', dependsOn: ['b'], length: 10 }, { id: 'b', dependsOn: ['a'], length: 20 },
    { id: 'c', dependsOn: ['b'], length: 5 }, { id: 'd', dependsOn: ['absent'], length: null }]);
  assert.deepEqual(graph.unresolved, ['a', 'b', 'c']); assert.deepEqual(graph.missing, ['d']);
  assert.equal(graph.levels.get('d'), null); assert.equal(graph.schedule, null);
});
test('dependency calculations remain distinct from source forecasts', () => {
  const graph = dependencyGraph([{ id: 'a', dependsOn: [], length: 10 }, { id: 'b', dependsOn: ['a'], length: 20 }]);
  assert.deepEqual(graph.schedule?.get('b'), { start: 10, end: 30 });
  assert.equal(dependencyGraph([{ id: 'a', dependsOn: ['a'], length: 10 }]).schedule, null);
});
test('accepted receipt requires matching current source evidence', () => {
  const catalog = followupCatalog(roadmapObservation([roadmapTask({ state: 'done', attempts: 1,
    timeline: [attemptObservation(1, { outcome: 'done' })], last_result: { result: 'done', summary: 'Reviewed deliverable', attempt_id: 'attempt-1', evidence: [] } })]));
  const summary = catalog.projects[0]!.sources[0]!.summary!, detail = summary.followup!.task_details.items[0]!, item = summary.items[0]!;
  assert.equal(acceptedReceipt(item, detail, summary), true);
  for (const alter of [() => { detail.last_result.value!.attempt_id = null; }, () => { summary.followup!.metadata.value!.contract_accepted = false; },
    () => { item.attempts = 2; }]) {
    const original = structuredClone({ item, detail, summary }); alter(); assert.equal(acceptedReceipt(item, detail, summary), false);
    Object.assign(item, original.item); Object.assign(detail, original.detail); Object.assign(summary, original.summary);
  }
  assert.equal(roadmapRows(summary)[0]?.meaning, 'accepted-receipt');
});
test('display links revalidate exact identities and observations', () => {
  const now = Date.parse('2026-11-14T12:00:00Z'), catalog = followupCatalog(), project = catalog.projects[0]!;
  const input = { schema_version: 1, availability: 'provided', observed_at: '2026-11-14T12:00:00Z', revision: 'one', provenance: 'Explicit caller binding', reason: null,
    links: [{ parent: { kind: 'roadmap-task', machine_id: 'host', project_id: 'one', source_id: 'roadmap', board_id: 'delivery', task_id: 'task', source_revision: null, contract_digest: null },
      child: { kind: 'pipeline-task', machine_id: 'host', project_id: 'one', source_id: 'child', task_id: 'release', source_revision: null } }] };
  assert.equal(readFollowupContext().availability, 'unsupported');
  assert.equal(readFollowupContext(input).availability, 'provided');
  assert.equal(resolveFollowupLinks(readFollowupContext(input), 'host', project, now)[0]?.valid, false);
  assert.equal(resolveFollowupLinks(readFollowupContext(input), 'other', project, now)[0]?.reason, 'unresolved-identity');
  assert.equal(readFollowupContext({ ...input, links: [...input.links, ...input.links] }).availability, 'invalid');
  assert.equal(readFollowupContext({ ...input, extra: true }).availability, 'invalid');
  assert.equal(readFollowupContext({ ...input, observed_at: 'yesterday' }).availability, 'invalid');
});
test('bounded preferences keep only interface choices and survive storage refusal', () => {
  let serialized = '';
  const store = new FollowupPreferenceStore('view', { getItem: () => null, setItem: (_key, value) => { serialized = value; } });
  for (let index = 0; index < 250; index++) store.write(String(index), { mode: 'timeline', selected: 'task', page: 900, zoom: 99, left: Infinity, top: -1, inspectorTop:Infinity, attemptPage: 99,
    disclosures: Array.from({ length: 500 }, (_, i) => `part-${i}`) });
  assert.ok(new TextEncoder().encode(serialized).byteLength <= 65536);
  assert.ok(JSON.parse(serialized).length <= 200);
  assert.equal(store.read('249').zoom, 4); assert.equal(store.read('249').page, 3); assert.equal(store.read('249').disclosures.length, 200);
  assert.equal(store.read('249').inspectorTop,0);
  store.write('pane',{...store.read('249'),inspectorTop:1e9});assert.equal(store.read('pane').inspectorTop,32768);
  const unavailable = new FollowupPreferenceStore('view', { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('full'); } });
  unavailable.write('source', store.read('249')); assert.equal(unavailable.read('source').selected, 'task');
  for (const mode of ['timeline-total', 'timeline-remaining'] as const) {
    store.write('source', { ...store.read('249'), mode }); assert.equal(store.read('source').mode, mode);
  }
});
test('closed claims with unknown endpoints do not become open lifetimes', () => {
  const catalog = followupCatalog(roadmapObservation([roadmapTask({ attempts: 1, timeline: [attemptObservation(1, { ended_at: null })] })]));
  assert.equal(roadmapRows(catalog.projects[0]!.sources[0]!.summary!)[0]?.duration, null);
});

test('estimate modes preserve separate likely minutes and complete task coverage', () => {
  const range = (likely: number) => ({ optimistic: likely, likely, pessimistic: likely });
  const tasks = [10, 20, null, 0].map((likely, index) => roadmapTask({ id: String(index), state: 'done', estimate: likely === null ? null :
    { id: String(index), status: 'conditional', duration_minutes: range(likely), remaining_minutes: null, source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] } }));
  const summary = followupCatalog(roadmapObservation(tasks)).projects[0]!.sources[0]!.summary!;
  const rows = roadmapRows(summary);
  assert.deepEqual(rows.map(row => estimateMinutes(row, 'timeline-total')), [10, 20, null, 0]);
  assert.deepEqual(rows.map(row => estimateMinutes(row, 'timeline-remaining')), [null, null, null, null]);
  assert.ok(rows.every(row => row.duration === null)); assert.equal(taskCoverage(summary), true);
  assert.equal(rowGraph(rows, summary).timing, null);
});
test('qualified remaining graph reports span slack and possible task overlap', () => {
  const independent = [{ id: 'a', dependsOn: [], length: 20 }, { id: 'b', dependsOn: [], length: 20 }];
  const graph = dependencyGraph(independent);
  assert.equal(graph.timing?.span, 20); assert.equal(graph.timing?.overlap, 2);
  assert.deepEqual(graph.timing?.zeroSlack, ['a', 'b']);
  assert.deepEqual([...graph.timing!.slack], [['a', 0], ['b', 0]]);
  assert.equal(dependencyGraph(independent, false).schedule, null);
  assert.equal(dependencyGraph(independent, false).timing, null);
  const unequal = dependencyGraph([{ ...independent[0]!, length: 10 }, independent[1]!]);
  assert.equal(unequal.timing?.slack.get('a'), 10); assert.deepEqual(unequal.timing?.zeroSlack, ['b']);
});
test('task window coverage does not inherit unrelated operator truncation', () => {
  const range = { optimistic: 20, likely: 20, pessimistic: 20 };
  const estimate = { id: 'task', status: 'conditional', duration_minutes: range, remaining_minutes: range, source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] };
  const summary = followupCatalog(roadmapObservation([roadmapTask({ estimate })])).projects[0]!.sources[0]!.summary!;
  summary.followup!.truncated = true; summary.truncated = true;
  assert.equal(taskCoverage(summary), true); assert.equal(rowGraph(roadmapRows(summary), summary).timing?.span, 20);
  summary.followup!.task_details.truncated = true; summary.followup!.task_details.total = 201;
  assert.equal(taskCoverage(summary), false); assert.equal(rowGraph(roadmapRows(summary), summary).schedule, null);
});

test('followup only mouse drags capture and write scroll while touch keeps tap and drag invalidation', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    let left = 40, writes = 0, captures = 0;
    const chart = { get scrollLeft() { return left; }, set scrollLeft(value: number) { left = value; writes++; },
      setPointerCapture() { captures++; } };
    // Exercise the production pointer handlers without constructing a DOM, timer or provider.
    const controller = Object.assign(Object.create(ProjectFollowupController.prototype), {
      options: { root: { querySelector: () => chart } }, pointers: new Set<number>(), pointer: null, invalidClick: false,
    });
    const pointer = (x: number, id = 1) => ({ pointerId: id, pointerType, clientX: x, clientY: 20 });
    controller.pointerDown(pointer(100)); controller.pointerMove(pointer(97));
    assert.equal(controller.invalidClick, false, `${pointerType} clean tap stays actionable`);
    controller.pointerMove(pointer(60));
    assert.equal(controller.invalidClick, true, `${pointerType} drag cannot activate a row`);
    assert.equal(writes, pointerType === 'mouse' ? 1 : 0, `${pointerType} scroll ownership`);
    assert.equal(captures, pointerType === 'mouse' ? 1 : 0, `${pointerType} capture ownership`);
    assert.equal(left, pointerType === 'mouse' ? 80 : 40);
    controller.invalidate(); controller.pointerMove(pointer(30));
    assert.equal(controller.pointer, null); assert.equal(controller.invalidClick, true);
    assert.equal(writes, pointerType === 'mouse' ? 1 : 0, 'cancelled tracking cannot write scroll');
    controller.pointers.clear(); controller.pointerDown(pointer(100)); controller.pointerDown(pointer(90, 2));
    assert.equal(controller.pointer, null); assert.equal(controller.invalidClick, true, 'multitouch invalidates click');
  }
});
