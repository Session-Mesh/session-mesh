// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "static", "demo-catalog.js");
const check = process.argv.includes("--check");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["static/demo-catalog.ts"],
  bundle: true,
  format: "iife",
  globalName: "MeshDemoCatalog",
  legalComments: "none",
  minify: true,
  outfile: output,
  sourcemap: false,
  target: ["es2022"],
  write: !check,
});

if (check) {
  const emitted = result.outputFiles.find((file) => file.path === output);
  if (!emitted) throw new Error("esbuild did not emit demo-catalog.js");
  const checkedIn = await readFile(output);
  if (!Buffer.from(emitted.contents).equals(checkedIn)) {
    throw new Error("static/demo-catalog.js is stale; run npm run build:demo-catalog");
  }
}
