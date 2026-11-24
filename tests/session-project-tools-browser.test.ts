// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

test('actual session Tools attachment: native receipts, uncertain save, project switch, offline and replacement', {skip, timeout: 90000}, async () => {
  const mesh = new TerminalMesh();
  let release = () => {};
  try {
    await mesh.start(); await mesh.newShell('project-tools');
    const headers = {Authorization: 'Bearer ' + mesh.token(), 'Content-Type': 'application/json'};
    const call = async (body: object) => {
      const response = await fetch(mesh.base + '/api/projects/v1', {method: 'POST', headers, body: JSON.stringify({version: 1, ...body})});
      assert.equal(response.status, 200); return response.json();
    };
    const capability = await call({op: 'project_capabilities'}), initial = await call({op: 'project_list'});
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    const created = await call({op: 'project_create', boot: capability.boot, expected_revision: initial.revision, request_id: first, project: {title: 'First local project'}});
    assert.equal(created.status, 'ok', JSON.stringify(created));
    const next = await call({op: 'project_create', boot: capability.boot, expected_revision: created.revision, request_id: second, project: {title: 'Second local project'}});
    assert.equal(next.status, 'ok', JSON.stringify(next));
    const read = async (id: string) => (await call({op: 'project_read', project_id: id})).project.sessions;
    const page = await mesh.openPage('project-tools', {width: 1440, height: 900});
    let loseSave = true, holdRead = false, held = false;
    const saves: string[] = [];
    const gate = new Promise<void>(resolve => {release = resolve;});
    await page.route('**/api/projects/v1', async route => {
      const body = route.request().postDataJSON();
      if (body.op === 'project_settings') {
        saves.push(body.project_id);
        if (loseSave) {loseSave = false; await route.fetch(); await route.abort(); return;}
      }
      if (body.op === 'project_read' && body.project_id === first && holdRead && !held) {
        held = true; const response = await route.fetch(); await gate; await route.fulfill({response}); return;
      }
      await route.continue();
    });
    for (const language of ['en', 'fr']) for (const width of [1440, 390]) {
      const messages = JSON.parse(fs.readFileSync(new URL(`../static/i18n/${language}.json`, import.meta.url), 'utf8'));
      await page.setViewportSize({width, height: 900});
      await page.evaluate(lang => localStorage.setItem('mesh.lang', JSON.stringify(lang)), language);
      await page.reload(); await page.waitForFunction(lang => document.documentElement.lang === lang, language);
      await page.locator('.p-tools summary').first().click();
      await page.locator('.p-tools-body button').filter({hasText: messages['artifacts.projectTitle']}).click();
      await page.getByRole('button', {name: messages['artifacts.legacyProjects'], exact:true}).click();
      const modal = page.locator('dialog.session-project-tools');
      await modal.getByText(messages['artifacts.projectNotAttached'], {exact: true}).waitFor();
      assert.ok((await modal.boundingBox())!.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.ok((await modal.getByRole('button', {name: messages['artifacts.projectAttach'], exact: true}).boundingBox())!.height >= 44);
      await page.keyboard.press('Escape'); await modal.waitFor({state: 'detached'});
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), messages['artifacts.projectTitle']);
    }
    assert.deepEqual(saves, [], 'rendering and reading never attach anything');
    await page.setViewportSize({width: 1440, height: 900});
    await page.evaluate(() => localStorage.setItem('mesh.lang', JSON.stringify('en')));
    await page.reload(); await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.locator('.p-tools summary').first().click();
    await page.locator('.p-tools-body button').filter({hasText: 'Project attachment'}).click();
    await page.getByRole('button', {name:'Legacy local projects (separate registry)', exact:true}).click();
    const dialog = page.locator('dialog.session-project-tools'), select = dialog.locator('select');
    await dialog.getByRole('button', {name: 'Attach session tools', exact: true}).waitFor();
    await select.selectOption(first);
    await page.evaluate(() => {
      const original = crypto.randomUUID;
      Object.defineProperty(crypto, 'randomUUID', {configurable: true, value: () => {throw Error('fixture ID unavailable');}});
      (window as unknown as {restoreId: () => void}).restoreId = () => Object.defineProperty(crypto, 'randomUUID', {configurable: true, value: original});
    });
    await dialog.getByRole('button', {name: 'Attach session tools', exact: true}).click();
    await dialog.getByText('Project attachment unavailable. No new save was confirmed.', {exact: true}).waitFor();
    assert.deepEqual(saves, [], 'pre-send setup failure cannot leave a write in flight');
    assert.equal(await select.isDisabled(), false, 'setup failure releases the busy state');
    await page.evaluate(() => (window as unknown as {restoreId: () => void}).restoreId());
    await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    await page.locator('.p-tools-body button').filter({hasText: 'Project attachment'}).click();
    await page.getByRole('button', {name:'Legacy local projects (separate registry)', exact:true}).click();
    await select.selectOption(first);
    await dialog.getByRole('button', {name: 'Attach session tools', exact: true}).click();
    await dialog.getByText('Save outcome unknown.', {exact: false}).waitFor();
    assert.equal(await select.isDisabled(), true);
    assert.equal((await read(first)).length, 1, 'native save happened despite lost response');
    assert.deepEqual(saves, [first], 'uncertain mutation was not replayed');
    await dialog.getByRole('button', {name: 'Check uncertain save'}).click();
    await dialog.getByText('This exact session is attached to this project.', {exact: true}).waitFor();
    await dialog.getByRole('button', {name: 'Detach session tools', exact: true}).click();
    await dialog.getByText('This exact session is not attached to this project.', {exact: true}).waitFor();
    assert.deepEqual(await read(first), []);
    await select.selectOption(second);
    await dialog.getByText('This exact session is not attached to this project.', {exact: true}).waitFor();
    holdRead = true; await select.selectOption(first);
    await waitFor('first project read held', 5000, () => held);
    await select.selectOption(second); release();
    await dialog.getByRole('button', {name: 'Attach session tools', exact: true}).click();
    await dialog.getByText('This exact session is attached to this project.', {exact: true}).waitFor();
    assert.equal(saves.at(-1), second, 'late first-project read cannot redirect the write');
    assert.deepEqual(await read(first), []);
    const references = await read(second); assert.equal(references.length, 1);
    assert.equal(references[0].machine_id, next.machine_id);
    assert.equal(fs.existsSync(path.join(mesh.home, '.config/session-mesh/notes-grants.json')), false);
    await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    // A saved operator preference selects the native local registry, not tracker IDs.
    await page.evaluate('store.set("projects.legacy", true)');
    await page.locator('#btn-projects').click();
    await page.locator('#project-sidebar-list button').filter({hasText: 'Second local project'}).click();
    const menu = page.locator('.project-session-tools details'); await menu.locator('summary').click();
    await menu.getByRole('button', {name: 'Project attachment', exact: true}).click();
    await dialog.getByRole('button', {name: 'Detach session tools', exact: true}).waitFor({state: 'visible'});
    await dialog.getByText('This exact session is attached to this project.', {exact: true}).waitFor();
    const beforeSwitch = saves.length;
    await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('#project-sidebar-list button')].find(row => row.textContent === 'First local project');
      button!.click();
    });
    await page.locator('#project-overview h2').filter({hasText: 'First local project'}).waitFor();
    await dialog.getByRole('button', {name: 'Detach session tools', exact: true}).click();
    await dialog.getByText('Project context changed.', {exact: false}).waitFor();
    assert.equal(saves.length, beforeSwitch, 'a switched project invalidates the old attachment dialog');
    assert.deepEqual(await read(second), references);
    await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    await page.locator('#project-sidebar-list button').filter({hasText: 'Second local project'}).click();
    await menu.locator('summary').click();
    await menu.locator('[data-tool="artifacts"]').click();
    await page.locator('dialog.session-artifacts').waitFor();
    await page.keyboard.press('Escape');
    const cached = await (await fetch(mesh.base + '/api/sessions', {headers})).json();
    await page.route('**/api/sessions*', route => route.fulfill({json: cached}));
    await mesh.stopHost();
    await menu.locator('[data-tool="artifacts"]').click();
    await page.getByText('Artifact references unavailable. The terminal is unaffected.', {exact: true}).waitFor();
    assert.equal(await page.locator('dialog.session-artifacts a').count(), 0);
    await page.keyboard.press('Escape');
    await mesh.restartHost(); await mesh.newShell('project-tools'); await page.unroute('**/api/sessions*'); await page.evaluate('refresh()');
    await page.waitForFunction(created => data.mesh.some((row: {name: string; created: number}) => row.name === 'project-tools' && row.created !== created), references[0].created);
    await menu.locator('[data-tool="artifacts"]').click();
    assert.equal(await page.locator('dialog.session-artifacts').count(), 0, 'same-name successor does not resolve the recorded identity');
    assert.deepEqual(await read(second), references, 'metadata is retained, never rebound by name');
    assert.equal(fs.existsSync(path.join(mesh.home, '.config/session-mesh/notes-grants.json')), false);
  } finally {release(); await mesh.stop();}
});

