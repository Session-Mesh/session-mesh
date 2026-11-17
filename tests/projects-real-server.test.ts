// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { ptyhostArgv } from './ptyhost-command.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const PYTHON = process.env.MESH_PYTHON ?? '';
const skip = (!CHROMIUM || !PYTHON) && !process.env.MESH_REQUIRE_BROWSER
  ? 'MESH_CHROMIUM and MESH_PYTHON required for real-server browser check' : false;

test('hostile catalog stays inert through real authenticated signed view and index CSP', {skip,timeout:30000}, async () => {
  assert.ok(CHROMIUM && PYTHON, 'set MESH_CHROMIUM and MESH_PYTHON');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'mesh-projects-real-'));
  const children: ChildProcess[] = [];
  const listener = net.createServer();
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const conf = path.join(temp,'conf'), runtime = path.join(temp,'run');
  fs.mkdirSync(conf,{mode:0o700}); fs.mkdirSync(runtime,{mode:0o700});
  const env = { PATH:process.env.PATH, LANG:'C.UTF-8', HOME:temp, XDG_CONFIG_HOME:path.join(temp,'config'),
    XDG_CACHE_HOME:path.join(temp,'cache'), XDG_DATA_HOME:path.join(temp,'data'), XDG_RUNTIME_DIR:runtime,
    MESH_CONF_DIR:conf, MESH_CACHE_DIR:path.join(temp,'cache'), MESH_RUNTIME_DIR:runtime,
    MESH_HOST:'127.0.0.1', MESH_PORT:String(port), MESH_AUTH_MODE:'legacy', PYTHONDONTWRITEBYTECODE:'1' };
  let diagnostics = '';
  const launch = (argv:string[]) => {
    const child = spawn(argv[0],argv.slice(1),{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
    child.on('error',error=>{diagnostics += String(error);});
    for (const stream of [child.stdout,child.stderr]) stream?.on('data',data=>{diagnostics = (diagnostics+data).slice(-16000);});
    children.push(child); return child;
  };
  let browser;
  try {
    launch(ptyhostArgv()); const server = launch([PYTHON,'server.py']);
    let ready = false;
    for (let i=0;i<150;i++) {
      assert.equal(server.exitCode,null,`server exited: ${diagnostics}`);
      try { ready = (await fetch(origin+'/login')).ok; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,`server did not start: ${diagnostics}`);
    assert.equal((await fetch(origin+'/api/sessions')).status,401);
    const hostile = '<img src="https://catalog-probe.invalid/leak" onerror="window.projectInjected=true">';
    const file = path.join(temp,'catalog.json');
    fs.writeFileSync(file,JSON.stringify({kind:'mesh-project-catalog',schema_version:1,machine_id:'isolated',
      revision:'a'.repeat(64),generated_at:'2026-11-14T12:00:00Z',projects:[{id:'hostile',title:hostile,
        description:hostile,sources:[],sessions:[]}]}),{mode:0o600});
    browser = await chromium.launch({executablePath:CHROMIUM,args:['--no-sandbox','--mute-audio']});
    const context = await browser.newContext({viewport:{width:850,height:900},locale:'en-US'});
    const token = fs.readFileSync(path.join(conf,'token'),'utf8').trim();
    assert.ok((await context.request.post(origin+'/login',{form:{token}})).ok());
    const page = await context.newPage();
    const foreign:string[] = [];
    page.on('request',request=>{if(new URL(request.url()).origin!==origin)foreign.push(request.url());});
    const index = await page.goto(origin);
    assert.match(index?.headers()['content-security-policy'] ?? '',/script-src/);
    await page.locator('#btn-projects').click();
    await page.locator('details.project-legacy:not([open])').waitFor({state:'attached'});
    await page.locator('.project-legacy > summary').click();
    await page.locator('#projects-path').fill(file);
    const signed = page.waitForResponse(response=>new URL(response.url()).pathname.startsWith('/view/'));
    await page.locator('.projects-load button').click();
    const response = await signed;
    assert.equal(response.status(),200);
    assert.match(response.headers()['content-type'] ?? '',/application\/json/);
    assert.match(response.headers()['content-security-policy'] ?? '',/sandbox/);
    await page.locator('.projects-detail h2').waitFor();
    assert.equal(await page.locator('.projects-detail h2').textContent(),hostile);
    assert.equal(await page.locator('#projects-root img').count(),0);
    assert.equal(await page.evaluate(()=>window.projectInjected),undefined);
    assert.deepEqual(foreign,[]);
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('/view/v2.')),false);
    assert.equal(await page.locator('#projects-path').inputValue(),file);
    await page.locator('#projects-return').click();
    assert.equal(await page.locator('#projects').isVisible(),false);
  } finally {
    await browser?.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child,'exit'); child.kill('SIGTERM');
      const timer = setTimeout(()=>child.kill('SIGKILL'),3000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
