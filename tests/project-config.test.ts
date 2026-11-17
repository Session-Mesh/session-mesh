// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const moduleURL = new URL('../tools/project-config.ts', import.meta.url);
const legacy = () => ({ kind: 'mesh-project-config', schema_version: 1, machine_id: 'declared', projects: [{
  id: 'project', title: 'Original', sessions: [{ name: 'session', created: 1794657432.123456 }],
  sources: [{ id: 'chat', kind: 'slack', label: 'Chat' }],
}] });
async function api() {
  assert.ok(existsSync(moduleURL), 'actual local config editor required');
  return import(moduleURL.href);
}
async function fixture(run: (path: string, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'project-config-'));
  try { const path = join(dir, 'config.json'); await fs.writeFile(path, JSON.stringify(legacy()), { mode: 0o600 }); await run(path, dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const request = (revision: string, operation: unknown) => ({ kind: 'mesh-project-config-edit', schema_version: 1,
  target_schema: 2, expected_revision: revision, project_id: 'project', operation });

test('explicitly authored titles stay strict independently of legacy reader compatibility', async () => {
  const editor = await api();
  await fixture(async path => {
    const before = await editor.readProjectConfigState(path), bytes = await fs.readFile(path);
    assert.equal(before.status, 'ok');
    for (const title of ['', ' ', '\t', 'bad\nname', 'bad\rname', 'bad\0name', 'x'.repeat(241)]) {
      assert.deepEqual(await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title })),
        { status: 'refused', code: 'invalid-request' });
      assert.deepEqual(await fs.readFile(path), bytes);
    }
  });
});

