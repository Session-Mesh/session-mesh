// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The licenses a third-party file may carry to be shipped with Session Mesh
// (AGPL-3.0-or-later), with the reason for each, and a small SPDX expression check.
// Owner rule, 2026-11-13: a file whose license is not in this list, or cannot be
// established, is not shipped (static/vendor/THIRD_PARTY.md).
//
// Sources for "compatible": the FSF list of licenses
// (https://www.gnu.org/licenses/license-list.html), GPLv3-compatible section, and the
// license texts themselves. The vendored files are shipped next to the program and
// loaded by its pages; the permissive licenses below allow that whether the result
// is read as one combined work or as an aggregate.
export const ALLOWED_LICENSES = Object.freeze({
  "MIT": "Expat license; permissive, GPL-compatible per the FSF list.",
  "ISC": "permissive (ISC), GPL-compatible per the FSF list.",
  "BSD-2-Clause": "FreeBSD license; permissive, GPL-compatible per the FSF list.",
  "BSD-3-Clause": "Modified BSD license; permissive, GPL-compatible per the FSF list.",
  "Zlib": "zlib license; permissive, GPL-compatible per the FSF list.",
  "Unlicense": "public-domain dedication with a permissive fallback; GPL-compatible per the FSF list.",
  "Apache-2.0": "compatible with GPLv3 and AGPLv3 (not GPLv2) per the FSF list; NOTICE texts are kept.",
  "0BSD": "Zero-clause BSD; permissive public-domain-equivalent license (tslib), GPL-compatible per the FSF list.",
  "OFL-1.1": "fonts only: the OFL allows the fonts to be bundled and redistributed with any software; they are " +
    "shipped unmodified as separate font files the pages load, an aggregation with the program rather than a " +
    "combined work, and stay under the OFL with its text in LICENSES/.",
  "CC-BY-4.0": "permissive with attribution; compatible with GPLv3 per the FSF list (used for the codicon font, " +
    "shipped as a separate file); the attribution and the license reference are kept.",
});

// Licenses accepted only as an alternative, in an OR with an allowed license (which is the one Session Mesh
// uses): never alone and never in an AND. Listed for the record; the check below needs no entry for them,
// since an OR is acceptable as soon as one alternative is acceptable with the list above.
export const ALTERNATIVE_ONLY_LICENSES = Object.freeze({
  "MPL-2.0": "met only as \"Apache-2.0 OR MPL-2.0\" (DOMPurify); Session Mesh takes it under Apache-2.0.",
});

function tokenize(text) {
  return text.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
}

// Grammar: or := and ("OR" and)*; and := atom ("AND" atom)*; atom := id ["WITH" id] | "(" or ")".
export function parseExpression(text) {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const parseAtom = () => {
    const token = tokens[position++];
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position++] !== ")") throw new Error(`unbalanced parentheses in "${text}"`);
      return inner;
    }
    const operators = ["AND", "OR", "WITH", "(", ")"];
    if (!token || operators.includes(token)) throw new Error(`unexpected "${token ?? "end"}" in "${text}"`);
    if (peek() !== "WITH") return { id: token };
    // "<license> WITH <exception>" is one identifier: it is allowed only when listed as a whole.
    const exception = tokens[position + 1];
    if (!exception || operators.includes(exception)) throw new Error(`unexpected "${exception ?? "end"}" in "${text}"`);
    position += 2;
    return { id: `${token} WITH ${exception}` };
  };
  const parseList = (operator, parseItem) => {
    const items = [parseItem()];
    while (peek() === operator) { position += 1; items.push(parseItem()); }
    return items.length === 1 ? items[0] : { [operator]: items };
  };
  const parseAnd = () => parseList("AND", parseAtom);
  const parseOr = () => parseList("OR", parseAnd);
  const tree = parseOr();
  if (position !== tokens.length) throw new Error(`unexpected "${tokens[position]}" in "${text}"`);
  return tree;
}

// The identifiers that make the expression unacceptable: every disallowed one of an
// AND, and for an OR only when no alternative is acceptable.
export function disallowedLicenses(tree, allowed = ALLOWED_LICENSES) {
  if (tree.id) return Object.hasOwn(allowed, tree.id) ? [] : [tree.id];
  if (tree.AND) return tree.AND.flatMap((item) => disallowedLicenses(item, allowed));
  const options = tree.OR.map((item) => disallowedLicenses(item, allowed));
  return options.some((problems) => problems.length === 0) ? [] : options.flat();
}

// Problems of one `License:` value, as messages; none when it is acceptable.
export function licenseExpressionProblems(text) {
  let tree;
  try { tree = parseExpression(text); } catch (error) { return [error.message]; }
  return [...new Set(disallowedLicenses(tree))].map((id) => `license "${id}" is not in the allowed list (tools/third-party/licenses.mjs)`);
}
