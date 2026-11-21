// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';
import {test, harness, open, record, closeCompose, select, dataFrames, ready, typeNative, holdEnter, runEnter, wire, observeOutput} from '../../checks/dictation-browser-fixture.ts';

// Application script-scope bindings, resolved inside browser callbacks.
declare const active: any, dictation: any, dictationInventoryReady: boolean;
declare function composeDictationSession(): any;

test('actual app exposes accessible hold dictation (fake API/media, not phone proof)', async () => {
  await harness(async page => {
    assert.equal(await page.locator('#compose-mic').count(), 1);
    assert.match(await page.locator('#compose-mic').getAttribute('aria-label') || '', /dicter/i);
  });
});

test('A released before ack, SAME Pane B then C: queue/process/manual drafts, no PTY or focus change', async () => {
  await harness(async (page, api, sockets, writes) => {
    const originalPane = await page.evaluate(() => (active.inputLeaseSlot));
    await record(page); await closeCompose(page);
    await select(page, 'B'); assert.equal(await page.evaluate(() => (active.inputLeaseSlot)), originalPane);
    await record(page); await closeCompose(page); await select(page, 'C');
    await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    assert.equal(api.jobs.length, 2); api.ack('A'); api.ack('B');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'queued');
    api.jobs[0]!.state = 'processing';
    await page.waitForFunction(() => dictation.session('A', 1).state === 'processing');
    assert.match(await page.locator('#list [data-id="A"]').innerText(), /Transcription en cours/);
    assert.match(await page.locator('#list [data-id="B"]').innerText(), /file d’attente/);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'bonjour A\nseconde ligne';
    api.jobs[1]!.state = 'ready'; api.jobs[1]!.text = 'bonjour B';
    await page.waitForFunction(() => dictation.session('A', 1).state === 'ready' && dictation.session('B', 2).state === 'ready');
    assert.equal(await page.evaluate(() => (active.id)), 'C');
    assert.equal(await page.evaluate(() => (document.activeElement.classList.contains("xterm-helper-textarea"))), true);
    assert.equal(dataFrames(writes).length, 0);
    assert.equal(sockets.get('A')!.length, 1); assert.equal(sockets.get('B')!.length, 1);
    assert.equal(await page.evaluate(() => ((window.micStreams).every(s => s.getTracks().every(t => t.readyState === "ended")))), true);
    await select(page, 'A'); await open(page);
    assert.equal(await page.locator('#compose-text').inputValue(), 'bonjour A\nseconde ligne');
    assert.equal(await page.locator('#compose-insert').isDisabled(), true);
    await page.locator('#compose-text').fill('edited A'); await closeCompose(page); await open(page);
    assert.equal(await page.locator('#compose-text').inputValue(), 'edited A');
    assert.equal(api.uploads.every(u => u.bytes > 0 && /^audio\/webm/.test(String(u.headers['content-type']))), true);
    assert.equal(new Set(api.uploads.map(u => u.headers['x-mesh-dictation-client'])).size, 1);
    assert.equal(await page.evaluate(() => (reloadHolds().some(h => h.kind === "dictation"))), true);
  });
});

test('lost upload ack reconciles same request, cancel latches; no second audio POST', async () => {
  await harness(async (page, api, _sockets, writes) => {
    api.lose(); await record(page); await closeCompose(page);
    await page.waitForFunction(() => dictation.session('A', 1).job !== null);
    assert.equal(api.uploads.length, 1);
    await page.locator('#dictation-jobs button').filter({hasText: 'Abandonner'}).click();
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.equal(api.jobs[0]!.state, 'cancelled'); assert.equal(api.uploads.length, 1);
    assert.equal(dataFrames(writes).length, 0);
  });
});

test('manual Send uses ORIGINAL retained socket, shared H identity and real xterm bracketed newline framing', async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await closeCompose(page); await select(page, 'B');
    sockets.get('A')![0]!.send(Buffer.from('\x1b[?2004h'));
    await ready(page, api); assert.equal(dataFrames(writes).length, 0);
    await select(page, 'A'); await open(page); await page.locator('#compose-send').click();
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    const original = writes.get('A:0')!, replacement = writes.get('A:1')!;
    assert.deepEqual(original.filter(v => typeof v !== 'string').map(v => v.toString()), ['\x1b[200~alpha\rbeta\x1b[201~', '\r']);
    assert.equal(replacement.filter(v => typeof v !== 'string').length, 0);
    const controls = original.filter((v): v is string => typeof v === 'string').map(v => JSON.parse(v)).filter(v => v.t === 'h');
    assert.equal(new Set(controls.map(v => v.client_id)).size, 1);
    assert.deepEqual(controls.map(v => v.dirty), [false, true, false]);
    assert.equal(api.jobs[0]!.outcome, 'submitted');
  });
});

