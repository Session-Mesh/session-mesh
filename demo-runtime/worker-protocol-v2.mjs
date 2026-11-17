// static/demo-view-contract.ts
var VIEW_LIMITS = Object.freeze({
  maxTextBytes: 2e3,
  maxNodes: 100,
  maxDepth: 6,
  maxChildren: 30,
  maxOutputBytes: 64 * 1024
});
var encoder = new TextEncoder();
var decodeError = () => Error("invalid view encoding");
var MAX_JSON_MEMBERS = 512;
var MAX_JSON_NESTING = 2 * VIEW_LIMITS.maxDepth + 3;
function parseJsonStrict(source, profile) {
  if (profile && encoder.encode(source).byteLength > 2 * 1024 * 1024 + 8192) throw decodeError();
  const maxMembers = profile === "project" ? 1048576 : MAX_JSON_MEMBERS;
  const maxDepth = profile === "project" ? 64 : MAX_JSON_NESTING;
  let at = 0;
  let members = 0;
  const whitespace = () => {
    while (at < source.length && /[\t\n\r ]/.test(source[at])) at += 1;
  };
  const character = (expected) => {
    if (source[at] !== expected) throw decodeError();
    at += 1;
  };
  const string = () => {
    character('"');
    let result = "";
    while (at < source.length) {
      const current = source[at++];
      if (current === '"') return result;
      if (current === "\\") {
        if (at >= source.length) throw decodeError();
        const escaped = source[at++];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "	" };
        if (Object.hasOwn(simple, escaped)) result += simple[escaped];
        else if (escaped === "u") {
          const digits = source.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw decodeError();
          const unit = Number.parseInt(digits, 16);
          at += 4;
          if (unit >= 55296 && unit <= 56319) {
            if (source.slice(at, at + 2) !== "\\u") throw decodeError();
            const lowDigits = source.slice(at + 2, at + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowDigits)) throw decodeError();
            const low = Number.parseInt(lowDigits, 16);
            if (low < 56320 || low > 57343) throw decodeError();
            result += String.fromCodePoint(65536 + (unit - 55296) * 1024 + low - 56320);
            at += 6;
          } else {
            if (unit >= 56320 && unit <= 57343) throw decodeError();
            result += String.fromCharCode(unit);
          }
        } else throw decodeError();
      } else {
        if (current < " ") throw decodeError();
        if (current >= "\uD800" && current <= "\uDBFF") {
          const low = source[at];
          if (low === void 0 || low < "\uDC00" || low > "\uDFFF") throw decodeError();
          result += current + low;
          at += 1;
        } else {
          if (current >= "\uDC00" && current <= "\uDFFF") throw decodeError();
          result += current;
        }
      }
    }
    throw decodeError();
  };
  const value = (depth) => {
    if (depth > maxDepth) throw decodeError();
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === "{") {
      character("{");
      whitespace();
      const result = /* @__PURE__ */ Object.create(null);
      const keys = /* @__PURE__ */ new Set();
      if (source[at] === "}") {
        at += 1;
        return result;
      }
      for (; ; ) {
        whitespace();
        if (source[at] !== '"') throw decodeError();
        const key = string();
        if (keys.has(key)) throw decodeError();
        keys.add(key);
        whitespace();
        character(":");
        result[key] = value(depth + 1);
        members += 1;
        if (members > maxMembers) throw decodeError();
        whitespace();
        if (source[at] === "}") {
          at += 1;
          return result;
        }
        character(",");
      }
    }
    if (source[at] === "[") {
      character("[");
      whitespace();
      const result = [];
      if (source[at] === "]") {
        at += 1;
        return result;
      }
      for (; ; ) {
        result.push(value(depth + 1));
        members += 1;
        if (members > maxMembers) throw decodeError();
        whitespace();
        if (source[at] === "]") {
          at += 1;
          return result;
        }
        character(",");
      }
    }
    if (source.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (source.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (source.startsWith("null", at)) {
      at += 4;
      return null;
    }
    const match = source.slice(at).match(profile === "project" ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/ : /^-?(?:0|[1-9]\d*)/);
    if (!match) throw decodeError();
    at += match[0].length;
    const parsed2 = Number(match[0]);
    if (profile === "project" ? !Number.isFinite(parsed2) : !Number.isSafeInteger(parsed2) || Object.is(parsed2, -0)) throw decodeError();
    return parsed2;
  };
  whitespace();
  const parsed = value(0);
  whitespace();
  if (at !== source.length) throw decodeError();
  return parsed;
}

