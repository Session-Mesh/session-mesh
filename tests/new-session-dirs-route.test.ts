// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The server side of the folder field of the "New session" dialog (issue #46):
// - GET /api/dirs lists the allowed work folders and their sub-folders (or ~/dev when no work folder is
//   configured), each one a folder a session may start in, never a hidden name, a symlink leading out or a
//   protected folder, bounded, and still a plain list of paths for older clients;
// - the recent folders are a runner setting ("recent_folders" of GET /api/config), recorded by the server
//   itself when the owner's browser starts a session with POST /api/new, newest first, once each, at most 8;
//   a browser moves the list it kept before with POST /api/dirs/recent (owner cookie only); the elevated
//   settings route cannot write them. Throwaway servers and PTY hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

type Runner = {values: {operator_name: string; recent_folders: string[]}; max_length: Record<string, number>};

const dirs = async (mesh: ConfigMesh, query = ''): Promise<unknown> => {
  const response = await fetch(`${mesh.base}/api/dirs${query}`, {headers: mesh.owner(false)});
  assert.equal(response.status, 200);
  return await response.json();
};
const recent = async (mesh: ConfigMesh) => ((await mesh.config()).runner_settings as Runner).values.recent_folders;
const mkdirs = (root: string, names: string[]) => { for (const name of names) fs.mkdirSync(path.join(root, name), {recursive: true}); };
let sessions = 0;
/** The owner's browser starts a session (cookie, same origin), the way the dialog does. */
const start = (mesh: ConfigMesh, cwd: string, headers = mesh.owner(false)) =>
  mesh.post('/api/new', {preset: 'shell', cwd, name: `s${++sessions}`}, headers);
const importRecent = (mesh: ConfigMesh, body: unknown, headers = mesh.owner(false)) => mesh.post('/api/dirs/recent', body, headers);

describe('GET /api/dirs with allowed work folders', () => {
  let mesh: ConfigMesh;
  let work: string, work2: string, work3: string;
  before(async () => {
    mesh = await ConfigMesh.start('ndr-', home => ({v: 1, workspace_roots: ['work', 'work2', 'work3'].map(name => path.join(home, name)),
      enabled_agents: ['claude']}));
    work = path.join(mesh.home, 'work'); work2 = path.join(mesh.home, 'work2'); work3 = path.join(mesh.home, 'work3');
    mkdirs(work, ['alpha/inner', 'beta', '.hidden']);
    mkdirs(work2, ['gamma']);
    mkdirs(mesh.home, ['dev/legacy', 'elsewhere']);
    fs.writeFileSync(path.join(work, 'a-file'), '');
    fs.symlinkSync(mesh.outside, path.join(work, 'link-out'));               // leads out of the home folder
    fs.symlinkSync(path.join(mesh.home, 'elsewhere'), path.join(work, 'link-home'));   // inside home, outside the roots
    fs.symlinkSync(path.join(work2, 'gamma'), path.join(work, 'link-gamma'));  // into another allowed folder
    fs.symlinkSync(path.join(work, 'missing'), path.join(work, 'link-dangling'));
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(work, 'beta'), old, old);
  });
  after(async () => { await mesh?.stop(); });

  test('the allowed folders, then their visible sub-folders newest first; nothing a session could not start in', async () => {
    const listed = await dirs(mesh) as string[];
    assert.ok(Array.isArray(listed) && listed.every(entry => typeof entry === 'string' && entry.startsWith('/')),
      'a plain list of absolute paths, as older clients expect');
    assert.deepEqual(listed.slice(0, 3), [work, work2, work3], 'the allowed folders come first');
    const below = listed.slice(3);
    for (const wanted of ['alpha', 'beta', 'link-gamma']) assert.ok(below.includes(path.join(work, wanted)), wanted);
    assert.ok(below.includes(path.join(work2, 'gamma')));
    assert.ok(below.indexOf(path.join(work, 'alpha')) < below.indexOf(path.join(work, 'beta')), 'newest first within a folder');
    for (const refused of [mesh.home, path.join(mesh.home, 'dev'), path.join(mesh.home, 'dev', 'legacy'), path.join(work, '.hidden'),
      path.join(work, 'a-file'), path.join(work, 'link-out'), path.join(work, 'link-home'), path.join(work, 'link-dangling'),
      path.join(work, 'alpha', 'inner')]) {
      assert.ok(!listed.includes(refused), `${refused} is not listed: ${JSON.stringify(listed)}`);
    }
  });

  test('takes no argument: a query cannot point it elsewhere', async () => {
    assert.deepEqual(await dirs(mesh, `?path=${encodeURIComponent('../../..')}&root=/`), await dirs(mesh));
  });

  test('bounded: at most 80 sub-folders of one folder, 200 entries in all', async () => {
    mkdirs(work, Array.from({length: 120}, (_, i) => `many-${i}`));
    mkdirs(work2, Array.from({length: 120}, (_, i) => `more-${i}`));
    mkdirs(work3, Array.from({length: 120}, (_, i) => `most-${i}`));
    const listed = await dirs(mesh) as string[];
    assert.equal(listed.filter(entry => path.dirname(entry) === work).length, 80);
    assert.equal(listed.filter(entry => path.dirname(entry) === work2).length, 80);
    assert.equal(listed.length, 200);
    assert.equal(new Set(listed).size, listed.length, 'once each');
  });
});

