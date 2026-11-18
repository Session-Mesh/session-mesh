// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How GitHub Copilot CLI behaves in the page. It is a full-screen TUI: alternate screen, mouse tracking "any",
// SGR mouse encoding, focus reports and bracketed paste (observed on copilot 1.0.86). So no scrollback setting is
// needed: the wheel and a touch swipe reach Copilot, which scrolls its own timeline, and the phone input line
// pastes "/help" as one bracketed block followed by Enter.
// First with a witness program that has those modes (a program the kernel names copilot, so that discovery sees
// the agent and the recovery action is offered), then with the real copilot against a local fake model
// (no network, no account; skipped without a `copilot` on PATH). A real PTY host, server.py and Chromium
// (MESH_CHROMIUM; skipped without it).
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {FakeProvider} from './helpers/fake-copilot-provider.ts';
import {REPO, rows, settle, skip, TerminalMesh, typeLine} from './terminal-browser-lib.ts';

type Line = {translateToString(trim: boolean): string};
type Pane = {term: {buffer: {active: {type: string; length: number; getLine(y: number): Line | undefined}};
  modes: {mouseTrackingMode: string; bracketedPasteMode: boolean}}; conn: {ws: {readyState: number}} | null};
declare const active: Pane;

const WITNESS = path.join(REPO, 'tests', 'fixtures', 'alt-screen-witness.mjs');
const DESKTOP = {width: 1100, height: 700};
const PHONE = {width: 390, height: 780};
const REAL = (() => {
  try { return execFileSync('which', ['copilot'], {encoding: 'utf8'}).trim(); } catch { return ''; }
})();
let mesh: TerminalMesh;
const provider = new FakeProvider();

before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('witness');
  await provider.start();
});
after(async () => {
  try {
    // A real Copilot outlives the PTY host for a moment: stop what carries the run's directory first.
    // Through /proc, so on Linux only; elsewhere the mesh and the provider are still stopped below.
    if (mesh && fs.existsSync('/proc')) {
      for (const entry of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        let cwd = '';
        try { cwd = fs.readlinkSync(`/proc/${entry}/cwd`); } catch { continue; }
        if (cwd.startsWith(mesh.scratch) && Number(entry) !== process.pid) { try { process.kill(Number(entry), 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  } finally {
    // Each stop runs even when the one before it rejects: either left running keeps this file alive.
    try {
      await mesh?.stop();
    } finally {
      await provider.stop();
    }
  }
});

/** The witness's status row ("offset=N pasted=[…] submitted=N"), '' while it is not drawn. */
const statusRow = (page: Page): Promise<string> => page.evaluate(() => {
  const buffer = active.term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const text = buffer.getLine(y)!.translateToString(true);
    if (text.startsWith('offset=')) return text;
  }
  return '';
});
const offsetOf = async (page: Page): Promise<number> => Number(/^offset=(\d+)/.exec(await statusRow(page))?.[1]);
const bufferKind = (page: Page): Promise<[string, string, boolean]> =>
  page.evaluate(() => [active.term.buffer.active.type, active.term.modes.mouseTrackingMode, active.term.modes.bracketedPasteMode]);

async function startWitness(page: Page): Promise<void> {
  await typeLine(page, `exec node ${WITNESS}`);
  await page.waitForFunction(() => {
    const buffer = active.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).startsWith('offset=')) return true;
    return false;
  }, undefined, {timeout: 15000});
  await settle(page);
}

async function swipe(page: Page, distance: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
  const x = box.x + box.width / 2, y0 = box.y + box.height * 0.3;
  const touch = (type: string, y: number) => cdp.send('Input.dispatchTouchEvent',
    {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]} as never);
  await touch('touchStart', y0);
  for (let step = 1; step <= 12; step += 1) { await touch('touchMove', y0 + (distance * step) / 12); await page.waitForTimeout(16); }
  await touch('touchEnd', y0 + distance);
  await page.waitForTimeout(900);
}

declare function find(id: string): {created: number; agent?: {type?: string; foreground?: boolean} | null} | undefined;
declare function restorePiFullscreenScroll(id: string, created: number): void;

describe('Copilot CLI full-screen TUI in the page (witness)', {skip}, () => {
  test('desktop: alternate screen with mouse reporting; the wheel scrolls the program view', async () => {
    const page = await mesh.openPage('witness', DESKTOP);
    await startWitness(page);
    const [type, mouse] = await bufferKind(page);
    assert.equal(type, 'alternate');
    assert.notEqual(mouse, 'none');
    const bottom = await offsetOf(page);
    assert.ok(bottom > 100, `the view starts at the bottom of the 200 items (offset ${bottom})`);
    const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    const scrolled = await offsetOf(page);
    assert.ok(scrolled < bottom, `the wheel moved the program view up (${bottom} -> ${scrolled})`);
    for (let notch = 0; notch < 8; notch += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    assert.ok(await offsetOf(page) > scrolled, 'and back down');
    await page.context().close();
  });

  test('after a replay cut at 2 MiB the modes are lost; the explicit Copilot recovery restores the wheel', async () => {
    await mesh.newShell('recovery');
    const named = path.join(mesh.scratch, 'copilot');   // a program the kernel names copilot, as discovery sees the native binary
    fs.copyFileSync(process.execPath, named);
    fs.chmodSync(named, 0o755);
    // A node linked to a shared libnode (Homebrew's) finds it relative to its own path, so its copy cannot
    // start: it then runs with argv[0] copilot instead, which discovery reads when the process name is node.
    const program = spawnSync(named, ['-e', '0']).status === 0 ? named
      : `perl -e 'exec {$ARGV[0]} "copilot", @ARGV[1..$#ARGV]' ${process.execPath}`;
    const first = await mesh.openPage('recovery', DESKTOP);
    await typeLine(first, `exec ${program} ${WITNESS} churn`);
    await first.waitForFunction(() => find('recovery')?.agent?.type === 'copilot' && find('recovery')?.agent?.foreground === true,
      undefined, {timeout: 20000});
    await first.waitForTimeout(4000);   // the churn is over
    await first.context().close();
    const page = await mesh.openPage('recovery', DESKTOP);
    await page.waitForFunction(() => find('recovery')?.agent?.type === 'copilot', undefined, {timeout: 20000});
    const [type, mouse] = await bufferKind(page);
    assert.deepEqual([type, mouse], ['normal', 'none'], 'the replay no longer carries the program modes');
    const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await offsetOf(page);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    assert.equal(await offsetOf(page), before, 'without the recovery the wheel does not reach the program');
    // The action is offered in the pane's menu, with the Copilot text.
    const label = await page.evaluate(() => (document.querySelector('#mobile-pi-scroll') as HTMLElement | null)?.textContent ?? '');
    await page.evaluate(() => restorePiFullscreenScroll('recovery', find('recovery')!.created));
    await page.waitForTimeout(300);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(500);
    assert.ok(await offsetOf(page) < before, 'after the recovery it does');
    assert.ok(label === '' || /Copilot/.test(label), `the phone action names Copilot (${label})`);
    await page.context().close();
  });

  test('phone: a swipe reaches the program as wheel reports; the input line pastes a slash command', async () => {
    const page = await mesh.signIn(PHONE, undefined, undefined, {phone: true});
    await page.evaluate(() => (document.querySelector('#list .item[data-id="witness"]') as HTMLElement).click());
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 10000});
    await settle(page);
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).startsWith('offset=')) return true;
      return false;
    }, undefined, {timeout: 15000});
    const before = await offsetOf(page);
    await swipe(page, 300);
    const after = await offsetOf(page);
    assert.ok(after < before, `a downward swipe scrolls the program view up (${before} -> ${after})`);
    await page.locator('#line-text').fill('/status');
    await page.locator('#line-text').press('Enter');
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const text = buffer.getLine(y)!.translateToString(true);
        if (text.includes('pasted=[/status]') && text.includes('submitted=1')) return true;
      }
      return false;
    }, undefined, {timeout: 10000});
  });
});

