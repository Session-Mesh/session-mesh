// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The native resolver and the shell command actually sent to the host share one selected profile.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const native = process.env.MESH_MESH_PLATFORM_CMD ||
  path.join(repo, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const python = process.env.MESH_PYTHON || 'python3';
const skip = fs.existsSync(native) || process.env.MESH_REQUIRE_MESH_PLATFORM === '1' ? false
  : 'build mesh-platform or set MESH_MESH_PLATFORM_CMD';

test('selected native profiles reach executed argv without ambient providers, while Pi profiles are refused', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-four-launch-'));
  try {
    const bin = path.join(root, 'bin'), conf = path.join(root, 'conf'), cwd = path.join(root, 'project');
    for (const directory of [bin, conf, cwd]) fs.mkdirSync(directory, {mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    const profiles = ['claude', 'codex', 'opencode-v2', 'pi'].map((backend, index) => {
      const names = backend === 'opencode-v2' ? ['config', 'data', 'state', 'cache']
        : backend === 'codex' ? ['config', 'state'] : ['config', 'history'];
      const roots = Object.fromEntries(names.map(role => [role, path.join(root, `selected-${index}-${role}`)]));
      for (const directory of Object.values(roots)) fs.mkdirSync(directory as string, {mode: 0o700});
      return {backend, id: `selected-${index}`, label: `Selected ${index}`, enabled: true, roots};
    });
    fs.writeFileSync(path.join(conf, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
    const preflight = path.join(root, 'preflight.jsonl');
    const executable = `#!${process.execPath}
const fs = require('node:fs'), name = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(preflight)}, JSON.stringify({name, args, env: process.env}) + '\\n');
  console.log(name === 'pi' ? '1.3.0' : '2.0.28-native1m.1'); process.exit(0);
}
if (name === 'opencode' && args[0] === 'api') {
  fs.appendFileSync(${JSON.stringify(preflight)}, JSON.stringify({name, args, env: process.env}) + '\\n');
  console.log(JSON.stringify([{info: {mcp: {servers: {}}}}])); process.exit(0);
}
fs.appendFileSync(process.env.MESH_RECORD, JSON.stringify({name, args, env: process.env}) + '\\n');
`;
    for (const name of ['claude', 'codex', 'opencode', 'pi']) {
      fs.writeFileSync(path.join(bin, name), executable, {mode: 0o700});
    }
    fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
    const record = path.join(root, 'record.jsonl');
    const script = `
import asyncio,json,os,subprocess,sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
metas = []
server.claudewake.launch_command = lambda command,*args: command
async def fake_host(request):
    return []
async def launch(request, conversation):
    metas.append(request['meta'])
    result = subprocess.run(['/bin/sh','-c',request['command']], cwd=request['cwd'],
                            env={**os.environ, **request['env']}, capture_output=True, timeout=5)
    if result.returncode:
        raise RuntimeError((result.returncode, result.stderr.decode()))
server.host = fake_host
server._send_launch = launch
async def main():
    for index, agent in enumerate(['claude','codex','opencode']):
        await server.new_session('test', ${JSON.stringify(cwd)}, agent, agent, agent,
                                 account=f'selected-{index}')
    try:
        await server.new_session('test', ${JSON.stringify(cwd)}, 'pi', 'pi', 'pi', account='selected-3')
        raise AssertionError('Pi profile admitted')
    except server.web.HTTPConflict as error:
        assert error.text == server.PI_PROFILE_UNAVAILABLE
    print(json.dumps(metas))
asyncio.run(main())
`;
    const metas = JSON.parse(execFileSync(python, ['-I', '-c', script], {cwd, encoding: 'utf8', timeout: 30000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin, MESH_RECORD: record,
        PATH: `${bin}:/usr/bin:/bin`, OPENAI_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient',
        OPENCODE_DB: path.join(root, 'ambient.db'), OPENCODE_CONFIG: path.join(root, 'ambient.json'),
        OPENCODE_CONFIG_CONTENT: '{"ambient":true}',
        XDG_CONFIG_HOME: path.join(root, 'ambient-config'), XDG_DATA_HOME: path.join(root, 'ambient-data'),
        XDG_STATE_HOME: path.join(root, 'ambient-state'), XDG_CACHE_HOME: path.join(root, 'ambient-cache'),
        PI_CODING_AGENT_DIR: path.join(root, 'ambient-pi')}})) as Array<Record<string, string>>;
    assert.equal(metas.length, 3);
    for (const [index, meta] of metas.entries()) {
      assert.equal(meta.account, `selected-${index}`);
      assert.match(meta.account_context_revision!, /^[0-9a-f]{64}$/);
    }
    const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.name), ['claude', 'codex', 'opencode']);
    const probes = fs.readFileSync(preflight, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(probes.some(call => call.name === 'opencode' && call.args[0] === 'api'
      && call.env.XDG_CONFIG_HOME === profiles[2]!.roots.config
      && call.env.XDG_DATA_HOME === profiles[2]!.roots.data
      && call.env.OPENCODE_DB === undefined && call.env.OPENCODE_CONFIG === undefined
      && call.env.OPENCODE_CONFIG_CONTENT === undefined));
    for (let index = 0; index < calls.length; index++) {
      const {env} = calls[index]!;
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.HOME, root, 'HOME remains the runner HOME');
      if (index === 0) assert.equal(env.CLAUDE_CONFIG_DIR, profiles[index]!.roots.config);
      if (index === 1) assert.equal(env.CODEX_HOME, profiles[index]!.roots.config);
      if (index === 2) {
        assert.equal(env.OPENCODE_DB, undefined);
        assert.equal(env.OPENCODE_CONFIG, undefined);
        assert.notEqual(env.OPENCODE_CONFIG_CONTENT, '{"ambient":true}');
        for (const role of ['config', 'data', 'state', 'cache']) {
          assert.equal(env[`XDG_${role.toUpperCase()}_HOME`], profiles[index]!.roots[role]);
        }
      }
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('native restore refuses unknown or changed context revisions before admitting any launch', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-restore-context-'));
  try {
    const conf = path.join(root, 'conf'), config = path.join(root, 'codex-config');
    const history = path.join(root, 'codex-state'), bin = path.join(root, 'bin');
    for (const directory of [conf, config, history, bin]) fs.mkdirSync(directory, {mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    const file = path.join(conf, 'backend-profiles.json');
    const profile = {id: 'work', label: 'Work', backend: 'codex', enabled: true,
      roots: {config, state: history}};
    fs.writeFileSync(file, JSON.stringify({version: 1, profiles: [profile]}), {mode: 0o600});
    const sid = '00000000-0000-0000-0000-000000000001';
    const script = `
import asyncio,json,sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server,respawn
async def main():
    entry = {'account': 'work', 'agent': {'type': 'codex', 'session_id': ${JSON.stringify(sid)}}}
    try:
        await server._restore_launch_context(entry)
        raise AssertionError('unknown revision admitted')
    except server.web.HTTPConflict: pass
    snapshot = await server._profile_launch_context('work', 'codex')
    entry['account_context_revision'] = snapshot['context_revision']
    persisted = respawn.valid_entry({'name':'mesh-codex','cwd':${JSON.stringify(root)},'created':1,
        'agent':{'type':'codex','session_id':${JSON.stringify(sid)},'argv':['codex','resume',${JSON.stringify(sid)}]},
        'account':'work','account_context_revision':entry['account_context_revision']})
    assert persisted['account_context_revision'] == entry['account_context_revision']
    context = await server._restore_launch_context(entry)
    assert context['roots']['state'] == ${JSON.stringify(history)}
    entry['account_context_revision'] = '0'*64
    try:
        await server._restore_launch_context(entry)
        raise AssertionError('changed revision admitted')
    except server.web.HTTPConflict: pass
    changed = ${JSON.stringify(path.join(root, 'changed-config'))}
    from pathlib import Path
    Path(${JSON.stringify(file)}).write_text(json.dumps({'version':1,'profiles':[{
        'id':'work','label':'Work','backend':'codex','enabled':True,
        'roots':{'config':changed,'state':changed+'/sessions'}}]}))
    entry['account_context_revision'] = snapshot['context_revision']
    try:
        await server._restore_launch_context(entry)
        raise AssertionError('changed roots admitted')
    except server.web.HTTPConflict: pass
    assert not Path(changed).exists(), 'revision mismatch created new credential root'
    async def malformed(*args, **kwargs):
        return {'context': {**snapshot, 'unset': ['PATH']}}
    server._accounts_program = malformed
    try:
        await server._profile_launch_context('work', 'codex')
        raise AssertionError('arbitrary environment removal admitted')
    except server.web.HTTPBadRequest: pass
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('selected OpenCode profile refuses v1, unreadable and unsupported versions before host launch', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-opencode-version-'));
  try {
    const conf = path.join(root, 'conf'), bin = path.join(root, 'bin');
    fs.mkdirSync(conf, {mode: 0o700}); fs.mkdirSync(bin, {mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    const roots = Object.fromEntries(['config', 'data', 'state', 'cache'].map(role => {
      const directory = path.join(root, role); fs.mkdirSync(directory, {mode: 0o700}); return [role, directory];
    }));
    fs.writeFileSync(path.join(conf, 'backend-profiles.json'), JSON.stringify({version: 1, profiles: [
      {id: 'work', label: 'Work', backend: 'opencode-v2', enabled: true, roots},
    ]}), {mode: 0o600});
    const script = `
import asyncio,sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
sent = []
async def host(request):
    sent.append(request)
    return []
server.host = host
async def send_launch(request, conversation):
    sent.append(request)
server._send_launch = send_launch
async def main():
    for major in [1, None, 3]:
        server.agentmcp.opencode_resolved = lambda env, major=major: ('/usr/bin/false', major)
        try:
            await server.new_session('o', ${JSON.stringify(root)}, 'opencode', 'opencode', 'opencode', account='work')
            raise AssertionError('wrong OpenCode version started')
        except server.web.HTTPConflict: pass
    assert not [request for request in sent if request['op'] != 'list'], sent
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('selected Pi command refuses ambient resume and conflicting session directories before launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-selected-pi-'));
  try {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
for args in ('pi --session-dir /ambient', 'pi --session-dir=/ambient', 'pi --continue',
             'pi --session /ambient/session.jsonl', 'pi --session=ambient'):
    try:
        server._pi_command(args, ('/usr/bin/pi', '/overlay'), '/selected')
        raise AssertionError('admitted: ' + args)
    except server.web.HTTPConflict: pass
`;
  execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
    env: {...process.env, HOME: root, XDG_RUNTIME_DIR: root, MESH_RUNTIME_DIR: undefined,
      MESH_CACHE_DIR: path.join(root, 'cache'), MESH_CONF_DIR: path.join(root, 'conf')}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('in-place restart pins native revision before stop and retains selected environment and metadata', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-restart-context-'));
  try {
    const conf = path.join(root, 'conf'), bin = path.join(root, 'bin');
    fs.mkdirSync(conf, {mode: 0o700}); fs.mkdirSync(bin, {mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    const original = path.join(root, 'codex-original');
    fs.mkdirSync(path.join(original, 'sessions'), {recursive: true, mode: 0o700});
    const file = path.join(conf, 'backend-profiles.json');
    const write = (config: string) => fs.writeFileSync(file, JSON.stringify({version: 1, profiles: [
      {backend: 'codex', id: 'work', label: 'Work', enabled: true,
        roots: {config, state: path.join(config, 'sessions')}},
    ]}), {mode: 0o600});
    write(original);
    const script = `
import asyncio,json,sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repo)})
import server
file = Path(${JSON.stringify(file)})
changed = Path(${JSON.stringify(path.join(root, 'codex-changed'))})
source = {'name':'old','created':1,'pid':42,'meta':{'nonce':'nonce','account':'work'},
          'pty_capabilities':['agent_relaunch_v1']}
calls=[]
async def host(request, **kwargs):
    calls.append(request)
    if request['op'] == 'stop_agent_if': return {'ok':True,'created':2}
    if request['op'] == 'start_if': return {'ok':True}
    return []
server.host=host
async def main():
    context = await server._profile_launch_context('work','codex')
    source['meta']['account_context_revision'] = context['context_revision']
    await server.replace_session('old',1,'old',${JSON.stringify(root)},
                                 'codex resume abcdef0123456789abcdef0123456789','codex','codex',
                                 account='work',source=source)
    starts=[r for r in calls if r['op']=='start_if']
    assert len(starts)==1 and starts[0]['meta']['account_context_revision']==context['context_revision'], starts
    assert 'CODEX_HOME=${original}' in starts[0]['command'], starts
    calls.clear()
    file.write_text(json.dumps({'version':1,'profiles':[{
        'backend':'codex','id':'work','label':'Work','enabled':True,
        'roots':{'config':str(changed),'state':str(changed/'sessions')}}]}))
    try:
        await server.replace_session('old',1,'old',${JSON.stringify(root)},
                                     'codex resume abcdef0123456789abcdef0123456789','codex','codex',
                                     account='work',source=source)
        raise AssertionError('changed revision admitted')
    except server.web.HTTPConflict: pass
    assert not changed.exists()
    assert not [r for r in calls if r['op'] in ('stop_agent_if','start_if','kill_if','new')], calls
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('selected Pi/OpenCode discovery does not attribute ambient store identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-selected-discovery-'));
  try {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
for kind in ('pi','opencode'):
    found={'agent':{'type':kind,'pid':42,'started':10,'argv':[kind],
                    'session_id':'ambient','identity_source':'unique','status':'busy',
                    'last':'ambient private text'},'cwd':'/work'}
    server._bind_profile_discovery(found, {'meta':{'account':'work',
        'account_context_revision':'a'*64}})
    assert found['agent'] == {'type':kind,'pid':42,'started':10,'argv':[kind]}, found
`;
  execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
    env: {...process.env, HOME: root, XDG_RUNTIME_DIR: root, MESH_RUNTIME_DIR: undefined,
      MESH_CACHE_DIR: path.join(root, 'cache'), MESH_CONF_DIR: path.join(root, 'conf')}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('whole-session restart retains native revision on standby and selected command', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-whole-restart-'));
  try {
    const conf = path.join(root, 'conf'), bin = path.join(root, 'bin'), config = path.join(root, 'codex');
    for (const folder of [conf, bin, path.join(config, 'sessions')])
      fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    fs.writeFileSync(path.join(conf, 'backend-profiles.json'), JSON.stringify({version: 1, profiles: [
      {backend: 'codex', id: 'work', label: 'Work', enabled: true,
        roots: {config, state: path.join(config, 'sessions')}},
    ]}), {mode: 0o600});
    const script = `
import asyncio,sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
calls=[]
standby=None
async def host(request,**kwargs):
    global standby
    calls.append(request)
    if request['op']=='new':
        standby={'name':request['name'],'created':2,'meta':request['meta']}
        return {'ok':True}
    if request['op']=='list': return [standby] if standby else []
    return {'ok':True}
server.host=host
server._arrangement_of = lambda *a: asyncio.sleep(0,result=None)
server._carry_arrangement = lambda *a: asyncio.sleep(0)
server._wait_source_gone = lambda *a: asyncio.sleep(0)
async def main():
    context = await server._profile_launch_context('work','codex')
    source={'name':'old','created':1,'meta':{'account':'work',
        'account_context_revision':context['context_revision']}}
    await server.replace_session('old',1,'old',${JSON.stringify(root)},
                                 'codex resume abcdef0123456789abcdef0123456789','codex','codex',
                                 account='work',source=source)
    started=[request for request in calls if request['op']=='start_if']
    assert len(started)==1 and 'CODEX_HOME=${config}' in started[0]['command'], calls
    assert standby['meta']['account_context_revision']==context['context_revision'], standby
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('whole-session profile change retires only the prepared standby, or reports uncertain cleanup', {skip}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-standby-context-'));
  try {
    const conf = path.join(root, 'conf'), bin = path.join(root, 'bin');
    const original = path.join(root, 'original'), changed = path.join(root, 'changed');
    for (const folder of [conf, bin, path.join(original, 'sessions')])
      fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    fs.symlinkSync(native, path.join(bin, 'mesh-platform'));
    const file = path.join(conf, 'backend-profiles.json');
    const write = (config: string) => fs.writeFileSync(file, JSON.stringify({version: 1, profiles: [
      {backend: 'codex', id: 'work', label: 'Work', enabled: true,
        roots: {config, state: path.join(config, 'sessions')}},
    ]}), {mode: 0o600});
    write(original);
    const script = `
import asyncio,json,sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repo)})
import server
file = Path(${JSON.stringify(file)})
original = ${JSON.stringify(original)}
changed = ${JSON.stringify(changed)}
source = {'name':'old','created':1,'meta':{'account':'work'}}
calls = []
standby = None
outcome = 'ok'
async def host(request, **kwargs):
    global standby
    calls.append(request)
    if request['op'] == 'new':
        standby = {'name': request['name'], 'created': 2, 'meta': request['meta']}
        return {'ok': True}
    if request['op'] == 'list':
        if standby:
            file.write_text(json.dumps({'version':1,'profiles':[{
                'backend':'codex','id':'work','label':'Work','enabled':True,
                'roots':{'config':changed,'state':changed+'/sessions'}}]}))
        return [source] + ([standby] if standby else [])
    if request['op'] == 'kill_if':
        assert request == {'op':'kill_if','name':standby['name'],'created':standby['created']}, request
        if outcome == 'refused': return {'ok': False}
        if outcome == 'lost_ack':
            raise server.web.HTTPServiceUnavailable(text='host reply lost')
        standby = None
        return {'ok': True}
    raise AssertionError(request)
server.host = host
server._arrangement_of = lambda *a: asyncio.sleep(0, result=None)
async def main():
    global standby, outcome
    context = await server._profile_launch_context('work','codex')
    source['meta']['account_context_revision'] = context['context_revision']
    for outcome in ('ok','refused','lost_ack'):
        calls.clear()
        file.write_text(json.dumps({'version':1,'profiles':[{
            'backend':'codex','id':'work','label':'Work','enabled':True,
            'roots':{'config':original,'state':original+'/sessions'}}]}))
        standby = None
        try:
            await server.replace_session('old',1,'old',${JSON.stringify(root)},
                'codex resume abcdef0123456789abcdef0123456789','codex','codex',
                account='work',source=source)
            raise AssertionError('changed context admitted')
        except server.web.HTTPException as exc:
            if outcome == 'ok':
                assert isinstance(exc, server.web.HTTPConflict), exc
                assert standby is None, 'prepared standby was orphaned'
            else:
                assert isinstance(exc, server.web.HTTPServiceUnavailable), exc
                assert 'uncertain' in exc.text.lower(), exc.text
                assert standby['name'] in exc.text and str(standby['created']) in exc.text, exc.text
                assert ('kill_if refused' if outcome == 'refused' else 'reply unavailable') in exc.text
                assert standby is not None
        assert not [r for r in calls if r['op'] in ('start_if','stop_agent_if')], calls
        assert len([r for r in calls if r['op']=='kill_if']) == 1, calls
        assert source['created'] == 1
    assert not Path(changed).exists(), 'changed profile root was created'
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 30000,
      env: {...process.env, HOME: root, MESH_CONF_DIR: conf, MESH_BIN_DIR: bin}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('both restore paths pin legacy and selected offers across migration before launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-restore-legacy-race-'));
  try {
    const conf = path.join(root, 'conf');
    fs.mkdirSync(conf, {mode: 0o700});
    const script = `
import asyncio,sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repo)})
import server
registry = Path(${JSON.stringify(path.join(conf, 'backend-profiles.json'))})
sent = []
phase = 'before'
mode = 'legacy'
server.LAUNCH_SETTINGS = type('Settings', (), {'allows_cwd': lambda self,cwd: True})()
server.unique_name = lambda *args: asyncio.sleep(0, result='restored')
server.account_environment = lambda *args: asyncio.sleep(0, result={'CLAUDE_CONFIG_DIR':${JSON.stringify(root)}})
async def host(request): return []
server.host = host
async def send(request, conversation): sent.append(request)
server._send_launch = send
async def context(account, agent, revision=None):
    if revision == 'legacy':
        if registry.exists():
            raise server.web.HTTPConflict(text='Account profile context changed; resume refused')
        return None
    if revision and not registry.exists():
        raise server.web.HTTPConflict(text='Account profile context changed; resume refused')
    return {'env':{'CLAUDE_CONFIG_DIR':${JSON.stringify(root)}},'unset':[],
            'roots':{'config':${JSON.stringify(root)}},'context_revision':'a'*64}
server._profile_launch_context = context
def wake(command,*args):
    if phase == 'during':
        if mode == 'legacy': registry.write_text('{}')
        else: registry.unlink()
    return command
server.claudewake.launch_command = wake
def argv(agent, context):
    if phase == 'before':
        if context is None: registry.write_text('{}')  # legacy -> native before launch
        else: registry.unlink()  # selected -> legacy before launch
    return ['claude', '--resume', 'fixture']
server._resume_argv = argv
entry = {'account':'work', 'cwd':${JSON.stringify(root)}, 'created':1,
         'agent':{'type':'claude','session_id':'fixture'}}
async def main():
    global mode, phase
    for mode in ('legacy', 'selected'):
      for phase in ('before', 'during'):
        for exact in (False, True):
            registry.unlink(missing_ok=True)
            entry.pop('account_context_revision', None)
            if mode == 'selected':
                entry['account_context_revision'] = 'a'*64
                registry.write_text('{}')
            if exact:
                result = await server._create_exact('restored', entry, 'fixture-nonce')
                assert result['code'] == 'launch-refused' and result['status'] == 409, result
            else:
                name, refusal = await server._create_restored('restored', entry, set())
                assert name is None and not refusal['ok'], (name, refusal)
            assert sent == [], sent
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, XDG_RUNTIME_DIR: root, MESH_CONF_DIR: conf}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('recycled standby name cannot be killed or started during whole-session restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-standby-recycled-'));
  try {
    const script = `
import asyncio,sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
server.LAUNCH_SETTINGS = type('Settings', (), {'allows_cwd': lambda self,cwd: True})()
server._restart_profile_context = lambda *args: asyncio.sleep(0, result=None)
server.account_environment = lambda *args: asyncio.sleep(0, result={})
server._prepared_launch = lambda *args: asyncio.sleep(0, result=('echo fixture',None,None))
server._arrangement_of = lambda *args: asyncio.sleep(0, result=None)
calls = []
case = 'first'
async def host(request):
    calls.append(request)
    if request['op'] == 'list':
        new = next((r for r in calls if r['op'] == 'new'), None)
        if new:
            count = sum(r['op'] == 'list' for r in calls[calls.index(new)+1:])
            nonce = new['meta']['nonce'] if case == 'later' and count == 1 else 'another-nonce'
            return [{'name':new['name'],'created':2,'meta':{'nonce':nonce}}]
        return []
    if request['op'] == 'new': return {'ok':True}
    if request['op'] == 'kill_if': return {'ok':True}
    raise AssertionError('foreign session touched: ' + repr(request))
server.host = host
async def main():
    global case
    for case in ('first', 'later'):
        calls.clear()
        try:
            await server.replace_session('old',1,'replacement',${JSON.stringify(root)},
                                         'echo fixture','custom','custom')
            raise AssertionError('foreign standby accepted')
        except server.web.HTTPServiceUnavailable: pass
        assert not [r for r in calls if r['op'] in ('kill_if','start_if')], calls
asyncio.run(main())
`;
    execFileSync(python, ['-I', '-c', script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: root, XDG_RUNTIME_DIR: root, MESH_CONF_DIR: path.join(root, 'conf')}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
