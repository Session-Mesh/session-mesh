// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What a terminal writes its socket's replay after (static/terminal-replay.ts, bundled into
// pane-actions.js): a reset, the input modes after a reconnection, nothing on the alternate screen.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {replayPrefix} from '../static/terminal-replay.ts';

const none = {applicationCursorKeysMode: false, applicationKeypadMode: false, bracketedPasteMode: false,
  mouseTrackingMode: 'none', sendFocusMode: false, insertMode: true, originMode: true, wraparoundMode: false};
const all = {...none, applicationCursorKeysMode: true, applicationKeypadMode: true, bracketedPasteMode: true,
  mouseTrackingMode: 'any', sendFocusMode: true};
const term = (modes: object, activeEncoding = 'DEFAULT', type = 'normal') =>
  ({buffer: {active: {type}}, modes, _core: {coreMouseService: {activeEncoding}}});

test('a replay is written after a reset; after a reconnection, also the input modes set now', () => {
  assert.equal(replayPrefix(term(all, 'SGR'), false), '\x1bc', 'an attach starts from a reset terminal only');
  assert.equal(replayPrefix(term(none), true), '\x1bc', 'output modes (insert, origin, autowrap) are not set again');
  assert.equal(replayPrefix(term(all, 'SGR'), true), '\x1bc\x1b[?1h\x1b=\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1004h');
  assert.equal(replayPrefix(term({...none, mouseTrackingMode: 'x10'}, 'SGR_PIXELS'), true), '\x1bc\x1b[?9h\x1b[?1016h');
  assert.equal(replayPrefix(term({...none, mouseTrackingMode: 'vt200'}), true), '\x1bc\x1b[?1000h');
  assert.equal(replayPrefix(term({...none, mouseTrackingMode: 'drag'}), true), '\x1bc\x1b[?1002h');
  assert.equal(replayPrefix({}, true), '\x1bc', 'without modes, a reset');
});

test('a reconnection on the alternate screen appends its replay without a reset', () => {
  assert.equal(replayPrefix(term(all, 'SGR', 'alternate'), true), null);
  assert.equal(replayPrefix(term(none, 'DEFAULT', 'alternate'), false), '\x1bc',
    'an attach starts from a reset terminal, whatever screen it showed');
});
