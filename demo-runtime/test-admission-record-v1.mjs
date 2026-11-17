// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
  ADMISSION_LIMITS, admitDemoRuntime, COMPILER_PROFILE, decodeAdmissionRecord,
  MAX_ADMISSION_RECORD_BYTES, RUNTIME_PROFILE,
} from "./admission-record-v1.mjs";

const vectorPath = new URL("../ocaml/mesh_wire/test/demo-runtime-admission-v1-vectors.json",
  import.meta.url);
const vector = JSON.parse(await readFile(vectorPath, "utf8"));
const encoder = new TextEncoder();
const canonical = encoder.encode(vector.canonical);
const expected = Object.freeze({
  target: Object.freeze({
    runner_id: vector.expected.runner_id,
    resource_id: vector.expected.resource_id,
    incarnation: vector.expected.incarnation,
    demo_id: vector.expected.demo_id,
  }),
  revision: vector.expected.revision,
  code_digest: vector.expected.code_digest,
  compiler_profile: vector.expected.compiler_profile,
  runtime_profile: vector.expected.runtime_profile,
});

function rejects(bytes, expectation = expected, pattern = /./) {
  assert.throws(() => decodeAdmissionRecord(bytes, expectation), pattern);
}

function mutate(mutator) {
  const value = JSON.parse(vector.canonical);
  mutator(value);
  return encoder.encode(JSON.stringify(value));
}

const decoded = decodeAdmissionRecord(canonical, expected);
assert.equal(decoded.demo_id, "demo_01");
assert.deepEqual(decoded.limits, ADMISSION_LIMITS);
assert.equal(Object.isFrozen(decoded), true);
assert.equal(Object.isFrozen(decoded.limits), true);

rejects(new Uint8Array(MAX_ADMISSION_RECORD_BYTES + 1), expected, /invalid_input/);
rejects(Uint8Array.of(0xc3, 0x28), expected, /invalid_encoding/);
rejects(encoder.encode("{"), expected, /malformed/);
rejects(encoder.encode(` ${vector.canonical}`), expected, /noncanonical/);
rejects(encoder.encode(vector.canonical.replace('"revision":3', '"revision":3e0')),
  expected, /noncanonical/);
rejects(encoder.encode(vector.canonical.replace('"revision":3', '"revision":-0')),
  expected, /noncanonical/);
rejects(encoder.encode(vector.canonical.replace("runner_a", "runner_\\u0061")),
  expected, /noncanonical/);
rejects(encoder.encode(vector.canonical.replace('"demo_id":"demo_01"',
  '"demo_id":"demo_01","demo_id":"demo_02"')), expected, /noncanonical/);

for (const [label, change, pattern] of [
  ["extra", value => { value.title = "homonym"; }, /noncanonical/],
  ["capability", value => { value.capabilities = []; }, /noncanonical/],
  ["recipient", value => { value.recipient = "device"; }, /noncanonical/],
  ["missing", value => { delete value.format; }, /noncanonical/],
  ["version", value => { value.version = 2; }, /unsupported_version/],
  ["format", value => { value.format = "mesh-scene-v0"; }, /invalid_record/],
  ["non-ASCII opaque id", value => { value.demo_id = "démo"; }, /invalid_record/],
  ["compiler", value => { value.compiler_profile = "esbuild-0.25.11-bwrap-v1"; },
    /wrong_compiler_profile/],
  ["runtime", value => {
    value.runtime_profile = "quickjs-emscripten-0.33.0+worker-v1+view-v0";
  }, /wrong_runtime_profile/],
]) {
  rejects(mutate(change), expected, pattern);
  assert.ok(label);
}

const exactSafeRevision = structuredClone(expected);
exactSafeRevision.revision = Number.MAX_SAFE_INTEGER;
const exactSafeRevisionWire = mutate(value => { value.revision = Number.MAX_SAFE_INTEGER; });
assert.equal(decodeAdmissionRecord(exactSafeRevisionWire, exactSafeRevision).revision,
  Number.MAX_SAFE_INTEGER);
rejects(mutate(value => { value.revision = Number.MAX_SAFE_INTEGER + 1; }), expected,
  /invalid_record/);

for (const key of Object.keys(ADMISSION_LIMITS)) {
  rejects(mutate(value => { value.limits[key] = ADMISSION_LIMITS[key] + 1; }), expected,
    /invalid_limits/);
}
rejects(mutate(value => { value.limits.network = 0; }), expected, /invalid_limits/);

for (const [label, change] of [
  ["runner", value => { value.target.runner_id = "runner_b"; }],
  ["resource", value => { value.target.resource_id = "resource_2"; }],
  ["old incarnation", value => { value.target.incarnation = "b".repeat(32); }],
  ["homonymous demo", value => { value.target.demo_id = "demo_02"; }],
]) {
  const changed = structuredClone(expected);
  change(changed);
  rejects(canonical, changed, /wrong_target/);
  assert.ok(label);
}
for (const [key, replacement, pattern] of [
  ["revision", 2, /wrong_revision/],
  ["code_digest", "0".repeat(64), /wrong_digest/],
]) {
  const changed = structuredClone(expected);
  changed[key] = replacement;
  rejects(canonical, changed, pattern);
}
for (const [key, replacement] of [
  ["compiler_profile", "other"], ["runtime_profile", "other"],
]) {
  const changed = structuredClone(expected);
  changed[key] = replacement;
  rejects(canonical, changed, /invalid_expectation/);
}

const forbidden = new Set(["url", "capability", "capabilities", "recipient", "key", "transport",
  "title", "session", "session_name", "device", "epoch", "sequence", "enc", "ct", "relay",
  "routing"]);
function assertNoForbidden(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `admission must not contain ${key}`);
    assertNoForbidden(child);
  }
}
assertNoForbidden(decoded);

const originalWorker = globalThis.Worker;
const originalDocument = globalThis.document;
let sideEffects = 0;
globalThis.Worker = class { constructor() { sideEffects += 1; } };
globalThis.document = new Proxy({}, {get() { sideEffects += 1; return undefined; }});
try {
  const admitted = await admitDemoRuntime(canonical, expected, vector.code);
  assert.deepEqual(admitted.init, {
    v: 1, type: "init", code: vector.code, code_digest: expected.code_digest,
  });
  assert.equal(sideEffects, 0, "admission and H1 init create neither Worker nor DOM");
  await assert.rejects(admitDemoRuntime(canonical, expected, `${vector.code} `),
    /code_digest_mismatch/);
  await assert.rejects(admitDemoRuntime(mutate(value => { value.revision = 4; }), expected,
    vector.code), /wrong_revision/);
  assert.equal(sideEffects, 0, "substitutions fail before Worker or DOM");
} finally {
  globalThis.Worker = originalWorker;
  globalThis.document = originalDocument;
}

assert.equal(COMPILER_PROFILE, expected.compiler_profile);
assert.equal(RUNTIME_PROFILE, expected.runtime_profile);
console.log("demo runtime admission v1: PASS");
