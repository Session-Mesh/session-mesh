// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The agent hook model (docs/agent-hooks.md) as types over its one data file, agent-hooks.json: the
// generic events, the normalised event, the reactions a consumer may have, the consumers Mesh runs and
// the event sources (one per agent). Pure: reading the file is the caller's business (loadModel takes
// its text). The Python generators read the same file (agentmcp.hook_events); this module is what a
// TypeScript or future protocol source (an ACP client) would build on. Today only the tests import it:
// they check the generators against the table, and bin/mesh-event against the stateEnvelope oracle.

export const EVENTS = ['session_start', 'prompt_submit', 'tool_before', 'tool_after', 'tool_failure',
  'permission_request', 'notification', 'turn_end', 'turn_end_failure', 'session_end'] as const;
export type GenericEvent = typeof EVENTS[number];

export const REACTIONS = ['observe', 'inject_context', 'block'] as const;
export type Reaction = typeof REACTIONS[number];

export const SOURCE_KINDS = ['native_config', 'plugin', 'extension', 'wrapper', 'protocol', 'none'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export const NOTICES = ['permission', 'question', 'turn_completed', 'turn_failed'] as const;
export type Notice = typeof NOTICES[number];

export type StateKind = 'working' | 'waiting_permission' | 'waiting_question' | 'done' | 'error';

/** One occurrence of a generic event, as any source reports it: structured fields only, each bounded.
 *  No prompt, reply, tool input or output, path or free text of the agent is ever a field. */
export interface NormalisedEvent {
  schema: 1;
  event: GenericEvent;
  agent: string;
  native: string;            // the agent's own name of the hook, at most 64 characters
  at: number;                // epoch seconds, read when the hook ran
  conversation?: string;     // the agent's conversation id, validated by the source
  occurrence?: string;       // the agent's id of this prompt or tool call, for deduplication
  tool?: string;
  tool_use?: string;
  notice?: Notice;           // with event notification (or a question asked through a tool)
  error?: string;            // the agent's error code, at most 256 characters
}

export interface Consumer {
  name: string;
  reaction: Reaction;
  program: string;
  args?: string[];
  switch: string | null;
  cap_seconds?: number;    // documents work-read's cap: a test keeps it equal to Wr_context.cap_seconds
}

export interface SourceEvent { event: GenericEvent; native: string; label?: string }

export interface Source {
  agent: string;
  kind: SourceKind;
  install: string;
  timeout: {value: number; unit: 's' | 'ms'} | null;
  inject: Partial<Record<GenericEvent, string>>;
  events: SourceEvent[];
  subscriptions: Record<string, GenericEvent[]>;
  reason?: string;
}

export interface Model {
  schema: 1;
  events: {name: GenericEvent; fires: string}[];
  reactions: Record<Reaction, 'permitted' | 'not_permitted'>;
  payload: Record<string, unknown>;
  consumers: Consumer[];
  sources: Source[];
}

const isIn = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** The model, checked: every rule a generator relies on holds, else an Error says which one fails. */
export function loadModel(text: string): Model {
  const model = JSON.parse(text) as Model;
  const fail = (why: string): never => { throw new Error(`agent-hooks.json: ${why}`); };
  if (model.schema !== 1) fail('schema is not 1');
  if (model.events.map(e => e.name).join() !== EVENTS.join()) fail('events differ from the generic events');
  if (model.reactions.block !== 'not_permitted') fail('a consumer may not block an agent');
  const consumers = new Map(model.consumers.map(c => [c.name, c]));
  for (const consumer of model.consumers) {
    if (model.reactions[consumer.reaction] !== 'permitted') fail(`${consumer.name}: reaction ${consumer.reaction} is not permitted`);
  }
  for (const source of model.sources) {
    if (!isIn(SOURCE_KINDS, source.kind)) fail(`${source.agent}: unknown kind ${source.kind}`);
    if (source.kind === 'none' && !source.reason) fail(`${source.agent}: a source of kind none says why`);
    const natives = new Map(source.events.map(e => [e.event, e]));
    for (const entry of source.events) if (!isIn(EVENTS, entry.event)) fail(`${source.agent}: unknown event ${entry.event}`);
    for (const [name, events] of Object.entries(source.subscriptions)) {
      const consumer = consumers.get(name) ?? fail(`${source.agent}: unknown consumer ${name}`);
      for (const event of events) {
        if (!natives.has(event)) fail(`${source.agent}: ${name} subscribes ${event}, which the source does not emit`);
        if (consumer.reaction === 'inject_context' && !source.inject[event]) {
          fail(`${source.agent}: ${name} needs a context format for ${event}`);
        }
      }
    }
  }
  return model;
}

export function source(model: Model, agent: string): Source {
  const found = model.sources.find(s => s.agent === agent);
  if (!found) throw new Error(`no source for ${agent}`);
  return found;
}

/** The native hooks a consumer is installed on for one agent, in the order the generator writes them. */
export function installed(model: Model, agent: string, consumer: string): SourceEvent[] {
  const row = source(model, agent);
  return (row.subscriptions[consumer] ?? []).map(event => row.events.find(e => e.event === event)!);
}

/** The session state each generic event, and each notice of a notification, gives. Part of the test
 *  oracle below, not of the table: in production, the per-agent decoding and this mapping live in
 *  bin/mesh-event. */
const STATE_KINDS: Partial<Record<GenericEvent, StateKind>> = {
  session_start: 'done', prompt_submit: 'working', tool_before: 'working', tool_after: 'working',
  tool_failure: 'working', permission_request: 'waiting_permission', turn_end: 'done', turn_end_failure: 'error',
};
const NOTICE_STATE_KINDS: Record<Notice, StateKind> = {
  permission: 'waiting_permission', question: 'waiting_question', turn_completed: 'done', turn_failed: 'error',
};

/** A test oracle, not a production path: the envelope POST /api/event would receive for one normalised
 *  event from a state consumer written against the model, or null when the event says nothing about the
 *  state. tests/agent-hooks-model.test.ts checks that bin/mesh-event, which does its own per-agent
 *  decoding, sends exactly this (without its size trimming) for each agent's native hooks. */
export function stateEnvelope(event: NormalisedEvent): Record<string, unknown> | null {
  const kind = event.notice ? NOTICE_STATE_KINDS[event.notice] : STATE_KINDS[event.event];
  if (!kind) return null;
  const detail: Record<string, string> = {source: event.agent, hook: event.native};
  if (event.tool !== undefined) detail.tool = event.tool;
  if (event.tool_use !== undefined) detail.tool_use_id = event.tool_use;
  if (event.error !== undefined) detail.error = event.error;
  if (event.conversation !== undefined) detail.session = event.conversation;
  const envelope: Record<string, unknown> = {type: kind, at: event.at, detail};
  const id = event.occurrence === undefined ? undefined : `${event.native}:${event.occurrence}`;
  if (id !== undefined && id.length <= 64) envelope.id = id;
  return envelope;
}

/** The Copilot plugin's hooks file (copilot-mesh-plugin/hooks/hooks.json, shipped as is): Copilot
 *  finds the helper through MESH_EVENT_BIN, so the file holds no path and is the same for every
 *  installation. A test keeps the shipped file equal to this rendering. */
export function copilotHooksFile(model: Model): string {
  const row = source(model, 'copilot');
  const seconds = row.timeout!.value;
  const lines = installed(model, 'copilot', 'state').map(({native}, index, all) => {
    const command = `[ -x \\"$MESH_EVENT_BIN\\" ] && exec \\"$MESH_EVENT_BIN\\" copilot ${native}; exit 0`;
    return `    "${native}": [\n      {"type": "command", "bash": "${command}", "timeoutSec": ${seconds}}\n    ]${index < all.length - 1 ? ',' : ''}`;
  });
  return `{\n  "version": 1,\n  "hooks": {\n${lines.join('\n')}\n  }\n}\n`;
}
