// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProjectConfig, parseProjectCatalog, PROJECT_LIMITS, PIPELINE_COMPONENTS, PIPELINE_UNSUPPORTED } from '../static/project-catalog.ts';
import { roadmapTask, roadmapObservation, attemptObservation, followupCatalog } from './helpers/project-followup-fixtures.ts';
import { pipelineRows } from '../static/project-followup-model.ts';

const config = () => ({ kind: 'mesh-project-config', schema_version: 1, machine_id: 'host',
  projects: [{ id: 'one', title: '<b>One</b>', sources: [], sessions: [] }] });
const catalog = () => ({ ...config(), kind: 'mesh-project-catalog', revision: 'abc', generated_at: '2026-11-14T12:00:00Z' });

test('pipeline DTO preserves an explicit unknown outcome without granting a verdict', () => {
  const components = Object.fromEntries(PIPELINE_COMPONENTS.map(name => [name,
    {availability: name === 'ledger' ? 'valid' : 'absent', reason: null, truncated: false}]));
  const pipeline = {task: 'release-check', availability: 'valid', mode: 'fast', latest_completed: {phase: 'review', outcome: null},
    verdict_disagreement: null, components, history: {total: 1, truncated: false, items: [{source_index: 0, phase: 'review', outcome: null,
      reason: null, reason_truncated: false, actor: {availability: 'unknown', value: null, truncated: false}, time: {availability: 'unknown', value: null}}]},
    review: null, qa: null, qa_markdown_status: null,
    coverage: PIPELINE_UNSUPPORTED.map(id => ({id, availability: 'unsupported', limitations: 'No delegated verdict authority'}))};
  const value = catalog(); value.projects[0].sources.push({id: 'pipeline', kind: 'roster', label: 'Pipeline', status: 'available',
    observed_at: value.generated_at, summary: {provider_schema: 'pipeline-task', provider_version: 1,
      source_generated_at: value.generated_at, source_revision: 'a'.repeat(64), counts: {}, items: [], pipeline, truncated: false, more: null}});
  const result = parseProjectCatalog(value);
  assert.ok(result);
  assert.equal(result.projects[0].sources[0].summary.pipeline.latest_completed.outcome, null);
  assert.equal(result.projects[0].sources[0].summary.pipeline.history.items[0].outcome, null);
  assert.equal(result.projects[0].sources[0].summary.pipeline.review, null);
  assert.equal(pipelineRows(result.projects[0].sources[0].summary.pipeline)[0].state, 'unknown');
  for (const change of [
    p => { delete p.latest_completed.outcome; },
    p => { p.latest_completed.phase = 'unknown'; p.history.items[0].phase = 'unknown'; },
    p => { p.latest_completed.outcome = 'PASS'; p.history.items[0].outcome = 'PASS'; },
    p => { p.latest_completed.outcome = ['GO']; p.history.items[0].outcome = ['GO']; },
  ]) {
    const invalid = structuredClone(value); change(invalid.projects[0].sources[0].summary.pipeline);
    assert.equal(parseProjectCatalog(invalid), null);
  }
});

