// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {decodeInputSchema,deepFreezeSnapshot,readInputSnapshot,type InputSchema,type InputSnapshot} from "./demo-input-contract";

export const WORKER_PROTOCOL_VERSION=2;
export const MAX_COMPILED_CODE_BYTES=128*1024;
export const MAX_FRAME_TIME_MS=60_000;
const encoder=new TextEncoder();const digest=/^[0-9a-f]{64}$/;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===[...keys].sort().join(",");
const fail=(code:string):never=>{throw new WorkerProtocolError(code);};
const sha256=async(value:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))),byte=>byte.toString(16).padStart(2,"0")).join("");
const wellFormed=(value:string):boolean=>{for(let i=0;i<value.length;i+=1){const unit=value.charCodeAt(i);if(unit>=0xd800&&unit<=0xdbff){const low=value.charCodeAt(i+1);if(!(low>=0xdc00&&low<=0xdfff))return false;i+=1;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}return true;};
export class WorkerProtocolError extends Error{code:string;constructor(code:string){super(code);this.name="WorkerProtocolError";this.code=code;}}
type Decoder=(source:string)=>unknown;
type Evaluator=(code:string,timeMs:number,snapshot:InputSnapshot)=>Promise<string>;

export function createWorkerProtocolV2(evaluate:Evaluator,decodeView:Decoder){
  let state:"fresh"|"ready"|"closed"="fresh",code="",codeDigest="",schemaDigest="",schema:InputSchema|null=null,lastSequence=0,lastGeneration=0,busy=false;
  const close=(reason:string):never=>{state="closed";return fail(reason);};
  return Object.freeze({async handle(message:unknown){
    if(busy)close("concurrent_message");if(state==="closed")fail("protocol_closed");busy=true;
    try{
      if(state==="fresh"){
        if(!exact(message,["v","type","code","code_digest","schema","schema_digest"])||message.v!==2||message.type!=="init"
            ||typeof message.code!=="string"||!wellFormed(message.code)||encoder.encode(message.code).byteLength>MAX_COMPILED_CODE_BYTES||!digest.test(String(message.code_digest))
            ||typeof message.schema!=="string"||!digest.test(String(message.schema_digest)))close("invalid_init");
        const msg=message as Record<string,unknown>;
        let acceptedSchema:InputSchema|null=null;try{acceptedSchema=decodeInputSchema(msg.schema as string);}catch{close("invalid_init");}if(!acceptedSchema)close("invalid_init");
        const [actualCode,actualSchema]=await Promise.all([sha256(msg.code as string),sha256(msg.schema as string)]);
        if(state!=="fresh")fail("protocol_closed");
        if(actualCode!==msg.code_digest||actualSchema!==msg.schema_digest)close("digest_mismatch");
        code=msg.code as string;codeDigest=actualCode;schemaDigest=actualSchema;schema=acceptedSchema;state="ready";
        return {v:2,type:"ready",code_digest:codeDigest,schema_digest:schemaDigest};
      }
      if(!exact(message,["v","type","sequence","time_ms","snapshot","input_generation"])||message.v!==2||message.type!=="frame"
          ||!Number.isSafeInteger(message.sequence)||message.sequence!==lastSequence+1||!Number.isSafeInteger(message.time_ms)||Object.is(message.time_ms,-0)
          ||Number(message.time_ms)<0||Number(message.time_ms)>MAX_FRAME_TIME_MS||!Number.isSafeInteger(message.input_generation)
          ||Number(message.input_generation)<lastGeneration||!schema)close("invalid_frame");
      const msg=message as Record<string,unknown>;const activeSchema=schema;if(!activeSchema)close("invalid_frame");
      const candidate=readInputSnapshot(msg.snapshot,activeSchema as InputSchema);if(!candidate||candidate.generation!==msg.input_generation)close("invalid_snapshot");const snapshot=candidate as InputSnapshot;
      lastSequence=msg.sequence as number;lastGeneration=msg.input_generation as number;
      let output="";try{output=await evaluate(code,msg.time_ms as number,deepFreezeSnapshot(snapshot));}catch{close("evaluation_failed");}
      if(state!=="ready")fail("protocol_closed");
      if(typeof output!=="string")close("invalid_output");try{decodeView(output);}catch{close("invalid_output");}
      return {v:2,type:"view",sequence:lastSequence,input_generation:lastGeneration,output};
    }finally{busy=false;}
  }});
}

export function createHostProtocolV2(code:string,codeDigest:string,schemaSource:string,schemaDigest:string,decodeView:Decoder){
  let acceptedSchema:InputSchema|null=null;try{acceptedSchema=decodeInputSchema(schemaSource);}catch{fail("invalid_init");}if(!acceptedSchema||typeof code!=="string"||!wellFormed(code)||!digest.test(codeDigest)||!digest.test(schemaDigest)||encoder.encode(code).byteLength>MAX_COMPILED_CODE_BYTES)fail("invalid_init");const schema=acceptedSchema as InputSchema;
  let state:"fresh"|"initializing"|"ready"|"closed"="fresh",sent=0,received=0,outstanding:number|null=null,lastGeneration=0;
  const close=(reason:string):never=>{state="closed";return fail(reason);};
  return Object.freeze({
    init(){if(state!=="fresh")close("invalid_state");state="initializing";return {v:2,type:"init",code,code_digest:codeDigest,schema:schemaSource,schema_digest:schemaDigest};},
    frame(timeMs:number,snapshot:InputSnapshot){if(state!=="ready"||outstanding!==null)close("concurrent_frame");const candidate=readInputSnapshot(snapshot,schema);if(!candidate||candidate.generation<lastGeneration||!Number.isSafeInteger(timeMs)||Object.is(timeMs,-0)||timeMs<0||timeMs>MAX_FRAME_TIME_MS)close("invalid_frame");const valid=candidate as InputSnapshot;if(sent===Number.MAX_SAFE_INTEGER)close("sequence_exhausted");sent+=1;outstanding=sent;lastGeneration=valid.generation;return {v:2,type:"frame",sequence:sent,time_ms:timeMs,snapshot:valid,input_generation:valid.generation};},
    accept(message:unknown){if(state==="closed")fail("protocol_closed");if(state==="initializing"){
      if(!exact(message,["v","type","code_digest","schema_digest"])||message.v!==2||message.type!=="ready"||message.code_digest!==codeDigest||message.schema_digest!==schemaDigest)close("invalid_ready");state="ready";return {type:"ready" as const};}
      if(state!=="ready"||outstanding===null||!exact(message,["v","type","sequence","input_generation","output"])||message.v!==2||message.type!=="view"
          ||message.sequence!==outstanding||message.sequence!==received+1||message.input_generation!==lastGeneration||typeof message.output!=="string")close("invalid_view");
      const msg=message as Record<string,unknown>;let view:unknown;try{view=decodeView(msg.output as string);}catch{close("invalid_output");}received=msg.sequence as number;outstanding=null;return {type:"view" as const,sequence:received,inputGeneration:lastGeneration,view};},
    timeout(sequence:number){if(state!=="ready"||outstanding!==sequence)close("invalid_timeout");close("worker_timeout");},
    crash(){if(state==="closed")fail("protocol_closed");close("worker_crash");},
    get busy(){return outstanding!==null;},
  });
}
