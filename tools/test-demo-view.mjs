// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const context = vm.createContext({TextEncoder, TextDecoder, Uint8Array});
vm.runInContext(await readFile("static/demo-view.js", "utf8"), context);
const { readScene, readView } = context.MeshDemoView;
for (const filename of ["demo-scene-v1-vectors.json", "demo-scene-v2-vectors.json"]) {
  const shared = JSON.parse(await readFile(`ocaml/mesh_wire/test/${filename}`, "utf8"));
  for (const vector of shared.cases) {
    assert.equal(readScene(vector.scene) !== null, vector.accepted, vector.name);
  }
}
const valid = { format: "mesh-scene-v1", version: 1, title: "Flow", theme: "dark",
  initial: "start", states: [
    { id: "start", view: { format: "mesh-view-v1", nodes: [
      { type: "text", text: "<img src=x>" }] }, choices: [{ label: "Next", target: "done" }] },
    { id: "done", view: { format: "mesh-view-v1", nodes: [] }, choices: [] },
  ] };
assert.equal(readScene(valid)?.initial, "start");
assert.equal(readScene({ ...valid, source: "javascript:evil()" }), null);
assert.equal(readScene({ ...valid, states: [{ ...valid.states[0], choices: [
  { label: "Next", target: "missing" }] }, valid.states[1]] }), null);
assert.equal(readScene({ ...valid, states: [{ ...valid.states[0], view: {
  format: "mesh-view-v1", nodes: [{ type: "text", text: "x", onclick: "evil()" }] } },
  valid.states[1]] }), null);
assert.equal(readScene({ ...valid, states: Array.from({ length: 17 }, (_, index) => ({
  id: `s${index}`, view: { format: "mesh-view-v1", nodes: [] }, choices: [] })) }), null);
const hundredNodes = Array.from({length: 20}, () => ({type: "card",
  children: Array.from({length: 4}, () => ({type: "text", text: "x"}))}));
assert.notEqual(readView({format: "mesh-view-v1", nodes: hundredNodes}), null);
assert.notEqual(readView({format: "mesh-view-v1", nodes: hundredNodes}), null);
assert.equal(readView({format: "mesh-view-v1", nodes: [...hundredNodes,
  {type: "text", text: "x"}]}), null);
