// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The answer drafts as the page shows them: read from an answer slot (`[data-work-answer-slot]`, its text field and the
 * pre-built answers ticked) when the owner types, and put back into the slots of the questions shown after the view is
 * drawn again. The drafts themselves are kept by static/work-view-state.ts. Values only ever go through `value` and
 * `checked`; nothing is built from the text.
 */

import type { Draft } from './work-view-state.ts';

const SLOT = '[data-work-answer-slot]';
const FIELD = '.work-answer-input';
const CHOICE = '.work-answer-choice-input';

/** The answer slot an event of the page came from, with its question id; null when it did not come from one. */
export function slotOf(target: EventTarget | null): { question: string; slot: HTMLElement } | null {
  if (!(target instanceof Element) || !target.matches(`${FIELD}, ${CHOICE}`)) return null;
  const slot = target.closest<HTMLElement>(SLOT), question = slot?.dataset.workAnswerSlot;
  return slot && question ? { question, slot } : null;
}

/** What the owner has put in a slot so far; null for an empty field with nothing ticked (the owner cleared it). */
export function draftIn(slot: HTMLElement, at: number): Draft | null {
  const text = slot.querySelector<HTMLTextAreaElement>(FIELD)?.value ?? '';
  const picked = [...slot.querySelectorAll<HTMLInputElement>(CHOICE)].filter(input => input.checked).map(input => input.value);
  if (text === '' && picked.length === 0) return null;
  return { text, picked, edit: slot.querySelector('.work-answer-form-edit') !== null, at };
}

/** Put a draft into a slot's form. */
function fill(slot: HTMLElement, draft: Draft): void {
  for (const input of slot.querySelectorAll<HTMLInputElement>(CHOICE)) input.checked = draft.picked.includes(input.value);
  const field = slot.querySelector<HTMLTextAreaElement>(FIELD);
  if (field) field.value = draft.text;
}

/** The draft of a correction: its form opens from the question's "Edit answer" button, without moving the focus. */
function openEdit(scope: HTMLElement, question: string): void {
  const area = [...scope.querySelectorAll<HTMLElement>('[data-work-answer-for]')].find(node => node.dataset.workAnswerFor === question);
  const open = area?.querySelector<HTMLButtonElement>('.work-answer-edit-open');
  if (!open) return;
  const focused = document.activeElement;
  open.click();
  if (focused instanceof HTMLElement && focused !== document.activeElement) focused.focus({ preventScroll: true });
}

/** Put the drafts back under the questions of `scope` that offer the form. A first answer's field that already holds
 *  text is kept; a correction's form, which opens filled with the current answer, takes the draft. A form being sent
 *  (read-only) is left alone. */
export function fillDrafts(scope: HTMLElement, drafts: ReadonlyMap<string, Draft>): void {
  if (drafts.size === 0) return;
  for (const [question, draft] of drafts) if (draft.edit) openEdit(scope, question);
  for (const slot of scope.querySelectorAll<HTMLElement>(SLOT)) {
    const draft = drafts.get(slot.dataset.workAnswerSlot ?? ''), field = slot.querySelector<HTMLTextAreaElement>(FIELD);
    if (!draft || !field || field.readOnly) continue;
    const editing = slot.querySelector('.work-answer-form-edit') !== null;
    if (editing === draft.edit && (field.value === '' || editing)) fill(slot, draft);
  }
}
