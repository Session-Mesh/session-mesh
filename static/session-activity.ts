// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Browser-local ranking of the existing, closed management CPU projection. */
type RecordValue = Record<string, unknown>;
type Phase = "active" | "inactive" | "unknown";
type Entry = { identity: string; status: string; phase: Phase; zeroWindows: number; hotWindows: number;
  windowEnd: number | null; positiveAt: number | null };
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

type Cpu = { value: number; windowStart: number; windowEnd: number };
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
  return { value: metric.value, windowStart: metric.window.start, windowEnd: metric.window.end };
}

/* Which statuses the agent itself reports, per agent (discover.py):
 * - claude writes busy / idle / waiting into ~/.claude/sessions/<pid>.json (claude_info): those are
 *   authoritative, and CPU never overrides them.
 * - codex reports nothing. discover.codex_info infers "busy" when its rollout was written in the last
 *   20 s and "idle" otherwise, so a long tool call (a build, a test run) reads "idle". "busy" is still
 *   direct evidence of work; "idle" is only the absence of a recent write, so CPU decides.
 * - "waiting" (a question or permission prompt, from claude's file or a hook) always wins: it asks
 *   for the owner, and CPU must not hide that.
 * - opencode, gemini, agy, vibe and copilot report through their hooks (server._apply_reported_state,
 *   _apply_copilot_hooks) and pi is inferred like codex, but none of them gets a CPU measurement here
 *   (see `known` below), so their status is all there is.
 * The server samples /proc every 10 s and reports percent of one core. An idle Claude or Codex process
 * still burns 0-3 clock ticks per window (0-0.3 % at 100 Hz), so any positive value is noise. 5 %
 * (50 ticks per window) is well above that noise and still far below a working agent. A single hot
 * window can be a timer or garbage collection, so two adjacent fresh windows (the second starts where
 * the first ended) at or above the threshold are needed to promote, and two fresh windows below it
 * demote again. A gap between windows, a missing sample or a status change breaks the run. */
const ACTIVE_CPU_PERCENT = 5;
const WINDOWS_TO_PROMOTE = 2;
const WINDOWS_TO_DEMOTE = 2;

/** Whether the status alone decides the phase, without looking at CPU. */
const statusDecides = (session: Session): boolean => session.status === "busy" || session.status === "waiting"
  || (session.agentType === "claude" && session.status === "idle");

/** A reported status first; sustained CPU above the threshold when the status is inferred or missing. */
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
    const sameStatus = prior?.status === session.status;
    let zeroWindows = sameStatus ? prior.zeroWindows : 0;
    let hotWindows = sameStatus ? prior.hotWindows : 0;
    let positiveAt = prior?.positiveAt ?? null;
    const adjacent = cpu !== null && prior !== null && prior.windowEnd !== null && cpu.windowStart === prior.windowEnd;
    const wasActive = prior?.phase === "active";
    if (known && !statusDecides(session)) {
      const hot = cpu !== null && cpu.value >= ACTIVE_CPU_PERCENT;
      if (hot && freshWindow) {
        hotWindows = adjacent ? hotWindows + 1 : 1;
        zeroWindows = 0;
        phase = wasActive || hotWindows >= WINDOWS_TO_PROMOTE ? "active" : "unknown";
        if (phase === "active") positiveAt = now;
      } else if (hot) {
        phase = wasActive ? "active" : "unknown";
      } else if (cpu && freshWindow) {
        zeroWindows += 1;
        hotWindows = 0;
        phase = wasActive && zeroWindows < WINDOWS_TO_DEMOTE ? "active" : "inactive";
      } else if (cpu) {
        phase = wasActive && zeroWindows < WINDOWS_TO_DEMOTE ? "active" : "inactive";
      } else {
        hotWindows = 0;
        zeroWindows = 0;
        phase = wasActive && positiveAt !== null && now - positiveAt <= 30 ? "active" : "unknown";
      }
    }
    if (session.status === "busy") {
      zeroWindows = 0;
      hotWindows = 0;
      if (finite(now)) positiveAt = now;
    }
    entries[session.id] = { identity: session.identity, status: session.status, phase, zeroWindows, hotWindows,
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
