// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, readdir, stat, rm, realpath } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { generateSnapshot, publishSnapshot, readConfigFile, runProvider, normalizeProvider, main } from '../tools/project-snapshot.ts';
import { parseProjectConfig, parseProjectCatalog } from '../static/project-catalog.ts';
import { roadmapTask, roadmapObservation, attemptObservation, followupCatalog } from './helpers/project-followup-fixtures.ts';

async function fixture(t) {
  // Resolved: project file paths refuse symlinks, and the macOS temporary directory is under /var, a symlink.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mesh-project-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const cfg = (root, sources = []) => parseProjectConfig({ kind: 'mesh-project-config', schema_version: 1, machine_id: 'host',
  projects: [{ id: 'one', title: 'One', sources, sessions: [] }] });
function pipelineObservation(root, task = 'release-check') {
  const pair = { phase: 'implement', outcome: 'COMPLETED' };
  const report = status => ({ status, round: 1, cycle: null, date: 'round two, date unknown',
    findings: { items: [{ severity: 'high', summary: '<img src=x onerror=alert(1)>', status: 'open', specialist: null, path: '/DO_NOT_COPY', line: 42 }], total: 1, truncated: false },
    rounds_audit: { items: [{ round: 1, date: null, verdict: status, qualifying: true, causes: 'Recorded cause' }], total: 1, truncated: false },
    no_go_reason: null, summary: null, cross_runtime: { items: [], total: null, truncated: false } });
  const components = Object.fromEntries(['ledger','intake','spec','plan','implementation','review','qa_state','qa','manifest'].map(name => [name,
    { source: `briefs/${task}-${name}`, availability: 'absent', reason: null, digest: null, value: null, truncated: false }]));
  const valid = value => ({ source: '/DO_NOT_COPY', availability: 'valid', reason: null, digest: 'a'.repeat(64), value, truncated: false });
  components.ledger = valid({ mode: 'full', current_phase: pair.phase, latest_completed: pair, history_total: 2 });
  components.review = valid(report('GO'));
  components.qa_state = valid({ ...report('NO-GO'), qa_no_go_round: 1 });
  components.qa = valid({ text: 'DO_NOT_COPY_MARKDOWN', status: 'NO-GO' });
  return { schema_version: 1, kind: 'pipeline-task', generated_at: '2026-11-14T10:00:00Z',
    schema: { id: 'https://github.com/mathiasbourgoin/roster/schema/pipeline-observation/v1', digest: 'b'.repeat(64) }, root, version: 'c'.repeat(64),
    coverage: ['checks','live-execution','session','attempt','full-report-history','standalone-acceptance'].map(id =>
      ({ id, availability: 'unsupported', limitations: 'No canonical authority', source: '/DO_NOT_COPY', authority: 'Metadata only' })),
    data: { task, availability: 'valid', components, mode: 'full', latest_completed: pair, verdict_disagreement: true,
      history: { total: 2, truncated: false, next_cursor: 'DO_NOT_COPY_CURSOR', items: [
        { id: 'event:0', source_index: 0, phase: 'review', outcome: 'NO-GO', reason: null, reason_truncated: false,
          actor: { availability: 'unknown', value: null, truncated: false }, time: { availability: 'unknown', value: null } },
        { id: 'event:1', source_index: 1, ...pair, reason: 'Correction recorded', reason_truncated: false,
          actor: { availability: 'valid', value: 'implementer', truncated: false }, time: { availability: 'valid', value: 'November 14, 2026 10:00:00 GMT+0100' } },
      ] } } };
}
async function executable(root, text) {
  const path = join(root, `provider-${Math.random()}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\n${text}`, { mode: 0o700 }); return path;
}
test('unconfigured registry produces valid catalog without invoking executables', async t => {
  const root = await fixture(t);
  const c = await generateSnapshot(cfg(root, [{ id: 'roadmap', kind: 'roster', label: 'Roadmap' }]), {});
  assert.equal(c.projects[0].sources[0].status, 'unconfigured');
  assert.ok(parseProjectCatalog(c));
});
test('explicit followup profile observes one bounded event window without changing the default', async t => {
  const root = await fixture(t), board = join(root, 'board'); await mkdir(board);
  const cli = await executable(root, `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['view',${JSON.stringify(board)},'--events','100']))process.exit(3);
    console.log(JSON.stringify({kind:'roster-roadmap-view',schema_version:1,generated_at:'2026-11-14T00:00:00Z',version:'v1',
      board_id:'board',contract_digest:'a'.repeat(64),accepted:true,revision:2,
      goal:'Deliver',phase:'active',counts:{active:1},completion:{},global:{accepted:false},
      tasks:[{id:'task',objective:'Task',state:'queued',attempts:0,depends_on:[],checks:[],max_attempts:3,assignment:null,
        topology:null,timeline:[],progress:{status:'not-active',sequence:0},kind:'contract',derived:null,corrections:[],estimate:null,last_result:null,blocker:null,recovery:null}],
      recent_events:[],events_total:0,events_truncated:false,estimates:null}));`);
  const config = cfg(root, [{ id: 'r', kind: 'roster', label: 'R', board_path: board }]);
  const value = await generateSnapshot(config, { rosterCLI: cli, catalogVersion: 2, profile: 'followup/1' });
  assert.equal(value.schema_version, 2);
  assert.deepEqual(value.features, ['roster-followup/1']);
  assert.equal(value.projects[0].sources[0].status, 'available');
  assert.equal(value.projects[0].sources[0].summary.followup.metadata.value.board_id, 'board');
  const legacy = await generateSnapshot(config, { rosterCLI: cli });
  assert.equal(legacy.schema_version, 1);
  assert.equal(legacy.projects[0].sources[0].status, 'unavailable');
});
test('attempt history retains original claims and budgets', () => {
  for (const total of [30, 200, 201]) {
    const timeline = Array.from({ length: total }, (_, i) => attemptObservation(i + 1));
    const c = followupCatalog(roadmapObservation([roadmapTask({ attempts: total, timeline, max_attempts: 3 })]));
    const detail = c.projects[0].sources[0].summary.followup.task_details.items[0];
    assert.equal(detail.timeline.availability, 'valid');
    assert.equal(detail.timeline.value.total, total);
    assert.equal(detail.timeline.value.items.length, Math.min(total, 200));
    assert.equal(detail.timeline.value.items[0].attempt, Math.max(1, total - 199));
    assert.equal(detail.timeline.truncated, total > 200);
    assert.equal(detail.budget.value.max_attempts, 3);
  }
  for (const timeline of [
    [attemptObservation(2)],
    [attemptObservation(1), attemptObservation(2, { attempt_id: 'attempt-1' })],
    [attemptObservation(1, { outcome: 'active', ended_at: null })],
  ]) {
    const value = followupCatalog(roadmapObservation([roadmapTask({ timeline, attempts: timeline.length })]));
    assert.equal(value.projects[0].sources[0].summary.followup.task_details.items[0].timeline.availability, 'invalid');
  }
  const discarded = Array.from({ length: 201 }, (_, i) => attemptObservation(i + 1));
  discarded[0].attempt_id = false;
  const value = followupCatalog(roadmapObservation([roadmapTask({ timeline: discarded, attempts: 201 })]));
  assert.equal(value.projects[0].sources[0].summary.followup.task_details.items[0].timeline.availability, 'invalid');
});
test('progress remains source declared assignment evidence', () => {
  const assignment = { id: 'attempt-1', assignee: 'worker', runtime: 'runtime', role: 'implementer', route: null, model: null };
  const progress = { status: 'reported', source: 'worker-reported', sequence: 1, recorded_at: '2026-11-14T11:00:00Z', message: 'Ready for review', current_step: null };
  const read = overrides => followupCatalog(roadmapObservation([roadmapTask({ state: 'active', assignment, progress, ...overrides })])).projects[0].sources[0].summary.followup.task_details.items[0];
  assert.equal(read({}).progress.value.source, 'worker-reported');
  for (const overrides of [{ assignment: null }, { state: 'done' }, { progress: { ...progress, sequence: 0 } }, { progress: { ...progress, source: 'live' } }]) assert.equal(read(overrides).progress.availability, 'invalid');
  assert.equal(read({ progress: { status: 'invalid', sequence: null, reason: 'Stale report' } }).progress.value.status, 'invalid');
  assert.equal(read({ progress: { status: 'unreported', sequence: 0 } }).progress.value.status, 'unreported');
  assert.equal(read({ progress: { status: 'not-active', sequence: 0 } }).progress.availability, 'invalid');
});
test('selected optional families contain malformed payloads and declare display clipping', () => {
  const task = roadmapTask({ blocker: 'x'.repeat(1999) + '😀tail', max_attempts: -1, kind: 'derived', derived: null });
  const value = followupCatalog(roadmapObservation([task], { revision: 'wrong', estimates: {} }));
  const followup = value.projects[0].sources[0].summary.followup, detail = followup.task_details.items[0];
  assert.equal(detail.blocker.value.length, 1999);
  assert.equal(detail.blocker.text_truncated, true);
  assert.equal(detail.budget.availability, 'invalid');
  assert.equal(detail.lineage.availability, 'invalid');
  assert.equal(followup.metadata.availability, 'invalid');
  assert.equal(followup.forecast.availability, 'invalid');
  assert.equal(followup.truncated, true);
  const absent = roadmapTask(); delete absent.timeline; delete absent.max_attempts;
  const detail2 = followupCatalog(roadmapObservation([absent])).projects[0].sources[0].summary.followup.task_details.items[0];
  assert.equal(detail2.timeline.availability, 'not-provided');
  assert.equal(detail2.budget.availability, 'not-provided');
  assert.equal(detail2.assignment.value, null);
});
test('catalog profiles refuse unsupported admission before providers', async t => {
  const root = await fixture(t), config = join(root, 'config.json'), output = join(root, 'catalog.json'), started = join(root, 'started');
  const cli = await executable(root, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(started)},'unexpected');console.log('{}')`);
  const raw = { kind: 'mesh-project-config', schema_version: 1, machine_id: 'host', projects: [{ id: 'one', title: 'One',
    sources: [{ id: 'r', kind: 'roster', label: 'R', board_path: root }], sessions: [] }] };
  await writeFile(config, JSON.stringify(raw)); await writeFile(output, 'prior-artifact');
  for (const args of [['--catalog-version', '0'], ['--catalog-version', '2', '--catalog-version', '2'], ['--catalog-version', '1', '--catalog-version', '2']]) {
    await assert.rejects(main(['--config', config, '--output', output, '--roster-cli', cli, ...args]));
  }
  for (const extra of [{ schema_version: 2 }, { features: ['project-metadata/1'] }, { features: ['unknown/1'] }]) {
    await writeFile(config, JSON.stringify({ ...raw, ...extra }));
    await assert.rejects(main(['--config', config, '--output', output, '--roster-cli', cli, '--catalog-version', '2']));
  }
  for (const catalogVersion of [0, 3, null, '2']) await assert.rejects(generateSnapshot(cfg(root), { catalogVersion }));
  assert.equal(await readFile(output, 'utf8'), 'prior-artifact');
  await assert.rejects(readFile(started), e => e.code === 'ENOENT');
});
test('source forecast clocks ranges and event windows preserve independent coverage', () => {
  const range = { optimistic: 10, likely: 20, pessimistic: 30 };
  const eta = { status: 'conditional', remaining_minutes: range,
    finish_at: { optimistic: '2026-11-14T12:10:00Z', likely: '2026-11-14T12:20:00Z', pessimistic: '2026-11-14T12:30:00Z' }, reasons: [] };
  const estimates = { schema_version: 1, as_of: '2026-11-14T12:00:00Z', estimate_revision: 3, based_on_state_revision: 1,
    tasks_eta: eta, global_eta: eta, assumptions: ['Capacity-aware source forecast'] };
  const read = overrides => followupCatalog(roadmapObservation([roadmapTask()], { estimates, ...overrides })).projects[0].sources[0].summary.followup;
  assert.equal(read({}).forecast.value.based_on_state_revision, 1);
  for (const forecast of [{ ...estimates, based_on_state_revision: 3 }, { ...estimates, as_of: '2026-11-14T12:01:00Z' },
    { ...estimates, global_eta: { ...eta, status: 'complete' } }, { ...estimates, global_eta: { ...eta, remaining_minutes: { optimistic: 20, likely: 10, pessimistic: 30 } } }]) {
    assert.equal(read({ estimates: forecast }).forecast.availability, 'invalid');
  }
  assert.equal(read({ recent_events: [], events_total: 4, events_truncated: true }).events.availability, 'invalid');
  assert.equal(read({ recent_events: Array.from({ length: 101 }, () => ({ action: 'claim' })), events_total: 101, events_truncated: false }).events.availability, 'invalid');
  assert.equal(read({ recent_events: [{ action: 'claim', task_id: 'task', at: 'source time' }], events_total: 1 }).events.value.items[0].at, 'source time');
});
test('fixed Roster read normalizes local receipt versus worker check and operator asks', async t => {
  const root = await fixture(t), board = join(root, 'board'); await mkdir(board);
  const cli = await executable(root, `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['view',${JSON.stringify(board)},'--events','0']))process.exit(3);
    console.log(JSON.stringify({kind:'roster-roadmap-view',schema_version:1,generated_at:'2026-11-14T00:00:00Z',version:'v1',
      goal:'Deliver',phase:'active',counts:{done:1,active:1},completion:{tasks_total:2,tasks_done:1},global:{accepted:false},
      tasks:[{id:'task',objective:'Task',state:'active',attempts:1,depends_on:[],checks:[{id:'test',accepted_status:'unknown',reported_status:'pass',command:'NEVER COPY'}]}],
      operator_requests:{status:'valid',counts:{open:1,now:1},items:[{id:'ask',text:'Approve?',state:'open'}]},token:'SECRET'}));`);
  const c = await generateSnapshot(cfg(root, [{ id: 'r', kind: 'roster', label: 'R', board_path: board }]), { rosterCLI: cli });
  const s = c.projects[0].sources[0]; assert.equal(s.status, 'available');
  assert.equal(s.summary.global_accepted, false); assert.equal(s.summary.counts.tasks_total, 2);
  assert.equal(s.summary.items[0].checks[0].reported_status, 'pass');
  assert.equal(s.summary.operator_requests[0].title, 'Approve?');
  assert.equal(s.summary.source_generated_at, '2026-11-14T00:00:00Z');
  assert.notEqual(s.observed_at, s.summary.source_generated_at);
  assert.doesNotMatch(JSON.stringify(c), /SECRET|NEVER COPY|board_path/);
});
test('one provider failure does not hide the project or another provider', async t => {
  const root = await fixture(t);
  const c = await generateSnapshot(cfg(root, [{ id: 'r', kind: 'roster', label: 'R', board_path: root }, { id: 'ref', kind: 'github', label: 'Repo' }]), {});
  assert.equal(c.projects[0].sources[0].error_code, 'missing-executable');
  assert.equal(c.projects[0].sources[1].status, 'unconfigured');
});
test('process deadline, UTF8, excess stdout/stderr, nonzero and JSON framing fail closed', async t => {
  const root = await fixture(t);
  for (const [body, code] of [
    ['setInterval(()=>{},1000)', 'timeout'],
    ['process.stdout.write(Buffer.from([0xff]))', 'invalid-output'],
    ['process.stdout.write("x".repeat(500))', 'output-limit'],
    ['process.stderr.write("x".repeat(500))', 'output-limit'],
    ['console.log("{}");process.exitCode=1', 'provider-failed'],
    ['console.log("{} {}")', 'invalid-output'],
  ]) {
    const cli = await executable(root, body);
    // Only the hanging child tests the short deadline. Content assertions must
    // allow normal Node startup, including on a busy test host.
    await assert.rejects(runProvider(cli, [], {}, { timeoutMs: code === 'timeout' ? 100 : 5000, stdoutBytes: 256, stderrBytes: 256 }), e => e.code === code);
  }
});
test('publication is private and atomic, refuses aliases, protected roots, symlinks and nonfiles', async t => {
  const root = await fixture(t), config = join(root, 'config.json'), output = join(root, 'catalog.json');
  await writeFile(config, JSON.stringify(cfg(root))); const catalog = await generateSnapshot(cfg(root), {});
  await publishSnapshot(output, catalog, config, []);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const old = await readFile(output, 'utf8');
  await assert.rejects(publishSnapshot(output, { ...catalog, projects: [{ id: 'bad' }] }, config, []));
  assert.equal(await readFile(output, 'utf8'), old);
  await assert.rejects(publishSnapshot(config, catalog, config, []));
  await assert.rejects(publishSnapshot(output, catalog, config, [root]));
  const link = join(root, 'alias.json'); await symlink(output, link);
  await assert.rejects(publishSnapshot(link, catalog, config, []));
  const dir = join(root, 'dir.json'); await mkdir(dir); await assert.rejects(publishSnapshot(dir, catalog, config, []));
  await assert.rejects(readConfigFile(link));
  assert.deepEqual((await readdir(root)).filter(n => n.includes('.tmp')), []);
});
test('whole run budget aborts active reads, bounds concurrency at four and marks queued reads', async t => {
  const root = await fixture(t), log = join(root, 'started');
  const cli = await executable(root, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(log)},'start\\n');setInterval(()=>{},1000);`);
  const sources = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, kind: 'roster', label: 'R', board_path: root }));
  const start = performance.now(); const c = await generateSnapshot(cfg(root, sources), { rosterCLI: cli, runMs: 150 });
  assert.ok(performance.now() - start < 1000);
  assert.equal(c.projects[0].sources.length, 12);
  assert.ok(c.projects[0].sources.every(s => s.error_code === 'budget-exceeded'));
  // On a loaded runner the 150 ms budget can expire before any provider has written its line:
  // no log is zero launches, which the bound accepts; any other read error still fails.
  const launched = await readFile(log, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  assert.ok(launched.split('\n').filter(Boolean).length <= 4);
});
test('normalization bounds items, preserves native truncation and invalid operator annex state', () => {
  const bounded = normalizeProvider('roster', { kind: 'roster-roadmap-view', schema_version: 1,
    generated_at: '2026-11-14T00:00:00Z', version: 'v', goal: '', phase: 'active', counts: { active: 201 }, completion: {}, global: { accepted: false },
    tasks: Array.from({ length: 201 }, (_, i) => ({ id: `t${i}`, objective: `Task ${i}`, state: 'active', attempts: 1, depends_on: [], checks: [] })) });
  assert.equal(bounded.items.length, 200); assert.equal(bounded.more, 1); assert.equal(bounded.truncated, true);
  const roster = normalizeProvider('roster', { kind: 'roster-roadmap-view', schema_version: 1,
    generated_at: '2026-11-14T00:00:00Z', version: 'v', goal: '', phase: 'draft', counts: {}, completion: {}, global: { accepted: false }, tasks: [],
    operator_requests: { status: 'invalid', reason: 'SECRET raw filesystem path' } });
  assert.equal(roster.operator_status, 'invalid'); assert.deepEqual(roster.operator_requests, []);
  assert.doesNotMatch(JSON.stringify(roster), /SECRET/);
});
test('CLI never replaces prior output after malformed config; stdout path is not implicit', async t => {
  const root = await fixture(t), config = join(root, 'input.json'), output = join(root, 'output.json');
  await writeFile(output, 'previous'); await writeFile(config, '{bad');
  await assert.rejects(main(['--config', config, '--output', output]));
  assert.equal(await readFile(output, 'utf8'), 'previous');
  await assert.rejects(main(['--config', config, '--config', config]));
});
test('FIFO, hardlink and parent-symlink destinations cannot block or replace source data', async t => {
  const root = await fixture(t), config = join(root, 'config.json'), catalog = await generateSnapshot(cfg(root), {});
  await writeFile(config, JSON.stringify(cfg(root)));
  const fifo = join(root, 'pipe.json'); execFileSync('mkfifo', [fifo]);
  await assert.rejects(readConfigFile(fifo));
  await assert.rejects(publishSnapshot(fifo, catalog, config, []));
  const alias = join(root, 'hard.json'); await link(config, alias);
  await assert.rejects(publishSnapshot(alias, catalog, config, []));
  const real = join(root, 'real'); await mkdir(real);
  const parent = join(root, 'parent'); await symlink(real, parent);
  await assert.rejects(publishSnapshot(join(parent, 'catalog.json'), catalog, config, []));
  assert.ok(parseProjectConfig(await readFile(config, 'utf8')));
});
test('deadline kills owned descendants that retain stdout pipes', async t => {
  const root = await fixture(t), heartbeat = join(root, 'beat');
  const body = `require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),5)`;
  const cli = await executable(root, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(body)}],{stdio:['ignore',1,2]});`);
  // Allow both Node processes to start on a busy host. The deadline remains
  // the failure under test; a missing or never-running descendant cannot pass.
  await assert.rejects(runProvider(cli, [], {}, { timeoutMs: 5000 }), e => e.code === 'timeout');
  await new Promise(r => setTimeout(r, 30)); const first = await readFile(heartbeat, 'utf8');
  assert.match(first, /^xx+$/, 'grandchild must have started and emitted repeated heartbeats');
  await new Promise(r => setTimeout(r, 40)); assert.equal(await readFile(heartbeat, 'utf8'), first);
});
test('CLI publishes and prints bounded valid catalogs using only explicit temporary config', async t => {
  const root = await fixture(t), config = join(root, 'config.json'), output = join(root, 'catalog.json');
  await writeFile(config, JSON.stringify(cfg(root)));
  const tool = new URL('../tools/project-snapshot.ts', import.meta.url).pathname;
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', tool, '--config', config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(parseProjectCatalog(stdout)); assert.deepEqual((await readdir(root)).sort(), ['config.json']);
  const emitted = execFileSync(process.execPath, ['--experimental-strip-types', tool, '--config', config, '--output', output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(emitted, ''); assert.ok(parseProjectCatalog(await readFile(output, 'utf8')));
  await writeFile(config, 'invalid');
  assert.throws(() => execFileSync(process.execPath, ['--experimental-strip-types', tool, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }), e => {
    assert.equal(e.status, 1); assert.equal(e.stdout.toString(), ''); assert.doesNotMatch(e.stderr.toString(), /invalid.*at position/); return true;
  });
});
test('missing executable and invalid native schema remain explicit per-source failures', async t => {
  const root = await fixture(t);
  await assert.rejects(runProvider(join(root, 'missing'), [], {}), e => e.code === 'missing-executable');
  const cli = await executable(root, `console.log(JSON.stringify({kind:'roster-roadmap-view',schema_version:2}));`);
  const c = await generateSnapshot(cfg(root, [{ id: 'r', kind: 'roster', label: 'Roadmap', board_path: root }]), { rosterCLI: cli });
  assert.equal(c.projects[0].sources[0].error_code, 'invalid-output');
});
test('malformed normalized summary is isolated to its source rather than breaking publication', async t => {
  const root = await fixture(t);
  const cli = await executable(root, `console.log(JSON.stringify({kind:'roster-roadmap-view',schema_version:1,generated_at:'2026-11-14T00:00:00Z',version:'v',goal:'',phase:'active',counts:{active:2},completion:{},global:{accepted:false},tasks:[{id:'same',objective:'A',state:'active',attempts:1,depends_on:[],checks:[]},{id:'same',objective:'B',state:'active',attempts:1,depends_on:[],checks:[]}]}));`);
  const c = await generateSnapshot(cfg(root, [{ id: 'roadmap', kind: 'roster', label: 'Roadmap', board_path: root }, { id: 'ref', kind: 'other', label: 'Reference' }]), { rosterCLI: cli });
  assert.equal(c.projects[0].sources[0].error_code, 'invalid-output');
  assert.equal(c.projects[0].sources[1].status, 'unconfigured');
});
test('aggregate projected budget refuses early, cancels children and preserves the previous artifact', async t => {
  const root = await fixture(t), payload = join(root, 'payload.json'), started = join(root, 'started'), beat = join(root, 'heartbeat');
  const raw = { kind: 'roster-roadmap-view', schema_version: 1, generated_at: '2026-11-14T00:00:00Z', version: 'v', goal: '', phase: 'active',
    counts: { active: 200 }, completion: { tasks_total: 200, tasks_done: 0 }, global: { accepted: false },
    tasks: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, objective: 'Task', state: 'active', attempts: 1, depends_on: [],
      checks: Array.from({ length: 30 }, (_, j) => ({ id: `c${j}` + 'x'.repeat(65), accepted_status: 'unknown', reported_status: 'pass' })) })) };
  await writeFile(payload, JSON.stringify(raw));
  const cli = await executable(root, `import fs from 'node:fs';const n=Number(process.argv[3].split('/').at(-1));fs.appendFileSync(${JSON.stringify(started)},'x');
    if(n<2)setTimeout(()=>process.stdout.write(fs.readFileSync(${JSON.stringify(payload)})),n*60);
    else {setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),5);setTimeout(()=>process.exit(),30000);}`);
  // Children 2+ hold their slot until the refusal cancels them (the 30 s exit only bounds a leak):
  // exiting on their own at 400 ms let a slow runner launch a sixth provider before the refusal.
  const sources = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, kind: 'roster', label: 'Roadmap', board_path: join(root, 'boards', String(i)) }));
  const configuration = { kind: 'mesh-project-config', schema_version: 1, machine_id: 'host', projects: Array.from({ length: 2 }, (_, i) => ({
    id: `p${i}`, title: 'Project', sources: sources.slice(i * 20, (i + 1) * 20), sessions: [] })) };
  const single = await generateSnapshot(parseProjectConfig({ ...configuration, projects: [{ ...configuration.projects[0], sources: sources.slice(0, 1) }] }), { rosterCLI: cli });
  assert.equal(single.projects[0].sources[0].status, 'available');
  assert.ok(Buffer.byteLength(JSON.stringify(single, null, 2) + '\n') < 2 * 1024 * 1024, 'each summary fits alone');
  await writeFile(started, '');
  const config = join(root, 'config.json'), output = join(root, 'catalog.json');
  await writeFile(config, JSON.stringify(configuration)); await writeFile(output, 'previous-valid-artifact');
  await assert.rejects(main(['--config', config, '--output', output, '--roster-cli', cli]), /catalog-limit/);
  const launches = (await readFile(started, 'utf8')).length;
  assert.ok(launches >= 2 && launches <= 5, `bounded provider launches: ${launches}`);
  await new Promise(r => setTimeout(r, 30)); const before = await readFile(beat, 'utf8').catch(() => '');
  await new Promise(r => setTimeout(r, 40)); assert.equal(await readFile(beat, 'utf8').catch(() => ''), before, 'owned children stopped');
  assert.equal(await readFile(output, 'utf8'), 'previous-valid-artifact');
  assert.deepEqual((await readdir(root)).filter(n => n.includes('.tmp')), []);
});
test('metadata publication budget is reserved before launching any provider', async t => {
  const root = await fixture(t), log = join(root, 'launched');
  const cli = await executable(root, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(log)},'unexpected');`);
  const config = parseProjectConfig({ kind: 'mesh-project-config', schema_version: 1, machine_id: 'host', projects: Array.from({ length: 100 }, (_, i) => ({
    id: `p${i}`, title: 'Project', description: 'd'.repeat(4000),
    sessions: Array.from({ length: 100 }, () => ({ name: 'n'.repeat(120), created: 1 })),
    sources: [{ id: 'r', kind: 'roster', label: 'Roadmap', board_path: join(root, 'board') }] })) });
  assert.ok(config, 'the compact config fits its independent input budget');
  await assert.rejects(generateSnapshot(config, { rosterCLI: cli }), /catalog-limit/);
  await assert.rejects(readFile(log), e => e.code === 'ENOENT');
});