test('whitespace/programmatic attachment edits and disabled config never request microphone', async () => {
  await harness(async (page, api) => {
    await open(page);
    for (const text of [' ', '\n', '/uploaded/attachment ']) {
      await page.locator('#compose-text').fill(text);
      await page.locator('#compose-mic').focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
      assert.equal(await page.evaluate(() => (window.micCalls)), 0);
    }
    await page.locator('#compose-text').fill('');
    await page.evaluate(() => {insertAtCursor(ctext,"/uploaded/programmatic "); composeOwner.change(); syncDictationDraft()});
    await closeCompose(page); await open(page);
    assert.equal(await page.locator('#compose-text').inputValue(), '/uploaded/programmatic ');
    api.disable(); await page.reload(); await page.waitForFunction(() => active?.conn?.terminal?.isOpen());
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => (window.micCalls)), 0); assert.equal(api.uploads.length, 0);
  });
});

test('late permission after close, denial, pointercancel and synthetic hidden cleanup stop every track', async () => {
  await harness(async (page, api) => {
    await page.evaluate(() => ((() => {
      const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.realGum=gum; navigator.mediaDevices.getUserMedia=async c=>{
        const stream=await gum(c); return new Promise(r=>window.latePermission=()=>r(stream));
      };
    })()));
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => typeof (window as any).latePermission === 'function');
    await closeCompose(page);
    assert.equal(await page.locator('#dlg-compose').evaluate(el => (el as HTMLDialogElement).open), false, 'late permission: close must close modal');
    await page.evaluate(() => (window.latePermission())); await page.keyboard.up('Space');
    assert.equal(await page.locator('#dlg-compose').evaluate(el => (el as HTMLDialogElement).open), false, 'late permission: key release must not reopen modal');
    await page.waitForFunction(() => (window as any).micStreams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
    await page.evaluate(() => (navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException("denied","NotAllowedError"))));
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'error'); await page.keyboard.up('Space');
    assert.match(await page.locator('#dictation-status').innerText(), /refusée/);
    await page.evaluate(() => {dictation.discard(composeDictationSession()); navigator.mediaDevices.getUserMedia=window.realGum});
    await page.locator('#compose-mic').dispatchEvent('pointerdown', {button: 0, pointerId: 1});
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.locator('#compose-mic').dispatchEvent('pointercancel', {pointerId: 1});
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.evaluate(() => {Object.defineProperty(document,"hidden",{configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange"))});
    await page.keyboard.up('Space');
    await page.waitForFunction(() => (window as any).micStreams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
    assert.equal(api.uploads.length, 0);
  });
});

test('disconnect/reincarnation and full context disposal retain recovery but never input', async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await closeCompose(page); await select(page, 'B');
    sockets.get('A')![0]!.close(); await ready(page, api);
    await select(page, 'A'); await open(page); await page.locator('#compose-send').click();
    assert.equal(dataFrames(writes).length, 0); assert.equal(api.jobs[0]!.state, 'ready');
    await closeCompose(page); api.inventory.mesh[0]!.created = 10;
    await page.evaluate(() => (refresh()));
    assert.equal(await page.evaluate(() => (dictation.session("A",10).text)), '');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
    await page.evaluate(() => ((async()=>{const ui=await localMesh;ui.dispose()})()));
    assert.equal(await page.evaluate(() => (localTerminalHandles.size)), 0);
    assert.equal(dataFrames(writes).length, 0);
  });
});

test('real pointer hold/release outside and Enter hold admit only at release; page state stays memory-only', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); const box = (await page.locator('#compose-mic').boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 4); await page.mouse.down();
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    assert.equal(api.uploads.length, 0); await page.waitForTimeout(350);
    await page.mouse.move(5, 5); await page.mouse.up();
    await page.waitForFunction(() => composeDictationSession().state === 'uploading');
    await closeCompose(page); await ready(page, api);
    const client = String(api.uploads[0]!.headers['x-mesh-dictation-client']);
    assert.equal(await page.evaluate(value => JSON.stringify({...localStorage,...sessionStorage}).includes(value), client), false);
    assert.equal(await page.evaluate(() => (JSON.stringify({...localStorage,...sessionStorage}).includes("alpha\nbeta"))), false);
    await select(page, 'B'); await open(page); await page.locator('#compose-mic').focus();
    await page.keyboard.down('Enter'); await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.waitForTimeout(350); assert.equal(api.uploads.length, 1); await page.keyboard.up('Enter');
    await page.waitForFunction(() => composeDictationSession().state === 'uploading');
    assert.equal(dataFrames(writes).length, 0);
    await page.evaluate(() => (dictation.dispose()));
    assert.equal(await page.evaluate(() => (window.micStreams.every(s=>s.getTracks().every(t=>t.readyState === "ended")))), true);
  });
});

