// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import {
  decodeView, decodeViewBytes, MAX_JSON_MEMBERS, MAX_JSON_NESTING, MAX_VIEW_OUTPUT_BYTES,
  renderView, validateView, VIEW_V0_LIMITS,
} from "./view-codec-v0.mjs";
import {
  createHostProtocol, createWorkerProtocol, MAX_COMPILED_CODE_BYTES, MAX_FRAME_TIME_MS,
} from "./worker-protocol-v0.mjs";

const encoder = new TextEncoder();
const code = "fixture";
const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code))),
  byte => byte.toString(16).padStart(2, "0")).join("");
const output = JSON.stringify({type: "text", text: '<img src="/sink">'});

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

function rejectsView(source, message) {
  assert.throws(() => decodeView(source), Error, message);
}

assert.equal(decodeView(output).text, '<img src="/sink">');
assert.equal(decodeView('{"type":"text","text":"💥"}').text, "💥");
assert.equal(decodeView('{"type":"text","text":"\\ud83d\\udca5"}').text, "💥");
for (const text of ["printable ASCII", "accentué", "💥"]) {
  assert.equal(validateView({type: "text", text}).text, text, `object accepts ${JSON.stringify(text)}`);
  assert.equal(decodeView(JSON.stringify({type: "text", text})).text, text,
    `JSON accepts ${JSON.stringify(text)}`);
}
const refusedScalars = [
  ["NUL", "\u0000"], ["TAB", "\u0009"], ["LF", "\u000a"], ["CR", "\u000d"],
  ["C0 unit separator", "\u001f"], ["DEL", "\u007f"], ["C1", "\u0085"],
  ["Arabic letter mark", "\u061c"], ["left-to-right mark", "\u200e"],
  ["right-to-left override", "\u202e"], ["left-to-right isolate", "\u2066"],
  ["pop directional isolate", "\u2069"], ["zero-width joiner", "\u200d"],
  ["byte-order mark", "\ufeff"], ["line separator", "\u2028"],
  ["paragraph separator", "\u2029"], ["lone high surrogate", String.fromCharCode(0xd800)],
  ["lone low surrogate", String.fromCharCode(0xdc00)],
];
for (const [label, text] of refusedScalars) {
  assert.throws(() => validateView({type: "text", text}), /invalid text node/,
    `object rejects ${label}`);
  rejectsView(JSON.stringify({type: "text", text}), `JSON rejects ${label}`);
}
rejectsView('{"type":"text","text":"a","text":"b"}', "duplicate keys");
rejectsView('{"type":"text","text":"\\ud800"}', "unpaired escaped high surrogate");
rejectsView('{"type":"text","text":"\\udc00"}', "unpaired escaped low surrogate");
rejectsView(`{"type":"text","text":"${String.fromCharCode(0xd800)}"}`, "raw unpaired surrogate");
rejectsView('{"type":"text","text":"x"} trailing', "trailing bytes");
rejectsView('{"type":"text","text":"x","extra":0}', "unknown field");
rejectsView('{"type":"gear","angle":-0}', "negative zero is not a canonical angle");
rejectsView('{"type":"gear","angle":1.0}', "fraction syntax is not a canonical integer");
rejectsView('{"type":"gear","angle":1e-400}', "numeric underflow cannot become zero");
assert.throws(() => validateView({type: "gear", angle: -0}), /invalid gear node/,
  "object entrypoint rejects negative zero");
assert.throws(() => decodeViewBytes(Uint8Array.of(0xc3, 0x28)), /invalid view encoding/,
  "malformed UTF-8");
assert.throws(() => decodeViewBytes(new Uint8Array(MAX_VIEW_OUTPUT_BYTES + 1)),
  /invalid view encoding/, "byte quota");
assert.throws(() => validateView({type: "text", text: "💥".repeat(501)}), /invalid text node/,
  "text quota counts UTF-8 bytes");
