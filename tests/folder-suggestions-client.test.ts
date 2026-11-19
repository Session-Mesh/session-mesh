// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The client logic of the folder suggestions of the "New session" dialog, against the shipped bundle,
// with a fake listing (POST /api/ls) and a fake clock: which text is listed, how the answer is filtered,
// the debounce, the cache and the dropping of answers to an older text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

type Typed = {directory: string; prefix: string};
type Suggester = {input: (typed: string) => void; reset: () => void};
type Options = {
  listFolder: (directory: string, signal?: unknown) => Promise<unknown>;
  createAbort?: () => {signal: unknown; abort: () => void};
  onSuggestions: (folders: string[]) => void;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};
type State = {
  splitTypedPath: (typed: string) => Typed | null;
  listingFolderNames: (response: unknown) => string[];
  matchingFolders: (typed: Typed, names: string[], limit?: number) => string[];
  createFolderSuggester: (options: Options) => Suggester;
};
const context: {MeshFolderState?: State} = {};
vm.runInNewContext(fs.readFileSync(new URL('../static/folder-state.js', import.meta.url), 'utf8'), context);
const bundle = context.MeshFolderState as State;
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));   // arrays of the bundle's realm compare unequal

const dir = (name: string, extra: object = {}) => ({name, dir: true, size: 0, link: false, ...extra});
const file = (name: string) => ({name, dir: false, size: 10, link: false});
const split = (typed: string) => plain(bundle.splitTypedPath(typed));
const match = (typed: string, names: string[], limit?: number) =>
  plain(bundle.matchingFolders(bundle.splitTypedPath(typed) as Typed, names, limit));

test('only an absolute or home-relative text is listed, from its last complete folder', () => {
  assert.deepEqual(split('/srv/work/dev/'), {directory: '/srv/work/dev/', prefix: ''});
  assert.deepEqual(split('  ~/dev/pr '), {directory: '~/dev/', prefix: 'pr'});
  assert.deepEqual(split('/tm'), {directory: '/', prefix: 'tm'});
  for (const typed of ['', '   ', 'dev/', '~', '~root/x', './x', '../x', '/' + 'a'.repeat(1030)]) {
    assert.equal(split(typed), null, typed.slice(0, 20));
  }
});

test('the listing keeps folders (links to folders too) and ignores anything else', () => {
  const answer = {entries: [dir('b'), file('f.txt'), dir('a', {link: true}), {name: 3, dir: true}, {dir: true}, dir(''), null, 'x']};
  assert.deepEqual(plain(bundle.listingFolderNames(answer)), ['b', 'a']);
  for (const bad of [null, 'x', [], {}, {entries: 'x'}, {entries: {}}]) assert.deepEqual(plain(bundle.listingFolderNames(bad)), []);
});

test('matching: case-insensitive prefix, written as typed, dotfolders only for a dot prefix, capped', () => {
  const names = ['zeta', 'Alpha', 'alpine', '.cache', '.config', 'beta'];
  assert.deepEqual(match('/h/', names), ['/h/Alpha', '/h/alpine', '/h/beta', '/h/zeta']);
  assert.deepEqual(match('~/AL', names), ['~/Alpha', '~/alpine']);
  assert.deepEqual(match('/h/.c', names), ['/h/.cache', '/h/.config']);
  assert.deepEqual(match('/h/.', names), ['/h/.cache', '/h/.config']);
  assert.deepEqual(match('/h/q', names), []);
  assert.equal(match('/h/', Array.from({length: 500}, (_, i) => `d${i}`)).length, 50);
  assert.equal(match('/h/', ['a', 'b', 'c'], 2).length, 2);
});

type Harness = {
  asked: string[];
  shown: string[][];
  suggester: Suggester;
  advance: (ms: number) => void;
  answers: Map<string, {resolve: (value: unknown) => void; reject: (error: Error) => void}[]>;
  clock: {t: number};
};

function harness(): Harness {
  const asked: string[] = [];
  const shown: string[][] = [];
  const answers: Harness['answers'] = new Map();
  const clock = {t: 0};
  let timers: {at: number; callback: () => void; id: number}[] = [];
  let nextId = 1;
  const suggester = bundle.createFolderSuggester({
    listFolder: directory => new Promise((resolve, reject) => {
      asked.push(directory);
      answers.set(directory, [...(answers.get(directory) ?? []), {resolve, reject}]);
    }),
    onSuggestions: folders => shown.push(plain(folders)),
    now: () => clock.t,
    setTimer: (callback, ms) => { const id = nextId++; timers.push({at: clock.t + ms, callback, id}); return id; },
    clearTimer: handle => { timers = timers.filter(timer => timer.id !== handle); },
  });
  const advance = (ms: number) => {
    clock.t += ms;
    const due = timers.filter(timer => timer.at <= clock.t);
    timers = timers.filter(timer => timer.at > clock.t);
    for (const timer of due) timer.callback();
  };
  return {asked, shown, suggester, advance, answers, clock};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const answer = (h: Harness, directory: string, value: unknown, index = 0) => h.answers.get(directory)?.[index]?.resolve(value);

test('debounce: one listing, 150 ms after the last key', async () => {
  const h = harness();
  h.suggester.input('/h/a'); h.advance(100); h.suggester.input('/h/al'); h.advance(100); h.suggester.input('/h/alp');
  h.advance(149);
  assert.deepEqual(h.asked, []);
  h.advance(1);
  assert.deepEqual(h.asked, ['/h/']);
  answer(h, '/h/', {entries: [dir('alpha'), dir('alpine'), dir('beta')]});
  await settle();
  assert.deepEqual(h.shown, [['/h/alpha', '/h/alpine']]);
});

test('an unusable text clears the suggestions at once and lists nothing', () => {
  const h = harness();
  h.suggester.input('dev');
  h.advance(1000);
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.shown, [[]]);
});

