// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export const VIEW_LIMITS = Object.freeze({
  maxTextBytes: 2000,
  maxNodes: 100,
  maxDepth: 6,
  maxChildren: 30,
  maxOutputBytes: 64 * 1024,
});

type TextNode = { type: "heading" | "text" | "badge" | "shape"; text: string };
type DividerNode = { type: "divider" };
type GearNode = { type: "gear"; angle: number };
type GroupNodeV1 = { type: "card" | "row" | "column"; children: ViewNodeV1[] };
type GroupNodeV2 = { type: "card" | "row" | "column"; children: ViewNodeV2[] };
export type ViewNodeV1 = TextNode | DividerNode | GroupNodeV1;
export type ViewNodeV2 = TextNode | DividerNode | GearNode | GroupNodeV2;
export type ViewV1 = { format: "mesh-view-v1"; nodes: ViewNodeV1[] };
export type ViewV2 = { format: "mesh-view-v2"; nodes: ViewNodeV2[] };
export type MeshView = ViewV1 | ViewV2;
export type ViewNodeCounter = { value: number };

const encoder = new TextEncoder();
const textKinds = new Set(["heading", "text", "badge", "shape"]);
const groupKinds = new Set(["card", "row", "column"]);

export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function scalarText(value: unknown, maxBytes: number = VIEW_LIMITS.maxTextBytes): value is string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > maxBytes
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
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

export function legacySceneText(value: unknown, maxCharacters: number = VIEW_LIMITS.maxTextBytes): value is string {
  return typeof value === "string" && Array.from(value).length <= maxCharacters
    && !Array.from(value).some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t");
}

function validNode(value: unknown, version: 1 | 2, depth: number, count: ViewNodeCounter): boolean {
  count.value += 1;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || count.value > VIEW_LIMITS.maxNodes || depth > VIEW_LIMITS.maxDepth) return false;
  const node = value as Record<string, unknown>;
  if (textKinds.has(String(node.type))) {
    return exact(node, ["type", "text"])
      && (version === 1 ? legacySceneText(node.text) : scalarText(node.text));
  }
  if (node.type === "divider") return exact(node, ["type"]);
  if (node.type === "gear") {
    return version === 2 && exact(node, ["type", "angle"])
      && Number.isSafeInteger(node.angle) && !Object.is(node.angle, -0)
      && Number(node.angle) >= 0 && Number(node.angle) <= 359;
  }
  if (!groupKinds.has(String(node.type)) || !exact(node, ["type", "children"])
      || !Array.isArray(node.children) || node.children.length > VIEW_LIMITS.maxChildren) return false;
  return node.children.every((child) => validNode(child, version, depth + 1, count));
}

export function readViewWithinBudget(value: unknown,
  expected: "mesh-view-v1" | "mesh-view-v2", count: ViewNodeCounter): MeshView | null {
  if (!exact(value, ["format", "nodes"]) || !Array.isArray(value.nodes)
      || value.nodes.length > VIEW_LIMITS.maxChildren
      || (value.format !== "mesh-view-v1" && value.format !== "mesh-view-v2")
      || value.format !== expected) return null;
  const version = value.format === "mesh-view-v1" ? 1 : 2;
  if (!value.nodes.every((node) => validNode(node, version, 0, count))) return null;
  return value as unknown as MeshView;
}

export function readView(value: unknown, expected?: "mesh-view-v1" | "mesh-view-v2"): MeshView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const format = (value as Record<string, unknown>).format;
  if (format !== "mesh-view-v1" && format !== "mesh-view-v2") return null;
  if (expected !== undefined && format !== expected) return null;
  return readViewWithinBudget(value, format, {value: 0});
}

const decodeError = (): Error => Error("invalid view encoding");
const MAX_JSON_MEMBERS = 512;
const MAX_JSON_NESTING = (2 * VIEW_LIMITS.maxDepth) + 3;