test('legacy project first attachment and receipt-bound project-view detach refresh', {skip, timeout: 60000}, async () => {
  const mesh = new TerminalMesh();
  try {
    await mesh.start(); await mesh.newShell('legacy-tools');
    const configFile = path.join(mesh.home, '.config/session-mesh/projects.json');
    fs.writeFileSync(configFile, JSON.stringify({kind: 'mesh-project-config', schema_version: 1, machine_id: 'legacy-machine', projects: [{id: 'legacy', title: 'Legacy project'}]}), {mode: 0o600});
    const headers = {Authorization: 'Bearer ' + mesh.token(), 'Content-Type': 'application/json'};
    const read = async () => {
      const reply = await fetch(mesh.base + '/api/projects/v1', {method: 'POST', headers, body: JSON.stringify({op: 'project_read', version: 1, project_id: 'legacy'})});
      assert.equal(reply.status, 200); return reply.json();
    };
    assert.deepEqual((await read()).project.sessions, []);
    assert.equal('sessions' in JSON.parse(fs.readFileSync(configFile, 'utf8')).projects[0], false, 'native projection does not rewrite legacy metadata');
    const page = await mesh.openPage('legacy-tools', {width: 1280, height: 900});
    const dialog = page.locator('dialog.session-project-tools');
    const paneAttach = async () => {
      if (await page.locator('.p-tools').first().getAttribute('open') === null) await page.locator('.p-tools summary').first().click();
      await page.locator('.p-tools-body button').filter({hasText: 'Project attachment'}).click();
      await page.getByRole('button', {name:'Legacy local projects (separate registry)', exact:true}).click();
      await dialog.getByText('This exact session is not attached to this project.', {exact: true}).waitFor();
      await dialog.getByRole('button', {name: 'Attach session tools', exact: true}).click();
      await dialog.getByText('This exact session is attached to this project.', {exact: true}).waitFor();
      await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    };
    await paneAttach();
    await page.evaluate('store.set("projects.legacy", true)');
    await page.locator('#btn-projects').click();
    const tools = page.locator('.project-session-tools');
    await tools.locator('details summary').waitFor();
    const detachAndCheck = async (uncertain: boolean) => {
      const before = await read();
      await tools.locator('details summary').click();
      await tools.getByRole('button', {name: 'Project attachment', exact: true}).click();
      await dialog.getByText('This exact session is attached to this project.', {exact: true}).waitFor();
      let writes = 0;
      if (uncertain) await page.route('**/api/projects/v1', async route => {
        if (route.request().postDataJSON().op === 'project_settings') {writes++; await route.fetch(); await route.abort();}
        else await route.continue();
      });
      let freshReply: {revision: string} | undefined;
      const fresh = page.waitForResponse(async response => {
        if (!response.url().endsWith('/api/projects/v1') || response.request().postDataJSON()?.op !== 'project_read') return false;
        let reply;
        try {reply = await response.json();}
        catch (error) {
          // A superseded read can lose its CDP body before this observer reads it.
          if (error instanceof Error && error.message.includes('Network.getResponseBody') &&
              error.message.includes('No data found for resource with given identifier')) return false;
          throw error;
        }
        if (reply.project?.id !== 'legacy' || reply.revision === before.revision || reply.project.sessions_total !== 0) return false;
        freshReply = reply; return true;
      }).then(() => null, error => error);
      await dialog.getByRole('button', {name: 'Detach session tools', exact: true}).click();
      if (uncertain) {
        await dialog.getByText('Save outcome unknown.', {exact: false}).waitFor();
        assert.equal(await tools.locator('details').count(), 1, 'an unconfirmed save cannot optimistically erase owner metadata');
        await dialog.getByRole('button', {name: 'Check uncertain save', exact: true}).click();
      }
      await dialog.getByText('Save confirmed.', {exact: false}).waitFor();
      const readError = await fresh; if (readError) throw readError;
      assert.ok(freshReply); assert.notEqual(freshReply.revision, before.revision);
      await tools.getByText('No session tools are attached to this local Mesh project.', {exact: true}).waitFor();
      assert.equal(await tools.locator('details, [data-tool="artifacts"]').count(), 0, 'confirmed detach removes the working row without navigation');
      if (uncertain) {assert.equal(writes, 1); await page.unroute('**/api/projects/v1');}
      await dialog.getByRole('button', {name: 'Close', exact: true}).click();
    };
    await detachAndCheck(false);
    await page.locator('#projects-return').click(); await paneAttach();
    await page.locator('#btn-projects').click(); await tools.locator('details summary').waitFor();
    await detachAndCheck(true);
    assert.equal(fs.existsSync(path.join(mesh.home, '.config/session-mesh/notes-grants.json')), false);
  } finally {await mesh.stop();}
});

declare const data: {mesh: {name: string; created: number}[]};
