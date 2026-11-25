// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Component tests, NOT running-app/HTTP-contract integration. Only the compiled component,
// real catalogs and a disposable in-memory port fixture are served on loopback. No CLI starts.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer, type Server} from 'node:http';
import {build} from 'esbuild';
import {chromium, type Browser, type Page} from 'playwright-core';
import {BACKENDS, type Backend, type ConsentMutation, type Policy, type Profile, type ProfileMutation, type ProvisionMutation} from '../static/backend-account-model.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogs = Object.fromEntries(['en', 'fr'].map(lang => [lang, JSON.parse(readFileSync(`${root}/static/i18n/${lang}.json`, 'utf8')) as Record<string, string>]));
const cache = `${homedir()}/.cache/ms-playwright`;
const chromiumPath = process.env.MESH_CHROMIUM || (existsSync(cache) ? readdirSync(cache).filter(p => /^chromium-\d+$/.test(p))
  .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  .flatMap(p => [`${cache}/${p}/chrome-linux64/chrome`, `${cache}/${p}/chrome-linux/chrome`]).find(existsSync) : undefined);
const skip = !chromiumPath && !process.env.MESH_REQUIRE_BROWSER ? 'Chromium unavailable' : false;
let browser: Browser, server: Server, base: string;
const hostile = '<img src=x onerror=1>';

declare const lab: {
  calls: (ConsentMutation | ProfileMutation | ProvisionMutation)[]; loads: number; profiles: Profile[]; policy: Policy; holdWrite: boolean; holdLoad: boolean;
  fail: string | null; createFail: string | null; readFail: string | null; finishWrite: () => void; finishLoad: () => void;
  panel: {open: () => Promise<void>; close: () => void};
};

