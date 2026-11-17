// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared pieces of the wrapped-link browser scenarios (tests/wrapped-links.test.ts and the
// scenario modules next to it): the bare Pane mounted over the page at 48 columns, and the
// helpers that write terminal output, click a cell and read back the opened destinations.
import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';

export const COLS = 48;

type LinkTerm = {
  cols: number; rows: number; write(data: string, done: () => void): void;
  buffer: {active: {getLine(row: number): {isWrapped: boolean} | undefined}};
  element: HTMLElement; resize(cols: number, rows: number): void;
};
type LinkPane = {el: HTMLElement; termEl: HTMLElement; term: LinkTerm; refit: () => void; mount(): void};
declare const Pane: new () => LinkPane;
declare const MeshTerminalLinks: {linksOnRow(buffer: unknown, row: number, cols: number): unknown[]};
declare global {
  // eslint-disable-next-line no-var
  var __linkPane: LinkPane | undefined;
  // eslint-disable-next-line no-var
  var __openedLinks: string[];
  // eslint-disable-next-line no-var
  var __openedFeatures: (string | undefined)[][];
}

export type Scenario = (name: string, check: (page: Page) => Promise<void>) => Promise<void>;
// A scenario runner plus the terminal input mode its output is written in.
export type Mode = {scenario: Scenario; mouse: boolean; mode: string};

// A URL that fills the first row exactly.
export const first = 'https://example.test/' + 'a'.repeat(COLS - 'https://example.test/'.length);

// A fresh bare Pane at 48x16 over the interface; the previous scenario's pane is removed.
export function mountPane() {
  globalThis.__linkPane?.el.remove();
  const pane = new Pane();
  globalThis.__linkPane = pane;
  pane.el.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#111';
  document.body.append(pane.el);
  pane.termEl.hidden = false;
  (pane.el.querySelector('.empty') as HTMLElement).style.display = 'none';
  pane.refit = () => {}; // Keep 48-cell geometry despite the pane ResizeObserver.
  pane.mount();
  pane.term.resize(48, 16);
  globalThis.__openedLinks = [];
  globalThis.__openedFeatures = [];
  window.open = (url?: string | URL, target?: string, features?: string) => {
    globalThis.__openedLinks.push(String(url));
    globalThis.__openedFeatures.push([target, features]);
    return null;
  };
  (globalThis as unknown as {openWeb: (path: string) => void}).openWeb = (path) => { globalThis.__openedLinks.push(path); };
}

export async function writeLink(page: Page, output: string, mouse = false) {
  await page.evaluate(({output, mouse}) => new Promise<void>((resolve) => {
    globalThis.__linkPane!.term.write((mouse ? '\x1b[?1003h' : '') + output, resolve);
  }), {output, mouse});
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function clickCell(page: Page, row: number, col: number) {
  const point = await page.evaluate(({row, col}) => {
    const term = globalThis.__linkPane!.term, rect = term.element.querySelector('.xterm-screen')!.getBoundingClientRect();
    return {x: rect.x + (col + .5) * rect.width / term.cols, y: rect.y + (row + .5) * rect.height / term.rows};
  }, {row, col});
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
}

// Click each [row, col] cell in turn.
export async function clickCells(page: Page, cells: readonly (readonly [number, number])[]) {
  for (const [row, col] of cells) await clickCell(page, row, col);
}

export async function opened(page: Page, targets: string[]) {
  assert.deepEqual(await page.evaluate(() => globalThis.__openedLinks), targets);
}

export async function linksOnRow(page: Page, row: number) {
  return page.evaluate((row) => {
    const pane = globalThis.__linkPane!;
    return MeshTerminalLinks.linksOnRow(pane.term.buffer.active, row, pane.term.cols);
  }, row);
}

// Whether row has any link of kind "url" (the matcher's own view, before any click).
export async function hasUrlOnRow(page: Page, row: number) {
  return (await linksOnRow(page, row)).some((link) => (link as {kind: string}).kind === 'url');
}

export async function isWrapped(page: Page, row: number) {
  return page.evaluate((row) => globalThis.__linkPane!.term.buffer.active.getLine(row)!.isWrapped, row);
}
