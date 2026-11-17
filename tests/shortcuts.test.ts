// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The shortcut registry's policy, without a browser: the shipped table is sound, and the rules
// that keep terminal keys away from the page are enforced by `validate` (a table that breaks one
// is reported). The dispatcher and the xterm integration are tested in a browser
// (tests/shortcut-search-browser.test.ts).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {
  type Binding, type Chord, type KeyLike, type Platform, SHORTCUTS, TERMINAL_RESERVED, appliesToTerminal,
  detectPlatform, formatChord, helpEntries, matches, resolve, validate,
} from '../static/shortcuts.ts';
import fs from 'node:fs';
import path from 'node:path';

const press = (key: string, flags: Partial<KeyLike> = {}): KeyLike =>
  ({key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...flags});
const chord = (key: string, options: Partial<Chord> = {}): Chord =>
  ({key, mod: false, ctrl: false, shift: false, alt: false, ...options});
const bind = (id: string, c: Chord, context: Binding['context'], extra: Partial<Binding> = {}): Binding =>
  ({id, chord: c, context, action: id, ...extra});

describe('the shipped table', () => {
  test('violates no policy rule', () => {
    assert.deepEqual(validate(SHORTCUTS), []);
  });

  test('every binding that applies to a terminal needs the modifier and Shift', () => {
    for (const binding of SHORTCUTS.filter(entry => entry.external !== true && appliesToTerminal(entry))) {
      assert.equal(binding.chord.shift, true, binding.id);
      assert.equal(binding.chord.mod, true, binding.id);
    }
  });

  test('Ctrl+K is not bound in a context that reaches a terminal', () => {
    for (const platform of ['other', 'mac'] as const) {
      const ctrlK = press('k', {ctrlKey: true});
      assert.equal(resolve(SHORTCUTS, ctrlK, 'terminal', platform), null);
      assert.equal(resolve(SHORTCUTS, ctrlK, 'field', platform), null);
      assert.equal(resolve(SHORTCUTS, ctrlK, 'direct-line', platform), null);
    }
  });

  test('every id has an English and a French label and context caption', () => {
    const load = (code: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'static', 'i18n', `${code}.json`), 'utf8')) as Record<string, string>;
    for (const catalog of [load('en'), load('fr')]) {
      for (const entry of helpEntries(SHORTCUTS, 'other')) {
        assert.equal(typeof catalog[`shortcuts.${entry.id}`], 'string', entry.id);
        assert.equal(typeof catalog[`shortcuts.context.${entry.context}`], 'string', entry.context);
      }
    }
  });
});

describe('resolution', () => {
  const cases: [string, KeyLike, Platform, Parameters<typeof resolve>[2], string | null][] = [
    ['Ctrl+K on the page', press('k', {ctrlKey: true}), 'other', 'page', 'sessionSearch'],
    ['Ctrl+K typed as capital K without Shift is still K', press('K', {ctrlKey: true}), 'other', 'page', 'sessionSearch'],
    ['Cmd+K on the page on macOS', press('k', {metaKey: true}), 'mac', 'page', 'sessionSearch'],
    ['Ctrl+K on macOS is not the shortcut (a terminal reads it)', press('k', {ctrlKey: true}), 'mac', 'page', null],
    ['Cmd+K elsewhere is not the shortcut', press('k', {metaKey: true}), 'other', 'page', null],
    ['Ctrl+K in a terminal goes to the program', press('k', {ctrlKey: true}), 'other', 'terminal', null],
    ['Ctrl+K in a text field is left alone', press('k', {ctrlKey: true}), 'other', 'field', null],
    ['Ctrl+K in the phone line is left alone', press('k', {ctrlKey: true}), 'other', 'direct-line', null],
    ['Ctrl+K with a dialog open is left alone', press('k', {ctrlKey: true}), 'other', 'modal', null],
    ['Ctrl+Alt+K is another key', press('k', {ctrlKey: true, altKey: true}), 'other', 'page', null],
    ['Ctrl+Shift+K on the page', press('K', {ctrlKey: true, shiftKey: true}), 'other', 'page', 'sessionSearchAnywhere'],
    ['Ctrl+Shift+K in a terminal is captured', press('K', {ctrlKey: true, shiftKey: true}), 'other', 'terminal', 'sessionSearchAnywhere'],
    ['Ctrl+Shift+K in a text field', press('K', {ctrlKey: true, shiftKey: true}), 'other', 'field', 'sessionSearchAnywhere'],
    ['Cmd+Shift+K in a terminal on macOS', press('K', {metaKey: true, shiftKey: true}), 'mac', 'terminal', 'sessionSearchAnywhere'],
    ['Ctrl+Shift+K with a dialog open is left alone', press('K', {ctrlKey: true, shiftKey: true}), 'other', 'modal', null],
    ['? on the page, whatever the layout does with Shift', press('?'), 'other', 'page', 'help'],
    ['? with Shift on the page', press('?', {shiftKey: true}), 'other', 'page', 'help'],
    ['? in a terminal is typed', press('?', {shiftKey: true}), 'other', 'terminal', null],
    ['? in a text field is typed', press('?', {shiftKey: true}), 'other', 'field', null],
    ['an external key (n) is not run by the registry', press('n'), 'other', 'page', null],
  ];
  for (const [name, event, platform, focus, expected] of cases) {
    test(name, () => {
      assert.equal(resolve(SHORTCUTS, event, focus, platform)?.id ?? null, expected);
    });
  }

  test('a key pressed during an IME composition resolves to nothing', () => {
    assert.equal(resolve(SHORTCUTS, press('k', {ctrlKey: true, isComposing: true}), 'page', 'other'), null);
  });

  test('matches reads the platform\'s own modifier only', () => {
    const [search] = SHORTCUTS;
    assert.ok(search);
    assert.equal(matches(search, press('k', {ctrlKey: true, metaKey: true}), 'other'), false);
    assert.equal(matches(search, press('k', {ctrlKey: true, metaKey: true}), 'mac'), false);
  });
});

