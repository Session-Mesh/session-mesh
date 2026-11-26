// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// POST /api/restore with an `expected` precondition ("exact restore"): a real server.py, a real
// PTY host and a fake `claude` that logs its argv (see restore-exact-lib.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {type Intercept} from './ptyhost-proxy-lib.ts';
import {ALPHA_CREATED, BRAVO_CREATED, Lab, type Offer, SID, withLab} from './restore-exact-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

test('an exact offer is restored once, with the creation bound in the answer', () => withLab(async lab => {
  const first = await lab.exact(lab.offers.alpha);
  assert.equal(first.status, 200, first.text);
  const live = (await lab.listed()).filter(s => s.name === 'alpha');
  assert.equal(live.length, 1);
  assert.deepEqual(first.json, {ok: true, id: 'alpha', created: live[0]!.created, resumed: true, guarded: true,
    previous: {name: 'alpha', created: ALPHA_CREATED}});
  assert.notEqual(first.json.created, ALPHA_CREATED, 'the new incarnation, not the old one');
  await waitFor('the fake agent started', 10000, () => lab.starts() === 1);
  assert.match(fs.readFileSync(lab.argvLog, 'utf8'), new RegExp(`--resume\\n${SID}`));

  const again = await lab.exact(lab.offers.alpha);
  assert.deepEqual([again.json.ok, again.json.code, again.json.phase], [false, 'not-found', 'not-started']);
  assert.equal((await lab.listed()).length, 1);
  assert.equal(lab.starts(), 1);
  assert.deepEqual(lab.snapshotLost().map(e => e.name), ['bravo']);
}));

test('a plain shell offer is restored exactly too', () => withLab(async lab => {
  const done = await lab.exact(lab.offers.bravo);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.resumed, false);
  assert.equal(done.json.guarded, true);
  assert.deepEqual(done.json.previous, {name: 'bravo', created: BRAVO_CREATED});
  assert.equal(lab.starts(), 0);
}));

test('a stale or different offer is refused before any session is created', () => withLab(async lab => {
  const alpha = lab.offers.alpha;
  const cases: [string, Offer][] = [
    ['created', {...alpha, created: alpha.created + 1}],
    ['agent_kind', {...alpha, agent_kind: 'codex'}],
    ['resume_id', {...alpha, resume_id: '9f8e7d6c-1111-2222-3333-555555555555'}],
    ['cwd', {...alpha, cwd: lab.offers.bravo.cwd}],
  ];
  for (const [field, offer] of cases) {
    const refused = await lab.exact(offer);
    assert.equal(refused.status, 200, field);
    assert.equal(refused.json.code, 'expected-mismatch', field);
    assert.equal(refused.json.phase, 'not-started', field);
    assert.deepEqual(refused.json.mismatched, [field]);
  }
  const unknown = await lab.exact({...alpha, name: 'ghost'});
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.code, 'not-found');
  assert.deepEqual(await lab.listed(), []);
  assert.equal(lab.starts(), 0);
  assert.equal(lab.snapshotLost().length, 2);
}));

test('a busy target name is refused with no suffixed session; the historical path still suffixes', () => withLab(async lab => {
  await lab.newShell('alpha');
  const refused = await lab.exact(lab.offers.alpha);
  assert.equal(refused.status, 200);
  assert.equal(refused.json.code, 'target-occupied');
  assert.deepEqual((await lab.listed()).map(s => s.name), ['alpha']);
  assert.equal(lab.starts(), 0);

  const legacy = await lab.post({names: ['alpha']});
  assert.equal(legacy.status, 200, legacy.text);
  assert.deepEqual(legacy.json.results.alpha,
    {ok: true, id: 'alpha-2', resumed: true, warnings: ['restored under another name: alpha-2']});
  assert.deepEqual((await lab.listed()).map(s => s.name).sort(), ['alpha', 'alpha-2']);
}));

test('without expected the endpoint behaves as before', () => withLab(async lab => {
  const done = await lab.post({names: ['alpha', 'bravo', 'ghost']});
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json.results.alpha, {ok: true, id: 'alpha', resumed: true});
  assert.deepEqual(done.json.results.bravo, {ok: true, id: 'bravo', resumed: false});
  assert.equal(done.json.results.ghost.ok, false);
  assert.deepEqual((await lab.listed()).map(s => s.name).sort(), ['alpha', 'bravo']);
  assert.equal((await lab.post({names: 'alpha'})).status, 400);
  assert.equal((await lab.post({})).status, 400);
}));