const exactText = "x".repeat(VIEW_V0_LIMITS.maxTextBytes);
for (const [label, check] of [
  ["object", value => validateView(value)],
  ["decoded JSON", value => decodeView(JSON.stringify(value))],
]) {
  assert.equal(check({type: "text", text: exactText}).text.length, VIEW_V0_LIMITS.maxTextBytes,
    `${label} accepts exact text bytes`);
  assert.throws(() => check({type: "text", text: `${exactText}x`}), /invalid text node/,
    `${label} rejects one text byte over`);
}
assert.throws(() => validateView({type: "card", children: Array.from(
  {length: VIEW_V0_LIMITS.maxChildren + 1}, () => ({type: "text", text: "x"}))}),
  /invalid view node/, "child quota");

function nodeTree(textLeaves) {
  const widths = [24, 24, 24, textLeaves - 72];
  return {type: "card", children: widths.map(width => ({
    type: "row", children: Array.from({length: width}, () => ({type: "text", text: "x"})),
  }))};
}
const exactNodes = nodeTree(VIEW_V0_LIMITS.maxNodes - 5);
assert.equal(validateView(exactNodes), exactNodes, "exact node quota is accepted");
const excessNodes = nodeTree(VIEW_V0_LIMITS.maxNodes - 4);
assert.throws(() => validateView(excessNodes), /view bounds exceeded/,
  "one node over quota is rejected");

function nestedView(groups) {
  let view = {type: "text", text: "end"};
  for (let count = 0; count < groups; count += 1) view = {type: "card", children: [view]};
  return view;
}
const exactDepth = nestedView(VIEW_V0_LIMITS.maxDepth);
assert.equal(validateView(exactDepth), exactDepth, "exact schema depth is accepted");
const excessDepth = nestedView(VIEW_V0_LIMITS.maxDepth + 1);
assert.throws(() => validateView(excessDepth), /view bounds exceeded/,
  "one schema level over is rejected");

const exactMembers = `[${Array.from({length: MAX_JSON_MEMBERS}, () => "0").join(",")}]`;
const excessMembers = `[${Array.from({length: MAX_JSON_MEMBERS + 1}, () => "0").join(",")}]`;
const exactNesting = `${"[".repeat(MAX_JSON_NESTING)}0${"]".repeat(MAX_JSON_NESTING)}`;
const excessNesting = `${"[".repeat(MAX_JSON_NESTING + 1)}0${"]".repeat(MAX_JSON_NESTING + 1)}`;
const outputAtLimit = `${" ".repeat(MAX_VIEW_OUTPUT_BYTES - encoder.encode(output).byteLength)}${output}`;
assert.equal(encoder.encode(outputAtLimit).byteLength, MAX_VIEW_OUTPUT_BYTES);
const decodingQuotaCases = [
  ["nodes", JSON.stringify(exactNodes), JSON.stringify(excessNodes), null, /view bounds exceeded/],
  ["schema depth", JSON.stringify(exactDepth), JSON.stringify(excessDepth), null,
    /invalid view encoding|view bounds exceeded/],
  ["JSON members", exactMembers, excessMembers, /invalid view node/, /invalid view encoding/],
  ["JSON nesting", exactNesting, excessNesting, /invalid view node/, /invalid view encoding/],
  ["output bytes", outputAtLimit, ` ${outputAtLimit}`, null, /invalid view encoding/],
];
for (const [label, exactSource, excessSource, exactError, excessError] of decodingQuotaCases) {
  if (exactError) assert.throws(() => decodeView(exactSource), exactError, `exact ${label}`);
  else assert.ok(decodeView(exactSource), `exact ${label} is accepted`);
  assert.throws(() => decodeView(excessSource), excessError, `one over ${label} is rejected`);
}

const originalDocument = globalThis.document;
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this._text = ""; }
  set textContent(value) { this._text = value; }
  get textContent() { return this._text; }
  append(child) { this.children.push(child); }
  replaceChildren(child) { this.children = [child]; }
}
globalThis.document = {createElement: tag => new Element(tag)};
try {
  const container = new Element("main");
  renderView(decodeView(output), container);
  assert.equal(container.children[0].tag, "p");
  assert.equal(container.children[0].textContent, '<img src="/sink">');
  assert.deepEqual(container.children[0].children, [], "guest text never creates DOM children");
  for (const [label, text] of refusedScalars) {
    assert.throws(() => renderView({type: "text", text}, container), /invalid text node/,
      `renderer rejects ${label}`);
  }
} finally {
  globalThis.document = originalDocument;
}