test('repository removal requires explicit null and refuses own-present undefined without changing bytes', async () => {
  const editor = await api();
  await fixture(async path => {
    const config: any = legacy(); config.projects[0].repository = { url: 'https://example.test/existing' };
    await fs.writeFile(path, JSON.stringify(config));
    const before = await editor.readProjectConfigState(path), bytes = await fs.readFile(path);
    assert.equal(before.status, 'ok');
    const operation = { type: 'repository.configure', repository: undefined };
    assert.equal(Object.hasOwn(operation, 'repository'), true);
    assert.deepEqual(await editor.editProjectConfig(path, request(before.revision, operation)), { status: 'refused', code: 'invalid-request' });
    assert.deepEqual(await fs.readFile(path), bytes);
    assert.equal((await editor.readProjectConfigState(path)).revision, before.revision);
    assert.equal((await editor.editProjectConfig(path, request(before.revision, { type: 'repository.configure', repository: null }))).status, 'ok');
    const after = await editor.readProjectConfigState(path);
    assert.equal(after.status, 'ok'); assert.equal(after.config.projects[0].repository, undefined);
  });
});
function childEdit(path: string, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {editProjectConfig} from ${JSON.stringify(moduleURL.href)};process.stdout.write(JSON.stringify(await editProjectConfig(process.argv[1],JSON.parse(process.argv[2]))));`, path, JSON.stringify(value)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { error += b; });
    child.once('error', reject); child.once('close', code => {
      if (code !== 0) reject(Error(`owned editor child ${code}: ${error}`)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
    });
  });
}

test('local edit uses exact consumed-byte revisions and persists migration without changing legacy identity', async () => {
  const editor = await api();
  await fixture(async path => {
    const bytes = await fs.readFile(path), before = await editor.readProjectConfigState(path);
    assert.equal(before.status, 'ok');
    assert.equal(before.revision, `cfg1_${createHash('sha256').update(bytes).digest('hex')}`);
    const changed = await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', description: 'Durable context' }));
    assert.equal(changed.status, 'ok');
    const after = await editor.readProjectConfigState(path);
    assert.equal(after.config.schema_version, 2); assert.deepEqual(after.config.features, ['project-metadata/1']);
    assert.equal(after.config.projects[0].description, 'Durable context');
    assert.deepEqual(after.config.projects[0].sessions, legacy().projects[0]!.sessions);
    assert.deepEqual(after.config.projects[0].sources, legacy().projects[0]!.sources);
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    const retained = await fs.readFile(path);
    assert.deepEqual(await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Stale' })), { status: 'refused', code: 'revision-conflict' });
    assert.deepEqual(await fs.readFile(path), retained);
  });
});

test('two real writer processes conflict explicitly and fresh intent preserves both unrelated edits', async () => {
  const editor = await api();
  await fixture(async path => {
    const before = await editor.readProjectConfigState(path);
    const operations = [{ type: 'project.describe', title: 'Title A' }, { type: 'project.describe', description: 'Description B' }];
    const outcomes = await Promise.all(operations.map(operation => childEdit(path, request(before.revision, operation))));
    assert.equal(outcomes.filter(o => o.status === 'ok').length, 1);
    for (let i = 0; i < outcomes.length; i++) if (outcomes[i].status !== 'ok') {
      assert.ok(['busy', 'revision-conflict'].includes(outcomes[i].code));
      const latest = await editor.readProjectConfigState(path);
      assert.equal((await childEdit(path, request(latest.revision, operations[i]))).status, 'ok');
    }
    const after = await editor.readProjectConfigState(path);
    assert.equal(after.config.projects[0].title, 'Title A'); assert.equal(after.config.projects[0].description, 'Description B');
  });
});

test('participation identity is immutable and known channel identity permits only declared enrichment', async () => {
  const editor = await api();
  await fixture(async path => {
    const put = async (operation: unknown) => editor.editProjectConfig(path, request((await editor.readProjectConfigState(path)).revision, operation));
    const participation = { id: 'link', recorded_relation: 'active', target: { kind: 'mesh', name: 's', created: 12.125 } };
    assert.equal((await put({ type: 'participation.put', participation })).status, 'ok');
    assert.equal((await put({ type: 'participation.put', participation: { ...participation, recorded_relation: 'historical', label: 'Renamed' } })).status, 'ok');
    assert.deepEqual(await put({ type: 'participation.put', participation: { ...participation, target: { ...participation.target, created: 13 } } }), { status: 'refused', code: 'immutable-identity' });
    assert.equal((await put({ type: 'channel.put', source_id: 'chat', channel: { id: 'channel', label: '#planning' } })).status, 'ok');
    assert.equal((await put({ type: 'channel.put', source_id: 'chat', channel: { id: 'channel', label: '#renamed', native_id: 'Exact:Native' } })).status, 'ok');
    assert.deepEqual(await put({ type: 'channel.put', source_id: 'chat', channel: { id: 'channel', label: '#renamed' } }), { status: 'refused', code: 'immutable-identity' });
  });
});

test('unsafe file aliases and abandoned ownership refuse without deleting evidence', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    const before = await editor.readProjectConfigState(path), edit = request(before.revision, { type: 'project.describe', title: 'Changed' });
    const lock = join(dir, `.mesh-project-config-${createHash('sha256').update(path).digest('hex')}.lock`);
    await fs.writeFile(lock, '', { mode: 0o600 });
    assert.deepEqual(await editor.editProjectConfig(path, edit), { status: 'refused', code: 'busy' });
    assert.equal((await fs.readFile(lock)).length, 0); await fs.unlink(lock);
    const link = join(dir, 'alias.json'); await fs.link(path, link);
    assert.equal((await editor.editProjectConfig(path, edit)).code, 'unsafe-path'); await fs.unlink(link);
    await fs.symlink(path, link); assert.equal((await editor.readProjectConfigState(link)).code, 'unsafe-path');
    await fs.chmod(path, 0o644); assert.equal((await editor.editProjectConfig(path, edit)).code, 'unsafe-path');
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).projects[0].title, 'Original');
  });
});

test('new CLI readers and producer observe committed bytes, and malformed edit requests preserve them', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    const before = await editor.readProjectConfigState(path), file = join(dir, 'edit.json');
    await fs.writeFile(file, JSON.stringify(request(before.revision, { type: 'project.describe', title: 'Persisted title' })), { mode: 0o600 });
    const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
    const written = run([moduleURL.pathname, 'edit', '--request', file, '--config', path]);
    assert.equal(written.status, 0, written.stderr); assert.equal(JSON.parse(written.stdout).status, 'ok');
    const read = run([moduleURL.pathname, 'read', '--config', path]);
    assert.equal(read.status, 0); assert.equal(JSON.parse(read.stdout).config.projects[0].title, 'Persisted title');
    const produced = run([new URL('../tools/project-snapshot.ts', import.meta.url).pathname, '--config', path, '--catalog-version', '2']);
    assert.equal(produced.status, 0, produced.stderr); assert.equal(JSON.parse(produced.stdout).projects[0].title, 'Persisted title');
    const bytes = await fs.readFile(path);
    for (const args of [['edit', '--config', path], ['read', '--config', path, '--config', path], ['read', '--config', path, '--unknown', 'x']]) {
      const result = run([moduleURL.pathname, ...args]); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).status, 'refused');
    }
    for (const operation of [{ type: 'project.describe' }, { type: 'project.describe', title: ' ', extra: true }, { type: 'project.remove' }]) {
      const current = await editor.readProjectConfigState(path);
      assert.equal((await editor.editProjectConfig(path, request(current.revision, operation))).code, 'invalid-request');
      assert.deepEqual(await fs.readFile(path), bytes);
    }
  });
});

test('byte revisions distinguish whitespace but do not assert monotonic history or ABA prevention', async () => {
  const editor = await api();
  await fixture(async path => {
    const bytes = await fs.readFile(path), before = await editor.readProjectConfigState(path);
    await fs.writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
    assert.equal((await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Stale' }))).code, 'revision-conflict');
    await fs.writeFile(path, bytes);
    assert.equal((await editor.readProjectConfigState(path)).revision, before.revision);
    assert.equal((await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Explicit intent' }))).status, 'ok');
  });
});

test('real temporary-write failure preserves bytes and real directory-sync failure reports uncertainty', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    const bytes = await fs.readFile(path), before = await editor.readProjectConfigState(path);
    const open = fs.open.bind(fs); const failure = () => Object.assign(Error('fixture I/O'), { code: 'EIO' });
    let events: string[] = [];
    const injection = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args), name = String(args[0]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(name.endsWith('.tmp') ? 'temporary-sync' : name.endsWith('.lock') ? 'lock-sync' : 'directory-sync');
        if (name.endsWith('.tmp')) throw failure(); return sync();
      };
      return handle;
    });
    try {
      assert.deepEqual(await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Not committed' })), { status: 'refused', code: 'io-refused' });
    } finally { injection.mock.restore(); }
    assert.deepEqual(await fs.readFile(path), bytes); assert.ok(events.includes('temporary-sync')); assert.ok(!events.includes('directory-sync'));
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
    events = [];
    const directoryFailure = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args), name = String(args[0]), sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push(name === dir ? 'directory-sync' : name.endsWith('.tmp') ? 'temporary-sync' : 'lock-sync'); if (name === dir) throw failure(); return sync(); };
      return handle;
    });
    try {
      assert.deepEqual(await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Possibly durable' })), { status: 'uncertain', code: 'commit-uncertain' });
    } finally { directoryFailure.mock.restore(); }
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).projects[0].title, 'Possibly durable');
    assert.ok(events.indexOf('temporary-sync') < events.indexOf('directory-sync'));
  });
});

test('postcommit cleanup failure warns without pretending rollback or stealing abandoned ownership', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    const before = await editor.readProjectConfigState(path), unlink = fs.unlink.bind(fs);
    const injection = mock.method(fs, 'unlink', async target => {
      if (String(target).endsWith('.lock')) throw Object.assign(Error('fixture cleanup'), { code: 'EACCES' }); return unlink(target);
    });
    let result;
    try { result = await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Accepted' })); }
    finally { injection.mock.restore(); }
    assert.equal(result.status, 'ok'); assert.deepEqual(result.warnings, ['cleanup-failed']);
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).projects[0].title, 'Accepted');
    assert.equal((await editor.editProjectConfig(path, request(result.revision, { type: 'project.describe', title: 'Blocked' }))).code, 'busy');
    assert.equal((await fs.readdir(dir)).filter(p => p.endsWith('.lock')).length, 1);
  });
});

test('killed fixture writers leave explicit ownership and fresh readers distinguish pre/postreplacement bytes', async () => {
  const editor = await api();
  for (const stage of ['before', 'after']) await fixture(async (path, dir) => {
    const before = await editor.readProjectConfigState(path);
    const value = request(before.revision, { type: 'project.describe', title: 'Interrupted intent' });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      const rename=fs.rename.bind(fs);const keep=setInterval(()=>{},1000);
      fs.rename=async(...args)=>{if(process.argv[3]==='after')await rename(...args);process.stdout.write('barrier\\n');await new Promise(()=>{});};
      const {editProjectConfig}=await import(${JSON.stringify(moduleURL.href)});
      await editProjectConfig(process.argv[1],JSON.parse(process.argv[2]));clearInterval(keep);
    `, path, JSON.stringify(value), stage], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let error = ''; child.stderr.on('data', bytes => { error += bytes; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error(`owned barrier timeout: ${error}`)), 5000);
        child.stdout.once('data', data => { clearTimeout(timeout); if (String(data).includes('barrier')) resolve(); else reject(Error('unexpected owned receipt')); });
        child.once('error', reject);
      });
    } finally { child.kill('SIGKILL'); }
    assert.equal((await closed).signal, 'SIGKILL');
    const fresh = spawnSync(process.execPath, [moduleURL.pathname, 'read', '--config', path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).config.projects[0].title, stage === 'after' ? 'Interrupted intent' : 'Original');
    assert.equal((await editor.editProjectConfig(path, request(JSON.parse(fresh.stdout).revision, { type: 'project.describe', title: 'No implicit recovery' }))).code, 'busy');
    const artifacts = (await fs.readdir(dir)).filter(name => name !== 'config.json');
    assert.equal(artifacts.filter(name => name.endsWith('.lock')).length, 1);
    assert.equal(artifacts.filter(name => name.endsWith('.tmp')).length, stage === 'before' ? 1 : 0);
    // This fixture owns the directory and has awaited its sole writer's death.
    // Inspect only those abandoned regular artifacts before explicit manual removal.
    for (const name of artifacts) {
      const target = join(dir, name), info = await fs.lstat(target);
      assert.ok(info.isFile() && info.nlink === 1 && info.uid === process.geteuid?.());
      if (name.endsWith('.lock')) assert.match(JSON.parse(await fs.readFile(target, 'utf8')).nonce, /^[a-f0-9]{32}$/);
      else assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).projects[0].title, 'Interrupted intent');
      await fs.unlink(target);
    }
    const current = await editor.readProjectConfigState(path);
    assert.equal((await editor.editProjectConfig(path, request(current.revision, { type: 'project.describe', title: 'Fresh inspected intent' }))).status, 'ok');
  });
});

