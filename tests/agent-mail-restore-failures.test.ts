// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Agent mail across a restoration, failure and ordering cases: a failed transfer keeps the offer
// and the mail, retained wakes survive a prune, the pruning hold is lifted only by a written
// snapshot, concurrent transfers serialise on the mail lock, and an expired retention is told.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {FAKE_HOST, runPython} from './helpers/mail-continuity-python.ts';

const SCENARIO = `
${FAKE_HOST}
import tempfile, threading
cwd = tempfile.mkdtemp()
alice, bob = ident('alice', 1.0), ident('bob', 3.0)
`;

describe('a transfer that fails keeps the offer and the mail', () => {
  test('(M1) MailStorageError: offer kept, warning shown, mail not purged by a later inbox', () => {
    const result = runPython<Record<string, unknown>>(`
${SCENARIO}
seed([message(1, bob, alice)])
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
def boom(old, new):
    raise agentmail.MailStorageError('Could not save agent messages')
agentmail.transfer_incarnation = boom
res = asyncio.run(restore('alice'))
new = ident('alice', 5001.0)
agentmail.inbox(bob, [bob, new])
out({'result': res, 'left': [m['target'] for m in stored()['messages']],
     'offered': [e['name'] for e in respawn.public(respawn._load()['lost'])],
     'retained': respawn.mail_offers()})
`);
    const outcome = result.result as {ok: boolean; id: string; warnings: string[]};
    assert.equal(outcome.ok, true);
    assert.equal(outcome.id, 'alice');   // the session exists: the restoration is partial
    assert.match(outcome.warnings[0], /agent mail not transferred/);
    assert.deepEqual(result.left, [{id: 'alice', created: 1.0, agent: 'claude'}]);
    assert.deepEqual(result.offered, ['alice']);
    assert.deepEqual(result.retained, [{id: 'alice', created: 1.0, agent: 'claude'}]);
  });

  test('(M1b) a mapping that is not exact also keeps the offer', () => {
    const offered = runPython<string[]>(`
${SCENARIO}
seed([message(1, bob, alice)])
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
real = server._transfer_restored_mail
async def inexact(entry, new, listed, expected_nonce=None, notes=None):
    return 'agent mail not transferred (kept for the old identity): not exact'
server._transfer_restored_mail = inexact
asyncio.run(restore('alice'))
out([e['name'] for e in respawn.public(respawn._load()['lost'])])
`);
    assert.deepEqual(offered, ['alice']);
  });

  test('a restoration whose transfer succeeds ends the offer', () => {
    const offered = runPython<string[]>(`
${SCENARIO}
seed([message(1, bob, alice)])
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
asyncio.run(restore('alice'))
out([e['name'] for e in respawn.public(respawn._load()['lost'])])
`);
    assert.deepEqual(offered, []);
  });
});

