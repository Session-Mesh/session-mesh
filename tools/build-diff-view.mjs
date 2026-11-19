// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const output = join(root, "static", "diff-view.js");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["static/diff-view.ts"],
  bundle: true,
  format: "iife",
  globalName: "MeshDiffView",
  legalComments: "none",
  minify: true,
  outfile: output,
  sourcemap: false,
  target: ["es2022"],
  write: !check,
});

if (check) {
  const emitted = result.outputFiles.find((file) => file.path === output);
  if (!emitted) throw new Error("esbuild did not emit diff-view.js");
  const checkedIn = await readFile(output);
  if (!Buffer.from(emitted.contents).equals(checkedIn)) {
    throw new Error("static/diff-view.js is stale; run npm run build:diff-view");
  }
}
