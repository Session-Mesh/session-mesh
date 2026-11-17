// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {compileDemoSource, MAX_SOURCE_BYTES} from "./compile.mjs";

const fixture = readFileSync(new URL("./fixture.tsx", import.meta.url));
const command = fileURLToPath(new URL("../scripts/compile-demo-tsx.sh", import.meta.url));
// Node 22 prints exactly this line whenever it starts with --jitless; Node 24
// does not. Only this whole line, at the very start, is ignored.
const NODE22_JITLESS_WARNING = "Warning: disabling flag --expose_wasm due to conflicting flags\n";
const withoutKnownWarning = stderr =>
  stderr.startsWith(NODE22_JITLESS_WARNING) ? stderr.slice(NODE22_JITLESS_WARNING.length) : stderr;
const run = (input, args = [], env = process.env) => {
  const result = spawnSync(command, args, {input, env, encoding: "utf8", maxBuffer: 256 * 1024});
  return {...result, stderr: withoutKnownWarning(result.stderr)};
};

// Off Linux the launcher refuses before anything else: there is no bubblewrap to confine the
// compiler, and it never runs unconfined. `env` names the system through PATH (a stand-in uname).
const refusedOn = (system, env = process.env) => {
  const refused = run(fixture, [], env);
  assert.equal(refused.status, 78);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, `compile-demo-tsx: the demo compiler runs only on Linux, inside bubblewrap; it is not available on ${system}.\n`);
};

// The pinned esbuild of this platform compiles the fixture (in this test's own process, not
// through the launcher): the build of a bundle checks it on every platform.
const expected = await compileDemoSource(fixture.toString("utf8"));
assert.ok(expected.length > 0);

const system = spawnSync("uname", ["-s"], {encoding: "utf8"}).stdout.trim();
if (system !== "Linux") {
  refusedOn(system);
  console.log("DEMO_COMPILER_REFUSED_OFF_LINUX_PASS");
  process.exit(0);
}

const valid = run(fixture, [], {...process.env, NODE_OPTIONS: "--not-a-real-node-flag"});
if (valid.status !== 0) {
  // The compiler hides its error on purpose (it can contain guest source). To find out why the sandbox
  // refused the fixture, run the pinned esbuild binary alone under several address-space limits and print
  // how each ends. Nothing of the fixture goes through this probe.
  const binary = fileURLToPath(new URL(`./node_modules/@esbuild/linux-${process.arch}/bin/esbuild`, import.meta.url));
  for (const limit of [1073741824, 2147483648, 4294967296]) {
    const probe = spawnSync("prlimit", [`--as=${limit}`, "--", binary, "--loader=ts"],
      {input: "let a: number = 1", encoding: "utf8"});
    console.error(`DIAGNOSTIC esbuild ${process.arch} --as=${limit}: status=${probe.status} signal=${probe.signal}` +
      ` error=${probe.error?.code ?? "none"} stderr=${JSON.stringify((probe.stderr ?? "").slice(0, 300))}`);
  }
}
assert.equal(valid.status, 0, valid.stderr);
assert.equal(valid.stdout, expected);
assert.equal(valid.stderr, "");

for (const badNode of ["node", "/nonexistent/mesh-node"]) {
  const refused = run(fixture, [], {...process.env, MESH_NODE: badNode});
  assert.equal(refused.status, 78);
  assert.equal(refused.stdout, "");
}

for (const input of [
  Buffer.from('import "https://example.invalid/remote.ts";'),
  Buffer.from('import "node:fs";'),
  Buffer.from('globalThis.__mesh_result = import("./local.js")'),
  Buffer.from(`globalThis.__mesh_result = [${Array(9000).fill("<x/>").join(",")}]`),
  Buffer.alloc(MAX_SOURCE_BYTES + 1, 65),
  Buffer.from([0xff]),
]) {
  const refused = run(input);
  assert.equal(refused.status, 78);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "demo compiler refused input\n");
}

const wrongArguments = run(fixture, ["--unsafe"]);
assert.equal(wrongArguments.status, 78);
assert.equal(wrongArguments.stdout, "");

// The macOS answer, checked here with a stand-in uname that says Darwin.
const fakes = mkdtempSync(join(tmpdir(), "mesh-uname-"));
try {
  writeFileSync(join(fakes, "uname"), "#!/bin/sh\necho Darwin\n", {mode: 0o755});
  refusedOn("Darwin", {...process.env, PATH: `${fakes}:${process.env.PATH}`});
} finally {
  rmSync(fakes, {recursive: true, force: true});
}
console.log("DEMO_COMPILER_SANDBOX_PASS");
