// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
for (const backend of ['codex', 'pi'] as const)
test(`${backend} operator switch is cookie-only, same-origin, exact-bound and queued once`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-operator-switch-'));
  try {
    const script = `
import asyncio, json, sys
from types import SimpleNamespace
from aiohttp import web
sys.path.insert(0, ${JSON.stringify(repo)})
import server, sessionrequests
backend = ${JSON.stringify(backend)}
revision, target_revision = 'a'*64, 'b'*64
source = {'id':'one','created':123,'agent':backend,'account':'work',
          'context_revision':revision,'conversation':'11111111-1111-1111-1111-111111111111',
          'agent_pid':77,'agent_started':100}
target = {'id':'other','label':'Other','context_revision':target_revision}
body = {'source':source,'target':target}
raw = {'name':'one','created':123,'cwd':'/tmp','meta':{'known_agent':backend,'account':'work',
       'account_context_revision':revision},'pty_capabilities':['agent_relaunch_v1','agent_relaunch_bound_v1']}
binding = {'backend':backend,'conversation':source['conversation'],'agent_pid':77,'agent_start':'9',
           'source':{'id':'work','context_revision':revision},
           'target':{'id':'other','context_revision':target_revision}}
server.NATIVE_SWITCH_QUALIFIED = True
server._native_profile_mode = lambda: True
server.LAUNCH_SETTINGS = SimpleNamespace(allows_cwd=lambda cwd:True)
server.has_owner_cookie = lambda request: request.cookies.get('owner') == 'yes'
server.same_origin = lambda request: request.headers.get('Origin') == 'http://mesh'
async def body_of(request): return json.dumps(request.body).encode(), None
server._accounts_body = body_of
async def host(_): return [raw]
server.host = host
async def declared(): return []
server.declared_accounts = declared
server._ACCOUNTS['file'] = 'ok'
server._ACCOUNTS['accounts'] = [{'id':'other','label':'Other','codex_home':'/tmp/other'}]
server._ACCOUNTS['launch_profiles'] = [{'backend':backend,'id':'other','label':'Other'}]
async def profiles(authority, op, payload):
    assert (authority,op,payload) == ('operator-switch','profiles.list',b'{}')
    return (0,b'{}\\n')
server._profile_run = profiles
server._profile_envelope = lambda op, code, out: {'ok':True,'data':{'profiles':[
    {'backend':backend,'id':'other','context_revision':target_revision,'label':'Other',
     'enabled':True,'managed':False}]}}
state = {'status':'idle', 'foreground':True, 'drop_foreground_on_bind':False,
         'target_revision':target_revision, 'agent_start':'9'}
server._describe_with_hooks = lambda listed: {'mesh':[{'id':'one','created':123,
    'agent':{'type':backend,'status':state['status'],'foreground':state['foreground'],'pid':77,
             'started':100,'session_id':source['conversation']}}]}
async def context(account, backend, revision=None, observed=None):
    return {'process_pid':77,'process_start':'9'}
server._switch_profile_context = context
server.discover.proc_start = lambda pid: 100
async def bound(src, choice):
    assert src['id'] == 'one' and src['created'] == 123 and choice == {'action':'switch_account','account':'other'}
    if state['drop_foreground_on_bind']: state['foreground'] = False
    return choice, 'work', {**binding, 'agent_start':state['agent_start'],
                            'target':{'id':'other','context_revision':state['target_revision']}}
server._switch_request = bound
server._schedule_session_action = lambda app, rid: app['scheduled'].append(rid)
requests = sessionrequests.Requests(':memory:')
app = {'session_requests':requests,'scheduled':[]}
def req(payload=body, cookie='yes', origin='http://mesh', authorization=None):
    headers={'Origin':origin}
    if authorization is not None: headers['Authorization']=authorization
    return SimpleNamespace(headers=headers,cookies={'owner':cookie},body=payload,query={},app=app)
def receipt_req(rid, cookie='yes', authorization=None):
    request = req(cookie=cookie, authorization=authorization)
    request.match_info = {'request_id':rid}
    return request
async def main():
    if backend == 'pi':
        try: await server.api_operator_account_switch(req())
        except web.HTTPConflict: pass
        else: raise AssertionError('Pi allowed without its native relaunch capability')
        raw['pty_capabilities'].append('agent_relaunch_pi_v1')
    for request, status in [(req(cookie='no'),401),(req(authorization='Bearer agent'),401),
                            (req(origin='https://other'),403)]:
        try: await server.api_operator_account_switch(request)
        except web.HTTPException as exc: assert exc.status == status
        else: raise AssertionError('unauthorized request accepted')
    assert not app['scheduled']
    for changed in ({'created':124},{'agent':'claude'},{'account':'default'},
                    {'agent_pid':78},{'agent_started':101},
                    {'context_revision':'f'*64},{'conversation':'2'*36}):
        try: await server.api_operator_account_switch(req({'source':{**source,**changed},'target':target}))
        except web.HTTPException as exc: assert exc.status in (400,409)
        else: raise AssertionError('stale source accepted')
    for changed in ({'id':'unknown'},{'label':'Renamed'},{'context_revision':'c'*64}):
        try: await server.api_operator_account_switch(req({'source':source,'target':{**target,**changed}}))
        except web.HTTPException as exc: assert exc.status in (400,409)
        else: raise AssertionError('stale target accepted')
    try: await server.api_operator_account_switch(req({'source':source,'target':
        {'id':'default','label':'Default account','context_revision':None}}))
    except web.HTTPException as exc: assert exc.status in (400,409)
    else: raise AssertionError('default target bypassed the qualified-profile picker')
    assert not app['scheduled']
    raw['meta'].pop('account_context_revision')
    raw['meta']['account'] = None
    try: await server.api_operator_account_switch(req({'source':{**source,'account':'default'},'target':target}))
    except web.HTTPConflict: pass
    else: raise AssertionError('unbound default source accepted')
    raw['meta']['account_context_revision'] = revision
    raw['meta']['account'] = 'work'
    state['target_revision'] = 'c'*64
    try: await server.api_operator_account_switch(req())
    except web.HTTPConflict: pass
    else: raise AssertionError('changed native target binding accepted')
    state['target_revision'] = target_revision
    state['agent_start'] = '10'
    try: await server.api_operator_account_switch(req())
    except web.HTTPConflict: pass
    else: raise AssertionError('replaced foreground process accepted')
    state['agent_start'] = '9'
    state['status'] = 'busy'
    refused = await server.api_operator_account_switch(req())
    assert refused.status == 409
    assert json.loads(refused.text) == {'refused':'foreground_unavailable'}
    assert not app['scheduled']
    state['status'] = 'idle'
    state['foreground'] = False
    try: await server.api_operator_account_switch(req())
    except web.HTTPConflict: pass
    else: raise AssertionError('background source accepted')
    state['foreground'] = True
    state['drop_foreground_on_bind'] = True
    try: await server.api_operator_account_switch(req())
    except web.HTTPConflict: pass
    else: raise AssertionError('source backgrounded during binding was accepted')
    state['drop_foreground_on_bind'] = False
    state['foreground'] = True
    accepted = await server.api_operator_account_switch(req())
    assert accepted.status == 202
    assert len(app['scheduled']) == 1
    assert requests.status(app['scheduled'][0])['switch_binding']['initiator'] == 'operator'
    rid = app['scheduled'][0]
    admitted = await server.api_operator_account_switch_status(receipt_req(rid))
    assert json.loads(admitted.text)['request']['state'] == 'approved'
    for request in (receipt_req(rid, cookie='no'), receipt_req(rid, authorization='Bearer agent')):
        try: await server.api_operator_account_switch_status(request)
        except web.HTTPUnauthorized: pass
        else: raise AssertionError('operator receipt leaked to bearer or missing cookie')
    try: await server.api_operator_account_switch_status(receipt_req('missing'))
    except web.HTTPNotFound: pass
    else: raise AssertionError('missing receipt returned')
    agent_item = requests.create({'id':'agent','created':124,'agent':backend,'cwd':'/tmp'},
        {'action':'switch_account','account':'other'}, enabled_agents={backend}, resumable={backend},
        current_account='work', switch_binding=binding)
    try: await server.api_operator_account_switch_status(receipt_req(agent_item['id']))
    except web.HTTPNotFound: pass
    else: raise AssertionError('agent-approved request exposed as operator receipt')
    raw['cwd'] = '/new-folder'  # a changed source JSON cannot bypass the incarnation limit
    try: await server.api_operator_account_switch(req())
    except web.HTTPConflict: pass
    else: raise AssertionError('second active switch accepted')
    assert len(app['scheduled']) == 1
    requests.begin_execution(rid)
    requests.finish(rid, error='Source became busy; nothing was stopped')
    receipt = await server.api_operator_account_switch_status(receipt_req(rid))
    assert json.loads(receipt.text)['request']['result']['error'] == 'Source became busy; nothing was stopped'
    print(json.dumps({'queued':len(app['scheduled']), 'state':requests.status(rid)['state']}))
asyncio.run(main())
`;
    const answer = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: repo, encoding: 'utf8', timeout: 10_000, env: {PATH: process.env.PATH, HOME: home,
        MESH_CONF_DIR: home, XDG_RUNTIME_DIR: home, TMPDIR: home}});
    assert.deepEqual(JSON.parse(answer), {queued: 1, state: 'failed'});
  } finally {fs.rmSync(home, {recursive: true, force: true});}
});
