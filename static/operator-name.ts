// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's display name: a runner setting ("runner_settings" of GET /api/config, written by the
// owner from the Configuration dialog) that the labels saying who a question or an answer waits for or
// comes from can use ("Waiting for an answer from Camille"). Pure helpers, shared by the Projects view
// bundle and the Configuration dialog bundle.
//
// The name is text typed by a person: it is only ever passed as a translation parameter and shown
// through text nodes. An empty or unreadable name means the wording without a name.

export type OperatorTranslate = (key: string, params?: Record<string, string | number>) => string;

export const OPERATOR_NAME_MAX = 40;
/** Sent on the window by the Configuration dialog after a save; its detail is the saved name. */
export const OPERATOR_NAME_EVENT = 'mesh:operator-name';

/** Control, format (bidirectional marks, zero-width characters), surrogate, private-use, unassigned and
 *  line or paragraph separator characters, and the invisible or blank-looking ones of other categories (combining
 *  grapheme joiner, Hangul fillers, Mongolian variation selectors, Braille blank, object replacement, variation
 *  selectors): the ones the server refuses in a runner setting (launchsettings.py). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180b-\u180d\u180f\u2800\u3164\uffa0\ufffc\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
/** At most this many combining marks in a row (after NFC), as on the server: more piles up out of the line. */
export const OPERATOR_NAME_MAX_MARKS = 3;
const MARK_RUN = new RegExp(`[\\p{Mn}\\p{Me}]{${OPERATOR_NAME_MAX_MARKS + 1},}`, 'gu');

/** The keys of one label: without a name, with a name, and with a name that starts with a vowel (French
 *  elides "de" into "d'" there; other languages give the same text to both). */
export type OperatorLabelKeys = Readonly<{ plain: string; named: string; elided: string }>;

export const OPERATOR_LABELS = {
  waiting: { plain: 'work.question.waiting', named: 'work.question.waitingNamed', elided: 'work.question.waitingNamedElided' },
  verified: { plain: 'work.answer.verified', named: 'work.answer.verifiedNamed', elided: 'work.answer.verifiedNamedElided' },
  relayed: { plain: 'work.answer.relayed', named: 'work.answer.relayedNamed', elided: 'work.answer.relayedNamedElided' },
  unrelayed: { plain: 'work.answer.unrelayed', named: 'work.answer.unrelayedNamed', elided: 'work.answer.unrelayedNamedElided' },
  superseded: { plain: 'work.answer.superseded', named: 'work.answer.supersededNamed', elided: 'work.answer.supersededNamedElided' },
  /** An earlier answer of the operator that a correction of theirs replaced (an edit). */
  replaced: { plain: 'work.answer.verifiedReplaced', named: 'work.answer.verifiedReplacedNamed', elided: 'work.answer.verifiedReplacedNamedElided' },
} as const satisfies Record<string, OperatorLabelKeys>;

export type OperatorLabelId = keyof typeof OPERATOR_LABELS;

/** The form a typed name is checked, saved and counted in, as the server does: NFC, trimmed. Lengths are counted
 *  in code points (`[...text].length`), never in UTF-16 units. */
export function normalizeOperatorName(typed: string): string {
  return typed.normalize('NFC').trim();
}

/** A name fit to show: hidden characters removed, NFC, trimmed, runs of combining marks cut to
 *  OPERATOR_NAME_MAX_MARKS, at most OPERATOR_NAME_MAX characters; "" for anything that is not text. The server
 *  already refuses such names; this guards the display anyway. */
export function cleanOperatorName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = normalizeOperatorName(raw.replace(HIDDEN, ''))
    .replace(MARK_RUN, run => [...run].slice(0, OPERATOR_NAME_MAX_MARKS).join(''));
  return [...name].slice(0, OPERATOR_NAME_MAX).join('').trim();
}

/** Why a typed name cannot be saved, or null. Checked on its normalised form (normalizeOperatorName). */
export function operatorNameProblem(typed: string): 'tooLong' | 'invalid' | null {
  const name = normalizeOperatorName(typed);
  if (new RegExp(HIDDEN.source, 'u').test(name) || new RegExp(MARK_RUN.source, 'u').test(name)) return 'invalid';
  return [...name].length > OPERATOR_NAME_MAX ? 'tooLong' : null;
}

/** The operator name of a GET /api/config answer (or of a runner settings write answer); "" when absent. */
export function operatorNameOfConfig(raw: unknown): string {
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return cleanOperatorName(field(field(field(raw, 'runner_settings'), 'values'), 'operator_name'));
}

/** Where French elides "de" into "d'", applied to the decomposed (NFD) name so that an accented vowel counts: a vowel,
 *  æ or œ; an h, taken as mute as in nearly every first name (d'Hélène, d'Hugo; a rare aspirated h reads d' too); a y
 *  before a consonant (d'Yves), not before a vowel, where it is a consonant (de Yann). */
const ELIDES = new RegExp('^(?:[aeiouh\\u00e6\\u0153]|y[^aeiouy])', 'iu');

/** The label `id` with the operator's name when there is one, else the wording without a name. The name sits between
 *  FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE, so that a right-to-left name never reorders the sentence around
 *  it; the whole label stays plain text. */
export function operatorLabel(t: OperatorTranslate, id: OperatorLabelId, name: string,
  params: Readonly<Record<string, string | number>> = {}): string {
  const keys: OperatorLabelKeys = OPERATOR_LABELS[id];
  const shown = cleanOperatorName(name);
  if (shown === '') return t(keys.plain, { ...params });
  return t(ELIDES.test(shown.normalize('NFD')) ? keys.elided : keys.named, { ...params, name: `\u2068${shown}\u2069` });
}
