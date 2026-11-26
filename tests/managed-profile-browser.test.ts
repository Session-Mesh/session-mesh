// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {chromium, type Browser} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';
import {REPO, startMesh} from './mesh-server-lib.ts';
import {attach, request, waitFor, type Attachment} from './ptyhost-wire-lib.ts';

const helper = process.env.MESH_MANAGED_PROFILE_TEST_HELPER ||
  path.join(REPO, 'ocaml/_build/default/test/provision_runner/mesh_profile_main.exe');
const platform = process.env.MESH_MESH_PLATFORM_CMD ||
  path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const chrome = process.env.MESH_CHROMIUM;
const skip = !process.env.MESH_REQUIRE_MANAGED_PROFILE && (!fs.existsSync(helper) || !chrome)
  ? 'build the synthetic runner helper and set MESH_CHROMIUM' : false;
const witness = '#!/bin/sh\nset -eu\nprintf \'%s\' "$MESH_SESSION" > "$CODEX_HOME/fixture-launch"\n'
  + 'record="$CODEX_HOME/fixture-argv-$MESH_SESSION"\n'
  + 'printf \'%s\\n\' "$#" "$@" > "$record.tmp"\nmv "$record.tmp" "$record"\n'
  + 'while IFS= read -r line; do printf \'%s\\n\' "$line" >> "$CODEX_HOME/fixture-input"; done\n';

