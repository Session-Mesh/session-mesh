// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
test('account refresh stops after listing producers and cannot restart during cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-account-cleanup-'));
  try {
    const script = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(repo)})
import server
async def main():
    app = server.make_app(session_request_path=${JSON.stringify(path.join(root, 'requests.json'))})
    callbacks = list(app.on_cleanup)
    assert callbacks.index(server.stop_history) < callbacks.index(server._stop_listing_account_refresh)
    assert callbacks.index(server.stop_snapshot) < callbacks.index(server._stop_listing_account_refresh)
    server._LISTING_ACCOUNT_REFRESH = (None, None, 0.0)
    server._LISTING_ACCOUNT_CLOSING = None
    server._LISTING_ACCOUNT_RETRY_SECONDS = 0
    calls, cancelled = [], []
    async def accounts():
        calls.append('start')
        if len(calls) == 1: return []
        try: await asyncio.Event().wait()
        finally: cancelled.append('cancelled')
    server.declared_accounts = accounts
    await server._start_listing_account_refresh(app)
    await server._LISTING_ACCOUNT_REFRESH[1]
    await asyncio.sleep(0)
    async def snapshot():
        try: await asyncio.Event().wait()
        finally:
            server._schedule_listing_account_refresh()
            await asyncio.sleep(0)
    app['snapshot_task'] = asyncio.create_task(snapshot())
    await asyncio.sleep(0)
    await server.stop_snapshot(app)
    assert calls == ['start', 'start'], calls
    await server._stop_listing_account_refresh(app)
    assert cancelled == ['cancelled'], cancelled
    server._schedule_listing_account_refresh()
    await asyncio.sleep(0)
    assert calls == ['start', 'start'], calls
    assert server._LISTING_ACCOUNT_REFRESH[1] is None
    # A fresh app startup on the same event loop re-enables scheduling.
    await server._start_listing_account_refresh(app)
    await asyncio.sleep(0)
    assert calls == ['start', 'start', 'start'], calls
    await server._stop_listing_account_refresh(app)
    app['session_requests'].close()
    print(json.dumps({'calls': calls, 'cancelled': cancelled}))
asyncio.run(main())
`;
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
      env: {PATH: process.env.PATH, HOME: root, MESH_CONF_DIR: root, XDG_RUNTIME_DIR: root, TMPDIR: root},
    });
    assert.deepEqual(JSON.parse(output), {calls: ['start', 'start', 'start'], cancelled: ['cancelled', 'cancelled']});
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