describe('guard rails reject a table that breaks the policy', () => {
  const sound = bind('sound', chord('j', {mod: true, shift: true}), 'anywhere');
  const problemsOf = (...bindings: Binding[]) => validate([...bindings]);

  test('a sound binding passes', () => {
    assert.deepEqual(problemsOf(sound), []);
  });

  test('two bindings with the same chord in overlapping contexts collide', () => {
    const duplicate = bind('duplicate', chord('j', {mod: true, shift: true}), 'terminal-captured');
    assert.match(problemsOf(sound, duplicate).join('\n'), /collides/);
  });

  test('the same chord in contexts that never overlap does not collide', () => {
    const plain = bind('plain', chord('j', {mod: true}), 'outside-terminal');
    const captured = bind('captured', chord('j', {mod: true}), 'terminal-captured');
    assert.deepEqual(problemsOf(plain).filter(problem => /collides/.test(problem)), []);
    assert.deepEqual(problemsOf(plain, captured).filter(problem => /collides/.test(problem)), []);
  });

  test('an external entry still reserves its chord', () => {
    const external: Binding = {id: 'ext', chord: chord('c', {ctrl: true, shift: true}), context: 'terminal-captured', external: true};
    const thief = bind('thief', chord('c', {ctrl: true, shift: true}), 'anywhere');
    assert.match(problemsOf(external, thief).join('\n'), /collides/);
  });

  test('a collision is judged on each platform\'s real modifiers', () => {
    const literalCtrl: Binding = {id: 'ctrl', chord: chord('j', {ctrl: true}), context: 'outside-terminal', external: true};
    const primary = bind('primary', chord('j', {mod: true}), 'outside-terminal');
    assert.match(problemsOf(literalCtrl, primary).join('\n'), /other: .*collides/);
    assert.doesNotMatch(problemsOf(literalCtrl, primary).join('\n'), /mac: .*collides/);
  });

  for (const reserved of TERMINAL_RESERVED) {
    const name = formatChord(reserved, 'other');
    test(`${name} cannot be bound where it reaches a terminal`, () => {
      for (const context of ['anywhere', 'terminal-captured'] as const) {
        const problems = problemsOf(bind('stolen', reserved, context));
        assert.ok(problems.length > 0, `${name} in ${context} was accepted`);
      }
    });
  }

  test('Ctrl+K without Shift cannot be bound anywhere or in a terminal', () => {
    for (const context of ['anywhere', 'terminal-captured'] as const) {
      assert.match(problemsOf(bind('kill', chord('k', {mod: true}), context)).join('\n'), /terminal/);
    }
  });

  test('a terminal-reaching binding with Shift but not the modifier is refused', () => {
    assert.match(problemsOf(bind('shifted', chord('j', {shift: true}), 'anywhere')).join('\n'), /needs the modifier with Shift/);
  });

  test('a binding without a modifier is refused outside the outside-terminal context', () => {
    assert.match(problemsOf(bind('bare', chord('j'), 'anywhere')).join('\n'), /no modifier/);
    assert.deepEqual(problemsOf(bind('bare', chord('j'), 'outside-terminal')), []);
  });

  test('a chord the browser keeps is refused', () => {
    assert.match(problemsOf(bind('tab', chord('t', {mod: true}), 'outside-terminal')).join('\n'), /browser keeps/);
  });

  test('a new binding names its action, an external one does not', () => {
    const {action: _action, ...noAction} = bind('none', chord('j', {mod: true}), 'outside-terminal');
    assert.match(problemsOf(noAction).join('\n'), /names no action/);
    assert.match(problemsOf({...sound, external: true}).join('\n'), /external and names an action/);
  });

  test('duplicate ids are refused', () => {
    assert.match(problemsOf(sound, {...sound, chord: chord('i', {mod: true, shift: true})}).join('\n'), /duplicate id/);
  });
});

describe('platform and help', () => {
  test('platform detection', () => {
    assert.equal(detectPlatform('MacIntel'), 'mac');
    assert.equal(detectPlatform('macOS'), 'mac');
    assert.equal(detectPlatform('iPad'), 'mac');
    assert.equal(detectPlatform('Linux x86_64'), 'other');
    assert.equal(detectPlatform('Win32'), 'other');
    assert.equal(detectPlatform(undefined), 'other');
  });

  test('the help lists every entry with the platform\'s key names', () => {
    const other = helpEntries(SHORTCUTS, 'other');
    const mac = helpEntries(SHORTCUTS, 'mac');
    assert.equal(other.length, SHORTCUTS.length);
    assert.equal(other.find(entry => entry.id === 'sessionSearch')?.keys, 'Ctrl+K');
    assert.equal(mac.find(entry => entry.id === 'sessionSearch')?.keys, 'Cmd+K');
    assert.equal(other.find(entry => entry.id === 'sessionSearchAnywhere')?.keys, 'Ctrl+Shift+K');
    assert.equal(mac.find(entry => entry.id === 'sessionSearchAnywhere')?.keys, 'Cmd+Shift+K');
    assert.equal(mac.find(entry => entry.id === 'copy')?.keys, 'Ctrl+C', 'the terminal copy is the Ctrl key on macOS too');
    assert.equal(other.find(entry => entry.id === 'help')?.keys, '?');
  });
});
