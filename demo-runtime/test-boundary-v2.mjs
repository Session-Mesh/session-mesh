// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {decodeView, renderView} from "./view-codec-v2.mjs";
import {createHostProtocol, createWorkerProtocol} from "./worker-protocol-v0.mjs";

globalThis.crypto ??= webcrypto;
const code = "fixture-v2";
const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(code))), byte => byte.toString(16).padStart(2, "0")).join("");
const decoder = source => decodeView(source, "mesh-view-v2");
const frame = time => JSON.stringify({format: "mesh-view-v2", nodes: [{type: "row", children: [
  {type: "gear", angle: time}, {type: "gear", angle: (360 - time) % 360},
  {type: "text", text: '<img src="/sink">'},
]}]});
const worker = createWorkerProtocol(async (_code, time) => frame(time), decoder);
const host = createHostProtocol(code, digest, decoder);
assert.deepEqual(host.accept(await worker.handle(host.init())), {type: "ready"});
const frames = [];
for (const angle of [0, 90, 180]) {
  const accepted = host.accept(await worker.handle(host.frame(angle)));
  frames.push(accepted.view.nodes[0].children.slice(0, 2).map(node => node.angle));
}
assert.deepEqual(frames, [[0, 0], [90, 270], [180, 180]]);
assert.throws(() => decoder('{"format":"mesh-view-v1","nodes":[{"type":"gear","angle":0}]}'));
assert.throws(() => decoder('{"format":"mesh-view-v2","nodes":[{"type":"gear","angle":360}]}'));

class Element {
  constructor(tag, ownerDocument) { this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.style = {setProperty: (key, value) => { this.style[key] = value; }}; }
  set textContent(value) { this.text = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
const doc = {createElement: tag => new Element(tag, doc)};
const root = new Element("main", doc);
renderView(root, decoder(frame(90)));
assert.equal(root.children[0].children[2].text, '<img src="/sink">');
assert.equal(root.children[0].children[2].children.length, 0);
assert.equal(root.children[0].children[0].style["--mesh-gear-angle"], "90deg");
console.log("closed demo boundary v2: ok");