test('catalog version two admits the followup feature', () => {
  const value = { ...catalog(), schema_version: 2, features: ['roster-followup/1'] };
  assert.ok(parseProjectCatalog(value));
  assert.equal(parseProjectCatalog({ ...value, features: [] }), null);
  assert.equal(parseProjectCatalog({ ...value, features: ['roster-followup/1', 'roster-followup/1'] }), null);
  assert.equal(parseProjectCatalog({ ...value, features: ['unknown/1'] }), null);
  assert.equal(parseProjectCatalog({ ...catalog(), features: ['roster-followup/1'] }), null);
});
test('normalized followup rejects extra keys inconsistent windows and discriminator contradictions', () => {
  const c = followupCatalog();
  const mutations = [
    f => { f.extra = 'unexpected'; },
    f => { f.metadata.value.extra = true; },
    f => { f.metadata.reason = 'contradiction'; },
    f => { f.metadata.truncated = true; },
    f => { f.task_details.total = null; f.task_details.truncated = true; f.truncated = true; },
    f => { f.task_details.items[0].id = 'different'; },
    f => { f.task_details.items[0].budget.value.max_attempts = -1; },
    f => { f.task_details.items[0].assignment.value = {}; },
    f => { f.task_details.items[0].progress.value.status = 'unreported'; },
    f => { f.task_details.items[0].lineage.value.parent = 'invented'; },
    f => { f.events.value.total = 10; },
    f => { f.events.value.truncated = true; f.events.truncated = true; f.truncated = true; },
    f => { f.forecast.value = {}; },
    f => { f.truncated = true; },
  ];
  for (const mutate of mutations) {
    const clone = structuredClone(c); mutate(clone.projects[0].sources[0].summary.followup);
    assert.equal(parseProjectCatalog(clone), null);
  }
  assert.equal(parseProjectCatalog({ ...c, schema_version: 1 }), null);
  const nonRoster = structuredClone(c); nonRoster.projects[0].sources[0].kind = 'other';
  assert.equal(parseProjectCatalog(nonRoster), null);
});
test('receipt contradictions reject selected data while independent invalid coverage remains admissible', () => {
  const raw = roadmapObservation([roadmapTask({ state: 'done', attempts: 1,
    timeline: [attemptObservation(1, { outcome: 'done' })],
    last_result: { result: 'done', summary: 'Delivered', attempt_id: 'attempt-1', evidence: [] } })]);
  const c = followupCatalog(raw), f = c.projects[0].sources[0].summary.followup;
  assert.equal(f.task_details.items[0].last_result.value.result, 'done');
  const invalidLineage = structuredClone(raw); invalidLineage.tasks[0].kind = 'invalid';
  assert.equal(followupCatalog(invalidLineage).projects[0].sources[0].summary.followup.task_details.items[0].last_result.availability, 'valid');
  for (const mutate of [
    d => { d.last_result.value.attempt_id = 'other'; },
    d => { d.assignment.value = { id: 'other', assignee: null, runtime: null, role: null, route: null, model: null }; },
    d => { d.timeline.value.items[0].attempt = 2; },
    d => { d.timeline.value.items[0].outcome = 'active'; },
  ]) {
    const clone = structuredClone(c); mutate(clone.projects[0].sources[0].summary.followup.task_details.items[0]);
    assert.equal(parseProjectCatalog(clone), null);
  }
});

