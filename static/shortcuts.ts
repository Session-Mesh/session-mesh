// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Keyboard shortcut registry: a declarative table and the pure logic around it.
//
// No DOM here. The page (app.js) classifies the focus into a FocusKind, builds a KeyLike from
// the event and asks `resolve` which binding, if any, owns the key. Nothing is bound anywhere
// else: one capture-phase dispatcher on the document and the terminal's key handler both go
// through the same table, so a collision or a stolen terminal key is caught by `validate` (run
// by the unit tests) rather than discovered by a user.
//
// Why terminal keys matter: a terminal sends Ctrl+K, Ctrl+A, Ctrl+E... to the program in it (an
// agent's TUI, a shell, an editor). A binding that applies while the terminal has the focus may
// therefore only use Shift with the modifier, and never a chord a program reads.

/** Where the keyboard focus is when the key goes down. */
export type FocusKind = 'page' | 'field' | 'direct-line' | 'terminal' | 'modal';

/**
 * Where a binding is valid.
 * - `outside-terminal`: only when the focus is on the page itself (not in a terminal, a text
 *   field, the phone's input line or a modal dialog). The key then goes unchanged to whatever has
 *   the focus in every other case.
 * - `anywhere`: every focus except a modal dialog, the terminal included (the key is captured
 *   before the terminal sees it, and is not sent to the program).
 * - `terminal-captured`: only while a terminal has the focus (captured before the program).
 */
export type ShortcutContext = 'anywhere' | 'outside-terminal' | 'terminal-captured';

export type Platform = 'mac' | 'other';

/**
 * A key with its modifiers. `mod` is the platform's primary modifier: Cmd on macOS, Ctrl
 * elsewhere (and the other one of the two must then be up). `ctrl` is the Ctrl key itself on
 * every platform: what a terminal reads, even on macOS. `shift: 'any'` is for symbols whose
 * Shift state depends on the keyboard layout (`?`).
 */
export type Chord = {
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean | 'any';
  readonly alt: boolean;
};

/** The state of a keydown, the part of KeyboardEvent the registry reads. */
export type KeyLike = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
};

export type Binding = {
  /** Stable identifier, also the suffix of the label's catalog key (`shortcuts.<id>`). */
  readonly id: string;
  readonly chord: Chord;
  /** A different chord on macOS, when `mod` alone does not say it. */
  readonly mac?: Chord;
  readonly context: ShortcutContext;
  /** What the page does: a name looked up in the page's action map. Absent on an external entry. */
  readonly action?: string;
  /**
   * An existing shortcut handled elsewhere in the code, recorded here for collision detection
   * and for the help. The dispatcher never runs it, and the policy rules do not apply to it.
   */
  readonly external?: true;
};

export const MODIFIER_FREE_CONTEXT: ShortcutContext = 'outside-terminal';

const FOCUS_COVERED: Readonly<Record<ShortcutContext, readonly FocusKind[]>> = {
  'anywhere': ['page', 'field', 'direct-line', 'terminal'],
  'outside-terminal': ['page'],
  'terminal-captured': ['terminal'],
};

export const contextCovers = (context: ShortcutContext, focus: FocusKind): boolean =>
  FOCUS_COVERED[context].includes(focus);

/** Whether the binding can fire while a terminal has the focus. */
export const appliesToTerminal = (binding: Binding): boolean => contextCovers(binding.context, 'terminal');

const chord = (key: string, options: {mod?: boolean; ctrl?: boolean; shift?: boolean | 'any'; alt?: boolean} = {}): Chord =>
  ({key, mod: options.mod ?? false, ctrl: options.ctrl ?? false, shift: options.shift ?? false, alt: options.alt ?? false});

/**
 * The table. Order is the order of the help.
 *
 * External entries describe what other code already does. They are listed so that no new
 * binding can take their chord and so that the help is complete; migrating them into the
 * dispatcher is a separate step.
 */
