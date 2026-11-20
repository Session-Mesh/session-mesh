// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A pane that comes back into use (focus here; the page becoming visible goes through the same
// method). With the PTY host's size owner rule, the pane always shows the PTY's width, so its
// screen never holds output drawn for another width: alone, it sends its size, as before;
// following another client that took the size, it sends nothing (only the banner takes the
// size back, terminal-shared-size-browser.test.ts). The repaint on evidence that the screen may
// hold such output remains for a host without the rule (Pane.retakeSize).
import assert from 'node:assert/strict';
import net from 'node:net';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {Attachment} from './ptyhost-wire-lib.ts';
import {type PaneView, recordControlMessages, skip, TerminalMesh, typeLine, waitForRow} from './terminal-browser-lib.ts';

declare const active: PaneView;
declare function refresh(): Promise<void>;
type Size = {rows: number; cols: number};

async function otherClient(mesh: TerminalMesh, name: string, size: Size): Promise<Attachment> {
  const client = new Attachment(net.createConnection(mesh.socketPath));
  client.send('C', {op: 'attach', name, ...size});
  const reply = JSON.parse((await client.next('C')).payload.toString('utf8'));
  assert.equal(reply.ok, true);
  return client;
}

const paneSize = (page: Page): Promise<Size> => page.evaluate(() => ({rows: active.term.rows, cols: active.term.cols}));

/** Leave the terminal: its textarea loses the focus. */
async function leave(page: Page): Promise<void> {
  await page.evaluate(() => {
    active.term.focus();
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

/** Take the size back by focusing the terminal; the resize messages that follow. */
async function retake(page: Page): Promise<Size[]> {
  await page.evaluate(async () => {
    await refresh(); // the session list now counts the attachments as they are
    window.__sent.length = 0;
    active.term.focus();
  });
  await page.waitForTimeout(600); // a redraw's second message follows 100 ms after the first
  return page.evaluate(() => window.__sent.filter(message => message.t === 'r')
    .map(message => ({rows: message.rows!, cols: message.cols!})));
}

describe('taking the terminal size back repaints only on evidence', {skip}, () => {
  const mesh = new TerminalMesh();
  const viewport = {width: 1200, height: 700};
  const clients: Attachment[] = [];

  before(() => mesh.start());
  after(async () => {
    for (const client of clients) client.close();
    await mesh.stop();
  });

  test('another client took the size: the pane follows it, and a focus neither resizes nor redraws', async () => {
    await mesh.newShell('shared');
    const page = await mesh.openPage('shared', viewport, recordControlMessages);
    const own = await paneSize(page);
    await leave(page);
    // A client without the size field (mesh-attach) takes the size when it attaches.
    const other = await otherClient(mesh, 'shared', {rows: own.rows, cols: 60});
    clients.push(other);
    other.send('D', Buffer.from("printf 'OTH''ER-drew\\n'\r"));
    await waitForRow(page, 'OTHER-drew');
    await page.waitForFunction(() => active.term.cols === 60);   // drawn at the PTY's width here too
    assert.deepEqual(await retake(page), []);
    other.send('R', own); // the PTY has this pane's size again, still owned by the other client
    await page.waitForFunction(cols => active.term.cols === cols, own.cols);
    await leave(page);
    assert.deepEqual(await retake(page), []);
    await page.context().close();
  });

  test('output while away with no other client attached: the size only', async () => {
    await mesh.newShell('alone');
    const page = await mesh.openPage('alone', viewport, recordControlMessages);
    const own = await paneSize(page);
    await leave(page);
    await typeLine(page, "printf 'AL''ONE-away\\n'");
    await waitForRow(page, 'ALONE-away');
    assert.deepEqual(await retake(page), [own]);
    // A client that attaches later at this size takes it: the pane then follows, and a focus
    // sends nothing.
    await leave(page);
    clients.push(await otherClient(mesh, 'alone', own));
    await page.waitForTimeout(300);
    assert.deepEqual(await retake(page), []);
    assert.deepEqual(await paneSize(page), own);
    await page.context().close();
  });

  test('another client attached at this size and nothing written: no repaint', async () => {
    await mesh.newShell('quiet');
    const page = await mesh.openPage('quiet', viewport, recordControlMessages);
    const own = await paneSize(page);
    await leave(page);
    clients.push(await otherClient(mesh, 'quiet', own));
    await page.waitForTimeout(300);
    assert.deepEqual(await retake(page), []);
    await page.context().close();
  });
});
