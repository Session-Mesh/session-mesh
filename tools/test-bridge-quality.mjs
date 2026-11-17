// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import { ESLint } from "eslint";

// Prove the real bridge filename inherits defect rules, without modifying its
// served bytes. Frontend CI installs ESLint; the independent Python job does not.
const lint = new ESLint();
const filePath = "static/mesh-frame-history.js";
const [control] = await lint.lintText("window.addEventListener('load', () => {});\n", { filePath });
assert.equal(control.errorCount, 0, JSON.stringify(control.messages));
assert.equal(control.warningCount, 0, JSON.stringify(control.messages));
const [defect] = await lint.lintText("const unusedBridgeBinding = 1;\n", { filePath });
assert.equal(defect.errorCount, 1, JSON.stringify(defect.messages));
assert.equal(defect.messages[0].ruleId, "no-unused-vars");