test('pipeline uses one explicit fixed show call and retains current reports apart from history', async t => {
  const root = await fixture(t), source = { id: 'pipeline', kind: 'roster', label: 'Pipeline', pipeline_root: root, pipeline_task: 'a'.repeat(120) };
  const raw = pipelineObservation(root, source.pipeline_task);
  const cli = await executable(root, `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['show','--root',${JSON.stringify(root)},'--task',${JSON.stringify(source.pipeline_task)},'--history-limit','50']))process.exit(4);console.log(${JSON.stringify(JSON.stringify(raw))});`);
  const result = await generateSnapshot(cfg(root, [source]), { rosterPipelineCLI: cli });
  const observed = result.projects[0].sources[0];
  assert.equal(observed.status, 'available');
  assert.equal(observed.summary.provider_schema, 'pipeline-task');
  const p = observed.summary.pipeline;
  assert.equal(p.task, source.pipeline_task); assert.equal(p.history.items[0].outcome, 'NO-GO');
  assert.equal(p.review.status, 'GO'); assert.equal(p.qa.status, 'NO-GO'); assert.equal(p.verdict_disagreement, true);
  assert.equal(p.review.date, 'round two, date unknown');
  assert.equal(p.history.items[1].time.value, raw.data.history.items[1].time.value);
  assert.equal(p.history.items[0].actor.value, null);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_COPY|pipeline_root|pipeline_task|source_index.*event:/);
  assert.ok(parseProjectCatalog(result));
  const profiled = await generateSnapshot(cfg(root, [source]), { rosterPipelineCLI: cli, catalogVersion: 2, profile: 'followup/1' });
  assert.equal(profiled.schema_version, 2);
  assert.deepEqual(profiled.projects[0].sources[0].summary, observed.summary);
});