describe('GET /api/dirs cost: runs on every dialog opening', () => {
  let mesh: ConfigMesh;
  let roots: string[];
  before(async () => {
    mesh = await ConfigMesh.start('ndc-', home => {
      fs.mkdirSync(path.join(home, 'work4'));
      return {v: 1, workspace_roots: ['work', 'work2', 'work3', 'work4'].map(name => path.join(home, name)), enabled_agents: ['claude']};
    });
    roots = ['work', 'work2', 'work3', 'work4'].map(name => path.join(mesh.home, name));
    mkdirs(roots[0]!, Array.from({length: 2000}, (_, i) => `big-${i}`));
    mkdirs(roots[1]!, Array.from({length: 120}, (_, i) => `mid-${i}`));
    mkdirs(roots[2]!, Array.from({length: 120}, (_, i) => `end-${i}`));
    mkdirs(roots[3]!, ['never-reached']);
  });
  after(async () => { await mesh?.stop(); });

  test('2000 sub-folders under one allowed folder list well under a second (generous bound: 2 s)', async () => {
    await dirs(mesh);   // warm
    const started = performance.now();
    const listed = await dirs(mesh) as string[];
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `GET /api/dirs took ${Math.round(elapsed)} ms`);
    assert.equal(listed.filter(entry => path.dirname(entry) === roots[0]).length, 80);
  });

  test('stops reading folders once 200 entries are listed: a later allowed folder is not read', async (t) => {
    // Observed through the access time of the folders: only a directory read sets it. Skipped where the file
    // system does not record it (noatime mounts, common for tmpfs and developer machines; CI runners use relatime).
    const old = new Date('2020-01-01T00:00:00Z');
    const now = new Date();
    const control = path.join(mesh.outside, 'atime-control');
    fs.mkdirSync(control, {recursive: true});
    fs.utimesSync(control, old, now);
    fs.readdirSync(control);
    if (fs.statSync(control).atimeMs === old.getTime()) { t.skip('directory reads do not update atime here'); return; }
    for (const root of roots.slice(2)) fs.utimesSync(root, old, now);
    const listed = await dirs(mesh) as string[];
    assert.equal(listed.length, 200);
    assert.notEqual(fs.statSync(roots[2]!).atimeMs, old.getTime(), 'the folder that completes the 200 entries is read');
    assert.equal(fs.statSync(roots[3]!).atimeMs, old.getTime(), 'the next one is not');
    assert.ok(!listed.includes(path.join(roots[3]!, 'never-reached')));
  });
});

describe('GET /api/dirs without a work folder restriction', () => {
  let mesh: ConfigMesh;
  before(async () => {
    mesh = await ConfigMesh.start('ndu-', null);
    mkdirs(mesh.home, ['dev/one', 'dev/.secret', 'Documents', '.ssh']);
    fs.symlinkSync(mesh.outside, path.join(mesh.home, 'dev', 'escape'));
    fs.symlinkSync(path.join(mesh.home, '.ssh'), path.join(mesh.home, 'dev', 'keys'));
    fs.symlinkSync(mesh.confDir, path.join(mesh.home, 'dev', 'conf'));
  });
  after(async () => { await mesh?.stop(); });

  test('the home folder and the folders of ~/dev, as before; no symlink out of home or into a protected folder', async () => {
    const listed = await dirs(mesh) as string[];
    assert.deepEqual(listed, [mesh.home, path.join(mesh.home, 'dev', 'one')]);
  });

  test('POST /api/dirs/recent keeps only what GET /api/dirs could list: in the home folder, not protected', async () => {
    const response = await importRecent(mesh, {folders: [mesh.outside, path.join(mesh.home, '.ssh'), mesh.confDir,
      path.join(mesh.home, 'dev', 'keys'), path.join(mesh.home, 'dev', 'escape'), path.join(mesh.home, 'dev', 'one')]});
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await recent(mesh), [path.join(mesh.home, 'dev', 'one')]);
  });
});

