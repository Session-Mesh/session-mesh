// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const output = join(root, "static", "workspace-spec.js");
const result = await build({
  absWorkingDir: root, entryPoints: ["static/workspace-spec.ts"], bundle: true,
  format: "iife", globalName: "MeshWorkspaceSpec", legalComments: "none", minify: true,
  outfile: output, sourcemap: false, target: ["es2022"], write: !check,
});
if (check) {
  const emitted = result.outputFiles.find((file) => file.path === output);
  if (!emitted) throw new Error("esbuild did not emit workspace-spec.js");
  if (!Buffer.from(emitted.contents).equals(await readFile(output))) {
    throw new Error("static/workspace-spec.js is stale; run npm run build:workspace-spec");
  }
}
