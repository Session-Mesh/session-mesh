// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {decodeView, MAX_VIEW_OUTPUT_BYTES} from "./view-codec-v0.mjs";

export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_COMPILED_CODE_BYTES = 128 * 1024;
export const MAX_FRAME_TIME_MS = 60_000;

const encoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/;
const errorCodes = new Set([
  "concurrent_message", "digest_mismatch", "evaluation_failed", "invalid_close", "invalid_frame",
  "invalid_init", "invalid_output", "protocol_closed", "worker_failed",
]);

export class WorkerProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkerProtocolError";
    this.code = code;
  }
}

function fail(code) {
  throw new WorkerProtocolError(code);
}

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function validDigest(value) {
  return typeof value === "string" && digestPattern.test(value);
}

function wellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function createWorkerProtocol(evaluate, viewDecoder = decodeView) {
  if (typeof evaluate !== "function") throw new TypeError("evaluate must be a function");
  let state = "fresh";
  let code;
  let digest;
  let lastSequence = 0;
  let busy = false;

  function closeWith(codeValue) {
    state = "closed";
    fail(codeValue);
  }

  return Object.freeze({
    async handle(message) {
      if (busy) closeWith("concurrent_message");
      if (state === "closed") fail("protocol_closed");
      busy = true;
      try {
        if (state === "fresh") {
          if (!exact(message, ["v", "type", "code", "code_digest"])
              || message.v !== WORKER_PROTOCOL_VERSION || message.type !== "init"
              || typeof message.code !== "string" || !wellFormedString(message.code)
              || encoder.encode(message.code).byteLength > MAX_COMPILED_CODE_BYTES
              || !validDigest(message.code_digest)) closeWith("invalid_init");
          const actual = await sha256Hex(message.code);
          if (state !== "fresh") fail("protocol_closed");
          if (actual !== message.code_digest) closeWith("digest_mismatch");
          code = message.code;
          digest = actual;
          state = "ready";
          return {v: WORKER_PROTOCOL_VERSION, type: "ready", code_digest: digest};
        }
        if (message?.type === "close") {
          if (!exact(message, ["v", "type"]) || message.v !== WORKER_PROTOCOL_VERSION) {
            closeWith("invalid_close");
          }
          state = "closed";
          return {v: WORKER_PROTOCOL_VERSION, type: "closed", last_sequence: lastSequence};
        }
        if (!exact(message, ["v", "type", "sequence", "time_ms"])
            || message.v !== WORKER_PROTOCOL_VERSION || message.type !== "frame"
            || !Number.isSafeInteger(message.sequence) || message.sequence !== lastSequence + 1
          || !Number.isInteger(message.time_ms) || Object.is(message.time_ms, -0)
            || message.time_ms < 0 || message.time_ms > MAX_FRAME_TIME_MS) {
          closeWith("invalid_frame");
        }
        // Consume before evaluation. A failure cannot make the same frame fresh.
        lastSequence = message.sequence;
        let output;
        try {
          output = await evaluate(code, message.time_ms);
        } catch {
          state = "closed";
          fail("evaluation_failed");
        }
        if (state !== "ready") fail("protocol_closed");
        if (typeof output !== "string"
            || encoder.encode(output).byteLength > MAX_VIEW_OUTPUT_BYTES) {
          closeWith("invalid_output");
        }
        try {
          viewDecoder(output);
        } catch {
          closeWith("invalid_output");
        }
        return {v: WORKER_PROTOCOL_VERSION, type: "view", sequence: lastSequence, output};
      } finally {
        busy = false;
      }
    },
  });
}

export function createHostProtocol(code, codeDigest, viewDecoder = decodeView) {
  if (typeof code !== "string" || !wellFormedString(code)
      || encoder.encode(code).byteLength > MAX_COMPILED_CODE_BYTES
      || !validDigest(codeDigest)) throw new WorkerProtocolError("invalid_init");
  let state = "fresh";
  let sentSequence = 0;
  let receivedSequence = 0;

  function closeWith(codeValue) {
    state = "closed";
    fail(codeValue);
  }

  return Object.freeze({
    init() {
      if (state !== "fresh") closeWith("invalid_state");
      state = "initializing";
      return {v: WORKER_PROTOCOL_VERSION, type: "init", code, code_digest: codeDigest};
    },
    frame(timeMs) {
      if (state !== "ready" || !Number.isInteger(timeMs) || Object.is(timeMs, -0)
          || timeMs < 0 || timeMs > MAX_FRAME_TIME_MS) closeWith("invalid_state");
      if (sentSequence === Number.MAX_SAFE_INTEGER) closeWith("sequence_exhausted");
      sentSequence += 1;
      return {v: WORKER_PROTOCOL_VERSION, type: "frame", sequence: sentSequence, time_ms: timeMs};
    },
    close() {
      if (state !== "ready" || sentSequence !== receivedSequence) closeWith("invalid_state");
      state = "closing";
      return {v: WORKER_PROTOCOL_VERSION, type: "close"};
    },
    accept(message) {
      if (state === "closed") fail("protocol_closed");
      if (exact(message, ["v", "type", "code"])
          && message.v === WORKER_PROTOCOL_VERSION && message.type === "error"
          && errorCodes.has(message.code)) {
        state = "closed";
        fail(`worker_${message.code}`);
      }
      if (state === "initializing") {
        if (!exact(message, ["v", "type", "code_digest"])
            || message.v !== WORKER_PROTOCOL_VERSION || message.type !== "ready"
            || message.code_digest !== codeDigest) closeWith("invalid_ready");
        state = "ready";
        return {type: "ready"};
      }
      if (state === "closing") {
        if (!exact(message, ["v", "type", "last_sequence"])
            || message.v !== WORKER_PROTOCOL_VERSION || message.type !== "closed"
            || message.last_sequence !== receivedSequence
            || message.last_sequence !== sentSequence) closeWith("invalid_closed");
        state = "closed";
        return {type: "closed", lastSequence: receivedSequence};
      }
      if (state !== "ready"
          || !exact(message, ["v", "type", "sequence", "output"])
          || message.v !== WORKER_PROTOCOL_VERSION || message.type !== "view"
          || !Number.isSafeInteger(message.sequence)
          || message.sequence !== receivedSequence + 1
          || message.sequence > sentSequence || typeof message.output !== "string") {
        closeWith("invalid_view_frame");
      }
      let view;
      try {
        view = viewDecoder(message.output);
      } catch {
        closeWith("invalid_view_output");
      }
      receivedSequence = message.sequence;
      return {type: "view", sequence: receivedSequence, view};
    },
  });
}
