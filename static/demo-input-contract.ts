// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {parseJsonStrict} from "./demo-view-contract";

export const INPUT_LIMITS = Object.freeze({
  maxSchemaBytes: 8 * 1024,
  maxSnapshotBytes: 4 * 1024,
  maxControls: 16,
  maxOptions: 64,
  maxLabelBytes: 128,
  minNumber: -1_000_000,
  maxNumber: 1_000_000,
});

export type RangeControl = {type:"range"; id:string; label:string; min:number; max:number; step:number; initial:number};
export type ToggleControl = {type:"toggle"; id:string; label:string; initial:boolean};
export type ChoiceControl = {type:"choice"; id:string; label:string; options:string[]; initial:string};
export type ActionControl = {type:"action"; id:string; label:string; initial:0};
export type InputControl = RangeControl | ToggleControl | ChoiceControl | ActionControl;
export type InputSchema = {format:"mesh-input-schema-v1"; controls:InputControl[]};
export type InputValue = {id:string; value:number|boolean|string};
export type InputSnapshot = {format:"mesh-input-snapshot-v1"; generation:number; values:InputValue[]};
export type InputGesture = {id:string; value?:number|boolean|string};

const encoder = new TextEncoder();
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const exact = (value:unknown, keys:readonly string[]):value is Record<string,unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key,index)=>key===expected[index]);
};
const safeBound = (value:unknown):value is number => Number.isSafeInteger(value) && !Object.is(value,-0)
  && Number(value)>=INPUT_LIMITS.minNumber && Number(value)<=INPUT_LIMITS.maxNumber;
