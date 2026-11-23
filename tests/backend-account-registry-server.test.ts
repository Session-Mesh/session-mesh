// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real native resolver behind the server's existing account projection. No live agents or credentials.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, startMesh, scratchHome, runServer, stopServer, removeScratch, type Mesh, type Scratch} from './mesh-server-lib.ts';
import {startFakeHost} from './fake-pty-host.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD || path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const required = process.env.MESH_REQUIRE_MESH_PLATFORM === '1';
const skip = fs.existsSync(PLATFORM) || required ? false : 'build mesh-platform or set MESH_MESH_PLATFORM_CMD';
function prepare(where: Scratch) {
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
  fs.chmodSync(where.confDir, 0o700);
  const root = fs.realpathSync(where.confDir);
  const profiles = ['claude', 'codex'].map(backend => {
    const config = path.join(root, backend), role = backend === 'claude' ? 'history' : 'state';
    const history = path.join(config, backend === 'claude' ? 'projects' : 'sessions');
    fs.mkdirSync(history, {recursive: true, mode: 0o700});
    return {backend, id: 'work', label: `${backend} Work`, enabled: true, roots: {config, [role]: history}};
  });
  fs.writeFileSync(path.join(root, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
  const legacy = path.join(root, 'obsolete'); fs.mkdirSync(legacy, {mode: 0o700});
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({v: 1, accounts: [
    {id: 'legacy', label: 'Obsolete', claude_config_dir: legacy},
  ]}), {mode: 0o600});
}
async function config(mesh: Mesh) {
  const cookie = createHmac('sha256', mesh.token()).update('session-mesh').digest('hex');
  const result = await fetch(`${mesh.base}/api/config`, {headers: {Cookie: `mesh_auth=${cookie}`}});
  assert.equal(result.status, 200); return result.json();
}

for (const backend of ['pi', 'opencode-v2']) for (const access of ['describe', 'open', 'stat']) {
  test(`document protection refreshes a changed ${backend} registry before ${access} access`, {skip, timeout: 45000}, async () => {
    const mesh = await startMesh('accounts-view-refresh-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'}, prepare);
    try {
      const docs = path.join(fs.realpathSync(mesh.home), 'documents');
      fs.mkdirSync(docs, {mode: 0o700});
      fs.writeFileSync(path.join(docs, 'index.html'), '<!doctype html><title>Fixture document</title>');
      const describe = (target: string) => fetch(`${mesh.base}/api/view`, {method: 'POST',
        headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({target})});
      const roles = backend === 'pi' ? ['config', 'history'] : ['config', 'data', 'state', 'cache'];
      const roots = Object.fromEntries(roles.map(role => {
        const folder = path.join(docs, backend, role);
        fs.mkdirSync(folder, {recursive: true, mode: 0o700});
        return [role, folder];
      }));
      const auth = backend === 'pi' ? path.join(roots.config!, 'auth.json')
        : path.join(roots.data!, 'opencode/auth.json');
      fs.mkdirSync(path.dirname(auth), {recursive: true, mode: 0o700});
      fs.writeFileSync(auth, 'profile-protection-fixture', {mode: 0o600});
      const hardlink = path.join(docs, 'linked-login.txt');
      fs.linkSync(auth, hardlink);
      const file = path.join(mesh.confDir, 'backend-profiles.json');
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
      registry.profiles.push({backend, id: 'recent', label: 'Recent', enabled: true, roots});
      fs.writeFileSync(file, JSON.stringify(registry), {mode: 0o600});
      // No configuration or session-list request may refresh protection on this test's behalf.
      const read = (target: string) => access === 'describe' ? describe(target)
        : fetch(`${mesh.base}/api/${access}`, {method: 'POST',
          headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
          body: JSON.stringify(access === 'stat' ? {targets: [target]} : {target})});
      for (const target of [auth, hardlink]) {
        const refused = await read(target);
        if (access === 'stat') {
          assert.equal(refused.status, 200);
          assert.equal((await refused.json() as any).mtimes[target], null);
        } else {
          assert.equal(refused.status, 403,
            `${access} must refresh declared credential protection (got ${refused.status})`);
          assert.ok(!(await refused.text()).includes('profile-protection-fixture'));
        }
      }
      const ordinary = await describe(path.join(docs, 'index.html'));
      assert.equal(ordinary.status, 200);
      const document = await ordinary.json() as {url: string};
      assert.equal((await fetch(`${mesh.base}${document.url}`)).status, 200, 'ordinary documents remain readable');
    } finally { await mesh.stop(); }
  });
}

