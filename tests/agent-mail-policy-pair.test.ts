// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A transfer of mail to a restored incarnation can bring a (source, target) pair that already holds a permanent
// permission (the new incarnation was granted before the transfer): the pair then keeps one permission, the oldest,
// so a later revoke ends the pair's permission instead of leaving a twin. Not an elevation either way.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runPython} from './helpers/mail-continuity-python.ts';

test('a transfer onto a pair that already has a permission leaves one permission for the pair, the oldest', () => {
  const result = runPython<{policies: {id: string; created: number}[]; others: number; again: boolean}>(`
alice, bob, carol = ident('alice', 1.0), ident('bob', 3.0), ident('carol', 7.0)
new = ident('alice', 5001.0)
def policy(n, source, target, created):
    return {'id': format(n, 'x').rjust(32, 'c'), 'source': source, 'target': target, 'created': created}
seed([message(1, bob, alice)], policies=[
    policy(1, bob, alice, 10.0),    # the old incarnation's permission
    policy(2, bob, new, 20.0),      # the new one was granted since
    policy(3, carol, new, 30.0),    # another pair: untouched
])
moved = agentmail.transfer_incarnation(alice, new)
state = stored()
pair = [p for p in state['always_policies'] if p['source'] == bob and p['target'] == new]
out({'policies': [{'id': p['id'], 'created': p['created']} for p in pair],
     'others': len([p for p in state['always_policies'] if p['source'] == carol]),
     'again': agentmail.transfer_incarnation(alice, new)})
`);
  assert.deepEqual(result.policies, [{id: '1'.padStart(32, 'c'), created: 10.0}]);
  assert.equal(result.others, 1);
  assert.equal(result.again, false);
});
