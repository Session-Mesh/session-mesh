// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The owner's answer form of an open question, in the reserved slot of the task sheet: the pre-built answers of the
 * question when it has some (work-answer-choices.ts), then the free-text field. It sends the text and the choices and
 * shows only the outcome; it never shows the answer itself: the answer appears when the task is read again, as
 * recorded. In edit mode it starts from the owner's current answer and sends a correction that supersedes it.
 */

import { button, el } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { AnswerExtra, WorkErrorKind } from './work-api.ts';
import { choiceControls } from './work-answer-choices.ts';
import type { ChoiceControls } from './work-answer-choices.ts';
import { composeAnswer } from './work-answer-options.ts';
import type { Prefill } from './work-answer-options.ts';
import type { Question } from './work-types.ts';

/** Why a send did not record an answer (the form stays, except for `unavailable`). */
export type AnswerFailure = 'empty' | 'too-long' | 'unavailable' | 'auth' | 'invalid' | 'missing' | 'busy' | 'network' | 'failed';

export type AnswerSender = Readonly<{
  /** False once the server said that work-write is not installed. */
  available: () => boolean;
  /** Send the answer. On success, or when the question already has an answer from the owner, the sender reads the
   *  task again (the form is replaced) and resolves to null; otherwise to the failure to show. */
  submit: (question: string, answerText: string, extra?: AnswerExtra) => Promise<AnswerFailure | null>;
}>;

/** An edit of the owner's answer: what the form starts from, and how to close it without sending. */
export type EditMode = Readonly<{ prefill: Prefill; cancel: () => void }>;

/** The bound of the writer, in characters (code points). */
export const MAX_ANSWER = 2000;

const FAILURE_KEYS: Readonly<Record<AnswerFailure, string>> = {
  empty: 'work.answer.empty', 'too-long': 'work.answer.tooLong', unavailable: 'work.answer.unavailable',
  auth: 'work.answer.auth', invalid: 'work.answer.invalid', missing: 'work.answer.missing', busy: 'work.answer.busy',
  network: 'work.answer.network', failed: 'work.answer.failed',
};

/** The failure shown for an error of the relay (a conflict is not a failure: the task is read again). */
export function failureOfKind(kind: WorkErrorKind): AnswerFailure {
  switch (kind) {
    case 'not-available': return 'unavailable';
    case 'auth': return 'auth';
    case 'invalid': case 'shape': return 'invalid';
    case 'missing': return 'missing';
    case 'busy': return 'busy';
    case 'network': case 'aborted': return 'network';
    default: return 'failed';
  }
}

/** The note shown in place of the form when work-write is not installed. */
export function unavailableNote(ctx: ViewContext): HTMLElement {
  return el('p', 'work-answer-unavailable work-mute', ctx.t('work.answer.unavailable'));
}

/** A local check before sending: blank, or over the bound. */
export function localFailure(answerText: string): AnswerFailure | null {
  if (answerText.trim() === '') return 'empty';
  return [...answerText].length > MAX_ANSWER ? 'too-long' : null;
}

type Parts = Readonly<{
  form: HTMLFormElement; input: HTMLTextAreaElement; send: HTMLButtonElement; status: HTMLElement; choices: ChoiceControls | null;
}>;

function textField(suffix: string, question: Question, edit: EditMode | undefined): HTMLTextAreaElement {
  const input = el('textarea', 'work-answer-input');
  // maxLength counts UTF-16 units: twice the bound lets 2000 characters outside the BMP (emoji) in; localFailure
  // then checks the bound in characters, as the writer does.
  Object.assign(input, { id: `work-answer-input-${suffix}`, rows: question.kind === 'multi' ? 2 : 3, maxLength: 2 * MAX_ANSWER, spellcheck: true });
  if (edit) input.value = edit.prefill.text;
  return input;
}

function actions(ctx: ViewContext, edit: EditMode | undefined): { row: HTMLElement; send: HTMLButtonElement } {
  const send = el('button', 'btn work-answer-send', ctx.t(edit ? 'work.answer.sendEdit' : 'work.answer.send'));
  send.type = 'submit';
  const cancel = edit ? button('btn work-answer-cancel', ctx.t('work.answer.cancel'), edit.cancel) : null;
  return { row: el('div', 'work-answer-actions', cancel, send), send };
}

function parts(ctx: ViewContext, question: Question, edit: EditMode | undefined): Parts {
  const suffix = (ctx.answerScope ?? '') + (edit ? 'edit-' : '') + question.id.replace(/[^A-Za-z0-9-]/g, '_');
  const input = textField(suffix, question, edit);
  const status = el('p', 'work-answer-status');
  Object.assign(status, { id: `work-answer-status-${suffix}` });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  input.setAttribute('aria-describedby', status.id);
  const choices = choiceControls(ctx, question.kind, question.options, suffix, input, edit?.prefill.picked);
  // With checkboxes the field is the "other" answer, beside the picked options; else it holds the answer itself.
  const label = el('label', 'work-answer-label', ctx.t(choices && question.kind === 'multi' ? 'work.answer.otherLabel'
    : choices ? 'work.answer.labelOrOwn' : 'work.answer.label'));
  label.htmlFor = input.id;
  const { row, send } = actions(ctx, edit);
  const form = el('form', `work-answer-form${edit ? ' work-answer-form-edit' : ''}`, choices?.fieldset, label, input, row, status);
  form.noValidate = true;
  return { form, input, send, status, choices };
}

function setBusy(p: Parts, busy: boolean): void {
  p.send.disabled = busy;
  p.input.readOnly = busy;
  p.choices?.setBusy(busy);
  p.form.setAttribute('aria-busy', String(busy));
}

/** Show a failure in the form's live region and give the field back; `unavailable` swaps the form for the note. */
function showFailure(ctx: ViewContext, p: Parts, failure: AnswerFailure): void {
  if (failure === 'unavailable') {
    p.form.replaceWith(unavailableNote(ctx));
    return;
  }
  p.status.textContent = ctx.t(FAILURE_KEYS[failure]);
  p.status.dataset.state = 'error';
  setBusy(p, false);
  p.input.focus();
}

/** The answer form of a question; with `edit`, the correction of the owner's current answer. */
export function answerForm(ctx: ViewContext, sender: AnswerSender, question: Question, edit?: EditMode): HTMLFormElement {
  const p = parts(ctx, question, edit);
  let sending = false;
  p.form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending) return;   // a second submit while the first is in flight sends nothing
    const answer = composeAnswer(question.kind, p.choices?.picked() ?? [], p.input.value, p.choices?.label);
    const local = localFailure(answer.text);
    if (local) return showFailure(ctx, p, local);
    sending = true;
    setBusy(p, true);
    p.status.textContent = ctx.t('work.answer.sending');
    p.status.dataset.state = 'sending';
    const extra: AnswerExtra = { edit: edit !== undefined, choices: answer.choices };
    void sender.submit(question.id, answer.text, extra).then(failure => failure, (): AnswerFailure => 'failed').then(failure => {
      sending = false;
      if (failure) showFailure(ctx, p, failure);
    });
  });
  return p.form;
}
