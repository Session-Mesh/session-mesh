// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {decodeInputSchema} from "./input-codec-v1.mjs";
import {assertDemoCatalogToken, verifyDemoCatalogToken} from "./catalog-v1.mjs";
import {ADMISSION_LIMITS, MAX_ADMISSION_RECORD_BYTES} from "./admission-record-v1.mjs";
const keys = ["admission","compiled","inputs","expected"];
const expectedKeys = ["target","revision","code_digest","input_schema_digest","compiler_profile","runtime_profile"];
const encoder = new TextEncoder();
const exact = (v,k) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).join(",") === k.join(",");
const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b=>b.toString(16).padStart(2,"0")).join("");
export async function admitDemoPacketV3(packet, catalogToken, constructProtocol) {
  assertDemoCatalogToken(catalogToken);
  if (!exact(packet, keys) || !keys.every(k => packet[k] instanceof Uint8Array)) throw Error("invalid_packet");
  if (packet.admission.byteLength > MAX_ADMISSION_RECORD_BYTES
      || packet.compiled.byteLength > ADMISSION_LIMITS.code_bytes
      || packet.inputs.byteLength > 8 * 1024 || packet.expected.byteLength > 2048) throw Error("oversize_member");
  let expected, schemaSource, code;
  try {
    const expectedSource = new TextDecoder("utf-8",{fatal:true}).decode(packet.expected);
    expected = JSON.parse(expectedSource);
    if (!exact(expected, expectedKeys) || JSON.stringify(expected) !== expectedSource) throw Error();
    schemaSource = new TextDecoder("utf-8",{fatal:true}).decode(packet.inputs);
    decodeInputSchema(schemaSource);
    if (JSON.stringify(JSON.parse(schemaSource)) !== schemaSource) throw Error();
    code = new TextDecoder("utf-8",{fatal:true}).decode(packet.compiled);
  } catch { throw Error("invalid_member"); }
  verifyDemoCatalogToken(catalogToken, packet.admission, expected);
  if (await hex(packet.compiled) !== expected.code_digest
      || await hex(packet.inputs) !== expected.input_schema_digest) throw Error("digest_mismatch");
  if (typeof constructProtocol !== "function") throw Error("invalid_protocol_factory");
  return constructProtocol(Object.freeze({code, schema:decodeInputSchema(schemaSource), expected:Object.freeze(expected)}));
}
