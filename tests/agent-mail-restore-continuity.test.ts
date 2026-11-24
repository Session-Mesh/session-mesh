// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Agent mail across a host loss and a restoration: retention while a restore offer is valid,
// the exact old->new transfer, the start-up hold and the refusal of an ambiguous mapping.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {FAKE_HOST, runPython} from './helpers/mail-continuity-python.ts';

describe('retention of mail addressed to a vanished incarnation', () => {
  test('(a) another agent reading its inbox does not erase mail for an incarnation with a restore offer', () => {
    const result = runPython<{alice: number; carol: number}>(`
alice, bob, carol = ident('alice', 1.0), ident('bob', 3.0), ident('carol', 7.0)
seed([message(1, bob, alice), message(2, bob, carol)])
# the host was lost: the snapshot still lists alice as live (lost_at None), carol as lost just now
snapshot(live=[entry('alice', 1.0, '/tmp')], lost=[entry('carol', 7.0, '/tmp', lost_at=time.time())])
agentmail.inbox(bob, [bob])
msgs = stored()['messages']
out({'alice': sum(m['target'] == alice for m in msgs), 'carol': sum(m['target'] == carol for m in msgs)})
`);
    assert.deepEqual(result, {alice: 1, carol: 1});
  });

  test('(a2) mail for an incarnation with no offer is still pruned', () => {
    const left = runPython<number>(`
alice, bob = ident('alice', 1.0), ident('bob', 3.0)
seed([message(1, bob, alice)])
snapshot()
agentmail.inbox(bob, [bob])
out(len(stored()['messages']))
`);
    assert.equal(left, 0);
  });

  test('(c) once the retention of a lost entry has ended the normal purge resumes; a live entry never expires', () => {
    const result = runPython<{inside: number; lost: number; live: number}>(`
alice, bob = ident('alice', 1.0), ident('bob', 3.0)
def left(**kw):
    seed([message(1, bob, alice)])
    snapshot(**kw)
    if kw.get('mtime') is not None:
        os.utime(respawn.FILE, (kw['mtime'], kw['mtime']))
    agentmail.inbox(bob, [bob])
    return len(stored()['messages'])
now = time.time()
day = respawn.MAIL_RETENTION_SECONDS
assert day == 24 * 3600
inside = left(lost=[entry('alice', 1.0, '/tmp', lost_at=now - day + 600)])
lost = left(lost=[entry('alice', 1.0, '/tmp', lost_at=now - day - 600)])
# a live entry does not expire by the age of the snapshot file: update() dates its loss
seed([message(1, bob, alice)])
snapshot(live=[entry('alice', 1.0, '/tmp')])
os.utime(respawn.FILE, (now - day - 600, now - day - 600))
agentmail.inbox(bob, [bob])
out({'inside': inside, 'lost': lost, 'live': len(stored()['messages'])})
`);
    assert.deepEqual(result, {inside: 1, lost: 0, live: 1});
  });

  test('(d) nothing is pruned while start-up holds it, or while the offers cannot be read', () => {
    const result = runPython<Record<string, number>>(`
alice, bob = ident('alice', 1.0), ident('bob', 3.0)
res = {}
seed([message(1, bob, alice)])
snapshot()   # no offer at all: normal pruning would delete the message
agentmail.hold_pruning()
agentmail.inbox(bob, [bob])          # the web server has not read the PTY list yet
res['held'] = len(stored()['messages'])
agentmail.release_pruning()
respawn.FILE.write_text('{not json')  # offers unreadable: in doubt, keep
agentmail.inbox(bob, [bob])
res['unreadable'] = len(stored()['messages'])
snapshot()
agentmail.inbox(bob, [bob])
res['released'] = len(stored()['messages'])
out(res)
`);
    assert.deepEqual(result, {held: 1, unreadable: 1, released: 0});
  });

  test('(d2) the first successful snapshot of the web server releases the hold', () => {
    const result = runPython<{during: number; after: number}>(`
${FAKE_HOST}
import tempfile
alice, bob = ident('alice', 1.0), ident('bob', 3.0)
seed([message(1, bob, alice)])
agentmail.hold_pruning()
install(FakeHost([live_session('bob', 3.0)]))
agentmail.inbox(bob, [bob])
during = len(stored()['messages'])
asyncio.run(server.sessions())
agentmail.inbox(bob, [bob])
out({'during': during, 'after': len(stored()['messages'])})
`);
    assert.deepEqual(result, {during: 1, after: 0});
  });
});

