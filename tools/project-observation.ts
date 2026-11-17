#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Trusted runner entry. Provider paths come only from the startup owner environment. */
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseJsonStrict, exact } from "../static/demo-view-contract.ts";
import { parseProjectCatalog } from "../static/project-catalog.ts";
import { pathToFileURL } from "node:url";
import { generateSnapshot } from "./project-snapshot.ts";
import { parseObservationInput, parseObservationOutput, OBSERVATION_LIMITS } from "../static/project-observation-contract.ts";
import type { ObservationInput, ObservationOutput, ObservationResult } from "../static/project-observation-contract.ts";
export interface CollectorRuntime { rosterCLI?: string | undefined; rosterPipelineCLI?: string | undefined; signal?: AbortSignal;
  runMs?: number; providerMs?: number; cancellationCode?: () => "cancelled" | "deadline" | "stale" }
export async function collectObservation(value: unknown, runtime: CollectorRuntime = {}): Promise<ObservationOutput> {
  const input = parseObservationInput(value); if (!input) throw Error("collector-invalid");
  const controller = new AbortController();
  let deadline = false;
  const abort = () => controller.abort();
  runtime.signal?.addEventListener("abort", abort, { once: true });
  if (runtime.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { deadline = true; controller.abort(); }, Math.max(0, Math.min(runtime.runMs ?? 30000, 30000)));
  let result: ObservationResult;
  try {
    // Only enabled selectors reach execution. Inert metadata remains represented.
    const config = { ...input.config, projects: input.config.projects.map(project => ({ ...project,
      sources: project.sources.map(source => {
        if (input.plan.source_ids.includes(source.id)) return source;
        const { board_path: _board, pipeline_root: _root, pipeline_task: _task, ...metadata } = source;
        return metadata;
      }) })) };
    const catalog = await generateSnapshot(config, { catalogVersion: 2, followup: true, compact: true, concurrency: 1,
      inspectRepositories: input.plan.repository, rosterCLI: runtime.rosterCLI, rosterPipelineCLI: runtime.rosterPipelineCLI,
      signal: controller.signal, ...(runtime.runMs === undefined ? {} : { runMs: runtime.runMs }),
      ...(runtime.providerMs === undefined ? {} : { providerMs: runtime.providerMs }) });
    result = controller.signal.aborted ? { state: "cancelled", code: deadline ? "deadline" : runtime.cancellationCode?.() ?? "cancelled" } : { state: "complete", catalog };
  } catch (error) {
    result = controller.signal.aborted ? { state: "cancelled", code: deadline ? "deadline" : runtime.cancellationCode?.() ?? "cancelled" } :
      { state: "failed", code: error instanceof Error && error.message === "catalog-limit" ? "collector-oversize" : "collector-failed" };
  } finally { clearTimeout(timer); runtime.signal?.removeEventListener("abort", abort); }
  // generateSnapshot waits for all owned direct children and their real pipes;
  // an uncooperative child therefore prevents this witness from being emitted.
  const output: ObservationOutput = { kind: "mesh-project-observation-output", version: 1, observation_id: input.observation_id,
    boot: input.boot, scope: input.scope, result, settlement: { providers_closed: true, provider_pipes_closed: true } };
  if (!parseObservationOutput(output, input)) throw Error("collector-invalid");
  return output;
}
async function readWireInput(): Promise<Buffer> {
  const buffer = Buffer.alloc(OBSERVATION_LIMITS.catalogBytes + OBSERVATION_LIMITS.metadataBytes);
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk as Buffer;
    if (length + bytes.length > buffer.length) throw Error("collector-oversize");
    bytes.copy(buffer, length); length += bytes.length;
  }
  return buffer.subarray(0, length);
}
async function readInput(): Promise<ObservationInput> {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readWireInput());
  const input = parseObservationInput(text); if (!input) throw Error("collector-invalid"); return input;
}
interface ValidationHeader { kind: "mesh-project-catalog-validation-input"; version: 1;
  observation_id: string; boot: string; scope: ObservationInput["scope"]; sha256: string }
