// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sidebar's activity phase against the shipped bundle: a status the agent reports itself
// (claude's) wins over CPU; an inferred one (codex "idle") leaves CPU to decide, which needs a
// sustained load above the noise of an idle process.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

type Ranking = {phaseById: Record<string, string>};
type Activity = {update: (prior: Ranking | null, sessions: unknown, management: unknown, now: number) => Ranking};

const source = fs.readFileSync(new URL('../static/session-activity.js', import.meta.url), 'utf8');
const context: {MeshSessionActivity?: Activity} = {};
vm.runInNewContext(source, context);
const activity = context.MeshSessionActivity as Activity;

const session = (status: string | undefined, type: string) =>
  ({id: 's', kind: 'mesh', name: 's', created: 1, agent: {type, status, updated: 1}});
const cpu = (value: number | null, end: number) => value === null
  ? {state: 'unknown', source: 'procfs-stat', value: null, observed_at: null, window: null, reason: 'gone'}
  : {state: 'derived', source: 'procfs-stat', value, observed_at: end, window: {start: end - 10, end}, reason: null};
const management = (value: number | null, end: number, type: string) => ({
  sessions: [{name: 's', created: 1, source: 'mesh', lifecycle: 'active', agent_type: type,
    metrics: {cpu_percent: cpu(value, end)}}],
});

// One 10 s sample per step: a CPU value (null: no sample), or [status, value] to change the status first.
type Step = number | null | [string | undefined, number | null];
const steps = (initial: string | undefined, values: Step[], type = 'claude') => {
  let ranking: Ranking | null = null;
  let status = initial;
  values.forEach((step, index) => {
    const now = 100 + 10 * index;
    if (Array.isArray(step)) status = step[0];
    const value = Array.isArray(step) ? step[1] : step;
    ranking = activity.update(ranking, [session(status, type)], management(value, now, type), now);
  });
  return (ranking as unknown as Ranking).phaseById.s;
};
const run = (status: string | undefined, values: number[], type = 'claude') => steps(status, values, type);

test('an idle claude session stays inactive through idle-process CPU noise', () => {
  assert.equal(run('idle', [0.2, 0.2, 0.2]), 'inactive');
  assert.equal(run('idle', [0, 0.3, 0.1, 0.3]), 'inactive');
});

test('a reported claude idle or waiting status is not overridden by heavy CPU', () => {
  assert.equal(run('idle', [80, 80, 80]), 'inactive');
  assert.notEqual(run('waiting', [80, 80, 80]), 'active');
});

test('unknown status needs two consecutive windows above the threshold', () => {
  assert.notEqual(run(undefined, [30]), 'active');
  assert.equal(run(undefined, [30, 30]), 'active');
  assert.notEqual(run(undefined, [30, 0.2, 30]), 'active');
  assert.notEqual(run(undefined, [3, 3, 3]), 'active');
});

test('a busy status is active whatever the CPU says', () => {
  assert.equal(run('busy', [0]), 'active');
  assert.equal(run('busy', [0, 0, 0]), 'active');
  assert.equal(run('busy', [90]), 'active');
  assert.equal(run('busy', [0, 0], 'codex'), 'active');
});

test('codex idle is only inferred from its rollout, so sustained CPU makes it active', () => {
  assert.equal(run('idle', [65, 65], 'codex'), 'active');
  assert.equal(run('idle', [80, 80, 80], 'codex'), 'active');
});

test('codex idle needs two consecutive hot windows and stays idle on noise', () => {
  assert.notEqual(run('idle', [65], 'codex'), 'active');
  assert.notEqual(run('idle', [0.2, 0.3, 0.1, 0.2], 'codex'), 'active');
  assert.notEqual(run('idle', [3, 3, 3], 'codex'), 'active');
  assert.notEqual(run('idle', [30, 0.2, 30], 'codex'), 'active');
});

test('a missing sample breaks the run of hot windows', () => {
  assert.notEqual(steps(undefined, [30, null, 30]), 'active');
  assert.notEqual(steps('idle', [65, null, 65], 'codex'), 'active');
  assert.equal(steps('idle', [65, null, 65, 65], 'codex'), 'active');
});

