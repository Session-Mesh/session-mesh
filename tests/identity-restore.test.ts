// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A restore reads the identity registry first. A conversation the registry names is resumed; one that is
// contested, unknown or gone is never relaunched: the session comes back as a shell in its folder, with one
// line typed there saying why. Real server.py, real PTY host, a fake `claude` that logs its argv.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {ALPHA_CREATED, type Lab, SID, withLab, writeClaudeTranscript} from './restore-exact-lib.ts';

const TIMEOUT = {timeout: 120000};
const OTHER = '0e6c0000-1111-4222-8333-555555555555';

function alphaIdentity(id: string | null): object {
  return {session: {name: 'alpha', created: ALPHA_CREATED, nonce: null}, agent: 'claude', id,
    source: id ? 'hook' : 'observed', evidence: id ? 'hook:Stop' : 'observed:pid_metadata', agent_started: null,
    observed_at: Date.now() / 1000, generation: 1, state: id ? 'active' : 'contested', holds_open: false};
}

/** The `new` requests the server sends to the host, by session name. */
function newRequests() {
  const sent: Record<string, any> = {};
  return {sent, intercept: (request: any) => {
    if (request.op === 'new') sent[request.name] = request;
    return undefined;
  }};
}

async function restoredAsShell(lab: Lab, sent: Record<string, any>, note: RegExp, line: RegExp): Promise<void> {
  const answer = await lab.post({names: ['alpha']});
  const result = answer.json.results.alpha;
  assert.equal(result.ok, true, answer.text);
  assert.equal(result.resumed, false);
  assert.match(result.note, note);
  assert.equal(sent.alpha.cwd, lab.offers.alpha.cwd, 'in the session folder');
  assert.match(sent.alpha.command, /^printf '%s\\n' /, 'one line typed in the shell');
  assert.match(sent.alpha.command, line);
  assert.equal(sent.alpha.meta.known_agent, null, 'a plain shell');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(lab.starts(), 0, 'the agent was not relaunched');
}

test('a contested conversation is restored as a shell that says why, never resumed', TIMEOUT, () => {
  const host = newRequests();
  return withLab(lab => restoredAsShell(lab, host.sent, /claimed by another session/, /claude not relaunched: .*contested/),
    {identities: [alphaIdentity(null)], intercept: host.intercept});
});

test('a conversation the registry names but that no longer exists is restored as a shell', TIMEOUT, () => {
  const host = newRequests();
  return withLab(lab => restoredAsShell(lab, host.sent, /Conversation not found/, /no longer exists/),
    {identities: [alphaIdentity(OTHER)], intercept: host.intercept});
});

test('an agent whose conversation is unknown is restored as a shell that says so', TIMEOUT, () => {
  const host = newRequests();
  return withLab(async lab => {
    const answer = await lab.post({names: ['bare']});
    assert.match(answer.json.results.bare.note, /Unknown conversation ID/, answer.text);
    assert.match(host.sent.bare.command, /claude not relaunched: its conversation ID is unknown/);
    assert.equal(lab.starts(), 0);
  }, {bare: true, intercept: host.intercept});
});

test('the registry wins over the snapshot: its conversation is the one resumed', TIMEOUT, () => withLab(async lab => {
  writeClaudeTranscript(lab.mesh.home, OTHER, lab.offers.alpha.cwd);
  const answer = await lab.post({names: ['alpha']});
  assert.equal(answer.json.results.alpha.resumed, true, answer.text);
  const deadline = Date.now() + 10000;
  while (lab.starts() < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const argv = fs.readFileSync(lab.argvLog, 'utf8').split('\n');
  assert.equal(argv[argv.indexOf('--resume') + 1], OTHER);
  assert.ok(!argv.includes(SID), 'not the snapshot conversation');
}, {identities: [alphaIdentity(OTHER)]}));

test('a guarded restore of a contested conversation is refused and creates nothing', TIMEOUT, () => withLab(async lab => {
  const answer = await lab.exact(lab.offers.alpha);
  assert.deepEqual([answer.json.ok, answer.json.code, answer.json.phase], [false, 'not-resumable', 'not-started'],
    JSON.stringify(answer.json));
  assert.match(answer.json.error, /claimed by another session/);
  assert.deepEqual(await lab.listed(), []);
}, {identities: [alphaIdentity(null)]}));
