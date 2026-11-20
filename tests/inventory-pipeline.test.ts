// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The real inventory seam of static/app.js, without a browser: refresh() goes through the
// single-flight poller (static/sessions-progress.js) to the loader, and an answer is applied by
// applyInventorySnapshot against the real pane target registry (static/pane-actions.js).
// A failure, a refusal or an invalid listing is never an observed empty inventory: it applies
// nothing, runs no effect and retires no pane target. Timers never fire here: only refresh()
// starts a request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import vm from 'node:vm';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (name: string) => fs.readFileSync(path.join(REPO, 'static', name), 'utf8');
const APP = read('app.js');

function region(from: string, to: string): string {
  const start = APP.indexOf(from);
  const end = APP.indexOf(to, start);
  assert.ok(start > 0 && end > start, `app.js region from ${JSON.stringify(from)}`);
  return APP.slice(start, end);
}

type Outcome = {kind: string; value?: unknown; status?: number | null};
type Loader = (signal: AbortSignal, attempt: unknown) => Promise<Outcome>;
type Page = Record<string, any> & {calls: string[]};

const EFFECTS = ['receiveBoardSignals', 'checkClientVersion', 'showUpdateNotice', 'markSeen',
  'invalidateReplacedDemoPanes', 'handleOpen', 'checkDemoSceneUpdates', 'renderManagement',
  'renderRestore', 'pollWatched', 'pollHistory', 'tickSessionMarker', 'tickReferences', 'directLineAlive', 'rememberKnownSessions'];

function page(inventory: (page: Page) => Loader): Page {
  const calls: string[] = [];
  const events = () => new EventTarget();
  const context = vm.createContext({
    AbortController, URLSearchParams, console, calls,
    setTimeout: () => 0, clearTimeout: () => {},   // only refresh() starts a request
    window: Object.assign(events(), {navigator: {onLine: true}}), document: Object.assign(events(), {hidden: false}),
    meshStopped: false, data: {mesh: [], external: []}, lastListing: null, inventoryLoaded: false,
    paneInventoryIssue: 0, activityRanking: {}, clockOffset: 0, lastOpen: null, pageStartedAt: 0,
    restoringWorkspace: false,
    managing: false, panes: [], location: {href: '/'},
    localMeshEffectsAllowed: () => context.meshContext !== null && !context.meshStopped,
    sessionRequestGate: {consider: () => calls.push('session-actions')},
    agentMailConsentGate: {consider: () => calls.push('agent-mail')},
    mailboxPanel: {note: () => {}},
    MeshSessionActivity: {update: (previous: unknown) => { calls.push('activity'); return previous; }},
    hostSilence: {update: () => {}, silent: () => false},
    listBatch: {request: () => calls.push('renderLists')},
    sessionsStatus: {render: () => {}},
    forgetKnownSessions: () => calls.push('forgetKnownSessions'),
    focusNames: () => [],
    isAdjacentPane: () => false, isHist: () => false, liveOf: () => null,
  }) as Page;
  for (const name of EFFECTS) context[name] = () => calls.push(name);
  vm.runInContext(read('pane-actions.js'), context);
  vm.runInContext(read('sessions-progress.js'), context);
  context.Progress = context.MeshSessionsProgress;
  context.paneTargets = context.MeshPaneActions.createTargetRegistry();
  context.find = (id: string) => context.data.mesh.find((session: {id: string}) => session.id === id);
  vm.runInContext(region('async function loadLocalInventory(', '// The sessions this page wants described first'), context);
  vm.runInContext(region('function validateInventorySnapshot(', '// One listing request at a time per tab'), context);
  vm.runInContext(region('function startInventory(', '// "Where are we"'), context);
  vm.runInContext(region('function refresh() {', '// ---------------------------------------------------------------- restore after'), context);
  context.meshContext = Object.freeze({inventory: inventory(context)});
  return context;
}

const snapshot = (created: number) => ({mesh: [{kind: 'mesh', id: 't1', name: 'shell', created}],
  external: [], management: {state: 'observed'}, portfolio: {created}});

function capture(context: Page, created: number) {
  const pane = {};
  context.paneTargets.observePane({pane, id: 't1', name: 'shell', sessionId: 't1', displayName: 'shell',
    created, view: 1, kind: 'mesh', available: true});
  return context.paneTargets.capture(pane);
}

