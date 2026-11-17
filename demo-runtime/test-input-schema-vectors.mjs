// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import fs from "node:fs";
import assert from "node:assert/strict";
import {decodeInputSchema} from "./input-codec-v1.mjs";
const corpus = JSON.parse(fs.readFileSync(new URL("../ocaml/mesh_wire/test/demo-input-schema-v1-vectors.json", import.meta.url)));
function fixture(vector) {
  if (!vector.fixture) return vector.bytes;
  if (vector.fixture === "controls") return JSON.stringify({format:"mesh-input-schema-v1",controls:Array.from({length:vector.count},(_,i)=>({type:"toggle",id:`c${i}`,label:`C${i}`,initial:false}))});
  if (vector.fixture === "label") return JSON.stringify({format:"mesh-input-schema-v1",controls:[{type:"toggle",id:"x",label:"é".repeat(Math.floor(vector.count/2))+"x".repeat(vector.count%2),initial:false}]});
  if (vector.fixture === "id") return JSON.stringify({format:"mesh-input-schema-v1",controls:[{type:"toggle",id:"a".repeat(vector.count),label:"X",initial:false}]});
  if (vector.fixture === "choice-options") { const options=Array.from({length:vector.count},(_,i)=>`o${i}`); return JSON.stringify({format:"mesh-input-schema-v1",controls:[{type:"choice",id:"x",label:"X",options,initial:options[0]??"o0"}]}); }
  const controls=[];
  const optionCount=vector.fixture === "bytes" ? 64 : vector.count;
  for(let at=0;at<optionCount;){const n=Math.min(16,optionCount-at);const options=Array.from({length:n},(_,i)=>`o${at+i}`);controls.push({type:"choice",id:`c${controls.length}`,label:`C${controls.length}`,options,initial:options[0]});at+=n;}
  if(vector.fixture === "options") return JSON.stringify({format:"mesh-input-schema-v1",controls});
  let source=JSON.stringify({format:"mesh-input-schema-v1",controls});
  let needed=vector.count-encoder.encode(source).byteLength;
  for(const control of controls) for(let i=1;i<control.options.length&&needed>0;i++){const add=Math.min(128-encoder.encode(control.options[i]).byteLength,needed);control.options[i]+="x".repeat(add);needed-=add;}
  assert.equal(needed,0,`${vector.name}: fixture capacity`);
  return JSON.stringify({format:"mesh-input-schema-v1",controls});
}
const encoder = new TextEncoder();
for (const vector of corpus.vectors) {
  const bytes=fixture(vector);
  assert.equal(encoder.encode(bytes).byteLength,vector.fixture === "bytes" ? vector.count : encoder.encode(bytes).byteLength,vector.name);
  let valid = true; try { const decoded=decodeInputSchema(bytes); if (JSON.stringify(decoded)!==bytes) valid=false; } catch { valid=false; }
  assert.equal(valid, vector.valid, vector.name);
}
console.log(`demo input schema vectors: ${corpus.vectors.length} passed`);