test('an answer to an older text is dropped, only the latest one is shown', async () => {
  const h = harness();
  h.suggester.input('/a/x'); h.advance(150);          // listing of /a/ starts
  h.suggester.input('/b/y'); h.advance(150);          // listing of /b/ starts before /a/ answers
  answer(h, '/b/', {entries: [dir('yes')]});
  await settle();
  answer(h, '/a/', {entries: [dir('xray')]});         // late answer to the older text
  await settle();
  assert.deepEqual(h.shown, [['/b/yes']]);
});

test('a text typed while a listing is pending also drops that listing, even for the same folder', async () => {
  const h = harness();
  h.suggester.input('/a/x'); h.advance(150);
  h.suggester.input('/a/xr');
  answer(h, '/a/', {entries: [dir('xray'), dir('xenon')]});
  await settle();
  assert.deepEqual(h.shown, []);                      // the timer of the newer text has not fired yet
  h.advance(150);                                     // served from the cache: no second listing
  await settle();
  assert.deepEqual(h.asked, ['/a/']);
  assert.deepEqual(h.shown, [['/a/xray']]);
});

test('cache: a folder is listed once within the lifetime, again after it', async () => {
  const h = harness();
  h.suggester.input('/a/x'); h.advance(150);
  answer(h, '/a/', {entries: [dir('xray')]});
  await settle();
  h.suggester.input('/a/'); h.advance(150);
  await settle();
  assert.deepEqual(h.asked, ['/a/']);
  assert.deepEqual(h.shown[1], ['/a/xray']);
  h.advance(5000);
  h.suggester.input('/a/x'); h.advance(150);
  assert.deepEqual(h.asked, ['/a/', '/a/']);
  answer(h, '/a/', {entries: [dir('xray'), dir('xenon')]}, 1);
  await settle();
  assert.deepEqual(h.shown[2], ['/a/xenon', '/a/xray']);
});

test('a refused (null) or failed (thrown) listing gives no suggestion and is not cached', async () => {
  const h = harness();
  h.suggester.input('/etc/x'); h.advance(150);
  answer(h, '/etc/', null);                           // 403/404 from the server
  await settle();
  assert.deepEqual(h.shown, [[]]);
  h.suggester.input('/n/x'); h.advance(150);
  h.answers.get('/n/')?.[0]?.reject(new Error('network'));
  await settle();
  assert.deepEqual(h.shown[1], []);
  h.suggester.input('/n/xy'); h.advance(150);
  assert.deepEqual(h.asked, ['/etc/', '/n/', '/n/']);
  h.suggester.input('/etc/xy'); h.advance(150);          // the refusal was not kept either
  assert.deepEqual(h.asked, ['/etc/', '/n/', '/n/', '/etc/']);
});

test('the cache keeps at most 30 folders: the oldest is listed again, a recent one is not', async () => {
  const h = harness();
  for (let n = 0; n < 31; n++) {
    h.suggester.input('/d' + n + '/x'); h.advance(150);
    answer(h, '/d' + n + '/', {entries: [dir('xray')]});
    await settle();
  }
  assert.equal(h.asked.length, 31);
  h.suggester.input('/d30/x'); h.advance(150);
  await settle();
  assert.equal(h.asked.length, 31);                      // newest still cached
  h.suggester.input('/d0/x'); h.advance(150);
  assert.equal(h.asked.length, 32);                      // oldest was evicted
  assert.equal(h.asked[31], '/d0/');
});

test('a newer text or a reset aborts the pending listing; the signal reaches the listing', async () => {
  const aborted: number[] = [];
  const signals: unknown[] = [];
  let made = 0;
  const timers: (() => void)[] = [];
  const suggester = bundle.createFolderSuggester({
    listFolder: (_directory, signal) => { signals.push(signal); return new Promise(() => {}); },
    onSuggestions: () => {},
    createAbort: () => { const id = ++made; return {signal: `signal-${id}`, abort: () => aborted.push(id)}; },
    now: () => 0,
    setTimer: callback => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  suggester.input('/a/x'); timers.shift()?.();
  await settle();
  assert.deepEqual(signals, ['signal-1']);
  suggester.input('/a/xy');
  assert.deepEqual(aborted, [1]);
  timers.shift()?.();
  await settle();
  suggester.reset();
  assert.deepEqual(aborted, [1, 2]);
  suggester.input('/b/');                                // nothing pending: nothing more to abort
  assert.deepEqual(aborted, [1, 2]);
});

test('reset drops a pending listing and empties the cache', async () => {
  const h = harness();
  h.suggester.input('/a/x'); h.advance(150);
  h.suggester.reset();
  answer(h, '/a/', {entries: [dir('xray')]});
  await settle();
  assert.deepEqual(h.shown, []);
  h.suggester.input('/a/x'); h.advance(150);
  assert.deepEqual(h.asked, ['/a/', '/a/']);
});
