// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A pane that takes the terminal size back (focus here; the page becoming visible goes through
// the same method) asks the program to repaint when its screen may hold output drawn for
// another client's width: output arrived while the pane was not in use, and another client was
// attached. The repaint is the existing redraw (shrunk size, then the real one), so it happens
// even when the PTY already has the pane's size and a plain size message would change nothing.
// Without that evidence, the pane only sends its size, as before.
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

  test('another client drew at its width, then the PTY came back to this size: redraw', async () => {
    await mesh.newShell('shared');
    const page = await mesh.openPage('shared', viewport, recordControlMessages);
    const own = await paneSize(page);
    await leave(page);
    const other = await otherClient(mesh, 'shared', {rows: own.rows, cols: 60});
    clients.push(other);
    other.send('D', Buffer.from("printf 'OTH''ER-drew\\n'\r"));
    await waitForRow(page, 'OTHER-drew');
    other.send('R', own); // the PTY has this pane's size again: a size message alone changes nothing
    await page.waitForTimeout(300);
    assert.deepEqual(await retake(page), [{rows: own.rows - 1, cols: own.cols}, own]);
    // Once repaired, a second focus has nothing to repair.
    await leave(page);
    assert.deepEqual(await retake(page), [own]);
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
    // That output was drawn for this pane's size: taking the size back ended the time away,
    // so another client attaching later, with nothing written since, is no reason to repaint.
    await leave(page);
    clients.push(await otherClient(mesh, 'alone', own));
    await page.waitForTimeout(300);
    assert.deepEqual(await retake(page), [own]);
    await page.context().close();
  });

  test('another client attached at this size and nothing written: the size only', async () => {
    await mesh.newShell('quiet');
    const page = await mesh.openPage('quiet', viewport, recordControlMessages);
    const own = await paneSize(page);
    await leave(page);
    clients.push(await otherClient(mesh, 'quiet', own));
    await page.waitForTimeout(300);
    assert.deepEqual(await retake(page), [own]);
    await page.context().close();
  });
});