describe('the recent folders of the runner', () => {
  let mesh: ConfigMesh;
  let work: string;
  const settingsFile = () => path.join(mesh.confDir, 'settings.json');
  before(async () => {
    mesh = await ConfigMesh.start('ndt-', home => ({v: 1, workspace_roots: [path.join(home, 'work')], enabled_agents: ['claude']}));
    work = path.join(mesh.home, 'work');
    mkdirs(work, ['a', 'b', ...Array.from({length: 10}, (_, i) => `r${i}`), 'sub/deeper']);
    fs.symlinkSync(mesh.outside, path.join(work, 'link-out'));
    fs.writeFileSync(path.join(work, 'file'), '');
  });
  after(async () => { await mesh?.stop(); });

  test('start empty, as a list of at most 8 entries beside the operator name', async () => {
    assert.deepEqual((await mesh.config()).runner_settings,
      {values: {operator_name: '', recent_folders: []}, max_length: {operator_name: 40}, max_entries: {recent_folders: 8}});
  });

  test('the owner\'s browser starting a session records its folder: newest first, once each', async () => {
    for (const folder of ['a', 'b', 'a']) assert.equal((await start(mesh, path.join(work, folder))).status, 200, mesh.output());
    assert.deepEqual(await recent(mesh), [path.join(work, 'a'), path.join(work, 'b')]);
    assert.equal((await start(mesh, `${path.join(work, 'sub', 'deeper')}/../deeper/`)).status, 200);
    assert.equal((await recent(mesh))[0], path.join(work, 'sub', 'deeper'), 'recorded as the folder the session runs in');
  });

  test('at most 8, the oldest dropped', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await start(mesh, path.join(work, `r${i}`))).status, 200);
    assert.deepEqual(await recent(mesh), Array.from({length: 8}, (_, i) => path.join(work, `r${9 - i}`)));
  });

  test('not recorded for a refused start, or for a start with the master token', async () => {
    const before = await recent(mesh);
    assert.equal((await start(mesh, mesh.outside)).status, 403);
    assert.equal((await start(mesh, path.join(work, 'a'), {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'})).status, 200);
    assert.deepEqual(await recent(mesh), before);
  });

  test('the elevated settings route cannot write them', async () => {
    assert.equal((await mesh.elevate()).status, 200);
    const response = await mesh.post('/api/config/launch', {settings: {recent_folders: [path.join(work, 'b')]}});
    assert.equal(response.status, 400);
    assert.equal((await mesh.post('/api/config/launch', {settings: {operator_name: 'Ana'}})).status, 200);
    assert.equal((await recent(mesh))[0], path.join(work, 'r9'), 'saving the name keeps the recent folders');
  });

  test('POST /api/dirs/recent: the owner cookie only, same origin', async () => {
    const body = {folders: [path.join(work, 'b')]};
    assert.equal((await importRecent(mesh, body, {'Content-Type': 'application/json'})).status, 401);
    assert.equal((await importRecent(mesh, body, {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'})).status, 401);
    assert.equal((await importRecent(mesh, body, {...mesh.owner(false), Authorization: `Bearer ${mesh.token()}`})).status, 401);
    assert.equal((await importRecent(mesh, body, {...mesh.owner(false), Origin: 'https://evil.example'})).status, 403);
    assert.equal((await fetch(`${mesh.base}/api/dirs/recent`, {headers: mesh.owner(false)})).status, 405);
  });

  test('a moved list goes after the runner\'s own, valid folders only, once each, at most 8', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: [path.join(work, 'a')]}));
    const response = await importRecent(mesh, {folders: [path.join(work, 'b'), path.join(work, 'a'), path.join(work, 'r1'), path.join(work, 'b')]});
    assert.equal(response.status, 200, await response.clone().text());
    const expected = [path.join(work, 'a'), path.join(work, 'b'), path.join(work, 'r1')];
    assert.deepEqual(((await response.json()) as {recent_folders: string[]}).recent_folders, expected);
    assert.deepEqual(await recent(mesh), expected);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).operator_name, 'Ana', 'the other settings are kept');
    assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o600);
  });

  test('hostile entries are left out one by one; a malformed body is refused whole', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: '', recent_folders: []}));
    const hostile = ['relative/path', `${work}/../work/a`, `${work}/./a`, `${work}/a/`, `${work}//a`, `${work}/a\n`, `${work}/‮a`,
      `/${'x'.repeat(1030)}`, path.join(work, 'missing'), path.join(work, 'file'), path.join(work, 'link-out'), mesh.outside,
      path.join(mesh.home, '.ssh'), '/', 7, null, {}];
    const response = await importRecent(mesh, {folders: [...hostile.slice(0, 7), path.join(work, 'b')]});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await importRecent(mesh, {folders: hostile.slice(7, 15)})).status, 200);
    assert.equal((await importRecent(mesh, {folders: hostile.slice(15)})).status, 200);
    assert.deepEqual(await recent(mesh), [path.join(work, 'b')]);
    for (const body of [{folders: Array.from({length: 9}, () => path.join(work, 'a'))}, {folders: 'x'}, {folders: path.join(work, 'a')},
      {}, {folders: [], other: 1}, [], 'x']) {
      assert.equal((await importRecent(mesh, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await mesh.post('/api/dirs/recent?x=1', {folders: []}, mesh.owner(false))).status, 400);
    assert.deepEqual(await recent(mesh), [path.join(work, 'b')]);
  });

  test('a hand-edited file: the entries that are not plain absolute paths are dropped, the rest kept, at most 8', async () => {
    const kept = Array.from({length: 10}, (_, i) => `/kept/${i}`);
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana',
      recent_folders: ['rel', '/a\u0000b', '/a‮b', 5, null, '/x/../y', '/x/', '/kept/0', ...kept]}));
    const runner = (await mesh.config()).runner_settings as Runner;
    assert.deepEqual(runner.values, {operator_name: 'Ana', recent_folders: kept.slice(0, 8)});
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: 'x'}));
    assert.deepEqual(((await mesh.config()).runner_settings as Runner).values, {operator_name: 'Ana', recent_folders: []});
  });

  test('a settings file that cannot be read whole is never rewritten: the start succeeds, the file stays as it was', async () => {
    const big = JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: [], note: 'x'.repeat(17 * 1024)});
    const broken: [string, string][] = [['not JSON', '{"v": 1, "operator_name": "Ana",'], ['not an object', '["Ana"]'],
      ['nested too deep', '['.repeat(16000)], ['over 16 KiB', big], ['not UTF-8', '{"v": 1, "operator_name": "\xff"}'],
      ['a newer version', JSON.stringify({v: 2, operator_name: 'Ana', recent_folders: [], added_later: {x: 1}})]];
    for (const [what, text] of broken) {
      fs.writeFileSync(settingsFile(), what === 'not UTF-8' ? Buffer.from(text, 'latin1') : text);
      const stored = fs.readFileSync(settingsFile());
      assert.equal((await start(mesh, path.join(work, 'a'))).status, 200, `${what}: ${mesh.output()}`);
      assert.ok(fs.readFileSync(settingsFile()).equals(stored), `${what}: recording a start left the file alone`);
      const moved = await importRecent(mesh, {folders: [path.join(work, 'b')]});
      assert.equal(moved.status, 503, `${what}: the browser keeps its copy for a later try`);
      assert.ok(fs.readFileSync(settingsFile()).equals(stored), `${what}: the move left the file alone`);
    }
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: []}));
    fs.chmodSync(settingsFile(), 0o000);
    try {
      assert.equal((await start(mesh, path.join(work, 'a'))).status, 200, 'an unreadable file: the start succeeds');
      assert.equal((await importRecent(mesh, {folders: [path.join(work, 'b')]})).status, 503);
    } finally { fs.chmodSync(settingsFile(), 0o600); }
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')), {v: 1, operator_name: 'Ana', recent_folders: []});
  });

  test('recording a folder keeps the other settings as stored, unknown ones included', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: [], added_later: {x: [1]}}));
    assert.equal((await start(mesh, path.join(work, 'b'))).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')),
      {v: 1, operator_name: 'Ana', recent_folders: [path.join(work, 'b')], added_later: {x: [1]}});
  });

  test('a folder is recorded only when it fits 1024 bytes as stored, so the file stays far below its size limit', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({v: 1, operator_name: 'Ana', recent_folders: []}));
    const deep = (stem: string, part: string) => {
      let folder = path.join(work, stem);
      while (Buffer.byteLength(folder) < 900) folder = path.join(folder, part);
      fs.mkdirSync(folder, {recursive: true});
      return folder;
    };
    const plain = deep('plain', 'p'.repeat(100));
    const quoted = deep('quoted', '"\\'.repeat(50));   // each character takes two bytes once written as JSON
    assert.equal((await start(mesh, plain)).status, 200, mesh.output());
    assert.equal((await start(mesh, quoted)).status, 200, 'the session starts all the same');
    assert.deepEqual(((await mesh.config()).runner_settings as Runner).values, {operator_name: 'Ana', recent_folders: [plain]});
  });
});
