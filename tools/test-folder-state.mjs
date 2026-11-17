// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(join(root, "static", "folder-state.js"), "utf8");
const context = {};
vm.runInNewContext(source, context, { filename: "static/folder-state.js" });
const state = context.MeshFolderState;

assert.ok(state);
assert.deepEqual(
  { ...state.folderRenameReceipt({ folder_rename: { old: "Avant", new: "Après plié" } }, "Avant") },
  { old: "Avant", new: "Après plié" },
);
assert.equal(state.folderRenameReceipt({ folder_rename: { old: "autre", new: "Après" } }, "Avant"), null);
assert.equal(state.folderRenameReceipt({ folder_rename: { old: "Avant", new: 4 } }, "Avant"), null);
assert.deepEqual(
  [...state.migrateFoldedFolder(new Set(["mesh", "dir:Avant", "st:busy"]), { old: "Avant", new: "Après" })],
  ["mesh", "dir:Après", "st:busy"],
);

vm.runInNewContext(await readFile(join(root, "static", "history-state.js"), "utf8"), context);
const history = context.MeshHistoryState;
const binding = { name: "continuous-audit-codex", label: "Security", aliases: ["Original", "Security"],
  agent: "codex", sid: "abcdefgh-1234", seen: 100, created: 1, closed_at: 101 };
assert.equal(history.bindings([binding, { ...binding, aliases: [12] }, null]).length, 1);
const decorated = history.decorate({ agent: "codex", id: binding.sid }, [binding]);
assert.equal(decorated.mesh_name, binding.name);
assert.equal(history.matchesName("original", decorated), true);
assert.equal(history.matchesName("continuous-audit", decorated), true);
assert.equal(history.decorate({ agent: "claude", id: binding.sid }, [binding]).mesh_name, "");
assert.equal(history.recent([binding], new Set([`codex:${binding.sid}`])).length, 0);
assert.equal(history.recent([{ ...binding, agent: "claude" }], new Set([`codex:${binding.sid}`])).length, 1);
assert.equal(history.recent([binding, { ...binding, closed_at: 99 }], new Set()).length, 1);
assert.equal(history.recent([{ ...binding, sid: null }], new Set()).length, 1);
assert.equal(history.decorate({ agent: "codex", id: binding.sid },
  Array.from({length: 50}, (_, i) => ({...binding, seen: i, aliases: [`alias-${i}`]}))).mesh_aliases.length, 20);
