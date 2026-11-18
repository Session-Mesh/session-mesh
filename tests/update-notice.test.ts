// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The update banner's logic (static/update-notice.ts): what the page accepts from the server, the
// release order, and the per-release dismissal kept in a storage that may be missing or throw.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {DISMISSED_KEY, compareTags, dismiss, forgetDismissals, parseNotice, shouldShow} from '../static/update-notice.ts';

const NOTES = 'https://github.com/Session-Mesh/session-mesh/releases/tag/';
const answer = (latest: string, extra: Record<string, unknown> = {}) => ({
  status: 'available', current: 'v0.1.0', latest, security: false, notes_url: NOTES + latest,
  upgrade_command: '~/.local/share/session-mesh/current/install.sh --upgrade', line: 'x', ...extra,
});

function memory() {
  const items = new Map<string, string>();
  return {getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }};
}
const broken = {getItem(): string | null { throw new Error('blocked'); }, setItem(): void { throw new Error('blocked'); }};

describe('update notice', () => {
  beforeEach(forgetDismissals);

  test('accepts only an available answer with a matching release-notes link', () => {
    assert.deepEqual(parseNotice(answer('v0.2.0')), {
      latest: 'v0.2.0', security: false, notesUrl: NOTES + 'v0.2.0',
      upgradeCommand: '~/.local/share/session-mesh/current/install.sh --upgrade'});
    for (const bad of [null, undefined, 'x', answer('v0.2.0', {status: 'current'}), answer('v0.2.0-rc.1'),
      answer('v0.2.0', {notes_url: 'https://example.invalid/'}), answer('v0.2.0', {notes_url: NOTES + 'v0.3.0'}),
      answer('v0.2.0', {security: 'yes'}), answer('v0.2.0', {upgrade_command: 7})]) {
      assert.equal(parseNotice(bad), null, JSON.stringify(bad));
    }
  });

  test('orders release tags as versions', () => {
    assert.ok(compareTags('v0.10.0', 'v0.9.0') > 0);
    assert.ok(compareTags('v1.0.0', 'v0.99.99') > 0);
    assert.equal(compareTags('v0.1.0', 'v0.1.0'), 0);
    assert.ok(Number.isNaN(compareTags('', 'v0.1.0')));
  });

  test('a dismissal holds for that release and older ones, not for a newer one', () => {
    const store = memory();
    const first = parseNotice(answer('v0.2.0'))!;
    assert.equal(shouldShow(first, store), true);
    dismiss(first, store);
    assert.equal(store.getItem(DISMISSED_KEY), 'v0.2.0');
    assert.equal(shouldShow(first, store), false);
    assert.equal(shouldShow(parseNotice(answer('v0.1.5'))!, store), false);
    assert.equal(shouldShow(parseNotice(answer('v0.2.1'))!, store), true);
  });

  test('a storage that throws or is missing still shows the banner', () => {
    const notice = parseNotice(answer('v0.2.0'))!;
    assert.equal(shouldShow(notice, broken), true);
    assert.equal(shouldShow(notice, null), true);
    assert.doesNotThrow(() => dismiss(notice, broken));
    assert.doesNotThrow(() => dismiss(notice, null));
  });

  test('without a usable storage a closed banner stays closed at the next poll, for that release only', () => {
    const notice = parseNotice(answer('v0.2.0'))!;
    for (const store of [broken, null]) {
      forgetDismissals();
      dismiss(notice, store);
      assert.equal(shouldShow(notice, store), false, 'the poll after closing');
      assert.equal(shouldShow(parseNotice(answer('v0.1.9'))!, store), false);
      assert.equal(shouldShow(parseNotice(answer('v0.2.1'))!, store), true, 'a newer release comes back');
    }
    forgetDismissals();   // a reload forgets it
    assert.equal(shouldShow(notice, null), true);
  });
});