test('two concurrent identical requests: exactly one wins', () => withLab(async lab => {
  const results = await Promise.all([lab.exact(lab.offers.alpha), lab.exact(lab.offers.alpha),
    lab.exact(lab.offers.alpha)]);
  assert.deepEqual(results.map(r => r.json.ok).sort(), [false, false, true]);
  assert.deepEqual(results.filter(r => !r.json.ok).map(r => r.json.code), ['not-found', 'not-found']);
  assert.equal((await lab.listed()).length, 1);
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  assert.equal(lab.starts(), 1);
}));

test('a failure after the creation: the retry completes without a second shell', () => withLab(async lab => {
  // board.transfer cannot take its lock: the shell exists but the transfer fails.
  const lock = path.join(lab.mesh.confDir, 'board.json.lock');
  fs.mkdirSync(lock);
  const failed = await lab.exact(lab.offers.alpha);
  assert.equal(failed.status, 200, failed.text);
  assert.equal(failed.json.code, 'completion-failed');
  assert.equal(failed.json.phase, 'created');
  const live = await lab.listed();
  assert.equal(live.length, 1);
  assert.equal(failed.json.created, live[0]!.created);
  assert.equal(failed.json.id, 'alpha');
  const kept = lab.snapshotLost().find(e => e.name === 'alpha');
  assert.match(kept?.restoring?.nonce ?? '', /^[0-9a-f]{32}$/, 'the offer stays, marked with the intent');
  assert.equal(kept?.restoring?.created, live[0]!.created, 'and with the birth date of its session');
  assert.equal((live[0] as any).meta.nonce, kept?.restoring?.nonce, 'the session carries the recorded nonce');

  fs.rmdirSync(lock);
  const retried = await lab.exact(lab.offers.alpha);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.ok, true);
  assert.equal(retried.json.created, live[0]!.created);
  assert.equal((await lab.listed()).length, 1, 'no second shell');
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  assert.equal(lab.starts(), 1);
  assert.deepEqual(lab.snapshotLost().map(e => e.name), ['bravo']);
  assert.equal((await lab.exact(lab.offers.alpha)).json.code, 'not-found');
}));

test('a marked offer whose session is gone is refused, not recreated', () => withLab(async lab => {
  fs.mkdirSync(path.join(lab.mesh.confDir, 'board.json.lock'));
  assert.equal((await lab.exact(lab.offers.alpha)).json.code, 'completion-failed');
  fs.rmdirSync(path.join(lab.mesh.confDir, 'board.json.lock'));
  await request(path.join(lab.mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {op: 'kill', name: 'alpha'});
  await waitFor('the session ended', 15000, async () => (await lab.listed()).length === 0);
  const refused = await lab.exact(lab.offers.alpha);
  assert.equal(refused.status, 200);
  assert.equal(refused.json.code, 'restore-interrupted');
  assert.equal(refused.json.phase, 'uncertain');
  assert.deepEqual(await lab.listed(), []);
  assert.equal(lab.snapshotLost().filter(e => e.name === 'alpha').length, 1, 'the offer stays for a discard');
}));

test('a malformed expected is a 400 and creates nothing', () => withLab(async lab => {
  const good = lab.offers.alpha;
  const {cwd: _cwd, ...withoutCwd} = good;
  const guarded = (expected: unknown, more: object = {}) => ({names: ['alpha'], expected, ...more});
  const bad: [string, unknown][] = [
    ['not an object', guarded('alpha')],
    ['null', guarded(null)],
    ['missing field', guarded(withoutCwd)],
    ['unknown field', guarded({...good, extra: 1})],
    ['names missing', {expected: good}],
    ['names empty', guarded(good, {names: []})],
    ['names of two', guarded(good, {names: ['alpha', 'bravo']})],
    ['names of another offer', guarded(good, {names: ['bravo']})],
    ['names a string', guarded(good, {names: 'alpha'})],
    ['other top-level field', guarded(good, {force: true})],
    ['created as text', guarded({...good, created: '1700000000'})],
    ['created boolean', guarded({...good, created: true})],
    ['created infinite', '{"names":["alpha"],"expected":' + JSON.stringify(good).replace('1700000000.25', '1e999') + '}'],
    ['unknown agent kind', guarded({...good, agent_kind: 'gpt'})],
    ['null agent kind', guarded({...good, agent_kind: null})],
    ['option as resume id', guarded({...good, resume_id: '--dangerous'})],
    ['resume id on a shell', guarded({...good, agent_kind: 'shell'})],
    ['relative cwd', guarded({...good, cwd: 'alpha-dir'})],
    ['oversized cwd', guarded({...good, cwd: '/' + 'a'.repeat(5000)})],
    ['slash in name', guarded({...good, name: 'a/b'})],
    ['name too long', guarded({...good, name: 'a'.repeat(49)})],
    ['not JSON', '{"expected":'],
    ['a list', [good]],
  ];
  for (const [what, body] of bad) {
    const refused = await lab.post(body);
    assert.equal(refused.status, 400, `${what}: ${refused.text}`);
  }
  assert.deepEqual(await lab.listed(), []);
  assert.equal(lab.starts(), 0);
  assert.equal(lab.snapshotLost().length, 2);
}));

test('the access control is unchanged: no credentials, 401', () => withLab(async lab => {
  const anonymous = await fetch(`${lab.mesh.base}/api/restore`, {method: 'POST',
    headers: {Origin: lab.mesh.base, 'Content-Type': 'application/json'}, body: JSON.stringify({names: ['alpha'], expected: lab.offers.alpha})});
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await lab.listed(), []);
}));

