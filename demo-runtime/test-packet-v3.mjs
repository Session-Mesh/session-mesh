// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {ADMISSION_LIMITS, COMPILER_PROFILE} from "./admission-record-v1.mjs";
import {RUNTIME_PROFILE_V3} from "./admission-record-v3.mjs";
import {acceptDemoCatalogV3} from "./catalog-v3.mjs";
import {admitDemoPacketV3} from "./packet-v3.mjs";
const enc = new TextEncoder();
const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
const code=enc.encode("export default 1;");
const inputs=enc.encode('{"format":"mesh-input-schema-v1","controls":[{"type":"toggle","id":"on","label":"On","initial":false}]}');
const identity={target:{runner_id:"runner-a",resource_id:"resource-a",incarnation:"0123456789abcdef0123456789abcdef",demo_id:"demo-a"},revision:7,code_digest:await hex(code),input_schema_digest:await hex(inputs),compiler_profile:COMPILER_PROFILE,runtime_profile:RUNTIME_PROFILE_V3};
const record={version:2,...identity.target,revision:identity.revision,format:"tsx-quickjs-v0",code_digest:identity.code_digest,compiler_profile:COMPILER_PROFILE,runtime_profile:RUNTIME_PROFILE_V3,input_schema_digest:identity.input_schema_digest,limits:ADMISSION_LIMITS};
const admission=enc.encode(JSON.stringify(record));
let runtimeCalls=0;
const catalog=acceptDemoCatalogV3(admission,identity,()=>{runtimeCalls++;return {unexpected:true};});
const packet={admission,compiled:code,inputs,expected:enc.encode(JSON.stringify(identity))};
let protocolCalls=0;
const accepted=await admitDemoPacketV3(packet,catalog,value=>{protocolCalls++;return value;});
assert.equal(accepted.code,"export default 1;"); assert.equal(protocolCalls,1); assert.equal(runtimeCalls,0);
const hostile=[];
for(const key of ["admission","compiled","inputs","expected"]){const copy={...packet,[key]:new Uint8Array(packet[key])};copy[key][copy[key].length-1]^=1;hostile.push([`substitute-${key}`,copy]);}
hostile.push(["missing",{admission,compiled:code,expected:packet.expected}]);
hostile.push(["extra",{...packet,snapshot:new Uint8Array()}]);
hostile.push(["unsafe-member",{...packet,compiled:"not bytes"}]);
hostile.push(["oversize-code",{...packet,compiled:new Uint8Array(ADMISSION_LIMITS.code_bytes+1)}]);
hostile.push(["oversize-schema",{...packet,inputs:new Uint8Array(8193)}]);
hostile.push(["oversize-expected",{...packet,expected:new Uint8Array(2049)}]);
for(const field of ["runner_id","resource_id","incarnation","demo_id"]){const changed={...identity,target:{...identity.target,[field]:field==="incarnation"?"f".repeat(32):`${field}-b`}};hostile.push([`target-${field}`,{...packet,expected:enc.encode(JSON.stringify(changed))}]);}
for(const [field,value] of [["revision",8],["code_digest","a".repeat(64)],["input_schema_digest","b".repeat(64)],["compiler_profile","other"],["runtime_profile","other"]]) hostile.push([field,{...packet,expected:enc.encode(JSON.stringify({...identity,[field]:value}))}]);
for(const [name,source] of [
  ["schema-reordered",'{"controls":[{"type":"toggle","id":"on","label":"On","initial":false}],"format":"mesh-input-schema-v1"}'],
  ["schema-extra",'{"format":"mesh-input-schema-v1","controls":[{"type":"toggle","id":"on","label":"On","initial":false,"extra":0}]}'],
  ["schema-unknown",'{"format":"mesh-input-schema-v1","controls":[{"type":"unknown","id":"on","label":"On","initial":false}]}'],
  ["schema-whitespace",new TextDecoder().decode(inputs)+" "],
  ["schema-bad-utf8",null],
]) hostile.push([name,{...packet,inputs:source===null?new Uint8Array([255]):enc.encode(source)}]);
for(const [name,candidate] of hostile){let calls=0;await assert.rejects(()=>admitDemoPacketV3(candidate,catalog,()=>{calls++;}));assert.equal(calls,0,`${name}: pre-protocol`);}
const alternate={...identity,target:{...identity.target,resource_id:"resource-b"}};
const alternateRecord={...record,resource_id:"resource-b"};
const alternateAdmission=enc.encode(JSON.stringify(alternateRecord));
const alternateCatalog=acceptDemoCatalogV3(alternateAdmission,alternate,()=>{runtimeCalls++;});
let calls=0;await assert.rejects(()=>admitDemoPacketV3(packet,alternateCatalog,()=>{calls++;}));assert.equal(calls,0,"packet A/catalog B pre-protocol");
const codeB=enc.encode("export default 2;");
const inputsB=enc.encode('{"format":"mesh-input-schema-v1","controls":[{"type":"action","id":"go","label":"Go","initial":0}]}');
const identityB={...identity,code_digest:await hex(codeB),input_schema_digest:await hex(inputsB)};
const recordB={...record,code_digest:identityB.code_digest,input_schema_digest:identityB.input_schema_digest};
const admissionB=enc.encode(JSON.stringify(recordB));
const packetB={admission:admissionB,compiled:codeB,inputs:inputsB,expected:enc.encode(JSON.stringify(identityB))};
const catalogB=acceptDemoCatalogV3(admissionB,identityB,()=>{runtimeCalls++;});
await admitDemoPacketV3(packetB,catalogB,value=>value);
for(const [name,candidate,token] of [
  ["coherent-code-a-schema-b",{...packet,inputs:inputsB,expected:packetB.expected},catalogB],
  ["coherent-schema-a-admission-b",{...packet,admission:admissionB,expected:packetB.expected},catalogB],
  ["coherent-expected-b",{...packet,expected:packetB.expected},catalog],
  ["coherent-catalog-b",packet,catalogB],
]) { let sentinel=0; await assert.rejects(()=>admitDemoPacketV3(candidate,token,()=>{sentinel++;})); assert.equal(sentinel,0,`${name}: pre-protocol`); }
for(const [name,mutate] of [
  ["admission-missing",r=>{delete r.input_schema_digest;}],
  ["admission-unknown",r=>{r.unknown=1;}],
  ["admission-unsafe",r=>{r.revision=Number.MAX_SAFE_INTEGER+1;}],
]) { const changed={...record}; mutate(changed); assert.throws(()=>acceptDemoCatalogV3(enc.encode(JSON.stringify(changed)),identity,()=>{}),undefined,name); }
assert.throws(()=>acceptDemoCatalogV3(new Uint8Array(4097),identity,()=>{}),undefined,"admission oversize");
console.log(`demo packet v3 hostile matrix: ${hostile.length+1} refused pre-protocol`);
