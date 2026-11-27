// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {switchSource, switchTargets, sameSwitchSource} from '../static/account-switch-picker.ts';

const revision = 'a'.repeat(64);
const source = {kind: 'mesh', id: 'one', created: 123, account: 'work', account_context_revision: revision,
  switch_qualified: true,
  agent: {type: 'codex', status: 'idle', foreground: true, pid: 77, started: 100,
    session_id: '11111111-1111-1111-1111-111111111111'}};
const profiles = [
  {backend: 'codex', id: 'work', label: 'Work', context_revision: revision, enabled: true, switch_qualified: true},
  {backend: 'codex', id: 'other', label: 'Other', context_revision: 'b'.repeat(64), enabled: true, switch_qualified: true},
  {backend: 'claude', id: 'other', label: 'Claude', context_revision: 'c'.repeat(64), enabled: true, switch_qualified: true},
  {backend: 'codex', id: 'disabled', label: 'Disabled', context_revision: revision, enabled: false, switch_qualified: true},
  {backend: 'codex', id: 'managed', label: 'Managed', context_revision: revision, enabled: true, switch_qualified: true, managed: true},
];

test('only exact, idle, revision-bound live Claude/Codex sessions expose a switch', () => {
  assert.ok(switchSource(source, true));
  for (const changed of [{kind: 'history'}, {created: null}, {switch_qualified: false},
    {agent: {...source.agent, status: 'busy'}},
    {agent: {...source.agent, foreground: false}},
    {agent: {...source.agent, pid: null}},
    {agent: {...source.agent, type: 'pi'}}, {agent: {...source.agent, session_id: null}},
    {account_context_revision: null}]) {
    assert.equal(switchSource({...source, ...changed}, true), null);
  }
  assert.equal(switchSource(source, false), null);
  assert.deepEqual(switchTargets(switchSource(source, true)!, profiles).map(p => p.id), ['other']);
  assert.deepEqual(switchTargets(switchSource(source, true)!, [
    ...profiles, {backend: 'codex', id: 'collision', label: 'other',
      context_revision: revision, enabled: false, switch_qualified: false}]).map(p => p.id), [],
    'an id that also names another profile label is ambiguous in the native resolver');
  assert.equal(sameSwitchSource(switchSource(source, true)!, {...source, account: 'other'}), false);
  assert.equal(sameSwitchSource(switchSource(source, true)!, {...source, agent: {...source.agent, status: 'busy'}}), false);
});

test('a bound default session can offer only qualified named profiles', () => {
  assert.equal(switchSource({...source, account: null, account_context_revision: undefined,
    default_context_revision: undefined}, true), null);
  const current = switchSource({...source, account: null, account_context_revision: undefined,
    default_context_revision: revision}, true);
  assert.ok(current);
  assert.deepEqual(switchTargets(current!, profiles).map(p => p.id), ['work', 'other']);
});