test('concurrent account protection refreshes share one installed registry snapshot', () => {
  const script = `
import asyncio,json,sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
async def main():
    entered, release = asyncio.Event(), asyncio.Event()
    calls, installed = [], []
    async def inline(function, *args, **kwargs):
        return function(*args, **kwargs)
    async def program(*args):
        calls.append(args)
        entered.set()
        await release.wait()
        return {'accounts': [], 'state': 'ok', 'protected_roots': []}
    server.asyncio.to_thread = inline
    server._accounts_signature = lambda: ('fixture-signature',)
    server._accounts_program = program
    server._protected_folders = lambda *args: []
    server.view.deny_account_files = lambda roots: installed.append(roots)
    first = asyncio.create_task(server.declared_accounts())
    await entered.wait()
    second = asyncio.create_task(server.declared_accounts())
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)
    assert len(calls) == 1, calls
    assert len(installed) == 1, installed
asyncio.run(main())
`;
  const where = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'accounts-refresh-serial-'));
  try {
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: REPO, env: {...process.env, HOME: where, MESH_CONF_DIR: path.join(where, 'config')},
      timeout: 10000,
    });
  } finally { fs.rmSync(where, {recursive: true, force: true}); }
});

test('transient resolver refusal retries without changing signature; invalid inventory stays refused', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'accounts-refresh-retry-'));
  try {
    const script = `
import asyncio,sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
async def inline(function, *args, **kwargs): return function(*args, **kwargs)
server.asyncio.to_thread = inline
server._accounts_signature = lambda: ('registry',)
calls, installed = [], []
async def program(*args):
    calls.append(args)
    if len(calls) == 1: raise server.AccountsUnavailable('temporary timeout', code='helper-unavailable')
    return {'accounts': [], 'protected_roots': []}
server._accounts_program = program
server._protected_folders = lambda *args: []
server.view.deny_account_files = lambda roots: installed.append(roots)
async def main():
    assert await server.declared_accounts() == []
    assert len(calls) == 2 and server._ACCOUNTS['file'] == 'ok', calls
    assert installed == [[]], installed
    server._ACCOUNTS['signature'] = 'old'
    async def timeout(*args): raise server.AccountsUnavailable('timeout', code='helper-unavailable')
    server._accounts_program = timeout
    assert await server.declared_accounts() == []
    assert server._ACCOUNTS['signature'] == 'old'
    server._accounts_program = program
    assert await server.declared_accounts() == []
    assert server._ACCOUNTS['signature'] == ('registry',)
    server._ACCOUNTS['signature'] = 'old'
    invalid_calls = []
    async def invalid(*args): raise server.AccountsUnavailable('invalid registry', code='registry-invalid')
    async def invalid_counted(*args):
        invalid_calls.append(args)
        return await invalid(*args)
    server._accounts_program = invalid_counted
    assert await server.declared_accounts() == []
    assert server._ACCOUNTS['file'] == 'refused'
    assert server._ACCOUNTS['signature'] == ('registry',)
    assert len(invalid_calls) == 1, invalid_calls
asyncio.run(main())
`;
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: REPO, timeout: 10000, env: {...process.env, HOME: root,
        XDG_RUNTIME_DIR: root, MESH_CONF_DIR: path.join(root, 'conf')},
    });
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('cancelled protection worker cannot publish stale roots after newer refresh', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'accounts-refresh-cancel-'));
  try {
    const script = `
import asyncio,json,threading,sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
entered, release = threading.Event(), threading.Event()
generation = ['old']
server._accounts_signature = lambda: (generation[0],)
async def program(*args):
    return {'accounts': [], 'protected_roots': [str(Path(${JSON.stringify(root)}) / generation[0])]}
server._accounts_program = program
original = server._protected_folders
def blocked(*args):
    if generation[0] == 'old':
        entered.set()
        assert release.wait(5)
    return original(*args)
server._protected_folders = blocked
installed = []
server.view.deny_account_files = lambda roots: installed.append(roots)
async def main():
    first = asyncio.create_task(server.declared_accounts())
    assert await asyncio.to_thread(entered.wait, 5)
    first.cancel()
    generation[0] = 'new'
    second = asyncio.create_task(server.declared_accounts())
    await asyncio.sleep(0.05)
    assert not second.done(), 'a cancelled worker must finish before the next refresh publishes'
    release.set()
    try: await first
    except asyncio.CancelledError: pass
    await second
    latest = json.loads(server.ACCOUNTS_PROTECTED_FILE.read_text())
    assert str(Path(${JSON.stringify(root)}) / 'new') in latest
    assert str(Path(${JSON.stringify(root)}) / 'old') in latest
    assert installed and str(Path(${JSON.stringify(root)}) / 'new') in installed[-1]
    assert server._ACCOUNTS['signature'] == ('new',)
asyncio.run(main())
`;
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: REPO, timeout: 10000, env: {...process.env, HOME: root,
        XDG_RUNTIME_DIR: root, MESH_CONF_DIR: path.join(root, 'conf')},
    });
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('registry becomes the server source; backend labels survive and file edits invalidate its cache', {skip, timeout: 45000}, async () => {
  fs.accessSync(PLATFORM, fs.constants.X_OK);
  const mesh = await startMesh('accounts-registry-http-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin',
    MESH_SESSION: undefined, MESH_SESSION_TOKEN: undefined}, prepare);
  try {
    const first = await config(mesh);
    assert.deepEqual(first.capabilities, {account_settings: true});
    assert.equal(first.accounts.length, 1); assert.equal(first.accounts[0].id, 'work');
    assert.deepEqual(first.accounts[0].backend_labels, {claude: 'claude Work', codex: 'codex Work'});
    assert.equal(first.accounts[0].claude, true); assert.equal(first.accounts[0].codex, true);
    assert.deepEqual(Object.keys(first.accounts[0]).sort(),
      ['id', 'label', 'claude', 'codex', 'backend_labels'].sort(), 'two-backend inventory keeps its old shape');
    assert.ok(!JSON.stringify(first.accounts).includes(mesh.confDir));
    const file = path.join(mesh.confDir, 'backend-profiles.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    registry.profiles[1].label = 'New Codex'; fs.writeFileSync(file, JSON.stringify(registry));
    const changed = await config(mesh);
    assert.equal(changed.accounts[0].backend_labels.codex, 'New Codex');
    registry.profiles[0].enabled = false; fs.writeFileSync(file, JSON.stringify(registry));
    const disabled = await config(mesh);
    assert.equal(disabled.accounts[0].claude, false); assert.equal(disabled.accounts[0].codex, true);
    fs.writeFileSync(file, '{');
    assert.deepEqual((await config(mesh)).accounts, [], 'a malformed registry never revives the legacy account');
  } finally { await mesh.stop(); }
});

