// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure parts of the owner's answer form (static/work-answer-form.ts): the local check before sending and the
// failure shown for each error of the relay. The form itself runs in tests/work-view-browser.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ANSWER, failureOfKind, localFailure } from '../static/work-answer-form.ts';
import type { WorkErrorKind } from '../static/work-api.ts';

test('a blank answer and one over the bound are refused before sending; the bound counts characters', () => {
  for (const blank of ['', '   ', '\n\t\n']) assert.equal(localFailure(blank), 'empty', JSON.stringify(blank));
  assert.equal(localFailure('x'.repeat(MAX_ANSWER)), null);
  assert.equal(localFailure('x'.repeat(MAX_ANSWER + 1)), 'too-long');
  // 2000 four-byte characters are 4000 UTF-16 units but 2000 characters: accepted, as the writer counts them.
  assert.equal(localFailure('\u{1F600}'.repeat(MAX_ANSWER)), null);
  assert.equal(localFailure('\u{1F600}'.repeat(MAX_ANSWER + 1)), 'too-long');
  assert.equal(localFailure('<img src=x onerror=alert(1)>'), null, 'markup is ordinary text here');
});

test('each relay error has the failure the form shows; a missing work-write hides the form', () => {
  const expected: [WorkErrorKind, string][] = [
    ['not-available', 'unavailable'], ['auth', 'auth'], ['invalid', 'invalid'], ['shape', 'invalid'], ['missing', 'missing'],
    ['busy', 'busy'], ['network', 'network'], ['aborted', 'network'], ['unavailable', 'failed'], ['timeout', 'failed'],
    ['failed', 'failed'], ['no-tracker', 'failed'], ['conflict', 'failed'],
  ];
  for (const [kind, failure] of expected) assert.equal(failureOfKind(kind), failure, kind);
});
