// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The timeline bar style of each task status (static/work-derive.ts friseBarStyle): every status of the data has one,
// an unknown status falls back to a neutral style, and the token of a status is the one its dot uses.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { THEMES } from '../static/themes.ts';
import { FRISE_LEGEND_STATUSES, STATUSES, friseBarStyle } from '../static/work-derive.ts';

describe('friseBarStyle', () => {
  test('every status of the data has its own class, and the legend statuses are all distinct', () => {
    for (const status of STATUSES) assert.match(friseBarStyle(status).cls, /^work-bar-[a-z_]+$/, status);
    const classes = FRISE_LEGEND_STATUSES.map(status => friseBarStyle(status).cls);
    assert.equal(new Set(classes).size, FRISE_LEGEND_STATUSES.length);
    assert.deepEqual([...FRISE_LEGEND_STATUSES].sort(), ['blocked', 'done', 'dropped', 'in_progress', 'todo', 'waiting']);
  });

  test('the colour tokens are the ones of the status dots', () => {
    assert.equal(friseBarStyle('in_progress').token, '--busy');
    assert.equal(friseBarStyle('waiting').token, '--wait');
    assert.equal(friseBarStyle('blocked').token, '--danger');
    assert.equal(friseBarStyle('done').token, '--accent');
    assert.equal(friseBarStyle('inbox').cls, friseBarStyle('todo').cls, 'an untriaged task looks like a task to do');
  });

  test('every bar colour has at least 3:1 contrast with the track in every shipped theme (WCAG 1.4.11), and the legend text 4.5:1', () => {
    const luminance = (hex: string): number => {
      const [red, green, blue] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number];
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const contrast = (first: string, second: string): number => {
      const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
      return (light + 0.05) / (dark + 0.05);
    };
    for (const theme of THEMES) {
      const background = theme.colours['--bg']!;
      assert.ok(contrast(theme.colours['--mute']!, background) >= 4.5, `${theme.id} legend text`);
      for (const status of [...FRISE_LEGEND_STATUSES, 'unknown']) {
        const token = friseBarStyle(status).token;
        const ratio = contrast(theme.colours[token]!, background);
        assert.ok(ratio >= 3, `${theme.id} ${status} ${token} ${ratio.toFixed(2)}`);
      }
    }
  });

  test('an unknown status gets a neutral style, never an undefined one', () => {
    for (const status of ['', 'archived', '__proto__', 'constructor', 'toString']) {
      assert.deepEqual(friseBarStyle(status), { cls: 'work-bar-unknown', token: '--mute' }, status);
    }
  });
});
