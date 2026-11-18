// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Colour themes (static/themes.ts): the built-in palettes, the validation and storage of the
// custom palette, the xterm.js mapping and the runtime that applies a choice to the page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {
  ANSI_NAMES, CSS_VARIABLES, PALETTE_KEY, THEME_KEY, THEMES, VARIABLES, contrastRatio, createRuntime, formatPalette,
  isColour, parsePalette, readPalette, readThemeId, resolveColours, terminalTheme, themeLabelKey, validatePalette,
  writePalette, writeThemeId, type ApplyTarget, type Colours, type StorageLike,
} from '../static/themes.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const readCatalog = (code: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'static', 'i18n', `${code}.json`), 'utf8'));

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

const FAILING: StorageLike = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

function fakePage(): ApplyTarget & {vars: Map<string, string>; meta: Map<string, string>; dataset: Record<string, string | undefined>; scheme: () => string} {
  const vars = new Map<string, string>();
  const meta = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const style = {colorScheme: '', setProperty(name: string, value: string) { vars.set(name, value); }};
  return {
    vars, meta, dataset, scheme: () => style.colorScheme,
    documentElement: {dataset, style},
    querySelector: (selector: string) => selector === 'meta[name="theme-color"]'
      ? {setAttribute: (name: string, value: string) => { meta.set(name, value); }} : null,
  };
}

