// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {applyInputGesture,decodeInputSchema,initialSnapshot,readInputSchema,readInputSnapshot,INPUT_LIMITS} from "../demo-runtime/input-codec-v1.mjs";
import {createHostProtocolV2,createWorkerProtocolV2,WorkerProtocolError} from "../demo-runtime/worker-protocol-v2.mjs";
import {createHash,webcrypto} from "node:crypto";
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const digest=value=>createHash("sha256").update(value).digest("hex");
const schema={format:"mesh-input-schema-v1",controls:[
  {type:"range",id:"fleet",label:"Fleet size",min:0,max:100,step:5,initial:25},
  {type:"toggle",id:"reserve",label:"Keep reserve",initial:true},
  {type:"choice",id:"region",label:"Region",options:["North","West","South"],initial:"North"},
  {type:"action",id:"dispatch",label:"Dispatch",initial:0},
]};
assert.ok(readInputSchema(schema));let snapshot=initialSnapshot(schema);assert.ok(readInputSnapshot(snapshot,schema));
assert.equal(JSON.stringify(decodeInputSchema(JSON.stringify(schema))),JSON.stringify(schema));assert.throws(()=>decodeInputSchema('{"format":"mesh-input-schema-v1","format":"mesh-input-schema-v1","controls":[]}'));
assert.throws(()=>decodeInputSchema(" ".repeat(INPUT_LIMITS.maxSchemaBytes+1)));
for(const [gesture,expected] of [[{id:"fleet",value:30},30],[{id:"reserve",value:false},false],[{id:"region",value:"West"},"West"],[{id:"dispatch"},1]]){const before=snapshot;snapshot=applyInputGesture(schema,snapshot,gesture);assert.equal(snapshot.generation,before.generation+1);assert.equal(snapshot.values.filter((x,i)=>x.value!==before.values[i].value).length,1);assert.equal(snapshot.values.find(x=>x.id===gesture.id).value,expected);}
for(const bad of [
 {...schema,extra:1},{...schema,controls:[]},{...schema,controls:[...schema.controls,{...schema.controls[0]}]},
 {...schema,controls:[{...schema.controls[0],id:"bad id"}]},{...schema,controls:[{...schema.controls[0],max:99}]},
 {...schema,controls:[{...schema.controls[2],options:["x"]}]},{...schema,controls:[{...schema.controls[3],initial:1}]},
])assert.equal(readInputSchema(bad),null);
assert.equal(readInputSchema({format:"mesh-input-schema-v1",controls:Array.from({length:INPUT_LIMITS.maxControls+1},(_,i)=>({type:"toggle",id:`x${i}`,label:"x",initial:false}))}),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[0],id:"x".repeat(33)}]}),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[0],label:"x".repeat(INPUT_LIMITS.maxLabelBytes+1)}]}),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[0],min:INPUT_LIMITS.minNumber-1}]}),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[0],max:INPUT_LIMITS.maxNumber+1}]}),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[2],options:Array.from({length:17},(_,i)=>`x${i}`),initial:"x0"}]}),null);
assert.throws(()=>applyInputGesture(schema,snapshot,{id:"unknown",value:1}),/unknown_input/);
assert.throws(()=>applyInputGesture(schema,{...snapshot,generation:Number.MAX_SAFE_INTEGER},{id:"reserve",value:true}),/exhausted/);
for(const id of ["fleet","reserve","region"]){const before=snapshot;const value=before.values.find(entry=>entry.id===id).value;assert.throws(()=>applyInputGesture(schema,before,{id,value}),/invalid_input_gesture/);assert.equal(before.generation,snapshot.generation);}
assert.equal(readInputSnapshot({...snapshot,extra:1},schema),null);assert.equal(readInputSnapshot({...snapshot,values:[...snapshot.values].reverse()},schema),null);
const cyclicControl={...schema.controls[0]},cyclicSchema={format:schema.format,controls:[cyclicControl,...schema.controls.slice(1)]};cyclicControl.initial=cyclicSchema;assert.equal(readInputSchema(cyclicSchema),null);
assert.equal(readInputSchema({...schema,controls:[{...schema.controls[0],initial:1n},...schema.controls.slice(1)]}),null);
const cyclicSnapshot={...snapshot,values:snapshot.values.map(entry=>({...entry}))};cyclicSnapshot.values[0].value=cyclicSnapshot;assert.equal(readInputSnapshot(cyclicSnapshot,schema),null);assert.equal(readInputSnapshot({...snapshot,values:snapshot.values.map((entry,index)=>index===0?{...entry,value:1n}:entry)},schema),null);