test('changed current bytes and foreign replacement locks survive detected refusal', async () => {
  const editor = await api();
  for (const replaceLock of [false, true]) await fixture(async (path, dir) => {
    const before = await editor.readProjectConfigState(path), open = fs.open.bind(fs);
    const lock = join(dir, `.mesh-project-config-${createHash('sha256').update(path).digest('hex')}.lock`);
    const injection = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        if (replaceLock) { await fs.unlink(lock); await fs.writeFile(lock, 'foreign evidence', { mode: 0o600 }); }
        else { const foreign = legacy(); foreign.projects[0]!.title = 'Independent bytes'; await fs.writeFile(path, JSON.stringify(foreign)); }
      }
      return handle;
    });
    let result;
    try { result = await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Overwritten' })); }
    finally { injection.mock.restore(); }
    assert.equal(result.status, 'refused');
    assert.equal(result.code, replaceLock ? 'unsafe-path' : 'revision-conflict');
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).projects[0].title, replaceLock ? 'Original' : 'Independent bytes');
    if (replaceLock) { assert.equal(await fs.readFile(lock, 'utf8'), 'foreign evidence'); assert.deepEqual(result.warnings, ['cleanup-failed']); }
  });
});

test('detected parent substitution prevents cleanup from following a new ancestor symlink', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    const moved = `${dir}-moved`, before = await editor.readProjectConfigState(path), open = fs.open.bind(fs);
    let changed = false;
    const injection = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (!changed && String(args[0]).endsWith('.tmp')) { changed = true; await fs.rename(dir, moved); await fs.symlink(moved, dir); }
      return handle;
    });
    try {
      const result = await editor.editProjectConfig(path, request(before.revision, { type: 'project.describe', title: 'Blocked' }));
      assert.equal(result.status, 'refused'); assert.equal(result.code, 'unsafe-path');
      assert.deepEqual(result.warnings, ['cleanup-failed']);
      assert.equal((await fs.readdir(moved)).filter(name => name !== 'config.json').length, 2, 'changed namespace retains its artifacts for inspection');
    } finally {
      injection.mock.restore();
      if (changed) { await fs.unlink(dir); await fs.rename(moved, dir); }
    }
  });
});

