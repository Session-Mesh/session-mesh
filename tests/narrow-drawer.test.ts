// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Which window resizes close the narrow layout's sidebar: a change of width does, a change of
// height alone (a phone's soft keyboard, its browser toolbar) does not.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {drawerClosesOnResize} from '../static/narrow-drawer.ts';

test('a height-only resize keeps the drawer', () => {
  assert.equal(drawerClosesOnResize(390, 390), false);
});

test('a change of width closes it', () => {
  assert.equal(drawerClosesOnResize(390, 460), true);
  assert.equal(drawerClosesOnResize(390, 1280), true);
  assert.equal(drawerClosesOnResize(460, 390), true);
});
