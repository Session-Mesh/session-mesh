// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pure translation of OpenCode's plugin events into Session Mesh's hook events
// (POST /api/event, the same v0 envelope that bin/mesh-event sends for Claude).
//
// This module holds no OpenCode export on purpose: OpenCode treats every export of a
// plugin module as a plugin, so the plugin file only re-exports a single function.

export type MeshEventType = 'working' | 'waiting_permission' | 'waiting_question' | 'done' | 'error';

export interface MeshEvent {
  type: MeshEventType;
  at: number;
  detail: {source: 'opencode'; hook: string; seq: number; session?: string};
}

export interface OpenCodeEvent {
  type?: unknown;
  properties?: unknown;
}

const MAX_HOOK = 64;
const SESSION_ID = /^ses_[0-9A-Za-z]{8,60}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function sessionOf(properties: Record<string, unknown> | null): string | null {
  const id = properties?.sessionID ?? record(properties?.info)?.id;
  return typeof id === 'string' ? id : null;
}

function kindOf(type: string, properties: Record<string, unknown> | null): MeshEventType | null {
  switch (type) {
    case 'session.status': {
      const status = record(properties?.status)?.type;
      if (status === 'busy' || status === 'retry') return 'working';
      return status === 'idle' ? 'done' : null;
    }
    case 'session.idle': return 'done';
    case 'session.error': return 'error';
    case 'permission.asked':
    case 'permission.updated': return 'waiting_permission';
    case 'question.asked': return 'waiting_question';
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected': return 'working';
    default: return null;
  }
}

/**
 * Tracks the sessions OpenCode starts for sub-agents (they have a parent): only the
 * root conversation says whether the terminal is idle or waiting for the user.
 * Consecutive identical states are not repeated, which keeps the endpoint's per-session
 * rate limit for real changes.
 */
export class EventTranslator {
  private readonly children = new Set<string>();
  private last: MeshEventType | null = null;
  // Each event is its own HTTP request and two can arrive out of order: the server keeps the one with
  // the higher number. Starting from the clock keeps the numbers rising across an OpenCode restart.
  private seq: number;

  constructor(now: number = Date.now()) {
    this.seq = now;
  }

  translate(event: OpenCodeEvent, now: number = Date.now() / 1000): MeshEvent | null {
    if (typeof event.type !== 'string') return null;
    const properties = record(event.properties);
    const session = sessionOf(properties);
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const parent = record(properties?.info)?.parentID;
      if (session !== null && typeof parent === 'string' && parent !== '') this.children.add(session);
      return null;
    }
    const fromChild = session !== null && this.children.has(session);
    const type = kindOf(event.type, properties);
    // A sub-agent's turns say nothing about the terminal, but its permission request blocks the root
    // conversation until the user answers: that one is reported, and its answer too.
    if (fromChild && !(event.type === 'permission.asked' || event.type === 'permission.updated'
      || event.type === 'permission.replied')) return null;
    if (type === null || type === this.last) return null;
    this.last = type;
    const detail: MeshEvent['detail'] = {source: 'opencode', hook: event.type.slice(0, MAX_HOOK), seq: ++this.seq};
    // The conversation to resume: Mesh cannot read it from the process (see discover.opencode_info).
    // A sub-agent's own conversation is never the one to resume.
    if (!fromChild && session !== null && SESSION_ID.test(session)) detail.session = session;
    return {type, at: now, detail};
  }
}
