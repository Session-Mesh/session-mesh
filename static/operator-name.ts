// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's display name: a runner setting ("runner_settings" of GET /api/config, written by the
// owner from the Configuration dialog) that the labels saying who a question or an answer waits for or
// comes from can use ("Waiting for an answer from Mathias"). Pure helpers, shared by the Projects view
// bundle and the Configuration dialog bundle.
//
// The name is text typed by a person: it is only ever passed as a translation parameter and shown
// through text nodes. An empty or unreadable name means the wording without a name.

export type OperatorTranslate = (key: string, params?: Record<string, string | number>) => string;

export const OPERATOR_NAME_MAX = 40;
/** Sent on the window by the Configuration dialog after a save; its detail is the saved name. */
export const OPERATOR_NAME_EVENT = 'mesh:operator-name';

/** Control, format (bidirectional marks, zero-width characters), surrogate, private-use, unassigned and
 *  line or paragraph separator characters: the ones the server refuses in a runner setting. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** The keys of one label: without a name, with a name, and with a name that starts with a vowel (French
 *  elides "de" into "d'" there; other languages give the same text to both). */
export type OperatorLabelKeys = Readonly<{ plain: string; named: string; elided: string }>;

export const OPERATOR_LABELS = {
  waiting: { plain: 'work.question.waiting', named: 'work.question.waitingNamed', elided: 'work.question.waitingNamedElided' },
  verified: { plain: 'work.answer.verified', named: 'work.answer.verifiedNamed', elided: 'work.answer.verifiedNamedElided' },
  relayed: { plain: 'work.answer.relayed', named: 'work.answer.relayedNamed', elided: 'work.answer.relayedNamedElided' },
  unrelayed: { plain: 'work.answer.unrelayed', named: 'work.answer.unrelayedNamed', elided: 'work.answer.unrelayedNamedElided' },
  superseded: { plain: 'work.answer.superseded', named: 'work.answer.supersededNamed', elided: 'work.answer.supersededNamedElided' },
} as const satisfies Record<string, OperatorLabelKeys>;

export type OperatorLabelId = keyof typeof OPERATOR_LABELS;

/** A name fit to show: hidden characters removed, trimmed, at most OPERATOR_NAME_MAX characters; "" for
 *  anything that is not text. The server already refuses such names; this guards the display anyway. */
export function cleanOperatorName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(HIDDEN, '').trim()].slice(0, OPERATOR_NAME_MAX).join('').trim();
}

/** Why a typed name cannot be saved, or null. Leading and trailing blanks are dropped first. */
export function operatorNameProblem(typed: string): 'tooLong' | 'invalid' | null {
  const name = typed.trim();
  if (new RegExp(HIDDEN.source, 'u').test(name)) return 'invalid';
  return [...name].length > OPERATOR_NAME_MAX ? 'tooLong' : null;
}

/** The operator name of a GET /api/config answer (or of a runner settings write answer); "" when absent. */
export function operatorNameOfConfig(raw: unknown): string {
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return cleanOperatorName(field(field(field(raw, 'runner_settings'), 'values'), 'operator_name'));
}

/** Applied to the decomposed (NFD) name, so that an accented vowel counts; then æ and œ. Not "y" nor "h". */
const STARTS_WITH_VOWEL = new RegExp('^[aeiou\\u00e6\\u0153]', 'iu');

/** The label `id` with the operator's name when there is one, else the wording without a name. */
export function operatorLabel(t: OperatorTranslate, id: OperatorLabelId, name: string,
  params: Readonly<Record<string, string | number>> = {}): string {
  const keys: OperatorLabelKeys = OPERATOR_LABELS[id];
  const shown = cleanOperatorName(name);
  if (shown === '') return t(keys.plain, { ...params });
  return t(STARTS_WITH_VOWEL.test(shown.normalize('NFD')) ? keys.elided : keys.named, { ...params, name: shown });
}