test('configuration offers native Pi/OpenCode availability and backend-specific labels without exposing roots', {skip, timeout: 45000}, async () => {
  const mesh = await startMesh('accounts-four-config-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'},
    where => {
      prepare(where);
      const file = path.join(where.confDir, 'backend-profiles.json');
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [backend, id, label, roles] of [
        ['pi', 'work', 'Pi Work', ['config', 'history']],
        ['opencode-v2', 'work', 'OpenCode Work', ['config', 'data', 'state', 'cache']],
        ['pi', 'pi-only', 'Pi Alone', ['config', 'history']],
      ] as const) {
        const roots = Object.fromEntries(roles.map(role => {
          const folder = path.join(where.home, `${backend}-${id}`, role);
          fs.mkdirSync(folder, {recursive: true, mode: 0o700}); return [role, folder];
        }));
        registry.profiles.push({backend, id, label, enabled: true, roots});
      }
      fs.writeFileSync(file, JSON.stringify(registry), {mode: 0o600});
      const auth = path.join(where.home, 'opencode-v2-work', 'data', 'opencode', 'auth.json');
      fs.mkdirSync(path.dirname(auth), {mode: 0o700});
      fs.writeFileSync(auth, 'native-profile-auth-fixture', {mode: 0o600});
      fs.linkSync(auth, path.join(where.home, 'auth-hardlink.md'));
      const piAuth = path.join(where.home, 'pi-work', 'config', 'auth.json');
      fs.writeFileSync(piAuth, 'pi-private-fixture', {mode: 0o600});
      fs.linkSync(piAuth, path.join(where.home, 'pi-auth-hardlink.md'));
    });
  try {
    const report = await config(mesh);
    const work = report.accounts.find((a: any) => a.id === 'work');
    const piOnly = report.accounts.find((a: any) => a.id === 'pi-only');
    assert.deepEqual({claude: work.claude, codex: work.codex, opencode: work.opencode, pi: work.pi},
      {claude: true, codex: true, opencode: true, pi: true});
    assert.deepEqual(work.backend_labels,
      {claude: 'claude Work', codex: 'codex Work', pi: 'Pi Work', 'opencode-v2': 'OpenCode Work'});
    assert.deepEqual({claude: piOnly.claude, codex: piOnly.codex, opencode: piOnly.opencode, pi: piOnly.pi},
      {claude: false, codex: false, opencode: false, pi: true});
    assert(!JSON.stringify(report.accounts).includes(mesh.home), 'no root in the public inventory');
    for (const target of ['opencode-v2-work/data/opencode/auth.json', 'auth-hardlink.md',
                          'pi-work/config/auth.json', 'pi-auth-hardlink.md']) {
      const response = await fetch(`${mesh.base}/api/view`, {method: 'POST',
        headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({target: path.join(mesh.home, target)})});
      assert.equal(response.status, 403, target);
    }
  } finally { await mesh.stop(); }
});