async function roundTrip() {
  const worker = createWorkerProtocol(async (receivedCode, timeMs) => {
    assert.equal(receivedCode, code);
    return JSON.stringify({type: "gear", angle: timeMs});
  });
  const host = createHostProtocol(code, digest);
  assert.deepEqual(host.accept(await worker.handle(host.init())), {type: "ready"});
  const first = host.accept(await worker.handle(host.frame(7)));
  assert.equal(first.type, "view");
  assert.equal(first.sequence, 1);
  assert.equal(first.view.type, "gear");
  assert.equal(first.view.angle, 7);
  const second = host.accept(await worker.handle(host.frame(8)));
  assert.equal(second.type, "view");
  assert.equal(second.sequence, 2);
  assert.equal(second.view.type, "gear");
  assert.equal(second.view.angle, 8);
  assert.deepEqual(host.accept(await worker.handle(host.close())), {type: "closed", lastSequence: 2});
  await assert.rejects(worker.handle({v: 1, type: "close"}), /protocol_closed/);
  assert.throws(() => host.frame(9), /invalid_state/, "host cannot be reused after close");
}
await roundTrip();

async function initializedWorker() {
  const worker = createWorkerProtocol(async () => output);
  await worker.handle({v: 1, type: "init", code, code_digest: digest});
  return worker;
}

const exactCode = "x".repeat(MAX_COMPILED_CODE_BYTES);
const exactCodeDigest = await sha256(exactCode);
const protocolQuotaCases = [
  [
    "compiled code bytes",
    async () => {
      const exactHost = createHostProtocol(exactCode, exactCodeDigest);
      assert.equal(exactHost.init().code.length, MAX_COMPILED_CODE_BYTES);
      const exactWorker = createWorkerProtocol(async () => output);
      assert.equal((await exactWorker.handle({v: 1, type: "init", code: exactCode,
        code_digest: exactCodeDigest})).type, "ready");
    },
    async () => {
      const excessCode = `${exactCode}x`;
      assert.throws(() => createHostProtocol(excessCode, exactCodeDigest), /invalid_init/);
      const excessWorker = createWorkerProtocol(async () => output);
      await assert.rejects(excessWorker.handle({v: 1, type: "init", code: excessCode,
        code_digest: exactCodeDigest}), /invalid_init/);
    },
  ],
  [
    "frame time",
    async () => {
      const exactWorker = await initializedWorker();
      assert.equal((await exactWorker.handle({v: 1, type: "frame", sequence: 1,
        time_ms: MAX_FRAME_TIME_MS})).type, "view");
      const exactHost = readyHost();
      assert.equal(exactHost.frame(MAX_FRAME_TIME_MS).time_ms, MAX_FRAME_TIME_MS);
    },
    async () => {
      const excessWorker = await initializedWorker();
      await assert.rejects(excessWorker.handle({v: 1, type: "frame", sequence: 1,
        time_ms: MAX_FRAME_TIME_MS + 1}), /invalid_frame/);
      const excessHost = readyHost();
      assert.throws(() => excessHost.frame(MAX_FRAME_TIME_MS + 1), /invalid_state/);
    },
  ],
  [
    "worker output bytes",
    async () => {
      const exactWorker = createWorkerProtocol(async () => outputAtLimit);
      await exactWorker.handle({v: 1, type: "init", code, code_digest: digest});
      assert.equal((await exactWorker.handle({v: 1, type: "frame", sequence: 1,
        time_ms: 0})).output.length, outputAtLimit.length);
    },
    async () => {
      const excessWorker = createWorkerProtocol(async () => ` ${outputAtLimit}`);
      await excessWorker.handle({v: 1, type: "init", code, code_digest: digest});
      await assert.rejects(excessWorker.handle({v: 1, type: "frame", sequence: 1,
        time_ms: 0}), /invalid_output/);
    },
  ],
];
for (const [label, acceptsExact, rejectsOneOver] of protocolQuotaCases) {
  await acceptsExact();
  await rejectsOneOver();
  assert.ok(label, "quota case has a diagnostic label");
}

let worker = createWorkerProtocol(async () => output);
await assert.rejects(worker.handle({v: 1, type: "init", code: String.fromCharCode(0xd800),
  code_digest: digest}), /invalid_init/, "worker refuses non-scalar code strings");