for (const lateConfig of [false, true]) test(lateConfig
  ? 'a superseded config response cannot replace the explicit profile with the default'
  : 'unmodified app creates and explicitly opens a managed profile through the runner capability', {skip, timeout: 60000}, async () => {
  assert.ok(chrome);
  fs.accessSync(helper, fs.constants.X_OK);
  const mesh = await startMesh('managed-profile-', {
    MESH_MESH_PROFILE_CMD:helper, MESH_MESH_PLATFORM_CMD:platform,
    MESH_SESSION:undefined, MESH_SESSION_TOKEN:undefined,
  }, where => {
    fs.mkdirSync(where.confDir, {recursive:true, mode:0o700});
    fs.writeFileSync(path.join(where.confDir, 'synthetic-profile-witness'), witness, {mode:0o700});
  });
  const socket = path.join(mesh.home, 'run/session-mesh/ptyhost.sock');
  const registry = path.join(mesh.confDir, 'backend-profiles.json');
  let host: ReturnType<typeof startTestPtyhost> | undefined, browser: Browser | undefined, terminalB: Attachment | undefined;
  try {
    assert.equal(fs.existsSync(registry), false);
    const argv = nativePtyhost();
    host = startTestPtyhost(argv, {cwd:REPO, stdio:'ignore',
      env:{HOME:mesh.home, PATH:'/usr/bin:/bin', SHELL:'/bin/sh', LANG:'C.UTF-8',
        XDG_RUNTIME_DIR:path.join(mesh.home,'run')}}, socket);
    const list = () => request(socket, {op:'list'}) as Promise<
      {name:string; pid:number; created:number; meta:Record<string,string>}[]>;
    await host.ready;
    browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));
    const context = await browser.newContext({locale:'en', viewport:{width:1440,height:900}});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const provisionURL = `${mesh.base}/api/accounts/profiles/provision`;
    const launchURL = `${mesh.base}/api/new`;
    const writes: unknown[] = [], launches: unknown[] = [], registryReads: string[] = [];
    page.on('request', req => {
      const endpoint = new URL(req.url()).pathname;
      if (req.method() === 'GET' && endpoint.startsWith('/api/accounts/')) registryReads.push(endpoint);
      if (req.method() !== 'POST') return;
      if (req.url() === provisionURL) writes.push(req.postDataJSON());
      if (req.url() === launchURL) launches.push(req.postDataJSON());
    });
    let frames = 0;
    page.on('websocket', ws => {
      if (new URL(ws.url()).pathname === '/ws/managed-a') ws.on('framesent', () => { frames++; });
    });
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    const panel = page.locator('dialog.backend-account-panel');
    const control = (name:string) => panel.locator(`[data-focus="${name}"]`);
    await page.locator('#btn-accounts').click();
    await control('provision-account').waitFor();
    registryReads.length = 0;
    const accepted = [];
    for (const label of ['Profile A', 'Profile B']) {
      await control('provision-account').click();
      await control('create-label').fill(label);
      assert.equal(await control('create-id').count(), 0);
      assert.equal(await control('create-config').count(), 0);
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === provisionURL && r.request().method() === 'POST'),
        control('save-account').click(),
      ]);
      assert.equal(response.status(), 200, await response.text());
      const receipt = (await response.json()).data;
      assert.deepEqual(Object.keys(receipt.profile).sort(),
        ['backend','context_revision','enabled','id','label','managed','switch_qualified']);
      assert.equal(receipt.profile.managed, true);
      assert.equal(receipt.profile.enabled, true);
      accepted.push(receipt);
      await control('create-label').waitFor({state:'detached'});
      await panel.locator('li').filter({hasText:label}).waitFor();
      await control('recovery-confirm').waitFor({state:'visible'});
      await page.waitForFunction(() => { const button = document.querySelector('[data-focus="recovery-confirm"]') as HTMLButtonElement | null; return !!button && !button.disabled; });
      await control('recovery-confirm').click();
      await panel.getByText('Result acknowledged.').waitFor();
      assert.deepEqual(await list(), []);
    }
    const [a,b] = accepted.map(r => r.profile);
    const stored = fs.readFileSync(registry,'utf8');
    const raw = JSON.parse(stored);
    assert.deepEqual(raw.profiles.map((p:{id:string; enabled:boolean})=>[p.id,p.enabled]), [[a.id,true],[b.id,true]]);
    for(const row of raw.profiles) {
      assert.equal(fs.statSync(row.roots.state).mode & 0o777, 0o700);
      assert.equal(fs.existsSync(path.join(row.roots.config,'fixture-launch')),false);
    }
    const listed = await context.request.get(`${mesh.base}/api/config`);
    const publicConfig = await listed.json();
    assert.deepEqual(publicConfig.capabilities.profile_provision, ['codex']);
    assert.deepEqual(publicConfig.managed_profile_offers,[a,b]);
    assert.ok(!JSON.stringify(publicConfig.managed_profile_offers).includes(raw.profiles[0].roots.config));
    const marker = path.join(raw.profiles[0].roots.config,'managed-private.txt');
    fs.writeFileSync(marker,'synthetic private marker',{mode:0o600});
    const view = await context.request.post(`${mesh.base}/api/view`,{data:{target:marker},headers:{Origin:mesh.base}});
    assert.equal(view.status(),403);
    assert.equal(writes.length, 2);
    for (const [index, raw] of writes.entries()) {
      const item = raw as {registry_revision:string|null;profile:object;operation_id:string};
      assert.match(item.operation_id, /^[a-f0-9]{32}$/);
      assert.deepEqual(item.profile, {backend:'codex',label:index === 0 ? 'Profile A' : 'Profile B'});
      assert.equal(item.registry_revision, index === 0 ? null : accepted[0].registry_revision);
    }
    assert.deepEqual(launches, []);
    assert.ok(registryReads.filter(path => path === '/api/accounts/profiles').length >= 2);
    await control('close').click();
    const ref = ({backend,id,context_revision}:{backend:string;id:string;context_revision:string}) =>
      ({backend,id,context_revision});
    const direct = (data:object) => context.request.post(launchURL, {data, headers:{Origin:mesh.base}});
    const input = {preset:'codex',name:'should-not-start',cwd:mesh.home};
    assert.equal((await direct({...input, account:a.id})).status(),400,'legacy launch cannot resolve managed entry');
    assert.equal((await direct({...input, managed_profile:{...ref(a),context_revision:'0'.repeat(64)}})).status(),409);
    assert.equal((await direct({...input, managed_profile:null})).status(),409);
    assert.equal((await direct({...input, managed_profile:ref(a), command:'not-a-runner-command'})).status(),409);
    assert.equal((await direct({...input, managed_profile:ref(a), options:'--model ignored'})).status(),409);
    const fake = path.join(mesh.confDir, 'synthetic-profile-witness');
    fs.chmodSync(fake,0o600);
    assert.equal((await direct({...input, managed_profile:ref(a)})).status(),409);
    fs.chmodSync(fake,0o700);
    assert.deepEqual(await list(), []);
    const launchB = await direct({...input,name:'managed-b',managed_profile:ref(b)});
    assert.equal(launchB.status(),200,await launchB.text());
    terminalB = await attach(socket, 'managed-b');
    const observe = (i:number,kind:string) => {
      const file = path.join(raw.profiles[i].roots.config, `fixture-${kind}`);
      return fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '';
    };
    const beforeB = (await list()).find(row => row.name === 'managed-b');
    assert.equal(beforeB?.meta.account_context_revision,b.context_revision);
    await waitFor('exact fake executable receives B',10000,()=>observe(1,'launch') === 'managed-b');
    terminalB.send('D',Buffer.from('B-before\r'));
    await waitFor('B receives its input',10000,()=>observe(1,'input') === 'B-before\n');

    let oldReady!: () => void, oldFailed!: (error: unknown) => void, releaseOld!: () => void;
    const oldConfigReady = new Promise<void>((resolve, reject) => { oldReady = resolve; oldFailed = reject; });
    const oldConfigRelease = new Promise<void>(resolve => { releaseOld = resolve; });
    const configURL = `${mesh.base}/api/config`;
    if (lateConfig) {
      fs.chmodSync(fake,0o600);
      await page.route(configURL, async route => {
        try {
          const response = await route.fetch();
          oldReady();
          await oldConfigRelease;
          await route.fulfill({response});
        } catch (error) { oldFailed(error); }
      }, {times:1});
      await page.locator('#btn-new').click();
      await oldConfigReady;
      await page.locator('#form-new [data-close-dialog]').click();
      fs.chmodSync(fake,0o700);
    }
    await page.locator('#btn-new').click();
    const form = page.locator('#form-new');
    await form.locator('label:has(input[name=preset][value=codex])').click();
    await form.locator('input[name=cwd]').fill(mesh.home);
    await form.locator('input[name=name]').fill('managed-a');
    await form.locator('select[name=account]').selectOption(`managed:codex:${a.id}`);
    if (lateConfig) {
      const deliveredOld = page.waitForResponse(r => r.url() === configURL);
      releaseOld();
      await (await deliveredOld).finished();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      assert.equal(await form.locator('select[name=account]').inputValue(), `managed:codex:${a.id}`);
    }
    // Shell and custom have no account selector. A previously selected managed
    // profile must not block them or be sent as a default/managed account.
    for (const preset of ['shell', 'custom']) {
      await form.locator(`label:has(input[name=preset][value=${preset}])`).click();
      if (preset === 'custom') await form.locator('input[name=command]').fill('true');
      let sent: Record<string, unknown> | undefined;
      await page.route(launchURL, async route => {
        sent = route.request().postDataJSON();
        await route.fulfill({status:409, body:'test refusal'});
      }, {times:1});
      await Promise.all([page.waitForResponse(r => r.url() === launchURL), form.locator('button[value=ok]').click()]);
      assert.equal(sent?.preset, preset);
      assert.equal(Object.hasOwn(sent!, 'managed_profile'), false);
      assert.equal(Object.hasOwn(sent!, 'account'), false);
    }
    launches.length = 0;
    await form.locator('label:has(input[name=preset][value=codex])').click();
    const submit = () => Promise.all([
      page.waitForResponse(r => r.url() === launchURL && r.request().method() === 'POST'),
      form.locator('button[value=ok]').click(),
    ]);
    fs.chmodSync(fake,0o600);
    const [lostCapability] = await submit();
    assert.equal(lostCapability.status(),409);
    await page.locator('#new-err').filter({hasText:'Managed profile unavailable or changed'}).waitFor();
    assert.equal(await form.locator('select[name=account]').inputValue(),`managed:codex:${a.id}`);
    assert.deepEqual((await list()).map(row => row.name), ['managed-b']);
    fs.chmodSync(fake,0o700);
    const [launched] = await submit();
    assert.equal(launched.status(),200,await launched.text());
    assert.deepEqual(launches.map(r => (r as {managed_profile:unknown}).managed_profile),[ref(a),ref(a)]);
    assert.ok(launches.every(r => Object.hasOwn(r as object,'managed_profile')), 'no request fell back to default');
    await waitFor('exact fake executable receives A',10000,()=>observe(0,'launch') === 'managed-a');
    await page.waitForFunction(() => active.id === 'managed-a' && active.conn?.terminal?.isOpen()
      && active.conn?.replaying === false, null, {timeout:10000});
    const terminalA = page.locator('.pane.active .xterm-helper-textarea');
    await terminalA.evaluate(field => (field as HTMLTextAreaElement).focus());
    const beforeKeys = frames;
    await page.keyboard.type('A-only');
    await page.keyboard.press('Enter');
    await waitFor('A input reached its CLI from Chromium',10000,()=>frames > beforeKeys && observe(0,'input') === 'A-only\n');
    terminalB.send('D',Buffer.from('B-after\r'));
    await waitFor('B is still interactive',10000,()=>observe(1,'input') === 'B-before\nB-after\n');
    const afterB = (await list()).find(row=>row.name==='managed-b');
    assert.deepEqual([afterB?.pid,afterB?.created,afterB?.meta], [beforeB?.pid,beforeB?.created,beforeB?.meta]);
    assert.equal((await list()).find(row=>row.name==='managed-a')?.meta.account_context_revision,a.context_revision);
    assert.equal(fs.readFileSync(registry,'utf8'), stored, 'launch did not change the registry published by creation');
    assert.equal(fs.existsSync(path.join(mesh.home,'.codex')),false);
    fs.chmodSync(fake,0o600);
    const freshConfig = page.waitForResponse(r => r.url() === `${mesh.base}/api/config`);
    await page.locator('#btn-new').click();
    await freshConfig;
    await form.locator('input[name=cwd]').fill(mesh.home);
    await form.locator('input[name=name]').fill('not-default');
    assert.equal(await form.locator('select[name=account]').inputValue(),`managed:codex:${a.id}`);
    await form.locator('button[value=ok]').click();
    await page.locator('#new-err').filter({hasText:'Managed profile unavailable or changed'}).waitFor();
    assert.equal(launches.length,2);
    assert.deepEqual((await list()).map(row=>row.name).sort(),['managed-a','managed-b']);
  } finally {
    try { await browser?.close(); } finally {
      terminalB?.close();
      try { await host?.stop(); } finally { await mesh.stop(); }
    }
  }
});

