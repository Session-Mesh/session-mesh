// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const repo = path.resolve(import.meta.dirname, '..');
test('operator inventory distinguishes orphan receipts without exposing fence secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-fence-inventory-'));
  try {
    const folder = path.join(dir, 'switch-fences');
    fs.mkdirSync(folder);
    for (const [id, name, created] of [['a'.repeat(64), 'first', 1], ['b'.repeat(64), 'second', 2]] as const)
      fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify({name, created, fence_id: 'secret-owner', creation_receipt: 'secret-receipt'}));
    const docs = fs.readFileSync(path.join(repo, 'docs/operations.md'), 'utf8');
    const section = docs.split('### Recovering an orphaned account-switch input fence')[1]!;
    const code = section.match(/```sh\npython - <<'PY'\n([\s\S]*?)\nPY\n```/)?.[1];
    assert.ok(code);
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-c', code],
      {cwd: repo, env: {...process.env, MESH_CONF_DIR: dir}, encoding: 'utf8'});
    assert.match(output, new RegExp(`sha256-${'a'.repeat(64)} 'first' 1`));
    assert.match(output, new RegExp(`sha256-${'b'.repeat(64)} 'second' 2`));
    assert.doesNotMatch(output, /secret-owner|secret-receipt/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('native switch fence binds one session and never replays an uncertain operation', () => {
  const script = `
import asyncio, sys, tempfile, pathlib, json, hashlib
sys.path.insert(0, ${JSON.stringify(repo)})
import server
server.CONF_DIR = pathlib.Path(tempfile.mkdtemp())
from aiohttp import web
raw = {'name':'one','created':1.0}
receipt = 'a'*64+':0000000000000001'
switch = ('target', None, {}, {}, 'durable-request-id')
async def main():
    calls = []
    async def host(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        if message['op'] == 'switch_input_acquire': return {'ok':True}
        if message['op'] == 'switch_input_release': return {'ok':True}
        raise AssertionError(message)
    async def relaunch(*args, fence, **kwargs):
        assert fence['creation_receipt'] == receipt and fence['created'] == 1.0
        fence['created'] = 2.0
        return 'one'
    real_stop = server._stop_agent
    server.host, server._relaunch_in_place = host, relaunch
    assert await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch) == 'one'
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire','switch_input_release']
    assert calls[1]['fence_id'] == calls[2]['fence_id'] and calls[2]['created'] == 2.0
    calls.clear()
    async def failed_acquire(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        return {'ok':False,'reason':'legacy_attachment'}
    server.host = failed_acquire
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except web.HTTPConflict: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire']
    calls.clear()
    async def uncertain(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        raise web.HTTPServiceUnavailable()
    server.host = uncertain
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired as e: assert e.fence['creation_receipt'] == receipt
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire']
    server._forget_native_fence(switch[4])
    calls.clear()
    server.host = host
    async def stop_uncertain(*args, fence, fence_state, **kwargs):
        fence_state['stop_started'] = True
        raise web.HTTPServiceUnavailable()
    server._relaunch_in_place = stop_uncertain
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire']
    saved = json.loads(server._native_fence_path(switch[4]).read_text())
    assert saved['creation_receipt'] == receipt
    assert server._native_fence_path(switch[4]).stat().st_mode & 0o777 == 0o600
    class Store:
        def status(self, rid): return {'action':'switch_account','source':{'id':'one','created':1.0}}
    class Request:
        match_info = {'request_id':switch[4]}
        app = {'session_action_tasks':{}, 'session_requests':Store()}
    async def body(_): return {'action':'release_fence'}
    server.json_object = body
    async def recoverhost(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':2.0,'creation_receipt':receipt}]
        if message['op'] == 'switch_input_release':
            assert message['created'] == 2.0 and message['fence_id'] == saved['fence_id']
            return {'ok':True}
        raise AssertionError(message)
    async def wrong_receipt(message, **kwargs):
        if message['op'] == 'list_bound': return [{'name':'one','created':2.0,'creation_receipt':'different'}]
        raise AssertionError('replacement terminal must not be released')
    server.host = wrong_receipt
    try: await server.api_session_action_recover_fence(Request()); assert False
    except web.HTTPConflict: pass
    assert server._native_fence_path(switch[4]).exists()
    server.host = recoverhost
    response = await server.api_session_action_recover_fence(Request())
    assert json.loads(response.text) == {'ok':True}
    assert not server._native_fence_path(switch[4]).exists()
    # Evidence remains authoritative even if a previous version pruned its row.
    server._save_native_fence(switch[4], saved)
    class PrunedStore:
        def status(self, rid): return None
    Request.app['session_requests'] = PrunedStore()
    assert json.loads((await server.api_session_action_recover_fence(Request())).text) == {'ok':True}
    assert not server._native_fence_path(switch[4]).exists()
    server._save_native_fence(switch[4], saved)
    Request.match_info['request_id'] = 'sha256-' + hashlib.sha256(switch[4].encode()).hexdigest()
    task = asyncio.create_task(asyncio.sleep(30))
    Request.app['session_action_tasks'][switch[4]] = task
    try: await server.api_session_action_recover_fence(Request()); assert False
    except web.HTTPConflict: pass
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass
    Request.app['session_action_tasks'].clear()
    assert json.loads((await server.api_session_action_recover_fence(Request())).text) == {'ok':True}
    Request.match_info['request_id'] = switch[4]
    Request.app['session_requests'] = Store()
    calls.clear()
    server.host = host
    async def refused_before_stop(*args, **kwargs): raise web.HTTPConflict(text='unchanged')
    server._relaunch_in_place = refused_before_stop
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except web.HTTPConflict: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire','switch_input_release']
    assert not server._native_fence_path(switch[4]).exists()
    calls.clear()
    async def release_lost(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        if message['op'] == 'switch_input_acquire': return {'ok':True}
        if message['op'] == 'switch_input_release': raise web.HTTPServiceUnavailable()
        raise AssertionError(message)
    server.host, server._relaunch_in_place = release_lost, relaunch
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired as exc:
        assert exc.switch_outcome == {'switch_phase':'target_start_accepted', 'id':'one',
                                      'target_copy_remains':True, 'target_copy_uncertain':False}
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire','switch_input_release']
    server._forget_native_fence(switch[4])
    calls.clear()
    server._relaunch_in_place = refused_before_stop
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired as exc:
        assert exc.switch_outcome == {'switch_phase':'not_stopped', 'target_copy_remains':False,
                                      'target_copy_uncertain':False}
    server._forget_native_fence(switch[4])
    calls.clear()
    server.host = host
    async def cancelled(*args, fence_state, **kwargs):
        fence_state['stop_started'] = True
        raise asyncio.CancelledError()
    server._relaunch_in_place = cancelled
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except asyncio.CancelledError: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire']
    assert server._native_fence_path(switch[4]).exists()
    server._forget_native_fence(switch[4])
    calls.clear()
    async def signalled_host(message, **kwargs):
        calls.append(message.copy())
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        if message['op'] == 'switch_input_acquire': return {'ok':True}
        if message['op'] == 'stop_agent_if': return {'ok':False,'reason':'agent_still_running'}
        raise AssertionError(message)
    async def real_stopping(*args, fence, fence_state, **kwargs):
        await real_stop(raw, 'codex', fence_id=fence['fence_id'], fence_state=fence_state)
    server.host, server._relaunch_in_place = signalled_host, real_stopping
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire','stop_agent_if']
    assert server._native_fence_path(switch[4]).exists()
    async def mismatchhost(message, **kwargs):
        if message['op'] == 'list_bound': return [{'name':'one','created':1.0,'creation_receipt':receipt}]
        if message['op'] == 'switch_input_release': return {'ok':False,'reason':'fence_mismatch'}
        raise AssertionError(message)
    server.host = mismatchhost
    try: await server.api_session_action_recover_fence(Request()); assert False
    except web.HTTPConflict as exc: assert 'may already be released' in exc.text
    assert server._native_fence_path(switch[4]).exists()
asyncio.run(main())
`;
  assert.doesNotThrow(() => execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {cwd: repo, timeout: 10_000, stdio: 'pipe'}));
});
