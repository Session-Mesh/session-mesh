// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../static/workspace-spec.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(source, context);
const spec = context.MeshWorkspaceSpec;
const plain = (value) => JSON.parse(JSON.stringify(value));

const v1 = {
  active: "live-a",
  columns: [{ grow: 2, active: 0, tabs: [
    { id: "live-a", kind: "terminal" }, { id: "board:live-a", kind: "board" },
  ] }],
};
const migrated = spec.migrateV1(v1);
assert.deepEqual(plain(migrated), {
  version: 2, active: { column: 0, tab: 0 }, columns: [{ grow: 2, active: 0, tabs: [
    { type: "terminal", target: "live-a" }, { type: "board", target: "board:live-a" },
  ] }],
});
assert.deepEqual(plain(spec.reconcile(migrated, (target) => target === "live-a")), {
  version: 2, active: { column: 0, tab: 0 }, columns: [{ grow: 2, active: 0, tabs: [
    { type: "terminal", target: "live-a" },
    { type: "unavailable", target: "board:live-a", unavailable: "missing-target" },
  ] }],
});

assert.deepEqual(plain(spec.migrateV1({ columns: [{ tabs: [{ id: "ignored", kind: "plugin" }] }] })), {
  version: 2, active: null, columns: [{ grow: 1, active: 0, tabs: [
    { type: "unavailable", target: null, unavailable: "unknown-type" },
  ] }],
});
assert.deepEqual(plain(spec.readV2({ version: 2, active: { column: 0, tab: 0 }, columns: [{ grow: 1, active: 0, tabs: [{ type: "future-widget", target: "never" }] }] })), {
  version: 2, active: { column: 0, tab: 0 }, columns: [{ grow: 1, active: 0, tabs: [
    { type: "unavailable", target: null, unavailable: "unknown-type" },
  ] }],
});
assert.equal(spec.readV2({ version: 1, columns: [] }), null);
