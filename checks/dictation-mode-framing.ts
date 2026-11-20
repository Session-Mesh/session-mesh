// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, record, ready, wire, observeOutput} from './dictation-browser-fixture.ts';
import type {Page} from 'playwright-core';

declare const active: any, dictation: any;

test('C1 CSI inside an original output string must protect actual retained multiline input', async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await ready(page, api);
    sockets.get('A')![0]!.send(Buffer.from('\x1b]title\u009b?2004h\x07'));
    await page.waitForFunction(() => active.term.modes.bracketedPasteMode);
    assert.equal(await page.evaluate(() => (active.conn.terminal.dictationMode.value)), true, 'C1 mode must match shipped xterm');
    await page.locator('#compose-send').click(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), ['\x1b[200~alpha\rbeta\x1b[201~', '\r']);
  });
});

test('pinned parser/UTF8 parity covers 276 initial-state vectors, byte splits and reset aliases', async () => {
  await harness(async page => {
    const result = await page.evaluate(async () => {
      const root = globalThis as any, prefixes = ['', '\x1b]data', '\x1bPdata', '\x1bXdata', '\x1b^data', '\x1b_data', '\u009ddata', '\u0090data', '\x1b[?20'];
      const suffixes = ['\x1b[?2004h', '\x1b[?02004h', '\u009b?2004h', '\x1b[?2004l', '\u009b?2004l',
        '\x1b[?1;2004h', '\x1b[?2004:1h', '\x1b[?2004 h', '\x1b[?2004\nl', '\x18\x1b[?2004h',
        '\x1b\\\x1b[?2004h', '\x07\x1b[?2004h', '04h', '\u009c\x1b[?2004l', '\x1a\u009b?02004h'];
      const vectors = [...prefixes.flatMap(p => suffixes.map(s => p + s)), '\x1bc', '\x1b[!p', '\x1b[?3h'];
      const mismatches: unknown[] = []; let checked = 0;
      for (const initial of [false, true]) for (const split of [false, true]) for (const vector of vectors) {
        const term = new root.Terminal({cols: 80, rows: 2, scrollback: 0, windowOptions: {setWinLines: true}});
        const mode = root.MeshPaneActions.createDictationModeObserver(initial, term);
        if (initial) await new Promise<void>(r => term.write('\x1b[?2004h', r));
        const bytes = new TextEncoder().encode(vector);
        for (const chunk of split ? [...bytes].map(b => new Uint8Array([b])) : [bytes]) {mode.bytes(chunk); term.write(chunk);}
        await new Promise<void>(r => term.write('', r)); checked++;
        if (mode.value !== term.modes.bracketedPasteMode && mismatches.length < 10) mismatches.push({initial, split, vector, actual: mode.value, expected: term.modes.bracketedPasteMode});
        mode.dispose?.(); term.dispose();
      }
      return {checked, mismatches};
    });
    assert.equal(result.checked, 552); assert.deepEqual(result.mismatches, []);
  });
});

test('capture in the middle of original CSI keeps the connection parser state', async () => {
  await harness(async (page, api, sockets, writes) => {
    await observeOutput(page, 'prefixSeen', 'unprefix');
    sockets.get('A')![0]!.send(Buffer.from('\x1b[?20'));
    await page.waitForFunction(() => (window as any).prefixSeen); await page.evaluate(() => (window.unprefix()));
    await record(page); await ready(page, api); sockets.get('A')![0]!.send(Buffer.from('04h'));
    await page.waitForFunction(() => active.term.modes.bracketedPasteMode);
    await page.locator('#compose-send').click(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), ['\x1b[200~alpha\rbeta\x1b[201~', '\r']);
  });
});

test('all pinned bracketed-mode resets and numeric parameter ordering match the real terminal', async () => {
  await harness(async page => {
    const result = await page.evaluate(async () => {
      const root = globalThis as any, mismatches: unknown[] = [];
      for (const columns of [false, true]) for (const suffix of ['\x1bc', '\x1b[!p', '\x1b[?3h', '\x1b[?3l', '\x1b[?3;2004h', '\x1b[?2004;3h']) {
        const terminal = new root.Terminal({cols: 80, rows: 2, scrollback: 0, windowOptions: {setWinLines: columns}});
        const mode = root.MeshPaneActions.createDictationModeObserver(false, terminal), bytes = new TextEncoder().encode('\x1b[?2004h' + suffix);
        mode.bytes(bytes); await new Promise<void>(r => terminal.write(bytes, r));
        if (mode.value !== terminal.modes.bracketedPasteMode) mismatches.push({columns, suffix, actual: mode.value, expected: terminal.modes.bracketedPasteMode});
        mode.dispose?.(); terminal.dispose();
      }
      return mismatches;
    });
    assert.deepEqual(result, []);
  });
});

async function holdPreparation(page: Page, every = false): Promise<void> {
  await page.evaluate(([argument0]) => {window.heldEncoder=null; window.encoderSeedWrites=0; const make=createDictationEncoder;
    createDictationEncoder=()=>{const encoder=make();let hold=true;return {...encoder,
      write:(text,done)=>{window.encoderSeedWrites++;encoder.write(text,()=>{
        if(hold || argument0){hold=false;window.heldEncoder=()=>{window.heldEncoder=null;done();};}else done();
      });}};};}, [every]);
}

