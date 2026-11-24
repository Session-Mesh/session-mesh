// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
test('native switch fence binds one session and never replays an uncertain operation', () => {
  const script = `
import asyncio, sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
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
    calls.clear()
    server.host = host
    async def stop_uncertain(*args, fence, **kwargs): raise web.HTTPServiceUnavailable()
    server._relaunch_in_place = stop_uncertain
    try: await server.relaunch_in_place(raw, '/', 'codex', 'codex', 'codex', switch=switch); assert False
    except server.NativeFenceRecoveryRequired: pass
    assert [c['op'] for c in calls] == ['list_bound','switch_input_acquire']
asyncio.run(main())
`;
  assert.doesNotThrow(() => execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {cwd: repo, timeout: 10_000, stdio: 'pipe'}));
});
