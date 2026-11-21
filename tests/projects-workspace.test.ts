// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { REPO, scratchHome, runServer, stopServer } from './mesh-server-lib.ts';
import { parseProjectConfig } from '../static/project-catalog.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const NATIVE = process.env.MESH_NATIVE_PTYHOST || '';
const CHROMIUM = process.env.MESH_CHROMIUM || '';
const skip = !NATIVE && !process.env.MESH_REQUIRE_NATIVE_PROJECTS
  ? 'native browser composition requires explicit MESH_NATIVE_PTYHOST' : false;
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await done; clearTimeout(timer);
}
async function socketReady(file: string) {
  for (let i = 0; i < 200; i++) {
    const ready = await new Promise<boolean>(resolve => {
      const socket = net.connect(file, () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('isolated native host did not listen');
}
async function enter(page: Page, mobile: boolean) {
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');await page.evaluate('store.set("projects.legacy", true)');
  if (mobile) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#btn-new')?.disabled);
}
async function login(context: BrowserContext, origin: string, token: string) {
  const response = await context.request.post(origin + '/login', { form: { token } });
  assert.ok(response.ok());
}
async function evidence(page: Page, width: number) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const output = process.env.MESH_PROJECT_EVIDENCE;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, `native-project-${width}.png`), fullPage: true });
  }
}

