// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure part of the folder field of the "New session" dialog, against the shipped bundle: the
// allowed work folders read from GET /api/config, the known folders (allowed folders, recent ones,
// the folders of open sessions, GET /api/dirs), their ranking for a typed text, the merge with the
// sub-folders listed while a path is typed, the recent list, and the keys of the combobox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

type Known = {roots: string[]; recent: string[]; sessions: string[]; listed: string[]};
type ComboState = {open: boolean; active: number; count: number};
type ComboAction = {state: ComboState; accept: number | null; handled: boolean};
type State = {
  workspaceRoots: (config: unknown) => string[];
  expandHome: (path: string, home: string) => string;
  insideRoots: (path: string, roots: string[], home: string) => boolean;
  leadsToRoot: (path: string, roots: string[], home: string) => boolean;
  knownFolderList: (known: Known, home: string) => string[];
  matchScore: (typed: string, folder: string, home: string) => number | null;
  rankFolders: (typed: string, folders: string[], home: string, limit?: number) => string[];
  folderSuggestions: (typed: string, known: string[], walked: string[], roots: string[], home: string, limit?: number) => string[];
  recentFolders: (stored: unknown) => string[];
  runnerRecentFolders: (config: unknown) => string[] | null;
  recentFoldersToImport: (stored: unknown, home: string) => string[];
  recentImportOutcome: (status: number) => 'clear' | 'keep';
  comboboxKey: (state: ComboState, key: string) => ComboAction;
  tabKey: (state: ComboState, context: {suggestions: string[]; value: string; typed: boolean; home: string}) => ComboAction;
};
const context: {MeshFolderState?: State} = {};
vm.runInNewContext(fs.readFileSync(new URL('../static/folder-state.js', import.meta.url), 'utf8'), context);
const bundle = context.MeshFolderState as State;
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));   // arrays of the bundle's realm compare unequal
const HOME = '/home/u';

test('allowed work folders: only when configured, absolute strings, bounded', () => {
  const config = (launch: unknown) => ({launch});
  assert.deepEqual(plain(bundle.workspaceRoots(config({configured: true, workspace_roots: ['/home/u/dev', 3, 'rel', '/home/u/w/']}))),
    ['/home/u/dev', '/home/u/w']);
  assert.deepEqual(plain(bundle.workspaceRoots(config({configured: false, workspace_roots: ['/home/u']}))), []);
  const many = Array.from({length: 40}, (_, i) => `/home/u/r${i}`);
  assert.equal(bundle.workspaceRoots(config({configured: true, workspace_roots: many})).length, 16);
  for (const bad of [null, 'x', [], {}, {launch: null}, {launch: {configured: true, workspace_roots: 'x'}}]) {
    assert.deepEqual(plain(bundle.workspaceRoots(bad)), []);
  }
});

test('home expansion and the trailing slash', () => {
  assert.equal(bundle.expandHome('~', HOME), HOME);
  assert.equal(bundle.expandHome('~/dev/', HOME), '/home/u/dev');
  assert.equal(bundle.expandHome('  /srv/x//  ', HOME), '/srv/x');
  assert.equal(bundle.expandHome('/', HOME), '/');
  assert.equal(bundle.expandHome('~other/x', HOME), '~other/x');
});

test('inside the roots, or on the way to one; no roots allows everything', () => {
  const roots = ['/home/u/dev', '/home/u/work'];
  assert.ok(bundle.insideRoots('/home/u/dev', roots, HOME));
  assert.ok(bundle.insideRoots('~/dev/a/b', roots, HOME));
  assert.ok(!bundle.insideRoots('/home/u/devices', roots, HOME));
  assert.ok(!bundle.insideRoots('/home/u', roots, HOME));
  assert.ok(bundle.insideRoots('/anything', [], HOME));
  assert.ok(bundle.leadsToRoot('~/', roots, HOME));
  assert.ok(bundle.leadsToRoot('/home', roots, HOME));
  assert.ok(!bundle.leadsToRoot('/home/u/dev', roots, HOME));
  assert.ok(!bundle.leadsToRoot('/home/u/de', roots, HOME));
  assert.ok(!bundle.leadsToRoot('/srv', roots, HOME));
});