test('explicit config preserves stable identities and inert strings', () => {
  assert.equal(parseProjectConfig(config())?.projects[0]?.title, '<b>One</b>');
  assert.equal(parseProjectCatalog(catalog())?.projects[0]?.id, 'one');
});
test('reject unsupported schemas, duplicates, unsafe links and excess bounds', () => {
  assert.equal(parseProjectConfig({ ...config(), schema_version: 2 }), null);
  const duplicate = config(); duplicate.projects.push(duplicate.projects[0]!);
  assert.equal(parseProjectConfig(duplicate), null);
  for (const url of ['javascript:alert(1)', 'file:///tmp/x', 'https://user:pass@example.com']) {
    const c = config(); Object.assign(c.projects[0]!, { repository: { url } });
    assert.equal(parseProjectConfig(c), null);
  }
  assert.equal(parseProjectConfig({ ...config(), projects: Array(PROJECT_LIMITS.projects + 1).fill(config().projects[0]) }), null);
});
test('catalog parser rejects locators/credentials/unknown fields and actionable sessions', () => {
  assert.equal(parseProjectCatalog({ ...catalog(), token: 'secret' }), null);
  const c = catalog(); Object.assign(c.projects[0]!, { sessions: [{ name: 's', created: '2026-11-14T12:00:00Z', command: 'bad' }] });
  assert.equal(parseProjectCatalog(c), null);
});
test('bounded normalized source retains totals, truncation and separate acceptance', () => {
  const c = catalog(); Object.assign(c.projects[0]!, { sources: [{ id: 'roster', kind: 'roster', label: 'Roadmap', status: 'available', observed_at: c.generated_at,
    summary: { provider_schema: 'roster-roadmap-view', provider_version: 1, global_accepted: false,
      counts: { done: 300 }, items: [{ id: 'task', title: 'Task', state: 'done' }], truncated: true, more: 299 } }] });
  const result = parseProjectCatalog(c);
  assert.equal(result?.projects[0]?.sources[0]?.summary?.global_accepted, false);
  assert.equal(result?.projects[0]?.sources[0]?.summary?.more, 299);
  assert.equal(parseProjectCatalog({ ...c, generated_at: 'yesterday' }), null);
  assert.equal(parseProjectCatalog({ ...c, generated_at: '2026-02-31T12:00:00Z' }), null);
});
test('session incarnation stays exact finite numeric data and creates no navigation authority', () => {
  const c = catalog(), created = 1794657432.123456;
  Object.assign(c.projects[0]!, { sessions: [{ name: 'arbitrary-local-name', created, machine_id: 'foreign' }] });
  assert.equal(parseProjectCatalog(c)?.projects[0]?.sessions[0]?.created, created);
  for (const invalid of [NaN, Infinity, -1, '2026-11-14T00:00:00Z']) {
    Object.assign(c.projects[0]!, { sessions: [{ name: 'x', created: invalid }] });
    assert.equal(parseProjectCatalog(c), null);
  }
});
test('config cannot grant executable or argument authority and bounds bytes independently of characters', () => {
  const c = config(); Object.assign(c.projects[0]!, { sources: [{ id: 'x', kind: 'roster', label: 'X', executable: '/tmp/evil', args: ['bad'] }] });
  assert.equal(parseProjectConfig(c), null);
  assert.equal(parseProjectConfig(' '.repeat(PROJECT_LIMITS.bytes + 1)), null);
  assert.equal(parseProjectConfig({ ...config(), machine_id: '__proto__' })?.machine_id, '__proto__');
});
test('catalog requires explicit arrays so missing observations are not silently empty', () => {
  const c = catalog(); const row = c.projects[0]! as Record<string, unknown>;
  delete row.sources;
  assert.equal(parseProjectCatalog(c), null);
});

test('pipeline locator is explicit paired exclusive and keeps canonical task bounds separate', () => {
  const c = config();
  const source = { id: 'delivery', kind: 'roster', label: 'Delivery', pipeline_root: '/tmp/pipeline', pipeline_task: 'a'.repeat(120) };
  Object.assign(c.projects[0]!, { sources: [source] });
  assert.ok(parseProjectConfig(c));
  for (const bad of [
    { ...source, pipeline_task: undefined }, { ...source, pipeline_root: undefined },
    { ...source, board_path: '/tmp/board' }, { ...source, kind: 'other' },
    { ...source, pipeline_task: 'a'.repeat(121) }, { ...source, pipeline_task: 'Bad_task' },
    { ...source, id: 'a'.repeat(81) }, { ...source, pipeline_root: 'relative' },
  ]) {
    Object.assign(c.projects[0]!, { sources: [bad] });
    assert.equal(parseProjectConfig(c), null);
  }
});

test("I1 project JSON rejects duplicate members before typed admission", () => {
  assert.equal(parseProjectConfig(`{"kind":"mesh-project-config","schema_version":1,"machine_id":"wrong","machine_id":"host","projects":[]}`), null);
});

import { parseJsonStrict } from "../static/demo-view-contract.ts";
test("I1 explicit project parse profile preserves demo defaults and finite incarnations", () => {
  for (const source of ["1.25", "1e2", "-0", JSON.stringify(Array.from({length: 513}, () => 1))]) assert.throws(() => parseJsonStrict(source));
  assert.equal(parseJsonStrict("1.25", "project"), 1.25);
  assert.equal(parseJsonStrict("1e2", "project"), 100);
  assert.equal(parseJsonStrict(JSON.stringify(Array.from({length: 8192}, () => 1)), "project").length, 8192);
  for (const source of ["1e999", "01", "1.", `{"x":1,"\\u0078":2}`, `"\\ud800"`, ' + String.fromCharCode(0xd800) + ']) assert.throws(() => parseJsonStrict(source, "project"));
  assert.throws(() => parseJsonStrict("[".repeat(66) + "0" + "]".repeat(66), "project"));
  assert.throws(() => parseJsonStrict(' + x.repeat(2097152 + 8192) + ', "project"));
});