describe('inventory pipeline', () => {
  test('an observed listing applies; failures, refusals and invalid listings change nothing', async () => {
    let next: Loader = async () => ({kind: 'loaded', value: snapshot(1)});
    let loads = 0;
    const context = page(() => (signal, attempt) => { loads++; return next(signal, attempt); });
    await context.startInventory(context.meshContext);
    assert.equal(context.data.portfolio.created, 1);
    // Every effect of an observed listing, in order (no open request, no management view here).
    assert.deepEqual(context.calls, ['rememberKnownSessions', 'session-actions', 'agent-mail', 'activity',
      'receiveBoardSignals', 'checkClientVersion', 'showUpdateNotice', 'directLineAlive', 'markSeen',
      'invalidateReplacedDemoPanes', 'checkDemoSceneUpdates', 'renderLists', 'renderRestore', 'pollWatched', 'pollHistory', 'tickSessionMarker', 'tickReferences']);
    const oldTarget = capture(context, 1);
    assert.ok(oldTarget && context.paneTargets.valid(oldTarget));

    // A new incarnation of the same name retires the target captured on the old one.
    next = async () => ({kind: 'loaded', value: snapshot(2)});
    await context.refresh();
    assert.equal(context.paneTargets.valid(oldTarget), false);
    const currentTarget = capture(context, 2);
    const applied = context.data;
    const appliedCalls = context.calls.length;

    for (const loader of [async () => ({kind: 'failed', status: 503}), async () => { throw Error('offline'); },
      async () => ({kind: 'loaded', value: {mesh: [], external: null}}),
      async () => ({kind: 'loaded', value: {...snapshot(2), mesh: [{...snapshot(2).mesh[0], created: NaN}]}}),
      async () => ({kind: 'loaded', value: {...snapshot(2), mesh: [snapshot(2).mesh[0], snapshot(2).mesh[0]]}})]) {
      next = loader as Loader;
      const before = loads;
      await context.refresh();
      assert.equal(loads, before + 1, 'the request really ran');
      assert.equal(context.data, applied);
      assert.equal(context.calls.length, appliedCalls, 'no effect runs for an answer that is not applied');
      assert.equal(context.paneTargets.valid(currentTarget), true);
    }

    let cleared = 0;
    context.panes = [{id: 't1', clear: () => { cleared++; }, header: () => {}}];
    next = async () => ({kind: 'loaded', value: {mesh: [], external: [], management: {state: 'observed'}}});
    await context.refresh();
    assert.equal(context.paneTargets.valid(currentTarget), false);
    assert.equal(cleared, 1, 'an observed empty inventory really does clear an ended pane');

    // A refusal stops the poller (the page goes to the login page): it applies nothing either.
    const emptied = context.data;
    const emptiedCalls = context.calls.length;
    next = async () => ({kind: 'refused'});
    await context.refresh();
    assert.equal(context.data, emptied);
    assert.equal(context.calls.length, emptiedCalls);
    assert.equal(context.inventoryPoller.state().stopped, true);
  });

  test('the local loader asks /api/sessions and sends a refused listing to the login page', async () => {
    const context = page(page => page.loadLocalInventory);
    const paths: string[] = [];
    context.requestLocal = async (url: string) => { paths.push(url); return {status: 200, ok: true, json: async () => snapshot(3)}; };
    assert.equal((await context.startInventory(context.meshContext))?.portfolio.created, 3);
    assert.deepEqual(paths, ['/api/sessions']);

    const before = context.data;
    context.requestLocal = async () => ({status: 503, ok: false});
    await context.refresh();
    assert.equal(context.data, before);
    assert.equal(context.location.href, '/');

    context.requestLocal = async () => ({status: 401, ok: false});
    await context.refresh();
    assert.equal(context.location.href, '/login');
    assert.ok(context.calls.includes('forgetKnownSessions'), 'a refused listing forgets the stored sessions');
    assert.equal(context.data, before);
    context.inventoryPoller.stop();
  });

  test('requests to open a pane wait until the saved panes are restored', async () => {
    const started = Date.now() / 1000;   // the server's clock is the page's here
    const opens = [{seq: 1, at: started - 5}, {seq: 2, at: started + 5}];   // made before and after the page started
    const context = page(() => async () => ({kind: 'loaded', value: {...snapshot(1), now: Date.now() / 1000, opens}}));
    context.pageStartedAt = started;
    context.restoringWorkspace = true;
    await context.startInventory(context.meshContext);
    assert.equal(context.calls.includes('handleOpen'), false, 'no anchor pane may exist yet during the restore');
    assert.equal(context.lastOpen, null, 'and no cutoff is taken');
    context.restoringWorkspace = false;
    context.consumeOpens();
    assert.deepEqual(context.calls.filter((call) => call === 'handleOpen'), ['handleOpen'], 'the later one only');
    assert.equal(context.lastOpen, 2);
    context.inventoryPoller.stop();
  });

  test('a refusal that arrives after disposal does not navigate', async () => {
    let release: (response: unknown) => void = () => {};
    const context = page(page => page.loadLocalInventory);
    context.requestLocal = () => new Promise(resolve => { release = resolve; });
    context.location.href = '/stay';
    const first = context.startInventory(context.meshContext);
    context.meshStopped = true;
    release({status: 401, ok: false});
    await first;
    assert.equal(context.location.href, '/stay');
    assert.equal(context.calls.includes('forgetKnownSessions'), false);
    context.inventoryPoller.stop();
  });
});