describe('transfer to the restored incarnation', () => {
  const restoreScenario = `
${FAKE_HOST}
import tempfile
cwd = tempfile.mkdtemp()
alice, bob, carol = ident('alice', 1.0), ident('bob', 3.0), ident('carol', 7.0)
mid = message(1, bob, alice)['id']
def mail():
    return [message(1, bob, alice), message(2, bob, carol)]
policy = [{'id': 'e' * 32, 'source': alice, 'target': bob, 'created': 6.0}]
wake = [{'notification_id': 'c' * 32, 'target': alice, 'from_seq': 1, 'through_seq': 1, 'count': 1,
         'seqs': [1], 'state': 'pending'}]
request = [{'id': 'd' * 32, 'message_id': mid, 'source': bob, 'target': alice, 'created': 5.0, 'state': 'granted'}]
`;

  test('(b) a restored session reads the mail of its old incarnation and keeps its policies', () => {
    const result = runPython<Record<string, unknown>>(`
${restoreScenario}
seed(mail(), wake, request, policy)
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time()), entry('carol', 7.0, cwd, lost_at=time.time())])
fake = FakeHost([live_session('bob', 3.0)])
install(fake)
result = asyncio.run(restore('alice'))
new = ident('alice', 5001.0)
live = [ident('bob', 3.0), new]
inbox = agentmail.inbox(new, live)
agentmail.inbox(ident('bob', 3.0), live)          # a later prune by someone else
state = stored()
out({'result': result, 'inbox': [m['id'] for m in inbox], 'wake': state['wakes'][0]['target'],
     'request': state['consent_requests'][0]['target'], 'policy': state['always_policies'][0]['source'],
     'sender': state['messages'][0]['source'], 'again': agentmail.transfer_incarnation(alice, new)})
`);
    assert.deepEqual(result.result, {ok: true, id: 'alice', resumed: true});
    assert.equal((result.inbox as string[]).length, 1);
    assert.deepEqual(result.wake, {id: 'alice', created: 5001.0, agent: 'claude'});
    assert.deepEqual(result.request, {id: 'alice', created: 5001.0, agent: 'claude'});
    assert.deepEqual(result.policy, {id: 'alice', created: 5001.0, agent: 'claude'});
    assert.deepEqual(result.sender, {id: 'bob', created: 3.0, agent: 'claude'});
    assert.equal(result.again, false);   // idempotent: nothing left to move
  });

  test('(e) partial restore: the restored session gets its mail, the other offer keeps its own', () => {
    const result = runPython<Record<string, unknown>>(`
${restoreScenario}
seed(mail())
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time()), entry('carol', 7.0, cwd, sid=SID2, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
asyncio.run(restore('alice'))
new = ident('alice', 5001.0)
agentmail.inbox(ident('bob', 3.0), [ident('bob', 3.0), new])
targets = {m['id'][-1]: m['target'] for m in stored()['messages']}
out(targets)
`);
    assert.deepEqual(result['1'], {id: 'alice', created: 5001.0, agent: 'claude'});
    assert.deepEqual(result['2'], {id: 'carol', created: 7.0, agent: 'claude'});
  });

  test('(f) a mapping that is not exact transfers nothing', () => {
    const result = runPython<Record<string, unknown>>(`
${restoreScenario}
seed(mail())
off = entry('alice', 1.0, cwd)
def attempt(listed, nonce=None):
    warning = asyncio.run(server._transfer_restored_mail(off, 'alice', listed, nonce))
    return [warning is not None, [m['target']['created'] for m in stored()['messages'] if m['id'] == mid]]
res = {}
res['other_nonce'] = attempt([live_session('alice', 9.0, nonce='n2')], 'n1')
res['other_agent'] = attempt([live_session('alice', 9.0, agent='codex')])
res['same_incarnation'] = attempt([live_session('alice', 1.0)])
res['same_name_twice'] = attempt([live_session('alice', 9.0), live_session('alice', 10.0)])
res['absent'] = attempt([live_session('bob', 3.0)])
off['agent']['session_id'] = None     # restarted as a plain shell: no conversation to continue
res['not_resumable'] = attempt([live_session('alice', 9.0)])
off['agent']['session_id'] = SID
res['exact'] = attempt([live_session('alice', 9.0, nonce='n1')], 'n1')
try:
    agentmail.transfer_incarnation(alice, ident('alice', 9.0, 'codex'))
    res['kind_mismatch'] = 'accepted'
except agentmail.MailInvalidRequest:
    res['kind_mismatch'] = 'refused'
out(res)
`);
    for (const key of ['other_nonce', 'other_agent', 'same_incarnation', 'same_name_twice', 'absent']) {
      assert.deepEqual(result[key], [true, [1.0]], key);
    }
    assert.deepEqual(result.not_resumable, [false, [1.0]]);
    assert.deepEqual(result.exact, [false, [9.0]]);
    assert.equal(result.kind_mismatch, 'refused');
  });

  test('(f2) the transfer moves one exact incarnation, never every incarnation of the name', () => {
    const result = runPython<number[]>(`
${restoreScenario}
other = ident('alice', 4.0)    # same name, another incarnation: not the offered one
seed([message(1, bob, alice), message(2, bob, other)])
agentmail.transfer_incarnation(alice, ident('alice', 9.0))
out([m['target']['created'] for m in stored()['messages']])
`);
    assert.deepEqual(result, [9.0, 4.0]);
  });

  test('a restore that cannot be exact, or lands under another name, says so in its result', () => {
    const result = runPython<Record<string, unknown>>(`
${restoreScenario}
seed(mail())
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
install(FakeHost([live_session('alice', 8.0, agent=None)]))   # the name is taken by another session
result = asyncio.run(restore('alice'))
new = ident(result['id'], 5001.0)
agentmail.inbox(ident('bob', 3.0), [ident('bob', 3.0), new])
out({'result': result, 'target': stored()['messages'][0]['target']})
`);
    const outcome = result.result as {ok: boolean; id: string; warnings: string[]};
    assert.equal(outcome.ok, true);
    assert.notEqual(outcome.id, 'alice');
    assert.deepEqual(outcome.warnings, [`restored under another name: ${outcome.id}`]);
    assert.equal((result.target as {id: string}).id, outcome.id);   // exact mapping despite the new name
  });
});