for (const reload of [true, false]) test(`lost creation receipt remains inspectable after ${reload ? 'reload' : 'reopen and outdated discovery'}`, {skip,timeout:45000}, async () => {
  assert.ok(chrome);
  fs.accessSync(helper,fs.constants.X_OK);
  const mesh = await startMesh('managed-loss-', {MESH_MESH_PROFILE_CMD:helper,MESH_MESH_PLATFORM_CMD:platform}, where => {
    fs.mkdirSync(where.confDir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(where.confDir,'synthetic-profile-witness'),witness,{mode:0o700});
    for (const dir of ['existing-config','existing-state']) fs.mkdirSync(path.join(where.confDir,dir),{mode:0o700});
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(chromiumLaunchOptions(chrome,['--no-sandbox']));
    const page = await browser.newPage({locale:'en',viewport:{width:1440,height:900}});
    page.setDefaultTimeout(6500);
    const control = (name:string) => page.locator(`dialog.backend-account-panel [data-focus="${name}"]`);
    const status = page.locator('dialog.backend-account-panel [role=status]');
    const traffic:string[] = [];
    const url = `${mesh.base}/api/accounts/profiles/provision`;
    page.on('request', req => {
      const endpoint = new URL(req.url()).pathname;
      if (endpoint.startsWith('/api/accounts/')) traffic.push(`${req.method()} ${endpoint}`);
    });
    await page.route(url,async route => {
      const reply=await route.fetch();
      assert.equal(reply.status(),200);
      await route.abort('failed'); // Commit occurred on the real server, but the browser has no receipt.
    },{times:1});
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    await page.locator('#btn-accounts').click();
    await control('provision-account').click();
    await control('create-label').fill('Unconfirmed');
    await control('save-account').click();
    await status.filter({hasText:'Creation has no confirmed receipt'}).waitFor();
    const fake=path.join(mesh.confDir,'synthetic-profile-witness');
    fs.chmodSync(fake,0o600);
    traffic.length=0;
    if (reload) await page.reload();
    else await control('close').click();
    await page.locator('#btn-accounts').click();
    await status.filter({hasText:'Creation has no confirmed receipt'}).waitFor();
    await page.locator('dialog li').filter({hasText:'Unconfirmed'}).waitFor();
    assert.equal(await control('provision-account').count(),0);
    assert.equal(await control('add-account').isDisabled(),true);
    // A reopened panel retains a policy snapshot and refreshes its revision;
    // after a page reload only the public profile list is inspected.
    assert.deepEqual(traffic, reload ? ['GET /api/accounts/profiles']
      : ['GET /api/accounts/profiles', 'GET /api/accounts/consent']);
    fs.chmodSync(fake,0o700);
    if (reload) await control('refresh').click();
    else {
      await control('close').click();
      const configURL = `${mesh.base}/api/config`;
      let releaseOld!: () => void, oldReady!: () => void, oldFailed!: (error: unknown) => void;
      const old = new Promise<void>((resolve, reject) => { oldReady = resolve; oldFailed = reject; });
      const release = new Promise<void>(resolve => { releaseOld = resolve; });
      // Simulate a transport that delivers the old reply despite cancellation.
      await page.evaluate(() => {
        const fetch = window.fetch;
        window.fetch = (input, init) => {
          if (input !== '/api/config') return fetch(input, init);
          window.fetch = fetch;
          return fetch(input, {...init, signal: undefined});
        };
      });
      await page.route(configURL, async route => {
        try {
          const response = await route.fetch();
          assert.deepEqual((await response.json()).capabilities.profile_provision, ['codex']);
          oldReady();
          await release;
          await route.fulfill({response});
        } catch (error) { oldFailed(error); }
      }, {times:1});
      await page.locator('#btn-accounts').click();
      await old;
      await control('add-account').waitFor();
      assert.equal(await control('provision-account').count(),0,'no cached grant while discovery is pending');
      await control('close').click();
      fs.chmodSync(fake,0o600);
      const fresh = page.waitForResponse(r => r.url() === configURL);
      await page.locator('#btn-accounts').click();
      assert.equal((await (await fresh).json()).capabilities.profile_provision, undefined);
      const deliveredOld = page.waitForResponse(r => r.url() === configURL);
      releaseOld();
      await (await deliveredOld).finished();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      assert.equal(await control('provision-account').count(),0,'the old positive reply cannot restore the grant');
      await control('add-account').waitFor();
      await control('close').click();
      fs.chmodSync(fake,0o700);
      await page.locator('#btn-accounts').click();
      await control('add-account').waitFor();
    }
    await status.filter({hasText:'Creation has no confirmed receipt'}).waitFor();
    await control('provision-account').waitFor();
    assert.equal(await control('provision-account').isDisabled(),true);
    assert.ok(traffic.every(call => call === 'GET /api/accounts/profiles' || call === 'GET /api/accounts/consent'),
      'reopening and refreshing never mutates account state');
    await control('recovery-inspect').click();
    await page.getByText('The account was recorded.', {exact:false}).waitFor();
    await control('recovery-confirm').click();
    await page.getByText('Result acknowledged.').waitFor();
    await page.waitForFunction(() => { const button = document.querySelector('[data-focus="provision-account"]') as HTMLButtonElement | null; return !!button && !button.disabled; });
    assert.equal(traffic.filter(call => call === 'POST /api/accounts/profiles/provision').length,0,
      'recovery never repeats the creation');
  } finally {
    try { await browser?.close(); } finally { await mesh.stop(); }
  }
});

test('two real tabs settle one lost creation without recreating it', {skip, timeout:45000}, async () => {
  assert.ok(chrome);
  const mesh = await startMesh('managed-two-tabs-', {MESH_MESH_PROFILE_CMD:helper,MESH_MESH_PLATFORM_CMD:platform}, where => {
    fs.mkdirSync(where.confDir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(where.confDir,'synthetic-profile-witness'),witness,{mode:0o700});
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(chromiumLaunchOptions(chrome,['--no-sandbox']));
    const context = await browser.newContext({locale:'en',viewport:{width:1440,height:900}});
    const a = await context.newPage(), b = await context.newPage();
    a.setDefaultTimeout(10000); b.setDefaultTimeout(10000);
    const control = (page: import('playwright-core').Page, name:string) => page.locator(`dialog.backend-account-panel [data-focus="${name}"]`);
    const url = `${mesh.base}/api/accounts/profiles/provision`;
    let writes = 0; context.on('request', req => { if (req.method() === 'POST' && req.url() === url) writes++; });
    await a.route(url, async route => { const reply = await route.fetch(); assert.equal(reply.status(),200); await route.abort('failed'); },{times:1});
    await a.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`); await a.goto(`${mesh.base}/`);
    await a.locator('#btn-accounts').click(); await control(a,'provision-account').click();
    await control(a,'create-label').fill('Two tabs'); await control(a,'save-account').click();
    await a.locator('dialog [role=status]').filter({hasText:'Creation has no confirmed receipt'}).waitFor();
    await b.goto(`${mesh.base}/`); await b.locator('#btn-accounts').click();
    await b.locator('dialog [role=status]').filter({hasText:'Creation has no confirmed receipt'}).waitFor();
    await control(b,'recovery-inspect').click(); await b.getByText('The account was recorded.',{exact:false}).waitFor();
    await control(b,'recovery-confirm').click(); await b.getByText('Result acknowledged.').waitFor();
    await control(a,'refresh').click();
    await a.waitForFunction(() => { const button = document.querySelector('[data-focus="provision-account"]') as HTMLButtonElement | null; return !!button && !button.disabled; });
    assert.equal(writes,1,'no automatic recreation');
  } finally { try { await browser?.close(); } finally { await mesh.stop(); } }
});

test('ordinary account cancellation and managed argv remain separate', {skip, timeout:60000}, async t => {
  assert.ok(chrome);
  fs.accessSync(helper, fs.constants.X_OK);
  const mesh = await startMesh('managed-ordinary-', {MESH_MESH_PROFILE_CMD:helper, MESH_MESH_PLATFORM_CMD:platform}, where => {
    fs.mkdirSync(where.confDir, {recursive:true, mode:0o700});
    fs.writeFileSync(path.join(where.confDir,'synthetic-profile-witness'),witness,{mode:0o700});
    const bin = path.join(where.home,'bin');
    fs.mkdirSync(bin,{mode:0o700});
    fs.writeFileSync(path.join(bin,'codex'),witness,{mode:0o700});
    const fixturePath = `${bin}:/usr/bin:/bin`;
    fs.writeFileSync(path.join(where.home,'.profile'),`export PATH='${fixturePath}'\n`,{mode:0o600});
    where.env.PATH = fixturePath;
    const profiles = ['ordinary-a','ordinary-b'].map(id => {
      const config = path.join(where.confDir,id), state = path.join(config,'sessions');
      fs.mkdirSync(state,{recursive:true,mode:0o700});
      return {id,label:id,backend:'codex',enabled:true,roots:{config,state}};
    });
    fs.writeFileSync(path.join(where.confDir,'backend-profiles.json'),JSON.stringify({version:1,profiles}),{mode:0o600});
  });
  let host: ReturnType<typeof startTestPtyhost> | undefined, browser: Browser | undefined;
  try {
    const socket = path.join(mesh.home,'run/session-mesh/ptyhost.sock');
    const argv = nativePtyhost();
    host = startTestPtyhost(argv,{cwd:REPO,stdio:'ignore',env:{
      HOME:mesh.home, PATH:`${mesh.home}/bin:/usr/bin:/bin`, SHELL:'/bin/sh', LANG:'C.UTF-8',
      XDG_RUNTIME_DIR:path.join(mesh.home,'run'),
    }}, socket);
    await host.ready;
    browser = await chromium.launch(chromiumLaunchOptions(chrome,['--no-sandbox']));
    const page = await browser.newPage({locale:'en',viewport:{width:1440,height:900}});
    page.setDefaultTimeout(10000);
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    const http = page.context().request;
    const getConfig = async () => (await http.get(`${mesh.base}/api/config`)).json();
    const post = (route: string, data: object) => http.post(`${mesh.base}${route}`, {data,headers:{Origin:mesh.base}});
    const launched = (name:string, account:object) => post('/api/new',{name,preset:'codex',cwd:mesh.home,...account});
    const observedArgv = async (root:string,name:string) => {
      const file = path.join(root,`fixture-argv-${name}`);
      await waitFor(`argv recorded by ${name}`,10000,()=>fs.existsSync(file));
      const [argc,...args] = fs.readFileSync(file,'utf8').slice(0,-1).split('\n');
      assert.equal(Number(argc),args.length,'one complete argv record');
      return args;
    };

    await t.test('the ordinary CLI receives the stored option; the managed CLI does not', async () => {
      const elevated = await post('/api/config/elevate',{token:mesh.token()});
      assert.equal(elevated.status(),200,await elevated.text());
      const option = '--model fixture-default';
      const saved = await post('/api/config/launch-options',{
        revision:(await getConfig()).launch.agent_options_revision, agent_options:{codex:option},
      });
      assert.equal(saved.status(),200,await saved.text());
      assert.equal((await getConfig()).launch.agent_options.codex,option);
      const listing = await http.get(`${mesh.base}/api/accounts/profiles`);
      const created = await post('/api/accounts/profiles/provision',{
        registry_revision:(await listing.json()).data.registry_revision,profile:{backend:'codex',label:'Managed fixture'},
      });
      assert.equal(created.status(),200,await created.text());
      const {backend,id,context_revision} = (await created.json()).data.profile;
      const ordinary = await launched('ordinary-argv',{account:'ordinary-a'});
      assert.equal(ordinary.status(),200,await ordinary.text());
      const managed = await launched('managed-argv',{managed_profile:{backend,id,context_revision}});
      assert.equal(managed.status(),200,await managed.text());
      const ordinaryArgs = await observedArgv(path.join(mesh.confDir,'ordinary-a'),'ordinary-argv');
      assert.deepEqual(ordinaryArgs.slice(-2),['--model','fixture-default']);
      const registry = JSON.parse(fs.readFileSync(path.join(mesh.confDir,'backend-profiles.json'),'utf8'));
      const managedRoot = registry.profiles.find((profile:{id:string})=>profile.id===id)?.roots.config;
      assert.ok(managedRoot);
      assert.deepEqual(await observedArgv(managedRoot,'managed-argv'),[]);
    });

    await t.test('cancelling an ordinary choice keeps the last successfully launched alias', async () => {
      const form = page.locator('#form-new'), account = form.locator('select[name=account]');
      const cancel = form.locator('[data-close-dialog]');
      const posts: Record<string,unknown>[] = [];
      page.on('request', req => {
        if (req.url() === `${mesh.base}/api/new` && req.method() === 'POST') posts.push(req.postDataJSON());
      });
      const open = async (name:string) => {
        await page.locator('#btn-new').click();
        await account.locator('option[value="ordinary-b"]').waitFor({state:'attached'});
        await form.locator('label:has(input[name=preset][value=codex])').click();
        await form.locator('input[name=cwd]').fill(mesh.home);
        await form.locator('input[name=name]').fill(name);
      };
      const submit = async () => {
        const [response] = await Promise.all([
          page.waitForResponse(r => r.url() === `${mesh.base}/api/new` && r.request().method() === 'POST'),
          form.locator('button[value=ok]').click(),
        ]);
        assert.equal(response.status(),200,await response.text());
        await page.locator('#dlg-new').waitFor({state:'hidden'});
      };
      await open('last-good');
      await account.selectOption('ordinary-a');
      await submit();
      await open('cancelled');
      await account.selectOption('ordinary-b');
      await cancel.click();
      assert.equal(posts.length,1,'Cancel sent no launch');
      await open('after-cancel');
      assert.equal(await account.inputValue(),'ordinary-a');
      await submit();
      assert.deepEqual(posts.map(({name, account, managed_profile})=>[name,account,managed_profile]),[
        ['last-good','ordinary-a',undefined],['after-cancel','ordinary-a',undefined],
      ]);
      const args = await observedArgv(path.join(mesh.confDir,'ordinary-a'),'after-cancel');
      assert.deepEqual(args.slice(-2),['--model','fixture-default']);
    });
  } finally {
    try { await browser?.close(); } finally {
      try { await host?.stop(); } finally { await mesh.stop(); }
    }
  }
});
