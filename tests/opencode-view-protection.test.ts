// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Exercise the document deny list with synthetic OpenCode databases, never actual credentials.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';

test('OpenCode data files are protected by path and identity; unknown profile roots fail closed', () => {
  const code = `
import os, sys
real_home = os.environ['MESH_TEST_REAL_HOME']
allowed = [os.environ['HOME'], os.getcwd(), sys.prefix, sys.base_prefix]
def in_path(candidate, root):
    try: return os.path.commonpath((candidate, root)) == root
    except ValueError: return False
def deny_real_home(event, args):
    if event not in ('open', 'os.listdir', 'os.scandir') or not args or not isinstance(args[0], (str, bytes, os.PathLike)): return
    candidate = os.path.realpath(os.fsdecode(args[0]))
    if in_path(candidate, real_home) and not any(in_path(candidate, os.path.realpath(root)) for root in allowed):
        raise AssertionError('test attempted access to the real home')
sys.addaudithook(deny_real_home)
try:
    open(os.path.join(real_home, '.config', 'session-mesh', 'synthetic-audit-probe'))
except AssertionError: pass
else: raise AssertionError('real-home audit guard did not run')
import asyncio, tempfile
from pathlib import Path
from unittest.mock import patch
from aiohttp import web
import server, view
assert Path.home() == Path(os.environ['HOME'])
assert str(server.CONF_DIR).startswith(os.environ['HOME'] + os.sep)
with tempfile.TemporaryDirectory() as t:
    home = Path(t); conf = home / 'conf'; conf.mkdir()
    data = home / 'custom-data'; profile = home / 'profile-data'; override = home / 'other/custom.db'
    databases = [data / 'opencode/opencode.db', profile / 'opencode/opencode.db', override]
    for db in databases:
        db.parent.mkdir(parents=True, exist_ok=True)
        for suffix in ('', '-wal', '-shm'): Path(str(db) + suffix).write_text('synthetic')
    ordinary = profile / 'opencode/notes.txt'; ordinary.write_text('ordinary')
    hardlink = home / 'hardlink.db'; hardlink.hardlink_to(databases[0])
    symlink = home / 'symlink.db'; symlink.symlink_to(databases[1])
    auth = data / 'opencode/auth.json'; auth.write_text('synthetic')
    with patch.object(Path, 'home', return_value=home), patch.dict('os.environ', {'XDG_DATA_HOME': str(data), 'OPENCODE_DB': str(override)}):
        view.configure('synthetic', conf); view.deny_account_files([str(profile)])
        assert all(view._denied(Path(str(db) + suffix)) for db in databases for suffix in ('', '-wal', '-shm'))
        assert view._denied(hardlink)
        assert view._denied(symlink)
        assert view._denied(auth)
        assert not view._denied(ordinary)
    relative = data / 'opencode/subdir/custom.db'
    relative.parent.mkdir(parents=True)
    for suffix in ('', '-wal', '-shm'): Path(str(relative) + suffix).write_text('synthetic')
    with patch.object(Path, 'home', return_value=home), patch.dict('os.environ', {'XDG_DATA_HOME': str(data), 'OPENCODE_DB': 'subdir/custom.db'}):
        view.configure('synthetic', conf)
        assert all(view._denied(Path(str(relative) + suffix)) for suffix in ('', '-wal', '-shm'))
async def refresh(): return []
async def incomplete(*args): return {'accounts': [], 'launch_profiles': []}
async def missing_launch(*args): return {'accounts': [], 'protected_roots': []}
async def malformed_launch(*args): return {'accounts': [], 'protected_roots': [], 'launch_profiles': 'invalid'}
async def check():
    with patch.object(server, 'declared_accounts', refresh), patch.object(server, '_native_profile_mode', return_value=True), patch.dict(server._ACCOUNTS, {'file': 'refused'}):
        try: await server.refresh_document_account_protection()
        except web.HTTPServiceUnavailable: pass
        else: raise AssertionError('unknown native roots must refuse document access')
        server._ACCOUNTS['file'] = 'ok'
        await server.refresh_document_account_protection()
    with patch.object(server, '_accounts_signature', return_value=('native',)), patch.object(server, '_native_profile_mode', return_value=True), patch.object(server, '_accounts_program', incomplete), patch.object(server, '_protected_folders', return_value=[]), patch.object(view, 'deny_account_files'), patch.dict(server._ACCOUNTS, {'file': 'ok', 'signature': 'old'}):
        await server._refresh_declared_accounts()
        assert server._ACCOUNTS['file'] == 'refused', 'missing protected_roots must never mean an empty inventory'
    for answer in (missing_launch, malformed_launch):
        with patch.object(server, '_accounts_signature', return_value=('native',)), patch.object(server, '_native_profile_mode', return_value=True), patch.object(server, '_accounts_program', answer), patch.object(server, '_protected_folders', return_value=[]), patch.object(view, 'deny_account_files'), patch.dict(server._ACCOUNTS, {'file': 'ok', 'signature': 'old'}):
            await server._refresh_declared_accounts()
            assert server._ACCOUNTS['file'] == 'refused', 'missing or malformed native launch inventory must fail closed'
    with patch.object(server, '_accounts_signature', return_value=('legacy',)), patch.object(server, '_native_profile_mode', return_value=False), patch.object(server, '_accounts_program', missing_launch), patch.object(server, '_protected_folders', return_value=[]), patch.object(view, 'deny_account_files'), patch.dict(server._ACCOUNTS, {'file': 'ok', 'signature': 'old'}):
        await server._refresh_declared_accounts()
        assert server._ACCOUNTS['file'] == 'ok', 'legacy helpers need not advertise launch_profiles'
asyncio.run(check())
`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-view-protection-'));
  try {
    execFileSync(process.env.MESH_PYTHON || 'python3', ['-c', code], {cwd: REPO, stdio: 'pipe',
      env: {PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config'),
        XDG_DATA_HOME: path.join(scratch, 'data'), XDG_STATE_HOME: path.join(scratch, 'state'),
        XDG_RUNTIME_DIR: path.join(scratch, 'run'), MESH_CONF_DIR: path.join(scratch, 'mesh-conf'),
        MESH_TEST_REAL_HOME: os.homedir(), PYTHONDONTWRITEBYTECODE: '1'}});
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});
