// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { test } from 'node:test';
import { checkProjectBridge } from './project-host-adapter-check.ts';
import assert from 'node:assert/strict';
import { parseHostReply, requestProject, projectReadRequest, PROJECT_MEMBERSHIP_FEATURE, ProjectTransportError, PROJECT_REPLY_BYTES } from '../static/project-host.ts';

test('real owner-only thin project bridge forwards to the native host and keeps Sessions', { timeout: 20000 }, checkProjectBridge);

test('browser rejects incomplete or contradictory host projections and retains multiline context', () => {
  const base = { kind: 'mesh-project-reply', version: 1, op: 'project_read', boot: 'a'.repeat(64), status: 'ok',
    project: { id: 'stable', title: 'A project', description: 'First line\nSecond line', folders_total: 0,
      sources_total: 0, sessions_total: 0, participations_total: 0 } };
  assert.equal(parseHostReply(base, 'project_read').project?.description, 'First line\nSecond line');
  assert.throws(() => parseHostReply({ ...base, op: 'project_create' }, 'project_read'));
  assert.throws(() => parseHostReply({ ...base, boot: '' }, 'project_read'));
  assert.throws(() => parseHostReply({ ...base, project: { ...base.project, folders_total: -1 } }, 'project_read'));
  assert.throws(() => parseHostReply({ ...base, op: 'project_list', projects: [{ id: 'same', title: 'A' },
    { id: 'same', title: 'B' }], complete: true, total: 2 }, 'project_list'));
  assert.throws(() => parseHostReply({ ...base, op: 'project_list', projects: [], total: 1, complete: true }, 'project_list'));
});

test('browser bounds responses and never retries an ambiguous mutation or treats auth denial as native absence', async () => {
  const intent = { op: 'project_create' as const, version: 1 as const, request_id: 'stable-request' };
  let attempts = 0;
  const oversized = async () => { attempts++; return new Response(' '.repeat(PROJECT_REPLY_BYTES + 1)); };
  await assert.rejects(requestProject(oversized, intent), (error: unknown) =>
    error instanceof ProjectTransportError && error.reason === 'uncertain');
  assert.equal(attempts, 1);
  await assert.rejects(requestProject(async () => new Response('denied', { status: 403 }),
    { op: 'project_capabilities', version: 1 }), (error: unknown) =>
    error instanceof ProjectTransportError && error.reason === 'denied');
  const legacy = await requestProject(async () => new Response('Unknown op: project_capabilities', { status: 400 }),
    { op: 'project_capabilities', version: 1 });
  assert.equal(legacy.status, 'unsupported');
  await assert.rejects(requestProject(async () => new Response('Unknown op: project_capabilities', { status: 500 }),
    { op: 'project_capabilities', version: 1 }));
});

test('browser reads every native-supported folder without truncation', () => {
  const folders = Array.from({length:100}, (_,i) => '/context/' + i);
  const reply = parseHostReply({kind:'mesh-project-reply',version:1,op:'project_read',boot:'a'.repeat(64),status:'ok',
    project:{id:'many-folders',title:'Many folders',folders,folders_total:100,sources_total:0,sessions_total:0,participations_total:0}}, 'project_read');
  assert.deepEqual(reply.project?.folders,folders);
});


test('only exact bounded start refusal establishes unsupported admission', async () => {
  const refusal = JSON.stringify({error: 'Unsupported project operation'});
  for (const op of ['project_observation_start', 'project_observation_status', 'project_create'] as const) {
    for (const status of [400, 401, 403, 500]) {
      for (const body of [refusal, 'Unsupported project operation']) {
        await assert.rejects(requestProject(async () => new Response(body, {status}), {op, version: 1}),
          (error: unknown) => error instanceof ProjectTransportError && error.reason ===
            (status === 401 || status === 403 ? 'denied' : op === 'project_create' ? 'uncertain' :
              op === 'project_observation_start' && status === 400 ? 'unsupported' : 'unavailable'));
      }
    }
  }
  for (const body of ['{', '{"error":"Unsupported project operation","extra":true}', '{"error":"Other"}',
    refusal + ' '.repeat(PROJECT_REPLY_BYTES), ' Unsupported project operation', 'Unsupported project operation\n',
    'Unsupported project operations']) {
    await assert.rejects(requestProject(async () => new Response(body, {status: 400}),
      {op: 'project_observation_start', version: 1}),
      (error: unknown) => error instanceof ProjectTransportError && error.reason === 'unavailable');
  }
});


