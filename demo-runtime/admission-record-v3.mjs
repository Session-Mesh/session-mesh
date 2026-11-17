// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {ADMISSION_LIMITS, COMPILER_PROFILE, MAX_ADMISSION_RECORD_BYTES} from "./admission-record-v1.mjs";

export const ADMISSION_RECORD_VERSION_V2 = 2;
export const RUNTIME_PROFILE_V3 = "quickjs-emscripten-0.32.0+worker-v2+view-v2+input-v1";
const keys = ["version","runner_id","resource_id","incarnation","demo_id","revision","format","code_digest","compiler_profile","runtime_profile","input_schema_digest","limits"];
const targetKeys = ["runner_id","resource_id","incarnation","demo_id"];
const digest = /^[0-9a-f]{64}$/;
const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const incarnation = /^[0-9a-f]{32}$/;
const encoder = new TextEncoder();
const exact = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).join(",") === expected.join(",");
const sameTarget = (record, target) => targetKeys.every(key => record[key] === target[key]);
export function decodeAdmissionRecordV3(bytes, expected) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ADMISSION_RECORD_BYTES) throw Error("invalid_input");
  let source, record;
  try { source = new TextDecoder("utf-8", {fatal:true}).decode(bytes); record = JSON.parse(source); } catch { throw Error("malformed"); }
  if (!exact(record, keys) || encoder.encode(JSON.stringify(record)).length !== bytes.length
      || JSON.stringify(record) !== source) throw Error("noncanonical");
  if (record.version !== 2 || record.format !== "tsx-quickjs-v0"
      || !targetKeys.every(key => typeof record[key] === "string")
      || !identifier.test(record.runner_id) || !identifier.test(record.resource_id)
      || !incarnation.test(record.incarnation) || !identifier.test(record.demo_id)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !digest.test(record.code_digest) || !digest.test(record.input_schema_digest)
      || record.compiler_profile !== COMPILER_PROFILE || record.runtime_profile !== RUNTIME_PROFILE_V3
      || JSON.stringify(record.limits) !== JSON.stringify(ADMISSION_LIMITS)) throw Error("invalid_record");
  if (!expected || !sameTarget(record, expected.target) || record.revision !== expected.revision
      || record.code_digest !== expected.code_digest || record.input_schema_digest !== expected.input_schema_digest
      || expected.compiler_profile !== COMPILER_PROFILE || expected.runtime_profile !== RUNTIME_PROFILE_V3) throw Error("wrong_expectation");
  return Object.freeze({...record, limits:Object.freeze({...record.limits})});
}
