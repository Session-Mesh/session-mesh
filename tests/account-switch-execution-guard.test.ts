// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');

test('durable operator approval refuses a newly busy foreground before a bound stop, even after reopening the store', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-switch-idle-'));
  try {
    const script = `
import asyncio, json, sys
from aiohttp import web
sys.path.insert(0, ${JSON.stringify(repo)})
import server, sessionrequests

revision = 'a'*64
source = {'id':'one', 'created':123, 'agent':'codex', 'cwd':${JSON.stringify(home)}}
binding = {'backend':'codex', 'conversation':'11111111-1111-1111-1111-111111111111',
           'agent_pid':77, 'agent_start':'100', 'initiator':'operator',
           'source':{'id':'work','context_revision':revision},
           'target':{'id':'other','context_revision':'b'*64}}
db = ${JSON.stringify(path.join(home, 'requests.sqlite'))}
store = sessionrequests.Requests(db)
item = store.create(source, {'action':'switch_account','account':'other'},
    enabled_agents={'codex'}, resumable={'codex'}, current_account='work',
    switch_binding=binding)
claim = store.claim(item['id'], 'a'*32)
store.decide(item['id'], True, claim['claim_nonce'])
store.close()
store = sessionrequests.Requests(db)
approved = store.approved()[0]
assert approved['switch_binding']['initiator'] == 'operator'

raw = {'name':'one', 'created':123, 'cwd':${JSON.stringify(home)},
       'pty_capabilities':['agent_relaunch_v1','agent_relaunch_bound_v1']}
context = {'process_pid':77, 'process_start':'100', 'conversation':binding['conversation'],
           'id':'work', 'context_revision':revision, 'env':{}}
state = {'status':'idle', 'stops':0, 'flip_busy':True}
async def prepared(agent, command, cwd, context): return command, None, None
async def arrangement(name, created): return {}
async def original_guard(source, kind, source_context, target_context):
    if state['flip_busy']:
        state['status'] = 'busy' # same PID and conversation starts a turn after initial validation
async def stopped(*args, **kwargs):
    state['stops'] += 1
    raise web.HTTPConflict(text='test stop intercepted')
server._prepared_launch = prepared
server._arrangement_of = arrangement
server._validate_native_switch = original_guard
server._switch_root_identity = lambda ctx: (1, 2)
server._stop_agent = stopped
server._describe_with_hooks = lambda listed, *args: {'mesh':[{
    'id':'one', 'created':123, 'agent':{'type':'codex', 'status':state['status'],
    'foreground':True, 'pid':77, 'started':100, 'session_id':binding['conversation']}}]}
server._switch_conversation = lambda described, source: binding['conversation']
server._switch_profile_context = lambda *args: asyncio.sleep(0, result={
    'process_pid':77, 'process_start':'100'})
server.discover.proc_start = lambda pid: 100
async def main():
    for initiator, busy, expected_stops in [
        (approved['switch_binding'].get('initiator'),True,0),
        (None,True,1),
        (approved['switch_binding'].get('initiator'),False,1)]:
        state['status'] = 'idle'
        state['stops'] = 0
        state['flip_busy'] = busy
        switch = ('other', lambda: None, context, {'id':'other','env':{}}, approved['id'], initiator)
        try:
            await server._relaunch_in_place(raw, raw['cwd'], 'codex resume', 'codex', 'codex',
                'work', switch, fence={'fence_id':'fixture'}, fence_state={'stop_started':False})
        except web.HTTPConflict: pass
        else: raise AssertionError('expected intercepted stop or idle refusal')
        assert state['stops'] == expected_stops, (initiator, state)
    async def execute_from_store(item, nonce=None):
        assert item['switch_binding']['initiator'] == 'operator'
        state['status'] = 'idle'
        switch = ('other', lambda: None, context, {'id':'other','env':{}}, item['id'],
                  item['switch_binding'].get('initiator'))
        return await server._relaunch_in_place(raw, raw['cwd'], 'codex resume', 'codex',
            'codex', 'work', switch, fence={'fence_id':'fixture'}, fence_state={'stop_started':False})
    server._execute_session_action = execute_from_store
    state['stops'] = 0
    state['flip_busy'] = True
    app = {'session_requests':store, 'session_action_tasks':{}}
    await server.start_session_actions(app)
    await asyncio.gather(*app['session_action_tasks'].values())
    assert store.status(item['id'])['state'] == 'failed'
    assert state['stops'] == 0
    print(json.dumps({'operator_stops':0,'agent_stops':1,'operator_idle_stops':1,
      'durable_initiator':approved['switch_binding']['initiator'], 'resumed':'failed'}))
asyncio.run(main())
`;
    const result = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
      env: {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: home, XDG_RUNTIME_DIR: home, TMPDIR: home},
    });
    assert.deepEqual(JSON.parse(result), {operator_stops: 0, agent_stops: 1, operator_idle_stops: 1,
      durable_initiator: 'operator', resumed: 'failed'});
  } finally {fs.rmSync(home, {recursive: true, force: true});}
});