test('pending Mesh context has no config/media/audio effects or obsolete remote entrypoint', async () => {
  await harness(async (page, api) => {
    assert.equal(api.seen.length, 0); assert.equal(await page.evaluate(() => (window.micCalls)), 0);
    // Mesh is local-only: the old device/gateway Deck entrypoint does not exist.
    assert.deepEqual(await page.evaluate(() => (Object.keys(MeshUI))), ['startLocalMesh', 'forgetKnownSessions']);
    assert.equal(await page.evaluate(() => (meshContext)), null);
    await page.locator('#compose-mic').dispatchEvent('pointerdown', {button: 0, pointerId: 1});
    await page.locator('#compose-mic').dispatchEvent('pointerup', {button: 0, pointerId: 1});
    assert.equal(api.seen.filter(path => path.startsWith('/api/transcribe')).length, 0);
    assert.equal(await page.evaluate(() => (window.micCalls)), 0);
    assert.equal(await page.evaluate(() => (dictation)), null);
  }, true);
});

test('composer dictation controls fit a narrow viewport (layout only, not phone capture)', async () => {
  await harness(async page => {
    await open(page); await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator('#dlg-compose').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('#compose-mic').isVisible(), true);
    assert.equal(await page.locator('#compose-send').isVisible(), true);
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.locator('#dictation-status').evaluate(el => {el.setAttribute('data-state', 'processing');});
    assert.equal(await page.locator('#dictation-status').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  });
});

test('CDP touch hold/release outside uses pointer capture and stops tracks (synthetic touch, not phone proof)', async () => {
  await harness(async (page, api) => {
    await open(page); const box = (await page.locator('#compose-mic').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: box.x + 5, y: box.y + 5}]});
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.waitForTimeout(350); assert.equal(api.uploads.length, 0);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 5, y: 5}]});
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitForFunction(() => composeDictationSession().state === 'uploading');
    await page.waitForFunction(() => (window as any).micStreams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
    await cdp.detach();
  });
});

test('editing after paste suppresses delayed Enter and keeps uncertain text/slot, never retries input', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.evaluate(() => {window.voiceEnter=[]; window.realTimer=window.setTimeout;
      window.setTimeout=(fn,ms,...args)=>ms===60?(window.voiceEnter.push(fn),0):window.realTimer(fn,ms,...args)});
    await page.locator('#compose-send').click(); await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    await page.locator('#compose-text').fill('edited while Enter pending');
    await page.evaluate(() => {window.voiceEnter.shift()(); window.setTimeout=window.realTimer});
    await page.waitForFunction(() => composeDictationSession().state === 'recovery');
    assert.deepEqual(dataFrames(writes).map(v => v.toString()), ['alpha\rbeta']);
    assert.equal(await page.locator('#compose-text').inputValue(), 'edited while Enter pending');
    assert.equal(api.jobs[0]!.state, 'ready');
    await page.evaluate(() => (dictation.reconcile(composeDictationSession())));
    assert.equal(dataFrames(writes).length, 1);
  });
});

test('unavailable inventory is not positive incarnation evidence for manual Send', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    api.inventory.management.state = 'unavailable'; await page.evaluate(() => (refresh()));
    assert.equal(await page.evaluate(() => (dictationInventoryReady)), false);
    await page.locator('#compose-send').click();
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'recovery');
    assert.equal(dataFrames(writes).length, 0); assert.equal(api.jobs[0]!.state, 'ready');
  });
});

test('explicit discard during delayed Enter waits for cancel ack and ignores the late delivery callback', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.evaluate(() => {window.voiceEnter=[]; window.realTimer=window.setTimeout;
      window.setTimeout=(fn,ms,...args)=>ms===60?(window.voiceEnter.push(fn),0):window.realTimer(fn,ms,...args)});
    await page.locator('#compose-send').click(); await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    await page.evaluate(() => (dictation.discard(composeDictationSession())));
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    await page.evaluate(() => {window.voiceEnter.shift()(); window.setTimeout=window.realTimer});
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'idle');
    assert.equal(api.jobs[0]!.state, 'cancelled');
    assert.deepEqual(dataFrames(writes).map(v => v.toString()), ['alpha\rbeta']);
  });
});

for (const timing of ['preflight', 'enter']) test(`another mounted Pane of the same A invalidates voice at ${timing}`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.evaluate(() => {window.originalA=active; window.otherA=addPane("A"); setActive(window.originalA)});
    await page.waitForFunction(() => (window as any).otherA.conn?.terminal?.isOpen());
    if (timing === 'preflight') api.holdRead(); else await holdEnter(page);
    await page.locator('#compose-send').click();
    if (timing === 'preflight') {
      for (let i = 0; !api.readHeld && i < 500; i++) await page.waitForTimeout(10);
      assert.equal(api.readHeld, true);
    } else await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    await closeCompose(page); await page.evaluate(() => (setActive(window.otherA))); await typeNative(page, 'other-view');
    if (timing === 'preflight') api.releaseRead(); else await runEnter(page);
    await page.waitForFunction(() => dictation.session('A', 1).state === 'recovery');
    assert.deepEqual(wire(writes, 'A:0'), timing === 'preflight' ? [] : ['alpha\rbeta']);
    assert.equal(wire(writes, 'A:1').join(''), 'other-view'); assert.equal(api.jobs[0]!.outcome, null);
    assert.equal(await page.evaluate(() => (window.otherA.inputLease.dirty)), true);
    assert.equal(await page.evaluate(() => (window.originalA.inputLease.revision === window.otherA.inputLease.revision)), true);
  });
});

