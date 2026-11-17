// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The npm packages esbuild puts into the whiteboard bundle, from its metafile, with
// the license each declares in its package.json. tools/build-board.mjs writes them to
// static/vendor/board-packages.json; tools/check-third-party.mjs compares that file
// with the `Package:` lines of THIRD_PARTY.md.
//
// What this cannot see: code a package embeds in its own prebuilt file. The
// Excalidraw npm package is one prebuilt bundle (pako, roughjs, jotai, ...), so its
// embedded libraries are still found by reading the file (THIRD_PARTY.md).
import fs from "node:fs";
import path from "node:path";

export const INVENTORY_NAME = "board-packages.json";

// "node_modules/@scope/name/dist/x.js" -> "node_modules/@scope/name" (the last node_modules level).
function packageDirectory(input) {
  const parts = input.split("/");
  const start = parts.lastIndexOf("node_modules");
  if (start < 0 || start + 1 >= parts.length) return null;
  return parts.slice(0, start + (parts[start + 1].startsWith("@") ? 3 : 2)).join("/");
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  return "UNKNOWN";
}

export function packagesFromMetafile(metafile, root) {
  const directories = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const directory = packageDirectory(input);
    if (directory) directories.add(directory);
  }
  const packages = [...directories].map((directory) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, "package.json"), "utf8"));
    return { name: manifest.name, version: manifest.version, license: declaredLicense(manifest) };
  });
  return packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function formatInventory(packages) {
  return `${JSON.stringify({ packages }, null, 2)}\n`;
}

const key = (item) => `${item.name} ${item.version} ${item.license}`;

// `declared`: the Package lines of a section, `inventory`: the packages of the file.
export function inventoryProblems(sectionTitle, declared, inventory) {
  const declaredKeys = new Set(declared.map(key));
  const inventoryKeys = new Set(inventory.map(key));
  const problems = [];
  for (const item of inventory) {
    if (!declaredKeys.has(key(item))) problems.push(`section "${sectionTitle}": bundled package ${key(item)} has no matching Package: line`);
  }
  for (const item of declared) {
    if (!inventoryKeys.has(key(item))) problems.push(`section "${sectionTitle}": Package: ${key(item)} is not in the bundle inventory`);
  }
  return problems;
}

// "name version license" (the name may be scoped); the license is the rest of the line.
export function parsePackageLine(text) {
  const [name, version, ...license] = text.trim().split(/\s+/);
  return { name, version, license: license.join(" ") };
}
