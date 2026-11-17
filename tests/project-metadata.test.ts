// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProjectConfig } from '../static/project-catalog.ts';
import { generateSnapshot } from '../tools/project-snapshot.ts';
import { readProjectConfigState, editProjectConfig } from '../tools/project-config.ts';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = () => ({ kind: 'mesh-project-config', schema_version: 2,
  features: ['project-metadata/1'], machine_id: 'declared_machine', projects: [{
    id: 'project_A', title: 'Project', sessions: [{ name: 'legacy', created: 1794657432.123456 }],
    sources: [{ id: 'chat', kind: 'slack', label: 'Team chat', channels: [{
      id: 'channel_A', label: '#planning', workspace_id: 'workspace_A', native_id: 'native:Channel_A',
    }] }], participations: [{ id: 'participation_A', label: 'Working context', recorded_relation: 'active',
      target: { kind: 'mesh', name: 'same-name', created: 1794657432.123456, machine_id: 'foreign' },
      work_refs: [{ source_id: 'chat', kind: 'channel', native_id: 'native:Channel_A' }],
    }],
  }] });

test('legacy common text survives explicit projection, migration and repairing edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-common-text-'));
  try {
    for (const text of ['Line\nBreak', '\t', '\r']) {
      const value = { kind: 'mesh-project-config', schema_version: 1, machine_id: 'machine', projects: [{
        id: 'project', title: text, sources: [{ id: 'source', kind: 'other', label: text }],
        repository: { url: 'https://example.test/repository', branch: text }, sessions: [{ name: text, created: 12.125 }],
      }] };
      assert.ok(parseProjectConfig(value), 'original reader accepts the fixture');
      const projected = await generateSnapshot(value as any, { catalogVersion: 2 })
        .catch(error => assert.fail(`valid legacy projection must succeed: ${error.message}`));
      assert.equal(projected.projects[0]!.title, text);
      assert.equal(projected.projects[0]!.sources[0]!.label, text);
      assert.equal(projected.projects[0]!.repository!.branch, text);
      assert.deepEqual(projected.projects[0]!.sessions, value.projects[0]!.sessions);
      const path = join(dir, 'config.json');
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      let before = await readProjectConfigState(path); assert.equal(before.status, 'ok');
      if (before.status !== 'ok') throw Error('fixture read failed');
      const request = (revision: string, operation: unknown) => ({ kind: 'mesh-project-config-edit', schema_version: 1,
        target_schema: 2, expected_revision: revision, project_id: 'project', operation });
      assert.equal((await editProjectConfig(path, request(before.revision, { type: 'project.describe', description: 'Added context' }))).status, 'ok');
      const migrated = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(migrated.projects[0].title, text);
      assert.equal(migrated.projects[0].sources[0].label, text);
      assert.equal(migrated.projects[0].repository.branch, text);
      before = await readProjectConfigState(path); assert.equal(before.status, 'ok');
      if (before.status !== 'ok') throw Error('migrated read failed');
      assert.equal((await editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Repaired title' }))).status, 'ok');
      const repaired = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(repaired.projects[0].title, 'Repaired title');
      assert.equal(repaired.projects[0].sources[0].label, text);
      assert.equal(repaired.projects[0].repository.branch, text);
      assert.deepEqual(repaired.projects[0].sessions, value.projects[0]!.sessions);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an explicit repository replacement repairs legacy normalization without broadening target URL bounds', async () => {
  const legacy: any = { kind: 'mesh-project-config', schema_version: 1, machine_id: 'machine', projects: [{
    id: 'project', title: 'Project', sources: [{ id: 'source', kind: 'other', label: 'Source' }],
    repository: { url: `https://example.test/${'é'.repeat(1000)}` }, sessions: [{ name: 'session', created: 12.125 }],
  }] };
  const parsed = parseProjectConfig(legacy); assert.ok(parsed);
  assert.ok(parsed.projects[0]!.repository!.url.length > 4096, 'legacy normalization produces the unsupported target value');
  assert.equal(parseProjectConfig({ ...legacy, schema_version: 2, features: ['project-metadata/1'] }), null, 'target canonical URL bound remains strict');
  const dir = await mkdtemp(join(tmpdir(), 'project-repository-repair-'));
  try {
    const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const before = await readProjectConfigState(path); assert.equal(before.status, 'ok');
    if (before.status !== 'ok') throw Error('fixture read failed');
    const changed = await editProjectConfig(path, { kind: 'mesh-project-config-edit', schema_version: 1, target_schema: 2,
      expected_revision: before.revision, project_id: 'project', operation: { type: 'repository.configure', repository: { url: 'https://example.test/repaired' } } });
    assert.equal(changed.status, 'ok', 'explicit valid replacement must be applied before complete target validation');
    const after = await readProjectConfigState(path); assert.equal(after.status, 'ok');
    if (after.status !== 'ok') throw Error('repaired read failed');
    assert.equal(after.config.schema_version, 2); assert.equal(after.config.projects[0]!.repository!.url, 'https://example.test/repaired');
    assert.deepEqual(after.config.projects[0]!.sources, legacy.projects[0].sources);
    assert.deepEqual(after.config.projects[0]!.sessions, legacy.projects[0].sessions);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit metadata configuration preserves exact declared identities independently of legacy hints', () => {
  const value = config(), parsed = parseProjectConfig(value);
  assert.ok(parsed, 'strict opt-in metadata config must be accepted');
  assert.deepEqual(parsed, value);
  assert.equal(parsed.projects[0]?.sessions[0]?.created, value.projects[0]!.sessions[0]!.created);
});

test('normalized metadata has its own aggregate byte bound after URL canonicalization', () => {
  const value: any = config();
  value.projects = Array.from({ length: 36 }, (_, i) => ({ id: `p${i}`, title: 'Project',
    sources: Array.from({ length: 20 }, (_, j) => ({ id: `s${j}`, kind: 'other', label: 'Source',
      url: `https://example.test/${'é'.repeat(500)}` })), sessions: [] }));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 2 * 1024 * 1024);
  assert.ok(parseProjectConfig(value) === null, 'bounded input cannot expand to oversized normalized data');
});

test('closed metadata rejects authority fields, duplicates, invalid identities and nested limits', () => {
  const mutations: ((v: any) => void)[] = [
    v => { v.features = []; }, v => { v.features.push('project-metadata/1'); },
    v => { v.features = ['roster-followup/1']; }, v => { v.schema_version = 99; },
    v => { v.projects[0].participations[0].label = ' '; }, v => { v.projects[0].sources[0].channels[0].label = 'x\ny'; },
    v => { v.projects[0].title = 'x'.repeat(241); }, v => { v.projects[0].description = 'x'.repeat(4001); },
    v => { v.projects[0].participations[0].target.trusted = true; },
    v => { v.projects[0].participations[0].target.created = '1794657432.123456'; },
    v => { v.projects[0].participations[0].target.created = Infinity; },
    v => { v.projects[0].participations[0].target.name = 'bad\rname'; },
    v => { v.projects[0].participations[0].recorded_relation = 'live'; },
    v => { v.projects[0].participations.push(structuredClone(v.projects[0].participations[0])); },
    v => { v.projects[0].participations[0].work_refs.push(structuredClone(v.projects[0].participations[0].work_refs[0])); },
    v => { v.projects[0].participations[0].work_refs[0].native_id = 'bad\nID'; },
    v => { v.projects[0].participations[0].work_refs[0].native_id = 'x'.repeat(241); },
    v => { v.projects[0].participations[0].work_refs = Array.from({length:21},(_,i)=>({source_id:'chat',kind:'task',native_id:`native${i}`})); },
    v => { v.projects[0].participations[0].work_refs[0].kind = 'bad:kind'; },
    v => { v.projects[0].sources[0].id = 'mesh'; },
    v => { v.projects[0].sources[0].channels[0].workspace_id = ''; },
    v => { v.projects[0].sources[0].channels[0].label = '\t'; },
    v => { v.projects[0].sources[0].channels[0].url = 'https://user:password@example.test/'; },
    v => { v.projects[0].sources[0].channels.push(structuredClone(v.projects[0].sources[0].channels[0])); },
    v => { v.projects[0].sources[0].channels = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, label: 'Channel' })); },
    v => { v.projects[0].participations = Array.from({ length: 101 }, (_, i) => ({ ...v.projects[0].participations[0], id: `p${i}` })); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = config(); mutate(value); assert.ok(parseProjectConfig(value) === null, `mutation ${index}`);
  }
  const history: any = config(); history.projects[0].participations[0].target = {
    kind: 'history', agent: 'codex', conversation_id: 'Exact:Original-ID',
  };
  assert.ok(parseProjectConfig(history));
  history.projects[0].participations[0].work_refs[0].source_id = 'not_configured';
  assert.ok(parseProjectConfig(history), 'missing source binding is retained as inert authored history');
});

