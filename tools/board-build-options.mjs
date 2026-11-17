// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The esbuild options of the whiteboard bundle, shared by tools/build-board.mjs and
// the test that checks the committed package inventory against a fresh build.
export function boardBuildOptions(root, outdir) {
  return {
    absWorkingDir: root,
    entryPoints: ["static/board-src.mjs"],
    bundle: true,
    format: "esm",
    minify: true,
    sourcemap: false,
    target: ["es2022"],
    conditions: ["production"],
    define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
    // Excalidraw's public path: it appends "excalidraw-assets/<file>" itself.
    banner: { js: 'window.EXCALIDRAW_ASSET_PATH="/static/vendor/";' },
    outdir,
    entryNames: "board-[hash]",
    assetNames: "board-[hash]",
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file" },
    legalComments: "linked",
    metafile: true,
  };
}
