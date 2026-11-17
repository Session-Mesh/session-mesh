// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Exact Mesh conversation names are independent of transcript indexing. */
type Binding = { name: string; label: string; aliases: string[]; created: number;
  agent: string | null; sid: string | null; seen: number; closed_at: number | null };
type Conversation = Record<string, unknown> & { agent: string; id: string };

export function bindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Binding => v !== null && typeof v === "object"
    && typeof v.name === "string" && typeof v.label === "string"
    && Array.isArray(v.aliases) && v.aliases.every((a: unknown) => typeof a === "string")
    && Number.isFinite(v.created) && Number.isFinite(v.seen)
    && (v.agent === null || v.agent === "claude" || v.agent === "codex")
    && (v.sid === null || typeof v.sid === "string")
    && (v.closed_at === null || Number.isFinite(v.closed_at))).slice(0, 500);
}

export function decorate<T extends Conversation>(item: T, names: readonly Binding[]): T & {
  mesh_name: string; mesh_label: string; mesh_aliases: string[] } {
  const found = names.filter(n => n.agent === item.agent && n.sid === item.id);
  const newest = [...found].sort((a, b) => b.seen - a.seen)[0];
  return { ...item, mesh_name: newest?.name || "", mesh_label: newest?.label || "",
    mesh_aliases: [...new Set([...found].sort((a, b) => a.seen - b.seen).flatMap(n => n.aliases))].slice(-20) };
}

export function recent(names: readonly Binding[], liveIdentities: ReadonlySet<string>): Binding[] {
  const seen = new Set<string>();
  return [...names].filter(n => n.closed_at !== null && (!n.sid || !liveIdentities.has(`${n.agent}:${n.sid}`)))
    .sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0))
    .filter(n => { const key = n.sid ? `${n.agent}:${n.sid}` : `${n.name}:${n.created}`;
      if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 20);
}

export function matchesName(query: string, value: { name?: unknown; label?: unknown;
  aliases?: unknown; mesh_name?: unknown; mesh_label?: unknown; mesh_aliases?: unknown }): boolean {
  return [value.name, value.label, value.aliases, value.mesh_name, value.mesh_label,
    value.mesh_aliases].flat().join(" ").toLowerCase().includes(query.toLowerCase());
}
