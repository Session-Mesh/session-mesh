// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure parts of the answer choices (static/work-answer-options.ts): the kind of a question as the view reads it,
// the choices offered, the answer text and choices sent, the prefill of an edit; the parser of the kind and of the
// choices of an answer; the write op's arguments; a correction sent through the view's answer path. The form itself
// runs in tests/work-answer-options-browser.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_OPTION, MAX_OPTIONS, MULTI_SEPARATOR, composeAnswer, currentOwnerAnswer, earlierAnswers, effectiveKind, offeredChoices,
  prefillOf,
} from '../static/work-answer-options.ts';
import { localFailure } from '../static/work-answer-form.ts';
import { createWorkApi, readSlots } from '../static/work-api.ts';
import type { WorkApi } from '../static/work-api.ts';
import { sendAnswer } from '../static/work-view-answer.ts';
import type { AnswerHost } from '../static/work-view-answer.ts';
import { parseTask } from '../static/work-parse.ts';
import type { Answer, Question } from '../static/work-types.ts';

const HOSTILE = '<img src=x onerror=alert(1)> & "quoted" ‮';

const answer = (text: string, extra: Partial<Answer> = {}): Answer =>
  ({ text, by: 'owner', at: null, relayedBy: null, ownerVerified: false, superseded: false, choices: [], ...extra });
const question = (extra: Partial<Question> = {}): Question => ({
  id: 'N-0000a000', open: true, text: 'Which?', options: [], kind: 'text', assumption: null, about: null, askedBy: null,
  askedByAgent: null, askedBySession: null, askedAt: null, answers: [], ownerAnswered: false, ...extra,
});

test('the kind: the stored one when it fits the options, else single with options and text without', () => {
  assert.equal(effectiveKind(undefined, []), 'text');
  assert.equal(effectiveKind(undefined, ['a']), 'single');
  assert.equal(effectiveKind('multi', ['a', 'b']), 'multi');
  assert.equal(effectiveKind('multi', []), 'text', 'multi without options has nothing to pick');
  assert.equal(effectiveKind('single', []), 'text');
  assert.equal(effectiveKind('yes_no', []), 'yes_no');
  // text and yes_no take no options: with some (a hand-written line), they do not fit and read as single, as the
  // readers of the tracker say (Work_questions.effective_kind), so the view and the server agree on the kind.
  assert.equal(effectiveKind('yes_no', ['a']), 'single');
  assert.equal(effectiveKind('text', ['a']), 'single');
  assert.equal(effectiveKind('ranking', ['a']), 'single', 'a kind of a later version falls back');
  assert.equal(effectiveKind('ranking', []), 'text');
  assert.equal(effectiveKind(3, ['a']), 'single');
  assert.equal(effectiveKind('__proto__', []), 'text');
});

