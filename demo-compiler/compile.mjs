// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {build} from "esbuild";

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_BUNDLE_BYTES = 128 * 1024;

// Guest helpers are ordinary guest JavaScript, never host functions.
const prelude = `
const h = (type, props, ...children) => {
  const attributes = props ?? {};
  return children.length ? {type, ...attributes, children} : {type, ...attributes};
};
`;
const resultExpression = "\n;JSON.stringify(typeof globalThis.__mesh_result === 'function' ? globalThis.__mesh_result(globalThis.__mesh_time_ms ?? 0) : globalThis.__mesh_result);";

export async function compileDemoSource(source) {
  if (typeof source !== "string" || new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    throw Error("TSX source too large or invalid");
  }
  const result = await build({
    stdin: {contents: `${prelude}\n${source}\n`,
      sourcefile: "demo.tsx", loader: "tsx"},
    bundle: true,
    write: false,
    platform: "neutral",
    format: "iife",
    jsxFactory: "h",
    logLevel: "silent",
    plugins: [{name: "no-imports", setup(builder) {
      builder.onResolve({filter: /.*/}, ({path}) => ({errors: [{text: `import forbidden: ${path}`}]}));
    }}],
  });
  const bytes = result.outputFiles[0].contents;
  if (bytes.length + resultExpression.length > MAX_BUNDLE_BYTES) {
    throw Error("compiled TSX too large");
  }
  return new TextDecoder("utf-8", {fatal: true}).decode(bytes) + resultExpression;
}
