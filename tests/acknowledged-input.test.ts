// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcknowledgedInput, terminalReportsOnly } from "../static/pane-actions.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
test("only complete terminal reports bypass a new draft lease", () => {
  for (const report of [
    "\x1b[I", "\x1b[O", "\x1b[<0;5;5M", "\x1b[<32;6;7M",
    "\x1b[<0;6;7m", "\x1b[M !!", "\x1b[7;9R", "\x1b[0n",
    "\x1b[I\x1b[<0;5;5M\x1b[O",
  ]) assert.equal(terminalReportsOnly(bytes(report)), true, JSON.stringify(report));
  for (const human of [
    "", "draft", "\r", "\x1b[I\r", "\x1b[<0;5;5Mhuman",
    "\x1b[200~paste\x1b[201~", "\x1b[<0;5;5X", "\x1b[<0;5;M",
    "\x1b[1;2A", "\x1b[?1004h", "\x1b[M \r!",
    "\x1b[I".repeat(22000), // cannot split a report across I frames
  ]) assert.equal(terminalReportsOnly(bytes(human)), false, JSON.stringify(human));
});

const setup = () => {
  const frames: Uint8Array[] = [];
  const states: string[] = [];
  let open = true;
  const input = createAcknowledgedInput({
    attachmentId: "opaque-attachment-0123456789",
    created: 42,
    send: (frame) => { if (!open) throw Error("closed"); frames.push(frame); },
    state: (state) => states.push(state),
  });
  return { input, frames, states, close: () => { open = false; } };
};

test("bytes remain retained until native ACK; no implicit resend after disconnection", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.write(bytes("first")), true);
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 5);
  input.disconnect();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(frames.length, 1);
  assert.equal(input.state, "uncertain");
  assert.equal(input.retry(), true); // explicit human choice, same incarnation
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], frames[1]); // native deduplication, not a fresh sequence
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  assert.equal(input.pendingBytes, 0);
});

test("fenced rejection and new input stay bounded and require human review", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("one"));
  input.ack(42, "opaque-attachment-0123456789", 1, false);
  assert.equal(input.state, "review");
  input.write(bytes("two"));
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 6);
  input.connect(43, "opaque-attachment-0123456789", true);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
  assert.equal(input.discard(), true);
  assert.equal(input.pendingBytes, 0);
});

test("malformed ACK and exceeded buffer fail closed, no legacy fallback", () => {
  const { input, frames } = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.write(bytes("x")), true);
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.state, "uncertain");
  assert.equal(input.write(new Uint8Array(1024 * 1024 + 1)), false);
  assert.equal(frames.length, 1);
  assert.equal(input.pendingBytes, 1);
});

test("reports never complete a human draft, including onBinary's complete hint", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("draft"));
  input.write(bytes("\x1b[O"), true);
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.completed, false);
  assert.equal(input.pendingHumanBytes, 0);
  input.write(bytes("\x1b[I\r"));
  assert.equal(input.pendingHumanBytes, 4);
});

test("a submitted human frame releases on ACK even when a report follows it", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("draft\r"), true);
  input.write(bytes("\x1b[<0;5;5M"), true);
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  assert.equal(input.completed, true);
  assert.equal(input.pendingHumanBytes, 0);
  assert.ok(input.pendingBytes > 0, "the report still needs its own ACK");
  input.ack(42, "opaque-attachment-0123456789", 2, true);
  assert.equal(input.completed, false);
  assert.equal(input.pendingBytes, 0);
});

test("uncertain discard permanently halts this attachment across socket reopen", () => {
  const {input, frames} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("possibly delivered"));
  input.disconnect();
  assert.equal(input.deliveryUncertain, true);
  assert.equal(input.discard(), true);
  assert.equal(input.state, "halted");
  input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(input.state, "halted");
  assert.equal(input.write(bytes("new input")), false);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
  const fresh = setup();
  fresh.input.connect(42, "opaque-attachment-0123456789", true);
  assert.equal(fresh.input.write(bytes("new input")), true);
  assert.equal(fresh.frames.length, 1);
});

test("unsent or rejected input without an acknowledged draft can clear its lease", () => {
  const {input} = setup();
  assert.equal(input.write(bytes("not sent")), true);
  assert.equal(input.deliveryUncertain, false);
  input.discard();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("rejected"));
  input.ack(42, "opaque-attachment-0123456789", 1, false, "input_pending");
  assert.equal(input.deliveryUncertain, false);
});

