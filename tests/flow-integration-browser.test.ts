// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
import {REPO} from './mesh-server-lib.ts';

const chrome = process.env.MESH_CHROMIUM ?? '';
const helper = process.env.MESH_MESH_HISTORY_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const skip = !chrome && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

test('the real Mesh page displays an accepted deposit without implying consent or delivery', {skip}, async () => {
  const hasHistory = fs.existsSync(helper);
  if (hasHistory) process.env.MESH_MESH_HISTORY_CMD = helper;
  const lab = await AgentMesh.start('flow-browser-', ['alpha', 'beta']);
  let browser;
  try {
    const message = await lab.send(lab.agents.alpha!, lab.agents.beta!, 'private test message');
    const request = (await lab.consent()).requests.find(request => request.message_id === message);
    assert.ok(request, 'the owner decision is pending');
    const read = await lab.readAs(lab.agents.beta!, message);
    assert.equal(read.status, 202, 'the message body still requires owner consent');
    assert.doesNotMatch(await read.text(), /private test message/);
    const decision = await lab.decide(request.id, 'no');
    assert.equal(decision.status, 200, await decision.clone().text());
    assert.equal((await lab.readAs(lab.agents.beta!, message)).status, 404,
      'refusing consent removes the unread message');
    browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));
    const page = await browser.newPage({locale: 'en-US', viewport: {width: 1400, height: 900}});
    // Browser CI provides the native PTY host but not mesh-history. Keep the
    // real mailbox and page there, and supply only the journal response; local
    // runs with mesh-history exercise the complete server-to-journal path.
    if (!hasHistory) await page.route('**/api/flow/events', route => route.fulfill({json: {
      truncated: false, events: [{id: message, kind: 'message', time: Date.now() / 1000,
        source: {id: 'alpha', created: lab.agents.alpha!.created, agent: 'claude'},
        target: {id: 'beta', created: lab.agents.beta!.created, agent: 'claude'}}],
    }}));
    await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
    await page.goto(`${lab.mesh.base}/#alpha`);
    assert.equal(await page.locator('link[href^="/static/flow.css?v="]').count(), 1,
      'the flow stylesheet is cache-versioned');
    await page.locator('#btn-flow').click();
    await page.getByRole('button', {name: 'All Mesh', exact: true}).click();
    const event = page.locator('.flow-event-row').filter({hasText: 'alpha'}).filter({hasText: 'beta'}).first();
    await event.waitFor({state: 'visible'});
    assert.match(await event.innerText(), /Message deposited/);
    await event.click();
    assert.match(await page.locator('.flow-detail').innerText(), /Owner consent, delivery of the message content and reading are not confirmed/);
    assert.doesNotMatch(await page.locator('#flow').innerText(), /private test message/);
    await page.getByRole('button', {name: 'Connections', exact: true}).click();
    assert.equal(await page.locator('.flow-graph-node').count(), 2);
  } finally {
    await browser?.close();
    await lab.stop();
  }
});