for (const chunks of [['\x1b[?02004h'], ['\x1b[?000020', '04h'], ['\x1b[?1;2004:1;25h'],
  ['\x1b[?2004h', '\x1b[?00002004l'], ['\x1b[?2004 h'], ['\x1b]title \x1b[?02004h\x07']]) {
  test(`retained manual wire agrees with shipped xterm for ${JSON.stringify(chunks)}`, async () => {
    await harness(async (page, api, sockets, writes) => {
      await record(page); await ready(page, api);
      await observeOutput(page, 'modeChunks', 'modeUnobserve');
      for (const chunk of chunks) sockets.get('A')![0]!.send(Buffer.from(chunk));
      await page.waitForFunction(count => (window as any).modeChunks === count, chunks.length);
      const expected = await page.evaluate(() => (new Promise(resolve=>active.term.write('',()=>{
        window.modeUnobserve(); resolve(active.term.modes.bracketedPasteMode);
      }))));
      assert.equal(await page.evaluate(() => (active.conn.terminal.dictationMode.value)), expected);
      await page.locator('#compose-send').click(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
      assert.deepEqual(wire(writes, 'A:0'), [expected ? '\x1b[200~alpha\rbeta\x1b[201~' : 'alpha\rbeta', '\r']);
    });
  });
}

// Optional inspection keeps the pre-feature RED on behavior, not a missing API.
async function autoPreference(page: Page, enabled: boolean): Promise<void> {
  if (!await page.locator('#dlg-compose').evaluate((e: HTMLDialogElement) => e.open)) await open(page);
  const checkbox = page.getByRole('checkbox', {name: /envoi automatique/i});
  if (await checkbox.count() && await checkbox.isChecked() !== enabled) await checkbox.click();
}
async function autoReady(page: Page, api: Parameters<Parameters<typeof harness>[0]>[1], name = 'A', text = 'alpha\nbeta'): Promise<void> {
  for (let i = 0; !api.jobs.some(j => j.session === name) && i < 500; i++) await page.waitForTimeout(10);
  const job = api.jobs.find(j => j.session === name); assert.ok(job);
  job.state = 'ready'; job.text = text; api.ack(name);
  const created = name === 'A' ? 1 : 2;
  await page.waitForFunction(({name, created}) => dictation.session(name, created).state !== 'uploading', {name, created});
  await page.evaluate(([argument0, argument1]) => (dictation.reconcile(dictation.session(argument0,argument1))), [name, created]);
  await page.waitForTimeout(180);
}

for (const autoSend of [false, true]) {
  test(`invalid C1 ready text never writes, submits or auto-recovers (autoSend=${autoSend})`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      await autoPreference(page, autoSend); await closeCompose(page); await record(page);
      await autoReady(page, api, 'A', 'before\x80\x85\x9fafter');
      await page.waitForFunction(() => dictation.session('A', 1).state === 'recovery');
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.evaluate(() => dictation.reconcile(dictation.session('A', 1)));
        assert.equal(await page.evaluate(() => dictation.send(dictation.session('A', 1))), false);
        assert.equal(await page.evaluate(() => dictation.send(dictation.session('A', 1), true)), false);
      }
      assert.equal(await page.locator('#compose-text').inputValue(), '');
      assert.equal(await page.locator('#compose-send').isDisabled(), true);
      assert.equal(await page.evaluate(() => dictation.session('A', 1).transcript), '');
      assert.equal(await page.evaluate(() => dictation.session('A', 1).autoAttempted), false);
      assert.equal(await page.evaluate(() => dictation.session('A', 1).requestId),
        api.uploads[0]!.headers['x-mesh-request-id']);
      assert.equal(api.uploads.length, 1);
      assert.equal(api.jobs[0]!.state, 'ready', 'invalid result is never settled as submitted');
      assert.deepEqual(dataFrames(writes), [], 'no paste or Enter on any channel');
    });
  });
}

test('auto preference is visible, accessible, warns about inactive commands and defaults off', async () => {
  await harness(async page => {
    await open(page);
    const checkbox = page.getByRole('checkbox', {name: /envoi automatique/i});
    assert.equal(await checkbox.count(), 1);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await checkbox.isVisible(), true);
    assert.match(await page.locator('#dlg-compose').innerText(), /commandes.*session inactive/i);
  });
});

