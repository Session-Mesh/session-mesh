// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export type FollowupMode = 'summary' | 'kanban' | 'timeline' | 'timeline-total' | 'timeline-remaining' | 'dependencies';
export interface FollowupPreferences { mode: FollowupMode; selected: string | null; page: number; zoom: number;
  left: number; top: number; inspectorTop:number; disclosures: string[]; attemptPage: number }
const fresh = (): FollowupPreferences => ({ mode: 'summary', selected: null, page: 0, zoom: 1, left: 0, top: 0, inspectorTop:0, disclosures: [], attemptPage: 0 });
function finite(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : fallback;
}
function normalize(value: unknown): FollowupPreferences {
  if (!value || typeof value !== 'object') return fresh();
  const o = value as Partial<FollowupPreferences>;
  return { mode: o.mode === 'kanban' || o.mode === 'timeline' || o.mode === 'timeline-total' || o.mode === 'timeline-remaining' || o.mode === 'dependencies' ? o.mode : 'summary',
    selected: typeof o.selected === 'string' && o.selected.length <= 240 ? o.selected : null,
    page: Math.floor(finite(o.page, 0, 3)), zoom: Math.max(0.5, finite(o.zoom, 1, 4)),
    left: finite(o.left, 0, 32768), top: finite(o.top, 0, 4096), inspectorTop:finite(o.inspectorTop,0,32768), attemptPage: Math.floor(finite(o.attemptPage, 0, 3)),
    disclosures: Array.isArray(o.disclosures) ? [...new Set(o.disclosures.filter((key): key is string => typeof key === 'string' && key.length <= 240))].slice(-200) : [] };
}
/** UI preferences only: no observations, actor data, clocks or authority enter storage. */
export class FollowupPreferenceStore {
  private entries = new Map<string, FollowupPreferences>();
  private storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  private key: string;
  constructor(key: string, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.key = key; this.storage = storage;
    try {
      const raw = storage?.getItem(key);
      if (!raw || new TextEncoder().encode(raw).byteLength > 65536) return;
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > 200) return;
      for (const entry of entries) if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 1000) this.entries.set(entry[0], normalize(entry[1]));
    } catch { /* Instance memory remains usable when storage refuses. */ }
  }
  has(scope: string): boolean { return this.entries.has(scope); }
  read(scope: string): FollowupPreferences { return normalize(this.entries.get(scope)); }
  write(scope: string, preferences: FollowupPreferences): void {
    if (!scope || scope.length > 1000) return;
    this.entries.delete(scope); this.entries.set(scope, normalize(preferences));
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    let serialized = JSON.stringify([...this.entries]);
    while (new TextEncoder().encode(serialized).byteLength > 65536 && this.entries.size > 1) {
      this.entries.delete(this.entries.keys().next().value!); serialized = JSON.stringify([...this.entries]);
    }
    while (new TextEncoder().encode(serialized).byteLength > 65536 && this.entries.get(scope)!.disclosures.length) {
      this.entries.get(scope)!.disclosures.shift(); serialized = JSON.stringify([...this.entries]);
    }
    try { this.storage?.setItem(this.key, serialized); } catch { /* Bounded memory is the fallback. */ }
  }
}

const owners = new WeakMap<Document, FollowupPreferenceStore>();
/** Exactly one aggregate preference budget per mounted document. No arbitrary legacy keys are imported. */
export function projectPreferences(doc: Document): FollowupPreferenceStore {
  let owner = owners.get(doc);
  if (!owner) {
    let storage: Storage | undefined;
    try { storage = doc.defaultView?.localStorage; } catch { /* Denied storage uses bounded document memory. */ }
    owner = new FollowupPreferenceStore('mesh.projects.ui.v1', storage); owners.set(doc, owner);
  }
  return owner;
}
