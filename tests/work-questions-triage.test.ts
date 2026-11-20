// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The classification of the open questions of the entry screen (static/work-questions-triage.ts) and the parsing of
// the `context` that `resume` gives each question (static/work-parse.ts). The section itself runs in
// tests/work-questions-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseOpenQuestions } from '../static/work-parse.ts';
import { isAttached, isLongText, oldestFirst, questionKind, triageQuestions } from '../static/work-questions-triage.ts';
import type { Question, QuestionContext } from '../static/work-types.ts';

type Extra = Partial<{ options: string[]; session: string | null; agent: string | null; context: Partial<QuestionContext> }>;

const context = (part: Partial<QuestionContext>): QuestionContext => ({
  taskTitle: null, project: null, projectTitle: null, product: null, category: null, ...part,
});

const question = (id: string, about: string | null, askedAt: string | null, extra: Extra = {}): Question => ({
  id, open: true, text: `Question ${id}?`, options: extra.options ?? [], assumption: null, about, askedBy: null,
  askedByAgent: extra.agent ?? null, askedBySession: extra.session === undefined ? 'asker' : extra.session, askedAt,
  answers: [], ownerAnswered: false, ...(extra.context ? { context: context(extra.context) } : {}),
});

const ZONES = [{ key: 'atlas', name: 'Atlas' }, { key: 'home', name: 'Home' }];
const inTask = (task: string, title: string, project: string | null, product: string, category: string | null): Extra =>
  ({ context: { taskTitle: title, project, projectTitle: project ? `Project ${project}` : null, product, category } });

describe('the kind of a question', () => {
  test('options offered make it a choice; none, an open question', () => {
    assert.equal(questionKind(question('a', 'T-0001', null, { options: ['keep', 'drop'] })), 'choice');
    assert.equal(questionKind(question('b', 'T-0001', null)), 'open');
  });
});

describe('order and attachment', () => {
  test('the oldest first, an undated question last, stable between equal dates', () => {
    const list = [question('c', null, '2026-11-03T00:00:00Z'), question('u', null, null), question('a', null, '2026-11-01T00:00:00Z'),
      question('b1', null, '2026-11-02T00:00:00Z'), question('b2', null, '2026-11-02T00:00:00Z')];
    assert.deepEqual(oldestFirst(list).map(q => q.id), ['a', 'b1', 'b2', 'c', 'u']);
  });

  test('a question about a task or a project is attached; about nothing or a question id, it is not', () => {
    assert.equal(isAttached(question('a', 'T-0001', null)), true);
    assert.equal(isAttached(question('b', 'P-0001', null)), true);
    assert.equal(isAttached(question('c', null, null)), false);
    assert.equal(isAttached(question('d', 'N-0000abcd', null)), false);
  });
});

