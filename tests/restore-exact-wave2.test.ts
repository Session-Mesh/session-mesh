// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Conditions of the fourth review of the guarded restore: the guard is announced before anything is sent,
// an offer whose page restore was sent without a confirmation is held (no second shell), a failure after
// the creation or a malformed host reply holds the conversation, and a History resume and a restore
// never run a second agent on one conversation. Real server.py, real PTY host (Python, or MESH_PTYHOST_CMD).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {type Intercept} from './ptyhost-proxy-lib.ts';
import {type Lab, type Offer, SID, withLab} from './restore-exact-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const TIMEOUT = {timeout: 120000};

/** A host that holds the first `new` named `name` until `release()` (then still creates it). `seen`: the names of
 *  every `new` that reached the proxy, in order. */
function slowNew(name: string) {
  let release!: () => void;
  let held = false;
  const seen: string[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  const intercept: Intercept = request => {
    if (request.op !== 'new') return undefined;
    seen.push(request.name);
    if (held || request.name !== name) return undefined;
    held = true;
    return {wait: gate};
  };
  return {intercept, release: () => release(), sent: () => held, seen};
}

const twinOf = (lab: Lab): Offer => ({...lab.offers.alpha, name: 'twin', created: lab.offers.alpha.created + 5,
  cwd: lab.offers.alpha.cwd.replace('alpha-dir', 'twin-dir')});

// ---- M1: a capability read before the send

test('GET /api/sessions announces the guard a tool reads before it sends a guarded restore', TIMEOUT, () => withLab(async lab => {
  const sessions = await lab.sessionsJson();
  assert.equal(sessions.status, 200);
  assert.equal(sessions.json.restore_guard, 'exact-v1');
  const done = await lab.exact(lab.offers.bravo);
  assert.equal(done.json.guarded, true, 'and the answer of a guarded restore says so too');
}));

// ---- M3: a shell offer is held after a page restore sent without a confirmation

test('a page click that times out, then a second click: one shell, not two', TIMEOUT, async () => {
  const slow = slowNew('bravo');
  await withLab(async lab => {
    const first = await lab.post({names: ['bravo']});
    assert.equal(first.status, 503, first.text);
    const second = await lab.post({names: ['bravo']});
    assert.equal(second.json.results.bravo.ok, false, second.text);
    assert.match(second.json.results.bravo.error, /sent a moment ago/);
    const exact = await lab.exact(lab.offers.bravo);   // the exact restore is held back too
    assert.deepEqual([exact.json.ok, exact.json.code, exact.json.phase], [false, 'target-occupied', 'not-started']);
    slow.release();
    await waitFor('the delayed shell appeared', 15000, async () => (await lab.listed()).length > 0);
    await new Promise(resolve => setTimeout(resolve, 1500));   // a second shell would exist by now
    assert.deepEqual((await lab.listed()).map(s => s.name), ['bravo']);
    assert.deepEqual(slow.seen, ['bravo'], 'one creation reached the host');
  }, {intercept: slow.intercept});
});

// ---- the page path: a failure between the successful `new` and the end of the path

test('the host fails right after the page created the session: the conversation stays held', TIMEOUT, async () => {
  let created = false;
  let failed = false;
  await withLab(async lab => {
    const page = await lab.post({names: ['alpha']});
    assert.equal(page.status, 400, page.text);   // the listing that confirms the session failed
    assert.ok(created && failed);
    await waitFor('the session exists', 10000, async () => (await lab.listed()).some(s => s.name === 'alpha'));
    const twin = await lab.exact(twinOf(lab));
    assert.deepEqual([twin.json.ok, twin.json.code, twin.json.phase], [false, 'conversation-running', 'not-started']);
    assert.equal(await lab.historyResume('claude', SID), 409);
    assert.equal((await lab.listed()).length, 1, 'one session on the conversation');
  }, {twin: true, intercept: request => {
    if (request.op === 'new') created = true;
    else if (request.op === 'list' && created && !failed) { failed = true; return {reply: {error: 'host broke'}}; }
  }});
});

// ---- B3: a host reply that is not understood, after the send

test('a malformed reply to the creation holds the conversation on the page path', TIMEOUT, async () => {
  let garbled = false;
  await withLab(async lab => {
    const page = await lab.post({names: ['alpha']});
    assert.equal(page.status, 503, page.text);
    assert.ok(garbled);
    const twin = await lab.exact(twinOf(lab));
    assert.deepEqual([twin.json.ok, twin.json.code, twin.json.phase], [false, 'conversation-running', 'not-started']);
    assert.equal(await lab.historyResume('claude', SID), 409);
  }, {twin: true, intercept: request => {
    if (request.op !== 'new' || garbled) return undefined;
    garbled = true;
    return {rawReply: '{not json'};
  }});
});

test('a malformed reply to the creation holds the conversation on the History path', TIMEOUT, async () => {
  let garbled = false;
  await withLab(async lab => {
    lab.writeTranscript(SID, lab.offers.alpha.cwd);
    assert.equal(await lab.historyResume('claude', SID), 503);
    assert.ok(garbled);
    const exact = await lab.exact(lab.offers.alpha);
    assert.deepEqual([exact.json.ok, exact.json.code, exact.json.phase], [false, 'conversation-running', 'not-started']);
  }, {intercept: request => {
    if (request.op !== 'new' || garbled) return undefined;
    garbled = true;
    return {rawReply: '{not json'};
  }});
});

test('a malformed reply to the creation of an exact restore is host-error, the intent stays', TIMEOUT, async () => {
  let garbled = false;
  await withLab(async lab => {
    const exact = await lab.exact(lab.offers.alpha);
    assert.deepEqual([exact.json.code, exact.json.phase], ['host-error', 'uncertain'], JSON.stringify(exact.json));
    assert.match(lab.snapshotLost().find(e => e.name === 'alpha')?.restoring?.nonce ?? '', /^[0-9a-f]{32}$/);
  }, {intercept: request => {
    if (request.op !== 'new' || garbled) return undefined;
    garbled = true;
    return {rawReply: '{not json'};
  }});
});

// ---- M2: a successful History resume holds the conversation as long as a restore does

test('after a successful History resume the conversation stays held past its guard', TIMEOUT, () => withLab(async lab => {
  lab.writeTranscript(SID, lab.offers.alpha.cwd);
  assert.equal(await lab.historyResume('claude', SID), 200);
  await waitFor('the resumed agent started', 10000, () => lab.starts() >= 1);
  await new Promise(resolve => setTimeout(resolve, 3500));   // MESH_HISTORY_RESUME_GRACE (2 s here, 20 s by default) is over
  assert.equal(await lab.historyResume('claude', SID), 409, 'still held: the same conversation is not started again');
  const exact = await lab.exact(lab.offers.alpha);
  assert.deepEqual([exact.json.ok, exact.json.code], [false, 'conversation-running']);
  assert.equal(lab.starts(), 1);
}, {env: {MESH_HISTORY_RESUME_GRACE: '2'}}));

// ---- M5: the History resume takes the restore lock

test('a History resume waits for a restore in flight and is refused as just restored', TIMEOUT, async () => {
  const slow = slowNew('alpha');
  await withLab(async lab => {
    lab.writeTranscript(SID, lab.offers.alpha.cwd);
    const page = lab.post({names: ['alpha']});
    await waitFor('the creation was sent', 10000, async () => slow.sent());
    const resume = lab.historyResume('claude', SID);
    await new Promise(resolve => setTimeout(resolve, 1000));
    slow.release();
    const restored = await page;
    assert.equal(restored.json.results.alpha.ok, true, restored.text);
    assert.equal(await resume, 409, 'the resume saw the conversation the restore has just started');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await lab.listed()).length, 1, 'one session on the conversation');
    assert.equal(lab.starts(), 1, 'one agent on the conversation');
  }, {intercept: slow.intercept});
});