before(async () => {
  if (skip) return;
  const built = await build({stdin: {resolveDir: root, contents: `
    import {createBackendAccountPanel} from './static/backend-account-panel.ts';
    import {provisionJournal} from './static/backend-account-provision-journal.ts';
    window.testProvisionJournal = () => provisionJournal(localStorage, indexedDB, crypto);
    const catalog = await (await fetch('/catalog.json' + location.search)).json();
    const t = (key, params = {}) => {
      if (!(key in catalog)) throw new Error('Missing catalog key: ' + key);
      return catalog[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? '{' + name + '}'));
    };
    const digest = 'a'.repeat(64), reply = data => ({version: 1, ok: true, data});
    const backends = ['claude', 'codex', 'opencode-v2', 'pi'];
    window.lab = {calls: [], loads: 0, fail: null, createFail: null, readFail: null, holdWrite: false, holdLoad: false, registryRevision:digest,
      policy: {version: 1, revision: 0, global: 'ask', pairs: []},
      profiles: backends.flatMap(backend => ['a', 'b', 'c'].map(id => ({backend, id, label: id === 'a' ? ${JSON.stringify(hostile)} : id === 'c' ? '界'.repeat(24) : 'Account ' + id,
        context_revision: digest, enabled: true, switch_qualified: false})))};
    const ref = ({backend, id, context_revision}) => ({backend, id, context_revision});
    const panel = createBackendAccountPanel(document.querySelector('main'), {t, timeoutMs: 10000,
      load: async () => {
        lab.loads++;
         const result = structuredClone({profiles: reply({configured: true, registry_revision: lab.registryRevision, profiles: lab.profiles}),
           policy: lab.readFail ? {version:1,ok:false,http_status:503,code:lab.readFail} : reply(lab.policy)});
        if (lab.holdLoad) return new Promise(resolve => { lab.finishLoad = () => resolve(result); });
        return result;
      },
      mutate: async request => {
        lab.calls.push(structuredClone(request));
        if (lab.fail === 'private') return {...reply(lab.policy), roots: {config: 'not-public'}};
        if (lab.fail) return {version: 1, ok: false, code: lab.fail};
        const commit = () => {
          let policy = structuredClone(lab.policy);
          if (request.expected_revision !== policy.revision) return {version: 1, ok: false, code: 'consent-revision-conflict'};
          policy.revision++;
          if (request.op === 'consent.set_global') policy.global = request.confirmation;
          if (request.op === 'consent.reset') { policy.global = 'ask'; policy.pairs = []; }
          if (request.op === 'consent.set_pair' || request.op === 'consent.remove_pair') {
            policy.pairs = policy.pairs.filter(r => !(r.a.backend === request.backend && r.a.id === request.source_id && r.b.id === request.target_id));
            if (request.op === 'consent.set_pair') {
              const a = lab.profiles.find(p => p.backend === request.backend && p.id === request.source_id);
              const b = lab.profiles.find(p => p.backend === request.backend && p.id === request.target_id);
              policy.pairs.push({a: ref(a), b: ref(b), confirmation: request.confirmation});
            }
          }
          lab.policy = policy; return reply(policy);
        };
        if (lab.holdWrite) return new Promise(resolve => { lab.finishWrite = () => resolve(commit()); });
        return commit();
      },
      create: async request => {
        lab.calls.push(structuredClone(request));
        if (lab.createFail) return {http_status:lab.createFail==='profile-publication-uncertain'?503:409,
          version:1,ok:false,code:lab.createFail};
        const {roots,...metadata} = request.profile;
        const p = {...metadata,enabled:true,context_revision:digest,switch_qualified:false};
        lab.profiles.push(p);
        lab.registryRevision='b'.repeat(64);
        return reply({registry_revision:lab.registryRevision,profile:p});
      },
      inspect: async () => {
        if (lab.readFail) return {version:1,ok:false,http_status:503,code:lab.readFail};
        return reply({configured:true,registry_revision:lab.registryRevision,profiles:lab.profiles});
      },
      provision: {backends:['codex'], write:async request => {
        lab.calls.push(structuredClone(request));
        if (lab.createFail) return {http_status:lab.createFail==='profile-publication-uncertain'?503:409,
          version:1,ok:false,code:lab.createFail};
        const p={...request.profile,id:'p-0123456789abcdef',enabled:false,context_revision:digest,switch_qualified:false};
        lab.profiles.push(p);lab.registryRevision='c'.repeat(64);
        return reply({registry_revision:lab.registryRevision,profile:p});
      }},
    });
    lab.panel = panel;
    document.querySelector('#open').textContent = t('backendAccounts.title');
    document.querySelector('#open').onclick = event => { void panel.open(event.currentTarget); };
  `}, bundle: true, format: 'esm', target: 'es2022', write: false});
  const js = built.outputFiles[0]!.text;
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
    if (url.pathname === '/component.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
    else if (url.pathname === '/panel.css') { res.setHeader('Content-Type', 'text/css'); res.end(readFileSync(`${root}/static/backend-account-panel.css`)); }
    else if (url.pathname === '/catalog.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalogs[url.searchParams.get('lang') ?? 'en'])); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/panel.css"></head><body><button id="open"></button><main></main><script type="module" src="/component.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}`;
  assert.ok(chromiumPath, 'a Chromium executable is required for the component checks');
  browser = await chromium.launch(chromiumLaunchOptions(chromiumPath, ['--no-sandbox']));
});
after(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

async function fixture(lang = 'en', width = 1440) {
  const context = await browser.newContext({locale: lang, viewport: {width, height: 900}}), page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/?lang=${lang}`); await page.locator('#open').filter({hasText: catalogs[lang]!['backendAccounts.title']!}).waitFor();
  await page.locator('#open').click(); await statusIs(page, lang, 'ready');
  return {page, errors, context};
}
async function statusIs(page: Page, lang: string, phase: string) {
  await page.getByRole('status').filter({hasText: catalogs[lang]![`backendAccounts.status.${phase}`]!}).waitFor();
}
const control = (page: Page, key: string) => page.locator(`[data-focus="${key}"]`);
test('provision journal acquisition is atomic across tabs and preserves legacy uncertainty', {skip}, async () => {
  const {page, context, errors} = await fixture();
  try {
    const other = await context.newPage();
    await other.goto(base + '/?lang=en');
    const acquire = (p: Page) => p.evaluate(async () => {
      // A key-index scan is unsafe when removals shift localStorage indices.
      Storage.prototype.key = () => { throw new Error('non-atomic enumeration'); };
      return (window as any).testProvisionJournal().acquire();
    });
    const results = await Promise.all([acquire(page), acquire(other)]);
    assert.equal(results.filter(r => r.acquired).length, 1);
    assert.deepEqual(results[0].entry, results[1].entry);
    const record = await page.evaluate(async () => (window as any).testProvisionJournal().load());
    assert.deepEqual(record, results[0].entry);
    const stable = 'f'.repeat(32);
    const receipt = JSON.stringify({version: 1, ok: true, data: {registry_revision: 'b'.repeat(64),
      profile: {backend: 'codex', id: 'p-0123456789abcdef', label: 'Travel',
        context_revision: 'a'.repeat(64), enabled: false, switch_qualified: false}}});
    await page.evaluate(async ({id, receipt}) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('mesh.backendAccounts.provision.v2', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('entries', 'readwrite');
        tx.objectStore('entries').add({id, value: receipt});
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, {id: stable, receipt});
    const [, duringDelete] = await Promise.all([
      page.evaluate(async id => (window as any).testProvisionJournal().save(id, null), record.id),
      acquire(other),
    ]);
    assert.equal(duringDelete.acquired, false, 'deleting one record must not hide the other');
    assert.deepEqual(await other.evaluate(async () => (window as any).testProvisionJournal().load()),
      {id: stable, value: receipt});
    await page.evaluate(() => localStorage.setItem('mesh.backendAccounts.provision.v1', 'uncertain'));
    const legacy = await other.evaluate(async () => (window as any).testProvisionJournal().acquire());
    assert.equal(legacy.acquired, false);
    assert.equal(legacy.entry.value, 'uncertain');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
for (const lang of ['en','fr']) test(`component ${lang}: provision collects only backend and label and never retries an uncertain write`,{skip},async()=>{
  const {page,context,errors}=await fixture(lang);
  try {
    await control(page,'provision-account').click();
    assert.deepEqual(await control(page,'create-backend').locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value)),['codex']);
    assert.equal(await control(page,'create-id').count(),0);
    assert.equal(await control(page,'create-config').count(),0);
    await control(page,'create-label').fill('  Travel  ');
    await page.evaluate(()=>{lab.createFail='profile-publication-uncertain';});
    await control(page,'save-account').click();
    await statusIs(page,lang,'provisionUncertain');
    assert.equal(await control(page,'create-label').inputValue(),'  Travel  ');
    assert.equal(await control(page,'save-account').isDisabled(),true);
    await page.evaluate(()=>{lab.createFail=null;});
    await control(page,'refresh').click();await statusIs(page,lang,'provisionUncertain');
    const request={version:1,op:'profiles.provision',registry_revision:'a'.repeat(64),profile:{backend:'codex',label:'Travel'}};
    assert.deepEqual(await page.evaluate(()=>lab.calls),[request]);
    assert.equal(await control(page,'save-account').isDisabled(),true);
    await control(page,'close').click();
    await page.locator('#open').click();
    await statusIs(page,lang,'provisionUncertain');
    assert.equal(await control(page,'provision-account').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>({calls:lab.calls,loads:lab.loads})),{calls:[request],loads:3});
    await control(page,'add-account').click(); // Association remains a separate form.
    assert.equal(await control(page,'create-config').count(),1);
    await page.reload();
    await page.locator('#open').click();
    await statusIs(page,lang,'provisionUncertain');
    assert.equal(await control(page,'provision-account').isDisabled(),true);
    assert.equal(await control(page,'add-account').isEnabled(),true);
    assert.ok(await page.locator('dialog li').count() > 0, 'runner registry is still inspectable');
    assert.deepEqual(await page.evaluate(()=>({calls:lab.calls,loads:lab.loads})),{calls:[],loads:0});
    const reopened = await context.newPage();
    await reopened.goto(`${base}/?lang=${lang}`);
    await reopened.locator('#open').click();
    await statusIs(reopened,lang,'provisionUncertain');
    assert.equal(await control(reopened,'provision-account').isDisabled(),true);
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});
test('component restores no provision draft after verifying an acknowledged receipt',{skip},async()=>{
  const {page,context}=await fixture();
  try {
    await control(page,'provision-account').click();
    await control(page,'create-label').fill('Travel');
    await page.evaluate(()=>{lab.readFail='busy';});
    await control(page,'save-account').click();
    await statusIs(page,'en','provisionVerification');
    assert.equal(await control(page,'save-account').isDisabled(),true);
    await page.evaluate(()=>{lab.readFail=null;});
    await control(page,'refresh').click();
    await statusIs(page,'en','saved');
    assert.equal(await control(page,'save-account').count(),0);
    assert.equal(await page.evaluate(()=>lab.calls.length),1);
    const row=page.locator('dialog li').filter({hasText:'p-0123456789abcdef'});
    assert.ok((await row.textContent())!.includes(catalogs.en!['backendAccounts.profileDisabled']!));
  } finally {await context.close();}
});
test('component restores a confirmed receipt after reloading the tab without reading consent',{skip},async()=>{
  const {page,context}=await fixture();
  try {
    await control(page,'provision-account').click();
    await control(page,'create-label').fill('Travel');
    await page.evaluate(()=>{lab.readFail='busy';});
    await control(page,'save-account').click();
    await statusIs(page,'en','provisionVerification');
    const committed = await page.evaluate(()=>lab.profiles);
    await page.reload();
    await page.locator('#open').click();
    await statusIs(page,'en','provisionVerification');
    await page.evaluate(profiles=>{
      Object.assign(lab, {profiles, registryRevision:'c'.repeat(64)});
    }, committed);
    await control(page,'refresh').click();
    await statusIs(page,'en','saved');
    assert.equal(await control(page,'save-account').count(),0);
    assert.equal(await page.locator('dialog li').filter({hasText:'p-0123456789abcdef'}).count(),1);
    assert.deepEqual(await page.evaluate(()=>({calls:lab.calls,loads:lab.loads})),{calls:[],loads:0});
  } finally {await context.close();}
});
for (const lang of ['en','fr']) test(`component ${lang}: confirmed create with refused reread stays review-only`,{skip},async()=>{
  const {page,context,errors}=await fixture(lang);
  try {
    await control(page,'add-account').click();
    await control(page,'create-backend').selectOption('claude');
    await control(page,'create-id').fill('readback-alias');
    await control(page,'create-label').fill('Readback');
    await control(page,'create-config').fill('/fixture/config');
    await control(page,'create-history').fill('/fixture/history');
    await page.evaluate(()=>{lab.readFail='busy';});
    await control(page,'save-account').click();
    await statusIs(page,lang,'verification');
    assert.equal((await page.getByRole('status').textContent())!.includes(catalogs[lang]!['backendAccounts.status.refused']!),false);
    assert.equal(await control(page,'create-id').inputValue(),'readback-alias');
    assert.equal(await control(page,'save-account').isDisabled(),true);
    assert.equal(await page.evaluate(()=>lab.calls.filter(call=>call.op==='profiles.create').length),1);
    await page.evaluate(()=>{lab.readFail=null;});
    await control(page,'refresh').click();
    await statusIs(page,lang,'ready');
    assert.equal(await page.evaluate(()=>lab.calls.filter(call=>call.op==='profiles.create').length),1);
    assert.equal(await page.locator('dialog li').filter({hasText:'readback-alias'}).count(),1);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); }
});
for (const lang of ['en','fr']) test(`component ${lang}: add-account form has backend roles, no credentials, and survives refusal`,{skip},async()=>{
  const {page,context,errors}=await fixture(lang);
  try {
    await control(page,'add-account').click();
    await control(page,'create-backend').selectOption('opencode-v2');
    await control(page,'create-id').fill('new-account');
    await control(page,'create-label').fill(' \tNew account \t');
    for(const role of ['config','data','state','cache']) await control(page,`create-${role}`).fill(`/fixture/${role}`);
    assert.equal(await page.locator('dialog input[type="password"],dialog input[name*="token"],dialog input[name*="secret"]').count(),0);
    assert.equal(await control(page,'create-history').count(),0);
    await page.evaluate(()=>{lab.createFail='profile-registry-changed';});
    await control(page,'save-account').click();
    await statusIs(page,lang,'conflict');
    assert.ok((await page.getByRole('status').textContent())!.includes(catalogs[lang]!['backendAccounts.refusal.profile-registry-changed']!));
    assert.equal(await control(page,'create-id').inputValue(),'new-account');
    assert.equal(await control(page,'create-state').inputValue(),'/fixture/state');
    assert.equal(await page.evaluate(()=>lab.profiles.some(p=>p.id==='new-account')),false);
    await page.evaluate(()=>{lab.createFail='profile-publication-uncertain';});
    await control(page,'refresh').click();
    await statusIs(page,lang,'ready');
    assert.equal(await control(page,'create-id').inputValue(),'new-account');
    await control(page,'save-account').click();
    await statusIs(page,lang,'error');
    assert.equal((await page.getByRole('status').textContent())!.includes(catalogs[lang]!['backendAccounts.status.refused']!),false);
    assert.equal(await control(page,'create-id').inputValue(),'new-account');
    assert.equal(await page.evaluate(()=>lab.profiles.some(p=>p.id==='new-account')),false);
    assert.equal(await control(page,'save-account').isDisabled(),true);
    await page.evaluate(()=>{lab.createFail=null;});
    await control(page,'refresh').click();
    await statusIs(page,lang,'ready');
    await control(page,'save-account').click(); await statusIs(page,lang,'saved');
    assert.equal(await page.evaluate(()=>{const last=lab.calls.at(-1);return last?.op==='profiles.create'?last.profile.label:null;}),'New account');
    assert.equal(await control(page,'create-id').count(),0);
    assert.equal(await page.locator('dialog li').filter({hasText:'new-account'}).count(),1);
    await control(page,'add-pair').click();
    await control(page,'pair-backend').selectOption('opencode-v2');
    assert.ok((await control(page,'pair-a').locator('option').allTextContents()).some(text=>text.includes('new-account')));
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});
async function addPair(page: Page, backend: Backend, reversed = false) {
  await control(page, 'add-pair').click(); await control(page, 'pair-backend').selectOption(backend);
  await control(page, 'pair-a').selectOption(reversed ? 'b' : 'a');
  await control(page, 'pair-b').selectOption(reversed ? 'a' : 'b');
}
async function fits(page: Page) {
  const fit = await page.evaluate(() => {
    const dialog = document.querySelector('dialog')!, box = dialog.getBoundingClientRect();
    return {page: document.documentElement.scrollWidth <= innerWidth, dialog: dialog.scrollWidth <= dialog.clientWidth,
      bounds: box.left >= 0 && box.right <= innerWidth,
      controls: Array.from(dialog.querySelectorAll('button,select,fieldset')).every(el => el.scrollWidth <= el.clientWidth)};
  });
  assert.deepEqual(fit, {page: true, dialog: true, bounds: true, controls: true});
}

for (const lang of ['en', 'fr']) for (const width of [1440, 390]) {
  test(`component ${lang} ${width}: explicit global/pair saves, all backends, reverse dedup, fallback/reset and layout`, {skip}, async () => {
    const {page, errors, context} = await fixture(lang, width);
    try {
      assert.equal(await page.getByRole('dialog', {name: catalogs[lang]!['backendAccounts.title']}).count(), 1);
      assert.equal(await page.locator('dialog img, dialog script, dialog a').count(), 0);
      assert.ok((await page.locator('dialog').textContent())!.includes(hostile));
      assert.equal(await page.evaluate(() => lab.calls.length), 0);
      assert.equal(await page.locator('dialog input:not([type="radio"])').count(), 0);
      assert.ok((await page.locator('dialog').textContent())!.includes(catalogs[lang]!['backendAccounts.globalWarning']!));
      await control(page, 'global-skip').check();
      assert.equal(await page.evaluate(() => lab.calls.length), 0);
      await control(page, 'save-global').click(); await statusIs(page, lang, 'saved');
      assert.equal(await page.evaluate(() => lab.policy.global), 'skip');
      for (const backend of BACKENDS) {
        const before = await page.evaluate(() => lab.calls.length);
        await addPair(page, backend);
        assert.ok((await page.locator('[data-preview]').textContent())!.includes(catalogs[lang]!['backendAccounts.previewOverride']!));
        assert.equal(await page.evaluate(() => lab.calls.length), before);
        await fits(page);
        await control(page, 'save-pair').click(); await statusIs(page, lang, 'saved');
        assert.equal(await page.locator(`[data-rule="${backend}:a:b"]`).count(), 1);
        await addPair(page, backend, true);
        assert.equal(await control(page, 'pair-rule-ask').isChecked(), true);
        await control(page, 'pair-rule-skip').focus(); await page.keyboard.press('ArrowLeft');
        assert.equal(await control(page, 'pair-rule-ask').isChecked(), true);
        await control(page, 'pair-rule-skip').check(); await control(page, 'save-pair').click(); await statusIs(page, lang, 'saved');
        assert.equal(await page.locator(`[data-rule="${backend}:a:b"]`).count(), 1);
        const request = await page.evaluate(() => lab.calls.at(-1));
        assert.deepEqual(request && {backend: 'backend' in request ? request.backend : '', op: request.op,
          source: 'source_id' in request ? request.source_id : '', target: 'target_id' in request ? request.target_id : ''},
        {backend, op: 'consent.set_pair', source: 'a', target: 'b'});
      }
      assert.equal(await page.locator('[data-rule]').count(), 4);
      await addPair(page, 'pi');
      assert.equal(await control(page, 'pair-rule-skip').isChecked(), true, 'existing pair loads its rule');
      await control(page, 'pair-b').selectOption('c');
      assert.equal(await control(page, 'pair-rule-ask').isChecked(), true, 'a different unconfigured pair starts with confirmation');
      await control(page, 'cancel-edit').click();
      const beforeCancel = await page.evaluate(() => lab.calls.length);
      await addPair(page, 'pi'); await control(page, 'cancel-edit').click();
      assert.equal(await page.evaluate(() => lab.calls.length), beforeCancel, 'cancel edit never writes');
      await fits(page);
      const row = page.locator('[data-rule="pi:a:b"]');
      assert.ok((await row.textContent())!.includes(catalogs[lang]!['backendAccounts.removeFallback']!.replace('{confirmation}', catalogs[lang]!['backendAccounts.skip']!)));
      await row.getByRole('button', {name: new RegExp(lang === 'en' ? '^Remove rule for' : '^Supprimer la règle pour')}).click();
      await statusIs(page, lang, 'saved'); assert.equal(await page.locator('[data-rule="pi:a:b"]').count(), 0);
      await control(page, 'reset').click(); await statusIs(page, lang, 'saved');
      assert.deepEqual(await page.evaluate(() => ({global: lab.policy.global, pairs: lab.policy.pairs})), {global: 'ask', pairs: []});
      await control(page, 'add-pair').click(); await control(page, 'pair-a').selectOption('a'); await control(page, 'pair-b').selectOption('a');
      assert.equal(await control(page, 'save-pair').isDisabled(), true);
      await control(page, 'cancel-edit').click();
      await control(page, 'close').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true, 'native modal traps focus');
      const mutations = await page.evaluate(() => lab.calls.length);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.equal(await page.locator('#open').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => lab.calls.length), mutations);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('component: conflict and leaking/malformed success disable edits until explicit refresh; no replay', {skip}, async () => {
  const {page, errors, context} = await fixture();
  try {
    for (const failure of ['consent-revision-conflict', 'profile-registry-changed', 'consent-rule-capacity', 'consent-revision-exhausted', 'private']) {
      await page.evaluate(f => { lab.fail = f; }, failure);
      await addPair(page, 'pi'); await control(page, 'save-pair').click();
      await statusIs(page, 'en', failure === 'private' ? 'error' : 'conflict');
      assert.equal(await control(page, 'add-pair').isDisabled(), true);
      assert.equal(await control(page, 'save-global').isDisabled(), true);
      const count = await page.evaluate(() => lab.calls.length);
      assert.equal(await page.locator('dialog').getByText('not-public', {exact: true}).count(), 0);
      await page.evaluate(() => { lab.fail = null; lab.policy = {...lab.policy, revision: lab.policy.revision + 1, global: 'skip'}; });
      await control(page, 'refresh').click(); await statusIs(page, 'en', 'ready');
      assert.equal(await page.locator('[data-focus="save-pair"]').count(), 0, 'refresh discards stale drafts for review');
      assert.equal(await page.evaluate(() => lab.calls.length), count);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('component: definite native refusals have their own not-saved status in both catalogs, never uncertain-write text', {skip}, async () => {
  for (const lang of ['en', 'fr']) {
    const {page, errors, context} = await fixture(lang, 390);
    try {
      for (const code of ['invalid-request', 'unknown-profile', 'request-too-large', 'unsafe-configuration-root', 'backend-transaction-aborted', 'busy']) {
        await page.evaluate(code => { lab.fail = code; }, code);
        await control(page, 'global-skip').check(); await control(page, 'save-global').click(); await statusIs(page, lang, 'refused');
        assert.equal(await control(page, 'save-global').isDisabled(), true);
        assert.equal(await control(page, 'add-pair').isDisabled(), true);
        assert.ok(!(await page.getByRole('status').textContent())!.includes(catalogs[lang]!['backendAccounts.status.error']!));
        const calls = await page.evaluate(() => lab.calls.length);
        await page.evaluate(() => { lab.fail = null; });
        await control(page, 'refresh').click(); await statusIs(page, lang, 'ready');
        assert.equal(await page.evaluate(() => lab.calls.length), calls);
        assert.equal(await control(page, 'global-ask').isChecked(), true);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('component: rejected public listing never reveals private fields or offers mutation controls', {skip}, async () => {
  const {page, errors, context} = await fixture('fr', 390);
  try {
    await page.evaluate(() => { lab.profiles[0] = {...lab.profiles[0]!, roots: {config: 'private-listing-value'}} as Profile; });
    await control(page, 'refresh').click(); await statusIs(page, 'fr', 'loadError');
    assert.equal(await control(page, 'save-global').count(), 0);
    assert.equal(await control(page, 'add-pair').count(), 0);
    assert.equal(await page.locator('dialog').getByText('private-listing-value', {exact: true}).count(), 0);
    assert.equal(await page.evaluate(() => lab.calls.length), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('component: pending writes disable controls; old write/load after close/reopen cannot touch current UI', {skip}, async () => {
  const {page, errors, context} = await fixture();
  try {
    await page.evaluate(() => { lab.holdWrite = true; });
    await control(page, 'global-skip').check(); await control(page, 'save-global').click(); await statusIs(page, 'en', 'saving');
    assert.equal(await control(page, 'add-pair').isDisabled(), true);
    assert.equal(await control(page, 'refresh').isDisabled(), true);
    assert.equal(await control(page, 'reset').isDisabled(), true);
    await control(page, 'close').click(); await page.locator('#open').click(); await statusIs(page, 'en', 'ready');
    await addPair(page, 'pi');
    await page.evaluate(() => { lab.finishWrite(); });
    assert.equal(await control(page, 'global-ask').isChecked(), true);
    assert.equal(await control(page, 'pair-a').inputValue(), 'a');
    assert.equal(await page.evaluate(() => lab.calls.length), 1);
    await page.evaluate(() => { lab.panel.close(); lab.holdLoad = true; void lab.panel.open(); });
    await statusIs(page, 'en', 'loading');
    // Loading is rendered before asynchronous journal inspection reaches load().
    // Ensure the old load is actually pending before closing its generation.
    await page.waitForFunction(() => typeof lab.finishLoad === 'function');
    await page.evaluate(() => { lab.panel.close(); lab.holdLoad = false; lab.policy = {...lab.policy, revision: 10, global: 'ask'}; void lab.panel.open(); });
    await statusIs(page, 'en', 'ready');
    await page.evaluate(() => { lab.finishLoad(); });
    assert.equal(await control(page, 'global-ask').isChecked(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('component: stale and retired contexts are described without granting stale Skip or inventing labels', {skip}, async () => {
  const {page, errors, context} = await fixture();
  try {
    await page.evaluate(() => {
      const ref = (p: Profile) => ({backend: p.backend, id: p.id, context_revision: p.context_revision});
      const a = ref(lab.profiles.find(p => p.backend === 'claude' && p.id === 'a')!);
      const b = ref(lab.profiles.find(p => p.backend === 'claude' && p.id === 'b')!);
      lab.policy = {version: 1, revision: 1, global: 'ask', pairs: [{a, b, confirmation: 'skip'}, {a: {...a, backend: 'pi'}, b: {...b, backend: 'pi'}, confirmation: 'ask'}]};
      lab.profiles = lab.profiles.filter(p => !(p.backend === 'pi' && p.id === 'b')).map(p => p.backend === 'claude' && p.id === 'a' ? {...p, context_revision: 'b'.repeat(64), label: 'Renamed profile'} : p);
    });
    await control(page, 'refresh').click(); await statusIs(page, 'en', 'ready');
    const stale = page.locator('[data-rule="claude:a:b"]'), retired = page.locator('[data-rule="pi:a:b"]');
    assert.ok((await stale.textContent())!.includes(catalogs.en!['backendAccounts.ruleStatus.stale']!));
    assert.ok((await stale.textContent())!.includes('Renamed profile'));
    assert.ok((await stale.textContent())!.includes('Effective result: Ask every time'));
    assert.ok((await retired.textContent())!.includes(catalogs.en!['backendAccounts.ruleStatus.retired']!));
    assert.equal(await retired.getByRole('button', {name: /^Edit/}).count(), 0);
    await retired.getByRole('button', {name: /^Remove/}).click(); await statusIs(page, 'en', 'saved');
    assert.equal(await page.locator('[data-rule="pi:a:b"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('component: keyboard removal restores a surviving control without stealing moved focus', {skip}, async () => {
  const {page, errors, context} = await fixture();
  try {
    await addPair(page, 'pi'); await control(page, 'save-pair').click(); await statusIs(page, 'en', 'saved');
    await control(page, 'remove-pi:a:b').focus(); await page.keyboard.press('Enter'); await statusIs(page, 'en', 'saved');
    assert.equal(await control(page, 'add-pair').evaluate(el => el === document.activeElement), true);
    await addPair(page, 'pi'); await control(page, 'save-pair').click(); await statusIs(page, 'en', 'saved');
    await page.evaluate(() => { lab.holdWrite = true; });
    await control(page, 'remove-pi:a:b').focus(); await page.keyboard.press('Enter'); await statusIs(page, 'en', 'saving');
    await control(page, 'close').focus();
    await page.evaluate(() => { lab.finishWrite(); }); await statusIs(page, 'en', 'saved');
    assert.equal(await control(page, 'close').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('component: pair save restores focus only if the user did not move it', {skip}, async () => {
  const {page, errors, context} = await fixture();
  try {
    await addPair(page, 'pi');
    await page.evaluate(() => { lab.holdWrite = true; });
    await control(page, 'save-pair').focus(); await page.keyboard.press('Enter'); await statusIs(page, 'en', 'saving');
    await control(page, 'close').focus();
    await page.evaluate(() => { lab.finishWrite(); }); await statusIs(page, 'en', 'saved');
    assert.equal(await control(page, 'close').evaluate(el => el === document.activeElement), true);
    assert.equal(await control(page, 'save-pair').count(), 0);
    await page.evaluate(() => { lab.holdWrite = false; });
    await addPair(page, 'pi');
    await control(page, 'pair-b').selectOption('c');
    await control(page, 'save-pair').focus(); await page.keyboard.press('Enter'); await statusIs(page, 'en', 'saved');
    assert.equal(await control(page, 'add-pair').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