test('unsupported config versions/features and missing request input have specific bounded refusals', async () => {
  const editor = await api();
  await fixture(async (path, dir) => {
    await fs.writeFile(path, JSON.stringify({ ...legacy(), schema_version: 99 }));
    assert.deepEqual(await editor.readProjectConfigState(path), { status: 'refused', code: 'unsupported-version' });
    await fs.writeFile(path, JSON.stringify({ ...legacy(), schema_version: 2, features: ['unknown-family/1'] }));
    assert.deepEqual(await editor.readProjectConfigState(path), { status: 'refused', code: 'unsupported-feature' });
    await fs.writeFile(path, JSON.stringify(legacy()));
    const cli = spawnSync(process.execPath, [moduleURL.pathname, 'edit', '--config', path, '--request', join(dir, 'missing.json')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout), { status: 'refused', code: 'invalid-request' });
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).schema_version, 1);
  });
});

test('local read refuses legacy normalization expansion beyond its response envelope budget', async () => {
  const editor = await api();
  await fixture(async path => {
    const value: any = legacy();
    value.projects = Array.from({ length: 36 }, (_, i) => ({ id: `p${i}`, title: 'Project', sessions: [],
      sources: Array.from({ length: 20 }, (_, j) => ({ id: `s${j}`, kind: 'other', label: 'Source', url: `https://example.test/${'é'.repeat(500)}` })) }));
    const bytes = JSON.stringify(value); assert.ok(Buffer.byteLength(bytes) < 2 * 1024 * 1024);
    await fs.writeFile(path, bytes);
    const result = await editor.readProjectConfigState(path);
    assert.equal(result.status, 'refused'); assert.equal(result.code, 'too-large');
    assert.equal(await fs.readFile(path, 'utf8'), bytes);
  });
});