test('remember only the preference boolean across close, sends and reload, not jobs or text', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page);
    await autoReady(page, api);
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']);
    await closeCompose(page); await open(page);
    assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), true);
    const persisted = await page.evaluate(() => (localStorage.getItem(`${meshContext.storagePrefix}.dictation-auto-send`)));
    assert.equal(persisted, 'true');
    await page.reload(); await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && dictationInventoryReady);
    await open(page); assert.equal(await page.locator('#compose-text').inputValue(), '');
    assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), true);
    assert.equal(await page.evaluate(() => (dictation.holds().length)), 0);
    await autoPreference(page, false); await page.reload();
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && dictationInventoryReady); await open(page);
    assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), false);
  });
});

test('opted-in A/B delayed admissions send once on retained originals while C stays focused and unresized', async () => {
  await harness(async (page, api, sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page);
    const pane = await page.evaluate(() => (active.inputLeaseSlot));
    await record(page); await closeCompose(page); await select(page, 'B'); await record(page);
    await closeCompose(page); await select(page, 'C'); await typeNative(page, '');
    assert.equal(await page.evaluate(() => (active.inputLeaseSlot)), pane);
    const size = await page.evaluate(() => ([active.term.cols,active.term.rows]));
    await autoReady(page, api, 'A'); await autoReady(page, api, 'B', 'bonjour B');
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']);
    assert.deepEqual(wire(writes, 'B:0'), ['bonjour B', '\r']); assert.deepEqual(wire(writes, 'C:0'), []);
    assert.equal(await page.evaluate(() => (active.id)), 'C');
    assert.equal(await page.evaluate(() => (document.activeElement.classList.contains("xterm-helper-textarea"))), true);
    assert.deepEqual(await page.evaluate(() => ([active.term.cols,active.term.rows])), size);
    assert.equal(sockets.get('A')!.length, 1); assert.equal(sockets.get('B')!.length, 1);
    assert.deepEqual(api.jobs.map(j => j.outcome), ['submitted', 'submitted']);
    assert.equal(api.uploads.length, 2);
  });
});

for (const mode of ['on-late', 'off-on-before-ready', 'off-on-after-ready']) {
  test(`automatic authorization is snapshotted and permanently revoked: ${mode}`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      if (mode !== 'on-late') {await autoPreference(page, true); await closeCompose(page);}
      await record(page);
      if (mode !== 'on-late') await autoPreference(page, false);
      if (mode === 'off-on-after-ready') await autoReady(page, api);
      await autoPreference(page, true);
      if (mode !== 'off-on-after-ready') await autoReady(page, api);
      await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
      assert.deepEqual(dataFrames(writes), []);
      assert.equal(await page.locator('#compose-text').inputValue(), 'alpha\nbeta');
      assert.equal(api.jobs[0]!.state, 'ready'); assert.equal(api.uploads.length, 1);
    });
  });
}

for (const phase of ['preflight', 'encoder', 'enter']) {
  test(`off then on during automatic ${phase} blocks all remaining frames, preserves text and never settles submitted`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      await autoPreference(page, true); await closeCompose(page);
      if (phase === 'encoder') await page.evaluate(() => {window.realEncoder=createDictationEncoder;
        createDictationEncoder=()=>{const e=window.realEncoder(),write=e.write;e.write=(text,done)=>write(text,()=>window.encoderDone=done);return e}});
      await record(page);
      for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
      assert.equal(api.jobs.length, 1); api.ack('A');
      await page.waitForFunction(() => dictation.session('A', 1).state === 'queued');
      if (phase === 'enter') await holdEnter(page);
      api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta';
      if (phase === 'preflight') {
        let first = true;
        await page.route(`**/api/transcribe/${api.jobs[0]!.job_id}`, async route => {
          const response = await route.fetch();
          if (first) {first = false; api.holdRead();}
          await route.fulfill({response});
        });
      }
      await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
      if (phase === 'preflight') {
        for (let i = 0; !api.readHeld && i < 500; i++) await page.waitForTimeout(10);
        assert.equal(api.readHeld, true, 'automatic preflight must reach the held GET');
      }
      if (phase === 'encoder') await page.waitForFunction(() => typeof (window as any).encoderDone === 'function');
      if (phase === 'enter') await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
      assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'delivering');
      await autoPreference(page, false); await autoPreference(page, true);
      if (phase === 'preflight') api.releaseRead();
      if (phase === 'encoder') await page.evaluate(() => {window.encoderDone(); createDictationEncoder=window.realEncoder});
      if (phase === 'enter') await runEnter(page);
      await page.waitForTimeout(180);
      assert.deepEqual(wire(writes, 'A:0'), phase === 'enter' ? ['alpha\rbeta'] : []);
      assert.equal(api.jobs[0]!.outcome, null);
      assert.equal(await page.locator('#compose-text').inputValue(), 'alpha\nbeta');
    });
  });
}

