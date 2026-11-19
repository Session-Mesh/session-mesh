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

function postNew(lab: Lab, name: string, cwd = lab.offers.alpha.cwd): Promise<Response> {
  return fetch(`${lab.mesh.base}/api/new`, {method: 'POST',
    headers: {Authorization: `Bearer ${lab.mesh.token()}`, Origin: lab.mesh.base, 'Content-Type': 'application/json'},
    body: JSON.stringify({preset: 'claude', cwd, name})});
}

async function newClaude(lab: Lab, name: string, cwd = lab.offers.alpha.cwd): Promise<void> {
  const response = await postNew(lab, name, cwd);
  assert.equal(response.status, 200, await response.text());
}

function hookReporting(conversation: string): string {
  const python = process.env.MESH_PYTHON || 'python3';
  const payload = JSON.stringify({hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', session_id: conversation});
  return `printf '%s' '${payload}' | '${python}' -I '${path.join(REPO, 'bin', 'mesh-event')}' claude`;
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

test("the session's own Claude hook reports another conversation (a /clear): the registry follows it", TIMEOUT, () =>
  withLab(async lab => {
    await newClaude(lab, 'cleared');
    await waitFor('the hook report was recorded', 15000, () =>
      registry(lab).some(e => e.session.name === 'cleared' && e.id === CLEARED));
    const entry = registry(lab).find(e => e.session.name === 'cleared');
    assert.deepEqual([entry.source, entry.evidence, entry.state], ['hook', 'hook:UserPromptSubmit', 'active']);
  }, {claudeLines: [hookReporting(CLEARED)]}));

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

test('a restore is refused while a live session holds the conversation in the registry, unseen by the listing', TIMEOUT, () =>
  withLab(async lab => {
    // `holder` runs in another folder; its hook reported SID, which no listing shows (no pid file, no history guess).
    await newClaude(lab, 'holder', lab.offers.bravo.cwd);
    await waitFor('the hook report was recorded', 15000, () =>
      registry(lab).some(e => e.session.name === 'holder' && e.id === SID && e.source === 'hook'));
    const answer = await lab.post({names: ['alpha']});
    const result = answer.json.results.alpha;
    assert.equal(result.ok, false, answer.text);
    assert.match(result.error, /already running \(another session\): nothing was started/);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(lab.starts(), 1, 'no second agent on the conversation');
    assert.deepEqual((await lab.listed()).map(s => s.name), ['holder']);
    const holder = registry(lab).find(e => e.session.name === 'holder');
    assert.deepEqual([holder.id, holder.state], [SID, 'active'], 'the holder keeps it');
  }, {claudeLines: [hookReporting(SID)]}));

test('a live session known by its nonce only (launched, not yet bound by a listing) blocks a restore', TIMEOUT, () => {
  // Each host listing would bind the entry's birth date: at every `list` request (the last one is the launch's own
  // check), the registry is put back with the live session's entry keyed by its nonce only.
  const unbound = {file: '', text: ''};
  const rewrite = () => {
    fs.writeFileSync(`${unbound.file}.test`, unbound.text, {mode: 0o600});
    fs.renameSync(`${unbound.file}.test`, unbound.file);
  };
  return withLab(async lab => {
    await lab.newShell('fresh');
    const fresh = (await lab.listed() as any[]).find(s => s.name === 'fresh')!;
    assert.match(fresh.meta?.nonce ?? '', /^[0-9a-f]{32}$/, 'the host lists the nonce');
    unbound.file = path.join(lab.mesh.confDir, 'session-identities.json');
    unbound.text = JSON.stringify({version: 1, generation: 5, entries: [{
      session: {name: 'fresh', created: null, nonce: fresh.meta.nonce}, agent: 'claude', id: SID, source: 'chosen',
      evidence: 'launch:history', agent_started: null, observed_at: Date.now() / 1000, generation: 5, state: 'active',
      holds_open: false}]});
    rewrite();
    const answer = await lab.post({names: ['alpha']});
    assert.match(answer.json.results.alpha.error ?? '', /already running \(another session\): nothing was started/,
      answer.text);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(lab.starts(), 0, 'no agent on the conversation');
  }, {intercept: request => {
    if (request.op === 'list' && unbound.text) rewrite();
    return undefined;
  }});
});

function hookStop(): string {
  const python = process.env.MESH_PYTHON || 'python3';
  const payload = JSON.stringify({hook_event_name: 'Stop', prompt_id: 'p0', background_tasks: []});
  return `printf '%s' '${payload}' | '${python}' -I '${path.join(REPO, 'bin', 'mesh-event')}' claude`;
}

test("a turn after a finished one withdraws the notice's Enter before its conversation is recorded", TIMEOUT, () => {
  const at: {confDir: string; recordedAtCancel: boolean[]} = {confDir: '', recordedAtCancel: []};
  return withLab(async lab => {
    at.confDir = lab.mesh.confDir;
    await newClaude(lab, 'turns');
    await waitFor('the hook report was recorded', 15000, () =>
      registry(lab).some(e => e.session.name === 'turns' && e.id === CLEARED));
    assert.deepEqual(at.recordedAtCancel, [false],
      'the withdrawal is sent first: a newer finished turn applied during the record keeps its Enter');
  }, {claudeLines: [hookStop(), hookReporting(CLEARED)], intercept: request => {
    if (request.op === 'cancel_submit' && at.confDir) {
      const file = path.join(at.confDir, 'session-identities.json');
      at.recordedAtCancel.push(JSON.parse(fs.readFileSync(file, 'utf8')).entries.some((e: any) => e.id === CLEARED));
    }
    return undefined;
  }});
});

test('a launch whose record fails after the file was replaced drops that record and starts nothing', TIMEOUT, () =>
  withLab(async lab => {
    lab.denyDirectoryRead(true);   // the registry is replaced, the flush of its folder fails
    let response: Response;
    try { response = await postNew(lab, 'unflushed'); } finally { lab.denyDirectoryRead(false); }
    assert.equal(response.status, 409);
    assert.match(await response.text(), /could not be recorded: nothing was started/);
    assert.equal(registry(lab).find(e => e.session.name === 'unflushed'), undefined, 'no record of a launch never sent');
    assert.deepEqual((await lab.listed()).map(s => s.name), []);
  }));

test('a launch the host refuses for good drops its record', TIMEOUT, () => {
  const at = recordedAtNew();
  return withLab(async lab => {
    at.setConf(lab.mesh.confDir);
    const response = await postNew(lab, 'refused');
    assert.notEqual(response.status, 200, await response.text());
    assert.equal(at.seen.refused.entry?.source, 'chosen', 'recorded before the request');
    assert.equal(registry(lab).find(e => e.session.nonce === at.seen.refused.nonce), undefined, 'dropped after the refusal');
  }, {intercept: request => {
    const seen = at.intercept(request);
    return request.op === 'new' ? {reply: {error: 'refused for the test'}} : seen;
  }});
});

test('a launch cancelled after its request was sent keeps its record: the session may still appear', TIMEOUT, () => {
  const at = recordedAtNew();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return withLab(async lab => {
    at.setConf(lab.mesh.confDir);
    const pending = postNew(lab, 'slow').catch(() => null);
    await waitFor('the creation was sent', 10000, () => Boolean(at.seen.slow));
    await lab.mesh.halt(true);   // a second SIGTERM: the handler is cancelled while its `new` is in flight
    await pending;
    const kept = registry(lab).find(e => e.session.nonce === at.seen.slow.nonce);
    assert.deepEqual([kept?.source, kept?.state], ['chosen', 'active']);
    release();
  }, {intercept: request => {
    at.intercept(request);
    return request.op === 'new' ? {wait: gate} : undefined;
  }});
});