test('the choices offered: distinct options of at most 100 characters, eight at most; yes and no; none for text', () => {
  const many = Array.from({ length: 12 }, (_, index) => `option ${index}`);
  assert.deepEqual(offeredChoices('single', many), many.slice(0, MAX_OPTIONS));
  assert.deepEqual(offeredChoices('multi', ['a', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(offeredChoices('single', ['x'.repeat(MAX_OPTION + 1), 'ok']), ['ok'], 'an option over the bound is not offered');
  assert.deepEqual(offeredChoices('single', ['\u{1F600}'.repeat(MAX_OPTION)]), ['\u{1F600}'.repeat(MAX_OPTION)], 'the bound counts characters');
  assert.deepEqual(offeredChoices('single', ['', '  ', 'a']), ['a'], 'a blank option is not offered');
  assert.deepEqual(offeredChoices('yes_no', []), ['yes', 'no']);
  assert.deepEqual(offeredChoices('text', ['a']), []);
  assert.deepEqual(offeredChoices('single', [HOSTILE]), [HOSTILE], 'option text is kept as written');
});

test('a single choice is sent while the field still holds its label; free text alone sends no choice', () => {
  assert.deepEqual(composeAnswer('single', ['gRPC'], 'gRPC'), { text: 'gRPC', choices: ['gRPC'] });
  assert.deepEqual(composeAnswer('single', ['gRPC'], '  gRPC '), { text: '  gRPC ', choices: ['gRPC'] });
  assert.deepEqual(composeAnswer('single', ['gRPC'], 'gRPC, but internal only'), { text: 'gRPC, but internal only', choices: [] });
  assert.deepEqual(composeAnswer('single', [], 'my own answer'), { text: 'my own answer', choices: [] });
  const label = (choice: string): string => (choice === 'yes' ? 'Oui' : 'Non');
  assert.deepEqual(composeAnswer('yes_no', ['yes'], 'Oui', label), { text: 'Oui', choices: ['yes'] });
  assert.deepEqual(composeAnswer('yes_no', ['no'], 'Non, pas encore', label), { text: 'Non, pas encore', choices: [] });
  assert.deepEqual(composeAnswer('text', ['a'], 'free'), { text: 'free', choices: [] }, 'a text question sends no choice');
  assert.deepEqual(composeAnswer('single', [HOSTILE], HOSTILE), { text: HOSTILE, choices: [HOSTILE] });
});

test('several choices are joined one per line, in the order of the options, with the free text last', () => {
  assert.equal(MULTI_SEPARATOR, '\n');
  assert.deepEqual(composeAnswer('multi', ['REST', 'GraphQL'], ''), { text: 'REST\nGraphQL', choices: ['REST', 'GraphQL'] });
  assert.deepEqual(composeAnswer('multi', ['REST'], '  and a note  '), { text: 'REST\nand a note', choices: ['REST'] });
  assert.deepEqual(composeAnswer('multi', [], 'only text'), { text: 'only text', choices: [] });
  assert.equal(localFailure(composeAnswer('multi', [], '   ').text), 'empty', 'nothing picked and nothing written');
  assert.equal(localFailure(composeAnswer('multi', [HOSTILE], '').text), null);
});

test('the current owner answer, the earlier ones, and the prefill of an edit', () => {
  const relayed = answer('relayed', { superseded: true });
  const first = answer('REST\nfirst note', { ownerVerified: true, superseded: true, choices: ['REST'] });
  const latest = answer('REST\nGraphQL\nlater note', { ownerVerified: true, choices: ['REST', 'GraphQL'] });
  const multi = question({ kind: 'multi', options: ['REST', 'gRPC', 'GraphQL'], open: false, ownerAnswered: true, answers: [relayed, first, latest] });
  assert.equal(currentOwnerAnswer(multi.answers), latest);
  assert.deepEqual(earlierAnswers(multi.answers), [relayed, first]);
  assert.deepEqual(prefillOf(multi), { text: 'later note', picked: ['REST', 'GraphQL'] });
  const single = question({ kind: 'single', options: ['a', 'b'], answers: [answer('b', { ownerVerified: true, choices: ['b'] })] });
  assert.deepEqual(prefillOf(single), { text: 'b', picked: ['b'] });
  // Choices that are no longer options (an edited question, a hand-written line) are not picked again.
  const stale = question({ kind: 'single', options: ['a'], answers: [answer('z', { ownerVerified: true, choices: ['z'] })] });
  assert.deepEqual(prefillOf(stale), { text: 'z', picked: [] });
  assert.deepEqual(prefillOf(question({ ownerAnswered: true })), { text: '', picked: [] }, 'the owner answer was cut from the list');
  assert.equal(currentOwnerAnswer([relayed]), null);
  assert.deepEqual(earlierAnswers([relayed]), [], 'with no owner answer, nothing is folded away');
});

test('the reader\'s kind and choices are parsed; anything else falls back', () => {
  const task = parseTask({ task: { id: 'T-1a2b', title: 'T', status: 'todo' }, questions: [
    { id: 'N-0000a001', state: 'open', text: 'Q1', options: ['a', 'b'], kind: 'multi', answers: [] },
    { id: 'N-0000a002', state: 'open', text: 'Q2', options: ['a'], kind: 'ranking', answers: [] },
    { id: 'N-0000a003', state: 'open', text: 'Q3', answers: [] },
    { id: 'N-0000a004', state: 'answered', text: 'Q4', options: ['a', 'b'], kind: 'single',
      answers: [{ text: 'a', by: 'owner', at: '2026-11-10T00:00:00Z', owner_verified: true, choices: ['a', 7, null] }] },
  ] });
  assert.ok(task);
  assert.deepEqual(task.questions.map(q => q.kind), ['multi', 'single', 'text', 'single']);
  assert.deepEqual(task.questions[3]!.answers[0]!.choices, ['a'], 'only strings are kept');
});

test('the write op sends edit and choices only when given, so an older work-write still takes a plain answer', async () => {
  const bodies: unknown[] = [];
  const api = createWorkApi(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'N-0000a000', owner_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, undefined, { slots: readSlots(2), busyDelays: [] });
  await api.answer('N-0000a000', 'plain');
  await api.answer('N-0000a000', 'REST\nGraphQL', { edit: true, choices: ['REST', 'GraphQL'] });
  await api.answer('N-0000a000', 'free', { edit: false, choices: [] });
  assert.deepEqual(bodies, [
    { op: 'answer', args: { question: 'N-0000a000', text: 'plain' } },
    { op: 'answer', args: { question: 'N-0000a000', text: 'REST\nGraphQL', edit: true, choices: ['REST', 'GraphQL'] } },
    { op: 'answer', args: { question: 'N-0000a000', text: 'free' } },
  ]);
});

test('a correction goes through the answer path: sent with edit and choices, the question published as answered, its notice', async () => {
  // static/work-view-answer.ts: the view's `recorded` hook drops the draft and publishes `answered` on the questions
  // channel (static/work-questions-sync.ts); an edit must reach it exactly as a first answer does.
  const sent: unknown[] = [], recorded: string[] = [], announced: string[] = [];
  const api = { answer: async (question: string, text: string, extra?: unknown) => {
    sent.push({ question, text, extra });
    return { ok: true as const, value: { id: question, duplicate: false, uncommitted: false } };
  } } as unknown as WorkApi;
  const host: AnswerHost = {
    api, t: key => key, generation: () => 1, selected: () => null, writeUnavailable: () => undefined,
    recorded: question => { recorded.push(question); }, sheetRecorded: async () => true,
    project: {} as AnswerHost['project'], refreshCount: async () => undefined, announce: message => { announced.push(message); },
  };
  assert.equal(await sendAnswer(host, 'N-0000a000', 'REST\nlater', 'sheet', { edit: true, choices: ['REST'] }), null);
  assert.equal(await sendAnswer(host, 'N-0000a001', 'plain', 'sheet'), null);
  assert.deepEqual(sent, [
    { question: 'N-0000a000', text: 'REST\nlater', extra: { edit: true, choices: ['REST'] } },
    { question: 'N-0000a001', text: 'plain', extra: undefined },
  ]);
  assert.deepEqual(recorded, ['N-0000a000', 'N-0000a001'], 'an edit is published as answered too');
  assert.deepEqual(announced, ['work.answer.sentEdit', 'work.answer.sent']);
});
