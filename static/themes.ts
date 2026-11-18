// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Colour themes of the interface and of its terminals, and the custom palette.
//
// A theme is a full set of colour variables: the CSS variables of static/style.css (--bg, --fg…)
// and the terminal's own (--cursor, --selection, the 16 --ansi-* colours). The page uses the CSS
// ones; `terminalTheme` maps the whole set to an xterm.js theme, so a pane follows the page.
// The custom palette is a set of overrides of those same variables, laid over the chosen theme.
//
// Both choices are kept in this browser (localStorage, "mesh.theme" and "mesh.palette"), like the
// language. This file is loaded in the <head>, before the stylesheets, and applies the choice at
// once: the page is never painted in the wrong theme. A stored value is validated again on every
// read, so a hand-edited or stale entry is ignored rather than applied.
//
// Palette sources (all under the MIT licence, which allows this reuse):
// - Solarized, Ethan Schoonover: https://ethanschoonover.com/solarized/ (github.com/altercation/solarized)
// - Gruvbox, Pavel Pertsev: https://github.com/morhetz/gruvbox
// - Nord, Arctic Ice Studio: https://www.nordtheme.com/ (github.com/nordtheme/nord)
// - The light theme takes its terminal colours from GitHub Primer primitives:
//   https://github.com/primer/primitives
// Interface shades that a source palette does not have (a second panel, a border, a muted text
// light enough for WCAG AA) are derived from it and marked "derived".

export const CSS_VARIABLES = [
  '--bg', '--term', '--panel', '--panel-2', '--line', '--fg', '--mute', '--accent', '--busy', '--idle',
  '--wait', '--off', '--danger', '--fg-2', '--raise', '--line-2', '--on-accent',
] as const;

export const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
export type AnsiName = typeof ANSI_NAMES[number];