test('known folders: roots first, then recent, sessions, listed; one entry per folder; outside the roots dropped', () => {
  const known = {roots: ['/home/u/dev'], recent: ['~/dev/b', '/srv/x'], sessions: ['/home/u/dev/b', '/home/u/dev/a'],
    listed: ['/home/u', '/home/u/dev/c', '/home/u/dev/a']};
  assert.deepEqual(plain(bundle.knownFolderList(known, HOME)), ['/home/u/dev', '~/dev/b', '/home/u/dev/a', '/home/u/dev/c']);
  assert.deepEqual(plain(bundle.knownFolderList({...known, roots: []}, HOME)),
    ['~/dev/b', '/srv/x', '/home/u/dev/a', '/home/u', '/home/u/dev/c']);
});

test('match score: full prefix, then name prefix, then substring, then letters in order', () => {
  const score = (typed: string, folder: string) => bundle.matchScore(typed, folder, HOME);
  assert.equal(score('~/dev/al', '/home/u/dev/alpha'), 0);
  assert.equal(score('AL', '/home/u/dev/alpha'), 1);
  assert.equal(score('pha', '/home/u/dev/alpha'), 2);
  assert.equal(score('dvap', '/home/u/dev/alpha'), 3);
  assert.equal(score('zz', '/home/u/dev/alpha'), null);
  assert.equal(score('', '/home/u/dev/alpha'), 0);
});

test('ranking: by score, then source order; bounded', () => {
  const folders = ['/home/u/dev/sigma-alp', '/home/u/dev/alpha', '/home/u/a-l-p', '/home/u/dev/alpine', '/srv/beta'];
  assert.deepEqual(plain(bundle.rankFolders('alp', folders, HOME)),
    ['/home/u/dev/alpha', '/home/u/dev/alpine', '/home/u/dev/sigma-alp', '/home/u/a-l-p']);
  assert.deepEqual(plain(bundle.rankFolders('', folders, HOME, 2)), folders.slice(0, 2));
  const many = Array.from({length: 300}, (_, i) => `/home/u/d${i}`);
  assert.equal(bundle.rankFolders('d', many, HOME).length, 50);
});

test('suggestions: the listed sub-folders as typed first, then the ranked known folders, no duplicate, roots applied', () => {
  const roots = ['/home/u/dev'];
  const known = ['/home/u/dev', '/home/u/dev/alpha', '/home/u/dev/zalpha'];
  assert.deepEqual(plain(bundle.folderSuggestions('~/dev/al', known, ['~/dev/alpha', '~/dev/alto'], roots, HOME)),
    ['~/dev/alpha', '~/dev/alto', '/home/u/dev/zalpha']);
  assert.deepEqual(plain(bundle.folderSuggestions('~/', known, ['~/dev', '~/music'], roots, HOME)),
    ['~/dev', '/home/u/dev/alpha', '/home/u/dev/zalpha']);
  assert.deepEqual(plain(bundle.folderSuggestions('/', [], ['/home', '/srv'], roots, HOME)), ['/home']);
  assert.deepEqual(plain(bundle.folderSuggestions('', known, [], [], HOME)), known);
  const walked = Array.from({length: 80}, (_, i) => `~/dev/a${i}`);
  assert.equal(bundle.folderSuggestions('~/dev/a', known, walked, roots, HOME).length, 50);
});

test('recent folders kept by an older version of this browser: usable paths only, at most 8', () => {
  assert.deepEqual(plain(bundle.recentFolders(['/a', 7, '', 'rel', '/b'])), ['/a', '/b']);
  assert.deepEqual(plain(bundle.recentFolders(null)), []);
  assert.deepEqual(plain(bundle.recentFolders(Array.from({length: 12}, (_, i) => `/r${i}`))).length, 8);
});

