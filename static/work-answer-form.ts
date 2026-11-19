// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The owner's answer form of an open question, in the reserved slot of the task sheet. It sends the text and shows
 * only the outcome; it never shows the answer itself: the answer appears when the task is read again, as recorded.
 */

import { el } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { WorkErrorKind } from './work-api.ts';

/** Why a send did not record an answer (the form stays, except for `unavailable`). */
export type AnswerFailure = 'empty' | 'too-long' | 'unavailable' | 'auth' | 'invalid' | 'missing' | 'busy' | 'network' | 'failed';

export type AnswerSender = Readonly<{
  /** False once the server said that work-write is not installed. */
  available: () => boolean;
  /** Send the answer. On success, or when the question already has an answer from the owner, the sender reads the
   *  task again (the form is replaced) and resolves to null; otherwise to the failure to show. */
  submit: (question: string, answerText: string) => Promise<AnswerFailure | null>;
}>;

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

type Parts = Readonly<{ form: HTMLFormElement; input: HTMLTextAreaElement; send: HTMLButtonElement; status: HTMLElement }>;

function parts(ctx: ViewContext, questionId: string): Parts {
  const suffix = questionId.replace(/[^A-Za-z0-9-]/g, '_');
  const input = el('textarea', 'work-answer-input');
  Object.assign(input, { id: `work-answer-input-${suffix}`, rows: 3, maxLength: MAX_ANSWER, spellcheck: true });
  const status = el('p', 'work-answer-status');
  Object.assign(status, { id: `work-answer-status-${suffix}` });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  input.setAttribute('aria-describedby', status.id);
  const label = el('label', 'work-answer-label', ctx.t('work.answer.label'));
  label.htmlFor = input.id;
  const send = el('button', 'btn work-answer-send', ctx.t('work.answer.send'));
  send.type = 'submit';
  const form = el('form', 'work-answer-form', label, input, el('div', 'work-answer-actions', send), status);
  form.noValidate = true;
  return { form, input, send, status };
}

function setBusy(p: Parts, busy: boolean): void {
  p.send.disabled = busy;
  p.input.readOnly = busy;
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

export function answerForm(ctx: ViewContext, sender: AnswerSender, questionId: string): HTMLFormElement {
  const p = parts(ctx, questionId);
  let sending = false;
  p.form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending) return;   // a second submit while the first is in flight sends nothing
    const answerText = p.input.value;
    const local = localFailure(answerText);
    if (local) return showFailure(ctx, p, local);
    sending = true;
    setBusy(p, true);
    p.status.textContent = ctx.t('work.answer.sending');
    p.status.dataset.state = 'sending';
    void sender.submit(questionId, answerText).then(failure => failure, (): AnswerFailure => 'failed').then(failure => {
      sending = false;
      if (failure) showFailure(ctx, p, failure);
    });
  });
  return p.form;
}