// static/demo-input-contract.ts
var INPUT_LIMITS = Object.freeze({
  maxSchemaBytes: 8 * 1024,
  maxSnapshotBytes: 4 * 1024,
  maxControls: 16,
  maxOptions: 64,
  maxLabelBytes: 128,
  minNumber: -1e6,
  maxNumber: 1e6
});
var encoder2 = new TextEncoder();
var idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
var exact = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
var safeBound = (value) => Number.isSafeInteger(value) && !Object.is(value, -0) && Number(value) >= INPUT_LIMITS.minNumber && Number(value) <= INPUT_LIMITS.maxNumber;
var printable = (value) => {
  if (typeof value !== "string" || value.length === 0 || encoder2.encode(value).byteLength > INPUT_LIMITS.maxLabelBytes || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 56320 && low <= 57343)) return false;
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) return false;
  }
  return true;
};
var size = (value) => encoder2.encode(JSON.stringify(value)).byteLength;
function readInputSchemaUnchecked(value) {
  if (!exact(value, ["format", "controls"]) || value.format !== "mesh-input-schema-v1" || !Array.isArray(value.controls) || value.controls.length < 1 || value.controls.length > INPUT_LIMITS.maxControls || size(value) > INPUT_LIMITS.maxSchemaBytes) return null;
  const ids = /* @__PURE__ */ new Set();
  let options = 0;
  for (const raw of value.controls) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const control = raw;
    if (typeof control.id !== "string" || !idPattern.test(control.id) || ids.has(control.id) || !printable(control.label)) return null;
    ids.add(control.id);
    if (control.type === "range") {
      if (!exact(control, ["type", "id", "label", "min", "max", "step", "initial"]) || !safeBound(control.min) || !safeBound(control.max) || !safeBound(control.step) || control.step <= 0 || control.min > control.max || !safeBound(control.initial) || control.initial < control.min || control.initial > control.max || (control.initial - control.min) % control.step !== 0 || (control.max - control.min) % control.step !== 0) return null;
    } else if (control.type === "toggle") {
      if (!exact(control, ["type", "id", "label", "initial"]) || typeof control.initial !== "boolean") return null;
    } else if (control.type === "choice") {
      if (!exact(control, ["type", "id", "label", "options", "initial"]) || !Array.isArray(control.options) || control.options.length < 2 || control.options.length > 16 || !control.options.every(printable) || new Set(control.options).size !== control.options.length || typeof control.initial !== "string" || !control.options.includes(control.initial)) return null;
      options += control.options.length;
      if (options > INPUT_LIMITS.maxOptions) return null;
    } else if (control.type === "action") {
      if (!exact(control, ["type", "id", "label", "initial"]) || control.initial !== 0) return null;
    } else return null;
  }
  return value;
}
function readInputSchema(value) {
  try {
    return readInputSchemaUnchecked(value);
  } catch {
    return null;
  }
}
function decodeInputSchema(source) {
  if (typeof source !== "string" || encoder2.encode(source).byteLength > INPUT_LIMITS.maxSchemaBytes) throw Error("invalid_input_schema");
  let parsed;
  try {
    parsed = parseJsonStrict(source);
  } catch {
    throw Error("invalid_input_schema");
  }
  const schema = readInputSchema(parsed);
  if (!schema) throw Error("invalid_input_schema");
  const controls = schema.controls.map((control) => control.type === "range" ? { type: control.type, id: control.id, label: control.label, min: control.min, max: control.max, step: control.step, initial: control.initial } : control.type === "choice" ? { type: control.type, id: control.id, label: control.label, options: control.options, initial: control.initial } : { type: control.type, id: control.id, label: control.label, initial: control.initial });
  if (JSON.stringify({ format: schema.format, controls }) !== source) throw Error("invalid_input_schema");
  return schema;
}
function readInputSnapshotUnchecked(value, schema) {
  const checked = readInputSchema(schema);
  if (!checked || !exact(value, ["format", "generation", "values"]) || value.format !== "mesh-input-snapshot-v1" || !Number.isSafeInteger(value.generation) || Object.is(value.generation, -0) || Number(value.generation) < 0 || !Array.isArray(value.values) || value.values.length !== checked.controls.length || size(value) > INPUT_LIMITS.maxSnapshotBytes) return null;
  for (let index = 0; index < checked.controls.length; index += 1) {
    const control = checked.controls[index];
    const entry = value.values[index];
    if (!exact(entry, ["id", "value"]) || entry.id !== control.id) return null;
    const actual = entry.value;
    if (control.type === "range" && (!safeBound(actual) || actual < control.min || actual > control.max || (actual - control.min) % control.step !== 0)) return null;
    if (control.type === "toggle" && typeof actual !== "boolean") return null;
    if (control.type === "choice" && (typeof actual !== "string" || !control.options.includes(actual))) return null;
    if (control.type === "action" && (!Number.isSafeInteger(actual) || Object.is(actual, -0) || Number(actual) < 0)) return null;
  }
  return value;
}
function readInputSnapshot(value, schema) {
  try {
    return readInputSnapshotUnchecked(value, schema);
  } catch {
    return null;
  }
}
function deepFreezeSnapshot(snapshot) {
  for (const entry of snapshot.values) Object.freeze(entry);
  Object.freeze(snapshot.values);
  return Object.freeze(snapshot);
}