test('membership metadata preserves exact targets and complete versus omitted fields', () => {
  const relation = {id: 'member', label: 'Build 🌍', recorded_relation: 'active', role_label: 'reviewer',
    target: {kind: 'mesh', machine_id: 'local', name: 'build', created: 1700000000.125},
    work_refs: [{source_id: 'roadmap', kind: 'task', native_id: 'VA'}]};
  const project = {id: 'p', title: 'P', folders_total: 0, sources_total: 0, sessions_total: 0, participations_total: 1};
  const base = {kind: 'mesh-project-reply', version: 1, op: 'project_read', boot: 'a'.repeat(64), status: 'ok', project};
  const membership = {sessions: [], participations: [relation], complete: true, omitted_fields: []};
  const parsed = parseHostReply({...base, membership}, 'project_read') as any;
  assert.deepEqual(parsed.membership, membership);
  relation.target.created = 1700000001.125;
  assert.equal(parsed.membership.participations[0].target.created, 1700000000.125, 'raw reply cannot change captured target');
  assert.equal((parseHostReply(base, 'project_read') as any).membership, undefined, 'absence is not an empty membership');
  assert.deepEqual((parseHostReply({...base, membership: {participations: [relation], complete: false,
    omitted_fields: ['sessions']}}, 'project_read') as any).membership,
  {participations: [relation], complete: false, omitted_fields: ['sessions']});
  assert.deepEqual((parseHostReply({...base, membership: {sessions: [], complete: false,
    omitted_fields: ['participations']}}, 'project_read') as any).membership,
  {sessions: [], complete: false, omitted_fields: ['participations']});
  const empty = {...project, participations_total: 0};
  assert.deepEqual((parseHostReply({...base, project: empty, membership: {sessions: [], participations: [],
    complete: true, omitted_fields: []}}, 'project_read') as any).membership,
  {sessions: [], participations: [], complete: true, omitted_fields: []});
});

test('membership metadata refuses malformed identities bounds and completeness contradictions', () => {
  const row = {id: 'member', recorded_relation: 'historical', target: {kind: 'history', agent: 'codex', conversation_id: 'conversation'}};
  const base = {kind: 'mesh-project-reply', version: 1, op: 'project_read', boot: 'a'.repeat(64), status: 'ok',
    project: {id: 'p', title: 'P', folders_total: 0, sources_total: 0, sessions_total: 0, participations_total: 1}};
  const membership = {sessions: [], participations: [row], complete: true, omitted_fields: []};
  assert.deepEqual((parseHostReply({...base, membership}, 'project_read') as any).membership, membership);
  for (const invalid of [ {...membership, authority: true}, {...membership, complete: false},
    {...membership, omitted_fields: ['sessions']}, {...membership, participations: []},
    {...membership, participations: [row, row]}, {...membership, participations: null},
    {...membership, omitted_fields: ['sessions', 'sessions']}, {...membership, sessions: Array(101).fill({name: 'x', created: 1})},
    {...membership, participations: [{...row, target: {...row.target, agent: 'unknown'}}]},
    {...membership, participations: [{...row, recorded_relation: ['historical']}]},
    {...membership, participations: [{...row, target: {...row.target, agent: ['codex']}}]},
    {...membership, participations: [{...row, target: {...row.target, name: 'typed-name'}}]},
    {...membership, participations: [{...row, work_refs: [{source_id: 'source', kind: 'task', native_id: 'same'},
      {source_id: 'source', kind: 'task', native_id: 'same'}]}]},
    ...[Number.MAX_SAFE_INTEGER + 1, -1, Infinity, NaN, '42'].map(created => ({...membership,
      participations: [{...row, target: {kind: 'mesh', name: 'build', created}}]})),
    {...membership, participations: [{...row, target: {kind: 'mesh', name: 'bad\ud800', created: 42}}]},
    {...membership, participations: [{...row, target: {kind: 'mesh', name: 'same', created: 42, machine_id: ''}}]},
  ]) assert.throws(() => parseHostReply({...base, membership: invalid}, 'project_read'));
  assert.throws(() => parseHostReply({...base, membership, project: undefined}, 'project_read'));
});