test("a rejected final frame cannot release an earlier acknowledged partial draft", () => {
  const {input} = setup();
  input.connect(42, "opaque-attachment-0123456789", true);
  input.write(bytes("partial"));
  input.ack(42, "opaque-attachment-0123456789", 1, true);
  input.write(bytes("\r"), true);
  input.ack(42, "opaque-attachment-0123456789", 2, false, "input_pending");
  assert.equal(input.deliveryUncertain, false);
  assert.equal(input.incompleteHumanInput, true);
});

test("v2 sends only after a confirmed slot and resumes exactly the confirmed generation", () => {
  const frames: Uint8Array[] = [];
  const input = createAcknowledgedInput({version: 2, created: 42,
    send: frame => frames.push(frame), state: () => {}});
  assert.equal(input.write(bytes("queued")), true);
  assert.equal(frames.length, 0);
  assert.equal(input.connectV2(42, 7, 11, "0123456789abcdef0123456789abcdef", true), true);
  assert.deepEqual(input.binding, {slot: 7, generation: 11, actorNonce: "0123456789abcdef0123456789abcdef"});
  assert.equal(input.state, "review");
  assert.equal(frames.length, 0, "confirmation does not automatically submit a queued draft");
  assert.equal(input.retry(), true);
  assert.equal(frames.length, 1);
  input.disconnect();
  assert.equal(input.connectV2(42, 7, 11, "0123456789abcdef0123456789abcdef", true), true);
  assert.equal(input.state, "uncertain");
  assert.equal(frames.length, 1);
  input.ackV2(42, 7, 12, 1, true);
  assert.equal(input.pendingBytes, 6);
  input.ackV2(42, 7, 11, 1, true);
  assert.equal(input.pendingBytes, 0);
});

test("v2 refused or mismatched capability cannot change bindings or silently use a new actor", () => {
  const input = createAcknowledgedInput({version: 2, created: 42,
    send: () => assert.fail("no input"), state: () => {}});
  assert.equal(input.connectV2(42, 0, 3, "0123456789abcdef0123456789abcdef", true), true);
  input.disconnect();
  assert.equal(input.connectV2(42, 0, 3, "ffffffffffffffffffffffffffffffff", true), false);
  assert.deepEqual(input.binding, {slot: 0, generation: 3, actorNonce: "0123456789abcdef0123456789abcdef"});
  assert.equal(input.write(bytes("not admitted")), false);
  assert.equal(input.connectV2(42, 0, 3, "0123456789abcdef0123456789abcdef", true), false);
  const first = createAcknowledgedInput({version: 2, created: 42,
    send: () => assert.fail("no input"), state: () => {}});
  first.write(bytes("not admitted"));
  first.reject();
  assert.equal(first.pendingBytes, 12);
  assert.equal(first.retry(), false);
  first.discard();
  assert.equal(first.state, "halted");
});

test("v2 nonce is mandatory and invalid or noncanonical values cannot bind", () => {
  for (const nonce of ["", "ABCDEF0123456789abcdef0123456789", "0123456789abcdef", "g".repeat(32)]) {
    const input = createAcknowledgedInput({version: 2, created: 42, send: () => assert.fail(), state: () => {}});
    assert.equal(input.connectV2(42, 0, 1, nonce, true), false);
    assert.equal(input.binding, null);
  }
});

test("a v2 terminal rejection remains halted across disconnect and late receipts", () => {
  const {input, frames} = (() => {
    const frames: Uint8Array[] = [];
    const input = createAcknowledgedInput({version: 2, created: 42,
      send: frame => frames.push(frame), state: () => {}});
    return {input, frames};
  })();
  input.connectV2(42, 0, 1, "0123456789abcdef0123456789abcdef", true);
  input.write(bytes("rejected"));
  input.ackV2(42, 0, 1, 1, false, "sequence_gap");
  assert.equal(input.state, "halted");
  input.disconnect();
  input.ackV2(42, 0, 1, 2, true);
  assert.equal(input.state, "halted");
  assert.equal(input.connectV2(42, 0, 1, "0123456789abcdef0123456789abcdef", true), false);
  assert.equal(input.retry(), false);
  assert.equal(frames.length, 1);
});