test('declared XDG data bases protect OpenCode login files and hard links without hiding ordinary documents', {skip, timeout: 45000}, async () => {
  const mesh = await startMesh('accounts-registry-view-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'}, where => {
    prepare(where);
    const file = path.join(where.confDir, 'backend-profiles.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roots = Object.fromEntries(['config', 'data', 'state', 'cache'].map(role => {
      const folder = path.join(where.home, 'oc-profile', role);
      fs.mkdirSync(folder, {recursive: true, mode: 0o700}); return [role, folder];
    }));
    fs.mkdirSync(path.join(roots.data!, 'opencode'), {mode: 0o700});
    const auth = path.join(roots.data!, 'opencode/auth.json');
    fs.writeFileSync(auth, '{"fixture":"private-do-not-display"}', {mode: 0o600});
    fs.linkSync(auth, path.join(where.home, 'public-hardlink.md'));
    fs.writeFileSync(path.join(where.home, 'ordinary.md'), 'Ordinary fixture');
    registry.profiles.push({id: 'oc', label: 'OC', backend: 'opencode-v2', enabled: false, roots});
    fs.writeFileSync(file, JSON.stringify(registry));
  });
  try {
    const describe = (target: string) => fetch(`${mesh.base}/api/view`, {method: 'POST',
      headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'}, body: JSON.stringify({target})});
    const ordinary = await describe(path.join(mesh.home, 'ordinary.md'));
    assert.equal(ordinary.status, 200, await ordinary.text());
    for (const name of ['oc-profile/data/opencode/auth.json', 'public-hardlink.md']) {
      const response = await describe(path.join(mesh.home, name));
      assert.equal(response.status, 403, name); assert.ok(!(await response.text()).includes('private-do-not-display'));
    }
  } finally { await mesh.stop(); }
});

test('a session-list read refreshes backend-specific labels without a configuration request', {skip, timeout: 45000}, async () => {
  const where = await scratchHome('accounts-label-list-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'});
  prepare(where);
  const host = await startFakeHost(path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh/ptyhost.sock'), {sessions: [{
    name: 'alpha', pid: process.pid, cwd: where.home, created: 1700000000, activity: 1700000000, attached: 0,
    meta: {account: 'work', known_agent: 'codex'},
  }]});
  let server: Awaited<ReturnType<typeof runServer>> | undefined;
  try {
    server = await runServer(where); assert.equal(server.result.listened, true, server.result.output);
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    const cookie = createHmac('sha256', token).update('session-mesh').digest('hex');
    const label = async () => {
      const response = await fetch(`http://127.0.0.1:${where.port}/api/sessions`, {headers: {Cookie: `mesh_auth=${cookie}`}});
      assert.equal(response.status, 200); const data = await response.json();
      return data.mesh.find((s: any) => s.id === 'alpha' || s.name === 'alpha')?.account_label;
    };
    assert.equal(await label(), 'codex Work');
    const file = path.join(where.confDir, 'backend-profiles.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    registry.profiles[1].label = 'Refreshed Codex'; fs.writeFileSync(file, JSON.stringify(registry));
    const deadline = Date.now() + 8000;
    while (await label() !== 'Refreshed Codex') {
      assert.ok(Date.now() < deadline, 'session-list reads must refresh the profile label without /api/config');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    try { if (server) await stopServer(server.child); } finally { await host.stop(); removeScratch(where.scratch); }
  }
});