test('membership wire rejects duplicate keys rather than manufacturing completeness', async () => {
  const body = '{"kind":"mesh-project-reply","version":1,"op":"project_read","boot":"' + 'a'.repeat(64) +
    '","status":"ok","project":{"id":"p","title":"P","folders_total":0,"sources_total":0,"sessions_total":0,"participations_total":0},' +
    '"membership":{"sessions":[],"participations":[],"complete":false,"complete":true,"omitted_fields":[]}}';
  let attempts = 0;
  await assert.rejects(requestProject(async () => { attempts++; return new Response(body); },
    {op: 'project_read', version: 1, project_id: 'p'}),
  (error: unknown) => error instanceof ProjectTransportError && error.reason === 'unavailable');
  assert.equal(attempts, 1, 'no retry or downgrade after malformed read');
});


test('membership selector requires exact advertised owner capability from the same boot', async () => {
  const boot = 'a'.repeat(64), op = 'project_capabilities';
  const cap = (features: unknown) => parseHostReply({kind: 'mesh-project-reply', version: 1, op, boot, status: 'ok', features}, op);
  const ordinary = {op: 'project_read', version: 1, project_id: 'p'};
  const absent = cap(['project-registry/1']);
  assert.equal(JSON.stringify(projectReadRequest('p', absent, boot)), JSON.stringify(ordinary), 'release14 and frozen fde bytes remain unchanged');
  assert.deepEqual(projectReadRequest('p', cap([PROJECT_MEMBERSHIP_FEATURE]), boot), {...ordinary, memberships: true});
  for (const capability of [null, absent, cap([]), cap(['project-memberships/2']), cap(['project-memberships/1 ']),
    cap(['PROJECT-MEMBERSHIPS/1']), {...cap([PROJECT_MEMBERSHIP_FEATURE]), op: 'project_read'},
    {...cap([PROJECT_MEMBERSHIP_FEATURE]), status: 'unavailable'}, {...cap([PROJECT_MEMBERSHIP_FEATURE]), boot: 'b'.repeat(64)}])
    assert.deepEqual(projectReadRequest('p', capability, boot), ordinary);
  for (const features of [PROJECT_MEMBERSHIP_FEATURE, [true], [PROJECT_MEMBERSHIP_FEATURE, PROJECT_MEMBERSHIP_FEATURE], Array(33).fill('unknown')])
    assert.throws(() => cap(features));
  assert.throws(() => parseHostReply({kind: 'mesh-project-reply', version: 1, op, boot, status: ['ok'],
    features: [PROJECT_MEMBERSHIP_FEATURE]}, op), 'an array cannot advertise successful capability');
  const bodies: string[] = [];
  const reply = {kind: 'mesh-project-reply', version: 1, op: 'project_read', boot, status: 'ok',
    project: {id: 'p', title: 'P', folders_total: 0, sources_total: 0, sessions_total: 0, participations_total: 0}};
  await requestProject(async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify(reply)); },
    projectReadRequest('p', absent, boot));
  assert.deepEqual(bodies, [JSON.stringify(ordinary)]);
});


test('an attempted advertised membership read never downgrades or retries on refusal', async () => {
  const boot = 'a'.repeat(64), capability = parseHostReply({kind: 'mesh-project-reply', version: 1,
    op: 'project_capabilities', boot, status: 'ok', features: [PROJECT_MEMBERSHIP_FEATURE]}, 'project_capabilities');
  const bodies: string[] = [];
  await assert.rejects(requestProject(async (_url, init) => { bodies.push(String(init?.body));
    return new Response('invalid request', {status: 400}); }, projectReadRequest('p', capability, boot)),
  (error: unknown) => error instanceof ProjectTransportError && error.reason === 'unavailable');
  assert.deepEqual(bodies, [JSON.stringify({op: 'project_read', version: 1, project_id: 'p', memberships: true})]);
});


test('membership wire retains fractional identity and full hundred-row bounds', async () => {
  const rows = Array.from({length: 100}, (_, index) => ({id: 'row-' + index, recorded_relation: 'saved',
    target: {kind: 'mesh', machine_id: 'recorded', name: 'session-' + index, created: 1700000000.125 + index}}));
  const reply = {kind: 'mesh-project-reply', version: 1, op: 'project_read', boot: 'a'.repeat(64), status: 'ok',
    project: {id: 'p', title: 'P', folders_total: 0, sources_total: 0, sessions_total: 0, participations_total: 100},
    membership: {sessions: [], participations: rows, complete: true, omitted_fields: []}};
  const parsed = await requestProject(async () => new Response(JSON.stringify(reply)), {op: 'project_read', version: 1, project_id: 'p'});
  assert.deepEqual(parsed.membership?.participations, rows);
});
