// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Defensive parsing and pure derivations of the Projects view (work-parse.ts, work-derive.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseProducts, parseProject, parseProjects, parseTask } from '../static/work-parse.ts';
import {
  axisPercent, axisSide, buildFrise, dependencyLevels, entryTree, progressPercent,
} from '../static/work-derive.ts';

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Task ${id}`, status: 'todo', priority: 'P1', product: 'relay', created: '2026-11-01T00:00:00Z', ...extra });

describe('parseProducts and parseProjects', () => {
  test('keep what is well formed, ignore unknown fields, tolerate missing ones', () => {
    const doc = parseProducts({
      schema: 1, mystery: { a: 1 }, truncated: false,
      categories: [
        { key: 'platform', name: 'Platform', products: [
          { id: 'relay', open: 1, done: 2, tree: { open: 3, done: 2, progress: 0.4 }, projects: 1, no_project_open: 2, extra: true },
          { id: 'relay-edge', parent: 'relay' }, { nope: 1 }, 'text', null, { id: 7 },
        ] },
        'broken',
      ],
    });
    assert.ok(doc);
    assert.equal(doc.categories.length, 1);
    const [relay, edge] = doc.categories[0]!.products;
    assert.deepEqual(relay!.tree, { open: 3, done: 2, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: 0.4 });
    assert.equal(relay!.noProjectOpen, 2);
    assert.equal(edge!.parent, 'relay');
    assert.equal(edge!.own.progress, null);
  });

  test('refuse a document of the wrong shape', () => {
    for (const bad of [null, 5, 'x', [], {}, { categories: 'no' }]) assert.equal(parseProducts(bad), null);
    for (const bad of [null, [], {}, { projects: {} }]) assert.equal(parseProjects(bad), null);
  });

  test('clamp numbers: negatives and NaN are zero, progress stays in 0..1', () => {
    const doc = parseProjects({ projects: [{ id: 'P-1a', open: -4, done: Number.NaN, progress: 7 }], no_project: [{ product: 'x', open: 2 }, {}] });
    assert.ok(doc);
    assert.deepEqual(doc.projects[0]!.counts, { open: 0, done: 0, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: 1 });
    assert.equal(doc.noProject.length, 1);
    assert.equal(doc.total, 1);
  });
});

describe('parseProject', () => {
  const full = {
    project: { id: 'P-5e6f', title: 'Rollout', product: 'relay', milestones: ['m1', 3], open_tasks: 2 },
    tasks: [row('T-1a2b', { blocked_by: ['T-3c4d', 9] }), { title: 'no id' }, row('T-3c4d', { done_at: '2026-11-05T00:00:00Z' })],
    columns: { todo: ['T-3c4d'], in_progress: ['T-1a2b', 4], blocked: 'x' },
    dependencies: [{ from: 'T-1a2b', to: 'T-3c4d', state: 'weird' }, { from: 'T-1a2b' }],
    reprise: { in_progress: [row('T-1a2b', { days_since_activity: 3, open_blockers: [{ id: 'B-1', text: 'wait' }] })], stale: 'no' },
    open_questions: 1, questions: [{ id: 'N-1', text: 'Which?', state: 'open', options: ['a', 2] }, { id: 'N-2' }],
    timeline: [{ at: '2026-11-01T00:00:00Z', task: 'T-1a2b', type: 'note', text: 'hello', prov: 'inferred', nested: { a: 1 } }, { x: 1 }],
    tasks_omitted: 12, dependencies_omitted: 0, truncated: true,
  };

  test('parses rows, columns, dependencies, reprise, questions and events; drops the rest', () => {
    const doc = parseProject(full);
    assert.ok(doc);
    assert.deepEqual(doc.tasks.map(task => task.id), ['T-1a2b', 'T-3c4d']);
    assert.deepEqual(doc.tasks[0]!.blockedBy, ['T-3c4d']);
    assert.deepEqual(doc.columns, { todo: ['T-3c4d'], inProgress: ['T-1a2b'], blocked: [], done: [], other: [] });
    assert.deepEqual(doc.dependencies.map(edge => [edge.from, edge.to, edge.state]), [['T-1a2b', 'T-3c4d', 'unknown']]);
    assert.equal(doc.reprise.inProgress[0]!.daysSinceActivity, 3);
    assert.equal(doc.reprise.inProgress[0]!.openBlockers[0]!.text, 'wait');
    assert.deepEqual(doc.reprise.stale, []);
    assert.deepEqual(doc.questions.map(q => [q.id, q.options]), [['N-1', ['a']]]);
    assert.equal(doc.timeline.length, 1);
    assert.equal(doc.timeline[0]!.prov, 'inferred');
    assert.deepEqual(doc.timeline[0]!.fields, [['text', 'hello']]);
  });

  test('reports omitted counts and the truncation marker', () => {
    const doc = parseProject({ ...full, reprise: { ...full.reprise, in_progress_omitted: 4 } });
    assert.ok(doc);
    assert.equal(doc.truncated, true);
    assert.deepEqual(doc.omitted, { tasks: 12, 'reprise.in_progress': 4 });
  });

  test('reads the fields added by the reviewed backend: dependency_open_tasks, columns.other, columns_omitted', () => {
    const doc = parseProject({
      project: { id: 'P-0a', blocked_tasks: 1, dependency_open_tasks: 2 },
      tasks: [row('T-0001', { status: 'weird' })],
      columns: { todo: [], in_progress: [], blocked: [], done: [], other: ['T-0001'] },
      columns_omitted: { todo: 7, other: 0, in_progress: 'x', blocked: 2 },
      questions_omitted: 5, truncated: true,
    });
    assert.ok(doc);
    assert.equal(doc.project.dependencyOpenTasks, 2);
    assert.deepEqual(doc.columns.other, ['T-0001']);
    assert.deepEqual(doc.omitted, { questions: 5, 'columns.todo': 7, 'columns.blocked': 2 });
    assert.equal(parseProjects({ projects: [{ id: 'P-1a', dependency_open_tasks: 3 }] })!.projects[0]!.counts.dependencyOpenTasks, 3);
  });

  test('refuses a project without an id and tolerates one with nothing else', () => {
    assert.equal(parseProject({ project: {} }), null);
    assert.equal(parseProject({ tasks: [] }), null);
    const minimal = parseProject({ project: { id: 'P-0a' } });
    assert.ok(minimal);
    assert.equal(minimal.project.title, 'P-0a');
    assert.deepEqual(minimal.tasks, []);
    assert.deepEqual(minimal.columns, { todo: [], inProgress: [], blocked: [], done: [], other: [] });
  });

  test('keeps hostile strings verbatim: the view shows them as text, the model does not rewrite them', () => {
    const hostile = '<script>alert(1)</script>‮evil';
    const doc = parseProject({ project: { id: 'P-0a', title: hostile }, tasks: [row('T-0a0a', { title: hostile })] });
    assert.equal(doc?.project.title, hostile);
    assert.equal(doc?.tasks[0]?.title, hostile);
  });
});

describe('parseTask', () => {
  test('parses the detail: blockers, targets with states, sessions, events with provenance, questions', () => {
    const detail = parseTask({
      task: row('T-3c4d', { tags: ['a', 1], links: ['https://example.test'], category: 'platform', origin: 'reactive' }),
      project: { id: 'P-5e6f', title: 'Rollout' }, notes: 'some notes', resolved_blockers: 2,
      open_blockers: [{ id: 'B-1', kind: 'external', text: 'wait', on: 'office', opened: '2026-11-03T00:00:00Z' }],
      blocked_by: [{ id: 'T-1', state: 'finished', title: 'First', status: 'done' }, { id: 'T-2', state: 'nonsense' }, {}],
      blocking: [{ id: 'T-9', state: 'open' }],
      sessions: [{ name: 's-old', agent: 'claude', branch: 'feat/x', repo: null, last_activity: '2026-11-03T09:02:00Z' }, { agent: 'x' }],
      timeline: [{ at: '2026-11-03T09:03:00Z', task: 'T-3c4d', type: 'blocker', text: 'wait', on: 'office', prov: 'confirmed' },
        { at: 'x', task: 'T-3c4d', type: 'x', prov: 'made-up' }],
      open_questions: 1, questions: [{ id: 'N-1', text: 'Q?', state: 'answered' }], truncated: false, timeline_omitted: 3,
    });
    assert.ok(detail);
    assert.equal(detail.projectTitle, 'Rollout');
    assert.deepEqual(detail.tags, ['a']);
    assert.deepEqual(detail.blockedBy.map(ref => [ref.id, ref.state]), [['T-1', 'finished'], ['T-2', 'unknown']]);
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0]!.repo, null);
    assert.deepEqual(detail.timeline.map(event => event.prov), ['confirmed', null]);
    assert.equal(detail.questions[0]!.open, false);
    assert.deepEqual(detail.omitted, { timeline: 3 });
  });

  test('parses the answers of a question: text, who, when, relaying session; drops malformed ones', () => {
    const detail = parseTask({
      task: row('T-3c4d'),
      questions: [
        { id: 'N-0000a001', text: 'Which port?', state: 'answered', answers: [
          { text: '8443', by: 'owner', at: '2026-11-19T10:00:00Z', relayed_by_session: 's-1', relayed_by_agent: 'claude', superseded: true },
          { text: 'later', by: 7, relayed_by_agent: 'codex', owner_verified: 'yes' }, { by: 'owner' }, 'nonsense',
          { text: '8080', by: 'owner', at: '2026-11-19T11:00:00Z', owner_verified: true }] },
        { id: 'N-0000a002', text: 'Open?', state: 'open', answers: 'nonsense' },
      ],
    });
    assert.ok(detail);
    const [answered, open] = detail.questions;
    assert.deepEqual(answered!.answers, [
      { text: '8443', by: 'owner', at: '2026-11-19T10:00:00Z', relayedBy: 's-1', ownerVerified: false, superseded: true },
      // The agent kind is not a session: without a relaying session, none is named. Only true marks verification.
      { text: 'later', by: null, at: null, relayedBy: null, ownerVerified: false, superseded: false },
      { text: '8080', by: 'owner', at: '2026-11-19T11:00:00Z', relayedBy: null, ownerVerified: true, superseded: false },
    ]);
    assert.equal(open!.open, true);
    assert.deepEqual(open!.answers, []);
  });

  test('refuses a document with no task', () => {
    for (const bad of [null, {}, { task: 'x' }, { task: {} }]) assert.equal(parseTask(bad), null);
  });
});

describe('parseProject hostile values', () => {
  test('an object where a provenance word is expected is ignored, not a throw', () => {
    const doc = parseProject({ project: { id: 'P-0a' }, timeline: [{ at: '2026-11-01T00:00:00Z', task: 'T-1', type: 'note', prov: { toString: 1 } }, { type: 'note', prov: ['x'] }] });
    assert.ok(doc);
    assert.deepEqual(doc.timeline.map(event => event.prov), [null, null]);
  });
});

describe('derivations', () => {
  test('progress is done over open plus done rounded down, absent without tasks', () => {
    assert.equal(progressPercent({ open: 7, done: 5, blockedTasks: 0, blockers: 0, progress: null }), 41);
    assert.equal(progressPercent({ open: 0, done: 0, blockedTasks: 0, blockers: 0, progress: null }), null);
  });

  test('entryTree nests a child under its listed parent and attaches projects and the no-project line', () => {
    const products = parseProducts({ categories: [{ key: 'p', name: 'P', products: [
      { id: 'relay' }, { id: 'relay-edge', parent: 'relay' }, { id: 'orphan', parent: 'missing' }, { id: 'loop-a', parent: 'loop-b' }, { id: 'loop-b', parent: 'loop-a' },
    ] }] })!;
    const projects = parseProjects({ projects: [{ id: 'P-1a', product: 'relay' }], no_project: [{ product: 'relay-edge', open: 2 }] })!;
    const tree = entryTree(products, projects);
    const top = tree[0]!.products;
    assert.deepEqual(top.map(node => node.product.id), ['relay', 'orphan']);
    assert.equal(top[0]!.projects[0]!.id, 'P-1a');
    assert.equal(top[0]!.children[0]!.noProject?.counts.open, 2);
  });

  test('frise: a bar from creation to done or today, markers for due and eta, no bar without dates', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [
      row('T-0001', { created: '2026-11-01T00:00:00Z', due: '2026-11-20', eta: '2026-11-15' }),
      row('T-0002', { status: 'done', created: '2026-11-02T00:00:00Z', done_at: '2026-11-04T00:00:00Z' }),
      row('T-0003', { created: 'garbage' }),
    ] })!;
    const frise = buildFrise(doc.tasks, now);
    const byId = new Map(frise.rows.map(entry => [entry.task.id, entry]));
    assert.equal(byId.get('T-0001')!.end, now);
    assert.equal(byId.get('T-0002')!.end, Date.parse('2026-11-04T00:00:00Z'));
    assert.equal(byId.get('T-0003')!.start, null);
    assert.equal(byId.get('T-0003')!.end, null);
    assert.equal(frise.max, Date.parse('2026-11-20'));
    assert.equal(axisPercent(frise, frise.min), 0);
    assert.equal(axisPercent(frise, frise.max), 100);
    assert.ok(axisPercent(frise, now) > 0 && axisPercent(frise, now) < 100);
    assert.equal(frise.rows[frise.rows.length - 1]!.task.id, 'T-0003');
  });

  test('frise: a task with no valid date has no bar and no marker, and an empty list does not break the axis', () => {
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [row('T-0001', { created: null, due: 'soon' })] })!;
    const frise = buildFrise(doc.tasks, 1_000);
    assert.deepEqual([frise.rows[0]!.start, frise.rows[0]!.due, frise.rows[0]!.eta], [null, null, null]);
    assert.equal(axisPercent(buildFrise([], 5), 5), 0);
  });

  test('dependency levels: waiting on nothing is level 0, one more than the deepest target after, cycles terminate', () => {
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [row('T-a'), row('T-b'), row('T-c')], dependencies: [
      { from: 'T-b', to: 'T-a', state: 'open', to_in_project: true },
      { from: 'T-c', to: 'T-b', state: 'open', to_in_project: true },
      { from: 'T-c', to: 'T-x', state: 'finished', to_title: 'External', to_in_project: false },
    ] })!;
    const levels = dependencyLevels(doc.dependencies, doc.tasks);
    assert.deepEqual(levels.map(entry => [entry.level, entry.nodes.map(node => node.id)]), [[0, ['T-a', 'T-x']], [1, ['T-b']], [2, ['T-c']]]);
    const external = levels[0]!.nodes.find(node => node.id === 'T-x')!;
    assert.equal(external.inProject, false);
    assert.equal(external.state, 'finished');
    assert.equal(external.title, 'External');
    const cycle = parseProject({ project: { id: 'P-0a' }, dependencies: [{ from: 'T-a', to: 'T-b' }, { from: 'T-b', to: 'T-a' }] })!;
    assert.ok(dependencyLevels(cycle.dependencies, []).length >= 1);
  });
  for (const size of [5000, 20000]) {
    test(`dependency levels: a chain of ${size} tasks does not overflow the stack and levels count up`, () => {
      const edges = Array.from({ length: size - 1 }, (_, i) => ({ from: `T-${i + 1}`, to: `T-${i}`, state: 'open' as const,
        toTitle: null, toStatus: null, toInProject: true }));
      const levels = dependencyLevels(edges, []);
      assert.equal(levels.length, size);
      assert.equal(levels[size - 1]!.level, size - 1);
      assert.deepEqual(levels[size - 1]!.nodes.map(node => node.id), [`T-${size - 1}`]);
      assert.ok(levels.every(entry => !entry.cycle));
    });
    test(`dependency levels: a ring of ${size} tasks is one cycle group`, () => {
      const edges = Array.from({ length: size }, (_, i) => ({ from: `T-${i}`, to: `T-${(i + 1) % size}`, state: 'open' as const,
        toTitle: null, toStatus: null, toInProject: true }));
      const levels = dependencyLevels(edges, []);
      assert.equal(levels.length, 1);
      assert.equal(levels[0]!.cycle, true);
      assert.equal(levels[0]!.nodes.length, size);
    });
  }
  test('dependency levels: a cycle with a tail and a dependent keeps its groups apart', () => {
    const edge = (from: string, to: string) => ({ from, to, state: 'open' as const, toTitle: null, toStatus: null, toInProject: true });
    const levels = dependencyLevels([edge('T-a', 'T-b'), edge('T-b', 'T-a'), edge('T-b', 'T-t'), edge('T-d', 'T-a')], []);
    assert.deepEqual(levels.map(entry => [entry.level, entry.cycle, entry.nodes.map(node => node.id)]),
      [[0, true, ['T-a', 'T-b']], [0, false, ['T-t']], [1, false, ['T-d']]]);
  });
  test('parseProject keeps at most 300 dependency edges, as the server does', () => {
    const dependencies = Array.from({ length: 450 }, (_, i) => ({ from: `T-${i + 1}`, to: `T-${i}` }));
    assert.equal(parseProject({ project: { id: 'P-0a' }, dependencies })!.dependencies.length, 300);
  });
  test('progress rounds down: 199 done of 200 is not 100 percent', () => {
    assert.equal(progressPercent({ open: 1, done: 199, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: null }), 99);
    assert.equal(progressPercent({ open: 0, done: 4, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: null }), 100);
  });

  test('frise: a dropped task, or a done one with no done date, has no length to today', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [
      row('T-0001', { status: 'dropped', created: '2026-11-01T00:00:00Z' }),
      row('T-0002', { status: 'done', created: '2026-11-02T00:00:00Z' }),
    ] })!;
    for (const entry of buildFrise(doc.tasks, now).rows) assert.equal(entry.end, entry.start, entry.task.id);
  });

  test('frise: a 1970 date and a 2099 date do not flatten the axis; they sit at its edge and are flagged', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [
      row('T-0001', { created: '2026-11-01T00:00:00Z', due: '2099-12-31' }),
      row('T-0002', { created: '1970-01-01T00:00:00Z' }),
      row('T-0003', { created: '2026-10-01T00:00:00Z' }),
    ] })!;
    const frise = buildFrise(doc.tasks, now);
    assert.equal(frise.min, Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(frise.max, now);
    const byId = new Map(frise.rows.map(entry => [entry.task.id, entry]));
    assert.equal(axisPercent(frise, byId.get('T-0001')!.due!), 100);
    assert.equal(axisSide(frise, byId.get('T-0001')!.due!), 1);
    assert.equal(axisSide(frise, byId.get('T-0002')!.start!), -1);
    assert.equal(axisSide(frise, byId.get('T-0003')!.start!), 0);
    assert.ok(axisPercent(frise, byId.get('T-0001')!.start!) > 50, 'a normal bar keeps its place on the axis');
  });

  test('dependency cycle: its tasks form a labelled group before level 0, and what waits on them comes after', () => {
    const doc = parseProject({ project: { id: 'P-0a' }, tasks: [row('T-a'), row('T-b'), row('T-c'), row('T-d')], dependencies: [
      { from: 'T-a', to: 'T-b' }, { from: 'T-b', to: 'T-a' }, { from: 'T-c', to: 'T-a' }, { from: 'T-d', to: 'T-d' }, { from: 'T-c', to: 'T-e' },
    ] })!;
    const levels = dependencyLevels(doc.dependencies, doc.tasks);
    assert.deepEqual(levels.map(entry => [entry.cycle, entry.level, entry.nodes.map(node => node.id)]),
      [[true, 0, ['T-a', 'T-b', 'T-d']], [false, 0, ['T-e']], [false, 1, ['T-c']]]);
  });
});