for (const operation of ['getItem', 'setItem']) {
  test(`browser storage ${operation} failure stays off with a visible honest error`, async () => {
    await harness(async page => {
      if (operation === 'getItem') {
        await page.addInitScript(() => {
          const get = Storage.prototype.getItem;
          Storage.prototype.getItem = function(key) {if (key.endsWith('.dictation-auto-send')) throw Error('blocked'); return get.call(this, key);};
        });
        await page.reload(); await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && dictationInventoryReady);
      } else await page.evaluate(() => {window.realSetItem=Storage.prototype.setItem;
        Storage.prototype.setItem=function(key,value){if(key.endsWith('.dictation-auto-send'))throw Error('blocked');return window.realSetItem.call(this,key,value)}});
      await autoPreference(page, operation === 'setItem');
      assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), false);
      assert.match(await page.locator('#dictation-preference-status').innerText(), /stockage.*indisponible/i);
      assert.equal(await page.evaluate(() => (dictation.autoSend)), false);
    });
  });
}

test('pending/disposed Mesh controllers cause no preference storage reads or writes', async () => {
  await harness(async page => {
    await page.evaluate(() => {window.preferenceEffects=[];
      for(const name of ['getItem','setItem']){const original=Storage.prototype[name];
        Storage.prototype[name]=function(key,...args){if(key.endsWith('.dictation-auto-send'))window.preferenceEffects.push(name);return original.call(this,key,...args)}}});
    await page.locator('#dictation-auto-send').dispatchEvent('change');
    assert.equal(await page.evaluate(() => (meshContext)), null);
    assert.deepEqual(await page.evaluate(() => (Object.keys(MeshUI))), ['startLocalMesh', 'forgetKnownSessions']);
    await page.locator('#dictation-auto-send').dispatchEvent('change');
    assert.deepEqual(await page.evaluate(() => (window.preferenceEffects)), []);
  }, true);
  await harness(async page => {
    await page.evaluate(() => {window.oldVoice=dictation;window.preferenceEffects=[];
      for(const name of ['getItem','setItem']){const original=Storage.prototype[name];
        Storage.prototype[name]=function(key,...args){if(key.endsWith('.dictation-auto-send'))window.preferenceEffects.push(name);return original.call(this,key,...args)}}
      dictation.dispose();window.oldVoice.setAutoSend(true);window.oldVoice.start()});
    assert.deepEqual(await page.evaluate(() => (window.preferenceEffects)), []);
  });
});

for (const edit of ['human edit', '', '/uploaded/attachment ']) {
  test(`intervening draft edits cannot authorize auto even if cleared: ${JSON.stringify(edit)}`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      await autoPreference(page, true); await closeCompose(page); await record(page);
      await page.locator('#compose-text').fill('intervening'); await page.locator('#compose-text').fill(edit);
      await autoReady(page, api);
      assert.deepEqual(dataFrames(writes), []); assert.equal(await page.locator('#compose-text').inputValue(), edit);
      assert.equal(await page.evaluate(() => (dictation.session("A",1).transcript)), 'alpha\nbeta');
      assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'recovery');
      assert.equal(api.jobs[0]!.outcome, null);
    });
  });
}

for (const clean of [false, true]) {
  test(`native input while pending prevents automatic delivery even when subsequently clean=${clean}`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      await autoPreference(page, true); await closeCompose(page); await record(page); await closeCompose(page);
      await typeNative(page, 'human');
      if (clean) {await page.keyboard.press('Enter'); await page.waitForFunction(() => !active.inputLease.dirty);}
      const before = wire(writes, 'A:0'); await autoReady(page, api);
      assert.deepEqual(wire(writes, 'A:0'), before);
      assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
      assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'recovery');
      assert.equal(api.jobs[0]!.outcome, null);
    });
  });
}

test('returning to A creates A:1 but automatic delivery still uses only original A:0', async () => {
  await harness(async (page, api, sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page); await closeCompose(page);
    await select(page, 'B'); await select(page, 'A'); assert.equal(sockets.get('A')!.length, 2);
    await autoReady(page, api);
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']); assert.deepEqual(wire(writes, 'A:1'), []);
    assert.deepEqual(wire(writes, 'B:0'), []); assert.equal(api.jobs[0]!.outcome, 'submitted');
  });
});

for (const failure of ['disconnect', 'reincarnation', 'inventory', 'logout']) {
  test(`automatic ${failure} preserves recovery without reattach/rePOST/input`, async () => {
    await harness(async (page, api, sockets, writes) => {
      await autoPreference(page, true); await closeCompose(page); await record(page); await closeCompose(page); await select(page, 'B');
      if (failure === 'disconnect') {sockets.get('A')![0]!.close(); await page.waitForTimeout(50);}
      if (failure === 'reincarnation') {api.inventory.mesh[0]!.created = 10; await page.evaluate(() => (refresh()));}
      if (failure === 'inventory') {api.inventory.management.state = 'unavailable'; await page.evaluate(() => (refresh()));}
      if (failure === 'logout') await page.route('**/api/transcribe/*', route => route.fulfill({status: 401, body: 'unauthorized'}));
      await autoReady(page, api);
      assert.deepEqual(dataFrames(writes), []); assert.equal(api.jobs[0]!.outcome, null); assert.equal(api.uploads.length, 1);
      assert.equal(sockets.get('A')!.length, 1);
      if (failure !== 'logout') assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
      else assert.equal(await page.evaluate(() => (dictation.autoSend)), false);
    });
  });
}