const ansiVariable = (name: AnsiName): `--ansi-${string}` => `--ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
export const ANSI_VARIABLES = ANSI_NAMES.map(ansiVariable);
export const TERMINAL_VARIABLES = ['--cursor', '--selection', ...ANSI_VARIABLES] as const;
export const VARIABLES: readonly string[] = [...CSS_VARIABLES, ...TERMINAL_VARIABLES];

export type Colours = Readonly<Record<string, string>>;
export type ThemeId = 'default' | 'light' | 'solarized-dark' | 'solarized-light' | 'gruvbox-dark' | 'nord';
export type Theme = { readonly id: ThemeId; readonly scheme: 'dark' | 'light'; readonly colours: Colours };

function ansi(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(ANSI_NAMES.map((name, i) => [ansiVariable(name), values[i]!]));
}

// The current dark palette: the values of static/style.css's :root (a unit test keeps them equal).
const DEFAULT: Colours = {
  '--bg': '#0b0e13', '--term': '#0d1117', '--panel': '#11151c', '--panel-2': '#161b24', '--line': '#232a35',
  '--fg': '#d8dee9', '--mute': '#7b8494', '--accent': '#7ee0a1', '--busy': '#f5c56b', '--idle': '#7ee0a1',
  '--wait': '#ff9f5a', '--off': '#4b5361', '--danger': '#ff8a8a',
  '--fg-2': '#aab2c0', '--raise': '#1d2530', '--line-2': '#3a4555', '--on-accent': '#0b0e13',
  '--cursor': '#7ee0a1', '--selection': '#2d3b4f',
  ...ansi(['#1b2029', '#ff7b72', '#7ee0a1', '#f5c56b', '#79b8ff', '#d2a8ff', '#76e3ea', '#d8dee9',
    '#4b5361', '#ffa198', '#a5f0c0', '#ffdf8a', '#a5cdff', '#e2c5ff', '#b3f0f5', '#ffffff']),
};

const LIGHT: Colours = {
  '--bg': '#eef1f5', '--term': '#ffffff', '--panel': '#f6f8fa', '--panel-2': '#eaeef2', '--line': '#d0d7de',
  '--fg': '#1f2328', '--mute': '#59636e', '--accent': '#177131', '--busy': '#875a00', '--idle': '#177131',
  '--wait': '#a94400', '--off': '#8c959f', '--danger': '#c1202b',
  '--fg-2': '#3d444d', '--raise': '#dde3ea', '--line-2': '#afb8c1', '--on-accent': '#ffffff',
  '--cursor': '#177131', '--selection': '#b6d7ff',
  ...ansi(['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
};

// Solarized: base03 #002b36, base02 #073642, base01 #586e75, base00 #657b83, base0 #839496,
// base1 #93a1a1, base2 #eee8d5, base3 #fdf6e3, and the eight accents. Bright black is base01
// rather than the background (base03), so dimmed terminal text stays visible.
const SOLARIZED_ACCENTS = ['#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198'];
const SOLARIZED_DARK: Colours = {
  '--bg': '#002b36', '--term': '#002b36', '--panel': '#073642', '--panel-2': '#0a3a47' /* derived */,
  '--line': '#1b4b57' /* derived */, '--fg': '#a2afaf' /* derived from base1 */, '--mute': '#99a9aa' /* derived from base0 */,
  '--accent': '#9eae35', '--busy': '#c4a235', '--idle': '#9eae35' /* derived from green and yellow */,
  '--wait': '#e09474' /* derived from orange */, '--off': '#586e75',
  '--danger': '#eb8b8a' /* derived from red */, '--fg-2': '#9ba8a8' /* derived from base1 */, '--raise': '#0c404d' /* derived */,
  '--line-2': '#586e75', '--on-accent': '#002b36', '--cursor': '#93a1a1', '--selection': '#0f4f5f',
  ...ansi(['#073642', ...SOLARIZED_ACCENTS, '#eee8d5',
    '#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
};
const SOLARIZED_LIGHT: Colours = {
  '--bg': '#fdf6e3', '--term': '#fdf6e3', '--panel': '#eee8d5', '--panel-2': '#e6dfc9' /* derived */,
  '--line': '#d6cfb9' /* derived */, '--fg': '#073642', '--mute': '#4f6369' /* derived from base01 */,
  '--accent': '#586600' /* derived from green */, '--busy': '#785b00' /* derived from yellow */,
  '--idle': '#586600', '--wait': '#a83c10' /* derived from orange */, '--off': '#93a1a1',
  '--danger': '#b8221f' /* derived from red */, '--fg-2': '#4f6369', '--raise': '#e3dcc4' /* derived */,
  '--line-2': '#93a1a1', '--on-accent': '#fdf6e3', '--cursor': '#586e75', '--selection': '#e3dcc4',
  // Bright white is #ffffff rather than base3: base3 is this terminal's background itself.
  ...ansi(['#073642', ...SOLARIZED_ACCENTS, '#eee8d5',
    '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#ffffff']),
};

// Gruvbox dark, medium contrast.
const GRUVBOX_DARK: Colours = {
  '--bg': '#1d2021', '--term': '#282828', '--panel': '#32302f', '--panel-2': '#3c3836', '--line': '#504945',
  '--fg': '#ebdbb2', '--mute': '#bdae93', '--accent': '#b8bb26', '--busy': '#fabd2f', '--idle': '#b8bb26',
  '--wait': '#fe9640' /* derived from orange */, '--off': '#665c54', '--danger': '#fc9386' /* derived from red */,
  '--fg-2': '#d5c4a1', '--raise': '#46413e' /* derived */, '--line-2': '#665c54', '--on-accent': '#1d2021',
  '--cursor': '#ebdbb2', '--selection': '#504945',
  // Black is bg1 rather than the source's #282828: that is this terminal's background itself.
  ...ansi(['#3c3836', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
    '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
};

// Nord: Polar Night nord0–3, Snow Storm nord4–6, Frost nord7–10, Aurora nord11–15. Bright black is
// #616e88 (the brighter comment colour of Nord 0.2+) for legible dimmed text.
const NORD: Colours = {
  '--bg': '#272c36' /* derived */, '--term': '#2e3440', '--panel': '#2e3440', '--panel-2': '#3b4252',
  '--line': '#434c5e', '--fg': '#e5e9f0', '--mute': '#a8b0c0' /* derived */, '--accent': '#88c0d0',
  '--busy': '#ebcb8b', '--idle': '#a3be8c', '--wait': '#dba391' /* derived from nord12 */, '--off': '#4c566a',
  '--danger': '#e39fa5' /* derived from nord11 */, '--fg-2': '#d8dee9', '--raise': '#3b4252',
  '--line-2': '#4c566a', '--on-accent': '#2e3440', '--cursor': '#d8dee9', '--selection': '#434c5e',
  ...ansi(['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
    '#616e88', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
};

export const THEMES: readonly Theme[] = Object.freeze([
  { id: 'default', scheme: 'dark', colours: DEFAULT },
  { id: 'light', scheme: 'light', colours: LIGHT },
  { id: 'solarized-dark', scheme: 'dark', colours: SOLARIZED_DARK },
  { id: 'solarized-light', scheme: 'light', colours: SOLARIZED_LIGHT },
  { id: 'gruvbox-dark', scheme: 'dark', colours: GRUVBOX_DARK },
  { id: 'nord', scheme: 'dark', colours: NORD },
]);

/** The i18n key of a theme's name. */
const LABEL_KEYS: Readonly<Record<ThemeId, string>> = {
  'default': 'theme.default', 'light': 'theme.light', 'solarized-dark': 'theme.solarizedDark',
  'solarized-light': 'theme.solarizedLight', 'gruvbox-dark': 'theme.gruvboxDark', 'nord': 'theme.nord',
};
export const themeLabelKey = (id: ThemeId): string => LABEL_KEYS[id];

export function findTheme(id: unknown): Theme | null {
  return THEMES.find((theme) => theme.id === id) ?? null;
}

// ---------------------------------------------------------------- validation

// Only hexadecimal colours: what CSS and xterm.js both read, and nothing that could carry a url(),
// an expression or a second declaration into a CSS variable.
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const isColour = (value: unknown): value is string => typeof value === 'string' && HEX.test(value.trim());

export type PaletteError = { readonly key: string; readonly reason: 'unknown-variable' | 'not-a-colour' };
export type PaletteResult =
  | { readonly ok: true; readonly palette: Colours }
  | { readonly ok: false; readonly reason: 'not-json' | 'not-an-object'; readonly errors: readonly PaletteError[] }
  | { readonly ok: false; readonly reason: 'invalid-entries'; readonly errors: readonly PaletteError[] };

const known = new Set(VARIABLES);

/** An object of overrides: every key a known variable, every value a hexadecimal colour. */
export function validatePalette(input: unknown): PaletteResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'not-an-object', errors: [] };
  const errors: PaletteError[] = [];
  const palette: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!known.has(key)) errors.push({ key, reason: 'unknown-variable' });
    else if (!isColour(value)) errors.push({ key, reason: 'not-a-colour' });
    else palette[key] = value.trim().toLowerCase();
  }
  return errors.length ? { ok: false, reason: 'invalid-entries', errors } : { ok: true, palette: Object.freeze(palette) };
}

export function parsePalette(text: string): PaletteResult {
  if (!text.trim()) return { ok: true, palette: Object.freeze({}) };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'not-json', errors: [] }; }
  return validatePalette(value);
}

/** The palette as editable text: one variable per line, in the order of VARIABLES. */
export function formatPalette(palette: Colours): string {
  const keys = VARIABLES.filter((key) => Object.hasOwn(palette, key));
  if (!keys.length) return '{}';
  return `{\n${keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(palette[key])}`).join(',\n')}\n}`;
}

