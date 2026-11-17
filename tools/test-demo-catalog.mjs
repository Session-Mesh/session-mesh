// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../static/demo-catalog.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(source, context);
const catalog = context.MeshDemoCatalog;
// The texts are checked in English, through the app's English catalog. No
// `document` in this sandbox: i18n.js only exposes its pure core.
const i18nSandbox = {};
vm.runInNewContext(await readFile(new URL("../static/i18n.js", import.meta.url), "utf8"), i18nSandbox);
const english = JSON.parse(await readFile(new URL("../static/i18n/en.json", import.meta.url), "utf8"));
catalog.setTranslator(i18nSandbox.MeshI18n.core.createTranslator({
  lang: "en", catalog: english, fallback: english,
  onMissing: (key) => { throw new Error(`no English text for ${key}`); } }));
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = "0123456789abcdef0123456789abcdef";

assert.deepEqual(plain(catalog.readCatalog([{ id, title: "🧪".repeat(61), version: 0 }])),
  [{ id, title: "🧪".repeat(61), version: 0 }]);
assert.equal(catalog.readCatalog([{ id, title: "🧪".repeat(121), version: 0 }]), null);
assert.equal(catalog.readCatalog([
  { id, title: "A", version: 0 }, { id, title: "B", version: 1 },
]), null);
assert.equal(catalog.choiceLabel({ id, title: "Même titre", version: 2 }, [{ id, title: "Même titre", version: 2 }]),
  "Même titre · 012345");
assert.equal(catalog.choiceLabel({ id: "legacy", title: "", version: 0 },
  [{ id: "legacy", title: "", version: 0 }]), "Untitled demo · old");

const sharedPrefixRows = [
  { id: `012345${"a".repeat(26)}`, title: "Même titre", version: 0 },
  { id: `012345${"b".repeat(26)}`, title: "Même titre", version: 0 },
];
assert.equal(catalog.choiceLabel(sharedPrefixRows[0], sharedPrefixRows), "Même titre · 012345a");
assert.equal(catalog.choiceLabel(sharedPrefixRows[1], sharedPrefixRows), "Même titre · 012345b");
assert.notEqual(catalog.choiceLabel(sharedPrefixRows[0], sharedPrefixRows),
  catalog.choiceLabel(sharedPrefixRows[1], sharedPrefixRows));

assert.deepEqual(plain(catalog.readNamedHistory({
  demo_id: id, format: "mesh-scene-v0", current: 3, versions: [1, 2, 3],
}, id)), { demoId: id, format: "mesh-scene-v0", current: 3, versions: [1, 2, 3] });
for (const hostile of [
  { demo_id: id, format: "mesh-scene-v0", current: 3, versions: [1, 3, 2] },
  { demo_id: id, format: "mesh-scene-v0", current: 2, versions: [1, 3] },
  { demo_id: id, format: "mesh-scene-v0", current: 1, versions: [1], title: "selector" },
  { demo_id: id, format: "mesh-scene-v0", current: true, versions: [1] },
  { demo_id: id, format: "mesh-scene-v0", current: 1, versions: [1, 1] },
]) assert.equal(catalog.readNamedHistory(hostile, id), null);
assert.equal(catalog.readNamedHistory({
  demo_id: id, format: "mesh-scene-v0", current: 1, versions: [1],
}, "f".repeat(32)), null);
