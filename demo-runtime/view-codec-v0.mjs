// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export const VIEW_V0_LIMITS = Object.freeze({
  maxTextBytes: 2000,
  maxNodes: 100,
  maxDepth: 6,
  maxChildren: 30,
});
export const MAX_VIEW_OUTPUT_BYTES = 64 * 1024;
const leaf = new Map([["heading", "h2"], ["text", "p"], ["badge", "span"],
  ["shape", "div"]]);
const group = new Set(["card", "row", "column"]);

// Guest output is a string, not a JavaScript object. JSON.parse would accept
// repeated object keys by silently retaining the last one, which makes a
// supposedly closed view schema ambiguous. This dependency-free decoder is the
// single laboratory codec shared by the demo and E2EE benches. It accepts JSON
// values, rejects duplicate keys while parsing, and leaves the actual view
// vocabulary to validateView. It is not a general-purpose JSON library.
export const MAX_JSON_MEMBERS = 512;
// JSON has both object and array layers. A valid view of schema depth N can
// alternate between them on its way to a leaf, so this is intentionally not
// the same bound as VIEW_V0_LIMITS.maxDepth. The schema validator below stays
// authoritative for view depth.
export const MAX_JSON_NESTING = (2 * VIEW_V0_LIMITS.maxDepth) + 1;

function decodeError() {
  return Error("invalid view encoding");
}

function parseJsonStrict(source) {
  let at = 0;
  let members = 0;

  function whitespace() {
    while (at < source.length && /[\t\n\r ]/.test(source[at])) at += 1;
  }

  function character(expected) {
    if (source[at] !== expected) throw decodeError();
    at += 1;
  }

  function string() {
    character('"');
    let value = "";
    while (at < source.length) {
      const current = source[at++];
      if (current === '"') return value;
      if (current === "\\") {
        if (at >= source.length) throw decodeError();
        const escaped = source[at++];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (Object.hasOwn(simple, escaped)) {
          value += simple[escaped];
        } else if (escaped === "u") {
          const digits = source.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw decodeError();
          const unit = Number.parseInt(digits, 16);
          at += 4;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (source.slice(at, at + 2) !== "\\u") throw decodeError();
            const lowDigits = source.slice(at + 2, at + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowDigits)) throw decodeError();
            const low = Number.parseInt(lowDigits, 16);
            if (low < 0xdc00 || low > 0xdfff) throw decodeError();
            value += String.fromCodePoint(0x10000 + ((unit - 0xd800) * 0x400) + (low - 0xdc00));
            at += 6;
          } else {
            if (unit >= 0xdc00 && unit <= 0xdfff) throw decodeError();
            value += String.fromCharCode(unit);
          }
        } else {
          throw decodeError();
        }
      } else {
        if (current < " ") throw decodeError();
        if (current >= "\ud800" && current <= "\udbff") {
          const low = source[at];
          if (low < "\udc00" || low > "\udfff") throw decodeError();
          value += current + low;
          at += 1;
        } else {
          if (current >= "\udc00" && current <= "\udfff") throw decodeError();
          value += current;
        }
      }
    }
    throw decodeError();
  }

  function countMember() {
    members += 1;
    if (members > MAX_JSON_MEMBERS) throw decodeError();
  }

  function value(depth) {
    if (depth > MAX_JSON_NESTING) throw decodeError();
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === "{") return object(depth + 1);
    if (source[at] === "[") return array(depth + 1);
    if (source.startsWith("true", at)) { at += 4; return true; }
    if (source.startsWith("false", at)) { at += 5; return false; }
    if (source.startsWith("null", at)) { at += 4; return null; }
    const number = source.slice(at).match(/^-?(?:0|[1-9]\d*)/);
    if (!number) throw decodeError();
    at += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) throw decodeError();
    return parsed;
  }

  function object(depth) {
    character("{");
    whitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (source[at] === "}") { at += 1; return result; }
    for (;;) {
      whitespace();
      if (source[at] !== '"') throw decodeError();
      const key = string();
      if (keys.has(key)) throw decodeError();
      keys.add(key);
      whitespace();
      character(":");
      const parsed = value(depth);
      countMember();
      result[key] = parsed;
      whitespace();
      if (source[at] === "}") { at += 1; return result; }
      character(",");
    }
  }

  function array(depth) {
    character("[");
    whitespace();
    const result = [];
    if (source[at] === "]") { at += 1; return result; }
    for (;;) {
      result.push(value(depth));
      countMember();
      whitespace();
      if (source[at] === "]") { at += 1; return result; }
      character(",");
    }
  }

  whitespace();
  const parsed = value(0);
  whitespace();
  if (at !== source.length) throw decodeError();
  return parsed;
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function validScalarText(value) {
  if (typeof value !== "string"
      || new TextEncoder().encode(value).byteLength > VIEW_V0_LIMITS.maxTextBytes
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    return false;
  }
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

export function validateView(view) {
  let count = 0;
  function check(node, depth) {
    count++;
    if (count > VIEW_V0_LIMITS.maxNodes || depth > VIEW_V0_LIMITS.maxDepth) {
      throw Error("view bounds exceeded");
    }
    if (node?.type === "gear") {
      if (!exact(node, ["type", "angle"]) || !Number.isInteger(node.angle)
          || Object.is(node.angle, -0) || node.angle < 0 || node.angle >= 360) {
        throw Error("invalid gear node");
      }
      return;
    }
    if (leaf.has(node?.type)) {
      if (!exact(node, ["type", "text"]) || !validScalarText(node.text)) {
        throw Error("invalid text node");
      }
      return;
    }
    if (!group.has(node?.type) || !exact(node, ["type", "children"])
        || !Array.isArray(node.children)
        || node.children.length > VIEW_V0_LIMITS.maxChildren) {
      throw Error("invalid view node");
    }
    for (const child of node.children) check(child, depth + 1);
  }
  check(view, 0);
  return view;
}

export function decodeView(source) {
  if (typeof source !== "string"
      || new TextEncoder().encode(source).byteLength > MAX_VIEW_OUTPUT_BYTES) {
    throw decodeError();
  }
  return validateView(parseJsonStrict(source));
}

export function decodeViewBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_VIEW_OUTPUT_BYTES) {
    throw decodeError();
  }
  let source;
  try {
    source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    throw decodeError();
  }
  return decodeView(source);
}

// The host owns every DOM node. Guest strings are assigned only as textContent.
export function renderView(view, container) {
  validateView(view);
  function make(node) {
    const element = document.createElement(node.type === "gear" ? "span" : leaf.get(node.type) ?? "div");
    element.className = `mesh-${node.type}`;
    if (node.type === "gear") {
      element.textContent = "⚙";
      element.style.transform = `rotate(${node.angle}deg)`;
    } else if (leaf.has(node.type)) element.textContent = node.text;
    else for (const child of node.children) element.append(make(child));
    return element;
  }
  container.replaceChildren(make(view));
}