test('owner API persists pipeline source creation and selector changes without weakening field validation',
  {skip, timeout: 90000}, async () => {
    assert.ok(NATIVE && process.env.MESH_PYTHON, 'explicit native host and isolated test Python required');
    const where = await scratchHome('mps.');
    const pipelineRoot = path.join(where.home, 'pipeline');
    fs.mkdirSync(path.join(pipelineRoot, 'briefs'), {recursive: true});
    fs.writeFileSync(path.join(pipelineRoot, 'briefs', 'mesh-roster-observation-state.json'), JSON.stringify({
      task: 'mesh-roster-observation', mode: 'fast', current_phase: 'implement',
      events: [{phase: 'implement', outcome: 'COMPLETED'}],
    }));
    const pipelineCLI = process.env.MESH_I1_ROSTER_ENTRY
      ? path.join(path.dirname(process.env.MESH_I1_ROSTER_ENTRY), 'roster-pipeline.cjs') : undefined;
    const host = spawn(NATIVE, [], {cwd: REPO, env: {...where.env,
      MESH_PROJECT_OBSERVATION_RUNTIME: process.execPath,
      MESH_PROJECT_OBSERVATION_ENTRY: path.join(REPO, 'tools', 'project-observation.mjs'),
      MESH_PROJECT_ROSTER_PIPELINE_CLI: pipelineCLI}, stdio: 'ignore'});
    let server: ChildProcess | undefined;
    try {
      await socketReady(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock'));
      const launched = await runServer(where); server = launched.child;
      assert.ok(launched.result.listened, launched.result.output);
      const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
      const call = async (body: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${where.port}/api/projects/v1`, {
          method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({version: 1, ...body}),
        });
        assert.equal(response.status, 200); return response.json();
      };
      const capabilities = await call({op: 'project_capabilities'}), initial = await call({op: 'project_list'});
      const id = crypto.randomUUID(), created = await call({op: 'project_create', boot: capabilities.boot,
        expected_revision: initial.revision, request_id: id, project: {title: 'Pipeline source project'}});
      assert.equal(created.status, 'ok');
      const selector = {kind: 'pipeline', root: pipelineRoot, task: 'mesh-roster-observation'};
      const put = {type: 'put', id: 'roster-compatibility', kind: 'roster', label: 'Roster compatibility', selector};
      const mutate = (revision: string, sourceChange: unknown, observation?: unknown) => call({op: 'project_settings', boot: capabilities.boot,
        expected_revision: revision, request_id: crypto.randomUUID(), project_id: id,
        patch: {source_changes: [sourceChange], ...(observation ? {observation} : {})}});
      const saved = await mutate(created.revision, put);
      assert.equal(saved.status, 'ok', JSON.stringify(saved));
      const readSource = async () => (await call({op: 'project_read', project_id: id,
        settings: {kind: 'source', source_id: put.id}})).observation_settings.source;
      assert.deepEqual((await readSource()).selector, selector);
      const board = {kind: 'board', path: path.join(where.home, 'board')};
      const changed = await mutate(saved.revision, {type: 'selector', id: put.id, selector: board});
      assert.equal(changed.status, 'ok', JSON.stringify(changed));
      assert.deepEqual((await readSource()).selector, board);
      const restored = await mutate(changed.revision, {type: 'selector', id: put.id, selector},
        {repository: false, source_ids: [put.id]});
      assert.equal(restored.status, 'ok', JSON.stringify(restored));
      const source = await readSource();
      assert.deepEqual(source.selector, selector); assert.equal(source.label, put.label);
      const registry = path.join(where.confDir, 'projects.json'), before = fs.readFileSync(registry);
      for (const bad of [
        {...selector, root: 'relative'}, {...selector, task: ''}, {...selector, task: 'Bad_task'},
        {...selector, extra: 'unsupported'},
      ]) {
        const refused = await mutate(restored.revision, {type: 'selector', id: put.id, selector: bad});
        assert.equal(refused.status, 'refused'); assert.deepEqual(fs.readFileSync(registry), before);
      }
      const emptyLabel = await mutate(restored.revision, {...put, label: ''});
      assert.equal(emptyLabel.status, 'refused'); assert.deepEqual(fs.readFileSync(registry), before);
      if (pipelineCLI) {
        const inventory = await call({op: 'project_list'}), requestId = crypto.randomUUID();
        const started = await call({op: 'project_observation_start', boot: capabilities.boot,
          machine_id: inventory.machine_id, project_id: id, expected_revision: restored.revision, request_id: requestId});
        assert.equal(started.status, 'ok', JSON.stringify(started));
        const identity = {boot: capabilities.boot, machine_id: inventory.machine_id, project_id: id,
          requested_revision: restored.revision, request_id: requestId, observation_id: started.observation_id};
        const deadline = Date.now() + 15000;
        let status;
        do {
          status = await call({op: 'project_observation_status', ...identity});
          assert.ok(!['failed', 'cancelled', 'cleanup-pending'].includes(status.observation_state), JSON.stringify(status));
          if (status.observation_state === 'complete') break;
          await new Promise(resolve => setTimeout(resolve, 30));
        } while (Date.now() < deadline);
        assert.equal(status.observation_state, 'complete');
        const page = await call({op: 'project_observation_page', ...identity, page_index: 0});
        const catalog = JSON.parse(Buffer.from(page.data_base64, 'base64').toString('utf8'));
        const observed = catalog.projects[0].sources.find(item => item.id === put.id);
        assert.equal(observed.status, 'available', JSON.stringify(observed));
        assert.equal(observed.summary.pipeline.latest_completed.phase, 'implement');
        assert.equal(observed.summary.pipeline.latest_completed.outcome, 'COMPLETED');
      }
    } finally {
      if (server) await stopServer(server); await stop(host);
      fs.rmSync(where.scratch, {recursive: true, force: true});
    }
  });

for (const width of [1280, 390]) test(`actual native Projects create/settings/conflict/reconcile and Sessions at ${width}px`,
  { skip, timeout: 120000 }, async () => {
    assert.ok(NATIVE && CHROMIUM && process.env.MESH_PYTHON, 'explicit native binary, isolated Chromium and test Python required');
    const where = await scratchHome('mesh-project-workspace-');
    fs.mkdirSync(where.confDir, { recursive: true, mode: 0o700 });
    const quietShell = path.join(where.home, 'quiet-shell');
    fs.writeFileSync(quietShell, '#!/bin/sh\nif [ "$1" = "-lc" ] || [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh\n', { mode: 0o700 });
    const quietSession = path.join(where.home, 'quiet-session');
    fs.writeFileSync(quietSession, '#!/bin/sh\ni=0\nwhile [ "$i" -lt 100 ]; do printf "line %s\\n" "$i"; i=$((i+1)); done\nwhile IFS= read -r value; do printf "reply:%s\\n" "$value"; done\n', { mode: 0o700 });
    const hostEnv = { ...where.env, SHELL: quietShell };
    let host = spawn(NATIVE, [], { cwd: REPO, env: hostEnv, stdio: 'ignore' });
    let server: ChildProcess | undefined;
    let browser;
    try {
      await socketReady(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock'));
      const launched = await runServer(where); server = launched.child; assert.ok(launched.result.listened, launched.result.output);
      const origin = `http://127.0.0.1:${where.port}`;
      const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
      browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
      const a = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', hasTouch: width === 390 });
      const b = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
      await login(a, origin, token); await login(b, origin, token);
      const createdSession = await a.request.post(origin + '/api/new', { data: {
        name: 'p1-quiet', cwd: where.home, preset: 'custom', command: `/bin/sh '${quietSession.replace(/'/g, "'\\''")}'` } });
      assert.equal(createdSession.status(), 200, await createdSession.text());
      const page = await a.newPage(), other = await b.newPage();
      const foreign: string[] = [];
      page.on('request', request => { if (new URL(request.url()).origin !== origin) foreign.push(request.url()); });
      await page.goto(origin); await page.waitForFunction(() => typeof panes !== 'undefined' && panes.length > 0);
      await page.waitForFunction(() => {
        if (typeof meshContext === 'undefined' || meshContext === null) return false;
        const session = find('p1-quiet');
        return session?.kind === 'mesh' && rowAuthoritative(session);
      });
      await page.evaluate('openSession("p1-quiet")');
      await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && active.term.buffer.active.length > 80);
      await page.evaluate(`(() => {
        active.noteUserScroll(false); active.term.scrollToLine(20);
        document.querySelector('#line-text').value='native pending draft';
        document.querySelector('#line-text').dispatchEvent(new Event('input',{bubbles:true}));
        window.p1Saved={pane:active,term:active.term,conn:active.conn,id:active.id,target:paneTargets.capture(active,true),viewport:active.term.buffer.active.viewportY};
      })()`);
      await enter(page, width === 390);
      if (width === 390) await page.getByRole('button', { name: 'New project', exact: true }).click();
      else await page.locator('#btn-new').click();
      await page.getByLabel('Project name', { exact: true }).fill('Research notebook');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await page.locator('#project-overview h2').filter({ hasText: 'Research notebook' }).waitFor();
      const configFile = path.join(where.confDir, 'projects.json');
      const original = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      assert.equal(original.projects.length, 1);
      const id = original.projects[0].id, machine = original.machine_id;
      assert.equal(parseProjectConfig(original), null, 'legacy base parser refuses new native feature without rewriting');
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).projects[0].id, id);
      await other.goto(origin); await enter(other, false);
      await other.locator('#project-overview h2').filter({ hasText: 'Research notebook' }).waitFor();
      await page.getByRole('button', { name: 'Project settings', exact: true }).click();
      await other.getByRole('button', { name: 'Project settings', exact: true }).click();
      await other.getByLabel('Project name', { exact: true }).fill('Shared notebook');
      const folders = [path.join(where.home, 'context-one'), path.join(where.home, 'context-two')];
      await other.getByLabel('Local folders', { exact: false }).fill(folders.join('\n'));
      await other.getByLabel('Repository URL', { exact: false }).fill('https://example.invalid/team/notebook');
      await other.getByRole('button', { name: '+ Source or workflow', exact: true }).click();
      await other.getByLabel('Reference label', { exact: true }).fill('Release workflow');
      await other.getByRole('button', { name: 'Save settings', exact: true }).click();
      await other.locator('#project-overview h2').filter({ hasText: 'Shared notebook' }).waitFor();
      await page.getByLabel('Description', { exact: false }).fill('Stale draft must not overwrite newer context');
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await page.getByRole('dialog').getByText('Saved settings changed.', { exact: false }).waitFor();
      const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      assert.equal(saved.projects[0].id, id); assert.equal(saved.machine_id, machine);
      assert.equal(saved.projects[0].title, 'Shared notebook'); assert.deepEqual(saved.projects[0].folders, folders);
      assert.equal(saved.projects[0].sources[0].label, 'Release workflow');
      if (process.env.MESH_PROJECT_EVIDENCE) {
        fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE, { recursive: true });
        fs.writeFileSync(path.join(process.env.MESH_PROJECT_EVIDENCE, `native-created-config-${width}.json`), JSON.stringify(saved), { mode: 0o600 });
      }
      for (const folder of folders) assert.equal(fs.existsSync(folder), false, 'folder references remain inert');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('#projects-return').click();
      assert.equal(await page.evaluate('active===p1Saved.pane && active.term===p1Saved.term && active.conn===p1Saved.conn && paneTargets.valid(p1Saved.target) && active.id===p1Saved.id'), true);
      assert.equal(await page.locator('#line-text').inputValue(), 'native pending draft');
      assert.equal(await page.evaluate('active.term.buffer.active.viewportY === p1Saved.viewport'), true);
      await page.evaluate('active.term.focus()');
      await page.keyboard.type('p1-marker');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Array.from({length:active.term.buffer.active.length},(_,i)=>active.term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('reply:p1-marker'));
      await enter(page, width === 390);
      await page.locator('#project-overview h2').filter({ hasText: 'Shared notebook' }).waitFor();
      await evidence(page, width);
      assert.deepEqual(foreign, []);

      // A real native commit reaches the server; only its browser acknowledgement is dropped.
      await page.route('**/api/projects/v1', async route => {
        const body = route.request().postDataJSON();
        if (body.op === 'project_create') { const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); }
        else await route.continue();
      });
      if (width === 390) { await page.locator('#btn-menu').click(); await page.locator('#btn-new').click(); }
      else await page.locator('#btn-new').click();
      await page.getByLabel('Project name', { exact: true }).fill('Lost acknowledgement');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await page.getByRole('button', { name: 'Check saved state', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false, 'submitted project save must leave its uncertain-state controls accessible in the main display');
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).projects.length, 2);
      await page.unroute('**/api/projects/v1');
      await page.getByRole('button', { name: 'Check saved state', exact: true }).click();
      await page.locator('#project-overview h2').filter({ hasText: 'Lost acknowledgement' }).waitFor();
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).projects.length, 2);
      await a.close(); await b.close();
      await stop(host);
      host = spawn(NATIVE, [], { cwd: REPO, env: hostEnv, stdio: 'ignore' });
      await socketReady(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock'));
      const c = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
      await login(c, origin, token);
      const restored = await c.newPage(); await restored.goto(origin); await enter(restored, width === 390);
      await restored.locator('#project-overview h2').filter({ hasText: 'Shared notebook' }).waitFor();
      const after = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      assert.equal(after.machine_id, machine); assert.equal(after.projects[0].id, id); assert.equal(after.projects.length, 2);

      // A complete native-supported context must stay editable at the browser boundary.
      const call = async (body: Record<string, unknown>) => {
        const reply = await c.request.post(origin + '/api/projects/v1', {data:{version:1,...body}});
        assert.equal(reply.status(),200); return reply.json();
      };
      const cap = await call({op:'project_capabilities'}), list = await call({op:'project_list'});
      const edgeId = crypto.randomUUID(), edgeFolders = Array.from({length:21},(_,i)=>'/context-'+i);
      edgeFolders[0] += ' ';
      const edgeTitle = 'Boundary\ncontext', edgeDescription = 'First\r\nSecond', edgeLabel = 'Road\nmap';
      const edge = await call({op:'project_create',boot:cap.boot,expected_revision:list.revision,request_id:edgeId,
        project:{title:edgeTitle,description:edgeDescription,folders:edgeFolders,
          sources:Array.from({length:20},(_,i)=>({id:'source_'+i,kind:'roster',label:i===1?edgeLabel:'Source '+i}))}});
      assert.equal(edge.status,'ok');
      if(width===390) await restored.locator('#btn-menu').click();
      await restored.locator('#project-refresh').click();
      await restored.locator('#project-sidebar-list').getByRole('button',{name:'Boundary context',exact:true}).click();
      await restored.getByRole('button',{name:'Project settings',exact:true}).click();
      await restored.getByLabel('Repository URL',{exact:false}).fill('https://example.invalid/context');
      const repositoryChanged = restored.waitForResponse(response => response.url().endsWith('/api/projects/v1') &&
        response.request().postDataJSON()?.op==='project_settings');
      await restored.getByRole('button',{name:'Save settings',exact:true}).click();
      const repositoryReply = await repositoryChanged;
      assert.equal((await repositoryReply.json()).status,'ok');
      assert.deepEqual(repositoryReply.request().postDataJSON().patch,{repository:{url:'https://example.invalid/context'}},
        'repository-only edit must not serialize DOM-normalized values');
      const untouched = JSON.parse(fs.readFileSync(configFile,'utf8')).projects.find(project=>project.id===edgeId);
      assert.deepEqual(Buffer.from(untouched.title),Buffer.from(edgeTitle));
      assert.deepEqual(Buffer.from(untouched.description),Buffer.from(edgeDescription));
      assert.deepEqual(Buffer.from(untouched.sources[1].label),Buffer.from(edgeLabel));
      assert.deepEqual(untouched.folders,edgeFolders);
      await restored.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#btn-new')?.disabled);
      await restored.getByRole('button',{name:'Project settings',exact:true}).click();
      await restored.getByLabel('Project name',{exact:true}).fill('Boundary renamed');
      await restored.locator('.project-source-fields').first().getByRole('button',{name:'Remove',exact:true}).click();
      await restored.getByRole('button',{name:'+ Source or workflow',exact:true}).click();
      await restored.locator('.project-source-fields').last().getByLabel('Reference label',{exact:true}).fill('Replacement');
      const changed = restored.waitForResponse(response => response.url().endsWith('/api/projects/v1') &&
        response.request().postDataJSON()?.op==='project_settings');
      await restored.getByRole('button',{name:'Save settings',exact:true}).click();
      const changedReply = await changed;
      assert.equal((await changedReply.json()).status,'ok');
      const patch = changedReply.request().postDataJSON().patch;
      assert.equal(patch.source_changes.length,2,'only new source and removed source are mutated');
      assert.equal(patch.folders,undefined,'unchanged21 folders are preserved');
      await restored.locator('#project-overview h2').filter({hasText:'Boundary renamed'}).waitFor();
      const savedEdge = JSON.parse(fs.readFileSync(configFile,'utf8')).projects.find(project=>project.id===edgeId);
      assert.deepEqual(savedEdge.folders,edgeFolders); assert.equal(savedEdge.sources.length,20);
      assert.equal(savedEdge.sources.some(source=>source.id==='source_0'),false);
      assert.equal(savedEdge.sources.filter(source=>source.label==='Replacement').length,1);
      assert.deepEqual(Buffer.from(savedEdge.description),Buffer.from(edgeDescription));
      assert.deepEqual(Buffer.from(savedEdge.sources.find(source=>source.id==='source_1').label),Buffer.from(edgeLabel));
      await restored.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#btn-new')?.disabled);
      await restored.getByRole('button',{name:'Project settings',exact:true}).click();
      const addedFolders = [...edgeFolders,'/context-added'];
      await restored.getByLabel('Local folders',{exact:false}).fill(addedFolders.join('\n'));
      const foldersChanged = restored.waitForResponse(response => response.url().endsWith('/api/projects/v1') &&
        response.request().postDataJSON()?.op==='project_settings');
      await restored.getByRole('button',{name:'Save settings',exact:true}).click();
      const foldersReply = await foldersChanged;
      assert.equal((await foldersReply.json()).status,'ok');
      assert.deepEqual(foldersReply.request().postDataJSON().patch,{folders:addedFolders},
        'adding a folder must preserve existing trailing whitespace and unrelated raw text');
      const folderSaved = JSON.parse(fs.readFileSync(configFile,'utf8')).projects.find(project=>project.id===edgeId);
      assert.deepEqual(folderSaved.folders,addedFolders);
      assert.deepEqual(Buffer.from(folderSaved.description),Buffer.from(edgeDescription));
      assert.deepEqual(Buffer.from(folderSaved.sources.find(source=>source.id==='source_1').label),Buffer.from(edgeLabel));
      await c.close();
    } finally {
      await browser?.close(); if (server) await stopServer(server); await stop(host);
      fs.rmSync(where.scratch, { recursive: true, force: true });
    }
  });

