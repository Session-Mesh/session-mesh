// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared helpers of the phone direct writing browser tests (tests/phone-direct-line-*-browser.test.ts).
// Each case drives the real field with real keyboard events on a throwaway mesh and reads what
// reached the terminal: the bytes of the page's input frames, and the shell's own line as it
// echoes them (a shell echoes every key it receives, before any Enter).
// Needs MESH_CHROMIUM (the tests are skipped without it).
import {after, afterEach, before} from 'node:test';
import type {Page} from 'playwright-core';
import {type PaneView, TerminalMesh} from './terminal-browser-lib.ts';

declare global {
  // app.js script-scope bindings, used inside page functions
  /* eslint-disable no-var */
  var __input: string[];
  var active: PaneView;
  var lineDirect: unknown;
  var linePending: unknown;
  var refresh: () => Promise<void>;
  var setExplorer: (on: boolean) => void;
  var addPane: (id?: string) => PaneView | null;
  var setActive: (pane: PaneView) => void;
  var panes: PaneView[];
  var directResidue: {since: number} | null;
  const DIRECT_RESIDUE_MS: number;
  /* eslint-enable no-var */
}

export const PHONE = {width: 390, height: 800};
export const DESKTOP = {width: 1280, height: 800};
export type Agent = 'claude' | 'codex' | 'pi' | null;
export const BRACKET_START = '\x1b[200~', BRACKET_END = '\x1b[201~';

/** Record the page's input frames (raw bytes to the terminal socket) as text. */
export function recordInputFrames(): void {
  window.__input = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (data instanceof Uint8Array) window.__input.push(new TextDecoder().decode(data));
    return send.call(this, data);
  };
}

/** What the sessions list says each session runs in the foreground of its terminal (every session
 * named here, not only the page's own). Changing an entry takes effect at the page's next
 * inventory refresh, as a real change would. */
export const foreground = new Map<string, Agent>();

export function asAgent(_name: string): (page: Page) => Promise<void> {
  return async page => {
    await page.route('**/api/sessions', async route => {
      try {
        const response = await route.fetch();
        const body = await response.json();
        for (const session of body.mesh ?? []) {
          const agent = foreground.get(session.id);
          if (agent) {
            session.agent = {type: agent, status: 'idle', foreground: true, updated: Date.now() / 1000, pid: 1, argv: [agent]};
          }
        }
        await route.fulfill({response, json: body});
      } catch { /* the page was closed while a poll was in flight */ }
    });
  };
}

export const frames = (page: Page): Promise<string[]> => page.evaluate(() => window.__input.slice());
export const forget = (page: Page): Promise<void> => page.evaluate(() => { window.__input.length = 0; });
export const field = (page: Page): Promise<string> => page.locator('#line-text').inputValue();
export const direct = (page: Page): Promise<boolean> => page.locator('#line-direct').isVisible();
export const flashed = (page: Page): Promise<string> => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('#flash')!;
  return el.hidden ? '' : el.textContent ?? '';
});
export const keyboardOpen = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement === document.querySelector('#line-text'));
/** Whether the pane's input lease is dirty: bytes were sent that did not complete a line. */
export const leaseDirty = (page: Page): Promise<boolean> =>
  page.evaluate(() => (active as unknown as {inputLease: {dirty: boolean}}).inputLease.dirty);

/** Wait until the message flashed to the user contains `text`. */
export async function waitForFlash(page: Page, text: string): Promise<void> {
  await page.waitForFunction(expected => {
    const el = document.querySelector<HTMLElement>('#flash')!;
    return !el.hidden && (el.textContent ?? '').includes(expected);
  }, text, {timeout: 30000});
}

/** The terminal's rows as the page shows them, last non-empty row first. */
export async function screenRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const buffer = active.term.buffer.active, rows: string[] = [];
    for (let y = buffer.length - 1; y >= 0; y--) {
      const text = buffer.getLine(y)!.translateToString(true);
      if (text) rows.push(text);
    }
    return rows;
  });
}

/** Wait until the shell's current line ends with `tail` (it echoes what it received). */
export async function waitForShellLine(page: Page, tail: string): Promise<void> {
  await page.waitForFunction(text => {
    const buffer = active.term.buffer.active;
    for (let y = buffer.length - 1; y >= 0; y--) {
      const row = buffer.getLine(y)!.translateToString(true);
      if (row) return row.endsWith(text);
    }
    return false;
  }, tail, {timeout: 30000});
}

/** Wait until some row of the terminal is exactly `text`. */
export async function waitForRow(page: Page, text: string): Promise<void> {
  await page.waitForFunction(expected => {
    const buffer = active.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true) === expected) return true;
    return false;
  }, text, {timeout: 30000});
}

/** Wait until some row of the terminal contains `text`. */
export async function waitForRowContaining(page: Page, text: string): Promise<void> {
  await page.waitForFunction(expected => {
    const buffer = active.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).includes(expected)) return true;
    return false;
  }, text, {timeout: 30000});
}

/** Text of frames with every bracketed paste removed: what is left reached the terminal as keys. */
export function outsideBrackets(sent: readonly string[]): string {
  return sent.join('').replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
}

/** A throwaway mesh and the pages opened on it, one at a time (a page polls the server). Call
 * once inside a `describe`: it registers the hooks that start and stop the mesh and close the pages. */
export function useMesh(): {
  mesh: TerminalMesh;
  phone(name: string, agent: Agent): Promise<Page>;
  desktop(name: string, agent: Agent): Promise<Page>;
  withoutBracketedPaste(page: Page): Promise<void>;
} {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });
  return {
    mesh,
    async phone(name, agent) {
      foreground.set(name, agent);
      await mesh.newShell(name);
      const page = await mesh.openPage(name, PHONE, recordInputFrames, undefined,
        {phone: true, routes: asAgent(name)});
      pages.push(page);
      await page.waitForFunction(() => document.activeElement === document.querySelector('#line-text'));
      await forget(page);
      return page;
    },
    async desktop(name, agent) {
      foreground.set(name, agent);
      await mesh.newShell(name);
      const page = await mesh.openPage(name, DESKTOP, recordInputFrames, undefined, {routes: asAgent(name)});
      pages.push(page);
      await forget(page);
      return page;
    },
    /** Run a program that never asked for bracketed paste: the shell turns the mode off while one runs. */
    async withoutBracketedPaste(page) {
      await page.evaluate(() => active.send('sleep 60\r'));
      await page.waitForFunction(() => !(active as unknown as {term: {modes: {bracketedPasteMode: boolean}}}).term.modes.bracketedPasteMode);
      await forget(page);
    },
  };
}