const FOREIGN_NONCE = 'a'.repeat(32);
const RESTORING_REFUSAL = 'An exact restore is in progress for this offer: repeat the exact request, or discard the offer';

test('the page restore (names) refuses an offer carrying the restore marker and creates nothing', () => withLab(async lab => {
  const lock = path.join(lab.mesh.confDir, 'board.json.lock');
  fs.mkdirSync(lock);
  assert.equal((await lab.exact(lab.offers.alpha)).json.code, 'completion-failed');
  fs.rmdirSync(lock);
  assert.equal((await lab.listed()).length, 1);

  const legacy = await lab.post({names: ['alpha', 'bravo']});
  assert.equal(legacy.status, 200, legacy.text);
  assert.deepEqual(legacy.json.results.alpha, {ok: false, error: RESTORING_REFUSAL});
  assert.equal(legacy.json.results.bravo.ok, true, 'an unmarked offer is restored as before');
  assert.deepEqual((await lab.listed()).map(s => s.name).sort(), ['alpha', 'bravo'], 'no alpha-2');
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  assert.equal(lab.starts(), 1);
  assert.ok(lab.snapshotLost().some(e => e.name === 'alpha'), 'the marked offer stays');
}));

test('a marked offer whose name is held by a foreign session is restore-interrupted', () => withLab(async lab => {
  await lab.newShell('alpha');
  const refused = await lab.exact(lab.offers.alpha);
  assert.equal(refused.status, 200);
  assert.equal(refused.json.code, 'restore-interrupted');
  assert.equal((await lab.listed()).length, 1, 'the foreign session is left alone, nothing else created');
  assert.equal(lab.starts(), 0);
  assert.ok(lab.snapshotLost().some(e => e.name === 'alpha'), 'the offer stays for a discard');
}, {marker: FOREIGN_NONCE}));

test('an intent that cannot be written creates nothing; the same request then succeeds', () => {
  let lab!: Lab;
  let lists = 0;
  // The host is listed three times before the intent is written (the snapshot of the mesh, the check of the
  // offer, the creation's own check): the folder turns read-only at the second, the check just before the write.
  return withLab(async started => {
    lab = started;
    const refused = await lab.exact(lab.offers.alpha);
    lab.makeConfigReadOnly(false);
    assert.equal(refused.status, 200, refused.text + "\n" + lab.mesh.output());
    assert.equal(refused.json?.code, 'not-restored', refused.text);
    assert.deepEqual(await lab.listed(), [], 'no shell was created');
    assert.equal(lab.starts(), 0);
    assert.equal(lab.snapshotLost().find(e => e.name === 'alpha')?.restoring, undefined);

    const retried = await lab.exact(lab.offers.alpha);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.ok, true);
    assert.equal((await lab.listed()).length, 1);
  }, {intercept: request => {
    if (request.op === 'list' && ++lists === 2) lab.makeConfigReadOnly(true);
  }});
});

