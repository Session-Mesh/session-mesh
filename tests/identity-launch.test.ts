// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The conversation ids the mesh knows at launch, and the ones the agent's hooks report, go into the identity
// registry. A new Claude is started with `--session-id <uuid>` chosen by the mesh; a restore records the
// conversation it resumes. Both are written before the `new` request reaches the PTY host. A hook of the
// session's own Claude (bin/mesh-event) then reports the conversation it is in. Real server.py, real PTY host,
// a fake `claude`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';
import {type Lab, SID, withLab} from './restore-exact-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const TIMEOUT = {timeout: 120000};
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLEARED = '0e6c0000-1111-4222-8333-555555555555';

function registry(lab: Lab): any[] {
  return JSON.parse(fs.readFileSync(path.join(lab.mesh.confDir, 'session-identities.json'), 'utf8')).entries;
}

/** At each `new` request, before the host sees it: the registry entry of that incarnation (by its nonce). */
function recordedAtNew() {
  const seen: Record<string, any> = {};
  let confDir = '';
  return {seen, setConf: (dir: string) => { confDir = dir; }, intercept: (request: any) => {
    if (request.op !== 'new' || !confDir) return undefined;
    const entries = JSON.parse(fs.readFileSync(path.join(confDir, 'session-identities.json'), 'utf8')).entries;
    seen[request.name] = {nonce: request.meta.nonce,
      entry: entries.find((e: any) => e.session.nonce === request.meta.nonce) ?? null};
    return undefined;
  }};
}

async function newClaude(lab: Lab, name: string): Promise<void> {
  const response = await fetch(`${lab.mesh.base}/api/new`, {method: 'POST',
    headers: {Authorization: `Bearer ${lab.mesh.token()}`, Origin: lab.mesh.base, 'Content-Type': 'application/json'},
    body: JSON.stringify({preset: 'claude', cwd: lab.offers.alpha.cwd, name})});
  assert.equal(response.status, 200, await response.text());
}

function argvAfter(lab: Lab, flag: string): string | undefined {
  const argv = fs.readFileSync(lab.argvLog, 'utf8').split('\n');
  return argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
}

test('a new Claude gets the conversation id the mesh chose, recorded before the agent starts', TIMEOUT, () => {
  const at = recordedAtNew();
  return withLab(async lab => {
    at.setConf(lab.mesh.confDir);
    await newClaude(lab, 'fresh');
    await waitFor('the fake claude started', 10000, () => lab.starts() >= 1);
    const chosen = argvAfter(lab, '--session-id');
    assert.match(chosen ?? '', UUID4, 'a UUIDv4 on the command line');
    assert.equal(argvAfter(lab, '--resume'), undefined, 'a new conversation, not a resume');
    const {entry} = at.seen.fresh;
    assert.deepEqual([entry.id, entry.source, entry.evidence, entry.state, entry.session.created],
      [chosen, 'chosen', 'launch:session_id', 'active', null], 'written before the new request');
    await lab.sessionsJson();       // a listing binds the session's birth date to the entry
    const listed = (await lab.listed()).find(s => s.name === 'fresh')!;
    const bound = registry(lab).find(e => e.session.nonce === at.seen.fresh.nonce);
    assert.equal(bound.session.created, listed.created);
  }, {intercept: at.intercept});
});

test("the session's own Claude hook reports another conversation (a /clear): the registry follows it", TIMEOUT, () => {
  const python = process.env.MESH_PYTHON || 'python3';
  const payload = JSON.stringify({hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', session_id: CLEARED});
  const hook = `printf '%s' '${payload}' | '${python}' -I '${path.join(REPO, 'bin', 'mesh-event')}' claude`;
  return withLab(async lab => {
    await newClaude(lab, 'cleared');
    await waitFor('the hook report was recorded', 15000, () =>
      registry(lab).some(e => e.session.name === 'cleared' && e.id === CLEARED));
    const entry = registry(lab).find(e => e.session.name === 'cleared');
    assert.deepEqual([entry.source, entry.evidence, entry.state], ['hook', 'hook:UserPromptSubmit', 'active']);
  }, {claudeLines: [hook]});
});

test('a restore records the conversation it resumes as chosen before the agent starts', TIMEOUT, () => {
  const at = recordedAtNew();
  return withLab(async lab => {
    at.setConf(lab.mesh.confDir);
    const answer = await lab.post({names: ['alpha']});
    assert.equal(answer.json.results.alpha.resumed, true, answer.text);
    const {entry} = at.seen.alpha;
    assert.deepEqual([entry.id, entry.source, entry.evidence, entry.state], [SID, 'chosen', 'launch:restore', 'active']);
  }, {intercept: at.intercept});
});
