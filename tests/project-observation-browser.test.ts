// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHostReply } from '../static/project-host.ts';
const boot = 'a'.repeat(64), revision = `cfg1_${'b'.repeat(64)}`;
test('typed project settings survive the host boundary without synthesizing an empty projection', () => {
  const settings = { kind: 'project', plan: { repository: false, source_ids: ['board'] }, repository: null,
    source_summaries: [{ id: 'board', kind: 'roster', label: 'Board', selector_configured: true }] };
  const parsed = parseHostReply({ kind: 'mesh-project-reply', version: 1, op: 'project_read', boot, revision,
    machine_id: 'runner', status: 'ok', observation_settings: settings }, 'project_read');
  assert.deepEqual((parsed as unknown as Record<string, unknown>).observation_settings, settings);
});

import { createHash } from 'node:crypto';
import { ProjectObservationReader, parseObservationReply } from '../static/project-observation.ts';
import { followupCatalog } from './helpers/project-followup-fixtures.ts';
const observationId = 'c'.repeat(64), requestId = '11111111-1111-4111-8111-111111111111';
const target = { boot, revision, machine_id: 'host', project_id: 'one' };
function fixture(options: { badDigest?: boolean; badPage?: boolean; stale?: boolean; unknown?: boolean; abandon?: boolean; split?: boolean } = {}) {
  const catalog = followupCatalog(); catalog.features.push('project-metadata/1');
  let text = JSON.stringify(catalog);
  if (options.split) {
    // Exact catalog maximum; a scalar straddles the first canonical raw-page boundary.
    const marker = '"title":"Delivery"';
    const index = text.indexOf(marker), prefix = '"title":';
    const padding = 131071 - Buffer.byteLength(text.slice(0, index) + prefix + '"Delivery');
    text = text.replace(marker, prefix + ' '.repeat(padding) + '"Delivery🌍"');
    text += ' '.repeat(2097152 - Buffer.byteLength(text));
  }
  const bytes = Buffer.from(text), descriptor = { observation_id: observationId, boot, machine_id: 'host', project_id: 'one', captured_revision: revision,
    byte_length: bytes.length, page_count: Math.ceil(bytes.length / 131072), raw_page_bytes: 131072,
    sha256: options.badDigest ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), captured_at: '2026-11-15T12:00:00Z', published_at: '2026-11-15T12:00:01Z' };
  const calls: string[] = []; let live = true;
  const request = async (_url: string, init?: RequestInit) => {
    const value = JSON.parse(init?.body as string); calls.push(value.op);
    if (value.op === 'project_read') return Response.json({ kind: 'mesh-project-reply', version: 1, op: value.op, boot, status: 'ok', machine_id: 'host',
      revision: options.stale ? `cfg1_${'f'.repeat(64)}` : revision,
      project: { id: 'one', title: 'Delivery', folders_total: 0, sources_total: 0, sessions_total: 0, participations_total: 0 } });
    const reply: Record<string, unknown> = { kind: 'mesh-project-reply', version: 1, op: value.op, boot, status: 'ok', request_id: requestId,
      observation_id: observationId, requested_scope: { machine_id: 'host', project_id: 'one', revision } };
    if (options.unknown && value.op === 'project_observation_status') return Response.json({ ...reply, code: 'unknown' });
    Object.assign(reply, { observation_state: 'complete', identity_retention_ms: 120000, remaining_ms: 120000, descriptor });
    if (value.op === 'project_observation_start') Object.assign(reply, { cancel_token: 'd'.repeat(64), replayed: false });
    if (value.op === 'project_observation_page') {
      const page = bytes.subarray(value.page_index * 131072, (value.page_index + 1) * 131072);
      Object.assign(reply, { page_index: options.badPage ? value.page_index + 1 : value.page_index, data_base64: page.toString('base64') });
      if (options.abandon) live = false;
    }
    return Response.json(reply);
  };
  return { reader: new ProjectObservationReader(request, target, () => live, requestId), calls };
}
test('full bounded pages admit one selected catalog only after final native identity read', async () => {
  const { reader, calls } = fixture(); await reader.start(); assert.equal((await reader.assemble()).projects[0]!.id, 'one');
  assert.equal(calls.at(-1), 'project_read'); assert.equal(calls.filter(op => op === 'project_observation_start').length, 1);
});
for (const option of ['badDigest', 'badPage', 'stale', 'abandon'] as const) test(`observation ${option} rejects current admission without replay or cancel`, async () => {
  const { reader, calls } = fixture({ [option]: true }); await reader.start(); await assert.rejects(reader.assemble());
  assert.equal(calls.filter(op => op === 'project_observation_start').length, 1); assert.ok(!calls.includes('project_observation_cancel'));
});
test('unknown retained handle remains explicit and cannot assemble empty success', async () => {
  const { reader } = fixture({ unknown: true }); await reader.start(); assert.equal((await reader.status()).code, 'unknown');
  await assert.rejects(reader.assemble());
});
test('unknown is a code and cannot carry data, descriptor, lifetime state or token', () => {
  const raw = { kind: 'mesh-project-reply', version: 1, op: 'project_observation_status', boot, status: 'ok', code: 'unknown', request_id: requestId,
    observation_id: observationId, requested_scope: { machine_id: 'host', project_id: 'one', revision } };
  assert.equal(parseObservationReply(raw, 'project_observation_status', target, requestId, observationId).code, 'unknown');
  for (const field of ['descriptor', 'observation_state', 'data_base64', 'cancel_token']) assert.throws(() => parseObservationReply({ ...raw, [field]: 'bad' }, 'project_observation_status', target, requestId, observationId));
});

test('exact two MiB catalog assembles split UTF8 scalar only after complete digest', async () => {
  const { reader, calls } = fixture({ split: true }); await reader.start();
  assert.equal((await reader.assemble()).projects[0]!.title, 'Delivery🌍');
  assert.equal(calls.filter(op => op === 'project_observation_page').length, 16);
});

import { FollowupPreferenceStore } from '../static/project-followup-preferences.ts';
test('one preference owner bounds every detail, README and source choice together', () => {
  let serialized = ''; const store = new FollowupPreferenceStore('mesh.projects.ui.v1', { getItem: () => null, setItem: (_key, value) => { serialized = value; } });
  for (let index = 0; index < 260; index++) {
    const scope = JSON.stringify(['host', 'one', `source-${index}`, 'pipeline', 'task']);
    const choice = store.read(scope); choice.mode = 'timeline'; choice.disclosures = Array.from({ length: 200 }, (_, number) => `${number}-${'é'.repeat(100)}`);
    store.write(scope, choice);
    assert.ok(Buffer.byteLength(serialized) <= 65536); assert.ok(JSON.parse(serialized).length <= 200);
  }
  assert.equal(store.read(JSON.stringify(['host', 'one', 'source-0', 'pipeline', 'task'])).mode, 'summary');
  assert.ok(!serialized.includes('cancel_token'));
});
