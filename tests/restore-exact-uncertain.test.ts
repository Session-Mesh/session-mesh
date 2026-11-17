// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// One conversation, at most one agent, whichever path asked (the exact restore, the page's "Restore", the
// History's "resume") and whatever the PTY host did meanwhile. A request sent to the host whose outcome is
// unknown holds the conversation back; a refusal before anything was sent holds nothing back and leaves
// no intent on the offer. Real server.py, real PTY host (Python, or MESH_PTYHOST_CMD) behind a proxy.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {type Intercept} from './ptyhost-proxy-lib.ts';
import {type Lab, type Offer, SID, withLab} from './restore-exact-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const TIMEOUT = {timeout: 120000};
const RESTORING_REFUSAL = 'An exact restore is in progress for this offer: repeat the exact request, or discard the offer';

/** A host that holds the first `new` accepted by `matches` (the server gives up after 5 s) until `release()`,
 *  then still creates the session. `sent()`: whether such a `new` arrived. */
function slowNew(matches: (request: any) => boolean = () => true) {
  let release!: () => void;
  let sent = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const intercept: Intercept = request => {
    if (request.op !== 'new' || sent || !matches(request)) return undefined;
    sent = true;
    return {wait: gate};
  };
  return {intercept, release: () => release(), sent: () => sent};
}

const twinOf = (lab: Lab): Offer => ({...lab.offers.alpha, name: 'twin', created: lab.offers.alpha.created + 5,
  cwd: lab.offers.alpha.cwd.replace('alpha-dir', 'twin-dir')});

async function oneAgentAfterRelease(lab: Lab, release: () => void, survivor: string): Promise<void> {
  release();
  await waitFor('the delayed session appeared', 15000, async () => (await lab.listed()).length > 0);
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  await new Promise(resolve => setTimeout(resolve, 1500));   // a second agent would have started by now
  assert.deepEqual((await lab.listed()).map(s => s.name), [survivor], 'one session on the conversation');
  assert.equal(lab.starts(), 1, 'one agent on the conversation');
}

test('the page click times out, then the exact restore of a twin offer is refused: one agent', TIMEOUT, async () => {
  const slow = slowNew(request => request.name === 'alpha');
  await withLab(async lab => {
    const page = await lab.post({names: ['alpha']});
    assert.equal(page.status, 503, page.text);
    const twin = await lab.exact(twinOf(lab));
    assert.deepEqual([twin.json.ok, twin.json.code, twin.json.phase], [false, 'conversation-running', 'not-started']);
    assert.equal(await lab.historyResume('claude', SID), 409, 'and so is a resume from the history');
    await oneAgentAfterRelease(lab, slow.release, 'alpha');
  }, {twin: true, intercept: slow.intercept});
});

test('the exact restore times out, then the page click on a twin offer starts nothing: one agent', TIMEOUT, async () => {
  const slow = slowNew(request => request.name === 'alpha');
  await withLab(async lab => {
    const first = await lab.exact(lab.offers.alpha);
    assert.deepEqual([first.json.code, first.json.phase], ['host-error', 'uncertain']);
    const page = await lab.post({names: ['twin']});
    assert.equal(page.json.results.twin.ok, false, page.text);
    await oneAgentAfterRelease(lab, slow.release, 'alpha');
  }, {twin: true, intercept: slow.intercept});
});

test('the History resume times out, then the exact restore of that conversation is refused: one agent', TIMEOUT, async () => {
  const slow = slowNew();
  await withLab(async lab => {
    lab.writeTranscript(SID, lab.offers.alpha.cwd);
    assert.equal(await lab.historyResume('claude', SID), 503);
    const exact = await lab.exact(lab.offers.alpha);
    assert.deepEqual([exact.json.ok, exact.json.code, exact.json.phase], [false, 'conversation-running', 'not-started']);
    assert.equal(await lab.historyResume('claude', SID), 409, 'a second click does not start a second agent');
    await oneAgentAfterRelease(lab, slow.release, 'alpha-dir-claude');
  }, {intercept: slow.intercept});
});

// ---- a refusal before anything was sent: no intent is left, nothing is held back

test('a Pi offer without Pi is refused for good: no intent, no restore-interrupted', TIMEOUT, () => withLab(async lab => {
  const offer = lab.piOffer;
  for (const attempt of [1, 2]) {
    const refused = await lab.exact(offer);
    assert.equal(refused.status, 200, refused.text);
    assert.deepEqual([refused.json.ok, refused.json.code, refused.json.phase, refused.json.status],
      [false, 'launch-refused', 'not-started', 503], `attempt ${attempt}: ${JSON.stringify(refused.json)}`);
    const entry = lab.snapshotLost().find(e => e.name === offer.name);
    assert.ok(entry, 'the offer stays');
    assert.equal(entry.restoring, undefined, 'no intent left');
  }
  const page = await lab.post({names: [offer.name]});
  assert.equal(page.status, 503, 'the page answers the Pi refusal, not the restoring one');
  assert.doesNotMatch(page.text, new RegExp(RESTORING_REFUSAL.slice(0, 20)));
  assert.deepEqual(await lab.listed(), []);
}, {pi: true}));

test('a failing listing of the host before the creation is refused for good: no intent left', TIMEOUT, async () => {
  let lab!: Lab;
  let hung = false;
  const never = new Promise<void>(() => {});
  await withLab(async started => {
    lab = started;
    const refused = await lab.exact(lab.offers.alpha);   // the listing new_session makes first does not answer
    assert.deepEqual([refused.json.ok, refused.json.code, refused.json.phase], [false, 'launch-refused', 'not-started'],
      JSON.stringify(refused.json));
    assert.equal(lab.snapshotLost().find(e => e.name === 'alpha')?.restoring, undefined, 'no intent left');
    const done = await lab.exact(lab.offers.alpha);
    assert.equal(done.json.ok, true, JSON.stringify(done.json));
    assert.equal((await lab.listed()).length, 1);
  }, {intercept: request => {
    if (request.op !== 'list' || hung) return undefined;
    const marked = lab?.snapshotLost().some(entry => entry.name === 'alpha' && entry.restoring);
    if (!marked) return undefined;
    hung = true;
    return {wait: never};
  }});
});

// ---- the handler is cancelled while the creation is in flight

test('a handler cancelled during a slow creation keeps the intent on the offer', TIMEOUT, async () => {
  const slow = slowNew(request => request.name === 'alpha');
  await withLab(async lab => {
    const pending = lab.exact(lab.offers.alpha).catch(() => null);
    await waitFor('the creation was sent', 10000, async () => slow.sent());
    await lab.mesh.halt(true);   // a second SIGTERM: the handler is cancelled while its `new` is in flight
    await pending;
    const kept = lab.snapshotLost().find(entry => entry.name === 'alpha');
    assert.match(kept?.restoring?.nonce ?? '', /^[0-9a-f]{32}$/, 'the intent survives a cancellation');
    slow.release();
    await waitFor('the delayed session appeared', 15000, async () => (await lab.listed()).some(s => s.name === 'alpha'));
  }, {intercept: slow.intercept});
});
