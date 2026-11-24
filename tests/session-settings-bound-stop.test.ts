// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
test('settings stop requires the host-bound foreground identity and never falls back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-settings-stop-'));
  try {
    const script = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
raw = {'name':'session','created':1.0,'pid':101,
       'pty_capabilities':['agent_relaunch_v1','agent_relaunch_bound_v1'], 'last_input':0.0}
agent = {'pid':102,'foreground':True}
requests = []
async def host(message, **kwargs):
    requests.append(message)
    if message['op'] == 'processes':
        return {'version':1,'complete':True,'errors':[],
                'processes':[{'pid':102,'sid':101,'incarnation':'98765'}]}
    if message['op'] == 'stop_agent_if': return {'ok':True,'created':2.0}
    raise AssertionError(message)
server.host = host
async def main():
    source = {'id':'session','created':1.0,'agent':'codex'}
    entry = {'agent':{**agent, 'type':'codex', 'argv':['codex']}, 'cwd':'/'}
    async def inspect(*args, **kwargs): return {'effort_choices':['low','medium','high']}
    server._session_settings_program = inspect
    server._session_control_conversation = lambda *_: 'exact-conversation'
    async def observation(_source): return entry, raw
    server._session_control_observation = observation
    status = await server._session_control_status(source)
    assert status['transition'] == 'restart' and status['effort_choices'] == ['low','medium','high']
    async def old_observation(_source): return entry, {**raw, 'pty_capabilities':['agent_relaunch_v1']}
    server._session_control_observation = old_observation
    status = await server._session_control_status(source)
    assert status['transition'] == 'unavailable' and status['effort_choices'] == []
    async def no_identity(message, **kwargs): return {'version':1,'complete':True,'errors':[], 'processes':[]}
    server.host = no_identity
    server._session_control_observation = observation
    status = await server._session_control_status(source)
    assert status['transition'] == 'unavailable' and status['effort_choices'] == []
    server.host = host
    binding = await server._settings_process_binding(raw, agent)
    assert binding == {'agent_pid':102,'agent_incarnation':'98765','agent_input_at':0.0}
    assert await server._stop_agent(raw, 'codex', binding) == 2.0
    assert requests[-1] == {'op':'stop_agent_if','name':'session','created':1.0,
                            'agent':'codex','agent_pid':102,'agent_incarnation':'98765','agent_input_at':0.0}
    before = len(requests)
    async def guard(): pass
    for source in (None, {**raw, 'pty_capabilities':['agent_relaunch_v1']}):
        try:
            await server.replace_session('session',1.0,'session','/','cmd','codex','codex',
                source=source, settings_guard=guard, settings_binding=binding)
            raise AssertionError('old or unavailable host admitted')
        except server.web.HTTPConflict: pass
    assert len(requests) == before
    async def cannot_stop(*args, **kwargs): raise server.WholeSessionOnly('no_shell')
    async def wrong_fallback(*args, **kwargs): raise AssertionError('whole session fallback')
    server.relaunch_in_place = cannot_stop
    server._replace_with_new_session = wrong_fallback
    try:
        await server.replace_session('session',1.0,'session','/','cmd','codex','codex',
            source=raw, settings_guard=guard, settings_binding=binding)
        raise AssertionError('unsafe whole session fallback admitted')
    except server.web.HTTPConflict: pass
    for bad in (None, {}, {'version':1,'complete':True,'errors':[], 'processes':[]},
                {'version':1,'complete':True,'errors':[], 'processes':[{'pid':102,'sid':999,'incarnation':'98765'}]},
                {'version':1,'complete':True,'errors':[], 'processes':[{'pid':102,'sid':101,'incarnation':'no'}]}):
        async def invalid_host(message, **kwargs): return bad
        server.host = invalid_host
        try: await server._settings_process_binding(raw, agent); raise AssertionError('invalid identity admitted')
        except server.web.HTTPConflict: pass
    print(json.dumps({'bound':True, 'fallback':False}))
asyncio.run(main())
`;
    const out = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
      env: {PATH: process.env.PATH, HOME: root, MESH_CONF_DIR: root, XDG_RUNTIME_DIR: root, TMPDIR: root},
    });
    assert.deepEqual(JSON.parse(out), {bound: true, fallback: false});
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('settings helper refuses unread launch arguments', () => {
  const program = process.env.MESH_MESH_PLATFORM_CMD
    || path.join(repo, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
  const input = JSON.stringify({agent: 'codex', options: [['codex']], tail: ['--unknown', '--model', 'old'], model: 'new'});
  assert.throws(() => execFileSync(program, ['session-settings', 'apply'], {input, encoding: 'utf8'}),
    error => {
      const result = error as {status: number; stdout: string};
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Unread launch arguments prevent a settings change/);
      return true;
    });
});
