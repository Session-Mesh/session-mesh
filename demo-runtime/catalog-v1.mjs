// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {
  admitDemoRuntime, COMPILER_PROFILE, decodeAdmissionRecord, MAX_ADMISSION_RECORD_BYTES,
  RUNTIME_PROFILE,
} from "./admission-record-v1.mjs";

const catalogEntries = new WeakMap();

export class DemoCatalogError extends Error {
  constructor(code) {
    super(code);
    this.name = "DemoCatalogError";
    this.code = code;
  }
}

function copyIdentity(expected) {
  return Object.freeze({...expected,
    target: Object.freeze({...expected.target})});
}

function copyBytes(bytes) {
  return new Uint8Array(bytes);
}

/**
 * Accept exactly the canonical demo-runtime-admission-v1 bytes against an
 * identity supplied by a trusted caller.  The returned frozen object carries
 * no visible data; its brand and contents remain private to this module.
 */
export function acceptDemoCatalog(bytes, expectedIdentity) {
  return acceptDemoCatalogWith(bytes, expectedIdentity, decodeAdmissionRecord,
    RUNTIME_PROFILE, admitDemoRuntime);
}

export function acceptDemoCatalogWith(bytes, expectedIdentity, decoder, runtimeProfile, admit) {
  // Refuse the public byte bound before copying, decoding or inspecting any
  // identity fields.
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ADMISSION_RECORD_BYTES) {
    decoder(bytes, expectedIdentity);
  }
  const identity = copyIdentity(expectedIdentity);
  const ownedBytes = copyBytes(bytes);
  const record = decoder(ownedBytes, identity);
  const token = Object.freeze(Object.create(null));
  catalogEntries.set(token, Object.freeze({bytes: ownedBytes, identity, record, runtimeProfile, admit}));
  return token;
}

/** True when `value` is a plain object with exactly the given keys. */
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function sameIdentity(left, right, runtimeProfile) {
  const targetKeys = ["runner_id", "resource_id", "incarnation", "demo_id"];
  const identityKeys = runtimeProfile.endsWith("+input-v1")
    ? ["target", "revision", "code_digest", "input_schema_digest", "compiler_profile", "runtime_profile"]
    : ["target", "revision", "code_digest", "compiler_profile", "runtime_profile"];
  return exact(left, identityKeys)
    && exact(left.target, targetKeys)
    && targetKeys.every(key => left.target[key] === right.target[key])
    && left.revision === right.revision
    && left.code_digest === right.code_digest
    && left.input_schema_digest === right.input_schema_digest
    && left.compiler_profile === right.compiler_profile
    && left.runtime_profile === right.runtime_profile
    && left.compiler_profile === COMPILER_PROFILE
    && left.runtime_profile === runtimeProfile;
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

/** Internal verifier: validates a token without revealing its private entry. */
export function assertDemoCatalogToken(token) {
  if (!catalogEntries.has(token)) throw new DemoCatalogError("invalid_catalog_token");
}

export function verifyDemoCatalogToken(token, admissionBytes, candidateIdentity) {
  const entry = catalogEntries.get(token);
  if (!entry) throw new DemoCatalogError("invalid_catalog_token");
  if (!(admissionBytes instanceof Uint8Array)
      || !sameBytes(admissionBytes, entry.bytes)) {
    throw new DemoCatalogError("wrong_catalog_admission");
  }
  if (!sameIdentity(candidateIdentity, entry.identity, entry.runtimeProfile)) {
    throw new DemoCatalogError("wrong_catalog_identity");
  }
  return entry.record;
}

/** Compose code with a verified catalog entry without exposing its identity. */
export async function admitDemoCatalogCode(
    token, admissionBytes, candidateIdentity, code) {
  verifyDemoCatalogToken(token, admissionBytes, candidateIdentity);
  const entry = catalogEntries.get(token);
  return entry.admit(admissionBytes, entry.identity, code);
}