describe('built-in themes', () => {
  test('each defines every variable with a hexadecimal colour', () => {
    for (const theme of THEMES) {
      assert.deepEqual(Object.keys(theme.colours).sort(), [...VARIABLES].sort(), theme.id);
      for (const [key, value] of Object.entries(theme.colours)) assert.ok(isColour(value), `${theme.id} ${key}: ${value}`);
    }
  });

  test('the default theme is the :root of style.css', () => {
    const css = fs.readFileSync(path.join(ROOT, 'static', 'style.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const declared = Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]+);/gi)].map(m => [m[1]!, m[2]!]));
    assert.ok(Object.keys(declared).length >= 13);
    const defaults = THEMES[0]!.colours;
    for (const [key, value] of Object.entries(declared)) assert.equal(defaults[key], value, key);
  });

  test('the default terminal colours are the ones the panes always had', () => {
    assert.deepEqual(terminalTheme(THEMES[0]!.colours), {
      background: '#0d1117', foreground: '#d8dee9', cursor: '#7ee0a1', cursorAccent: '#0d1117', selectionBackground: '#2d3b4f',
      black: '#1b2029', red: '#ff7b72', green: '#7ee0a1', yellow: '#f5c56b', blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#76e3ea',
      white: '#d8dee9', brightBlack: '#4b5361', brightRed: '#ffa198', brightGreen: '#a5f0c0', brightYellow: '#ffdf8a',
      brightBlue: '#a5cdff', brightMagenta: '#e2c5ff', brightCyan: '#b3f0f5', brightWhite: '#ffffff',
    });
  });

  // WCAG 2.x AA for normal text: 4.5:1. Every text, accent and state colour is checked on every
  // surface of style.css and themes.css (--bg, --panel, --panel-2 and --raise: a selected tab or
  // button, a checked explorer row, the current project), which covers each pair actually drawn.
  // Then the colours drawn on a coloured background: primary buttons and the "new" button
  // (--on-accent on --accent), the menu badge (--on-accent on --wait), the mail badge and the
  // "to bottom" button (--bg on --danger and on --accent), and the terminal text.
  const TEXT = ['--fg', '--fg-2', '--mute', '--accent', '--idle', '--busy', '--wait', '--danger'];
  const SURFACES = ['--bg', '--panel', '--panel-2', '--raise'];
  const ON_COLOUR: [string, string][] = [
    ['--on-accent', '--accent'], ['--on-accent', '--wait'], ['--bg', '--accent'], ['--bg', '--danger'], ['--fg', '--term'],
  ];
  const PAIRS: [string, string][] = [...TEXT.flatMap((text) => SURFACES.map((surface): [string, string] => [text, surface])), ...ON_COLOUR];
  // The counter of the current tab (#n-live, #n-hist) is drawn on --raise in every theme: its
  // colour comes from the unscoped rule of themes.css, which applies to the default theme too.
  const STYLE_CSS = fs.readFileSync(path.join(ROOT, 'static', 'style.css'), 'utf8');
  const THEMES_CSS = fs.readFileSync(path.join(ROOT, 'static', 'themes.css'), 'utf8');
  const COUNTER = /^\.tabs button\.cur \.n \{ color: var\((--[a-z0-9-]+)\); \}$/m.exec(THEMES_CSS)?.[1];
  test('the counter of the current tab meets WCAG AA on the current tab in every theme', () => {
    assert.ok(COUNTER, 'no unscoped .tabs button.cur .n rule in themes.css');
    assert.match(STYLE_CSS, new RegExp(`^\\.tabs button\\.cur \\{ background: ${THEMES[0]!.colours['--raise']};`, 'm'),
      'the default current tab is not drawn on the default --raise');
    for (const theme of THEMES) {
      const ratio = contrastRatio(theme.colours[COUNTER]!, theme.colours['--raise']!);
      assert.ok(ratio >= 4.5, `${theme.id} ${COUNTER} on --raise: ${ratio.toFixed(2)}`);
    }
  });
  // In the default theme --raise is only the literal #1d2530 of style.css: the current tab and the
  // active mode buttons, whose text is --fg, plus the counter checked above (the other themes also
  // paint --raise under a checked explorer row and the current project, so every text is checked).
  const drawnOnRaise = (themeId: string): readonly string[] => themeId === 'default' ? ['--fg', COUNTER ?? '--fg'] : TEXT;
  for (const theme of THEMES) {
    test(`${theme.id}: text meets WCAG AA (4.5:1) on every surface`, () => {
      for (const [text, surface] of PAIRS) {
        if (surface === '--raise' && !drawnOnRaise(theme.id).includes(text)) continue;
        const ratio = contrastRatio(theme.colours[text]!, theme.colours[surface]!);
        assert.ok(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    });
  }

  test('the literal colours of the light schemes meet WCAG AA on every light surface', () => {
    const css = fs.readFileSync(path.join(ROOT, 'static', 'themes.css'), 'utf8');
    const rules = [...css.matchAll(/^:root\[data-scheme="light"\][^{]*\{([^}]*)\}/gm)].map((m) => m[1]!);
    const checked = rules.flatMap((body) => {
      const colour = /(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
      if (!colour) return [];
      const background = /background:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
      const surfaces = background ? [background]
        : THEMES.filter((theme) => theme.scheme === 'light').flatMap((theme) => SURFACES.map((surface) => theme.colours[surface]!));
      for (const surface of surfaces) {
        const ratio = contrastRatio(colour, surface);
        assert.ok(ratio >= 4.5, `${colour} on ${surface}: ${ratio.toFixed(2)}`);
      }
      return [colour];
    });
    assert.ok(checked.length >= 8, `only ${checked.length} light-scheme colours found`);
  });

  test('each has a name in every catalog', () => {
    for (const code of ['en', 'fr']) {
      const catalog = readCatalog(code);
      for (const theme of THEMES) assert.equal(typeof catalog[themeLabelKey(theme.id)], 'string', `${code} ${theme.id}`);
    }
  });

  test('the contrast ratio follows WCAG (black on white is 21:1)', () => {
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#fff', '#000'), 21);
    assert.equal(contrastRatio('#777777', '#777777'), 1);
  });
});

describe('custom palette validation', () => {
  test('accepts known variables with hexadecimal colours, normalised', () => {
    const result = validatePalette({'--bg': ' #002B36 ', '--ansi-bright-white': '#fff', '--selection': '#11223344'});
    assert.deepEqual(result, {ok: true, palette: {'--bg': '#002b36', '--ansi-bright-white': '#fff', '--selection': '#11223344'}});
  });

  test('refuses an unknown variable and anything but a hexadecimal colour', () => {
    const result = validatePalette({
      '--bogus': '#000', 'bg': '#000', '--fg': 'red', '--mute': 'url(https://example.test/x)', '--panel': '#fff;--bg:#000',
      '--line': '#12345', '--accent': 42, '--busy': null,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === 'invalid-entries');
    assert.deepEqual(!result.ok && result.errors.map(e => `${e.key}:${e.reason}`), [
      '--bogus:unknown-variable', 'bg:unknown-variable', '--fg:not-a-colour', '--mute:not-a-colour', '--panel:not-a-colour',
      '--line:not-a-colour', '--accent:not-a-colour', '--busy:not-a-colour',
    ]);
  });

  test('refuses what is not an object', () => {
    for (const value of [null, [], '#000', 3]) assert.deepEqual(validatePalette(value), {ok: false, reason: 'not-an-object', errors: []});
  });

  test('parses text: empty is no palette, broken JSON is reported', () => {
    assert.deepEqual(parsePalette('  '), {ok: true, palette: {}});
    assert.deepEqual(parsePalette('{"--bg": '), {ok: false, reason: 'not-json', errors: []});
    assert.deepEqual(parsePalette('{"--bg": "#000"}'), {ok: true, palette: {'--bg': '#000'}});
  });

  test('formats a palette in variable order and parses it back', () => {
    const palette = {'--ansi-red': '#dc322f', '--bg': '#002b36'};
    const text = formatPalette(palette);
    assert.ok(text.indexOf('--bg') < text.indexOf('--ansi-red'));
    assert.deepEqual(parsePalette(text), {ok: true, palette});
    assert.equal(formatPalette({}), '{}');
  });

  test('every CSS variable of the themes exists in style.css or themes.css', () => {
    const css = ['style.css', 'themes.css'].map(name => fs.readFileSync(path.join(ROOT, 'static', name), 'utf8')).join('\n');
    for (const name of CSS_VARIABLES) assert.match(css, new RegExp(`${name}:\\s*#`), name);
  });
});

describe('storage', () => {
  test('the theme: unknown or missing is the default, the default is not stored', () => {
    const storage = new MemoryStorage();
    assert.equal(readThemeId(storage), 'default');
    assert.equal(writeThemeId(storage, 'nord'), true);
    assert.equal(storage.getItem(THEME_KEY), '"nord"');
    assert.equal(readThemeId(storage), 'nord');
    writeThemeId(storage, 'default');
    assert.equal(storage.getItem(THEME_KEY), null);
    storage.setItem(THEME_KEY, '"no-such-theme"');
    assert.equal(readThemeId(storage), 'default');
    storage.setItem(THEME_KEY, '{not json');
    assert.equal(readThemeId(storage), 'default');
  });

  test('the palette: a stored entry that is no longer valid is ignored whole', () => {
    const storage = new MemoryStorage();
    assert.deepEqual(readPalette(storage), {});
    writePalette(storage, {'--bg': '#000000'});
    assert.deepEqual(readPalette(storage), {'--bg': '#000000'});
    storage.setItem(PALETTE_KEY, JSON.stringify({'--bg': '#000000', '--fg': 'expression(alert(1))'}));
    assert.deepEqual(readPalette(storage), {});
    writePalette(storage, {});
    assert.equal(storage.getItem(PALETTE_KEY), null);
  });

  test('a blocked storage gives the default theme and reports the failed write', () => {
    assert.equal(readThemeId(FAILING), 'default');
    assert.deepEqual(readPalette(FAILING), {});
    assert.equal(writeThemeId(FAILING, 'light'), false);
    assert.equal(writePalette(FAILING, {'--bg': '#000'}), false);
    assert.equal(readThemeId(null), 'default');
  });
});

describe('terminal mapping', () => {
  test('maps background, text, cursor, selection and the 16 ANSI colours', () => {
    for (const theme of THEMES) {
      const mapped = terminalTheme(theme.colours);
      assert.deepEqual(Object.keys(mapped).sort(),
        ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', ...ANSI_NAMES].sort());
      assert.equal(mapped.background, theme.colours['--term']);
      assert.equal(mapped.foreground, theme.colours['--fg']);
      assert.equal(mapped.brightBlack, theme.colours['--ansi-bright-black']);
    }
  });

  test('the custom palette reaches the terminal', () => {
    const colours = resolveColours('solarized-dark', {'--term': '#101010', '--ansi-red': '#ff0000'});
    const mapped = terminalTheme(colours);
    assert.equal(mapped.background, '#101010');
    assert.equal(mapped.cursorAccent, '#101010');
    assert.equal(mapped.red, '#ff0000');
    assert.equal(mapped.green, '#859900');
  });
});

describe('runtime', () => {
  test('applies the stored choice at once: variables, data-theme, colour scheme, theme-color', () => {
    const storage = new MemoryStorage();
    writeThemeId(storage, 'solarized-light');
    writePalette(storage, {'--panel': '#eeeeee'});
    const page = fakePage();
    const runtime = createRuntime(page, storage);
    assert.equal(runtime.current(), 'solarized-light');
    assert.equal(page.dataset['theme'], 'solarized-light');
    assert.equal(page.dataset['scheme'], 'light');
    assert.equal(page.scheme(), 'light');
    assert.equal(page.vars.get('--bg'), '#fdf6e3');
    assert.equal(page.vars.get('--panel'), '#eeeeee');
    assert.equal(page.meta.get('content'), '#eeeeee');
    assert.equal(runtime.terminal().background, '#fdf6e3');
  });

  test('a change is stored, applied and announced; an invalid one changes nothing', () => {
    const storage = new MemoryStorage();
    const page = fakePage();
    const runtime = createRuntime(page, storage);
    const heard: Colours[] = [];
    runtime.onChange(colours => heard.push(colours));
    assert.equal(runtime.use('gruvbox-dark'), true);
    assert.equal(page.vars.get('--term'), '#282828');
    assert.equal(heard.at(-1)?.['--term'], '#282828');
    assert.equal(runtime.use('bogus' as never), false);
    assert.equal(runtime.current(), 'gruvbox-dark');
    assert.equal(runtime.setPalette({'--bg': 'blue'}), false);
    assert.deepEqual(runtime.palette(), {});
    assert.equal(runtime.setPalette({'--bg': '#123456'}), true);
    assert.equal(page.vars.get('--bg'), '#123456');
    assert.equal(heard.length, 2);
    assert.equal(runtime.setPalette({}), true);
    assert.equal(page.vars.get('--bg'), '#1d2021', 'reset restores the theme value');
  });

  test('reload follows a change made by another tab', () => {
    const storage = new MemoryStorage();
    const page = fakePage();
    const runtime = createRuntime(page, storage);
    writeThemeId(storage, 'light');
    runtime.reload();
    assert.equal(runtime.current(), 'light');
    assert.equal(page.vars.get('--fg'), '#1f2328');
  });
});
