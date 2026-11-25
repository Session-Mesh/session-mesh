// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
test('profile qualification requires a bound named session and a valid complete inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-qualify-'));
  try {
    const script = `
import asyncio, json, sys
from types import SimpleNamespace
sys.path.insert(0, ${JSON.stringify(repo)})
import server
server.NATIVE_SWITCH_QUALIFIED = True
server._native_profile_mode = lambda: True
caps = ['agent_relaunch_v1', 'agent_relaunch_bound_v1']
raw = {'name':'one','pid':7,'cwd':'/','created':1,'activity':1,'attached':0,
       'meta':{'known_agent':'codex'},'pty_capabilities':caps}
profiles = [{'backend':'codex','enabled':True}]
def qualified(meta): return server._native_switch_available('codex', {**raw, 'meta':meta})
assert qualified({'known_agent':'codex'})
assert not qualified({'known_agent':'codex','account':'work'})
assert not qualified({'known_agent':'codex','account':'work','account_context_revision':'invalid'})
assert qualified({'known_agent':'codex','account':'work','account_context_revision':'a'*64})
assert not qualified({'known_agent':'codex','account':17,'account_context_revision':'a'*64})
assert server._qualify_profiles(profiles, [raw])[0]['switch_qualified']
assert not server._qualify_profiles(profiles, [{**raw, 'meta':{'known_agent':'codex','account':'work'}}])[0]['switch_qualified']
for bad in ({'unexpected': 'object'}, ['not a session'], [raw, {'name':'partial'}], None,
            [{**raw, 'meta':{'known_agent':['codex']}}], [{**raw, 'meta':{'known_agent':{'kind':'codex'}}}]):
    assert not server._qualify_profiles(profiles, bad)[0]['switch_qualified']

# Exercise the owner route's actual malformed-host path, not only the helper.
server._require_owner_cookie = lambda request: None
server.same_origin = lambda request: True
async def run(authority, op, body):
    assert authority == 'accounts'
    return (0, b'{}\\n')
server._profile_run = run
server._profile_envelope = lambda op, code, out: {'ok':True, 'http_status':200, 'data':{'profiles':profiles}}
async def host(body): return {'unexpected':'object'}
server.host = host
async def main():
    request = SimpleNamespace(headers={}, path='/api/accounts/profiles', query={}, method='GET')
    result = await server.api_accounts(request)
    assert result.status == 200
    assert not json.loads(result.text)['data']['profiles'][0]['switch_qualified']
    for value in (['codex'], {'kind':'codex'}):
        async def malformed_agent_host(body):
            return [{**raw, 'meta':{'known_agent':value}}]
        server.host = malformed_agent_host
        result = await server.api_accounts(request)
        assert result.status == 200
        assert not json.loads(result.text)['data']['profiles'][0]['switch_qualified']
    async def bad_host(body): raise ValueError('malformed host reply')
    server.host = bad_host
    result = await server.api_accounts(request)
    assert result.status == 200
    assert not json.loads(result.text)['data']['profiles'][0]['switch_qualified']
    print(json.dumps({'status':result.status, 'qualified':False}))
asyncio.run(main())
`;
    const result = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
      env: {PATH: process.env.PATH, HOME: root, MESH_CONF_DIR: root, XDG_RUNTIME_DIR: root, TMPDIR: root},
    });
    assert.deepEqual(JSON.parse(result), {status: 200, qualified: false});
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