// static/demo-worker-protocol-v2.ts
var WORKER_PROTOCOL_VERSION = 2;
var MAX_COMPILED_CODE_BYTES = 128 * 1024;
var MAX_FRAME_TIME_MS = 6e4;
var encoder3 = new TextEncoder();
var digest = /^[0-9a-f]{64}$/;
var exact2 = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
var fail = (code) => {
  throw new WorkerProtocolError(code);
};
var sha256 = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder3.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
var wellFormed = (value) => {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 55296 && unit <= 56319) {
      const low = value.charCodeAt(i + 1);
      if (!(low >= 56320 && low <= 57343)) return false;
      i += 1;
    } else if (unit >= 56320 && unit <= 57343) return false;
  }
  return true;
};
var WorkerProtocolError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "WorkerProtocolError";
    this.code = code;
  }
};
function createWorkerProtocolV2(evaluate, decodeView) {
  let state = "fresh", code = "", codeDigest = "", schemaDigest = "", schema = null, lastSequence = 0, lastGeneration = 0, busy = false;
  const close = (reason) => {
    state = "closed";
    return fail(reason);
  };
  return Object.freeze({ async handle(message) {
    if (busy) close("concurrent_message");
    if (state === "closed") fail("protocol_closed");
    busy = true;
    try {
      if (state === "fresh") {
        if (!exact2(message, ["v", "type", "code", "code_digest", "schema", "schema_digest"]) || message.v !== 2 || message.type !== "init" || typeof message.code !== "string" || !wellFormed(message.code) || encoder3.encode(message.code).byteLength > MAX_COMPILED_CODE_BYTES || !digest.test(String(message.code_digest)) || typeof message.schema !== "string" || !digest.test(String(message.schema_digest))) close("invalid_init");
        const msg2 = message;
        let acceptedSchema = null;
        try {
          acceptedSchema = decodeInputSchema(msg2.schema);
        } catch {
          close("invalid_init");
        }
        if (!acceptedSchema) close("invalid_init");
        const [actualCode, actualSchema] = await Promise.all([sha256(msg2.code), sha256(msg2.schema)]);
        if (state !== "fresh") fail("protocol_closed");
        if (actualCode !== msg2.code_digest || actualSchema !== msg2.schema_digest) close("digest_mismatch");
        code = msg2.code;
        codeDigest = actualCode;
        schemaDigest = actualSchema;
        schema = acceptedSchema;
        state = "ready";
        return { v: 2, type: "ready", code_digest: codeDigest, schema_digest: schemaDigest };
      }
      if (!exact2(message, ["v", "type", "sequence", "time_ms", "snapshot", "input_generation"]) || message.v !== 2 || message.type !== "frame" || !Number.isSafeInteger(message.sequence) || message.sequence !== lastSequence + 1 || !Number.isSafeInteger(message.time_ms) || Object.is(message.time_ms, -0) || Number(message.time_ms) < 0 || Number(message.time_ms) > MAX_FRAME_TIME_MS || !Number.isSafeInteger(message.input_generation) || Number(message.input_generation) < lastGeneration || !schema) close("invalid_frame");
      const msg = message;
      const activeSchema = schema;
      if (!activeSchema) close("invalid_frame");
      const candidate = readInputSnapshot(msg.snapshot, activeSchema);
      if (!candidate || candidate.generation !== msg.input_generation) close("invalid_snapshot");
      const snapshot = candidate;
      lastSequence = msg.sequence;
      lastGeneration = msg.input_generation;
      let output = "";
      try {
        output = await evaluate(code, msg.time_ms, deepFreezeSnapshot(snapshot));
      } catch {
        close("evaluation_failed");
      }
      if (state !== "ready") fail("protocol_closed");
      if (typeof output !== "string") close("invalid_output");
      try {
        decodeView(output);
      } catch {
        close("invalid_output");
      }
      return { v: 2, type: "view", sequence: lastSequence, input_generation: lastGeneration, output };
    } finally {
      busy = false;
    }
  } });
}
function createHostProtocolV2(code, codeDigest, schemaSource, schemaDigest, decodeView) {
  let acceptedSchema = null;
  try {
    acceptedSchema = decodeInputSchema(schemaSource);
  } catch {
    fail("invalid_init");
  }
  if (!acceptedSchema || typeof code !== "string" || !wellFormed(code) || !digest.test(codeDigest) || !digest.test(schemaDigest) || encoder3.encode(code).byteLength > MAX_COMPILED_CODE_BYTES) fail("invalid_init");
  const schema = acceptedSchema;
  let state = "fresh", sent = 0, received = 0, outstanding = null, lastGeneration = 0;
  const close = (reason) => {
    state = "closed";
    return fail(reason);
  };
  return Object.freeze({
    init() {
      if (state !== "fresh") close("invalid_state");
      state = "initializing";
      return { v: 2, type: "init", code, code_digest: codeDigest, schema: schemaSource, schema_digest: schemaDigest };
    },
    frame(timeMs, snapshot) {
      if (state !== "ready" || outstanding !== null) close("concurrent_frame");
      const candidate = readInputSnapshot(snapshot, schema);
      if (!candidate || candidate.generation < lastGeneration || !Number.isSafeInteger(timeMs) || Object.is(timeMs, -0) || timeMs < 0 || timeMs > MAX_FRAME_TIME_MS) close("invalid_frame");
      const valid = candidate;
      if (sent === Number.MAX_SAFE_INTEGER) close("sequence_exhausted");
      sent += 1;
      outstanding = sent;
      lastGeneration = valid.generation;
      return { v: 2, type: "frame", sequence: sent, time_ms: timeMs, snapshot: valid, input_generation: valid.generation };
    },
    accept(message) {
      if (state === "closed") fail("protocol_closed");
      if (state === "initializing") {
        if (!exact2(message, ["v", "type", "code_digest", "schema_digest"]) || message.v !== 2 || message.type !== "ready" || message.code_digest !== codeDigest || message.schema_digest !== schemaDigest) close("invalid_ready");
        state = "ready";
        return { type: "ready" };
      }
      if (state !== "ready" || outstanding === null || !exact2(message, ["v", "type", "sequence", "input_generation", "output"]) || message.v !== 2 || message.type !== "view" || message.sequence !== outstanding || message.sequence !== received + 1 || message.input_generation !== lastGeneration || typeof message.output !== "string") close("invalid_view");
      const msg = message;
      let view;
      try {
        view = decodeView(msg.output);
      } catch {
        close("invalid_output");
      }
      received = msg.sequence;
      outstanding = null;
      return { type: "view", sequence: received, inputGeneration: lastGeneration, view };
    },
    timeout(sequence) {
      if (state !== "ready" || outstanding !== sequence) close("invalid_timeout");
      close("worker_timeout");
    },
    crash() {
      if (state === "closed") fail("protocol_closed");
      close("worker_crash");
    },
    get busy() {
      return outstanding !== null;
    }
  });
}
export {
  MAX_COMPILED_CODE_BYTES,
  MAX_FRAME_TIME_MS,
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  createHostProtocolV2,
  createWorkerProtocolV2
};