for (const enable of [true, false]) test(`latest original mode ${enable ? 'enable' : 'reset'} during asynchronous encoder preparation determines wire framing`, async () => {
  await harness(async (page, api, sockets, writes) => {
    await holdPreparation(page); await record(page); await ready(page, api);
    if (!enable) {
      sockets.get('A')![0]!.send(Buffer.from('\x1b[?2004h'));
      await page.waitForFunction(() => active.term.modes.bracketedPasteMode && active.conn.terminal.dictationMode.value);
    }
    await page.locator('#compose-send').click();
    await page.waitForFunction(() => typeof (window as any).heldEncoder === 'function');
    sockets.get('A')![0]!.send(Buffer.from(enable ? '\x1b[?2004h' : '\x1b[?2004l'));
    await page.waitForFunction(enable => active.term.modes.bracketedPasteMode === enable && active.conn.terminal.dictationMode.value === enable, enable);
    await page.evaluate(() => (window.heldEncoder()));
    // Local delivery exits "delivering" before the asynchronous settle response.
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), [enable ? '\x1b[200~alpha\rbeta\x1b[201~' : 'alpha\rbeta', '\r'],
      'one stabilizing change must use the latest original mode, never the stale seed');
    assert.equal(api.jobs[0]!.outcome, 'submitted');
    assert.equal(await page.evaluate(() => (window.encoderSeedWrites)), 2, 'reseeding must use a fresh real asynchronous xterm write');
    assert.equal(api.uploads.length, 1);
  });
});

test('persistent preparation mode churn refuses within a bounded number of seeds, with zero input and recovery', async () => {
  await harness(async (page, api, sockets, writes) => {
    await holdPreparation(page, true); await record(page); await ready(page, api);
    await page.locator('#compose-send').click();
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForFunction(() => typeof (window as any).heldEncoder === 'function');
      const enabled = attempt % 2 === 0;
      sockets.get('A')![0]!.send(Buffer.from(enabled ? '\x1b[?2004h' : '\x1b[?2004l'));
      await page.waitForFunction(enabled => active.term.modes.bracketedPasteMode === enabled && active.conn.terminal.dictationMode.value === enabled, enabled);
      await page.evaluate(() => (window.heldEncoder()));
      await page.waitForTimeout(50);
      assert.deepEqual(wire(writes, 'A:0'), [], 'a raced preparation must not write any stale-framed input');
      if (await page.evaluate(() => (dictation.session("A",1).state !== "delivering"))) break;
    }
    assert.deepEqual(wire(writes, 'A:0'), [], 'churn may never leak stale-framed input');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'recovery');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).requestId !== null)), true);
    assert.equal(await page.evaluate(() => (window.encoderSeedWrites <= 3)), true);
    assert.equal(api.jobs[0]!.state, 'ready'); assert.equal(api.jobs[0]!.outcome, null);
    assert.equal(api.uploads.length, 1);
  });
});

test('closing the original channel during encoder preparation refuses without data or submitted settlement', async () => {
  await harness(async (page, api, sockets, writes) => {
    await holdPreparation(page); await record(page); await ready(page, api);
    await page.locator('#compose-send').click();
    await page.waitForFunction(() => typeof (window as any).heldEncoder === 'function');
    sockets.get('A')![0]!.close();
    await page.waitForFunction(() => active.conn.ws.readyState !== WebSocket.OPEN);
    await page.evaluate(() => (window.heldEncoder()));
    await page.waitForFunction(() => dictation.session('A', 1).state === 'recovery');
    assert.deepEqual(wire(writes, 'A:0'), []);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
    assert.equal(api.jobs[0]!.state, 'ready'); assert.equal(api.jobs[0]!.outcome, null);
  });
});

test('retained framing follows shipped xterm numeric DEC mode, including leading zeros', async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await ready(page, api);
    sockets.get('A')![0]!.send(Buffer.from('\x1b[?02004h'));
    await page.waitForFunction(() => active.term.modes.bracketedPasteMode);
    assert.equal(await page.evaluate(() => (active.conn.terminal.dictationMode.value)), true, 'observer must agree with shipped xterm on leading-zero DEC');
    await page.locator('#compose-send').click(); await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.deepEqual(wire(writes, 'A:0'), ['\x1b[200~alpha\rbeta\x1b[201~', '\r']);
  });
});

test('mode observer differentially matches shipped xterm across chunking/parameters/set/reset', async () => {
  await harness(async page => {
    const vectors = ['\x1b[?02004h', '\x1b[?0000000002004l', '\x1b[?1;0002004;25h', '\x1b[?;2004l',
      '\x1b[?2004:1h', '\x1b[?2004;1:2h', '\x1b[?2004 h', '\x1b[?00002004h', '\x1bc',
      '\x1b]title \x1b[?2004h\x07', '\x1bPignored \x1b[?2004h\x1b\\', '\x1b[?2004\nl'];
    for (const vector of vectors) for (const split of [false, true]) {
      const observation = await page.evaluate(async ({vector, split}) => {
        const root = globalThis as any;
        const term = new root.Terminal({cols: 80, rows: 2, scrollback: 0});
        const mode = root.MeshPaneActions.createDictationModeObserver(false);
        for (const chunk of split ? [...vector] : [vector]) {
          mode.bytes(new TextEncoder().encode(chunk));
          await new Promise<void>(resolve => term.write(chunk, resolve));
        }
        const result = {actual: mode.value, expected: term.modes.bracketedPasteMode}; term.dispose(); return result;
      }, {vector, split});
      assert.equal(observation.actual, observation.expected, `mode differential: ${JSON.stringify(vector)}, split=${split}`);
    }
  });
});
