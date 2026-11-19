// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A restore reads the identity registry first. A conversation the registry names is resumed; one that is
// contested, unknown or gone is never relaunched: the session comes back as a shell in its folder, with one
// line typed there saying why. Real server.py, real PTY host, a fake `claude` that logs its argv.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {waitFor} from './ptyhost-wire-lib.ts';
import {ALPHA_CREATED, type Lab, type Offer, SID, withLab, writeClaudeTranscript} from './restore-exact-lib.ts';

const TIMEOUT = {timeout: 120000};
const OTHER = '0e6c0000-1111-4222-8333-555555555555';
const BARE_CREATED = ALPHA_CREATED + 9;   // restore-exact-lib's `bare` offer: an agent with no conversation id

function identity(name: string, created: number, id: string | null): object {
  return {session: {name, created, nonce: null}, agent: 'claude', id,
    source: id ? 'hook' : 'observed', evidence: id ? 'hook:Stop' : 'observed:pid_metadata', agent_started: null,
    observed_at: Date.now() / 1000, generation: 1, state: id ? 'active' : 'contested', holds_open: false};
}

function alphaIdentity(id: string | null): object {
  return identity('alpha', ALPHA_CREATED, id);
}

function registryEntries(lab: Lab): any[] {
  return JSON.parse(fs.readFileSync(path.join(lab.mesh.confDir, 'session-identities.json'), 'utf8')).entries;
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

test('a transcript that is a dangling link counts as gone: restored as a shell', TIMEOUT, () => {
  const host = newRequests();
  return withLab(lab => {
    const folder = path.join(lab.mesh.home, '.claude', 'projects', '-home-x');
    fs.mkdirSync(folder, {recursive: true});
    fs.symlinkSync(path.join(folder, 'deleted.jsonl'), path.join(folder, `${OTHER}.jsonl`));
    return restoredAsShell(lab, host.sent, /Conversation not found/, /no longer exists/);
  }, {identities: [alphaIdentity(OTHER)], intercept: host.intercept});
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

test('a guarded retry completes the session it created, although the transcript was deleted in between', TIMEOUT, () =>
  withLab(async lab => {
    const lock = path.join(lab.mesh.confDir, 'board.json.lock');
    fs.mkdirSync(lock);   // board.transfer cannot take its lock: the session exists, the completion fails
    const failed = await lab.exact(lab.offers.alpha);
    assert.equal(failed.json.code, 'completion-failed', failed.text);
    fs.rmdirSync(lock);
    fs.rmSync(path.join(lab.mesh.home, '.claude', 'projects', '-home-x', `${SID}.jsonl`));
    const retried = await lab.exact(lab.offers.alpha);
    assert.equal(retried.json.ok, true, retried.text);
    assert.equal((await lab.listed()).length, 1, 'no second session');
    assert.deepEqual(lab.snapshotLost().map(e => e.name), ['bravo'], 'the offer is gone');
  }));

test('a guarded restore of a conversation gone from disk is refused as not resumable and creates nothing', TIMEOUT, () =>
  withLab(async lab => {
    const answer = await lab.exact({...lab.offers.alpha, resume_id: OTHER});   // the registry's id, no transcript
    assert.deepEqual([answer.json.ok, answer.json.code, answer.json.phase], [false, 'not-resumable', 'not-started'],
      JSON.stringify(answer.json));
    assert.match(answer.json.error, /^Conversation not found: /);
    assert.deepEqual(await lab.listed(), []);
    assert.equal(lab.starts(), 0);
  }, {identities: [alphaIdentity(OTHER)]}));

test('a guarded restore that expects no conversation does not resume the one the registry names', TIMEOUT, () =>
  withLab(async lab => {
    writeClaudeTranscript(lab.mesh.home, OTHER, lab.offers.alpha.cwd);
    const listed = (await lab.sessionsJson()).json.restorable.find((o: any) => o.name === 'bare');
    assert.equal(listed.resumable, true, 'the offer shows what the restore would do');
    const bare: Offer = {name: 'bare', created: BARE_CREATED, agent_kind: 'claude', resume_id: null,
      cwd: path.join(lab.mesh.home, 'bare-dir')};
    const answer = await lab.exact(bare);
    assert.deepEqual([answer.json.ok, answer.json.code, answer.json.mismatched], [false, 'expected-mismatch', ['resume_id']],
      JSON.stringify(answer.json));
    assert.deepEqual(await lab.listed(), []);
    assert.equal(lab.starts(), 0);
  }, {bare: true, identities: [identity('bare', BARE_CREATED, OTHER)]}));

test('a conversation kept under $CLAUDE_CONFIG_DIR is found: it is resumed, not called gone', TIMEOUT, () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  const folder = path.join(config, 'projects', '-elsewhere');
  fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(path.join(folder, `${OTHER}.jsonl`), '{}\n');
  return withLab(async lab => {
    const answer = await lab.post({names: ['alpha']});
    assert.equal(answer.json.results.alpha.resumed, true, answer.text);
    await waitFor('the fake claude started', 10000, () => lab.starts() >= 1);
    const argv = fs.readFileSync(lab.argvLog, 'utf8').split('\n');
    assert.equal(argv[argv.indexOf('--resume') + 1], OTHER);
  }, {identities: [alphaIdentity(OTHER)], env: {CLAUDE_CONFIG_DIR: config}})
    .finally(() => fs.rmSync(config, {recursive: true, force: true}));
});

test('with no registry, a restore migrates the snapshot: the first holder resumes, its twin is contested', TIMEOUT, () =>
  withLab(async lab => {
    const first = await lab.post({names: ['alpha']});
    assert.equal(first.json.results.alpha.resumed, true, first.text);
    const migrated = registryEntries(lab).find(e => e.session.name === 'alpha' && e.session.created === ALPHA_CREATED);
    assert.deepEqual([migrated.id, migrated.evidence], [SID, 'migrated:pid_metadata']);
    const twin = await lab.post({names: ['twin']});
    assert.equal(twin.json.results.twin.resumed, false, twin.text);
    assert.match(twin.json.results.twin.note, /claimed by another session/);
    await waitFor('the fake claude started', 10000, () => lab.starts() >= 1);
    await new Promise(resolve => setTimeout(resolve, 1000));   // a second agent would have started by now
    assert.equal(lab.starts(), 1, 'one agent on the conversation');
  }, {noRegistry: true, twin: true}));