const printable = (value:unknown):value is string => {
  if (typeof value!=="string" || value.length===0 || encoder.encode(value).byteLength>INPUT_LIMITS.maxLabelBytes
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  for(let index=0;index<value.length;index+=1){const unit=value.charCodeAt(index);if(unit>=0xd800&&unit<=0xdbff){const low=value.charCodeAt(index+1);if(!(low>=0xdc00&&low<=0xdfff))return false;index+=1;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}
  return true;
};
const size = (value:unknown):number => encoder.encode(JSON.stringify(value)).byteLength;

function readInputSchemaUnchecked(value:unknown):InputSchema|null {
  if (!exact(value,["format","controls"]) || value.format!=="mesh-input-schema-v1"
      || !Array.isArray(value.controls) || value.controls.length<1 || value.controls.length>INPUT_LIMITS.maxControls
      || size(value)>INPUT_LIMITS.maxSchemaBytes) return null;
  const ids=new Set<string>(); let options=0;
  for(const raw of value.controls){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const control=raw as Record<string,unknown>;
    if(typeof control.id!=="string"||!idPattern.test(control.id)||ids.has(control.id)||!printable(control.label))return null;
    ids.add(control.id);
    if(control.type==="range"){
      if(!exact(control,["type","id","label","min","max","step","initial"])||!safeBound(control.min)||!safeBound(control.max)
          ||!safeBound(control.step)||control.step<=0||control.min>control.max||!safeBound(control.initial)
          ||control.initial<control.min||control.initial>control.max||(control.initial-control.min)%control.step!==0
          ||(control.max-control.min)%control.step!==0)return null;
    }else if(control.type==="toggle"){
      if(!exact(control,["type","id","label","initial"])||typeof control.initial!=="boolean")return null;
    }else if(control.type==="choice"){
      if(!exact(control,["type","id","label","options","initial"])||!Array.isArray(control.options)
          ||control.options.length<2||control.options.length>16||!control.options.every(printable)
          ||new Set(control.options).size!==control.options.length||typeof control.initial!=="string"
          ||!control.options.includes(control.initial))return null;
      options+=control.options.length;if(options>INPUT_LIMITS.maxOptions)return null;
    }else if(control.type==="action"){
      if(!exact(control,["type","id","label","initial"])||control.initial!==0)return null;
    }else return null;
  }
  return value as unknown as InputSchema;
}

export function readInputSchema(value:unknown):InputSchema|null {
  try{return readInputSchemaUnchecked(value);}catch{return null;}
}

export function decodeInputSchema(source:string):InputSchema {
  if(typeof source!=="string"||encoder.encode(source).byteLength>INPUT_LIMITS.maxSchemaBytes)throw Error("invalid_input_schema");
  let parsed:unknown;try{parsed=parseJsonStrict(source);}catch{throw Error("invalid_input_schema");}
  const schema=readInputSchema(parsed);if(!schema)throw Error("invalid_input_schema");
  const controls=schema.controls.map(control=>control.type==="range"
    ?{type:control.type,id:control.id,label:control.label,min:control.min,max:control.max,step:control.step,initial:control.initial}
    :control.type==="choice"?{type:control.type,id:control.id,label:control.label,options:control.options,initial:control.initial}
    :{type:control.type,id:control.id,label:control.label,initial:control.initial});
  if(JSON.stringify({format:schema.format,controls})!==source)throw Error("invalid_input_schema");return schema;
}

export function initialSnapshot(schema:InputSchema):InputSnapshot {
  const checked=readInputSchema(schema);if(!checked)throw Error("invalid_input_schema");
  return {format:"mesh-input-snapshot-v1",generation:0,values:checked.controls.map(({id,initial})=>({id,value:initial}))};
}

function readInputSnapshotUnchecked(value:unknown,schema:InputSchema):InputSnapshot|null {
  const checked=readInputSchema(schema);
  if(!checked||!exact(value,["format","generation","values"])||value.format!=="mesh-input-snapshot-v1"
      ||!Number.isSafeInteger(value.generation)||Object.is(value.generation,-0)||Number(value.generation)<0
      ||!Array.isArray(value.values)||value.values.length!==checked.controls.length||size(value)>INPUT_LIMITS.maxSnapshotBytes)return null;
  for(let index=0;index<checked.controls.length;index+=1){
    const control=checked.controls[index];const entry=value.values[index];
    if(!exact(entry,["id","value"])||entry.id!==control.id)return null;
    const actual=entry.value;
    if(control.type==="range"&&(!safeBound(actual)||actual<control.min||actual>control.max||(actual-control.min)%control.step!==0))return null;
    if(control.type==="toggle"&&typeof actual!=="boolean")return null;
    if(control.type==="choice"&&(typeof actual!=="string"||!control.options.includes(actual)))return null;
    if(control.type==="action"&&(!Number.isSafeInteger(actual)||Object.is(actual,-0)||Number(actual)<0))return null;
  }
  return value as unknown as InputSnapshot;
}

export function readInputSnapshot(value:unknown,schema:InputSchema):InputSnapshot|null {
  try{return readInputSnapshotUnchecked(value,schema);}catch{return null;}
}

export function applyInputGesture(schema:InputSchema,snapshot:InputSnapshot,gesture:InputGesture):InputSnapshot {
  const current=readInputSnapshot(snapshot,schema);if(!current||!exact(gesture,gesture.value===undefined?["id"]:["id","value"]))throw Error("invalid_input_gesture");
  if(current.generation===Number.MAX_SAFE_INTEGER)throw Error("input_generation_exhausted");
  const index=schema.controls.findIndex(control=>control.id===gesture.id);if(index<0)throw Error("unknown_input");
  const control=schema.controls[index];let next:unknown;
  if(control.type==="action"){if(gesture.value!==undefined)throw Error("invalid_input_gesture");const prior=current.values[index].value as number;if(prior===Number.MAX_SAFE_INTEGER)throw Error("input_counter_exhausted");next=prior+1;}
  else {if(gesture.value===undefined||Object.is(gesture.value,current.values[index].value))throw Error("invalid_input_gesture");next=gesture.value;}
  const candidate:InputSnapshot={format:"mesh-input-snapshot-v1",generation:current.generation+1,
    values:current.values.map((entry,at)=>at===index?{id:entry.id,value:next as number|boolean|string}:{id:entry.id,value:entry.value})};
  if(!readInputSnapshot(candidate,schema))throw Error("invalid_input_gesture");return candidate;
}

export function deepFreezeSnapshot(snapshot:InputSnapshot):InputSnapshot {
  for(const entry of snapshot.values)Object.freeze(entry);Object.freeze(snapshot.values);return Object.freeze(snapshot);
}