export const SHORTCUTS: readonly Binding[] = [
  {id: 'sessionSearch', chord: chord('k', {mod: true}), context: 'outside-terminal', action: 'sessions.search'},
  {id: 'sessionSearchAnywhere', chord: chord('k', {mod: true, shift: true}), context: 'anywhere', action: 'sessions.search'},
  {id: 'help', chord: chord('?', {shift: 'any'}), context: 'outside-terminal', action: 'shortcuts.help'},
  {id: 'newSession', chord: chord('n'), context: 'outside-terminal', external: true},
  {id: 'openPage', chord: chord('o'), context: 'outside-terminal', external: true},
  {id: 'copy', chord: chord('c', {ctrl: true}), context: 'terminal-captured', external: true},
  {id: 'copyAlways', chord: chord('c', {ctrl: true, shift: true}), context: 'terminal-captured', external: true},
  {id: 'paste', chord: chord('v', {ctrl: true}), context: 'terminal-captured', external: true},
  {id: 'newline', chord: chord('Enter', {shift: true}), context: 'terminal-captured', external: true},
  {id: 'newlineAlt', chord: chord('Enter', {alt: true}), context: 'terminal-captured', external: true},
];

/** `navigator.platform` (or userAgentData.platform) to a Platform. iPad keyboards use Cmd too. */
export const detectPlatform = (platform: string | undefined): Platform =>
  /^(mac|iphone|ipad|ipod)/i.test(platform ?? '') ? 'mac' : 'other';

const chordFor = (binding: Binding, platform: Platform): Chord =>
  platform === 'mac' && binding.mac ? binding.mac : binding.chord;

/** The modifiers a chord demands on a platform, as the event's four flags. */
const expectedFlags = (c: Chord, platform: Platform) => ({
  ctrlKey: c.ctrl || (c.mod && platform === 'other'),
  metaKey: c.mod && platform === 'mac',
  altKey: c.alt,
});

export function matches(binding: Binding, event: KeyLike, platform: Platform): boolean {
  const c = chordFor(binding, platform);
  const flags = expectedFlags(c, platform);
  if (event.ctrlKey !== flags.ctrlKey || event.metaKey !== flags.metaKey || event.altKey !== flags.altKey) return false;
  if (c.shift !== 'any' && event.shiftKey !== c.shift) return false;
  return event.key.toLowerCase() === c.key.toLowerCase();
}

/**
 * The binding that owns this key at this focus, or null: the key then goes unchanged to its
 * target. External entries never resolve (they are not run by the dispatcher). A key pressed
 * during an IME composition, or with a modal dialog open, resolves to nothing.
 */
export function resolve(table: readonly Binding[], event: KeyLike, focus: FocusKind, platform: Platform): Binding | null {
  if (event.isComposing === true || focus === 'modal') return null;
  for (const binding of table) {
    if (binding.external === true || !contextCovers(binding.context, focus)) continue;
    if (matches(binding, event, platform)) return binding;
  }
  return null;
}

/** Chords a terminal program reads: no binding that applies to a terminal may use one, shifted or not. */
export const TERMINAL_RESERVED: readonly Chord[] = [
  ...['a', 'b', 'c', 'd', 'e', 'f', 'h', 'k', 'l', 'n', 'p', 'r', 't', 'u', 'w', 'y', 'z', '[', ']', '\\', '_']
    .map(key => chord(key, {ctrl: true})),
  chord('b', {alt: true}), chord('f', {alt: true}), chord('d', {alt: true}), chord('Backspace', {alt: true}),
  chord('ArrowLeft', {ctrl: true}), chord('ArrowRight', {ctrl: true}),
  chord('ArrowUp', {ctrl: true}), chord('ArrowDown', {ctrl: true}),
  chord('Escape'), chord('Tab'), chord('Tab', {shift: true}), chord('Enter'), chord('Backspace'),
];

/** Chords a page cannot take from the browser (tabs and windows): binding one would never fire. */
export const BROWSER_RESERVED: readonly Chord[] = [
  chord('t', {mod: true}), chord('n', {mod: true}), chord('w', {mod: true}),
  chord('t', {mod: true, shift: true}), chord('n', {mod: true, shift: true}), chord('w', {mod: true, shift: true}),
  chord('Tab', {mod: true}), chord('Tab', {mod: true, shift: true}),
];

