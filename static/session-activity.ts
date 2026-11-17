// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Browser-local ranking of the existing, closed management CPU projection. */
type RecordValue = Record<string, unknown>;
type Phase = "active" | "inactive" | "unknown";
type Entry = { identity: string; phase: Phase; zeroWindows: number; windowEnd: number | null; positiveAt: number | null };
export type Ranking = { entries: Record<string, Entry>; activeIds: string[]; phaseById: Record<string, Phase> };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type Session = { id: string; name: string | null; created: number | null; identity: string;
  kind: string; agentType: string; status: string; updated: number };
function sessionValue(raw: unknown): Session | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const agent = isRecord(raw.agent) ? raw.agent : {};
  const name = typeof raw.name === "string" && raw.name ? raw.name : null;
  const created = finite(raw.created) ? raw.created : null;
  return {
    id: raw.id,
    name, created, identity: JSON.stringify([name, created]),
    kind: typeof raw.kind === "string" ? raw.kind : "",
    agentType: typeof agent.type === "string" ? agent.type : "",
    status: typeof agent.status === "string" ? agent.status : "",
    updated: finite(agent.updated) ? agent.updated : finite(raw.activity) ? raw.activity : 0,
  };
}

type Cpu = { value: number; windowEnd: number };
function cpuFor(raw: unknown, session: Session, now: number): Cpu | null {
  if (!isRecord(raw) || !Array.isArray(raw.sessions) || session.name === null || session.created === null) return null;
  const rows = raw.sessions.filter((row: unknown) => isRecord(row)
    && row.name === session.name && row.created === session.created);
  if (rows.length !== 1) return null;
  const row = rows[0] as RecordValue;
  if (row.source !== "mesh" || row.lifecycle !== "active" || row.agent_type !== session.agentType
      || !isRecord(row.metrics) || !isRecord(row.metrics.cpu_percent)) return null;
  const metric = row.metrics.cpu_percent;
  if (metric.state !== "derived" || metric.source !== "procfs-stat" || metric.reason !== null
      || !finite(metric.value) || metric.value < 0 || !finite(metric.observed_at)
      || metric.observed_at > now + 2 || now - metric.observed_at > 20
      || !isRecord(metric.window) || !finite(metric.window.start) || metric.window.start < 0
      || !finite(metric.window.end) || metric.window.end <= metric.window.start) return null;
  return { value: metric.value, windowEnd: metric.window.end };
}

/** Positive CPU proves activity immediately; two distinct zero windows demote it. */
export function update(previous: Ranking | null, rawSessions: unknown, management: unknown, now: number): Ranking {
  const sessions = Array.isArray(rawSessions) ? rawSessions.map(sessionValue).filter((s): s is Session => s !== null) : [];
  const entries: Record<string, Entry> = Object.create(null);
  const phaseById: Record<string, Phase> = Object.create(null);
  const previousEntries = previous?.entries || {};
  for (const session of sessions) {
    const previousEntry = previousEntries[session.id];
    const prior = previousEntry?.identity === session.identity ? previousEntry : null;
    const known = session.kind === "mesh" && (session.agentType === "claude" || session.agentType === "codex");
    const measured = known && finite(now) ? cpuFor(management, session, now) : null;
    const cpu = measured && prior?.windowEnd !== null && prior?.windowEnd !== undefined
      && measured.windowEnd < prior.windowEnd ? null : measured;
    const freshWindow = cpu !== null && (prior?.windowEnd === null || prior === null || cpu.windowEnd > prior.windowEnd);
    let phase: Phase = session.status === "busy" ? "active" : "inactive";
    let zeroWindows = prior?.zeroWindows ?? 0;
    let positiveAt = prior?.positiveAt ?? null;
    if (session.status !== "busy" && session.status !== "waiting" && known) {
      if (cpu && cpu.value > 0 && freshWindow) {
        phase = "active";
        zeroWindows = 0;
        positiveAt = now;
      } else if (cpu && cpu.value > 0) {
        phase = prior?.phase === "active" ? "active" : "unknown";
      } else if (cpu && freshWindow) {
        zeroWindows += 1;
        phase = prior?.phase === "active" && zeroWindows < 2 ? "active" : "inactive";
      } else if (cpu && cpu.value === 0) {
        phase = prior?.phase === "active" && zeroWindows < 2 ? "active" : "inactive";
      } else {
        phase = prior?.phase === "active" && positiveAt !== null && now - positiveAt <= 30
          ? "active" : "unknown";
      }
    }
    if (session.status === "busy") {
      zeroWindows = 0;
      if (finite(now)) positiveAt = now;
    }
    entries[session.id] = { identity: session.identity, phase, zeroWindows,
      windowEnd: freshWindow ? cpu!.windowEnd : prior?.windowEnd ?? null, positiveAt };
    phaseById[session.id] = phase;
  }
  const active = sessions.filter((s) => phaseById[s.id] === "active");
  const byId = new Map(active.map((s) => [s.id, s]));
  const retained = (previous?.activeIds || []).filter((id) => byId.has(id));
  const retainedSet = new Set(retained);
  const added = active.filter((s) => !retainedSet.has(s.id))
    .sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id)).map((s) => s.id);
  return { entries, phaseById, activeIds: [...retained, ...added] };
}