test('two offers sharing one conversation: the second restore is refused', () => withLab(async lab => {
  const twin: Offer = {...lab.offers.alpha, name: 'twin', created: ALPHA_CREATED + 5,
    cwd: path.join(lab.mesh.home, 'twin-dir')};
  assert.equal((await lab.exact(lab.offers.alpha)).status, 200);
  const refused = await lab.exact(twin);
  assert.equal(refused.status, 200, refused.text);
  assert.equal(refused.json.code, 'conversation-running');
  assert.deepEqual((await lab.listed()).map(s => s.name), ['alpha']);
  const legacy = await lab.post({names: ['twin']});
  assert.equal(legacy.json.results.twin.ok, false, 'the page path is held back too');
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  assert.equal(lab.starts(), 1, 'one agent on the conversation');
}, {twin: true}));

test('an identified agent without a conversation id is not degraded to a shell', () => withLab(async lab => {
  const bare: Offer = {name: 'bare', created: ALPHA_CREATED + 9, agent_kind: 'claude', resume_id: null,
    cwd: path.join(lab.mesh.home, 'bare-dir')};
  const refused = await lab.exact(bare);
  assert.deepEqual([refused.json.ok, refused.json.code, refused.json.phase], [false, 'not-resumable', 'not-started']);
  assert.deepEqual(await lab.listed(), []);
  assert.ok(lab.snapshotLost().some(e => e.name === 'bare' && e.restoring === undefined), 'offer untouched, unmarked');
  const asShell = await lab.exact({...bare, agent_kind: 'shell'});
  assert.equal(asShell.json.code, 'expected-mismatch', 'a shell expectation does not match an agent offer');
}, {bare: true}));

test('an integer too large for a float in created is a 400', () => withLab(async lab => {
  const text = '{"names":["alpha"],"expected":' + JSON.stringify(lab.offers.alpha).replace('1700000000.25', '1' + '0'.repeat(400)) + '}';
  const refused = await lab.post(text);
  assert.equal(refused.status, 400, refused.text);
  assert.deepEqual(await lab.listed(), []);
}));

// ---- a host that is slow, refuses or fails around the creation (ptyhost-proxy-lib.ts)

const TIMEOUT = {timeout: 90000};

/** A host whose `new` of `name` is held (the server gives up after 5 s) until `release()`, then still creates it. */
function slowNew(name: string): {intercept: Intercept; release: () => void} {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {release: () => release(), intercept: request => request.op === 'new' && request.name === name ? {wait: gate} : undefined};
}

function marker(lab: Lab, offer: Offer): {nonce?: string; created?: number} | undefined {
  return lab.snapshotLost().find(entry => entry.name === offer.name)?.restoring;
}

async function uncertainThenResolved(lab: Lab, offer: Offer, release: () => void,
                                     whileUncertain: () => Promise<void> = async () => {}): Promise<void> {
  const first = await lab.exact(offer);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.json.ok, first.json.code, first.json.phase], [false, 'host-error', 'uncertain']);
  assert.match(marker(lab, offer)?.nonce ?? '', /^[0-9a-f]{32}$/, 'a timeout keeps the intent');

  await whileUncertain();
  const early = await lab.exact(offer);   // the host shows no such session yet
  assert.deepEqual([early.json.code, early.json.phase], ['restore-interrupted', 'uncertain']);
  assert.ok(marker(lab, offer), 'still marked');
  assert.equal((await lab.post({names: [offer.name]})).json.results[offer.name].error, RESTORING_REFUSAL);

  release();
  await waitFor('the delayed session appeared', 15000, async () => (await lab.listed()).some(s => s.name === offer.name));
  const page = await lab.post({names: [offer.name]});
  assert.deepEqual(page.json.results[offer.name], {ok: false, error: RESTORING_REFUSAL}, 'the page must not add a second shell');
  const done = await lab.exact(offer);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  const live = await lab.listed();
  assert.deepEqual(live.map(s => s.name), [offer.name], 'one session, no suffixed twin');
  assert.equal(done.json.created, live[0]!.created);
  assert.ok(!lab.snapshotLost().some(entry => entry.name === offer.name), 'the offer is gone');
}