test('recent folders of the runner: read from GET /api/config, absent on an older server', () => {
  const config = (values: unknown) => ({runner_settings: {values}});
  assert.deepEqual(plain(bundle.runnerRecentFolders(config({operator_name: '', recent_folders: ['/home/u/b', '/home/u/a']}))),
    ['/home/u/b', '/home/u/a']);
  assert.deepEqual(plain(bundle.runnerRecentFolders(config({recent_folders: ['/a', 3, 'rel', '~/x', '', '/b']}))), ['/a', '/b'],
    'only absolute paths: the server stores them expanded');
  assert.equal(bundle.runnerRecentFolders(config({operator_name: 'Ana'})), null, 'an older server: no shared list');
  for (const bad of [null, 'x', {}, {runner_settings: null}, config(null), config({recent_folders: 'x'})]) {
    assert.equal(bundle.runnerRecentFolders(bad), null, JSON.stringify(bad));
  }
});

test('the one-time move of this browser\'s recent folders to the runner: expanded, once each, at most 8', () => {
  assert.deepEqual(plain(bundle.recentFoldersToImport(['~/b/', '/home/u/b', '/a', 7, 'rel', ''], HOME)), ['/home/u/b', '/a']);
  assert.deepEqual(plain(bundle.recentFoldersToImport('junk', HOME)), []);
  assert.deepEqual(plain(bundle.recentFoldersToImport(['~/x', '~', '/a'], '')), ['/a'], 'home not known yet: ~/x never becomes /x');
  assert.equal(bundle.recentFoldersToImport(Array.from({length: 12}, (_, i) => `/r${i}`), HOME).length, 8);
  // the local copy goes once the runner answered for good; a failure that may pass keeps it for the next try
  for (const status of [200, 400, 401, 403, 404, 413, 415]) assert.equal(bundle.recentImportOutcome(status), 'clear', String(status));
  for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(bundle.recentImportOutcome(status), 'keep', String(status));
});

test('combobox keys: arrows move and wrap, Enter accepts the active option, Escape closes; Tab is tabKey', () => {
  const key = (open: boolean, active: number, count: number, name: string) => plain(bundle.comboboxKey({open, active, count}, name));
  assert.deepEqual(key(false, -1, 3, 'ArrowDown'), {state: {open: true, active: 0, count: 3}, accept: null, handled: true});
  assert.deepEqual(key(true, 2, 3, 'ArrowDown').state.active, 0);
  assert.deepEqual(key(true, 0, 3, 'ArrowUp').state.active, 2);
  assert.deepEqual(key(false, -1, 3, 'ArrowUp').state, {open: true, active: 2, count: 3});
  assert.deepEqual(key(false, -1, 0, 'ArrowDown'), {state: {open: false, active: -1, count: 0}, accept: null, handled: false});
  assert.deepEqual(key(true, 1, 3, 'Enter'), {state: {open: false, active: -1, count: 3}, accept: 1, handled: true});
  assert.deepEqual(key(true, -1, 3, 'Enter'), {state: {open: false, active: -1, count: 3}, accept: null, handled: false});
  assert.deepEqual(key(false, -1, 3, 'Enter').handled, false);
  assert.deepEqual(key(true, 1, 3, 'Tab').handled, false, 'comboboxKey leaves Tab to tabKey');
  assert.deepEqual(key(true, 1, 3, 'Escape'), {state: {open: false, active: -1, count: 3}, accept: null, handled: true});
  assert.deepEqual(key(false, -1, 3, 'Escape').handled, false);
  for (const name of ['Escape', 'Enter', 'ArrowDown']) {   // wanted open but empty: not shown, so the key goes on
    assert.deepEqual(key(true, -1, 0, name), {state: {open: true, active: -1, count: 0}, accept: null, handled: false}, name);
  }
  assert.deepEqual(key(true, 1, 3, 'a'), {state: {open: true, active: 1, count: 3}, accept: null, handled: false});
});

