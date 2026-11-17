// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boardBuildOptions } from "./board-build-options.mjs";
import { INVENTORY_NAME, formatInventory, packagesFromMetafile } from "./third-party/board-inventory.mjs";

const root = new URL("..", import.meta.url).pathname;
const vendor = join(root, "static", "vendor");
const staging = join(vendor, ".board-build");
const fontSource = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "excalidraw-assets");
const fontDestination = join(vendor, "excalidraw-assets");

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await rm(join(vendor, "excalidraw-assets"), { recursive: true, force: true });
await copyFreeAssets();

// Only the package assets whose license is compatible with the AGPL-3.0 are
// copied (static/vendor/THIRD_PARTY.md): the Assistant fonts (OFL-1.1) and the
// locales (MIT). Left out: Virgil.woff2 (freeware, non-free), Cascadia.woff2
// (a Microsoft license only based on the OFL) and vendor-*.js, the chunk Excalidraw
// loads on demand for "Mermaid to Excalidraw", image resizing and file dialogs
// (elkjs under the EPL-2.0, EMF under the EPL-1.0). The board maps the Virgil and
// Cascadia families to free fonts kept in static/vendor/fonts/ (board-fonts.mjs).
async function copyFreeAssets() {
  await mkdir(fontDestination, { recursive: true });
  for (const name of await readdir(fontSource)) {
    if (/^Assistant-[A-Za-z]+\.woff2$/.test(name)) await cp(join(fontSource, name), join(fontDestination, name));
  }
  await cp(join(fontSource, "locales"), join(fontDestination, "locales"), { recursive: true });
}

const result = await build(boardBuildOptions(root, staging));

const names = (await readdir(staging)).sort();
let main = names.find((name) => /^board-[A-Z0-9]+\.js$/i.test(name));
const css = names.find((name) => /^board-[A-Z0-9]+\.css$/i.test(name));
if (!main || !css) throw new Error("esbuild did not produce the board JavaScript and CSS assets");

// The upstream font loader always appends esm.sh as a fallback even when an
// explicit local asset path is supplied. Remove that fallback from our private
// bundle: every font is copied below and a board must never initiate a remote
// request merely because a local font is unavailable.
const mainPath = join(staging, main);
const original = await readFile(mainPath, "utf8");
const patched = original
  .replace(/return r\.push\(new URL\(t,[A-Za-z0-9_$]+\.ASSETS_FALLBACK_URL\)\),r/, "return r")
  .replace(/[ \t]+$/gm, "");
// 0.18 shipped this fallback and needs the patch; 0.17 uses the supplied
// asset path directly. Keep one builder for both audited package layouts.
await writeFile(mainPath, patched);
const hashedMain = `board-${createHash("sha256").update(patched).digest("hex").slice(0, 16)}.js`;
const legal = `${main}.LEGAL.txt`;
await rename(mainPath, join(staging, hashedMain));
if (names.includes(legal)) await rename(join(staging, legal), join(staging, `${hashedMain}.LEGAL.txt`));
names.splice(names.indexOf(main), 1, hashedMain);
if (names.includes(legal)) names.splice(names.indexOf(legal), 1, `${hashedMain}.LEGAL.txt`);
main = hashedMain;

for (const name of names) await rename(join(staging, name), join(vendor, name));
await rm(staging, { recursive: true, force: true });
for (const name of await readdir(vendor)) {
  if (/^board-[A-Z0-9]+(?:\.(?:js|css|woff2|woff|ttf|svg)|\.js\.LEGAL\.txt)$/i.test(name) && !names.includes(name)) {
    await rm(join(vendor, name));
  }
}

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) output.push(...await filesBelow(join(directory, entry.name), `${relative}/`));
    else if ((await stat(join(directory, entry.name))).isFile()) output.push(relative);
  }
  return output.sort();
}

const integrity = Object.fromEntries(await Promise.all(names.map(async (name) => {
  const bytes = await readFile(join(vendor, name));
  return [name, createHash("sha256").update(bytes).digest("hex")];
})));
const fonts = Object.fromEntries(await Promise.all((await filesBelow(fontDestination)).map(async (name) => {
  const bytes = await readFile(join(fontDestination, name));
  return [name, createHash("sha256").update(bytes).digest("hex")];
})));
// The npm packages esbuild bundled, compared with THIRD_PARTY.md by tools/check-third-party.mjs.
await writeFile(join(vendor, INVENTORY_NAME), formatInventory(packagesFromMetafile(result.metafile, root)));
await writeFile(join(vendor, "board-assets.json"), `${JSON.stringify({ main, css, integrity, fonts }, null, 2)}\n`);
await writeFile(join(root, "static", "board.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">\n<meta name="referrer" content="no-referrer">\n<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-src 'none'; img-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src blob:">\n<title>Whiteboard</title>\n<link rel="stylesheet" href="/static/vendor/${css}">\n</head>\n<body>\n<div id="root"></div>\n<script type="module" src="/static/vendor/${main}"></script>\n</body>\n</html>\n`);
