// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The decision behind copy on select (static/terminal-links.ts): when a settled selection goes to
// the clipboard, and what the stored preference means.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {
  COPY_ON_SELECT_KEY, COPY_ON_SELECT_MULTI_CLICK_MS, type CopyOnSelectState, copyOnSelectDelay, copyOnSelectEnabled,
  forcesSelection, shouldCopyOnSelect,
} from '../static/terminal-links.ts';

const base: CopyOnSelectState = {enabled: true, selection: 'text', visible: true, mouseTracking: false, forced: false};
const decide = (change: Partial<CopyOnSelectState>) => shouldCopyOnSelect({...base, ...change});

describe('copy on select', () => {
  test('is on unless the stored value is exactly false', () => {
    assert.equal(COPY_ON_SELECT_KEY, 'copyOnSelect');
    for (const stored of [undefined, null, true, 'false', 0, {}]) assert.equal(copyOnSelectEnabled(stored), true);
    assert.equal(copyOnSelectEnabled(false), false);
  });

  test('copies a non-empty selection', () => assert.equal(decide({}), true));

  test('does nothing when turned off', () => assert.equal(decide({enabled: false}), false));

  test('never copies an empty or blank selection', () => {
    assert.equal(decide({selection: ''}), false);
    assert.equal(decide({selection: ' \n\t'}), false);
  });

  test('never copies from a hidden pane', () => assert.equal(decide({visible: false}), false));

  test('while the program tracks the mouse, only a forced selection is copied', () => {
    assert.equal(decide({mouseTracking: true}), false);
    assert.equal(decide({mouseTracking: true, forced: true}), true);
    assert.equal(decide({mouseTracking: false, forced: true}), true);
  });
});

describe('forced selection, by the platform', () => {
  const keys = (shiftKey: boolean, altKey: boolean) => ({shiftKey, altKey});

  test('on Linux and Windows only Shift forces a selection', () => {
    assert.equal(forcesSelection(keys(true, false), 'other'), true);
    assert.equal(forcesSelection(keys(false, true), 'other'), false);
    assert.equal(forcesSelection(keys(false, false), 'other'), false);
  });

  test('on macOS only Option forces a selection', () => {
    assert.equal(forcesSelection(keys(false, true), 'mac'), true);
    assert.equal(forcesSelection(keys(true, false), 'mac'), false);
    assert.equal(forcesSelection(keys(false, false), 'mac'), false);
  });
});

describe('copy on select timing', () => {
  test('only a double click waits, so a triple click writes the clipboard once', () => {
    assert.equal(copyOnSelectDelay(1), 0);
    assert.equal(copyOnSelectDelay(2), COPY_ON_SELECT_MULTI_CLICK_MS);
    assert.equal(copyOnSelectDelay(3), 0);
  });
});
