// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";

const output = "static/demo-view.js";
const check = process.argv.includes("--check");
const target = check ? `${output}.check` : output;
await build({ entryPoints: ["static/demo-view.ts"], outfile: target, bundle: true,
  format: "iife", globalName: "MeshDemoView", platform: "browser", target: "es2022", minify: true });
const contractOutput = "demo-runtime/view-codec-v2.mjs";
const contractTarget = check ? `${contractOutput}.check` : contractOutput;
await build({entryPoints: ["static/demo-view-contract.ts"], outfile: contractTarget, bundle: true,
  format: "esm", platform: "browser", target: "es2022", minify: false});
if (check) {
  const [actual, expected, contractActual, contractExpected] = await Promise.all([
    readFile(target), readFile(output), readFile(contractTarget), readFile(contractOutput),
  ]);
  await Promise.all([rm(target), rm(contractTarget)]);
  if (!actual.equals(expected) || !contractActual.equals(contractExpected)) {
    throw new Error(`demo view assets are stale; run npm run build:demo-view`);
  }
}
