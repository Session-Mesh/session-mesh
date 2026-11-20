// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The pre-built answers of the owner's answer form: a fieldset of radio buttons (`single`, `yes_no`) or checkboxes
 * (`multi`) above the free-text field. A radio puts its label in the field, where the owner can still change it; the
 * field stays for any other answer. Option text is agent-written: it only ever becomes text nodes and input values.
 */

import { el } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { offeredChoices } from './work-answer-options.ts';
import type { QuestionKind } from './work-types.ts';

export type ChoiceControls = Readonly<{
  fieldset: HTMLFieldSetElement;
  /** The picked choices, in the order offered. */
  picked: () => string[];
  /** The label a choice puts in the field (translated for yes / no, the option itself otherwise). */
  label: (choice: string) => string;
  setBusy: (busy: boolean) => void;
}>;

const LEGEND_KEYS: Readonly<Record<Exclude<QuestionKind, 'text'>, string>> = {
  single: 'work.answer.pickOne', multi: 'work.answer.pickAll', yes_no: 'work.answer.pickOne',
};

function choiceLabel(ctx: ViewContext, kind: QuestionKind, choice: string): string {
  return kind === 'yes_no' ? ctx.t(choice === 'yes' ? 'work.answer.yes' : 'work.answer.no') : choice;
}

/** One choice: a native radio or checkbox inside its label, so the whole row (44 px high) is the target. */
function choiceRow(kind: QuestionKind, name: string, choice: string, label: string, index: number): { row: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input', 'work-answer-choice-input');
  Object.assign(input, { type: kind === 'multi' ? 'checkbox' : 'radio', name, value: choice, id: `${name}-${index}` });
  const row = el('label', 'work-answer-choice', input, el('span', 'work-answer-choice-text', label));
  row.htmlFor = input.id;
  return { row, input };
}

/** Keep a radio checked only while the field holds its label: a changed field is the owner's own answer. */
function syncWithField(inputs: readonly HTMLInputElement[], field: HTMLTextAreaElement, label: (choice: string) => string): void {
  for (const input of inputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      field.value = label(input.value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  field.addEventListener('input', () => {
    for (const input of inputs) if (input.checked && field.value.trim() !== label(input.value).trim()) input.checked = false;
  });
}

/**
 * The choices of a question, or null when it offers none (`text`, or no usable option). `picked` checks those
 * choices at the start (an edit); `field` is the form's text field. Ids are unique per form (`suffix`).
 */
export function choiceControls(ctx: ViewContext, kind: QuestionKind, options: readonly string[], suffix: string,
  field: HTMLTextAreaElement, picked: readonly string[] = []): ChoiceControls | null {
  const choices = offeredChoices(kind, options);
  if (kind === 'text' || choices.length === 0) return null;
  const name = `work-answer-choice-${suffix}`;
  const label = (choice: string): string => choiceLabel(ctx, kind, choice);
  const rows = choices.map((choice, index) => choiceRow(kind, name, choice, label(choice), index));
  const inputs = rows.map(({ input }) => input);
  for (const input of inputs) input.checked = picked.includes(input.value);
  if (kind !== 'multi') syncWithField(inputs, field, label);
  const fieldset = el('fieldset', `work-answer-choices work-answer-choices-${kind}`,
    el('legend', 'work-answer-legend', ctx.t(LEGEND_KEYS[kind])), el('div', 'work-answer-choice-list', ...rows.map(({ row }) => row)));
  return {
    fieldset, label,
    picked: () => inputs.filter(input => input.checked).map(input => input.value),
    setBusy: busy => { fieldset.disabled = busy; },
  };
}