const source=JSON.stringify(schema),code="ok",codeDigest=digest(code),schemaDigest=digest(source),decode=source=>{const value=JSON.parse(source);if(value.format!=="mesh-view-v2")throw Error();return value;};
const worker=createWorkerProtocolV2(async(_code,time,input)=>{assert.ok(Object.isFrozen(input)&&Object.isFrozen(input.values)&&Object.isFrozen(input.values[0]));return JSON.stringify({format:"mesh-view-v2",nodes:[{type:"text",text:`${time}:${input.generation}`}]});},decode);
const host=createHostProtocolV2(code,codeDigest,source,schemaDigest,decode);const ready=await worker.handle(host.init());host.accept(ready);let frame=host.frame(1,snapshot);assert.equal(host.busy,true);assert.throws(()=>host.frame(2,snapshot),error=>error instanceof WorkerProtocolError&&error.code==="concurrent_frame");
// A fresh pair validates successful sequence/generation binding.
const host2=createHostProtocolV2(code,codeDigest,source,schemaDigest,decode),worker2=createWorkerProtocolV2(async(_c,t,s)=>JSON.stringify({format:"mesh-view-v2",nodes:[{type:"text",text:`${t}:${s.generation}`}] }),decode);host2.accept(await worker2.handle(host2.init()));frame=host2.frame(1,snapshot);const view=await worker2.handle(frame);assert.equal(host2.accept(view).inputGeneration,snapshot.generation);assert.equal(host2.busy,false);
assert.throws(()=>createHostProtocolV2("\ud800",codeDigest,source,schemaDigest,decode),/invalid_init/);
const staleHost=createHostProtocolV2(code,codeDigest,source,schemaDigest,decode),staleWorker=createWorkerProtocolV2(async()=>JSON.stringify({format:"mesh-view-v2",nodes:[]}),decode);staleHost.accept(await staleWorker.handle(staleHost.init()));const staleFrame=staleHost.frame(0,snapshot),staleView=await staleWorker.handle(staleFrame);assert.throws(()=>staleHost.accept({...staleView,input_generation:staleView.input_generation-1}),/invalid_view/);
const negative=async(mutator)=>{const h=createHostProtocolV2(code,codeDigest,source,schemaDigest,decode),w=createWorkerProtocolV2(async()=>JSON.stringify({format:"mesh-view-v2",nodes:[]}),decode);h.accept(await w.handle(h.init()));const message=h.frame(0,snapshot);await assert.rejects(w.handle(mutator({...message})),WorkerProtocolError);await assert.rejects(w.handle(message),error=>error instanceof WorkerProtocolError&&error.code==="protocol_closed");};
await negative(m=>({...m,unknown:true}));await negative(m=>({...m,sequence:0}));await negative(m=>({...m,sequence:2}));await negative(m=>({...m,input_generation:m.input_generation+1}));await negative(m=>({...m,snapshot:{...m.snapshot,generation:m.input_generation+1}}));
await negative(m=>{const bad={...m.snapshot,values:m.snapshot.values.map(entry=>({...entry}))};bad.values[0].value=bad;return {...m,snapshot:bad};});
await negative(m=>({...m,snapshot:{...m.snapshot,values:m.snapshot.values.map((entry,index)=>index===0?{...entry,value:1n}:entry)}}));
for(const event of ["timeout","crash"]){const h=createHostProtocolV2(code,codeDigest,source,schemaDigest,decode),w=createWorkerProtocolV2(async()=>"",decode);h.accept(await w.handle(h.init()));const f=h.frame(0,snapshot);assert.throws(()=>event==="timeout"?h.timeout(f.sequence):h.crash(),WorkerProtocolError);assert.throws(()=>h.accept({}),/protocol_closed/);}
// Worker concurrency closes rather than queues.
let release;const gate=new Promise(resolve=>{release=resolve;});const concurrent=createWorkerProtocolV2(async()=>{await gate;return JSON.stringify({format:"mesh-view-v2",nodes:[]});},decode);await concurrent.handle({v:2,type:"init",code,code_digest:codeDigest,schema:source,schema_digest:schemaDigest});const p=concurrent.handle({v:2,type:"frame",sequence:1,time_ms:0,snapshot:initialSnapshot(schema),input_generation:0});await assert.rejects(concurrent.handle({v:2,type:"frame",sequence:2,time_ms:0,snapshot:initialSnapshot(schema),input_generation:0}),/concurrent_message/);release();await assert.rejects(p,/protocol_closed/);
console.log("demo input/protocol: ok");
