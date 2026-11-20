// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Correcting an answer the owner already gave. The tracker is append-only: a correction is a new owner answer that
 * supersedes the earlier one, which stays in the history. This module renders that history (the current answer, the
 * earlier ones folded under it) and the "Edit answer" button that opens the answer form prefilled.
 */

import { answerForm } from './work-answer-form.ts';
import type { AnswerSender } from './work-answer-form.ts';
import { currentOwnerAnswer, earlierAnswers, prefillOf } from './work-answer-options.ts';
import { button, el } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { Answer, Question } from './work-types.ts';

/**
 * The answers of a question as list nodes. Once the owner has answered, the answers the current one replaces (relayed
 * ones, earlier owner answers) are folded in a closed disclosure before it; the current one says when it is an edit.
 */
export function answerHistory(ctx: ViewContext, answers: readonly Answer[],
  item: (answer: Answer, edited: boolean) => HTMLElement): HTMLElement[] {
  const current = currentOwnerAnswer(answers), earlier = earlierAnswers(answers);
  if (!current || earlier.length === 0) return [el('ul', 'work-answer-list', ...answers.map(answer => item(answer, false)))];
  const folded = el('details', 'work-answer-history',
    el('summary', 'work-answer-history-summary', ctx.t('work.answer.earlier', { n: earlier.length })),
    el('ul', 'work-answer-list', ...earlier.map(answer => item(answer, false))));
  // The item renders the "edited" mark itself, inside the text the operator name rewrites (work-operator-label.ts).
  return [folded, el('ul', 'work-answer-list', item(current, earlier.some(answer => answer.ownerVerified)))];
}

/** The "Edit answer" button of a question the owner answered; it opens the prefilled form in a reply slot, and the
 *  form's Cancel puts the button back. */
export function editControl(ctx: ViewContext, sender: AnswerSender, question: Question): HTMLElement {
  const holder = el('div', 'work-answer-edit');
  const open = button('btn work-answer-edit-open', ctx.t('work.answer.edit'), () => {
    const slot = el('div', 'work-answer-slot');
    slot.dataset.workAnswerSlot = question.id;
    const cancel = (): void => {
      slot.replaceWith(open);
      open.focus();
    };
    slot.append(answerForm(ctx, sender, question, { prefill: prefillOf(question), cancel }));
    open.replaceWith(slot);
    slot.querySelector<HTMLElement>('.work-answer-choice-input, .work-answer-input')?.focus();
  });
  open.setAttribute('aria-describedby', `work-answer-edit-hint-${(ctx.answerScope ?? '') + question.id}`);
  const hint = el('span', 'work-answer-edit-hint sr-only', ctx.t('work.answer.editHint'));
  hint.id = `work-answer-edit-hint-${(ctx.answerScope ?? '') + question.id}`;
  holder.append(open, hint);
  return holder;
}