test('a slow host (agent offer): timeout, then the page and the exact retries create one session', TIMEOUT, async () => {
  const slow = slowNew('alpha');
  await withLab(async lab => {
    const twin: Offer = {...lab.offers.alpha, name: 'twin', created: lab.offers.alpha.created + 5,
      cwd: lab.offers.alpha.cwd.replace('alpha-dir', 'twin-dir')};
    await uncertainThenResolved(lab, lab.offers.alpha, slow.release, async () => {
      assert.equal((await lab.exact(twin)).json.code, 'conversation-running', 'the conversation is held back');
      assert.equal(await lab.historyResume('claude', SID), 409, 'and so is a resume from the history');
      assert.deepEqual(await lab.listed(), []);
    });
    await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
    assert.equal(lab.starts(), 1, 'one agent on the conversation');
  }, {twin: true, intercept: slow.intercept});
});

test('a slow host (shell offer): timeout, then the page and the exact retries create one session', TIMEOUT, async () => {
  const slow = slowNew('bravo');
  await withLab(lab => uncertainThenResolved(lab, lab.offers.bravo, slow.release), {intercept: slow.intercept});
});

test('a refusal of the host is final: the intent is withdrawn and the same request then succeeds', TIMEOUT, async () => {
  let refusals = 1;
  await withLab(async lab => {
    const refused = await lab.exact(lab.offers.alpha);
    assert.equal(refused.status, 200, refused.text);
    assert.deepEqual([refused.json.code, refused.json.phase], ['launch-refused', 'not-started']);
    assert.equal(marker(lab, lab.offers.alpha), undefined, 'nothing can appear: no intent left');
    const done = await lab.exact(lab.offers.alpha);
    assert.equal(done.json.ok, true, done.text);
    assert.equal((await lab.listed()).length, 1);
  }, {intercept: request => request.op === 'new' && refusals-- > 0 ? {reply: {error: 'refused for the test'}} : undefined});
});

test('a failure of the snapshot after the creation is not announced as a success', TIMEOUT, async () => {
  let lab!: Lab;
  await withLab(async started => {
    lab = started;
    const failed = await lab.exact(lab.offers.alpha);   // the host creates the session, then the folder is read-only
    assert.equal(failed.status, 200, failed.text);
    assert.deepEqual([failed.json.ok, failed.json.code, failed.json.phase], [false, 'completion-failed', 'created']);
    assert.ok(lab.snapshotLost().some(entry => entry.name === 'alpha'), 'the file still offers it');
    lab.makeConfigReadOnly(false);
    const done = await lab.exact(lab.offers.alpha);
    assert.equal(done.json.ok, true, done.text);
    assert.equal((await lab.listed()).length, 1, 'no second shell');
    assert.deepEqual(lab.snapshotLost().map(entry => entry.name), ['bravo']);
  }, {intercept: request => {
    if (request.op === 'new') lab.makeConfigReadOnly(true);
  }});
});

test('a host that stops answering after the intent is an uncertain answer, never a 5xx', TIMEOUT, async () => {
  let created = false;
  let silent = true;
  const never = new Promise<void>(() => {});
  await withLab(async lab => {
    const first = await lab.exact(lab.offers.alpha);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual([first.json.code, first.json.phase], ['host-error', 'uncertain']);
    assert.equal((await lab.listed()).length, 1, 'the session was created');
    assert.ok(marker(lab, lab.offers.alpha));
    silent = false;
    const done = await lab.exact(lab.offers.alpha);
    assert.equal(done.json.ok, true, done.text);
    assert.equal((await lab.listed()).length, 1);
  }, {intercept: request => {
    if (request.op === 'new') created = true;
    else if (request.op === 'list' && created && silent) return {wait: never};
  }});
});

test('a resume from the history just started holds back the restore of that conversation', TIMEOUT, () => withLab(async lab => {
  lab.writeTranscript(SID, lab.offers.alpha.cwd);
  assert.equal(await lab.historyResume('claude', SID), 200);
  const refused = await lab.exact(lab.offers.alpha);
  assert.deepEqual([refused.json.ok, refused.json.code, refused.json.phase], [false, 'conversation-running', 'not-started']);
  assert.equal((await lab.post({names: ['alpha']})).json.results.alpha.ok, false);
  await waitFor('the fake agent started', 10000, () => lab.starts() >= 1);
  assert.equal(lab.starts(), 1, 'one agent on the conversation');
  assert.ok(lab.snapshotLost().some(entry => entry.name === 'alpha'), 'the offer is untouched');
}));
