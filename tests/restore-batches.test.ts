// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The restore routes take at most 50 names per request: the page cuts a larger offer into batches,
// sends them one after the other, merges their results and stops at the first failed batch.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {RESTORE_BATCH_MAX, mergeResults, postInBatches, restoreBatches, type BatchOutcome} from '../static/restore-batches.ts';

const names = (count: number) => Array.from({length: count}, (_, index) => `s${index + 1}`);
type Result = {ok: boolean; id?: string};

test('the batch size mirrors the server limit RESTORE_MAX', () => {
  const server = readFileSync(new URL('../server.py', import.meta.url), 'utf8');
  assert.equal(RESTORE_BATCH_MAX, Number(/^RESTORE_MAX = (\d+)$/m.exec(server)?.[1]));
  assert.equal(RESTORE_BATCH_MAX, 50);
});

test('50 names or fewer make one batch, in order', () => {
  assert.deepEqual(restoreBatches([]), []);
  assert.deepEqual(restoreBatches(['a']), [['a']]);
  assert.deepEqual(restoreBatches(names(50)), [names(50)]);
});

test('53 names make a batch of 50 then one of 3, in order', () => {
  const batches = restoreBatches(names(53));
  assert.deepEqual(batches.map(batch => batch.length), [50, 3]);
  assert.deepEqual(batches.flat(), names(53));
  assert.deepEqual(batches[1], ['s51', 's52', 's53']);
  assert.deepEqual(restoreBatches(names(101)).map(batch => batch.length), [50, 50, 1]);
});

test('a batch size that is not a positive integer is refused', () => {
  assert.throws(() => restoreBatches(['a'], 0), RangeError);
  assert.throws(() => restoreBatches(['a'], 1.5), RangeError);
});

test('the results of every batch are merged by name', async () => {
  const sentBatches: string[][] = [];
  const out = await postInBatches<Result>(names(53), async batch => {
    sentBatches.push(batch);
    return {ok: true, results: Object.fromEntries(batch.map(name => [name, {ok: name !== 's52', id: name}]))};
  });
  assert.deepEqual(sentBatches.map(batch => batch.length), [50, 3]);
  assert.equal(out.error, null);
  assert.deepEqual(out.unsent, []);
  assert.deepEqual(out.sent, names(53));
  assert.deepEqual(Object.keys(out.results), names(53));
  assert.equal(out.results.s52?.ok, false);
  assert.equal(out.results.s1?.ok, true);
});

test('the batches are sent one after the other, never two at once', async () => {
  let inFlight = 0;
  let most = 0;
  await postInBatches<Result>(names(120), async batch => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    return {ok: true, results: Object.fromEntries(batch.map(name => [name, {ok: true}]))};
  });
  assert.equal(most, 1);
});

test('a failed second batch keeps the results of the first and stops there', async () => {
  const sentBatches: string[][] = [];
  const out = await postInBatches<Result>(names(120), async (batch): Promise<BatchOutcome<Result>> => {
    sentBatches.push(batch);
    if (sentBatches.length === 2) return {ok: false, error: 'names: a list of at most 50 session names'};
    return {ok: true, results: Object.fromEntries(batch.map(name => [name, {ok: true}]))};
  });
  assert.equal(sentBatches.length, 2, 'no batch after the failed one');
  assert.equal(out.error, 'names: a list of at most 50 session names');
  assert.deepEqual(out.sent, names(50));
  assert.deepEqual(Object.keys(out.results), names(50));
  assert.deepEqual(out.unsent, names(120).slice(50));
});

test('a failed first batch sends nothing else', async () => {
  let calls = 0;
  const out = await postInBatches<Result>(names(53), async () => { calls++; return {ok: false, error: 'boom'}; });
  assert.equal(calls, 1);
  assert.deepEqual(out.results, {});
  assert.deepEqual(out.sent, []);
  assert.deepEqual(out.unsent, names(53));
});

test('no names, no request', async () => {
  let calls = 0;
  const out = await postInBatches<Result>([], async () => { calls++; return {ok: true, results: {}}; });
  assert.equal(calls, 0);
  assert.equal(out.error, null);
});

test('merging copies own entries only, a name like __proto__ included', () => {
  const into: Record<string, Result> = {a: {ok: true}};
  const batch = JSON.parse('{"__proto__": {"ok": false}, "b": {"ok": true}}') as Record<string, Result>;
  mergeResults(into, batch);
  assert.deepEqual(Object.keys(into), ['a', '__proto__', 'b']);
  assert.equal(Object.getPrototypeOf(into), Object.prototype);
  assert.equal(({} as Record<string, unknown>).ok, undefined);
  assert.deepEqual(mergeResults(into, null), into);
});
