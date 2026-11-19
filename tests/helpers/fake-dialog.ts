// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A modal <dialog> as browsers run it, for unit tests: one modal at a time, `close()` hides it at
// once, and the `close` event fires later, in its own task (the HTML spec queues it). A listener
// can therefore see the event after the dialog was opened again.

type Listener = Readonly<{handler: () => void; once: boolean}>;

export class FakeDialog {
  open = false;
  returnValue = '';
  /** The request id the prompt last described, set by the test's describe port. */
  shows = '';
  private listeners: Listener[] = [];

  addEventListener(type: string, handler: () => void, options?: {once?: boolean}): void {
    if (type === 'close') this.listeners.push({handler, once: options?.once === true});
  }

  removeEventListener(type: string, handler: () => void): void {
    if (type === 'close') this.listeners = this.listeners.filter(listener => listener.handler !== handler);
  }

  showModal(): void {
    if (this.open) throw new Error('InvalidStateError: the dialog is already open');
    this.open = true;
  }

  close(value?: string): void {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    setTimeout(() => this.fireClose(), 0);
  }

  /** A button of the dialog's `<form method="dialog">`. */
  click(value: string): void { this.close(value); }

  private fireClose(): void {
    const listeners = this.listeners;
    this.listeners = listeners.filter(listener => !listener.once);
    for (const listener of listeners) listener.handler();
  }
}

/** Let queued tasks (close events) and the promise chains they settle run. */
export const settle = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