describe('retained wakes and the pruning hold', () => {
  test('(m8) a prune during the retention keeps the wake: the restored agent claims it', () => {
    const result = runPython<Record<string, unknown>>(`
${SCENARIO}
wake = {'notification_id': 'c' * 32, 'target': alice, 'from_seq': 1, 'through_seq': 1, 'count': 1, 'state': 'pending'}
seed([message(1, bob, alice)], [wake])
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
agentmail.inbox(bob, [bob])                  # someone else prunes while alice is gone
kept = len(stored()['wakes'])
asyncio.run(restore('alice'))
new = ident('alice', 5001.0)
claimed = agentmail.claim_wake(new, [bob, new])
out({'kept': kept, 'claimed': claimed and {'state': claimed['state'], 'count': claimed['count']}})
`);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.claimed, {state: 'claimed', count: 1});
  });

  test('(m3) a snapshot that could not be written does not lift the hold', () => {
    const result = runPython<Record<string, number>>(`
${SCENARIO}
import fsutil
seed([message(1, bob, alice)])
# an offer older than KEEP_SECONDS is dropped by the first update: the snapshot has to be rewritten
snapshot(lost=[entry('old', 2.0, cwd, lost_at=time.time() - respawn.KEEP_SECONDS - 60)])
agentmail.hold_pruning()
install(FakeHost([live_session('bob', 3.0)]))
real = fsutil.atomic_write
def refuse(path, *args, **kwargs):
    if path == respawn.FILE:           # only the snapshot of the offers is unwritable
        raise OSError('read-only')
    return real(path, *args, **kwargs)
fsutil.atomic_write = refuse
asyncio.run(server.sessions())          # the offers could not be written
agentmail.inbox(bob, [bob])
res = {'failed': len(stored()['messages'])}
fsutil.atomic_write = real
asyncio.run(server.sessions())
agentmail.inbox(bob, [bob])
res['written'] = len(stored()['messages'])
out(res)
`);
    assert.deepEqual(result, {failed: 1, written: 0});
  });

  test('(m10) the hold is lifted after the update, not before it', () => {
    const order = runPython<string[]>(`
${SCENARIO}
calls = []
real_record, real_release = respawn.record, agentmail.release_pruning
def record(*args, **kwargs):
    calls.append('record')
    return real_record(*args, **kwargs)
def release():
    calls.append('release')
    real_release()
respawn.record, agentmail.release_pruning = record, release
install(FakeHost([live_session('bob', 3.0)]))
asyncio.run(server.sessions())
out(calls)
`);
    assert.deepEqual(order, ['record', 'release']);
  });

  test('the hold stays when ptyhost did not answer', () => {
    const held = runPython<number>(`
${SCENARIO}
seed([message(1, bob, alice)])
agentmail.hold_pruning()
class Down(FakeHost):
    async def request(self, req):
        raise OSError('gone')
install(Down())
asyncio.run(server.sessions())
agentmail.inbox(bob, [bob])
out(len(stored()['messages']))
`);
    assert.equal(held, 1);
  });
});

describe('the transfer is serialised on the mail lock', () => {
  test('(m6) two concurrent transfers wait for the lock and the first one wins', () => {
    const result = runPython<Record<string, unknown>>(`
${SCENARIO}
seed([message(1, bob, alice), message(2, bob, alice)])
done = []
moved = {}
def run(tag, created):
    moved[tag] = agentmail.transfer_incarnation(alice, ident('alice', created))
    done.append(tag)
threads = [threading.Thread(target=run, args=('a', 8.0)), threading.Thread(target=run, args=('b', 9.0))]
with agentmail._locked():
    for t in threads:
        t.start()
    time.sleep(0.5)
    during = list(done)            # no transfer may complete while the lock is held
for t in threads:
    t.join()
targets = {m['target']['created'] for m in stored()['messages']}
out({'during': during, 'moved': sorted(moved.values()), 'single_target': len(targets) == 1})
`);
    assert.deepEqual(result.during, []);
    assert.deepEqual(result.moved, [false, true]);   // the loser finds nothing addressed to the old incarnation
    assert.equal(result.single_target, true);
  });
});

describe('retention that ended before the restoration', () => {
  test('(B4) no mail left after the retention: the result says "mail expired", the restoration succeeds', () => {
    const result = runPython<Record<string, unknown>>(`
${SCENARIO}
seed([])
old = time.time() - respawn.MAIL_RETENTION_SECONDS - 3600
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=old)])
install(FakeHost([live_session('bob', 3.0)]))
res = asyncio.run(restore('alice'))
out({'res': res, 'offered': [e['name'] for e in respawn.public(respawn._load()['lost'])]})
`);
    const outcome = result.res as {ok: boolean; warnings: string[]};
    assert.equal(outcome.ok, true);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /^mail expired/);
    assert.deepEqual(result.offered, []);
  });

  test('inside the retention, or when mail was found, no such warning', () => {
    const result = runPython<Record<string, unknown>>(`
${SCENARIO}
seed([message(1, bob, alice)])
old = time.time() - respawn.MAIL_RETENTION_SECONDS - 3600
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=old)])
install(FakeHost([live_session('bob', 3.0)]))
res = asyncio.run(restore('alice'))      # mail still there although old: moved, nothing to report
out(res)
`);
    assert.deepEqual(result, {ok: true, id: 'alice', resumed: true});
  });
});
