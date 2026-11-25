// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export type Identity = { id: string; created: number; agent: string };
export type FlowEvent = { id: string; kind: 'message' | 'create'; time: number; source: Identity; target: Identity };
export type FlowSnapshot = { events: FlowEvent[]; truncated: boolean };
export function identityKey(identity: Pick<Identity, 'id' | 'created'>): string {
  return JSON.stringify([identity.id, identity.created]);
}
function identity(value: unknown): Identity | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || row.id.length > 256 || typeof row.created !== 'number'
      || !Number.isFinite(row.created) || typeof row.agent !== 'string' || row.agent.length > 80) return null;
  return {id: row.id, created: row.created, agent: row.agent};
}
export function parseSnapshot(value: unknown): FlowSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.events) || row.events.length > 5000 || typeof row.truncated !== 'boolean') return null;
  const result: FlowEvent[] = [], seen = new Set<string>();
  for (const raw of row.events) {
    if (!raw || typeof raw !== 'object') return null;
    const event = raw as Record<string, unknown>, source = identity(event.source), target = identity(event.target);
    if (typeof event.id !== 'string' || !event.id || event.id.length > 128 || seen.has(event.id)
        || (event.kind !== 'message' && event.kind !== 'create') || typeof event.time !== 'number'
        || !Number.isFinite(event.time) || !source || !target || identityKey(source) === identityKey(target)) return null;
    seen.add(event.id);
    result.push({id: event.id, kind: event.kind, time: event.time, source, target});
  }
  result.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return {events: result, truncated: row.truncated};
}
export function filterEvents(events: FlowEvent[], current: Pick<Identity, 'id' | 'created'> | null,
    scope: 'current' | 'all', since: number, kind: string): FlowEvent[] {
  if (scope === 'current' && !current) return [];
  const key = current && identityKey(current);
  return events.filter(event => event.time >= since && (kind === 'all' || event.kind === kind)
    && (scope === 'all' || identityKey(event.source) === key || identityKey(event.target) === key));
}
