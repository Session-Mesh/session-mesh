// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Agent mail across the exact (guarded) restore, and across the first listing after a host loss.
// server.restore_exact against an in-memory PTY host and the real agentmail and respawn modules:
// the mail of the offered incarnation moves to the new one before the offer ends; a failed transfer
// leaves the offer and the intent (phase created) and the retry completes it; no purge slips in
// between the loss and the transfer.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {FAKE_HOST, runPython} from './helpers/mail-continuity-python.ts';

const SCENARIO = `
${FAKE_HOST}
import tempfile
cwd = tempfile.mkdtemp()
alice, bob, carol = ident('alice', 1.0), ident('bob', 3.0), ident('carol', 7.0)
mid = message(1, bob, alice)['id']
mail = [message(1, bob, alice), message(2, bob, carol)]
policy = [{'id': 'e' * 32, 'source': alice, 'target': bob, 'created': 6.0}]
wake = [{'notification_id': 'c' * 32, 'target': alice, 'from_seq': 1, 'through_seq': 1, 'count': 1,
         'seqs': [1], 'state': 'pending'}]
request = [{'id': 'd' * 32, 'message_id': mid, 'source': bob, 'target': alice, 'created': 5.0, 'state': 'granted'}]

async def exact(name='alice', created=1.0, sid=SID):
    app = {'restore_lock': asyncio.Lock(), 'organisation_lock': asyncio.Lock(), 'recent_conversations': {}}
    expected = {'name': name, 'created': created, 'agent_kind': 'claude', 'resume_id': sid, 'cwd': cwd}
    return await server.restore_exact(app, expected)

def offers():
    return [e['name'] for e in respawn.public(respawn._load()['lost'])]
`;

describe('the exact restore carries the mail of the offered incarnation', () => {
  test('messages, wakes, consents and policies move to the new incarnation; the offer ends', () => {
    const result = runPython<Record<string, any>>(`
${SCENARIO}
seed(mail, wake, request, policy)
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time()), entry('carol', 7.0, cwd, sid=SID2, lost_at=time.time())])
install(FakeHost([live_session('bob', 3.0)]))
res = asyncio.run(exact())
state = stored()
out({'res': res, 'targets': {m['id'][-1]: m['target'] for m in state['messages']}, 'wake': state['wakes'][0]['target'],
     'request': state['consent_requests'][0]['target'], 'policy': state['always_policies'][0]['source'],
     'offers': offers()})
`);
    const moved = {id: 'alice', created: 5001.0, agent: 'claude'};
    assert.equal(result.res.ok, true, JSON.stringify(result.res));
    assert.equal(result.res.guarded, true);
    assert.equal(result.res.created, 5001.0);
    assert.deepEqual(result.targets['1'], moved);
    assert.deepEqual(result.targets['2'], {id: 'carol', created: 7.0, agent: 'claude'}, 'the other offer keeps its mail');
    assert.deepEqual(result.wake, moved);
    assert.deepEqual(result.request, moved);
    assert.deepEqual(result.policy, moved);
    assert.deepEqual(result.offers, ['carol']);
  });

  test('a transfer that fails leaves the offer and the intent (created); the retry completes it', () => {
    const result = runPython<Record<string, any>>(`
${SCENARIO}
seed(mail, wake, request, policy)
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
fake = FakeHost([live_session('bob', 3.0)])
install(fake)
real = agentmail.transfer_incarnation
def boom(old, new):
    raise agentmail.MailStorageError('Could not save agent messages')
agentmail.transfer_incarnation = boom
first = asyncio.run(exact())
kept = respawn._load()['lost']
agentmail.inbox(bob, [bob, ident('alice', 5001.0)])         # a later prune by someone else
left = [m['target'] for m in stored()['messages'] if m['id'] == mid]
agentmail.transfer_incarnation = real
second = asyncio.run(exact())
out({'first': first, 'marker': kept[0].get('restoring') if kept else None, 'offered_after_failure': len(kept),
     'left': left, 'second': second, 'offers': offers(), 'news': len(fake.new_requests),
     'target': [m['target'] for m in stored()['messages'] if m['id'] == mid]})
`);
    assert.deepEqual([result.first.ok, result.first.code, result.first.phase, result.first.id],
      [false, 'completion-failed', 'created', 'alice'], JSON.stringify(result.first));
    assert.match(result.marker.nonce, /^[0-9a-f]{32}$/, 'the intent stays');
    assert.equal(result.offered_after_failure, 1, 'the offer stays');
    assert.deepEqual(result.left, [{id: 'alice', created: 1.0, agent: 'claude'}], 'the mail waits for the old identity');
    assert.equal(result.second.ok, true, JSON.stringify(result.second));
    assert.deepEqual(result.offers, []);
    assert.equal(result.news, 1, 'the retry created no second session');
    assert.deepEqual(result.target, [{id: 'alice', created: 5001.0, agent: 'claude'}]);
  });

  test('the transfer wants the nonce of the marker: a session of that name with another nonce is not the one', () => {
    const result = runPython<Record<string, any>>(`
${SCENARIO}
seed(mail)
snapshot(lost=[entry('alice', 1.0, cwd, lost_at=time.time())])
fake = FakeHost([live_session('bob', 3.0)])
install(fake)
seen = {}
real = server._transfer_restored_mail
async def spy(entry, name, listed, expected_nonce=None, notes=None):
    seen['nonce'] = expected_nonce
    return await real(entry, name, listed, expected_nonce=expected_nonce, notes=notes)
server._transfer_restored_mail = spy
res = asyncio.run(exact())
metas = [s['meta']['nonce'] for s in fake.sessions if s['name'] == 'alice']
out({'ok': res['ok'], 'nonce': seen.get('nonce'), 'metas': metas})
`);
    assert.equal(result.ok, true);
    assert.match(result.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual(result.metas, [result.nonce], 'the nonce of the marker is the one of the session');
  });
});

describe('a purge cannot slip in between the host loss and the transfer', () => {
  test('mail read-pruned before and after the first listing survives to the restoration', () => {
    const result = runPython<Record<string, any>>(`
${SCENARIO}
seed([message(1, bob, alice)])
snapshot(live=[entry('alice', 1.0, cwd)])                    # alice was live before the host was lost
agentmail.hold_pruning()                                      # a web server just started
install(FakeHost([live_session('bob', 3.0)]))                # the new host knows no alice
agentmail.inbox(bob, [bob])                                   # an agent reads its inbox before the first GET sessions
before = len(stored()['messages'])
asyncio.run(server.sessions())                                # the first GET: alice becomes an offer, the hold is lifted
agentmail.inbox(bob, [bob])                                   # the purge that runs next
after = len(stored()['messages'])
res = asyncio.run(exact())
out({'before': before, 'after': after, 'res': res, 'target': [m['target'] for m in stored()['messages']]})
`);
    assert.equal(result.before, 1, 'held until the offers are on disk');
    assert.equal(result.after, 1, 'kept for the offer once the hold is lifted');
    assert.equal(result.res.ok, true, JSON.stringify(result.res));
    assert.deepEqual(result.target, [{id: 'alice', created: 5001.0, agent: 'claude'}]);
  });
});