test('duplicate ready reads and encoder callbacks cannot submit twice; lost settle ACK preserves new draft and retries only settle', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page);
    await page.evaluate(() => {window.realEncoder=createDictationEncoder;
      createDictationEncoder=()=>{const e=window.realEncoder(),write=e.write;e.write=(text,done)=>write(text,()=>{done();done()});return e}});
    await record(page); await holdEnter(page);
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
    await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    for (let i = 0; i < 3; i++) await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta']); api.loseSettle = true; await runEnter(page);
    await page.waitForFunction(() => dictation.session('A', 1).outcome === 'submitted' && !dictation.session('A', 1).busy);
    await page.locator('#compose-text').fill('new draft after local submission');
    await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.equal(await page.locator('#compose-text').inputValue(), 'new draft after local submission');
    api.loseSettle = false; await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.equal(await page.locator('#compose-text').inputValue(), 'new draft after local submission');
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']); assert.equal(api.uploads.length, 1);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'idle');
    assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), true);
  });
});

test('off revokes every pending A/B; re-enabled C is independent and can submit while A/B remain editable', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page); await closeCompose(page);
    await select(page, 'B'); await record(page); await autoPreference(page, false); await autoPreference(page, true);
    await closeCompose(page); await select(page, 'C'); await record(page);
    await autoReady(page, api, 'A'); await autoReady(page, api, 'B');
    for (let i = 0; api.jobs.length < 3 && i < 500; i++) await page.waitForTimeout(10);
    api.jobs[2]!.state = 'ready'; api.jobs[2]!.text = 'only C'; api.ack('C');
    await page.waitForFunction(() => dictation.session('C', 3).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), []); assert.deepEqual(wire(writes, 'B:0'), []);
    assert.deepEqual(wire(writes, 'C:0'), ['only C', '\r']); assert.equal(api.uploads.length, 3);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => (dictation.session("B",2).text)), 'alpha\nbeta');
  });
});

test('turning on during capture cannot arm it; revoked ready text remains manually sendable', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    // A test-owned dispatched UI change does not move the held key's focus.
    await page.evaluate(() => (document.querySelector("#dictation-auto-send").click()));
    await page.waitForTimeout(350); await page.keyboard.up('Space'); await autoReady(page, api);
    assert.deepEqual(dataFrames(writes), []); assert.equal(api.jobs[0]!.state, 'ready');
    await autoPreference(page, false); await page.locator('#compose-send').click();
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']);
    assert.equal(await page.getByRole('checkbox', {name: /envoi automatique/i}).isChecked(), false);
  });
});

for (const action of ['close', 'hidden']) {
  test(`opt-in does not override pre-release ${action} capture cancellation`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      await autoPreference(page, true); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
      await page.waitForFunction(() => composeDictationSession().state === 'recording');
      if (action === 'close') await closeCompose(page);
      else await page.evaluate(() => {Object.defineProperty(document,"hidden",{configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange"))});
      await page.keyboard.up('Space'); await page.waitForTimeout(100);
      assert.equal(api.uploads.length, 0); assert.deepEqual(dataFrames(writes), []);
      assert.equal(await page.evaluate(() => (window.micStreams.every(s=>s.getTracks().every(t=>t.readyState === "ended")))), true);
      assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'idle');
    });
  });
}

for (const status of [202, 409]) {
  test(`ready lookup while POST ack is held waits for IO release; late admission ${status} cannot replay or rePOST`, async () => {
    await harness(async (page, api, _sockets, writes) => {
      let release: (() => void) | null = null;
      await page.route('**/api/transcribe', async route => {
        const response = await route.fetch(); await new Promise<void>(r => {release = r;});
        if (status === 202) await route.fulfill({response});
        else await route.fulfill({status, contentType: 'application/json', body: JSON.stringify({error: {code: 'session_busy'}})});
      });
      await autoPreference(page, true); await closeCompose(page); await record(page);
      for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
      api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
      for (let i = 0; !release && i < 500; i++) await page.waitForTimeout(10);
      assert.ok(release); await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
      assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'ready');
      assert.equal(await page.evaluate(() => (dictation.session("A",1).io)), 1); assert.deepEqual(dataFrames(writes), []);
      (release as () => void)(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
      assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']); assert.equal(api.uploads.length, 1);
      await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
      assert.equal(api.jobs[0]!.outcome, 'submitted'); assert.equal(wire(writes, 'A:0').length, 2);
    });
  });
}

