// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pure translation of OpenCode 2's plugin events (ctx.event.subscribe) into Session Mesh's hook events
// (POST /api/event, the same v0 envelope as for OpenCode 1 and for Claude's hooks).
//
// OpenCode 2 events carry their session in ``data.sessionID``, except a form, whose session is in
// ``data.form.sessionID`` (the ``form.created`` event; its ``form.replied`` / ``form.cancelled``
// follow-ups carry ``data.sessionID`` and the form ``data.id``). Verified on OpenCode 2.3.0.
//
// A sub-agent runs in its own session, and nothing in these events says that a session is a child.
// The state is therefore computed from every session at once, which is safe whatever the sessions are:
//   waiting_*  while any permission request or question form is open,
//   working    while any session has an execution in progress,
//   done       only when none has (a sub-agent finishing never reports the terminal idle).
// The conversation to resume is the root one: a session whose execution starts while no other is
// running. A sub-agent's execution starts inside its parent's turn, so it never names the conversation.

export type MeshEventType = 'working' | 'waiting_permission' | 'waiting_question' | 'done' | 'error';

export interface MeshEvent {
  type: MeshEventType;
  at: number;
  detail: {source: 'opencode'; hook: string; seq: number; session?: string};
}

export interface OpenCodeV2Event {
  type?: unknown;
  data?: unknown;
}

const MAX_HOOK = 64;
const SESSION_ID = /^ses_[0-9A-Za-z]{8,60}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export class EventTranslatorV2 {
  private readonly running = new Set<string>();
  private readonly permissions = new Map<string, string | null>();   // request id -> session
  private readonly questions = new Map<string, string | null>();     // form id -> session
  private root: string | null = null;
  private last: MeshEventType | null = null;
  private lastEnd: MeshEventType = 'done';
  // Each event is its own HTTP request and two can arrive out of order: the server keeps the one with
  // the higher number. Starting from the clock keeps the numbers rising across an OpenCode restart.
  private seq: number;

  constructor(now: number = Date.now()) {
    this.seq = now;
  }

  private state(): MeshEventType {
    if (this.permissions.size > 0) return 'waiting_permission';
    if (this.questions.size > 0) return 'waiting_question';
    return this.running.size > 0 ? 'working' : this.lastEnd;
  }

  private drop(session: string | null): void {
    if (session === null) return;
    for (const pending of [this.permissions, this.questions]) {
      for (const [id, owner] of pending) if (owner === session) pending.delete(id);
    }
  }

  private apply(type: string, data: Record<string, unknown> | null): boolean {
    const session = text(data?.sessionID);
    switch (type) {
      case 'session.execution.started':
        if (session === null) return false;
        if (this.running.size === 0) this.root = session;
        this.running.add(session);
        return true;
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
      case 'session.execution.failed':
        if (session === null) return false;
        this.running.delete(session);
        this.drop(session);
        this.lastEnd = type === 'session.execution.failed' ? 'error' : 'done';
        return true;
      case 'permission.asked': {
        const id = text(data?.id);
        if (id === null) return false;
        this.permissions.set(id, session);
        return true;
      }
      case 'permission.replied':
      case 'permission.rejected': {
        const id = text(data?.requestID) ?? text(data?.id);
        return id !== null && this.permissions.delete(id);
      }
      case 'form.created': {
        const form = record(data?.form);
        const id = text(form?.id);
        // Other kinds of form are not a question put to the user by the model.
        if (id === null || record(form?.metadata)?.kind !== 'question') return false;
        this.questions.set(id, text(form?.sessionID));
        return true;
      }
      case 'form.replied':
      case 'form.cancelled': {
        const id = text(data?.id);
        return id !== null && this.questions.delete(id);
      }
      default:
        return false;
    }
  }

  translate(event: OpenCodeV2Event, now: number = Date.now() / 1000): MeshEvent | null {
    if (typeof event.type !== 'string' || !this.apply(event.type, record(event.data))) return null;
    const type = this.state();
    if (type === this.last) return null;
    this.last = type;
    const detail: MeshEvent['detail'] = {source: 'opencode', hook: event.type.slice(0, MAX_HOOK), seq: ++this.seq};
    if (this.root !== null && SESSION_ID.test(this.root)) detail.session = this.root;
    return {type, at: now, detail};
  }
}