// ---- M4: the intent was written to the file, the flush of the directory failed

test('an intent whose directory flush fails is withdrawn: nothing is created, the same request then succeeds', TIMEOUT, () => {
  let lab!: Lab;
  let lists = 0;
  return withLab(async started => {
    lab = started;
    const refused = await lab.exact(lab.offers.alpha);
    lab.denyDirectoryRead(false);
    assert.equal(refused.status, 200, refused.text);
    assert.equal(refused.json?.code, 'not-restored', refused.text);
    assert.match(refused.json.error, /repeat the same request/);
    assert.deepEqual(await lab.listed(), [], 'no shell was created');
    assert.equal(lab.snapshotLost().find(e => e.name === 'alpha')?.restoring, undefined,
      'the intent that reached the file was withdrawn');
    const retried = await lab.exact(lab.offers.alpha);
    assert.equal(retried.json.ok, true, JSON.stringify(retried.json));
    assert.equal((await lab.listed()).length, 1);
  }, {intercept: request => {
    if (request.op === 'list' && ++lists === 2) lab.denyDirectoryRead(true);
  }});
});

// ---- a History resume of any agent takes the restore lock: it waits for a restore in flight

test('a History resume of every agent waits for a restore in flight, then is refused for the conversation it holds', TIMEOUT, async () => {
  const slow = slowNew('alpha');
  await withLab(async lab => {
    const page = lab.post({names: ['alpha']});
    await waitFor('the creation was sent', 10000, async () => slow.sent());
    const agents = ['claude', 'copilot', 'opencode', 'gemini', 'agy', 'vibe'];
    let settled = 0;
    const resumes = agents.map(agent => lab.historyResume(agent, SID).then(status => { settled++; return status; }));
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(settled, 0, 'no History resume starts or answers while the restore holds the lock');
    slow.release();
    assert.deepEqual(await Promise.all(resumes), agents.map(() => 409), 'the restored conversation is held: nothing is started twice');
    assert.equal((await page).json.results.alpha.ok, true);
  }, {intercept: slow.intercept});
});