// Real I1 host/collector composition: browser selects saved metadata, never supplies executable or output paths.
const REAL_ROSTER = !!process.env.MESH_I1_ROSTER_ENTRY && !!process.env.MESH_I1_ROSTER_BOARD;
for (const width of [1280, 390]) test(`actual I1 native typed repository ${REAL_ROSTER ? 'and public Roster observation renders real README and work' : 'Git-only observation renders real README (external Roster extension not configured)'} at ${width}px`, { skip, timeout: 90000 }, async () => {
  assert.ok(NATIVE && CHROMIUM && process.env.MESH_PYTHON, 'explicit native binary, isolated Chromium and test Python required');
  const entry = path.join(REPO, 'tools/project-observation.mjs'); assert.ok(fs.existsSync(entry), 'root-built I1 collector entry required');
  const where = await scratchHome('mi1.B.');
  const { execFileSync } = await import('node:child_process');
  const repository = path.join(where.home, 'repository'); fs.mkdirSync(repository, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  const readme = '# Real I1 project\n\nActual repository evidence — 🌍\n'; fs.writeFileSync(path.join(repository, 'README.md'), readme);
  git('add', 'README.md'); git('-c', 'user.name=I1 Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Authored observation fixture');
  const commit = git('rev-parse', 'HEAD').trim();
  const rosterEntry = process.env.MESH_I1_ROSTER_ENTRY, rosterBoard = process.env.MESH_I1_ROSTER_BOARD;
  assert.equal(!!rosterEntry, !!rosterBoard, 'real Roster extension requires both explicit entry and board');
  if (REAL_ROSTER) assert.ok(rosterEntry && rosterBoard && fs.existsSync(rosterEntry) && fs.existsSync(rosterBoard), 'configured public Roster entry and actual board must exist');
  const rosterLauncher = path.join(where.home, 'roster-view');
  if (rosterEntry) fs.writeFileSync(rosterLauncher, '#!/bin/sh\nexec /usr/bin/node ' + "'" + rosterEntry.replace(/'/g, "'\\''") + "'" + ' "$@"\n', { mode: 0o700 });
  const quietShell = path.join(where.home, 'quiet-shell'); fs.writeFileSync(quietShell, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
  const host = spawn(NATIVE, [], { cwd: REPO, env: { ...where.env, SHELL: quietShell,
    MESH_PROJECT_OBSERVATION_RUNTIME: '/usr/bin/node', MESH_PROJECT_OBSERVATION_ENTRY: entry, MESH_PROJECT_ROSTER_CLI: REAL_ROSTER ? rosterLauncher : undefined }, stdio: 'ignore' });
  let server: ChildProcess | undefined; let browser;
  try {
    await socketReady(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock'));
    const launched = await runServer(where); server = launched.child; assert.ok(launched.result.listened, launched.result.output);
    const origin = `http://127.0.0.1:${where.port}`, token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', hasTouch: width === 390 });
    await login(context, origin, token);
    const created = await context.request.post(origin + '/api/new', { data: { name: 'i1-live', cwd: where.home, preset: 'custom', command: '/bin/cat' } });
    assert.equal(created.status(), 200, await created.text());
    const page = await context.newPage();
    // Run only settled context-refresh deadlines deterministically; native capture polling stays real.
    await page.addInitScript(() => {
      const timers = new Map<number, { action: TimerHandler; delay: number }>();
      const start = window.setTimeout.bind(window), stop = window.clearTimeout.bind(window);
      window.setTimeout = ((action: TimerHandler, delay = 0, ...args: unknown[]) => {
        const id = start(action, delay, ...args); if (delay >= 1000 && delay <= 300000) timers.set(id, { action, delay }); return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = id => { timers.delete(id!); stop(id); };
      window.tickProjectContext = (delay: number) => {
        for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); stop(id); if (typeof timer.action === 'function') timer.action(); }
      };
      window.projectContextDeadlines = () => [...timers.values()].map(timer => timer.delay);
    });
    await page.goto(origin);
    await page.waitForFunction(() => typeof panes !== 'undefined' && panes.length > 0);
    await page.waitForFunction(() => {
      if (typeof meshContext === 'undefined' || meshContext === null) return false;
      const session = find('i1-live');
      return session?.kind === 'mesh' && rowAuthoritative(session);
    });
    await page.evaluate('openSession("i1-live")');
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen());
    await page.evaluate('window.i1Saved={pane:active,term:active.term,conn:active.conn,target:paneTargets.capture(active,true)}');
    const requests: Record<string, unknown>[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/projects/v1')) requests.push(request.postDataJSON()); });
    // Keep automatic admission pending long enough to exercise concurrent manual refresh.
    await page.route('**/api/projects/v1', async route => {
      if (route.request().postDataJSON()?.op === 'project_observation_start') {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await route.continue();
    });
    await enter(page, width === 390);
    if (width === 390) await page.getByRole('button', { name: 'New project', exact: true }).click(); else await page.locator('#btn-new').click();
    await page.getByLabel('Project name', { exact: true }).fill('Observed repository');
    const description = 'A long project description coordinates repository activity, project work, private feedback and release preparation across many sessions. '.repeat(6);
    await page.getByLabel('Description', { exact: false }).fill(description);
    await page.locator('dialog details summary').click();
    await page.getByLabel('Repository URL', { exact: false }).fill('https://example.invalid/i1/repo');
    await page.getByLabel('Local repository path', { exact: true }).fill(repository);
    await page.getByLabel('Primary ref (blank: cached origin HEAD)', { exact: true }).fill('refs/heads/main');
    await page.getByLabel('Observe repository', { exact: true }).check();
    if (REAL_ROSTER) {
      await page.getByRole('button', { name: '+ Source or workflow', exact: true }).click();
      await page.getByLabel('Reference label', { exact: true }).fill('Native roadmap');
    }
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.locator('#project-overview h2').filter({ hasText: 'Observed repository' }).waitFor();
    assert.equal(await page.locator('.project-context-disclosure').evaluate((node: HTMLDetailsElement) => node.open), false,
      'settings references must not occupy the dashboard by default');
    const saved = JSON.parse(fs.readFileSync(path.join(where.confDir, 'projects.json'), 'utf8'));
    assert.equal(saved.projects[0].repository.local_path, repository); assert.deepEqual(saved.projects[0].observation, { repository: true, source_ids: [] });
    await page.waitForFunction(() => !!document.querySelector('.cockpit-tabs'));
    await page.getByRole('button', { name: 'Refresh project context', exact: true }).click();
    await page.locator('.projects-readme-preview').waitFor({ state: 'attached', timeout: 15000 });
    assert.equal(requests.filter(value => value.op === 'project_observation_start').length, 1,
      'selecting the saved project loads configured context once; concurrent manual refresh shares the admission');
    if (REAL_ROSTER) {
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('button', { name: 'Configure Native roadmap', exact: true }).click();
    await page.getByLabel('Roster source type', { exact: true }).selectOption('board');
    await page.getByLabel('Local board file or pipeline root', { exact: true }).fill(rosterBoard!);
    await page.getByLabel('Observe Native roadmap', { exact: true }).check();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.locator('.project-observation .projects-readme-preview').waitFor({ state: 'attached', timeout: 10000 }).catch(async failure => { throw Error(String(failure) + ' status=' + await page.locator('.project-observation').innerText() + ' calls=' + requests.map(value => value.op).join(',')); });
    if (REAL_ROSTER) await page.locator('.cockpit-source-title').filter({ hasText: 'Native roadmap' }).waitFor();
    assert.equal(await page.locator('.cockpit-tabs [aria-current="true"]').textContent(), 'Overview');
    assert.equal(await page.locator('.cockpit-overview-grid .cockpit-card').count(), 4);
    assert.equal(await page.locator('.project-context-settings').isVisible(), false, 'configuration stays in Sources');
    assert.equal(await page.locator('.project-context-panel').first().textContent().then(text => text?.includes(description)), true,
      'the full saved description remains available in project context');
    if (REAL_ROSTER) {
      await page.locator('.cockpit-source-title').filter({ hasText: 'Native roadmap' }).waitFor();
      if (process.env.MESH_PROJECT_EVIDENCE) await page.screenshot({ path: path.join(process.env.MESH_PROJECT_EVIDENCE, `approved-overview-${width}.png`), fullPage: true });
      const overviewTask = await page.locator('.cockpit-work-row small').first().textContent();
      await page.locator('.cockpit-work-row').first().click();
      assert.equal(await page.locator('.cockpit-tabs [aria-current="true"]').textContent(), 'Work');
      assert.ok((await page.locator('.project-followup-row > button[aria-pressed="true"]').textContent())?.startsWith(overviewTask + ' · '),
        'overview task links open the exact task rather than the default task');
      await page.locator('#projects').evaluate(node => { node.scrollTop = 0; });
      const first = await page.locator('.project-observation .project-followup-row').first().boundingBox();
      assert.ok(first && first.y >= 0 && first.y + first.height <= 836, 'the first real task is fully visible above the viewport fold with a long description');
      assert.equal(await page.locator('.project-observation [data-followup-key="view-mode"]').inputValue(), 'summary');
      assert.equal(await page.locator('.project-observation .project-followup-zoom').count(), 0, 'summary does not expose irrelevant zoom');
      if (await page.locator('.project-observation .project-followup-row').count() < 50)
        assert.equal(await page.locator('.project-observation .project-followup-pages').count(), 0, 'single-page work lists do not expose useless paging');
      const initialEvidence = process.env.MESH_PROJECT_EVIDENCE;
      if (initialEvidence) {
        fs.mkdirSync(initialEvidence, { recursive: true });
        await page.screenshot({ path: path.join(initialEvidence, `i1-first-viewport-${width}.png`) });
        fs.writeFileSync(path.join(initialEvidence, `i1-first-viewport-${width}.json`), JSON.stringify({ width, height: 900, descriptionLength: description.length, firstTask: first, mode: 'summary' }, null, 2));
      }
    }
    assert.equal(await page.locator('.project-observation .projects-readme-disclosure').evaluate((node: HTMLDetailsElement) => node.open), false,
      'README remains secondary rather than opening ahead of current work');
    await page.locator('[data-cockpit-tab="repository"]').click();
    if (!await page.locator('.project-observation .projects-readme-disclosure').evaluate((node: HTMLDetailsElement) => node.open)) await page.locator('.project-observation .projects-readme-disclosure > summary').click();
    await page.locator('.project-observation .projects-readme-preview[data-markdown-state="rendered"]').waitFor();
    assert.equal(await page.locator('.project-observation .projects-readme-preview h1').textContent(), 'Real I1 project');
    assert.match(await page.locator('.project-observation .projects-readme-preview').textContent() ?? '', /Actual repository evidence — 🌍/);
    assert.match(await page.locator('.projects-repository-observation').textContent() ?? '', new RegExp(commit));
    await page.locator('.project-observation .projects-readme-disclosure > summary').click();
    if (REAL_ROSTER) {
    await page.locator('[data-cockpit-tab="work"]').click();
    await page.locator('.project-observation .project-followup').waitFor();
    assert.equal(await page.locator('.project-observation .project-work-heading h3').textContent(), 'Native roadmap · Roster');
    assert.ok(await page.locator('.project-observation .project-work-metrics dd').count() > 0, 'available source counts remain visible above the work list');
    assert.ok(await page.locator('.project-observation .project-followup-row').count() > 0, 'real Roster tasks render through native collector');
    assert.ok(await page.locator('.project-observation').evaluate(node => !!(node.querySelector('.project-followup')!.compareDocumentPosition(node.querySelector('.projects-repository-observation')!) & Node.DOCUMENT_POSITION_FOLLOWING)),
      'actual Roster work is rendered before repository reading');
    await page.locator('.project-observation [data-followup-key="view-mode"]').selectOption('timeline');
    assert.ok(await page.locator('.project-observation .project-followup-chart').count() > 0);
    }
    const output = process.env.MESH_PROJECT_EVIDENCE;
    if (output) { fs.mkdirSync(output, { recursive: true }); await page.locator('#projects').evaluate(node => { node.scrollTop = 0; }); await page.screenshot({ path: path.join(output, `i1-real-repository-${width}.png`), fullPage: true });
      if (REAL_ROSTER) await page.locator('.project-observation .project-followup').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `i1-real-work-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); }
    const start = requests.find(value => value.op === 'project_observation_start'); assert.ok(start);
    assert.deepEqual(Object.keys(start).sort(), ['boot', 'expected_revision', 'machine_id', 'op', 'project_id', 'request_id', 'version']);
    const admissions = requests.filter(value => value.op === 'project_observation_start');
    assert.equal(admissions.length, REAL_ROSTER ? 2 : 1, 'one admission per selected configuration, no rerender admissions');
    if (width === 1280) {
      const starts = () => requests.filter(value => value.op === 'project_observation_start');
      const settled = async () => { await page.waitForFunction(() => document.querySelector('#project-overview > p[role="status"]')?.textContent?.startsWith('Context observed')); };
      let before = starts().length;
      // Observe writes, not formatted time: two completed captures may share one displayed minute.
      await page.evaluate(() => {
        const status = document.querySelector('#project-overview > p[role="status"]')!;
        (window as any).observedStatusWrites = 0;
        new MutationObserver(() => { (window as any).observedStatusWrites++; })
          .observe(status, { childList: true, characterData: true, subtree: true });
      });
      const stamp = await page.locator('#project-overview > p[role="status"]').getAttribute('data-observed-at');
      assert.ok(stamp, 'the displayed context retains its precise native observation time');
      fs.writeFileSync(path.join(repository, 'README.md'), readme + '\nFresh observation evidence.\n');
      git('add', 'README.md'); git('-c', 'user.name=I1 Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Refresh observation fixture');
      const refreshedCommit = git('rev-parse', 'HEAD').trim();
      const taskControls=page.locator('.project-followup [data-followup-key^="row-"]');
      if(REAL_ROSTER)assert.ok(await taskControls.count()>0,'real Roster task controls are mounted before refresh');
      else assert.equal(await taskControls.count(),0,'Git-only observation has no Roster task controls');
      const next = page.waitForRequest(request => request.url().endsWith('/api/projects/v1') && request.postDataJSON()?.op === 'project_observation_start');
      await page.evaluate(() => window.tickProjectContext(30000)); await next;
      if(REAL_ROSTER)assert.ok(await taskControls.count()>0,'old task controls remain mounted while refreshing in list or clock view');
      else assert.equal(await taskControls.count(),0,'Git-only refresh does not create Roster task controls');
      await settled(); assert.equal(starts().length, before + 1, 'settled observation refreshes on the thirty second cadence');
      await page.waitForFunction(commit => (window as any).observedStatusWrites > 0 &&
        document.querySelector('#project-overview > p[role="status"]')?.textContent?.startsWith('Context observed') &&
        document.querySelector('.projects-repository-observation')?.textContent?.includes(commit), refreshedCommit);
      await page.waitForFunction(previous => {
        const current = document.querySelector<HTMLElement>('#project-overview > p[role="status"]')?.dataset.observedAt;
        return typeof current === 'string' && current !== previous;
      }, stamp);
      assert.notEqual(await page.locator('#project-overview > p[role="status"]').getAttribute('data-observed-at'), stamp);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); window.tickProjectContext(30000); });
      assert.equal(starts().length, before + 1, 'hidden document does not start captures');
      const resume = page.waitForRequest(request => request.url().endsWith('/api/projects/v1') && request.postDataJSON()?.op === 'project_observation_start');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await resume; await settled();
      // A lost admission acknowledgement must recover manually using the same native intent.
      let drop = true;
      await page.route('**/api/projects/v1', async route => {
        if (drop && route.request().postDataJSON()?.op === 'project_observation_start') { drop = false; await route.fetch(); await route.abort(); }
        else await route.continue();
      });
      const lost = page.waitForRequest(request => request.url().endsWith('/api/projects/v1') && request.postDataJSON()?.op === 'project_observation_start');
      await page.evaluate(() => window.tickProjectContext(30000)); await lost;
      await page.waitForFunction(() => document.querySelector('#project-overview > p[role="status"]')?.textContent?.includes('unavailable'));
      const uncertain = starts().at(-1)!;
      await page.getByRole('button', { name: 'Refresh project context', exact: true }).click(); await settled();
      assert.equal(starts().at(-1)!.request_id, uncertain.request_id, 'manual recovery replays the same uncertain admission identity');
      await page.unroute('**/api/projects/v1');
      let refusals = 2;
      let refusalCode = 'worker-capacity';
      await page.route('**/api/projects/v1', async route => {
        const body = route.request().postDataJSON();
        if (refusals && body?.op === 'project_observation_start') { refusals--; await route.fulfill({ json: { kind: 'mesh-project-reply', version: 1, op: body.op, boot: body.boot, status: refusalCode === 'worker-capacity' ? 'busy' : 'unavailable', code: refusalCode, request_id: body.request_id } }); }
        else await route.continue();
      });
      await page.evaluate(() => window.tickProjectContext(30000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(1000) && document.querySelector('#project-overview > p[role="status"]')?.textContent?.includes('unavailable'), undefined, { timeout: 5000 });
      const capacityRefused = starts().at(-1)!;
      before = starts().length;
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); window.tickProjectContext(1000); });
      assert.equal(starts().length, before, 'hidden document also pauses the short capacity retry');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => window.projectContextDeadlines().includes(2000) && document.querySelector('#project-overview > p[role="status"]')?.textContent?.includes('unavailable'));
      assert.notEqual(starts().at(-1)!.request_id, capacityRefused.request_id, 'unadmitted worker capacity retries use a fresh identity');
      before = starts().length; await page.evaluate(() => window.tickProjectContext(1000));
      assert.equal(starts().length, before, 'capacity backoff grows rather than hammering a busy host');
      await page.evaluate(() => window.tickProjectContext(2000)); await settled();
      refusals = 2; refusalCode = 'collector-failed';
      await page.evaluate(() => window.tickProjectContext(30000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(60000));
      const refused = starts().at(-1)!;
      await page.evaluate(() => window.tickProjectContext(60000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(120000));
      assert.notEqual(starts().at(-1)!.request_id, refused.request_id, 'definitive refusal permits a fresh admission identity');
      before = starts().length; await page.evaluate(() => window.tickProjectContext(60000));
      assert.equal(starts().length, before, 'repeated failures increase the settled backoff');
      await page.evaluate(() => window.tickProjectContext(120000)); await settled();
      await page.unroute('**/api/projects/v1');
      let controlRefused = false;
      await page.route('**/api/projects/v1', async route => {
        const body = route.request().postDataJSON();
        if (!controlRefused && body?.op === 'project_observation_status') { controlRefused = true; await route.fulfill({ json: { kind: 'mesh-project-reply', version: 1, op: body.op, boot: body.boot, status: 'busy', code: 'control-capacity', request_id: body.request_id } }); }
        else await route.continue();
      });
      before = starts().length;
      await page.evaluate(() => window.tickProjectContext(30000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(1000) && document.querySelector('#project-overview > p[role="status"]')?.textContent?.includes('unavailable'));
      assert.equal(controlRefused, true);
      const admitted = starts().at(-1)!;
      await page.evaluate(() => window.tickProjectContext(1000)); await settled();
      assert.equal(starts().length, before + 1, 'control-capacity retry retains the already admitted observation without another capture');
      assert.equal(requests.filter(value => value.op === 'project_observation_status').at(-1)!.request_id, admitted.request_id);
      await page.unroute('**/api/projects/v1');
      // A second client edits the global configuration revision without changing this project.
      const call = async (body: Record<string, unknown>) => (await context.request.post(origin + '/api/projects/v1', { data: { version: 1, ...body } })).json();
      const cap = await call({ op: 'project_capabilities' }), list = await call({ op: 'project_list' });
      assert.equal((await call({ op: 'project_create', boot: cap.boot, expected_revision: list.revision, request_id: crypto.randomUUID(), project: { title: 'Concurrent project' } })).status, 'ok');
      await page.evaluate(() => window.tickProjectContext(30000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(60000));
      await page.waitForFunction(() => /unavailable|stale/.test(document.querySelector('#project-overview > p[role="status"]')?.textContent ?? ''), undefined, { timeout: 5000 }).catch(async () => {
        throw Error('revision refresh status=' + await page.locator('#project-overview > p[role="status"]').textContent() + ' starts=' + JSON.stringify(starts()) + ' listed=' + list.revision);
      });
      const stale = starts().at(-1)!;
      await page.evaluate(() => window.tickProjectContext(60000)); await settled();
      assert.notEqual(starts().at(-1)!.expected_revision, stale.expected_revision, 'known revision conflict re-reads native settings before admitting a fresh capture');
      let changedDuringAssembly = false;
      await page.route('**/api/projects/v1', async route => {
        if (!changedDuringAssembly && route.request().postDataJSON()?.op === 'project_observation_page') {
          changedDuringAssembly = true;
          const response = await route.fetch(), registry = await call({ op: 'project_list' });
          assert.equal((await call({ op: 'project_create', boot: cap.boot, expected_revision: registry.revision, request_id: crypto.randomUUID(), project: { title: 'Assembly concurrent project' } })).status, 'ok');
          await route.fulfill({ response });
        } else await route.continue();
      });
      await page.evaluate(() => window.tickProjectContext(30000));
      await page.waitForFunction(() => window.projectContextDeadlines().includes(60000));
      const staleAssembly = starts().at(-1)!;
      assert.equal(changedDuringAssembly, true);
      await page.evaluate(() => window.tickProjectContext(60000)); await settled();
      assert.notEqual(starts().at(-1)!.expected_revision, staleAssembly.expected_revision,
        'observation-stale after paged assembly rebinds settings rather than retrying the immutable completed reader');
      await page.unroute('**/api/projects/v1');
      before = starts().length;
      await page.locator('#projects-return').click(); await page.evaluate(() => window.tickProjectContext(30000));
      assert.equal(starts().length, before, 'closing Projects cancels the settled refresh deadline');
      await enter(page, false); await settled();
    }
    await page.locator('[data-cockpit-tab="sources"]').click();
    assert.equal(await page.locator('.project-context-settings').isVisible(), true);
    await page.locator('[data-cockpit-tab="sessions"]').click();
    await page.locator('.cockpit-panel').getByText('No participating sessions reported in this snapshot.', { exact: true }).waitFor();
    if (REAL_ROSTER) {
      await page.locator('[data-cockpit-tab="roster"]').click();
      assert.equal(await page.locator('.cockpit-panel .cockpit-work-row').count(), 17, 'all actual board tasks remain available through Roster');
    }
    await page.locator('[data-cockpit-tab="work"]').click();
    const persisted = await page.evaluate(() => localStorage.getItem('mesh.projects.ui.v1') ?? '');
    assert.ok(!persisted.includes('cancel_token') && !persisted.includes('data_base64') && !persisted.includes('observation_id'));
    assert.ok(JSON.parse(persisted).some(([key, state]) => key.includes('cockpit') && state.selected === 'work'),
      'bounded UI preferences retain the selected project section without observation authority');
    await page.locator('#projects-return').click();
    assert.equal(await page.evaluate('active===i1Saved.pane && active.term===i1Saved.term && active.conn===i1Saved.conn && paneTargets.valid(i1Saved.target)'), true);
    await page.evaluate('active.term.focus()');
    await page.keyboard.type('i1-terminal-alive');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Array.from({ length: active.term.buffer.active.length }, (_, i) => active.term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('i1-terminal-alive'));
    await context.close();
  } finally { await browser?.close(); if (server) await stopServer(server); await stop(host); fs.rmSync(where.scratch, { recursive: true, force: true }); }
});
