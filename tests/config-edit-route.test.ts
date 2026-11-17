// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The owner edits two launch settings from the Configuration dialog: the enabled agents and the
// allowed work folders. Editing needs the owner cookie AND a short elevation (the master token,
// typed again). Run on a throwaway server and PTY host; the real mesh is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

let mesh: ConfigMesh;
const spare: ConfigMesh[] = [];
const home = () => mesh.home;
const initial = (where: string) => ({v: 1 as const, workspace_roots: [path.join(where, 'work')], enabled_agents: ['claude']});

before(async () => {
  mesh = await ConfigMesh.start('cfe-', initial);
  assert.equal((await mesh.elevate()).status, 200);
  fs.symlinkSync(mesh.outside, path.join(mesh.home, 'escape'));
  fs.symlinkSync(path.join(mesh.home, 'work'), path.join(mesh.home, 'alias'));
  fs.writeFileSync(path.join(mesh.home, 'plain-file'), 'x');
});
after(async () => {
  await mesh?.stop();
  for (const other of spare) await other.stop();
});

async function reset(): Promise<void> {
  const response = await mesh.save(['claude'], [path.join(home(), 'work')]);
  assert.equal(response.status, 200, await response.clone().text());
}

describe('who may edit', () => {
  test('only the owner cookie: no credential, master token, session token, or any header beside the cookie', async () => {
    assert.equal((await mesh.post('/api/new', {preset: 'claude', cwd: path.join(home(), 'work'), name: 'agent1'},
      {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'})).status, 200);
    const tokenFile = path.join(home(), 'work', 'token');
    for (let i = 0; i < 100 && !fs.existsSync(tokenFile); i += 1) await new Promise(r => setTimeout(r, 100));
    const session = fs.readFileSync(tokenFile, 'utf8').trim();
    const body = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [path.join(home(), 'work')]};
    const json = {'Content-Type': 'application/json', Origin: mesh.base};
    for (const route of ['/api/config/launch', '/api/config/elevate', '/api/config/elevate/revoke']) {
      const payload = route.endsWith('elevate') ? {token: mesh.token()} : body;
      assert.equal((await mesh.post(route, payload, json)).status, 401, `${route}: no credential`);
      assert.equal((await mesh.post(route, payload, {...json, Authorization: `Bearer ${mesh.token()}`})).status, 401, `${route}: master token`);
      assert.equal((await mesh.post(route, payload, {...json, Authorization: `MeshSession ${session}`})).status, 401, `${route}: session token`);
      assert.equal((await mesh.post(route, payload, {...mesh.owner(), Authorization: `Bearer ${mesh.token()}`})).status, 401, `${route}: cookie + master token`);
      assert.equal((await mesh.post(route, payload, {...mesh.owner(), Authorization: `MeshSession ${session}`})).status, 401, `${route}: cookie + session token`);
    }
    assert.deepEqual(mesh.file().enabled_agents, ['claude'], 'nothing was written');
  });

  test('a foreign origin is refused, and so is any content type but JSON', async () => {
    const body = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [path.join(home(), 'work')]};
    assert.equal((await mesh.post('/api/config/launch', body, {...mesh.owner(), Origin: 'https://evil.example'})).status, 403);
    assert.equal((await mesh.post('/api/config/elevate', {token: mesh.token()}, {...mesh.owner(false), Origin: 'https://evil.example'})).status, 403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/json']) {
      const response = await mesh.post('/api/config/launch', JSON.stringify(body), {...mesh.owner(), 'Content-Type': type});
      assert.equal(response.status, 415, type);
    }
    assert.equal((await mesh.post('/api/config/launch', JSON.stringify(body), {Cookie: `${mesh.cookie}; ${mesh.elevation}`, Origin: mesh.base})).status, 415, 'no content type');
  });

  test('without an elevation the owner cookie alone cannot write; revoking ends it', async () => {
    const body = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [path.join(home(), 'work')]};
    const locked = await mesh.post('/api/config/launch', body, mesh.owner(false));
    assert.equal(locked.status, 403);
    assert.equal(((await locked.json()) as {error: string}).error, 'elevation-required');
    const kept = mesh.elevation;
    assert.equal((await mesh.post('/api/config/elevate/revoke', {})).status, 200);
    assert.equal((await mesh.post('/api/config/launch', body, {...mesh.owner(false), Cookie: `${mesh.cookie}; ${kept}`})).status, 403, 'the old elevation cookie is dead');
    assert.equal((await mesh.elevate()).status, 200);
  });

  test('a wrong master token grants nothing, and the token never appears in an answer or the log', async () => {
    const wrong = await mesh.post('/api/config/elevate', {token: 'not-the-token'}, mesh.owner(false));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const good = await mesh.post('/api/config/elevate', {token: mesh.token()}, mesh.owner(false));
    const cookie = good.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.ok(!cookie.includes(mesh.token()) && !(await good.text()).includes(mesh.token()));
    assert.ok(!mesh.output().includes(mesh.token()), 'the server log does not carry the token');
    mesh.elevation = cookie.split(';')[0]!;
  });

  test('the elevation is bound to the login: "log out everywhere" ends it', async () => {
    const stale = mesh.elevation;
    assert.equal((await mesh.post('/api/logout-all', {}, mesh.owner(false))).status, 200);
    await mesh.signIn();
    const body = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [path.join(home(), 'work')]};
    assert.equal((await mesh.post('/api/config/launch', body, {...mesh.owner(false), Cookie: `${mesh.cookie}; ${stale}`})).status, 403);
    assert.equal((await mesh.elevate()).status, 200);
  });

  test('failed attempts are limited: five wrong tokens, then 429 even for the right one', async () => {
    const other = await ConfigMesh.start('cfe-rate-', initial);
    spare.push(other);
    for (let i = 0; i < 5; i += 1) assert.equal((await other.post('/api/config/elevate', {token: `bad-${i}`}, other.owner(false))).status, 403);
    const blocked = await other.post('/api/config/elevate', {token: other.token()}, other.owner(false));
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

describe('what may be written', () => {
  const work = () => path.join(home(), 'work');
  const refused = async (agents: unknown, roots: unknown, why: RegExp, status = 400): Promise<void> => {
    const before = fs.readFileSync(mesh.settingsPath, 'utf8');
    const response = await mesh.post('/api/config/launch', {revision: await mesh.revision(), enabled_agents: agents, workspace_roots: roots});
    const text = await response.text();
    assert.equal(response.status, status, text);
    assert.match(text, why);
    assert.equal(fs.readFileSync(mesh.settingsPath, 'utf8'), before, 'a refused edit changes nothing');
  };

  test('agents: only the names of the launch catalogue, at least one', async () => {
    await refused(['claude', 'rm -rf'], [work()], /unknown agent/);
    await refused(['bash'], [work()], /unknown agent/);
    await refused([], [work()], /at least one agent/);
    await refused([7], [work()], /unknown agent/);
    await refused('claude', [work()], /at least one agent/);
    await refused(['claude', 'claude'], [work()], /unique/);
  });

  test('folders: absolute, existing, real, inside the home, no duplicates, bounded', async () => {
    await refused(['claude'], ['work'], /absolute/);
    await refused(['claude'], ['~/work'], /absolute/);
    await refused(['claude'], [path.join(home(), '..', 'elsewhere')], /unavailable|outside/);
    await refused(['claude'], [path.join(home(), 'work', '..', '..')], /outside the Mesh home perimeter/);
    await refused(['claude'], [path.join(home(), 'missing')], /unavailable/);
    await refused(['claude'], [path.join(home(), 'plain-file')], /outside the Mesh home perimeter|invalid/);
    await refused(['claude'], ['/etc'], /outside the Mesh home perimeter/);
    await refused(['claude'], [path.join(home(), 'escape')], /outside the Mesh home perimeter/);
    await refused(['claude'], [path.join(home(), 'escape', 'nested')], /unavailable|outside/);
    await refused(['claude'], [work(), work()], /unique/);
    await refused(['claude'], [work(), path.join(home(), 'alias')], /unique/);
    await refused(['claude'], [], /between 1 and 16/);
    await refused(['claude'], Array.from({length: 17}, () => work()), /between 1 and 16/);
    await refused(['claude'], ['/' + 'a'.repeat(1025)], /outside|unavailable|invalid/);
    await refused(['claude'], [7], /invalid/);
    await refused(['claude'], 'x', /between 1 and 16/);
  });

  test('a body that is too large or has other fields is refused', async () => {
    const huge = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [work()], padding: 'x'.repeat(40 * 1024)};
    assert.equal((await mesh.post('/api/config/launch', huge)).status, 413);
    const base = {revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: [work()]};
    for (const extra of [{port: 1}, {listen_host: '0.0.0.0'}, {trust_proxy: true}, {v: 1}]) {
      assert.equal((await mesh.post('/api/config/launch', {...base, ...extra})).status, 400, JSON.stringify(extra));
    }
    assert.equal((await mesh.post('/api/config/launch', {enabled_agents: ['claude'], workspace_roots: [work()]})).status, 400);
    assert.equal((await mesh.post('/api/config/launch', {...base, revision: 5})).status, 400);
    assert.equal((await mesh.post('/api/config/launch', '[1,2]')).status, 400);
    assert.equal((await mesh.post('/api/config/launch', '{not json')).status, 400);
    assert.equal((await mesh.post('/api/config/launch?x=1', base)).status, 400);
  });

  test('a valid edit stores physical paths, in the same v1 format', async () => {
    const response = await mesh.save(['codex', 'claude'], [path.join(home(), 'alias')]);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(mesh.file(), {v: 1, workspace_roots: [fs.realpathSync(path.join(home(), 'work'))], enabled_agents: ['claude', 'codex']});
    await reset();
  });
});

describe('concurrent edits and atomic writes', () => {
  test('a stale revision is refused: two tabs never overwrite each other silently', async () => {
    await reset();
    const seen = await mesh.revision();
    const first = await mesh.save(['claude', 'codex'], [path.join(home(), 'work')], seen);
    assert.equal(first.status, 200);
    const second = await mesh.save(['claude'], [path.join(home(), 'work2')], seen);
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as {error: string}).error, 'stale-revision');
    assert.deepEqual(mesh.file().enabled_agents, ['claude', 'codex'], 'the first tab\'s edit stands');
    assert.notEqual(await mesh.revision(), seen);
    await reset();
  });

  test('two saves with the same revision at once: exactly one wins', async () => {
    const seen = await mesh.revision();
    const results = await Promise.all([
      mesh.save(['claude', 'codex'], [path.join(home(), 'work')], seen),
      mesh.save(['claude'], [path.join(home(), 'work2')], seen)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    await reset();
  });

  test('the file is replaced atomically: always whole JSON, same mode, no temporary file left', async () => {
    const mode = (fs.statSync(mesh.settingsPath).mode & 0o777);
    assert.equal(mode, 0o640);
    let reading = true, bad = 0, reads = 0;
    const reader = (async () => {
      while (reading) {
        try { JSON.parse(fs.readFileSync(mesh.settingsPath, 'utf8')); } catch { bad += 1; }
        reads += 1;
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 15; i += 1) {
      const roots = [path.join(home(), i % 2 ? 'work2' : 'work')];
      assert.equal((await mesh.save(i % 3 ? ['claude'] : ['claude', 'codex'], roots)).status, 200);
    }
    reading = false;
    await reader;
    assert.ok(reads > 15);
    assert.equal(bad, 0, 'a reader never saw a partial file');
    assert.equal(fs.statSync(mesh.settingsPath).mode & 0o777, mode, 'the file keeps its mode');
    assert.deepEqual(fs.readdirSync(path.dirname(mesh.settingsPath)).filter(name => name.startsWith('.launch-settings')), []);
    await reset();
  });

  test('a file edited outside Mesh is not overwritten: 409 "file-changed"', async () => {
    const seen = await mesh.revision();
    const original = fs.readFileSync(mesh.settingsPath);
    const edited = {...mesh.file(), enabled_agents: ['claude', 'pi']};
    fs.writeFileSync(mesh.settingsPath, JSON.stringify(edited));
    const response = await mesh.save(['claude'], [path.join(home(), 'work')], seen);
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as {error: string}).error, 'file-changed');
    assert.deepEqual(mesh.file().enabled_agents, ['claude', 'pi'], 'the outside edit is kept');
    fs.writeFileSync(mesh.settingsPath, original, {mode: 0o640});
  });
});

describe('effect on "+ New"', () => {
  test('applies at once, with no restart, and leaves running sessions alone', async () => {
    await reset();
    const work = path.join(home(), 'work'), work2 = path.join(home(), 'work2');
    assert.equal((await mesh.launch('claude', work, 'before')).status, 200);
    assert.equal((await mesh.launch('codex', work, 'nocodex')).status, 400, 'codex is not enabled yet');
    assert.equal((await mesh.launch('claude', work2, 'nowork2')).status, 403, 'work2 is not allowed yet');

    assert.equal((await mesh.save(['claude', 'codex'], [work, work2])).status, 200);
    assert.equal((await mesh.launch('codex', work2, 'codex-ok')).status, 200, 'now allowed, same server process');

    assert.equal((await mesh.save(['codex'], [work2])).status, 200);
    assert.equal((await mesh.launch('claude', work2, 'claude-off')).status, 400, 'claude is disabled now');
    assert.equal((await mesh.launch('codex', work, 'work-off')).status, 403, 'work is no longer allowed');
    const listed = await (await fetch(`${mesh.base}/api/sessions`, {headers: mesh.owner(false)})).json() as {name?: string; id?: string}[];
    const names = JSON.stringify(listed);
    assert.ok(names.includes('before'), 'the session started earlier is still there');
    assert.ok(names.includes('codex-ok'));
    await reset();
  });

  test('GET /api/config reports the editable state, revision, limits, defaults and elevation', async () => {
    const config = await mesh.config();
    assert.equal(config.launch.editable, true);
    assert.match(config.launch.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(config.launch.limits, {max_roots: 16, max_path: 1024});
    assert.deepEqual(config.launch.defaults.workspace_roots, [fs.realpathSync(mesh.home)]);
    assert.ok(config.launch.known_agents.includes('codex-yolo'));
    assert.deepEqual(config.launch.defaults.enabled_agents, config.launch.known_agents);
    assert.equal(config.elevation.active, true);
    assert.ok(config.elevation.seconds_left > 0 && config.elevation.seconds_left <= config.elevation.duration);
    assert.equal(config.paths.launch_settings, mesh.settingsPath);
    assert.ok(!JSON.stringify(config).includes(mesh.token()));
  });
});

describe('without a settings file', () => {
  test('nothing can be edited: the report says so and a save is refused with 409 not-configured', async () => {
    const bare = await ConfigMesh.start('cfe-bare-', null);
    spare.push(bare);
    assert.equal((await bare.elevate()).status, 200);
    const config = await bare.config();
    assert.equal(config.launch.editable, false);
    assert.equal(config.launch.revision, null);
    const response = await bare.post('/api/config/launch', {revision: 'x', enabled_agents: ['claude'], workspace_roots: [bare.home]});
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as {error: string}).error, 'not-configured');
    assert.equal(fs.existsSync(bare.settingsPath), false, 'no file is created');
  });
});
