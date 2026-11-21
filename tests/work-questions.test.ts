// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure parts of the Questions surfaces of the Projects view (static/work-questions.ts) and the parsing of the
// unscoped `resume` document they read (static/work-parse.ts). The surfaces themselves run in
// tests/work-questions-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseOpenQuestions, parseProject } from '../static/work-parse.ts';
import {
  aboutKind, ageOf, counterText, formatAge, groupProjectQuestions, orderQuestions, readOpenQuestions, withoutQuestion,
} from '../static/work-questions.ts';
import type { WorkResult } from '../static/work-api.ts';
import type { OpenQuestionsDoc, Question, TaskRow } from '../static/work-types.ts';

const question = (id: string, about: string | null, askedAt: string | null, open = true): Question => ({
  id, open, text: `Question ${id}?`, options: [], assumption: null, about, askedBy: null, askedByAgent: null, askedBySession: null,
  askedAt, answers: [], ownerAnswered: false,
});

const taskRow = (id: string, title: string): TaskRow => {
  const doc = parseProject({ project: { id: 'P-0a0a', title: 'Fictional', product: 'demo' }, tasks: [{ id, title, status: 'todo' }] });
  assert.ok(doc);
  return doc.tasks[0]!;
};

describe('what a question is about', () => {
  test('a task, a project, or nothing; an unexpected reference counts as nothing', () => {
    assert.equal(aboutKind('T-1a2b'), 'task');
    assert.equal(aboutKind('P-5e6f'), 'project');
    assert.equal(aboutKind(null), 'none');
    assert.equal(aboutKind('N-0001'), 'none');
    assert.equal(aboutKind('t-1a2b'), 'task', 'the reader may keep a lower-case prefix');
  });
});

describe('ordering and grouping', () => {
  test('open questions first, then answered ones, each newest first; an undated one goes last of its group', () => {
    const list = [question('a', null, '2026-11-01T00:00:00Z', false), question('b', null, '2026-11-02T00:00:00Z'),
      question('c', null, null), question('d', null, '2026-11-05T00:00:00Z'), question('e', null, '2026-11-09T00:00:00Z', false)];
    assert.deepEqual(orderQuestions(list).map(q => q.id), ['d', 'b', 'c', 'e', 'a']);
  });

  test('the project tab groups by task, the task with the newest open question first, and "without a task" last', () => {
    const tasks = [taskRow('T-0001', 'First task'), taskRow('T-0002', 'Second task')];
    const groups = groupProjectQuestions([
      question('q1', 'T-0001', '2026-11-01T00:00:00Z'),
      question('q2', 'T-0002', '2026-11-03T00:00:00Z'),
      question('q3', 'P-0a0a', '2026-11-04T00:00:00Z'),
      question('q4', 'T-0003', '2026-11-05T00:00:00Z', false),
      question('q5', 'T-0001', '2026-11-02T00:00:00Z', false),
    ], tasks);
    assert.deepEqual(groups.map(group => group.task), ['T-0002', 'T-0001', 'T-0003', null]);
    assert.deepEqual(groups.map(group => group.title), ['Second task', 'First task', null, null], 'a task not listed has no title');
    assert.deepEqual(groups[1]!.questions.map(q => q.id), ['q1', 'q5'], 'open before answered inside a group');
    assert.deepEqual(groups[3]!.questions.map(q => q.id), ['q3']);
  });

  test('no questions, no groups', () => {
    assert.deepEqual(groupProjectQuestions([], []), []);
  });
});

describe('the list kept after a failed read again', () => {
  test('loses the question just answered and one from its total; anything else is the same document', () => {
    const doc = { openQuestions: 30, questions: [question('a', null, null), question('b', 'T-0001', null)], omitted: 28, truncated: true };
    assert.deepEqual(withoutQuestion(doc, 'a'), { ...doc, openQuestions: 29, questions: [doc.questions[1]] });
    assert.equal(withoutQuestion(doc, 'z'), doc, 'a question not listed changes nothing');
    assert.equal(withoutQuestion(doc, null), doc);
    const small = { openQuestions: 1, questions: [question('a', null, null)], omitted: 0, truncated: false };
    assert.equal(withoutQuestion(small, 'a').openQuestions, 0);
  });
});