test('repository local locators are explicit config-only metadata and preserve optional supplied links', () => {
  const value: any = config(); value.projects[0].repository = { url: 'https://example.test/repository',
    branch: 'supplied-topic', readme_url: 'https://example.test/document', local_path: '/tmp/local-repository',
    primary_ref: 'refs/heads/release' };
  const parsed = parseProjectConfig(value);
  assert.ok(parsed, 'opt-in repository configuration is accepted without inspection');
  assert.deepEqual(parsed.projects[0]?.repository, value.projects[0].repository);
});

test('explicit metadata projection retains authored data while stripping private repository locators', async () => {
  const value: any = config(); value.projects[0].repository = { url: 'https://example.test/repo',
    local_path: '/private/local/repository', primary_ref: 'refs/heads/release' };
  const catalog = await generateSnapshot(value, { catalogVersion: 2 });
  assert.equal(catalog.schema_version, 2);
  assert.deepEqual(catalog.features, ['project-metadata/1']);
  assert.deepEqual(catalog.projects[0]?.participations, value.projects[0].participations);
  assert.deepEqual(catalog.projects[0]?.sources[0]?.channels, value.projects[0].sources[0].channels);
  assert.equal(catalog.projects[0]?.sources[0]?.status, 'unconfigured');
  assert.ok(!JSON.stringify(catalog).includes('/private/local/repository'));
  assert.ok(!JSON.stringify(catalog).includes('primary_ref'));
});

test('config2 default projection refuses before any provider starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-version-'));
  try {
    const marker = join(dir, 'called'), executable = join(dir, 'provider');
    await writeFile(executable, `#!/usr/bin/node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');process.stdout.write('{}');\n`, { mode: 0o700 });
    const value: any = config(); value.projects[0].sources[0] = { id: 'source', kind: 'roster', label: 'Source', board_path: join(dir, 'board') };
    await assert.rejects(generateSnapshot(value, { rosterCLI: executable }), /unsupported-version/);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reserved source migration refuses before provider side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-reserved-source-'));
  try {
    const marker = join(dir, 'called'), executable = join(dir, 'provider');
    await writeFile(executable, `#!/usr/bin/node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');process.stdout.write('{}');\n`, { mode: 0o700 });
    const value: any = {kind:'mesh-project-config',schema_version:1,machine_id:'machine',projects:[{
      id:'project',title:'Project',sources:[{id:'mesh',kind:'roster',label:'Source',board_path:join(dir,'board')}],sessions:[]}]};
    assert.ok(parseProjectConfig(value));
    await assert.rejects(generateSnapshot(value, { catalogVersion: 2, rosterCLI: executable }), /invalid-catalog/);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
