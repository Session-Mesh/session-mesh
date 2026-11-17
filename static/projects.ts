// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export { mountProjectFollowup } from './project-followup-controller.ts';
import { ProjectCatalogController } from './project-catalog-controller.ts';
import type { ProjectOptions } from './project-catalog-controller.ts';
import { parseProjectCatalog } from "./project-catalog.js";
import type { ProjectCatalog } from "./project-catalog.js";
export { mountProjectWorkspace } from './project-workspace.ts';

type Request = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_BYTES = 2 * 1024 * 1024;

// Both descriptor and artifact are bounded; no URL or raw exception escapes this adapter.
async function jsonResponse(response: Response, signal: AbortSignal, current: () => boolean, raw = false): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted || !current()) throw new Error("cancelled");
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error("oversize");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (signal.aborted || !current()) throw new Error("cancelled");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return raw ? text : JSON.parse(text);
}

export async function readProjectCatalog(path: string, request: Request, signal: AbortSignal,
  current: () => boolean, origin: string): Promise<ProjectCatalog> {
  if (!path.startsWith("/") || !path.endsWith(".json") || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error("path");
  const descriptorResponse = await request("/api/view", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: path }), signal, redirect: "error", cache: "no-store" });
  if (signal.aborted || !current()) throw new Error("cancelled");
  const descriptor = await jsonResponse(descriptorResponse, signal, current);
  if (signal.aborted || !current()) throw new Error("cancelled");
  if (!descriptor || typeof descriptor !== "object" || !("url" in descriptor) || typeof descriptor.url !== "string") throw new Error("descriptor");
  const url = new URL(descriptor.url, origin);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/view/v2.f.")) throw new Error("scope");
  const response = await request(url.href, { signal, redirect: "error", cache: "no-store" });
  if (signal.aborted || !current()) throw new Error("cancelled");
  const value = await jsonResponse(response, signal, current, true);
  if (signal.aborted || !current()) throw new Error("cancelled");
  const catalog = parseProjectCatalog(value);
  if (!catalog) throw new Error("invalid");
  return catalog;
}

export function mountProjects(options: ProjectOptions) { return new ProjectCatalogController(options, readProjectCatalog); }
