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
  rememberFolder: (recent: unknown, folder: string, home: string, max?: number) => string[];
  recentFolders: (stored: unknown) => string[];
  comboboxKey: (state: ComboState, key: string) => ComboAction;
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

test('recent folders: newest first, expanded once, at most 8, junk ignored', () => {
  assert.deepEqual(plain(bundle.rememberFolder(['/a', '/home/u/b'], '~/b/', HOME)), ['/home/u/b', '/a']);
  const nine = Array.from({length: 9}, (_, i) => `/r${i}`);
  assert.deepEqual(plain(bundle.rememberFolder(nine, '/new', HOME)), ['/new', ...nine.slice(0, 7)]);
  assert.deepEqual(plain(bundle.rememberFolder('junk', '/new', HOME)), ['/new']);
  assert.deepEqual(plain(bundle.rememberFolder([3, '/a', ''], '  ', HOME)), ['/a']);
  assert.deepEqual(plain(bundle.recentFolders(['/a', 7, '', 'rel', '/b'])), ['/a', '/b']);
  assert.deepEqual(plain(bundle.recentFolders(null)), []);
});

test('combobox keys: arrows move and wrap, Enter and Tab accept the active option, Escape closes', () => {
  const key = (open: boolean, active: number, count: number, name: string) => plain(bundle.comboboxKey({open, active, count}, name));
  assert.deepEqual(key(false, -1, 3, 'ArrowDown'), {state: {open: true, active: 0, count: 3}, accept: null, handled: true});
  assert.deepEqual(key(true, 2, 3, 'ArrowDown').state.active, 0);
  assert.deepEqual(key(true, 0, 3, 'ArrowUp').state.active, 2);
  assert.deepEqual(key(false, -1, 3, 'ArrowUp').state, {open: true, active: 2, count: 3});
  assert.deepEqual(key(false, -1, 0, 'ArrowDown'), {state: {open: false, active: -1, count: 0}, accept: null, handled: false});
  assert.deepEqual(key(true, 1, 3, 'Enter'), {state: {open: false, active: -1, count: 3}, accept: 1, handled: true});
  assert.deepEqual(key(true, -1, 3, 'Enter'), {state: {open: false, active: -1, count: 3}, accept: null, handled: false});
  assert.deepEqual(key(false, -1, 3, 'Enter').handled, false);
  assert.deepEqual(key(true, 1, 3, 'Tab'), {state: {open: false, active: -1, count: 3}, accept: 1, handled: true});
  assert.deepEqual(key(true, -1, 3, 'Tab'), {state: {open: false, active: -1, count: 3}, accept: null, handled: false});
  assert.deepEqual(key(false, -1, 3, 'Tab').handled, false);
  assert.deepEqual(key(true, 1, 3, 'Escape'), {state: {open: false, active: -1, count: 3}, accept: null, handled: true});
  assert.deepEqual(key(false, -1, 3, 'Escape').handled, false);
  for (const name of ['Escape', 'Enter', 'Tab', 'ArrowDown']) {   // wanted open but empty: not shown, so the key goes on
    assert.deepEqual(key(true, -1, 0, name), {state: {open: true, active: -1, count: 0}, accept: null, handled: false}, name);
  }
  assert.deepEqual(key(true, 1, 3, 'a'), {state: {open: true, active: 1, count: 3}, accept: null, handled: false});
});
