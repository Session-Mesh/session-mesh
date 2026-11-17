// static/demo-view-contract.ts
var VIEW_LIMITS = Object.freeze({
  maxTextBytes: 2e3,
  maxNodes: 100,
  maxDepth: 6,
  maxChildren: 30,
  maxOutputBytes: 64 * 1024
});
var encoder = new TextEncoder();
var textKinds = /* @__PURE__ */ new Set(["heading", "text", "badge", "shape"]);
var groupKinds = /* @__PURE__ */ new Set(["card", "row", "column"]);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function scalarText(value, maxBytes = VIEW_LIMITS.maxTextBytes) {
  if (typeof value !== "string" || encoder.encode(value).byteLength > maxBytes || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 56320 && low <= 57343)) return false;
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) return false;
  }
  return true;
}
function legacySceneText(value, maxCharacters = VIEW_LIMITS.maxTextBytes) {
  return typeof value === "string" && Array.from(value).length <= maxCharacters && !Array.from(value).some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "	");
}
function validNode(value, version, depth, count) {
  count.value += 1;
  if (!value || typeof value !== "object" || Array.isArray(value) || count.value > VIEW_LIMITS.maxNodes || depth > VIEW_LIMITS.maxDepth) return false;
  const node = value;
  if (textKinds.has(String(node.type))) {
    return exact(node, ["type", "text"]) && (version === 1 ? legacySceneText(node.text) : scalarText(node.text));
  }
  if (node.type === "divider") return exact(node, ["type"]);
  if (node.type === "gear") {
    return version === 2 && exact(node, ["type", "angle"]) && Number.isSafeInteger(node.angle) && !Object.is(node.angle, -0) && Number(node.angle) >= 0 && Number(node.angle) <= 359;
  }
  if (!groupKinds.has(String(node.type)) || !exact(node, ["type", "children"]) || !Array.isArray(node.children) || node.children.length > VIEW_LIMITS.maxChildren) return false;
  return node.children.every((child) => validNode(child, version, depth + 1, count));
}
function readViewWithinBudget(value, expected, count) {
  if (!exact(value, ["format", "nodes"]) || !Array.isArray(value.nodes) || value.nodes.length > VIEW_LIMITS.maxChildren || value.format !== "mesh-view-v1" && value.format !== "mesh-view-v2" || value.format !== expected) return null;
  const version = value.format === "mesh-view-v1" ? 1 : 2;
  if (!value.nodes.every((node) => validNode(node, version, 0, count))) return null;
  return value;
}
function readView(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const format = value.format;
  if (format !== "mesh-view-v1" && format !== "mesh-view-v2") return null;
  if (expected !== void 0 && format !== expected) return null;
  return readViewWithinBudget(value, format, { value: 0 });
}
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
function decodeView(source, expected) {
  if (typeof source !== "string" || encoder.encode(source).byteLength > VIEW_LIMITS.maxOutputBytes) throw decodeError();
  const view = readView(parseJsonStrict(source), expected);
  if (!view) throw Error("invalid view schema");
  return view;
}
function makeNode(doc, node) {
  if (node.type === "divider") return doc.createElement("hr");
  if (node.type === "card" || node.type === "row" || node.type === "column") {
    const box = doc.createElement("div");
    box.className = node.type;
    box.append(...node.children.map((child) => makeNode(doc, child)));
    return box;
  }
  if (node.type === "gear") {
    const gear = doc.createElement("span");
    gear.className = "gear";
    gear.textContent = "\u2699";
    gear.style.setProperty("--mesh-gear-angle", `${node.angle}deg`);
    return gear;
  }
  const tag = node.type === "heading" ? "h2" : node.type === "text" ? "p" : "div";
  const result = doc.createElement(tag);
  if (node.type !== "heading" && node.type !== "text") result.className = node.type;
  result.textContent = node.text;
  return result;
}
function renderView(root, view) {
  const checked = readView(view, view.format);
  if (!checked) throw Error("invalid view schema");
  root.replaceChildren(...checked.nodes.map((node) => makeNode(root.ownerDocument, node)));
}
export {
  VIEW_LIMITS,
  decodeView,
  exact,
  legacySceneText,
  parseJsonStrict,
  readView,
  readViewWithinBudget,
  renderView,
  scalarText
};