// Dependency-free strict JSON parser: duplicate keys, malformed scalar Unicode,
// non-canonical numbers, excessive members and nesting are rejected before the
// closed view schema is considered.
export function parseJsonStrict(source: string, profile?: "project"): unknown {
  if (profile && encoder.encode(source).byteLength > 2 * 1024 * 1024 + 8192) throw decodeError();
  const maxMembers = profile === "project" ? 1048576 : MAX_JSON_MEMBERS;
  const maxDepth = profile === "project" ? 64 : MAX_JSON_NESTING;
  let at = 0;
  let members = 0;
  const whitespace = (): void => { while (at < source.length && /[\t\n\r ]/.test(source[at]!)) at += 1; };
  const character = (expected: string): void => { if (source[at] !== expected) throw decodeError(); at += 1; };
  const string = (): string => {
    character('"');
    let result = "";
    while (at < source.length) {
      const current = source[at++]!;
      if (current === '"') return result;
      if (current === "\\") {
        if (at >= source.length) throw decodeError();
        const escaped = source[at++]!;
        const simple: Record<string, string> = {'"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t"};
        if (Object.hasOwn(simple, escaped)) result += simple[escaped];
        else if (escaped === "u") {
          const digits = source.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw decodeError();
          const unit = Number.parseInt(digits, 16); at += 4;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (source.slice(at, at + 2) !== "\\u") throw decodeError();
            const lowDigits = source.slice(at + 2, at + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowDigits)) throw decodeError();
            const low = Number.parseInt(lowDigits, 16);
            if (low < 0xdc00 || low > 0xdfff) throw decodeError();
            result += String.fromCodePoint(0x10000 + ((unit - 0xd800) * 0x400) + low - 0xdc00); at += 6;
          } else {
            if (unit >= 0xdc00 && unit <= 0xdfff) throw decodeError();
            result += String.fromCharCode(unit);
          }
        } else throw decodeError();
      } else {
        if (current < " ") throw decodeError();
        if (current >= "\ud800" && current <= "\udbff") {
          const low = source[at]; if (low === undefined || low < "\udc00" || low > "\udfff") throw decodeError();
          result += current + low; at += 1;
        } else { if (current >= "\udc00" && current <= "\udfff") throw decodeError(); result += current; }
      }
    }
    throw decodeError();
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) throw decodeError();
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === "{") {
      character("{"); whitespace(); const result: Record<string, unknown> = Object.create(null); const keys = new Set<string>();
      if (source[at] === "}") { at += 1; return result; }
      for (;;) {
        whitespace(); if (source[at] !== '"') throw decodeError(); const key = string();
        if (keys.has(key)) throw decodeError(); keys.add(key); whitespace(); character(":"); result[key] = value(depth + 1);
        members += 1; if (members > maxMembers) throw decodeError(); whitespace();
        if (source[at] === "}") { at += 1; return result; } character(",");
      }
    }
    if (source[at] === "[") {
      character("["); whitespace(); const result: unknown[] = [];
      if (source[at] === "]") { at += 1; return result; }
      for (;;) {
        result.push(value(depth + 1)); members += 1; if (members > maxMembers) throw decodeError(); whitespace();
        if (source[at] === "]") { at += 1; return result; } character(",");
      }
    }
    if (source.startsWith("true", at)) { at += 4; return true; }
    if (source.startsWith("false", at)) { at += 5; return false; }
    if (source.startsWith("null", at)) { at += 4; return null; }
    const match = source.slice(at).match(profile === "project" ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/ : /^-?(?:0|[1-9]\d*)/);
    if (!match) throw decodeError(); at += match[0].length; const parsed = Number(match[0]);
    if (profile === "project" ? !Number.isFinite(parsed) : !Number.isSafeInteger(parsed) || Object.is(parsed, -0)) throw decodeError(); return parsed;
  };
  whitespace(); const parsed = value(0); whitespace(); if (at !== source.length) throw decodeError(); return parsed;
}

export function decodeView(source: string, expected: "mesh-view-v1" | "mesh-view-v2"): MeshView {
  if (typeof source !== "string" || encoder.encode(source).byteLength > VIEW_LIMITS.maxOutputBytes) throw decodeError();
  const view = readView(parseJsonStrict(source), expected);
  if (!view) throw Error("invalid view schema");
  return view;
}

function makeNode(doc: Document, node: ViewNodeV1 | ViewNodeV2): HTMLElement {
  if (node.type === "divider") return doc.createElement("hr");
  if (node.type === "card" || node.type === "row" || node.type === "column") {
    const box = doc.createElement("div"); box.className = node.type;
    box.append(...node.children.map((child) => makeNode(doc, child))); return box;
  }
  if (node.type === "gear") {
    const gear = doc.createElement("span"); gear.className = "gear"; gear.textContent = "⚙";
    gear.style.setProperty("--mesh-gear-angle", `${node.angle}deg`); return gear;
  }
  const tag = node.type === "heading" ? "h2" : node.type === "text" ? "p" : "div";
  const result = doc.createElement(tag);
  if (node.type !== "heading" && node.type !== "text") result.className = node.type;
  result.textContent = (node as TextNode).text; return result;
}

export function renderView(root: HTMLElement, view: MeshView): void {
  const checked = readView(view, view.format);
  if (!checked) throw Error("invalid view schema");
  root.replaceChildren(...checked.nodes.map((node) => makeNode(root.ownerDocument, node)));
}