test('off during delayed Enter is partial recovery, not submitted, and never replays on reconcile', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page); await holdEnter(page);
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
    await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    await autoPreference(page, false); await autoPreference(page, true); await runEnter(page);
    await page.waitForFunction(() => dictation.session('A', 1).state === 'recovery');
    for (let i = 0; i < 3; i++) await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta']); assert.equal(api.jobs[0]!.outcome, null);
    assert.equal(await page.locator('#compose-text').inputValue(), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).sent)), true);
    assert.equal(await page.evaluate(() => (dictation.send(dictation.session("A",1)))), false);
  });
});

test('logout/disposal during delayed Enter suppresses dead callbacks and releases retained resources', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page); await holdEnter(page);
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
    await page.waitForFunction(() => (window as any).voiceEnter.length === 1);
    await page.evaluate(() => ((async()=>{const ui=await localMesh;ui.dispose()})())); await runEnter(page);
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta']); assert.equal(api.jobs[0]!.outcome, null);
    assert.equal(await page.evaluate(() => (localTerminalHandles.size)), 0);
    assert.equal(await page.evaluate(() => (dictation.autoSend)), false);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).channel)), null);
  });
});

test('opted-in queued/processing jobs expose independent status and spinner while C stays selected', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await autoPreference(page, true); await closeCompose(page); await record(page); await closeCompose(page);
    await select(page, 'B'); await record(page); await closeCompose(page); await select(page, 'C');
    for (let i = 0; api.jobs.length < 2 && i < 500; i++) await page.waitForTimeout(10);
    api.ack('A'); api.ack('B');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'queued' && dictation.session('B', 2).state === 'queued');
    api.jobs[0]!.state = 'processing'; await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.match(await page.locator('#dictation-jobs').innerText(), /Transcription en cours/);
    assert.match(await page.locator('#dictation-jobs').innerText(), /file d’attente/);
    assert.equal(await page.locator('#dictation-jobs [data-state="processing"]').evaluate(e => getComputedStyle(e, '::before').animationName), 'dictation-spin');
    assert.deepEqual(dataFrames(writes), []); assert.equal(await page.evaluate(() => (active.id)), 'C');
    for (const job of api.jobs) {job.state = 'ready'; job.text = 'alpha\nbeta';}
    await page.evaluate(() => (Promise.all([dictation.reconcile(dictation.session("A",1)),dictation.reconcile(dictation.session("B",2))])));
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle' && dictation.session('B', 2).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']); assert.deepEqual(wire(writes, 'B:0'), ['alpha\rbeta', '\r']);
    assert.deepEqual(wire(writes, 'C:0'), []);
  });
});

test('a draft entered during held settlement acknowledgement survives; duplicate delivery callbacks are inert', async () => {
  await harness(async (page, api, _sockets, writes) => {
    let release: (() => void) | null = null;
    await page.route('**/api/transcribe/*/settle', async route => {
      const response = await route.fetch(); await new Promise<void>(r => {release = r;}); await route.fulfill({response});
    });
    await page.evaluate(() => {window.realRetain=retainDictationChannel;
      retainDictationChannel=s=>{const ch=window.realRetain(s),deliver=ch.deliver;
        ch.deliver=(text,done,guard)=>deliver(text,r=>{done(r);done(r)},guard);return ch}});
    await autoPreference(page, true); await closeCompose(page); await record(page); await autoReady(page, api);
    for (let i = 0; !release && i < 500; i++) await page.waitForTimeout(10);
    assert.ok(release); assert.equal(await page.evaluate(() => (dictation.session("A",1).outcome)), 'submitted');
    await page.locator('#compose-text').fill('new draft during ACK');
    (release as () => void)(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.equal(await page.locator('#compose-text').inputValue(), 'new draft during ACK');
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta', '\r']);
    assert.equal(api.seen.filter(path => path.endsWith('/settle')).length, 1); assert.equal(api.uploads.length, 1);
  });
});

test('English catalog exposes accessible dictation and exact queued/processing status', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page);
    assert.match(await page.locator('#compose-mic').getAttribute('aria-label') || '', /dictat/i);
    const checkbox = page.getByRole('checkbox', {name: 'Automatically send dictations', exact: true});
    assert.equal(await checkbox.isVisible(), true); assert.equal(await checkbox.isChecked(), false);
    await closeCompose(page); await record(page);
    for (let i = 0; !api.jobs.length && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.jobs.length, 1); api.ack('A');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'queued');
    assert.equal(await page.locator('#dictation-status').innerText(), 'Dictation queued');
    api.jobs[0]!.state = 'processing'; await page.evaluate(() => (dictation.reconcile(composeDictationSession())));
    assert.equal(await page.locator('#dictation-status').innerText(), 'Transcribing…');
    assert.deepEqual(dataFrames(writes), []);
  }, false, 'en');
});
