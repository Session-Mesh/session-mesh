// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The pure rules of the owner's answer choices: the kind of a question as the view reads it, the choices it offers,
 * the answer text and choices a send carries, and what an edit starts from. No DOM here (work-answer-choices.ts
 * renders them). Option text is agent-written data: it is compared and joined, never interpreted.
 */

import type { Answer, Question, QuestionKind } from './work-types.ts';

/** The bounds of work_ask's options, checked again here: an option over them (a hand-written line) is not offered. */
export const MAX_OPTIONS = 8;
export const MAX_OPTION = 100;
/** Between the picked options of a `multi` answer (an option never holds a newline: work_ask refuses it). */
export const MULTI_SEPARATOR = '\n';
/** The choices of a `yes_no` question, as stored; the form shows them translated. */
export const YES_NO: readonly string[] = ['yes', 'no'];

const KINDS: readonly QuestionKind[] = ['single', 'multi', 'text', 'yes_no'];

/** The kind the view uses: the stored one when it is known and fits the options (`text` and `yes_no` take none,
 *  `single` and `multi` need some); else `single` with options and `text` without (a question asked before kinds
 *  existed, a hand-written line, or a kind a later version added). The same rule as Work_questions.effective_kind. */
export function effectiveKind(kind: unknown, options: readonly string[]): QuestionKind {
  const known = KINDS.find(candidate => candidate === kind);
  if (options.length === 0) return known === 'yes_no' ? 'yes_no' : 'text';
  return known === 'single' || known === 'multi' ? known : 'single';
}

const characters = (value: string): number => [...value].length;

/** What the owner can pick: yes and no; the distinct, non-blank options within the bounds; nothing for `text`. */
export function offeredChoices(kind: QuestionKind, options: readonly string[]): readonly string[] {
  if (kind === 'yes_no') return YES_NO;
  if (kind === 'text') return [];
  const offered: string[] = [];
  for (const option of options) {
    if (offered.length === MAX_OPTIONS) break;
    if (option.trim() !== '' && characters(option) <= MAX_OPTION && !offered.includes(option)) offered.push(option);
  }
  return offered;
}

export type ComposedAnswer = Readonly<{ text: string; choices: readonly string[] }>;

/**
 * The text and choices a send carries. `single` and `yes_no`: the field holds the answer (a click puts the choice's
 * label there); the choice goes with it only while the field still says exactly that label. `multi`: the picked
 * options one per line, then the free text. `text`: the field alone.
 */
export function composeAnswer(kind: QuestionKind, picked: readonly string[], freeText: string,
  label: (choice: string) => string = choice => choice): ComposedAnswer {
  if (kind === 'multi') {
    const free = freeText.trim();
    return { text: [...picked, ...(free ? [free] : [])].join(MULTI_SEPARATOR), choices: [...picked] };
  }
  const choice = kind === 'text' ? undefined : picked[0];
  const kept = choice !== undefined && freeText.trim() === label(choice).trim();
  return { text: freeText, choices: kept ? [choice] : [] };
}

/** The latest owner-verified answer that nothing supersedes: the one the question stands on. */
export function currentOwnerAnswer(answers: readonly Answer[]): Answer | null {
  for (let index = answers.length - 1; index >= 0; index--) {
    const answer = answers[index]!;
    if (answer.ownerVerified && !answer.superseded) return answer;
  }
  return null;
}

/** The answers the current owner answer replaces, kept for the history (none while the owner has not answered). */
export function earlierAnswers(answers: readonly Answer[]): readonly Answer[] {
  const current = currentOwnerAnswer(answers);
  return current ? answers.filter(answer => answer !== current) : [];
}

export type Prefill = Readonly<{ text: string; picked: readonly string[] }>;

/** What an edit starts from: the current owner answer, its choices that are still offered, and, for `multi`, the free
 *  text after the picked lines. Empty when the owner answer is not in the list (a size bound left it out). */
export function prefillOf(question: Question): Prefill {
  const current = currentOwnerAnswer(question.answers);
  if (!current) return { text: '', picked: [] };
  const offered = offeredChoices(question.kind, question.options);
  const picked = current.choices.filter(choice => offered.includes(choice));
  if (question.kind !== 'multi') return { text: current.text, picked: picked.slice(0, 1) };
  const head = current.choices.join(MULTI_SEPARATOR);
  const rest = current.choices.length > 0 && current.text.startsWith(head) ? current.text.slice(head.length) : current.text;
  return { text: rest.replace(/^\n/, ''), picked };
}