const sameChord = (a: Chord, b: Chord, platform: Platform): boolean => {
  const first = expectedFlags(a, platform), second = expectedFlags(b, platform);
  return a.key.toLowerCase() === b.key.toLowerCase() && first.ctrlKey === second.ctrlKey
    && first.metaKey === second.metaKey && first.altKey === second.altKey
    && (a.shift === b.shift || a.shift === 'any' || b.shift === 'any');
};

const hasModifier = (c: Chord): boolean => c.mod || c.ctrl || c.alt || c.shift === true;

const describe = (binding: Binding, platform: Platform): string => `${binding.id} (${formatChord(chordFor(binding, platform), platform)})`;

/**
 * Policy violations of a table, one message each (empty when the table is sound), checked on
 * both platforms:
 * 1. no two entries with an overlapping context share a chord;
 * 2. a new binding needs a modifier, except one valid only outside a terminal and a field;
 * 3. a binding that applies to a terminal needs Shift, and may not be a chord a terminal
 *    program reads;
 * 4. a binding may not be a chord the browser keeps for itself;
 * 5. a new binding names its action; an external one does not.
 */
export function validate(table: readonly Binding[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const platform of ['mac', 'other'] as const) {
    for (const [index, first] of table.entries()) {
      for (const second of table.slice(index + 1)) {
        const overlap = FOCUS_COVERED[first.context].some(focus => contextCovers(second.context, focus));
        if (overlap && sameChord(chordFor(first, platform), chordFor(second, platform), platform)) {
          problems.push(`${platform}: ${describe(first, platform)} collides with ${describe(second, platform)}`);
        }
      }
    }
    for (const binding of table) {
      if (binding.external === true) continue;
      const c = chordFor(binding, platform);
      if (!hasModifier(c) && binding.context !== MODIFIER_FREE_CONTEXT) {
        problems.push(`${platform}: ${describe(binding, platform)} has no modifier outside the ${MODIFIER_FREE_CONTEXT} context`);
      }
      if (appliesToTerminal(binding)) {
        if (TERMINAL_RESERVED.some(reserved => sameChord(reserved, c, platform))) {
          problems.push(`${platform}: ${describe(binding, platform)} is a key a terminal program reads`);
        } else if (c.shift !== true || !(c.mod || c.ctrl)) {
          problems.push(`${platform}: ${describe(binding, platform)} applies to a terminal and needs the modifier with Shift`);
        }
      }
      if (BROWSER_RESERVED.some(reserved => sameChord(reserved, c, platform))) {
        problems.push(`${platform}: ${describe(binding, platform)} is a chord the browser keeps`);
      }
    }
  }
  for (const binding of table) {
    if (ids.has(binding.id)) problems.push(`duplicate id ${binding.id}`);
    ids.add(binding.id);
    if (binding.external === true && binding.action !== undefined) problems.push(`${binding.id} is external and names an action`);
    if (binding.external !== true && binding.action === undefined) problems.push(`${binding.id} names no action`);
  }
  return problems;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** A chord as text: `Ctrl+Shift+K`, `Cmd+K`, `?`, `Shift+Enter`. */
export function formatChord(c: Chord, platform: Platform): string {
  const parts: string[] = [];
  if (c.ctrl || (c.mod && platform === 'other')) parts.push('Ctrl');
  if (c.mod && platform === 'mac') parts.push('Cmd');
  if (c.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (c.shift === true) parts.push('Shift');
  parts.push(KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return parts.join('+');
}

export type HelpEntry = {
  /** The binding's id: its label is the catalog key `shortcuts.<id>`. */
  readonly id: string;
  /** Where it applies: its caption is the catalog key `shortcuts.context.<context>`. */
  readonly context: ShortcutContext;
  readonly keys: string;
};

/** The help's rows, generated from the table for a platform. */
export const helpEntries = (table: readonly Binding[], platform: Platform): HelpEntry[] =>
  table.map(binding => ({id: binding.id, context: binding.context, keys: formatChord(chordFor(binding, platform), platform)}));