async function observePipeline(root, raw, other = []) {
  const cli = await executable(root, `console.log(${JSON.stringify(JSON.stringify(raw))});`);
  return generateSnapshot(cfg(root, [{ id: 'pipeline', kind: 'roster', label: 'Pipeline', pipeline_root: root, pipeline_task: 'release-check' }, ...other]), { rosterPipelineCLI: cli });
}
const realPipelineEntry = process.env.MESH_I1_ROSTER_ENTRY
  ? join(dirname(process.env.MESH_I1_ROSTER_ENTRY), 'roster-pipeline.cjs') : undefined;
test('pinned public Roster pipeline producer roundtrips findings, unknown outcomes and retry history', {
  skip: !realPipelineEntry && !process.env.MESH_I1_ROSTER_BOARD
    ? 'real producer requires the explicit MESH_I1_ROSTER_ENTRY public distribution' : false,
}, async t => {
  assert.ok(realPipelineEntry, 'required qualification needs the explicit pinned public Roster entry');
  assert.equal(createHash('sha256').update(await readFile(realPipelineEntry)).digest('hex'),
    '3e6f50db89d438b341e16fb2f65321d7b81b0ed6fcc5a307547ce9f3fb650462', 'public Roster 757bf97 producer must match the qualified pin');
  const root = await fixture(t), briefs = join(root, 'briefs'), task = 'release-check'; await mkdir(briefs);
  const ledger = join(briefs, `${task}-state.json`), review = join(briefs, `${task}-review.json`);
  const events = [
    { phase: 'review', outcome: 'NO-GO' },
    { phase: 'implement', outcome: 'COMPLETED', by: 'worker', at: '2026-11-14T10:00:00Z', reason: 'Corrected failed review' },
    // The router accepts an outcome subarray; the public display projection
    // deliberately reports its non-scalar outcome as unknown, never as GO.
    { phase: 'review', outcome: ['GO'], by: {}, at: 'not a date' },
  ];
  const writeLedger = entries => writeFile(ledger, JSON.stringify({task, mode: 'fast', current_phase: 'review', events: entries}));
  await writeLedger(events);
  await writeFile(review, JSON.stringify({task, status: 'NO-GO', findings: Array.from({length: 101}, (_, index) =>
    ({severity: 'high', summary: `Actual provider finding ${index}`, status: 'open'})), rounds_audit: [
    {round: 1, verdict: 'NO-GO', qualifying: true, causes: ['Original failure']},
  ]}));
  const raw = JSON.parse(execFileSync(process.execPath, [realPipelineEntry, 'show', '--root', root, '--task', task, '--history-limit', '50'], {encoding: 'utf8'}));
  assert.equal(raw.schema.id, 'https://github.com/mathiasbourgoin/roster/schema/pipeline-observation/v1');
  assert.equal(raw.data.components.review.value.findings.items[0].summary, 'Actual provider finding 0');
  assert.equal(raw.data.latest_completed.outcome, null);
  const config = cfg(root, [{id: 'real-pipeline', kind: 'roster', label: 'Real pipeline', pipeline_root: root, pipeline_task: task}]);
  const observe = () => generateSnapshot(config, {rosterPipelineCLI: realPipelineEntry});
  const catalog = await observe(), source = catalog.projects[0].sources[0];
  assert.equal(source.status, 'available', JSON.stringify(source));
  const p = source.summary.pipeline;
  assert.equal(p.review.findings.items[0].description, 'Actual provider finding 0');
  assert.equal(p.review.findings.total, 101); assert.equal(p.review.findings.items.length, 100); assert.equal(p.review.findings.truncated, true);
  assert.deepEqual(p.history.items.map(e => e.outcome), ['NO-GO', 'COMPLETED', null]);
  assert.equal(p.latest_completed.outcome, null); assert.equal(p.review.status, 'NO-GO');
  assert.deepEqual(p.history.items[2].actor, {availability: 'unknown', value: null, truncated: false});
  assert.deepEqual(p.history.items[2].time, {availability: 'unknown', value: null});
  assert.equal(p.components.spec.availability, 'absent'); assert.ok(parseProjectCatalog(catalog));
  const unknown = structuredClone(catalog); delete unknown.projects[0].sources[0].summary.pipeline.latest_completed.outcome;
  assert.equal(parseProjectCatalog(unknown), null, 'missing outcome is not an explicit unknown');
  const wrong = structuredClone(raw); wrong.schema.id = 'https://roster.dev/schema/pipeline-observation/v1';
  assert.equal((await observePipeline(root, wrong)).projects[0].sources[0].error_code, 'invalid-output');
  await writeFile(review, '{');
  const invalid = (await observe()).projects[0].sources[0];
  assert.equal(invalid.status, 'available'); assert.equal(invalid.summary.pipeline.components.review.availability, 'invalid');
  assert.equal(invalid.summary.pipeline.review, null);
  await writeLedger(Array.from({length: 205}, (_, i) => i === 204 ? events[2] : {phase: 'review', outcome: 'NO-GO'}));
  const history = (await observe()).projects[0].sources[0].summary.pipeline;
  assert.equal(history.history.total, 205); assert.equal(history.history.items.length, 50); assert.equal(history.history.truncated, true);
  assert.equal(history.latest_completed.outcome, null);
  for (const outcome of ['SKIPPED', 'BOUNCED']) {
    await writeFile(ledger, JSON.stringify({task, mode: 'full', current_phase: 'spec', events: [{phase: 'spec', outcome}]}));
    const observed = (await observe()).projects[0].sources[0];
    assert.equal(observed.status, 'available', JSON.stringify(observed));
    assert.deepEqual(observed.summary.pipeline.latest_completed, {phase: 'spec', outcome});
    assert.equal(observed.summary.pipeline.history.items[0].outcome, outcome);
    assert.equal(observed.summary.pipeline.review, null);
    assert.equal(observed.summary.global_accepted, undefined, 'recorded skipped/bounced specification is not acceptance');
  }
});
test('pipeline envelope and cross-field contradictions fail per source while other references survive', async t => {
  const root = await fixture(t);
  const cases = [
    r => { r.root += '/wrong'; }, r => { r.data.task = 'wrong'; }, r => { r.kind = 'pipeline-list'; },
    r => { r.schema_version = 2; }, r => { r.schema.id = 'https://example.com/wrong'; },
    r => { r.schema.id = 'https://roster.dev/schema/pipeline-observation/v1'; }, r => { r.schema.digest = 'wrong'; },
    r => { delete r.data.components.manifest; }, r => { r.data.components.extra = r.data.components.manifest; },
    r => { r.data.availability = 'absent'; }, r => { r.data.components.review.value = null; },
    r => { r.data.components.review.digest = null; }, r => { r.data.components.intake.value = {}; },
    r => { r.data.history.items[0].id = 'event:9'; }, r => { r.data.history.items[0].source_index = -1; },
    r => { r.data.history.total = 1; }, r => { r.data.components.ledger.value.history_total = 3; },
    r => { r.data.history.truncated = true; }, r => { r.data.latest_completed.outcome = 'PARTIAL'; },
    r => { r.data.history.items[0].actor.value = 'not unknown'; }, r => { r.data.history.items[1].time.value = null; },
    r => { r.data.history.items[0].reason_truncated = true; }, r => { r.data.components.review.value.date = '\u0001'; },
    r => { r.data.verdict_disagreement = false; }, r => { r.coverage[0].availability = 'supported'; },
  ];
  for (const [index, change] of cases.entries()) {
    const raw = pipelineObservation(root); change(raw);
    const c = await observePipeline(root, raw, [{ id: 'reference', kind: 'other', label: 'Reference' }]);
    assert.equal(c.projects[0].sources[0].error_code, 'invalid-output', `invalid case ${index}`);
    assert.equal(c.projects[0].sources[1].status, 'unconfigured');
  }
});
test('pipeline invalid or absent components remain evidence rather than provider failure', async t => {
  const root = await fixture(t), raw = pipelineObservation(root);
  Object.assign(raw.data.components.ledger, { availability: 'invalid', value: null, reason: 'domain', digest: 'd'.repeat(64) });
  Object.assign(raw.data, { mode: null, latest_completed: null, history: { items: [], total: null, next_cursor: null, truncated: false } });
  raw.data.components.review.truncated = true;
  raw.data.components.review.value.findings = { items: [], total: null, truncated: false };
  const c = await observePipeline(root, raw), summary = c.projects[0].sources[0].summary;
  assert.equal(c.projects[0].sources[0].status, 'available');
  assert.equal(summary.pipeline.components.ledger.availability, 'invalid');
  assert.equal(summary.pipeline.history.total, null); assert.equal(summary.pipeline.review.status, 'GO');
  assert.equal(summary.pipeline.review.findings.total, null); assert.equal(summary.truncated, true);
  for (const component of Object.values(raw.data.components)) Object.assign(component, { availability: 'absent', reason: null, digest: null, value: null, truncated: false });
  Object.assign(raw.data, { availability: 'absent', verdict_disagreement: null });
  const absent = await observePipeline(root, raw);
  assert.equal(absent.projects[0].sources[0].status, 'available');
  assert.equal(absent.projects[0].sources[0].summary.pipeline.availability, 'absent');
});
test('pipeline first page preserves independent latest and report-list truncation', async t => {
  const root = await fixture(t), raw = pipelineObservation(root);
  const event = raw.data.history.items[0];
  raw.data.history.items = Array.from({ length: 50 }, (_, i) => ({ ...event, id: `event:${i}`, source_index: i }));
  raw.data.history.total = 51; raw.data.history.truncated = true; raw.data.components.ledger.value.history_total = 51;
  const findings = raw.data.components.review.value.findings;
  findings.items = Array.from({ length: 100 }, () => findings.items[0]); findings.total = 101; findings.truncated = true;
  raw.data.components.review.truncated = true;
  const c = await observePipeline(root, raw), p = c.projects[0].sources[0].summary.pipeline;
  assert.equal(p.history.items.length, 50); assert.equal(p.history.total, 51); assert.equal(p.latest_completed.phase, 'implement');
  assert.equal(p.history.items.at(-1).phase, 'review'); assert.equal(p.review.findings.items.length, 100); assert.equal(p.review.findings.total, 101);
});
test('canonical reported integers stay recorded data without widening counts or event indexes', async t => {
  const root = await fixture(t), raw = pipelineObservation(root);
  Object.assign(raw.data.components.qa_state.value, { round: -1, cycle: -2, qa_no_go_round: -3 });
  raw.data.components.review.value.rounds_audit.items[0].round = -4;
  const c = await observePipeline(root, raw), p = c.projects[0].sources[0].summary.pipeline;
  assert.equal(p.qa.round,-1);assert.equal(p.qa.cycle,-2);assert.equal(p.qa.qa_no_go_round,-3);assert.equal(p.review.rounds_audit.items[0].round,-4);
});
test('crafted pipeline catalogs cannot bypass normalized variant or evidence invariants', async t => {
  const root = await fixture(t), c = await observePipeline(root, pipelineObservation(root));
  for (const change of [
    s => { s.global_accepted = true; }, s => { s.counts.total = 0; }, s => { s.items.push({ id: 'fake', title: 'Fake', state: 'done' }); },
    s => { s.pipeline.review.findings.items[0].path = '/DO_NOT_COPY'; }, s => { s.pipeline.history.items[0].source_index = 9; },
    s => { s.pipeline.review = null; }, s => { s.pipeline.qa_markdown_status = 'GO'; s.pipeline.qa.status = 'GO'; },
    s => { s.truncated = true; }, s => { delete s.source_generated_at; }, s => { s.source_revision = 'unverified'; },
  ]) {
    const copy = structuredClone(c); change(copy.projects[0].sources[0].summary);
    assert.equal(parseProjectCatalog(copy), null);
  }
});
test('pipeline root protection refuses publication before any source launch and preserves prior output', async t => {
  const root = await fixture(t), log = join(root, 'launches'), config = join(root, 'config.json'), output = join(root, 'catalog.json');
  const cli = await executable(root, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(log)},'launched');`);
  await writeFile(config, JSON.stringify(cfg(root, [{ id: 'board', kind: 'roster', label: 'Board', board_path: join(root, 'board') }, { id: 'pipeline', kind: 'roster', label: 'Pipeline', pipeline_root: root, pipeline_task: 'release-check' }])));
  await writeFile(output, 'previous');
  await assert.rejects(main(['--config', config, '--output', output, '--roster-pipeline-cli', cli, '--roster-cli', cli]));
  assert.equal(await readFile(output, 'utf8'), 'previous'); await assert.rejects(readFile(log), e => e.code === 'ENOENT');
});
test('a later invalid pipeline locator prevents earlier valid providers from launching', async t => {
  const root = await fixture(t), config = join(root, 'config.json'), log = join(root, 'launches');
  const cli = await executable(root, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(log)},'launched');`);
  const c = { kind: 'mesh-project-config', schema_version: 1, machine_id: 'host', projects: [{ id: 'one', title: 'One', sessions: [], sources: [
    { id: 'board', kind: 'roster', label: 'Board', board_path: root },
    { id: 'pipeline', kind: 'roster', label: 'Pipeline', pipeline_root: root },
  ] }] };
  await writeFile(config, JSON.stringify(c));
  await assert.rejects(main(['--config', config, '--roster-cli', cli, '--roster-pipeline-cli', cli]));
  await assert.rejects(readFile(log), e => e.code === 'ENOENT');
});
test('pipeline per-source refusal publishes unavailable status beside fresh successful observations', async t => {
  const root = await fixture(t), raw = pipelineObservation(root), config = join(root, 'config.json'), output = join(root, 'catalog.json');
  const board = join(root, 'board'), pipelineRoot = join(root, 'pipeline'); await mkdir(board); await mkdir(pipelineRoot);
  raw.root = pipelineRoot; raw.data.task = 'wrong';
  const pipelineCLI = await executable(root, `console.log(${JSON.stringify(JSON.stringify(raw))});`);
  const roadmapCLI = await executable(root, `console.log(JSON.stringify({kind:'roster-roadmap-view',schema_version:1,generated_at:'2026-11-14T00:00:00Z',version:'fresh',goal:'Changed',phase:'active',counts:{},completion:{},global:{accepted:false},tasks:[]}));`);
  await writeFile(config, JSON.stringify(cfg(root, [{ id: 'pipeline', kind: 'roster', label: 'Pipeline', pipeline_root: pipelineRoot, pipeline_task: 'release-check' }, { id: 'roadmap', kind: 'roster', label: 'Roadmap', board_path: board }])));
  await writeFile(output, 'previous');
  await main(['--config', config, '--output', output, '--roster-pipeline-cli', pipelineCLI, '--roster-cli', roadmapCLI]);
  const c = parseProjectCatalog(await readFile(output, 'utf8'));
  assert.equal(c.projects[0].sources[0].error_code, 'invalid-output'); assert.equal(c.projects[0].sources[1].summary.goal, 'Changed');
});
test('large pipeline summaries still refuse aggregate publication before retaining every response', async t => {
  const root = await fixture(t), pipelineRoot = join(root, 'observed'); await mkdir(pipelineRoot);
  const raw = pipelineObservation(pipelineRoot), payload = join(root, 'payload.json'), log = join(root, 'starts');
  for (const name of ['review','qa_state']) {
    const report = raw.data.components[name].value;
    report.findings = { items: Array.from({ length: 100 }, () => ({ severity: 'high', summary: 'd'.repeat(1500), status: 'open', specialist: 's'.repeat(1500) })), total: 100, truncated: false };
    report.rounds_audit = { items: Array.from({ length: 100 }, (_, i) => ({ round: i, date: 'recorded date', verdict: 'NO-GO', qualifying: false, causes: 'c'.repeat(1500) })), total: 100, truncated: false };
  }
  await writeFile(payload, JSON.stringify(raw));
  const cli = await executable(root, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(log)},'x');process.stdout.write(fs.readFileSync(${JSON.stringify(payload)}));`);
  const sources = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, kind: 'roster', label: 'Pipeline', pipeline_root: pipelineRoot, pipeline_task: 'release-check' }));
  const single = await generateSnapshot(cfg(root, sources.slice(0,1)), { rosterPipelineCLI: cli });
  assert.equal(single.projects[0].sources[0].status, 'available');
  await writeFile(log, '');const config = join(root, 'config.json'), output = join(root, 'catalog.json');
  await writeFile(config, JSON.stringify(cfg(root, sources)));await writeFile(output, 'previous');
  await assert.rejects(main(['--config', config, '--output', output, '--roster-pipeline-cli', cli]), /catalog-limit/);
  assert.ok((await readFile(log,'utf8')).length < sources.length,'aggregate refusal stops remaining launches');
  assert.equal(await readFile(output,'utf8'),'previous');assert.deepEqual((await readdir(root)).filter(name=>name.includes('.tmp')),[]);
});

// I1 collector joins retain the inherited snapshot predicates above.
import { parseObservationInput, parseObservationOutput } from "../static/project-observation-contract.ts";
import { collectObservation } from "../tools/project-observation.ts";
function observationInput(sources = [], repository = undefined, plan = { repository: false, source_ids: [] }) {
  return { kind: "mesh-project-observation-input", version: 1, observation_id: "a".repeat(64), boot: "b".repeat(64),
    scope: { machine_id: "host", project_id: "one", captured_revision: "cfg1_" + "c".repeat(64) }, plan,
    config: { kind: "mesh-project-config", schema_version: 2, features: ["project-metadata/1"], machine_id: "host",
      projects: [{ id: "one", title: "One", sources, sessions: [{ name: "fractional", created: 12.375 }], ...(repository ? { repository } : {}) }] }, profile: "metadata-followup/1" };
}
test("I1 closed collector rejects raw duplicate, executable, plan and scope mutations", async () => {
  const value = observationInput(); assert.ok(parseObservationInput(JSON.stringify(value)));
  assert.equal(parseObservationInput(JSON.stringify(value).replace(`"version":1`, `"version":1,"version":1`)), null);
  for (const mutate of [v => { v.executable = "/usr/bin/node"; }, v => { v.argv = []; }, v => { v.cancel_token = "d".repeat(64); },
    v => { v.scope.machine_id = "other"; }, v => { v.scope.project_id = "other"; }, v => { v.plan.source_ids = ["missing"]; },
    v => { v.plan.repository = true; }, v => { v.profile = "other"; }, v => { v.config.projects.push(v.config.projects[0]); }]) {
    const changed = structuredClone(value); mutate(changed); assert.equal(parseObservationInput(changed), null);
    await assert.rejects(collectObservation(changed), /collector-invalid/);
  }
  const output = await collectObservation(value); assert.equal(output.result.state, "complete");
  assert.ok(parseObservationOutput(JSON.stringify(output), parseObservationInput(value)));
  const catalog = output.result.catalog;
  assert.equal(catalog.projects[0].sessions[0].created, 12.375);
  assert.deepEqual(catalog.features, ["project-metadata/1", "roster-followup/1"]);
  for (const mutate of [v => { v.settlement.providers_closed = false; }, v => { v.settlement.provider_pipes_closed = false; },
    v => { v.result.catalog.features.pop(); }, v => { v.scope.captured_revision = "cfg1_" + "d".repeat(64); },
    v => { v.result.catalog.projects[0].id = "other"; }, v => { v.result.code = "rawstderr"; }]) {
    const changed = structuredClone(output); mutate(changed); assert.equal(parseObservationOutput(changed, parseObservationInput(value)), null);
  }
});
test("I1 disabled selectors and repository plan never invoke inspection; missing provider stays source local", async t => {
  const root = await fixture(t), marker = join(root, "must-not-exist");
  const cli = await executable(root, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)},"spawned"); process.exit(7);`);
  const sources = [{ id: "disabled", kind: "roster", label: "Disabled", board_path: root }, { id: "missing", kind: "roster", label: "Missing", board_path: root }];
  const output = await collectObservation(observationInput(sources, { url: "https://example.com/repo", local_path: join(root, "absent") }, { repository: false, source_ids: ["missing"] }));
  assert.equal(output.result.state, "complete");
  assert.deepEqual(output.result.catalog.projects[0].sources.map(s => [s.status, s.error_code]), [["unconfigured", undefined], ["unavailable", "missing-executable"]]);
  assert.equal(output.result.catalog.projects[0].repository.observation.reason, "inspection-disabled");
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const disabled = await collectObservation(observationInput(sources), { rosterCLI: cli });
  assert.equal(disabled.result.state, "complete"); await assert.rejects(stat(marker), { code: "ENOENT" });
});
test("I1 cancellation waits for actual delayed child termination and pipe drain before witness", async t => {
  const root = await fixture(t), ready = join(root, "ready"), closed = join(root, "closed");
  // Ready must mean the delayed-termination handler is installed, not merely that Node started.
  const cli = await executable(root, `import fs from "node:fs";
    process.on("SIGTERM",()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(closed)},"done");process.exit(0)},180)});setInterval(()=>{},1000);
    fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));`);
  const controller = new AbortController(); let settled = false;
  const pending = collectObservation(observationInput([{ id: "one", kind: "roster", label: "One", board_path: root }], undefined, { repository: false, source_ids: ["one"] }),
    { rosterCLI: cli, signal: controller.signal }).then(output => { settled = true; return output; });
  for (let i = 0; i < 100; i++) { try { await stat(ready); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
  const pid = Number(await readFile(ready, "utf8")); controller.abort();
  await new Promise(r => setTimeout(r, 50)); assert.equal(settled, false); process.kill(pid, 0);
  const output = await pending; assert.equal(await readFile(closed, "utf8"), "done");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(output.result, { state: "cancelled", code: "cancelled" });
  assert.deepEqual(output.settlement, { providers_closed: true, provider_pipes_closed: true });
});
test("I1 strict selected catalog admits the complete 2MiB payload without shrinking for envelope metadata", async () => {
  const output = await collectObservation(observationInput()); assert.equal(output.result.state, "complete");
  const catalog = output.result.catalog, project = catalog.projects[0];
  project.sources = Array.from({ length: 20 }, (_, s) => ({ id: `s${s}`, kind: "roster", label: "Source", status: "available", observed_at: catalog.generated_at,
    summary: { provider_schema: "roster-roadmap-view", provider_version: 1, counts: {}, items: Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`.padEnd(80, "x"), title: "x", state: "s".repeat(40), checks: [{ id: "c".repeat(30), accepted_status: "a".repeat(30), reported_status: "r".repeat(30) }] })), truncated: false, more: 0 } }));
  let missing = 2097152 - Buffer.byteLength(JSON.stringify(catalog));
  assert.ok(missing > 0 && missing < 20 * 200 * 239);
  for (const source of project.sources) for (const item of source.summary.items) {
    const count = Math.min(missing, 239); item.title += "x".repeat(count); missing -= count;
  }
  assert.equal(missing, 0); assert.equal(Buffer.byteLength(JSON.stringify(catalog)), 2097152);
  const envelope = JSON.stringify(output); assert.ok(Buffer.byteLength(envelope) > 2097152);
  assert.ok(parseObservationOutput(envelope, parseObservationInput(observationInput())));
  project.sources[0].summary.items[0].title = "x".repeat(241);
  assert.equal(parseObservationOutput(JSON.stringify(output)), null);
});
test("I1 direct exit with an escaped pipe holder cannot create an early settlement witness", async t => {
  const root = await fixture(t), childReady = join(root, "pipe-owner"), directReady = join(root, "direct");
  const pipeBody = `require("node:fs").writeFileSync(${JSON.stringify(childReady)},String(process.pid));setTimeout(()=>process.exit(0),450);`;
  const cli = await executable(root, `import {spawn} from "node:child_process";import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(directReady)},String(process.pid));process.on("SIGTERM",()=>process.exit(0));
    spawn(process.execPath,["-e",${JSON.stringify(pipeBody)}],{detached:true,stdio:["ignore",1,2]}).unref();setInterval(()=>{},1000);`);
  const controller = new AbortController(); let settled = false;
  const pending = collectObservation(observationInput([{id:"r",kind:"roster",label:"R",board_path:root}], undefined, {repository:false,source_ids:["r"]}),
    {rosterCLI:cli,signal:controller.signal}).then(output => { settled = true; return output; });
  for (let i = 0; i < 200; i++) { try { await stat(childReady); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
  const direct = Number(await readFile(directReady,"utf8")), pipeOwner = Number(await readFile(childReady,"utf8")); controller.abort();
  await new Promise(r => setTimeout(r, 100)); assert.throws(() => process.kill(direct,0),{code:"ESRCH"});
  process.kill(pipeOwner,0); assert.equal(settled,false);
  const output = await pending; assert.equal(output.result.state,"cancelled"); assert.equal(output.settlement.provider_pipes_closed,true);
});
test("I1 collector joins real cached Git evidence and bounded followup in one selected catalog", async t => {
  const root = await fixture(t), repo = join(root,"repo"); await mkdir(repo);
  const git = args => execFileSync("/usr/bin/git",["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git(["init","-b","main"]); git(["config","user.name","Collector fixture"]); git(["config","user.email","fixture@example.invalid"]);
  await writeFile(join(repo,"README.md"),"# Selected README\n"); git(["add","README.md"]); git(["commit","-m","fixture"]);
  const cli = await executable(root, `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["view",${JSON.stringify(root)},"--events","100"]))process.exit(3);console.log(${JSON.stringify(JSON.stringify(roadmapObservation([roadmapTask()])))})`);
  const input = observationInput([{id:"r",kind:"roster",label:"R",board_path:root}],{url:"https://example.com/repo",local_path:repo,primary_ref:"refs/heads/main"},{repository:true,source_ids:["r"]});
  const output = await collectObservation(input,{rosterCLI:cli}); assert.equal(output.result.state,"complete");
  const selected = output.result.catalog.projects[0]; assert.equal(selected.repository.observation.commit,git(["rev-parse","HEAD"]));
  assert.equal(selected.repository.observation.readme.text,"# Selected README\n");
  assert.equal(selected.sources[0].status,"available"); assert.equal(selected.sources[0].summary.followup.metadata.value.board_id,"delivery");
  assert.doesNotMatch(JSON.stringify(output),/local_path|primary_ref|board_path|pipeline_root|pipeline_task/);
});

import { build } from "esbuild";
test("I1 compiled startup collector uses stdin only and emits a witnessed envelope after real close", async t => {
  const root = await fixture(t), entry = join(root, "project-observation.mjs");
  await build({entryPoints:[new URL("../tools/project-observation.ts",import.meta.url).pathname],outfile:entry,bundle:true,platform:"node",format:"esm",target:"es2022"});
  const invoke = (input, args = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath,[entry,...args],{env:{...process.env,MESH_PROJECT_ROSTER_CLI:"",MESH_PROJECT_ROSTER_PIPELINE_CLI:""},stdio:["pipe","pipe","pipe"]});
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data",s => { stdout += s; assert.ok(Buffer.byteLength(stdout)<=2097152+8192); });
    child.stderr.on("data",s=>{stderr+=s;assert.ok(Buffer.byteLength(stderr)<=65536);});
    child.on("error",reject); child.on("close",(code,signal)=>resolve({code,signal,stdout,stderr})); child.stdin.end(input);
  });
  const value = observationInput(), ok = await invoke(JSON.stringify(value)); assert.equal(ok.code,0); assert.equal(ok.signal,null); assert.equal(ok.stderr,"");
  const envelope = parseObservationOutput(ok.stdout,parseObservationInput(value)); assert.equal(envelope.result.state,"complete");
  for (const [raw,args] of [["{",[]],[JSON.stringify(value).replace('"version":1','"version":1,"version":1'),[]],[JSON.stringify(value),["--config","/must-not-read"]]]) {
    const refused = await invoke(raw,args); assert.equal(refused.code,1); assert.equal(refused.stdout,""); assert.match(refused.stderr,/project-observation: refused/);
    assert.doesNotMatch(refused.stderr,/must-not-read|captured_revision|stack|SyntaxError/);
  }
});
test("I1 deadline cannot settle a provider that ignores termination until its real exit", async t => {
  const root = await fixture(t), ready = join(root,"uncooperative");
  const cli = await executable(root, `import fs from "node:fs";process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),1600);`);
  let settled = false;
  const pending = collectObservation(observationInput([{id:"r",kind:"roster",label:"R",board_path:root}],undefined,{repository:false,source_ids:["r"]}),
    {rosterCLI:cli,runMs:1000,providerMs:5000}).then(output=>{settled=true;return output;});
  for(let i=0;i<200;i++){try{await stat(ready);break;}catch{await new Promise(r=>setTimeout(r,5));}}
  const pid=Number(await readFile(ready,"utf8"));
  await new Promise(r=>setTimeout(r,1100));assert.equal(settled,false);process.kill(pid,0);
  const output=await pending;assert.deepEqual(output.result,{state:"cancelled",code:"deadline"});
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});assert.equal(output.settlement.providers_closed,true);
});

test('operator request text preserves the genuine 501-unit question and 2000-unit public limit', async t => {
  const root = await fixture(t), board = join(root, 'board'); await mkdir(board);
  const genuineQuestion = "Exact project-to-live-session opening needs an expected identity sent to the native attach_if/attach_bound primitive. Current owner WebSocket bridge (also final8b) sends only the session name, so a same-name replacement race remains. Allow a limited change to the two existing Python adapters, with no new Python file, or retain zero additional Python and defer exact live opening until a native HTTP/WebSocket bridge exists? This blocks that VD implementation choice only; VC qualification continues.";
  assert.equal(genuineQuestion.length, 501);
  const view = text => ({kind:'roster-roadmap-view',schema_version:1,generated_at:'2026-11-16T00:00:00Z',version:'v1',
    goal:'Deliver',phase:'active',counts:{active:1},completion:{},global:{accepted:false},
    tasks:[{id:'task',objective:'Task',state:'active',attempts:1,depends_on:[],checks:[]}],
    operator_requests:{status:'valid',counts:{answered:1},items:[{id:'ask',text,status:'answered'}]}});
  for (const text of [genuineQuestion, 'é'.repeat(2000)]) {
    const cli = await executable(root, `console.log(JSON.stringify(${JSON.stringify(view(text))}));`);
    const catalog = await generateSnapshot(cfg(root, [
      {id:'r2',kind:'roster',label:'R2',board_path:board}, {id:'r3',kind:'roster',label:'R3',board_path:board}
    ]), {rosterCLI:cli,catalogVersion:2,followup:true});
    assert.deepEqual(catalog.projects[0].sources.map(source => source.status), ['available','available']);
    for (const source of catalog.projects[0].sources) assert.equal(source.summary.operator_requests[0].title, text);
    const decoded = parseProjectCatalog(JSON.stringify(catalog)); assert.ok(decoded);
    assert.equal(decoded.projects[0].sources[1].summary.operator_requests[0].title, text);
  }
  const invalidBoard = join(root, 'invalid-board'); await mkdir(invalidBoard);
  const mixedCLI = await executable(root, `console.log(JSON.stringify(process.argv[3] === ${JSON.stringify(invalidBoard)} ?
    ${JSON.stringify(view('x'.repeat(2001)))} : ${JSON.stringify(view(genuineQuestion))}));`);
  const mixed = await generateSnapshot(cfg(root, [
    {id:'r2',kind:'roster',label:'R2',board_path:board}, {id:'r3',kind:'roster',label:'R3',board_path:invalidBoard}
  ]), {rosterCLI:mixedCLI});
  assert.deepEqual(mixed.projects[0].sources.map(source => source.status), ['available','unavailable']);
  assert.equal(mixed.projects[0].sources[0].summary.operator_requests[0].title, genuineQuestion);
  assert.equal(mixed.projects[0].sources[1].error_code, 'invalid-output');
  assert.ok(parseProjectCatalog(JSON.stringify(mixed)));
  assert.throws(() => normalizeProvider('roster', view('x'.repeat(2001))));
  const longTask = view('Valid request'); longTask.tasks[0].objective = 'x'.repeat(241);
  assert.throws(() => normalizeProvider('roster', longTask), 'task titles keep their separate 240-unit bound');
});
