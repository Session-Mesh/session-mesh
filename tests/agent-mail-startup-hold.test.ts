// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Mail is never pruned while the web server has not yet read the PTY host's list and written the snapshot with the
// restore offers (__main__ calls agentmail.hold_pruning; the first durable snapshot releases it). Proven by the real
// start of server.py, not by calling the function: an agent that ends right after start must keep the mail sent to
// it until a snapshot lists it as lost, so that its restore offer can still bring the mail back. The first
// snapshot is written 10 s after the start (snapshot_loop) when no page asks sooner, so this runs within that window.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';

const WINDOW_MS = 8000;

test('the mail of an agent that ended right after start is kept: pruning is held until the first snapshot', {timeout: 120000}, async () => {
  const began = Date.now();
  const lab = await AgentMesh.start('hold-', ['alpha', 'beta']);
  try {
    const [alpha, beta] = [lab.agents.alpha!, lab.agents.beta!];
    await lab.send(alpha, beta, 'for beta, who is about to end');
    const killed = await fetch(`${lab.mesh.base}/api/kill/beta`, {method: 'POST',
      headers: {Authorization: `Bearer ${lab.mesh.token()}`, Origin: lab.mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({created: beta.created})});
    assert.equal(killed.status, 200, await killed.text());
    await lab.inbox(alpha);   // an agent operation prunes what no live incarnation or offer can receive
    const left = (JSON.parse(fs.readFileSync(path.join(lab.mesh.confDir, 'agent-mail.json'), 'utf8')) as {messages: unknown[]}).messages.length;
    assert.ok(Date.now() - began < WINDOW_MS + 4000, 'the check ran inside the start-up window (before the first snapshot)');
    assert.equal(left, 1, 'the message to the vanished incarnation was not pruned while the start-up hold was on');
  } finally {
    await lab.stop();
  }
});
