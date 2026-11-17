// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {
  createHostProtocol, MAX_COMPILED_CODE_BYTES, MAX_FRAME_TIME_MS,
} from "./worker-protocol-v0.mjs";
import {MAX_VIEW_OUTPUT_BYTES, VIEW_V0_LIMITS} from "./view-codec-v0.mjs";

export const ADMISSION_RECORD_VERSION = 1;
export const MAX_ADMISSION_RECORD_BYTES = 4 * 1024;
export const COMPILER_PROFILE = "esbuild-0.25.10-bwrap-v1";
export const RUNTIME_PROFILE = "quickjs-emscripten-0.32.0+worker-v1+view-v0";
export const ADMISSION_LIMITS = Object.freeze({
  code_bytes: MAX_COMPILED_CODE_BYTES,
  frame_time_ms: MAX_FRAME_TIME_MS,
  output_bytes: MAX_VIEW_OUTPUT_BYTES,
  text_bytes: VIEW_V0_LIMITS.maxTextBytes,
  nodes: VIEW_V0_LIMITS.maxNodes,
  depth: VIEW_V0_LIMITS.maxDepth,
  update_interval_ms: 100,
});

const recordKeys = ["version", "runner_id", "resource_id", "incarnation", "demo_id",
  "revision", "format", "code_digest", "compiler_profile", "runtime_profile", "limits"];
const targetKeys = ["runner_id", "resource_id", "incarnation", "demo_id"];
const expectedKeys = ["target", "revision", "code_digest", "compiler_profile", "runtime_profile"];
const limitKeys = ["code_bytes", "frame_time_ms", "output_bytes", "text_bytes", "nodes",
  "depth", "update_interval_ms"];
const identifierPattern = /^[A-Za-z0-9_-]{1,64}$/;
const incarnationPattern = /^[0-9a-f]{32}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export class AdmissionRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = "AdmissionRecordError";
    this.code = code;
  }
}

function fail(code) {
  throw new AdmissionRecordError(code);
}

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function validTarget(target) {
  return exact(target, targetKeys)
    && typeof target.runner_id === "string" && identifierPattern.test(target.runner_id)
    && typeof target.resource_id === "string" && identifierPattern.test(target.resource_id)
    && typeof target.incarnation === "string" && incarnationPattern.test(target.incarnation)
    && typeof target.demo_id === "string" && identifierPattern.test(target.demo_id);
}

function recordTarget(record) {
  return Object.fromEntries(targetKeys.map(key => [key, record[key]]));
}

function validExpected(expected, runtimeProfile) {
  return exact(expected, expectedKeys) && validTarget(expected.target)
    && Number.isSafeInteger(expected.revision) && expected.revision >= 1
    && typeof expected.code_digest === "string" && digestPattern.test(expected.code_digest)
    && expected.compiler_profile === COMPILER_PROFILE
    && expected.runtime_profile === runtimeProfile;
}

function sameTarget(record, target) {
  return targetKeys.every(key => record[key] === target[key]);
}

function validLimits(limits) {
  return exact(limits, limitKeys)
    && limitKeys.every(key => Number.isSafeInteger(limits[key])
      && !Object.is(limits[key], -0) && limits[key] === ADMISSION_LIMITS[key]);
}

export function decodeAdmissionRecordForProfile(bytes, expected, runtimeProfile) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ADMISSION_RECORD_BYTES) {
    fail("invalid_input");
  }
  if (!validExpected(expected, runtimeProfile)) fail("invalid_expectation");
  let source;
  try {
    source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    fail("invalid_encoding");
  }
  let record;
  try {
    record = JSON.parse(source);
  } catch {
    fail("malformed");
  }
  // Equality with the fixed-order encoder rejects duplicate members, alternate
  // ordering, insignificant whitespace, escapes and noncanonical numbers.
  if (!exact(record, recordKeys)
      || !sameBytes(encoder.encode(JSON.stringify(record)), bytes)) fail("noncanonical");
  if (record.version !== ADMISSION_RECORD_VERSION) fail("unsupported_version");
  if (!validTarget(recordTarget(record)) || record.format !== "tsx-quickjs-v0"
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || typeof record.code_digest !== "string"
      || !digestPattern.test(record.code_digest)) fail("invalid_record");
  if (record.compiler_profile !== COMPILER_PROFILE) fail("wrong_compiler_profile");
  if (record.runtime_profile !== runtimeProfile) fail("wrong_runtime_profile");
  if (!validLimits(record.limits)) fail("invalid_limits");
  if (!sameTarget(record, expected.target)) fail("wrong_target");
  if (record.revision !== expected.revision) fail("wrong_revision");
  if (record.code_digest !== expected.code_digest) fail("wrong_digest");
  if (record.compiler_profile !== expected.compiler_profile) fail("wrong_compiler_profile");
  if (record.runtime_profile !== expected.runtime_profile) fail("wrong_runtime_profile");
  return Object.freeze({...record, limits: Object.freeze({...record.limits})});
}

export function decodeAdmissionRecord(bytes, expected) {
  return decodeAdmissionRecordForProfile(bytes, expected, RUNTIME_PROFILE);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function admitDemoRuntime(bytes, expected, code) {
  const record = decodeAdmissionRecord(bytes, expected);
  if (typeof code !== "string" || encoder.encode(code).byteLength > record.limits.code_bytes) {
    fail("invalid_code");
  }
  const actualDigest = await sha256Hex(encoder.encode(code));
  if (actualDigest !== record.code_digest) fail("code_digest_mismatch");
  const protocol = createHostProtocol(code, record.code_digest);
  return Object.freeze({record, protocol, init: protocol.init()});
}

export async function admitDemoRuntimeForProfile(bytes, expected, code, runtimeProfile, viewDecoder) {
  const record = decodeAdmissionRecordForProfile(bytes, expected, runtimeProfile);
  if (typeof code !== "string" || encoder.encode(code).byteLength > record.limits.code_bytes) {
    fail("invalid_code");
  }
  const actualDigest = await sha256Hex(encoder.encode(code));
  if (actualDigest !== record.code_digest) fail("code_digest_mismatch");
  const protocol = createHostProtocol(code, record.code_digest, viewDecoder);
  return Object.freeze({record, protocol, init: protocol.init()});
}