describe('the real Copilot CLI in the page', {skip: skip || (REAL ? false : 'no copilot on PATH')}, () => {
  const home = () => path.join(mesh.scratch, 'copilot-home');
  const text = async (page: Page) => (await rows(page)).map(row => row.slice(2)).join('\n');

  async function startReal(page: Page): Promise<void> {
    fs.mkdirSync(home(), {recursive: true});
    fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify({trustedFolders: [mesh.home]}));
    provider.reset();
    provider.enqueue({text: Array.from({length: 160}, (_, i) => `answer-line-${String(i).padStart(3, '0')}`).join('\n\n')});
    await typeLine(page, `exec env COPILOT_HOME=${home()} COPILOT_OFFLINE=true COPILOT_MODEL=fake COPILOT_TELEMETRY_DISABLED=true `
      + `COPILOT_PROVIDER_BASE_URL=${provider.baseUrl} COPILOT_PROVIDER_API_KEY=unused copilot --no-auto-update`);
    await page.waitForFunction(() => find('real')?.agent?.type === 'copilot' && find('real')?.agent?.foreground === true,
      undefined, {timeout: 30000});
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).includes('commands')) return true;
      return false;
    }, undefined, {timeout: 30000});
    await settle(page);
  }

  test('desktop: alternate screen, mouse reports and bracketed paste; the wheel scrolls the timeline', async () => {
    await mesh.newShell('real');
    const page = await mesh.openPage('real', DESKTOP);
    await startReal(page);
    assert.deepEqual(await bufferKind(page), ['alternate', 'any', true]);
    await typeLine(page, 'write a long answer');
    await page.waitForFunction(() => document.body.innerText.length > 0 && (() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).includes('answer-line-')) return true;
      return false;
    })(), undefined, {timeout: 30000});
    await page.waitForTimeout(1500);
    const bottom = await text(page);
    const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    for (let notch = 0; notch < 10; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(600);
    const scrolled = await text(page);
    assert.notEqual(scrolled, bottom, 'the wheel scrolled the timeline of Copilot');
    await page.context().close();
  });

  test('phone: a swipe scrolls the timeline; the input line pastes a slash command that Copilot runs', async () => {
    const page = await mesh.signIn(PHONE, undefined, undefined, {phone: true});
    await page.evaluate(() => (document.querySelector('#list .item[data-id="real"]') as HTMLElement).click());
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 10000});
    await settle(page);
    const bottom = await text(page);
    await swipe(page, 300);
    assert.notEqual(await text(page), bottom, 'the swipe scrolled the timeline');
    await page.locator('#line-text').fill('/help');
    await page.locator('#line-text').press('Enter');
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (/Interactive Mode|Help|help/.test(buffer.getLine(y)!.translateToString(true)) && !buffer.getLine(y)!.translateToString(true).includes('? help')) return true;
      return false;
    }, undefined, {timeout: 15000});
    assert.equal(provider.requests.some(request => request.messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('/help'))), false,
      'the slash command was run by Copilot, not sent to the model');
  });
});
