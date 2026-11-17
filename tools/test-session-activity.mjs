// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../static/session-activity.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(source, context);
const activity = context.MeshSessionActivity;
assert.ok(activity, "typed activity bundle must export its browser API");

const session = (id, status = "idle", created = 1, updated = 1) =>
  ({ id, kind: "mesh", name: id, created, agent: { type: "codex", status, updated } });
const metric = (value, end, state = "derived") => ({
  state, source: "procfs-stat", value: state === "derived" ? value : null,
  observed_at: state === "derived" ? end : null,
  window: state === "derived" ? { start: end - 10, end } : null,
  reason: state === "derived" ? null : "first-sample",
});
const management = (id, created, cpu) => ({
  sessions: [{ name: id, created, source: "mesh", lifecycle: "active",
    agent_type: "codex", metrics: { cpu_percent: cpu } }],
});
const update = (prior, sessions, rows, now) => activity.update(prior, sessions, rows, now);

for (const rows of [null, management("quiet", 1, metric(90, 1))]) {
  let confirmed = update(null, [session("quiet", "busy")], null, 100);
  confirmed = update(confirmed, [session("quiet", "busy")], null, 110);
  const retained = update(confirmed, [session("quiet")], rows, 140);
  assert.equal(retained.phaseById.quiet, "active", "busy confirmation retains unknown/stale CPU for 30 seconds");
  assert.equal(update(retained, [session("quiet")], rows, 141).phaseById.quiet,
    "unknown", "busy retention expires without renewed confirmation");
}

let result = update(null, [session("busy", "busy"), session("quiet")],
  management("quiet", 1, metric(72, 100)), 100);
assert.deepEqual([...result.activeIds], ["busy", "quiet"]);
assert.equal(result.phaseById.quiet, "active");

result = update(result, [session("busy", "busy", 1, 999), session("quiet", "idle", 1, 999)],
  management("quiet", 1, metric(0, 110)), 110);
assert.deepEqual([...result.activeIds], ["busy", "quiet"], "one zero window must not demote");
result = update(result, [session("busy", "busy"), session("quiet")],
  management("quiet", 1, metric(0, 120)), 120);
assert.deepEqual([...result.activeIds], ["busy"]);
assert.equal(result.phaseById.quiet, "inactive");

const absent = update(null, [session("quiet")], management("quiet", 1, metric(null, 0, "unknown")), 100);
assert.equal(update(null, [session("quiet", "waiting")], management("quiet", 1, metric(90, 100)), 100)
  .phaseById.quiet, "inactive", "waiting preserves the owner-needed indication despite positive CPU");
assert.equal(absent.phaseById.quiet, "unknown", "unknown CPU must not become measured idle");
const stale = update(null, [session("quiet")], management("quiet", 1, metric(90, 1)), 100);
assert.equal(stale.phaseById.quiet, "unknown", "old measurements cannot prove present activity");
const malformed = metric(90, 100);
malformed.reason = "association-changed";
assert.equal(update(null, [session("quiet")], management("quiet", 1, malformed), 100).phaseById.quiet,
  "unknown", "malformed measurements cannot prove activity");
const oldWindow = update(result, [session("quiet")], management("quiet", 1, metric(90, 110)), 130);
assert.equal(oldWindow.phaseById.quiet, "unknown", "an older window cannot revive a demoted session");
const lost = update(update(null, [session("quiet")], management("quiet", 1, metric(80, 100)), 100),
  [session("quiet")], management("quiet", 1, metric(null, 0, "unknown")), 131);
assert.equal(lost.phaseById.quiet, "unknown", "unknown activity must not be retained indefinitely");
const changed = update(result, [session("quiet", "idle", 2)], management("quiet", 1, metric(80, 130)), 130);
assert.equal(changed.phaseById.quiet, "unknown", "a reused name cannot inherit old activity");
const stopped = update(result, [], management("quiet", 1, metric(80, 130)), 130);
assert.deepEqual([...stopped.activeIds], []);

let many = update(null, Array.from({ length: 10 }, (_, i) => session(`s${i}`, "busy", 1, i)), null, 100);
const firstOrder = [...many.activeIds];
many = update(many, Array.from({ length: 10 }, (_, i) => session(`s${i}`, "busy", 1, 100 - i)), null, 104);
assert.deepEqual([...many.activeIds], firstOrder, "output timestamps must not reorder active rows");

console.log("session activity ranking passed");
