// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A modal <dialog> as browsers run it, for unit tests: one modal at a time, `close()` hides it at
// once, and the `close` event fires later, in its own task (the HTML spec queues it). A listener
// can therefore see the event after the dialog was opened again. As in the spec, `showModal()` on
// a dialog already open as a modal returns without effect, and Escape fires `cancel` and then
// closes the dialog with its `returnValue` unchanged.

type Listener = Readonly<{type: string; handler: () => void; once: boolean}>;

export class FakeDialog {
  open = false;
  returnValue = '';
  /** The request id the prompt last described, set by the test's describe port. */
  shows = '';
  private modal = false;
  private listeners: Listener[] = [];

  addEventListener(type: string, handler: () => void, options?: {once?: boolean}): void {
    this.listeners.push({type, handler, once: options?.once === true});
  }

  removeEventListener(type: string, handler: () => void): void {
    this.listeners = this.listeners.filter(listener => listener.type !== type || listener.handler !== handler);
  }

  /** A non-modal open, only so that `showModal()` can be checked against it. */
  show(): void {
    if (this.open) return;
    this.open = true;
  }

  showModal(): void {
    if (this.open && this.modal) return;
    if (this.open) throw new Error('InvalidStateError: the dialog is open but not modal');
    this.open = true;
    this.modal = true;
  }

  close(value?: string): void {
    if (!this.open) return;
    this.open = false;
    this.modal = false;
    if (value !== undefined) this.returnValue = value;
    setTimeout(() => this.fire('close'), 0);
  }

  /** A button of the dialog's `<form method="dialog">`. */
  click(value: string): void { this.close(value); }

  /** The Escape key on an open modal dialog: `cancel`, then a close that keeps `returnValue`. */
  escape(): void {
    if (!this.open || !this.modal) return;
    this.fire('cancel');
    this.close();
  }

  private fire(type: string): void {
    const listeners = this.listeners;
    this.listeners = listeners.filter(listener => listener.type !== type || !listener.once);
    for (const listener of listeners) if (listener.type === type) listener.handler();
  }
}

/** Let queued tasks (close events) and the promise chains they settle run. */
export const settle = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** Run every pending promise reaction, but no task: a queued `close` event has not fired after it. */
export const drainMicrotasks = async (): Promise<void> => {
  for (let round = 0; round < 100; round += 1) await Promise.resolve();
};