// ---------------------------------------------------------------- storage

export const THEME_KEY = 'mesh.theme';
export const PALETTE_KEY = 'mesh.palette';
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readJson(storage: StorageLike | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch { return null; }
}

// Without a storage (the browser blocks it) nothing is kept: the write reports a failure.
function writeJson(storage: StorageLike | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function readThemeId(storage: StorageLike | null): ThemeId {
  return findTheme(readJson(storage, THEME_KEY))?.id ?? 'default';
}

export function writeThemeId(storage: StorageLike | null, id: ThemeId): boolean {
  return writeJson(storage, THEME_KEY, id === 'default' ? null : id);
}

/** The stored overrides, or none when the entry is missing or no longer valid. */
export function readPalette(storage: StorageLike | null): Colours {
  const result = validatePalette(readJson(storage, PALETTE_KEY));
  return result.ok ? result.palette : Object.freeze({});
}

export function writePalette(storage: StorageLike | null, palette: Colours): boolean {
  return writeJson(storage, PALETTE_KEY, Object.keys(palette).length ? palette : null);
}

// ---------------------------------------------------------------- resolution

export function resolveColours(id: ThemeId, palette: Colours): Colours {
  return Object.freeze({ ...(findTheme(id) ?? THEMES[0]!).colours, ...palette });
}

export type TerminalTheme = Readonly<Record<'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground' | AnsiName, string>>;

/** The xterm.js theme of a set of colours: the pane's background is --term, its text --fg. */
export function terminalTheme(colours: Colours): TerminalTheme {
  const pick = (key: string): string => colours[key] ?? DEFAULT[key]!;
  const theme: Record<string, string> = {
    background: pick('--term'), foreground: pick('--fg'), cursor: pick('--cursor'),
    cursorAccent: pick('--term'), selectionBackground: pick('--selection'),
  };
  for (const name of ANSI_NAMES) theme[name] = pick(ansiVariable(name));
  return Object.freeze(theme) as TerminalTheme;
}

// WCAG 2.x relative luminance and contrast ratio, for the tests and the palette editor's warning.
type Rgba = readonly [number, number, number, number];

function rgba(hex: string): Rgba {
  let digits = hex.trim().slice(1);
  if (digits.length <= 4) digits = [...digits].map((c) => c + c).join('');
  const byte = (i: number): number => parseInt(digits.slice(i, i + 2), 16) / 255;
  return [byte(0), byte(2), byte(4), digits.length === 8 ? byte(6) : 1];
}

function luminance(colour: Rgba): number {
  const linear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(colour[0]) + 0.7152 * linear(colour[1]) + 0.0722 * linear(colour[2]);
}

/** The contrast of `foreground` drawn over `background`. A translucent foreground is measured as it
 *  shows, blended over the background. A translucent background lets through what lies under it,
 *  which is not known here: the ratio is then NaN ("could not be checked"). */
export function contrastRatio(foreground: string, background: string): number {
  const under = rgba(background);
  if (under[3] < 1) return Number.NaN;
  const over = rgba(foreground);
  const blend = (i: 0 | 1 | 2): number => over[i] * over[3] + under[i] * (1 - over[3]);
  const shown: Rgba = [blend(0), blend(1), blend(2), 1];
  const [light, dark] = [luminance(shown), luminance(under)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

// ---------------------------------------------------------------- the page

export type ApplyTarget = {
  readonly documentElement: { dataset: Record<string, string | undefined>; style: { setProperty(name: string, value: string): void; colorScheme: string } };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
};

/** Sets the variables on :root (inline, over style.css), the colour scheme and the theme-color.
 *  data-palette marks a custom palette: themes.css then routes style.css's literal colours through
 *  the variables under the default theme too, so an override such as --raise shows there. */
export function applyColours(target: ApplyTarget, id: ThemeId, colours: Colours, custom = false): void {
  const root = target.documentElement;
  const scheme = findTheme(id)?.scheme ?? 'dark';
  root.dataset['theme'] = id;
  if (custom) root.dataset['palette'] = 'custom';
  else delete root.dataset['palette'];
  root.dataset['scheme'] = scheme;
  root.style.colorScheme = scheme;
  for (const key of VARIABLES) if (colours[key]) root.style.setProperty(key, colours[key]);
  target.querySelector('meta[name="theme-color"]')?.setAttribute('content', colours['--panel'] ?? DEFAULT['--panel']!);
}

type Listener = (colours: Colours) => void;

export type Runtime = {
  readonly themes: readonly Theme[];
  current(): ThemeId;
  palette(): Colours;
  colours(): Colours;
  terminal(): TerminalTheme;
  use(id: ThemeId): boolean;
  setPalette(palette: Colours): boolean;
  onChange(listener: Listener): void;
  reload(): void;
};

export function createRuntime(target: ApplyTarget, storage: StorageLike | null): Runtime {
  const listeners: Listener[] = [];
  let id = readThemeId(storage);
  let palette = readPalette(storage);
  const apply = (): void => {
    const colours = resolveColours(id, palette);
    applyColours(target, id, colours, Object.keys(palette).length > 0);
    for (const listener of listeners) listener(colours);
  };
  apply();
  return Object.freeze({
    themes: THEMES,
    current: () => id,
    palette: () => palette,
    colours: () => resolveColours(id, palette),
    terminal: () => terminalTheme(resolveColours(id, palette)),
    use(next: ThemeId): boolean {
      if (!findTheme(next)) return false;
      id = next;
      const saved = writeThemeId(storage, next);
      apply();
      return saved;
    },
    setPalette(next: Colours): boolean {
      const result = validatePalette(next);
      if (!result.ok) return false;
      palette = result.palette;
      const saved = writePalette(storage, palette);
      apply();
      return saved;
    },
    // Re-reads both entries: another tab of this browser changed them.
    reload(): void {
      id = readThemeId(storage);
      palette = readPalette(storage);
      apply();
    },
    onChange(listener: Listener): void { listeners.push(listener); },
  });
}

function install(): Runtime | null {
  if (typeof window === 'undefined' || !window.document) return null;
  let storage: StorageLike | null = null;
  try { storage = window.localStorage; } catch { /* storage blocked: the default theme */ }
  const runtime = createRuntime(window.document as unknown as ApplyTarget, storage);
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY || event.key === PALETTE_KEY || event.key === null) runtime.reload();
  });
  return runtime;
}

export const runtime: Runtime | null = install();