describe('the classification', () => {
  const list = [
    question('home-old', 'T-0005', '2026-09-01T00:00:00Z', inTask('T-0005', 'Paint the fence', null, 'garden', 'home')),
    question('atlas-new', 'T-0001', '2026-11-05T00:00:00Z', inTask('T-0001', 'Ship it', 'P-0001', 'relay', 'atlas')),
    question('atlas-old', 'T-0002', '2026-11-02T00:00:00Z', inTask('T-0002', 'Book it', 'P-0001', 'relay', 'atlas')),
    question('atlas-same-task', 'T-0001', '2026-11-03T00:00:00Z', inTask('T-0001', 'Ship it', 'P-0001', 'relay', 'atlas')),
    question('atlas-project', 'P-0001', '2026-11-04T00:00:00Z', { context: { project: 'P-0001', projectTitle: 'Project P-0001', product: 'relay', category: 'atlas' } }),
    question('atlas-gateway', 'T-0003', '2026-11-06T00:00:00Z', inTask('T-0003', 'Open the gate', 'P-0002', 'gateway', 'atlas')),
    question('lone-1', null, '2026-11-02T00:00:00Z', { session: 'session-b' }),
    question('lone-2', null, '2026-11-01T00:00:00Z', { session: 'session-a' }),
    question('lone-3', null, '2026-11-03T00:00:00Z', { session: 'session-b' }),
    question('lone-agent', null, '2026-11-04T00:00:00Z', { session: null, agent: 'codex' }),
    question('unknown-zone', 'T-0009', '2026-10-01T00:00:00Z'),
    question('other-zone', 'T-0008', '2026-10-02T00:00:00Z', inTask('T-0008', 'Elsewhere', null, 'misc', 'zzz')),
    { ...question('answered', 'T-0001', '2026-10-01T00:00:00Z', inTask('T-0001', 'Ship it', 'P-0001', 'relay', 'atlas')), open: false },
  ];
  const triage = triageQuestions(list, ZONES, id => (id === 'P-0009' ? 'Named elsewhere' : null));

  test('zones follow the taxonomy, an unlisted category after them, an unknown one last; answered questions are left out', () => {
    assert.deepEqual(triage.zones.map(zone => [zone.key, zone.name, zone.count]),
      [['atlas', 'Atlas', 5], ['home', 'Home', 1], ['zzz', 'zzz', 1], [null, null, 1]]);
  });

  test('inside a zone: products, projects and tasks, each group of the oldest question first, the oldest first inside', () => {
    const atlas = triage.zones[0]!;
    assert.deepEqual(atlas.products.map(product => [product.product, product.count]), [['relay', 4], ['gateway', 1]]);
    const relay = atlas.products[0]!;
    assert.deepEqual(relay.projects.map(project => [project.project, project.title, project.count]), [['P-0001', 'Project P-0001', 4]]);
    const tasks = relay.projects[0]!.tasks;
    assert.deepEqual(tasks.map(task => [task.task, task.title, task.questions.map(q => q.id)]), [
      ['T-0002', 'Book it', ['atlas-old']],
      ['T-0001', 'Ship it', ['atlas-same-task', 'atlas-new']],
      [null, null, ['atlas-project']],
    ]);
  });

  test('a task in no project stands under a project group named null', () => {
    const home = triage.zones[1]!;
    assert.deepEqual(home.products[0]!.projects.map(project => [project.project, project.title]), [[null, null]]);
    assert.equal(home.products[0]!.projects[0]!.tasks[0]!.title, 'Paint the fence');
  });

  test('a question without a context still stands, in the unknown zone, product and project', () => {
    const unknown = triage.zones[3]!;
    assert.deepEqual(unknown.products.map(product => product.product), [null]);
    assert.deepEqual(unknown.products[0]!.projects[0]!.tasks.map(task => [task.task, task.title]), [['T-0009', null]]);
  });

  test('a project the context does not name is named by the entry list', () => {
    const named = triageQuestions([question('x', 'P-0009', null)], ZONES, id => (id === 'P-0009' ? 'Named elsewhere' : null));
    assert.equal(named.zones[0]!.products[0]!.projects[0]!.title, 'Named elsewhere');
  });

  test('unattached questions are grouped by the session that asked them, the session of the oldest question first', () => {
    assert.equal(triage.unattachedCount, 4);
    assert.deepEqual(triage.unattached.map(group => [group.session, group.questions.map(q => q.id)]),
      [['session-a', ['lone-2']], ['session-b', ['lone-1', 'lone-3']], ['codex', ['lone-agent']]]);
  });

  test('nothing to classify: no zone, no session', () => {
    assert.deepEqual(triageQuestions([], ZONES), { zones: [], unattached: [], unattachedCount: 0 });
  });
});

// The folded or open state of the section is kept with the rest of the view's state (tests/work-view-state.test.ts).
describe('long texts', () => {
  test('a text is long past 280 characters (code points) or 4 lines', () => {
    assert.equal(isLongText('a'.repeat(280)), false);
    assert.equal(isLongText('a'.repeat(281)), true);
    assert.equal(isLongText('😀'.repeat(200)), false, 'counted in characters, not UTF-16 units');
    assert.equal(isLongText('1\n2\n3\n4'), false);
    assert.equal(isLongText('1\n2\n3\n4\n5'), true);
  });
});

describe('the context of the questions of resume', () => {
  test('parsed when present, absent when empty or not an object; text fields only', () => {
    const doc = parseOpenQuestions({ open_questions: 3, questions: [
      { id: 'N-00000001', state: 'open', text: 'a?', about: 'T-0001',
        context: { task_title: 'Ship it', project: 'P-0001', project_title: 'Rollout', product: 'relay', category: 'atlas' } },
      { id: 'N-00000002', state: 'open', text: 'b?', context: {} },
      { id: 'N-00000003', state: 'open', text: 'c?', about: 'T-0002', context: { task_title: 7, product: 'relay' } },
      { id: 'N-00000004', state: 'open', text: 'd?', context: 'nope' },
    ] });
    assert.ok(doc);
    assert.deepEqual(doc.questions[0]!.context,
      { taskTitle: 'Ship it', project: 'P-0001', projectTitle: 'Rollout', product: 'relay', category: 'atlas' });
    assert.equal('context' in doc.questions[1]!, false);
    assert.deepEqual(doc.questions[2]!.context, { taskTitle: null, project: null, projectTitle: null, product: 'relay', category: null });
    assert.equal('context' in doc.questions[3]!, false);
  });
});