// Each sample as [window end, CPU value]; the window is the 10 s before its end, read at that end.
const windows = (status: string, samples: [number, number][], type = 'codex') => {
  let ranking: Ranking | null = null;
  for (const [end, value] of samples) {
    ranking = activity.update(ranking, [session(status, type)], management(value, end, type), end);
  }
  return (ranking as unknown as Ranking).phaseById.s;
};

test('two hot windows promote only when the second starts where the first ended', () => {
  assert.notEqual(windows('idle', [[100, 65], [120, 65]]), 'active');
  assert.equal(windows('idle', [[100, 65], [120, 65], [130, 65]]), 'active');
  assert.equal(windows('idle', [[100, 65], [110, 65]]), 'active');
});

// Demotion is eager on purpose: a client that shares the CPU baseline may only ever see gapped windows.
test('two cold windows demote whether or not the second starts where the first ended', () => {
  assert.equal(windows('idle', [[100, 65], [110, 65], [120, 0.2]]), 'active');
  assert.equal(windows('idle', [[100, 65], [110, 65], [120, 0.2], [140, 0.2]]), 'inactive');
  assert.equal(windows('idle', [[100, 65], [110, 65], [120, 0.2], [130, 0.2]]), 'inactive');
});

test('gapped cold windows over more than 30 s demote an active session', () => {
  const samples: [number, number][] = [[100, 65], [110, 65]];
  for (let end = 130; end <= 3730; end += 20) samples.push([end, 0.2]);
  assert.equal(windows('idle', samples), 'inactive');
});

test('an active session demotes once no hot window has been seen for more than 30 s', () => {
  // Each status change restarts the cold run, so only the time bound can demote here.
  const flipping: Step[] = [65, 65, [undefined, 0.2], ['idle', 0.2], [undefined, 0.2]];
  assert.equal(steps('idle', flipping, 'codex'), 'active');
  assert.equal(steps('idle', [...flipping, ['idle', 0.2]], 'codex'), 'inactive');
});

test('a missing sample breaks the run of cold windows during the grace period', () => {
  assert.equal(steps('idle', [65, 65, 0.2, null, 0.2], 'codex'), 'active');
  assert.equal(steps('idle', [65, 65, 0.2, null, 0.2, 0.2], 'codex'), 'inactive');
});

test('a status change breaks the run of hot windows', () => {
  assert.notEqual(steps(undefined, [30, ['shell', 30]]), 'active');
  assert.equal(steps(undefined, [30, ['shell', 30], 30]), 'active');
});

// Each sample as [window start, window end, CPU value], read at the window end.
const spans = (samples: [number, number, number][]) => {
  let ranking: Ranking | null = null;
  for (const [start, end, value] of samples) {
    const metrics = {cpu_percent: {state: 'derived', source: 'procfs-stat', value, observed_at: end,
      window: {start, end}, reason: null}};
    const raw = {sessions: [{name: 's', created: 1, source: 'mesh', lifecycle: 'active', agent_type: 'codex', metrics}]};
    ranking = activity.update(ranking, [session('idle', 'codex')], raw, end);
  }
  return (ranking as unknown as Ranking).phaseById.s;
};

test('a window longer than 15 s is never hot, so it cannot promote', () => {
  assert.notEqual(spans([[90, 100, 65], [100, 140, 10]]), 'active');
  assert.notEqual(spans([[90, 100, 65], [100, 140, 10], [140, 150, 65]]), 'active');
  assert.equal(spans([[90, 100, 65], [100, 140, 10], [140, 150, 65], [150, 160, 65]]), 'active');
  assert.equal(spans([[90, 100, 65], [100, 114, 65]]), 'active');
});

test('after the 30 s grace, one hot window does not renew activity', () => {
  assert.equal(windows('idle', [[100, 65], [110, 65], [140, 65]]), 'active');
  assert.notEqual(windows('idle', [[100, 65], [110, 65], [150, 65]]), 'active');
  assert.equal(windows('idle', [[100, 65], [110, 65], [150, 65], [160, 65]]), 'active');
});
