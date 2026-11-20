// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Runs a short Python snippet against the real agentmail, respawn and server modules in a
// throwaway configuration directory (HOME, XDG_*, MESH_CONF_DIR and the runtime directory are the
// snippet's own: no real host, port or user file is reachable). The snippet prints one JSON value
// as its last line; it is returned parsed.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');

// Shared by every snippet: identities, a seeded mailbox and the snapshot file of respawn.
const PRELUDE = `
import asyncio, json, os, sys, time
sys.path.insert(0, ${JSON.stringify(REPO)})
import agentmail, respawn

SID = '0a1b2c3d-1111-2222-3333-444444444444'
SID2 = '9f8e7d6c-1111-2222-3333-555555555555'

def ident(name, created, agent='claude'):
    return {'id': name, 'created': created, 'agent': agent}

def message(n, source, target, text='hello'):
    return {'id': format(n, 'x').rjust(32, 'a'), 'conversation_id': 'b' * 32, 'source': source,
            'target': target, 'kind': 'message', 'text': text, 'created': 4.0, 'seq': n}

def seed(messages=(), wakes=(), requests=(), policies=()):
    state = agentmail._empty_state()
    state['next_seq'] = len(messages) + 1
    state['messages'], state['wakes'] = list(messages), list(wakes)
    state['consent_requests'], state['always_policies'] = list(requests), list(policies)
    agentmail._save(state)

def entry(name, created, cwd, agent='claude', sid=SID, lost_at=None):
    return {'name': name, 'cwd': cwd, 'created': created, 'cmd': None, 'lost_at': lost_at,
            'agent': {'type': agent, 'session_id': sid, 'argv': [agent]} if agent else None,
            'org': {'label': None, 'folder': None, 'rank': None}}

def snapshot(live=(), lost=()):
    respawn.FILE.parent.mkdir(parents=True, exist_ok=True)
    respawn.FILE.write_text(json.dumps({'version': 1, 'host': None, 'live': list(live), 'lost': list(lost)}))

def stored():
    return agentmail._load()

def out(value):
    print(json.dumps(value))
`;

export function runPython<T>(code: string): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  try {
    const run = path.join(root, 'run');
    fs.mkdirSync(run, {mode: 0o700});
    const result = spawnSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', PRELUDE + code], {
      cwd: root, encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, XDG_RUNTIME_DIR: run,
        XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_DATA_HOME: path.join(root, 'data'), MESH_CONF_DIR: path.join(root, 'conf'),
        MESH_CACHE_DIR: path.join(root, 'cache-mesh'), PYTHONPATH: REPO, SHELL: '/bin/sh',
      },
    });
    if (result.status !== 0) throw new Error(`python failed: ${result.stderr || result.stdout}`);
    const lines = result.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]) as T;
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// An in-memory PTY host for server.restore_one: lists, creates and remembers sessions.
export const FAKE_HOST = `
import ptyhost, server

class FakeHost:
    def __init__(self, sessions=()):
        self.sessions = [dict(s) for s in sessions]
        self.new_requests = []
    async def request(self, req):
        if req['op'] == 'list':
            return [dict(s) for s in self.sessions]
        if req['op'] == 'new':
            self.new_requests.append(req)
            self.sessions.append({'name': req['name'], 'pid': 999999, 'cwd': req['cwd'],
                                  'created': 5000.0 + len(self.sessions), 'activity': 0,
                                  'attached': 0, 'meta': req['meta']})
            return {'ok': True, 'name': req['name']}
        if req['op'] == 'processes':
            # ptyhost.host_identity off Linux, where the host names itself: an unknown host, as
            # on Linux, where it reads the peer of a socket that does not exist here.
            return {}
        raise AssertionError(req)

def install(fake):
    ptyhost.request = fake.request
    server._conversation_missing = lambda kind, sid, account=None: False   # no transcript files in this home

def live_session(name, created, agent='claude', nonce='n0'):
    return {'name': name, 'pid': 999998, 'cwd': '/tmp', 'created': created, 'activity': 0,
            'attached': 0, 'meta': {'agent': agent, 'known_agent': agent, 'nonce': nonce}}

async def restore(name):
    return await server.restore_one(name, set(), asyncio.Lock())
`;
