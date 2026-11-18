# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Exercise the real app inventory seam and target registry without a browser."""

from pathlib import Path
import shutil
import subprocess

import pytest


def test_inventory_loading_preserves_observation_and_retirement():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for the frontend source unit")
    root = Path(__file__).resolve().parents[1]
    script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const calls = [];
const context = vm.createContext({
  AbortController,
  meshContext: {}, meshStopped: false,
  localMeshEffectsAllowed: () => context.meshContext !== null && !context.meshStopped,
  data: {mesh: [], external: []}, paneInventoryIssue: 0,
  activityRanking: {}, clockOffset: 0, lastOpen: null, managing: false, panes: [],
  location: {href: '/'},
  sessionRequestGate: {consider: () => calls.push('session-actions')},
  agentMailConsentGate: {consider: () => calls.push('agent-mail')},
  // The pane envelope's mailbox and the phone's direct-writing line: outside this seam.
  mailboxPanel: {note: () => {}}, directLineAlive: () => {},
  MeshSessionActivity: {update: previous => { calls.push('activity'); return previous; }},
  isAdjacentPane: () => false, isHist: () => false,
});
for (const name of ['receiveBoardSignals', 'checkClientVersion', 'showUpdateNotice', 'markSeen',
  'invalidateReplacedDemoPanes', 'handleOpen', 'checkDemoSceneUpdates',
  'renderLists', 'renderManagement', 'renderRestore', 'pollWatched', 'pollHistory']) {
  context[name] = () => calls.push(name);
}
vm.runInContext(fs.readFileSync('static/pane-actions.js', 'utf8'), context);
context.paneTargets = context.MeshPaneActions.createTargetRegistry();
context.find = id => context.data.mesh.find(session => session.id === id);
const app = fs.readFileSync('static/app.js', 'utf8');
const start = app.indexOf('async function loadLocalInventory()');
const end = app.indexOf('// ---------------------------------------------------------------- restore after', start);
assert.ok(start > 0 && end > start, 'inventory source region exists');
vm.runInContext(app.slice(start, end), context);
vm.runInContext(app.slice(app.indexOf('function localTerminalSocketReady('), app.indexOf('class Pane {')), context);
context.requestLocal = (...args) => context.fetch(...args);
context.meshContext.inventory = context.loadLocalInventory;
const snapshot = created => ({mesh: [{kind: 'mesh', id: 't1', name: 'shell', created}],
  external: [], management: {state: 'observed'}, portfolio: {created}});
const load = value => async () => ({state: 'loaded', value});
const evidencePane = {};
const capture = created => {
  context.paneTargets.observePane({pane: evidencePane, id: 't1', name: 'shell',
    sessionId: 't1', displayName: 'shell', created, view: 1, kind: 'mesh', available: true});
  return context.paneTargets.capture(evidencePane);
};
(async () => {
  await context.refreshInventory(load(snapshot(1)));
  assert.deepEqual(calls, ['session-actions', 'agent-mail', 'activity',
    'receiveBoardSignals', 'checkClientVersion', 'showUpdateNotice', 'markSeen',
    'invalidateReplacedDemoPanes', 'checkDemoSceneUpdates', 'renderLists',
    'renderRestore', 'pollWatched', 'pollHistory']);
  const oldTarget = capture(1);
  assert.ok(oldTarget && context.paneTargets.valid(oldTarget));

  // A newer incarnation arrives before a slow, earlier inventory response.
  let releaseOld;
  const oldResponse = context.refreshInventory(() => new Promise(resolve => { releaseOld = resolve; }));
  await context.refreshInventory(load(snapshot(2)));
  assert.equal(context.paneTargets.valid(oldTarget), false);
  const currentTarget = capture(2);
  const applied = context.data;
  const appliedCalls = calls.length;
  releaseOld({state: 'loaded', value: snapshot(1)});
  await oldResponse;
  assert.equal(context.data, applied);
  assert.equal(calls.length, appliedCalls, 'late inventory cannot run auxiliary effects');
  assert.equal(context.paneTargets.valid(currentTarget), true);

  // Failure is not an authoritative empty inventory and cannot retire a target.
  for (const loader of [async () => ({state: 'unavailable'}),
    async () => ({state: 'refused'}), async () => { throw Error('offline'); },
    load({mesh: [], external: null}),
    load({...snapshot(2), mesh: [{...snapshot(2).mesh[0], created: NaN}]}),
    load({...snapshot(2), mesh: [snapshot(2).mesh[0], snapshot(2).mesh[0]]})]) {
    await context.refreshInventory(loader);
    assert.equal(context.data, applied);
    assert.equal(calls.length, appliedCalls);
    assert.equal(context.paneTargets.valid(currentTarget), true);
  }
  let cleared = 0;
  context.panes = [{id: 't1', clear: () => { cleared++; }}];
  await context.refreshInventory(load({mesh: [], external: [], management: {state: 'observed'}}));
  assert.equal(context.paneTargets.valid(currentTarget), false);
  assert.equal(cleared, 1, 'an observed empty inventory really does clear an ended pane');
  context.panes = [];

  // Default refresh still chooses the fixed local loader, including local login.
  const paths = [];
  context.fetch = async path => { paths.push(path); return {status: 200, ok: true, json: async () => snapshot(3)}; };
  assert.equal((await context.refresh()).portfolio.created, 3);
  assert.deepEqual(paths, ['/api/sessions']);
  const beforeDenied = context.data;
  context.fetch = async () => ({status: 401, ok: false});
  await context.refresh();
  assert.equal(context.location.href, '/login');
  assert.equal(context.data, beforeDenied);
  context.fetch = async () => ({status: 503, ok: false});
  await context.refresh();
  assert.equal(context.data, beforeDenied);

  // A late local login response must not navigate after disposal.
  let releaseLogin;
  context.location.href = '/stay';
  context.fetch = () => new Promise(resolve => { releaseLogin = resolve; });
  const login = context.refresh();
  context.meshStopped = true;
  releaseLogin({status: 401, ok: false});
  await login;
  assert.equal(context.location.href, '/stay');
  context.meshStopped = false;
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
    subprocess.run([node, "-e", script], cwd=root, check=True, timeout=20,
                   capture_output=True, text=True)
