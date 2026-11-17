// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Closed collector DTOs. Runtime paths and executable arguments never enter these values. */
import { parseJsonStrict } from "./demo-view-contract.ts";
import { parseProjectConfig, parseProjectCatalog, readObservationPlan, PROJECT_LIMITS } from "./project-catalog.ts";
import type { ProjectConfig, ProjectCatalog, ObservationPlan } from "./project-catalog.ts";
export const OBSERVATION_LIMITS = Object.freeze({ catalogBytes: PROJECT_LIMITS.bytes, metadataBytes: 8192, collectorBytes: 16 * 1024 * 1024 });
export interface ObservationScope { machine_id: string; project_id: string; captured_revision: string }
export interface ObservationInput { kind: "mesh-project-observation-input"; version: 1; observation_id: string; boot: string;
  scope: ObservationScope; plan: ObservationPlan; config: ProjectConfig; profile: "metadata-followup/1" }
export type ObservationResult = { state: "complete"; catalog: ProjectCatalog } |
  { state: "failed"; code: "collector-failed" | "collector-invalid" | "collector-oversize" } |
  { state: "cancelled"; code: "cancelled" | "deadline" | "stale" };
export interface ObservationOutput { kind: "mesh-project-observation-output"; version: 1; observation_id: string; boot: string;
  scope: ObservationScope; result: ObservationResult; settlement: { providers_closed: true; provider_pipes_closed: true } }
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid-observation");
  const object = value as Record<string, unknown>, keys = Object.keys(object);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) throw Error("invalid-observation"); return object;
}
function scalar(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw Error("invalid-observation"); return value;
}
function scope(value: unknown): ObservationScope {
  const o = record(value, ["machine_id", "project_id", "captured_revision"]);
  return { machine_id: scalar(o.machine_id, /^[A-Za-z0-9_-]{1,80}$/), project_id: scalar(o.project_id, /^[A-Za-z0-9_-]{1,80}$/), captured_revision: scalar(o.captured_revision, /^cfg1_[a-f0-9]{64}$/) };
}
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const source = value;
  if (new TextEncoder().encode(source).byteLength > OBSERVATION_LIMITS.catalogBytes + OBSERVATION_LIMITS.metadataBytes) throw Error("observation-limit");
  return parseJsonStrict(source, "project");
}
function identity(o: Record<string, unknown>): { observation_id: string; boot: string; scope: ObservationScope } {
  if (o.version !== 1) throw Error("observation-version");
  return { observation_id: scalar(o.observation_id, /^[a-f0-9]{64}$/), boot: scalar(o.boot, /^[a-f0-9]{64}$/), scope: scope(o.scope) };
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function metadata(o: Record<string, unknown>, input: boolean): void {
  // Measure only the bounded envelope, without copying its large payload.
  const shell = input ? { ...o, config: null } : { ...o, result: { state: "complete", catalog: null } };
  if (bytes(shell) - 4 > OBSERVATION_LIMITS.metadataBytes) throw Error("observation-metadata-limit");
}
export function parseObservationInput(value: unknown): ObservationInput | null {
  try {
    const o = record(json(value), ["kind", "version", "observation_id", "boot", "scope", "plan", "config", "profile"]);
    if (o.kind !== "mesh-project-observation-input" || o.profile !== "metadata-followup/1") return null;
    const target = identity(o), plan = readObservationPlan(o.plan), config = parseProjectConfig(o.config);
    if (!config || config.projects.length !== 1 || config.machine_id !== target.scope.machine_id || config.projects[0]!.id !== target.scope.project_id) return null;
    const project = config.projects[0]!;
    if (plan.repository && !project.repository?.local_path || plan.source_ids.some(id => !project.sources.some(s => s.id === id && s.kind === "roster" && (s.board_path !== undefined || s.pipeline_root !== undefined && s.pipeline_task !== undefined)))) return null;
    metadata(o, true);
    return { kind: "mesh-project-observation-input", version: 1, ...target, plan, config, profile: "metadata-followup/1" };
  } catch { return null; }
}
export function parseObservationOutput(value: unknown, input?: ObservationInput): ObservationOutput | null {
  try {
    const o = record(json(value), ["kind", "version", "observation_id", "boot", "scope", "result", "settlement"]);
    if (o.kind !== "mesh-project-observation-output") return null;
    const target = identity(o), settlement = record(o.settlement, ["providers_closed", "provider_pipes_closed"]);
    if (settlement.providers_closed !== true || settlement.provider_pipes_closed !== true) return null;
    if (input && (target.observation_id !== input.observation_id || target.boot !== input.boot || target.scope.machine_id !== input.scope.machine_id || target.scope.project_id !== input.scope.project_id || target.scope.captured_revision !== input.scope.captured_revision)) return null;
    const raw = o.result as Record<string, unknown>;
    let result: ObservationResult;
    if (raw?.state === "complete") {
      record(raw, ["state", "catalog"]); const catalog = parseProjectCatalog(raw.catalog);
      if (!catalog || catalog.schema_version !== 2 || catalog.features.length !== 2 || !catalog.features.includes("project-metadata/1") || !catalog.features.includes("roster-followup/1") || catalog.projects.length !== 1 || catalog.machine_id !== target.scope.machine_id || catalog.projects[0]!.id !== target.scope.project_id) return null;
      metadata(o, false); result = { state: "complete", catalog };
    } else {
      record(raw, ["state", "code"]);
      if (raw.state === "failed" && ["collector-failed", "collector-invalid", "collector-oversize"].includes(raw.code as string)) result = { state: "failed", code: raw.code as "collector-failed" | "collector-invalid" | "collector-oversize" };
      else if (raw.state === "cancelled" && ["cancelled", "deadline", "stale"].includes(raw.code as string)) result = { state: "cancelled", code: raw.code as "cancelled" | "deadline" | "stale" };
      else return null;
      if (bytes(o) > OBSERVATION_LIMITS.metadataBytes) return null;
    }
    return { kind: "mesh-project-observation-output", version: 1, ...target, result, settlement: { providers_closed: true, provider_pipes_closed: true } };
  } catch { return null; }
}
