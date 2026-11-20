// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "What's new" panel's logic (static/update-notes.ts): what the page accepts from GET /api/update/notes,
// which links stay links, and which images are asked of the server's proxy (never of GitHub).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {imageSource, NOTES_LIMIT, parseNotes, safeLink} from '../static/update-notes.ts';
import {parseNotice} from '../static/update-notice.ts';

const URL_OF = 'https://github.com/Session-Mesh/session-mesh/releases/tag/';
const notes = (extra: Record<string, unknown> = {}) => ({
  tag: 'v0.2.0', published: '2026-11-19T10:00:00Z', body: '## New', truncated: false, notes_url: URL_OF + 'v0.2.0', ...extra,
});

describe('update notes', () => {
  test('accepts the notes of the announced release only', () => {
    assert.deepEqual(parseNotes(notes(), 'v0.2.0'), {
      tag: 'v0.2.0', published: '2026-11-19T10:00:00Z', body: '## New', truncated: false, notesUrl: URL_OF + 'v0.2.0'});
    assert.equal(parseNotes(notes({published: ''}), 'v0.2.0')?.published, '', 'no date');
    for (const bad of [null, 'x', notes({tag: 'v0.3.0'}), notes({body: 7}), notes({truncated: 'no'}),
      notes({notes_url: 'https://example.com/releases/tag/v0.2.0'}), notes({notes_url: URL_OF + 'v0.3.0'}),
      notes({published: 'yesterday'}), notes({body: 'x'.repeat(NOTES_LIMIT + 1)})]) {
      assert.equal(parseNotes(bad, 'v0.2.0'), null, JSON.stringify(bad).slice(0, 80));
    }
  });

  test('a link stays one only for an absolute http(s) URL without credentials', () => {
    assert.equal(safeLink('https://github.com/Session-Mesh/session-mesh/pull/12'), 'https://github.com/Session-Mesh/session-mesh/pull/12');
    assert.equal(safeLink('http://example.com/a'), 'http://example.com/a');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', '/api/sessions',
      '#top', '//evil.example/x', 'https://user:pw@example.com/', 'file:///etc/passwd', '', null]) {
      assert.equal(safeLink(bad), null, String(bad));
    }
  });

  test('images go through the server\'s proxy, for the GitHub hosts only', () => {
    const url = 'https://github.com/user-attachments/assets/0f1e';
    assert.equal(imageSource(url), `/api/update/image?url=${encodeURIComponent(url)}`);
    assert.ok(imageSource('https://private-user-images.githubusercontent.com/1/x.png?jwt=a'));
    assert.ok(imageSource('https://raw.githubusercontent.com/o/r/main/x.png'));
    for (const bad of ['http://github.com/x.png', 'https://example.com/x.png', 'https://127.0.0.1/x.png',
      'https://github.com.evil.example/x.png', 'https://evilgithubusercontent.com/x.png', `https://u:p${'@'}github.com/x.png`,
      'https://github.com:8443/x.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/api/sessions', '', null]) {
      assert.equal(imageSource(bad), null, String(bad));
    }
  });

  test('the banner offers the notes only when the host says it has them', () => {
    const answer = {status: 'available', latest: 'v0.2.0', security: false, notes_url: URL_OF + 'v0.2.0',
      upgrade_command: 'x', line: 'x'};
    assert.equal(parseNotice(answer)?.notes, false, 'an older host says nothing');
    assert.equal(parseNotice({...answer, notes: true})?.notes, true);
    assert.equal(parseNotice({...answer, notes: 'yes'})?.notes, false);
  });
});
