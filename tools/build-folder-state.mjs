// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
for (const [module, globalName] of [["folder-state", "MeshFolderState"], ["history-state", "MeshHistoryState"], ["session-activity", "MeshSessionActivity"]]) {
const output = join(root, "static", `${module}.js`);
const result = await build({
  absWorkingDir: root,
  entryPoints: [`static/${module}.ts`],
  bundle: true,
  format: "iife",
  globalName,
  legalComments: "none",
  minify: true,
  outfile: output,
  sourcemap: false,
  target: ["es2022"],
  write: !check,
});

if (check) {
  const emitted = result.outputFiles.find((file) => file.path === output);
  if (!emitted) throw new Error(`esbuild did not emit ${module}.js`);
  const checkedIn = await readFile(output);
  if (!Buffer.from(emitted.contents).equals(checkedIn)) {
    throw new Error(`static/${module}.js is stale; run npm run build:folder-state`);
  }
}
}
