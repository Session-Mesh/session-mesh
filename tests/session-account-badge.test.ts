// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const accountLabel =');
const end = source.indexOf('\nfunction ', source.indexOf('\nfunction showAccountBadge', start) + 1);
assert.ok(start >= 0 && end > start, 'account badge functions exist');
const sandbox: any = {
  t: (key: string, vars?: {label: string}) => ({
    'list.accountDefault': 'Mesh default',
    'list.accountDefaultTitle': 'No alias recorded; login unverified.',
    'list.accountTitle': `Account: ${vars?.label}`,
  } as Record<string, string>)[key],
  esc: (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.badge = accountBadgeHtml; globalThis.show = showAccountBadge;`, sandbox);

test('default alias badge applies only to Mesh Claude or Codex sessions', () => {
  for (const session of [{kind: 'mesh', agent: {type: 'codex'}}, {kind: 'mesh', known_agent: 'claude'}]) {
    assert.match(sandbox.badge(session), />Mesh default<\/span>/);
    assert.match(sandbox.badge(session), /login unverified/);
    const pane = {hidden: true, textContent: '', title: ''};
    sandbox.show(pane, session);
    assert.deepEqual(pane, {hidden: false, textContent: 'Mesh default', title: 'No alias recorded; login unverified.'});
  }
  for (const session of [{kind: 'external', agent: {type: 'codex'}}, {kind: 'mesh'},
    {kind: 'mesh', agent: {type: 'pi'}}, {kind: 'mesh', agent: {type: 'codex'}, account: 42}]) {
    assert.equal(sandbox.badge(session), '');
  }
});

test('named aliases retain labels and escape markup in list and pane', () => {
  const session = {kind: 'mesh', agent: {type: 'codex'}, account: 'work', account_label: '<Work>'};
  assert.match(sandbox.badge(session), /&lt;Work>/);
  assert.doesNotMatch(sandbox.badge(session), /<Work>/);
  const pane = {hidden: true, textContent: '', title: ''};
  sandbox.show(pane, session);
  assert.equal(pane.textContent, '<Work>');
  assert.equal(pane.title, 'Account: <Work>');
});