describe('age and counter', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  test('the age is in whole minutes, hours or days, never negative, null without a date', () => {
    assert.deepEqual(ageOf('2026-11-10T11:58:30Z', now), { value: 1, unit: 'minute' });
    assert.deepEqual(ageOf('2026-11-10T09:00:00Z', now), { value: 3, unit: 'hour' });
    assert.deepEqual(ageOf('2026-11-07T11:00:00Z', now), { value: 3, unit: 'day' });
    assert.deepEqual(ageOf('2026-11-11T00:00:00Z', now), { value: 0, unit: 'minute' }, 'a clock ahead reads as now');
    assert.equal(ageOf(null, now), null);
    assert.equal(ageOf('not a date', now), null);
  });

  test('the age reads in the interface language', () => {
    assert.equal(formatAge({ value: 3, unit: 'day' }, 'en'), '3 days ago');
    assert.equal(formatAge({ value: 3, unit: 'day' }, 'fr'), 'il y a 3 jours');
    assert.equal(formatAge({ value: 1, unit: 'day' }, 'en'), 'yesterday');
    assert.ok(formatAge({ value: 2, unit: 'hour' }, 'not a locale!').length > 0, 'a bad locale falls back');
  });

  test('the badge shows nothing at zero or when unknown, the count up to 99, then 99+', () => {
    assert.equal(counterText(null), '');
    assert.equal(counterText(0), '');
    assert.equal(counterText(-2), '');
    assert.equal(counterText(Number.NaN), '');
    assert.equal(counterText(1), '1');
    assert.equal(counterText(99), '99');
    assert.equal(counterText(100), '99+');
  });
});

describe('parseOpenQuestions', () => {
  test('keeps the open questions with who asked them, the total and what was left out', () => {
    const doc = parseOpenQuestions({
      schema: 1, command: 'resume', in_progress: [], open_questions: 23, questions_omitted: 3, truncated: true,
      questions: [
        { id: 'N-1', state: 'open', text: '<b>Port?</b>', about: 'T-0001', asked_by_agent: 'claude', asked_by_session: 'asking', asked_at: '2026-11-01T00:00:00Z',
          assumption: 'use 8443', options: ['8443', 9], answers: [] },
        { id: 'N-2', state: 'answered', text: 'not open' }, { text: 'no id' }, 'junk',
      ],
    });
    assert.ok(doc);
    assert.equal(doc.openQuestions, 23);
    assert.equal(doc.omitted, 3);
    assert.equal(doc.truncated, true);
    assert.deepEqual(doc.questions.map(q => q.id), ['N-1']);
    const [first] = doc.questions;
    assert.equal(first!.text, '<b>Port?</b>', 'kept as written; the view makes it text');
    assert.equal(first!.askedByAgent, 'claude');
    assert.equal(first!.askedBySession, 'asking');
    assert.equal(first!.askedBy, 'asking');
    assert.equal(first!.assumption, 'use 8443');
    assert.deepEqual(first!.options, ['8443']);
  });

  test('the total is never below the questions listed; a document without a list is refused', () => {
    assert.equal(parseOpenQuestions({ questions: [{ id: 'N-1', text: 'x' }] })!.openQuestions, 1);
    for (const bad of [null, [], {}, { questions: 'no' }, { open_questions: 3 }]) assert.equal(parseOpenQuestions(bad), null);
  });
});

describe('reading more open questions than one read gives', () => {
  // A fictional server of `total` open questions, oldest first, at most 100 a read, as work-read's `open-questions`.
  const server = (total: number, fail: number | null = null) => {
    const all = Array.from({ length: total }, (_, index) => question(`N-${String(index).padStart(4, '0')}`, null, null));
    const pages: Array<{ after?: string; limit: number }> = [];
    const read = async (page: { after?: string; limit: number }): Promise<WorkResult<OpenQuestionsDoc>> => {
      pages.push(page);
      if (pages.length === fail) return { ok: false, error: { kind: 'busy' } } as WorkResult<OpenQuestionsDoc>;
      const start = page.after ? all.findIndex(item => item.id === page.after) + 1 : 0;
      const questions = all.slice(start, start + Math.min(page.limit, 100));
      return { ok: true, value: { openQuestions: total, questions, omitted: total - start - questions.length, truncated: false } };
    };
    return { read, pages };
  };

  test('the oldest questions up to the number wanted, a page of at most 100 at a time, each once', async () => {
    const { read, pages } = server(130);
    const result = await readOpenQuestions(read, 120);
    assert.ok(result.ok);
    assert.equal(result.value.questions.length, 120, 'the 120 the list shows, past one read');
    assert.equal(new Set(result.value.questions.map(item => item.id)).size, 120);
    assert.equal(result.value.openQuestions, 130);
    assert.deepEqual(pages, [{ limit: 100 }, { after: 'N-0099', limit: 20 }]);
  });

  test('fewer open than wanted, a single page, or a failed page', async () => {
    const few = server(7);
    const result = await readOpenQuestions(few.read, 120);
    assert.ok(result.ok);
    assert.equal(result.value.questions.length, 7);
    assert.equal(few.pages.length, 1, 'no read past the last question');
    const one = server(50);
    assert.equal((await readOpenQuestions(one.read, 20)).ok, true);
    assert.deepEqual(one.pages, [{ limit: 20 }]);
    assert.equal((await readOpenQuestions(server(150, 2).read, 120)).ok, false, 'a failed page fails the read');
  });
});