worker = createWorkerProtocol(async () => output);
await assert.rejects(worker.handle({v: 1, type: "init", code, code_digest: "0".repeat(64)}),
  /digest_mismatch/);
await assert.rejects(worker.handle({v: 1, type: "init", code, code_digest: digest}),
  /protocol_closed/, "digest refusal is terminal");
worker = await initializedWorker();
await assert.rejects(worker.handle({v: 1, type: "init", code, code_digest: digest}),
  /invalid_frame/, "worker refuses a second init");
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 1, time_ms: 0}),
  /protocol_closed/, "second init refusal is terminal");
worker = await initializedWorker();
await worker.handle({v: 1, type: "frame", sequence: 1, time_ms: 0});
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 1, time_ms: 0}),
  /invalid_frame/, "worker refuses replay");
worker = await initializedWorker();
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 2, time_ms: 0}),
  /invalid_frame/, "worker refuses a gap");
worker = await initializedWorker();
await assert.rejects(worker.handle({v: 2, type: "frame", sequence: 1, time_ms: 0}),
  /invalid_frame/, "worker refuses a different version");
worker = await initializedWorker();
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 1, time_ms: -0}),
  /invalid_frame/, "worker refuses negative-zero frame time");
const negativeZeroHost = readyHost();
assert.throws(() => negativeZeroHost.frame(-0), /invalid_state/,
  "host refuses negative-zero frame time");
worker = await initializedWorker();
await assert.rejects(worker.handle({v: 1, type: "close", extra: true}), /invalid_close/,
  "worker refuses unknown close fields");
worker = createWorkerProtocol(async () => '{"type":"text","text":"a","text":"b"}');
await worker.handle({v: 1, type: "init", code, code_digest: digest});
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 1, time_ms: 0}),
  /invalid_output/, "worker applies the strict codec before returning output");

let releaseEvaluation;
worker = createWorkerProtocol(() => new Promise(resolve => { releaseEvaluation = resolve; }));
await worker.handle({v: 1, type: "init", code, code_digest: digest});
const pending = worker.handle({v: 1, type: "frame", sequence: 1, time_ms: 0});
await assert.rejects(worker.handle({v: 1, type: "frame", sequence: 2, time_ms: 0}),
  /concurrent_message/, "concurrent delivery closes the worker");
releaseEvaluation(output);
await assert.rejects(pending, /protocol_closed/, "in-flight output is discarded after closure");

function readyHost() {
  const host = createHostProtocol(code, digest);
  host.init();
  host.accept({v: 1, type: "ready", code_digest: digest});
  return host;
}
let host = readyHost();
assert.throws(() => host.accept({v: 1, type: "error", code: "evaluation_failed"}),
  /worker_evaluation_failed/, "host closes on an exact worker error");
host = readyHost();
assert.throws(() => host.accept({v: 1, type: "error", code: "invented"}),
  /invalid_view_frame/, "host refuses an unknown error code");
host = readyHost();
host.frame(0);
host.frame(1);
assert.throws(() => host.accept({v: 1, type: "view", sequence: 2, output}),
  /invalid_view_frame/, "host refuses out-of-order responses");
host = readyHost();
host.frame(0);
host.accept({v: 1, type: "view", sequence: 1, output});
assert.throws(() => host.accept({v: 1, type: "view", sequence: 1, output}),
  /invalid_view_frame/, "host refuses response replay");
host = readyHost();
host.frame(0);
assert.throws(() => host.close(), /invalid_closed|invalid_state/,
  "host cannot close with a frame still outstanding");
host = readyHost();
assert.throws(() => host.accept({v: 2, type: "view", sequence: 1, output}),
  /invalid_view_frame/, "first invalid host frame closes the protocol");
assert.throws(() => host.accept({v: 2, type: "view", sequence: 1, output}),
  /protocol_closed/, "repeated invalid host frames cannot revive the protocol");

host = createHostProtocol(code, digest);
host.init();
assert.throws(() => host.init(), /invalid_state/, "host refuses a second init");
assert.throws(() => host.accept({v: 1, type: "ready", code_digest: digest}),
  /protocol_closed/, "host second-init refusal is terminal");

console.log("closed demo boundary v0: ok");