test('a full registry retains all credential protections after a later configuration refusal', {skip, timeout: 45000}, async () => {
  const mesh = await startMesh('accounts-registry-retention-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'}, where => {
    fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
    const profiles = Array.from({length: 128}, (_, index) => {
      const roots = Object.fromEntries(['config', 'data', 'state', 'cache'].map(role => {
        const directory = path.join(where.home, 'profiles', `a${index}`, role);
        fs.mkdirSync(directory, {recursive: true, mode: 0o700}); return [role, directory];
      }));
      return {id: `a${index}`, label: `Account ${index}`, backend: 'opencode-v2', enabled: false, roots};
    });
    fs.writeFileSync(path.join(where.confDir, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
    fs.writeFileSync(path.join(where.home, 'profiles/a0/config/auth.json'), 'private-fixture', {mode: 0o600});
    fs.writeFileSync(path.join(where.home, 'ordinary.md'), 'Ordinary document');
  });
  try {
    await config(mesh);
    const remembered = JSON.parse(fs.readFileSync(path.join(mesh.confDir, 'accounts-protected.json'), 'utf8'));
    assert.equal(remembered.length, 384, 'every config/data/state root survives the persistence bound');
    fs.writeFileSync(path.join(mesh.confDir, 'backend-profiles.json'), '{');
    assert.deepEqual((await config(mesh)).accounts, []);
    for (const [name, expected] of [['profiles/a0/config/auth.json', 403], ['ordinary.md', 200]] as const) {
      const response = await fetch(`${mesh.base}/api/view`, {method: 'POST',
        headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({target: path.join(mesh.home, name)})});
      assert.equal(response.status, expected, name);
    }
  } finally { await mesh.stop(); }
});

test('current roots take precedence over a saturated history and remain remembered after refusal', {skip, timeout: 45000}, async () => {
  const mesh = await startMesh('accounts-current-retention-', {MESH_MESH_PLATFORM_CMD: PLATFORM, PATH: '/usr/bin:/bin'}, where => {
    prepare(where);
    const current = path.join(fs.realpathSync(where.confDir), 'claude');
    const known = [current, ...Array.from({length: 1023}, (_, index) => path.join(where.home, 'history', `h${index}`))];
    fs.writeFileSync(path.join(where.confDir, 'accounts-protected.json'), JSON.stringify(known), {mode: 0o600});
    fs.writeFileSync(path.join(current, 'auth.json'), 'retention-fixture', {mode: 0o600});
    fs.writeFileSync(path.join(where.home, 'ordinary.md'), 'Ordinary fixture');
  });
  try {
    await config(mesh);
    const current = path.join(fs.realpathSync(mesh.confDir), 'claude');
    const remembered = JSON.parse(fs.readFileSync(path.join(mesh.confDir, 'accounts-protected.json'), 'utf8')) as string[];
    assert.equal(remembered.length, 1024);
    assert(remembered.includes(current), 'current roots must be persisted, not only added to the immediate return value');
    assert(remembered.includes(path.join(fs.realpathSync(mesh.confDir), 'codex')));
    assert(!remembered.includes(path.join(mesh.home, 'history/h0')), 'only historical roots are evicted');
    fs.writeFileSync(path.join(mesh.confDir, 'backend-profiles.json'), '{');
    assert.deepEqual((await config(mesh)).accounts, []);
    for (const [target, expected] of [[path.join(current, 'auth.json'), 403], [path.join(mesh.home, 'ordinary.md'), 200]] as const) {
      const response = await fetch(`${mesh.base}/api/view`, {method: 'POST',
        headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({target})});
      assert.equal(response.status, expected);
    }
  } finally { await mesh.stop(); }
});

test('account cache observes a link-count change even when timestamps and all other stat fields are unchanged', () => {
  const answer = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json,sys
from types import SimpleNamespace
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
def stat(links):
    return SimpleNamespace(st_ino=1,st_size=100,st_mtime_ns=1,st_ctime_ns=1,st_mode=33152,st_nlink=links)
server.os.lstat=lambda _: stat(2)
before=server._accounts_signature()
server.os.lstat=lambda _: stat(1)
print(json.dumps(before != server._accounts_signature()))
`], {encoding: 'utf8', timeout: 10000});
  assert.equal(JSON.parse(answer), true);
});
