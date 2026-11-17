// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The page's restore creates a plain shell offer once. A failure between the successful creation and the end of
// the path (the confirming listing fails or never answers) holds the offer, so a second click does not create
// `bravo-2`; a connection that failed before anything was sent withdraws the intent of a guarded restore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {type Lab, withLab} from './restore-exact-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const TIMEOUT = {timeout: 120000};

/** After the first successful `new` named bravo, the next `list` answers `reply`, or never answers (`hang`). */
function afterNew(mode: 'error' | 'hang') {
  let created = false;
  let spent = false;
  return (request: any) => {
    if (request.op === 'new' && request.name === 'bravo') created = true;
    else if (request.op === 'list' && created && !spent) {
      spent = true;
      return mode === 'error' ? {reply: {error: 'host broke'}} : {wait: new Promise<void>(() => {})};
    }
    return undefined;
  };
}

async function oneShell(lab: Lab): Promise<void> {
  await waitFor('the shell exists', 10000, async () => (await lab.listed()).some(s => s.name === 'bravo'));
  const second = await lab.post({names: ['bravo']});
  assert.equal(second.json.results.bravo.ok, false, second.text);
  assert.match(second.json.results.bravo.error, /sent a moment ago/);
  await new Promise(resolve => setTimeout(resolve, 1500));   // a second shell would exist by now
  assert.deepEqual((await lab.listed()).map(s => s.name), ['bravo'], 'no bravo-2');
}

test('the listing that confirms a restored shell fails: a second click creates no second shell', TIMEOUT, () => withLab(async lab => {
  const first = await lab.post({names: ['bravo']});
  assert.equal(first.status, 400, first.text);
  await oneShell(lab);
}, {intercept: afterNew('error')}));

test('the listing that confirms a restored shell never answers: a second click creates no second shell', TIMEOUT, () => withLab(async lab => {
  const first = await lab.post({names: ['bravo']});
  assert.equal(first.status, 503, first.text);
  await oneShell(lab);
}, {intercept: afterNew('hang')}));

test('a connection that fails before the send withdraws the intent of a guarded restore', TIMEOUT, () => {
  let socket = '';
  let lab!: Lab;
  return withLab(async started => {
    lab = started;
    socket = path.join(lab.mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
    const answer = await lab.exact(lab.offers.bravo);
    assert.deepEqual([answer.json.ok, answer.json.code, answer.json.phase], [false, 'launch-refused', 'not-started'],
      JSON.stringify(answer.json));
    assert.equal(lab.snapshotLost().find(entry => entry.name === 'bravo')?.restoring, undefined,
      'the intent was withdrawn: the creation was never sent, a retry is allowed');
    assert.deepEqual(await lab.listed(), [], 'nothing was created');
  }, {intercept: request => {
    // The listing made by new_session, after the intent is recorded: the next connection finds no socket.
    const bravo = lab?.snapshotLost().find(entry => entry.name === 'bravo');
    if (request.op === 'list' && bravo?.restoring && socket) fs.rmSync(socket, {force: true});
  }});
});