test('Tab completes like a shell: the chosen suggestion, else the first one once something is typed', () => {
  const shown = ['/home/u/dev/alpha', '/home/u/dev/alpine'];
  const tab = (open: boolean, active: number, value: string, typed = true, suggestions = shown) =>
    plain(bundle.tabKey({open, active, count: suggestions.length}, {suggestions, value, typed, home: HOME}));
  const closed = (count = 2) => ({open: false, active: -1, count});
  assert.deepEqual(tab(true, -1, '~/dev/al'), {state: closed(), accept: 0, handled: true}, 'the first suggestion');
  assert.deepEqual(tab(true, 1, '~/dev/al'), {state: closed(), accept: 1, handled: true}, 'the highlighted one wins');
  assert.deepEqual(tab(false, -1, '~/dev/al'), {state: closed(), accept: null, handled: false}, 'list closed: focus moves on');
  assert.deepEqual(tab(true, -1, '~/dev/zz', true, []), {state: closed(0), accept: null, handled: false}, 'no suggestion: focus moves on');
  assert.deepEqual(tab(true, -1, '/home/u/dev/alpha'), {state: closed(), accept: null, handled: false},
    'the field already holds the suggestion: a second Tab moves on');
  assert.deepEqual(tab(true, -1, '~/dev/alpha/'), {state: closed(), accept: null, handled: false}, 'compared after ~ and the trailing slash');
  assert.deepEqual(tab(true, 1, '/home/u/dev/alpine'), {state: closed(), accept: null, handled: false});
  assert.deepEqual(tab(true, -1, '/home/u', false), {state: closed(), accept: null, handled: false},
    'nothing typed yet (the folder the dialog opened with): Tab moves on, the folder is kept');
  assert.deepEqual(tab(true, 0, '/home/u', false), {state: closed(), accept: 0, handled: true}, 'unless an option was chosen with the arrows');
});

test('Tab completes only a prefix of what was typed, like a shell; a fuzzy match never replaces the text', () => {
  const tab = (value: string, suggestions: string[], active = -1) =>
    plain(bundle.tabKey({open: true, active, count: suggestions.length}, {suggestions, value, typed: true, home: HOME}));
  const moveOn = (count: number) => ({state: {open: false, active: -1, count}, accept: null, handled: false});
  const accept = (count: number, index: number) => ({state: {open: false, active: -1, count}, accept: index, handled: true});
  // letters in order (matchScore 3): "api" in "alpha-pi"
  assert.deepEqual(tab('~/dev/api', ['/home/u/dev/alpha-pi']), moveOn(1), 'a subsequence match is not a completion');
  // contained (matchScore 2) and name prefix (matchScore 1)
  assert.deepEqual(tab('~/dev/pha', ['/home/u/dev/alpha']), moveOn(1), 'a substring match is not a completion');
  assert.deepEqual(tab('alp', ['/home/u/dev/alpha']), moveOn(1), 'a folder-name match is not a completion of the typed path');
  assert.deepEqual(tab('~/dev/api', ['/home/u/dev/alpha-pi', '/home/u/dev/api-gateway']), accept(2, 1),
    'the first suggestion that extends the typed text');
  assert.deepEqual(tab('~/dev/', ['/home/u/devel', '/home/u/dev/x']), accept(2, 1), 'a typed trailing slash is part of the prefix');
  assert.deepEqual(tab('~/dev/Al', ['/home/u/dev/alpha']), moveOn(1), 'case-sensitive, as a shell');
  assert.deepEqual(tab('/home/u/dev/al', ['~/dev/alpha']), accept(1, 0), 'both sides compared once ~ is expanded');
  assert.deepEqual(tab('~/dev/alpha', ['/home/u/dev/alpha', '/home/u/dev/alpha-2']), moveOn(2),
    'the field already holds the first prefix match: a second Tab moves on');
  // the 150 ms debounce window: the list still shows the suggestions of an earlier text, not the listing of this one
  const stale = ['/home/u/dev/alpha', '/home/u/dev/alpine'];   // listed for "~/dev/a", the field now holds "~/dev/ap"
  assert.deepEqual(tab('~/dev/ap', stale), moveOn(2), 'no stale fuzzy match is accepted before the exact listing');
  assert.deepEqual(tab('~/dev/alpi', stale), accept(2, 1), 'a stale suggestion is accepted only when it extends the typed text');
  assert.deepEqual(tab('~/dev/api', ['/home/u/dev/alpha-pi'], 0), accept(1, 0), 'an option chosen with the arrows is taken as chosen');
});