function validationHeader(bytes: Buffer): ValidationHeader {
  const value = parseJsonStrict(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), "project");
  if (!exact(value, ["kind", "version", "observation_id", "boot", "scope", "sha256"]) || value.kind !== "mesh-project-catalog-validation-input" || value.version !== 1) throw Error("collector-invalid");
  for (const name of ["observation_id", "boot", "sha256"]) if (typeof value[name] !== "string" || !/^[a-f0-9]{64}$/.test(value[name] as string)) throw Error("collector-invalid");
  if (!exact(value.scope, ["machine_id", "project_id", "captured_revision"])) throw Error("collector-invalid");
  for (const name of ["machine_id", "project_id"]) if (typeof value.scope[name] !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.scope[name] as string)) throw Error("collector-invalid");
  if (typeof value.scope.captured_revision !== "string" || !/^cfg1_[a-f0-9]{64}$/.test(value.scope.captured_revision)) throw Error("collector-invalid");
  return value as unknown as ValidationHeader;
}
async function validateCatalog(): Promise<void> {
  const wire = await readWireInput(), newline = wire.indexOf(10);
  if (newline < 1 || newline >= OBSERVATION_LIMITS.metadataBytes) throw Error("collector-invalid");
  const header = validationHeader(wire.subarray(0, newline)), bytes = wire.subarray(newline + 1);
  let valid = false;
  if (bytes.length > 0 && bytes.length <= OBSERVATION_LIMITS.catalogBytes && createHash("sha256").update(bytes).digest("hex") === header.sha256) {
    try {
      const catalog = parseProjectCatalog(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
      valid = catalog !== null && catalog.schema_version === 2 && catalog.features.length === 2 && catalog.features.includes("project-metadata/1") && catalog.features.includes("roster-followup/1") && catalog.machine_id === header.scope.machine_id && catalog.projects.length === 1 && catalog.projects[0]!.id === header.scope.project_id;
    } catch { valid = false; }
  }
  const text = JSON.stringify({ kind: "mesh-project-catalog-validation-reply", version: 1, observation_id: header.observation_id,
    boot: header.boot, scope: header.scope, sha256: header.sha256, valid, settlement: { providers_closed: true, provider_pipes_closed: true } });
  if (Buffer.byteLength(text) > OBSERVATION_LIMITS.metadataBytes) throw Error("collector-oversize");
  await new Promise<void>((accept, reject) => process.stdout.write(text, error => error ? reject(error) : accept()));
}
export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--validate-catalog") {
    const finishPureValidation = () => {};
    process.on("SIGTERM", finishPureValidation); process.on("SIGINT", finishPureValidation);
    // Test-only opt-in: tells a supervising test that the handlers above are installed.
    if (process.env.MESH_PROJECT_VALIDATOR_READY_MARKER === "1") process.stderr.write("project-observation: validator-ready\n");
    try { await validateCatalog(); } finally { process.removeListener("SIGTERM", finishPureValidation); process.removeListener("SIGINT", finishPureValidation); }
    return;
  }
  if (args.length) throw Error("collector-invalid");
  const input = await readInput(), controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort); process.on("SIGINT", abort);
  try {
    const output = await collectObservation(input, { rosterCLI: process.env.MESH_PROJECT_ROSTER_CLI,
      rosterPipelineCLI: process.env.MESH_PROJECT_ROSTER_PIPELINE_CLI, signal: controller.signal });
    const text = JSON.stringify(output);
    if (Buffer.byteLength(text) > OBSERVATION_LIMITS.catalogBytes + OBSERVATION_LIMITS.metadataBytes) throw Error("collector-oversize");
    await new Promise<void>((accept, reject) => process.stdout.write(text, error => error ? reject(error) : accept()));
  } finally { process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write("project-observation: refused\n"); process.exitCode = 1; });
}
