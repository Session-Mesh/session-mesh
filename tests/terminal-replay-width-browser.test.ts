// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A page that attaches interprets the host's replay at the width it was produced at. The host
// names the PTY's geometry before applying the attaching client's; server.py relays it before
// the replay; the page parses the replay at that geometry, then takes its own size back and
// xterm rewraps the rows. Before, a narrow page parsed a wide program's relative cursor moves
// on its own width: words landed on the wrong rows, one per row, and widening the page did
// not bring the text back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {logicalLines, type PaneView, REPO, rows, settle, skip, TerminalMesh, typeLine, waitForRow, WITNESS} from './terminal-browser-lib.ts';

type Writes = {__writes: [unknown, (() => void) | undefined][]; __write: Term['write']};
type Term = {write(data: unknown, done?: () => void): void};
declare const active: PaneView & {term: Term; fit: {proposeDimensions(): {cols: number}}};
type Paragraph = {first: string; rest: string; indent: number};

const {paragraphs} = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'terminal-width-witness.json'),
  'utf8')) as {paragraphs: Paragraph[]};
const WIDE = {width: 2400, height: 1000};
const NARROW = {width: 2000, height: 1000};
const words = (text: string): string => text.trim().split(/\s+/).join(' ');

/** The witness's output: from its first line to its last. */
function region(lines: string[], tag: string): string[] {
  const start = lines.findIndex(line => line.includes(`witness ${tag}: the program sees`));
  const end = lines.findIndex(line => line.endsWith(`FIN-${tag}`));
  assert.ok(start >= 0 && end > start, lines.join('\n'));
  return lines.slice(start, end + 1);
}

/** The witness's paragraphs as read in the terminal, rows joined: its header and end left out. */
function readText(lines: string[]): string {
  return words(lines.slice(1, -1).join(' '));
}

const cols = (page: Page): Promise<number> => page.evaluate(() => active.term.cols);

describe('a replay is interpreted at the width it was produced at', {skip}, () => {
  const mesh = new TerminalMesh();

  before(() => mesh.start());
  after(() => mesh.stop());

  test('a narrow page attached after a wide program reads its text, and widened matches the wide page', async () => {
    await mesh.newShell('rw');
    const wide = await mesh.openPage('rw', WIDE);
    await typeLine(wide, `node ${WITNESS} a`);
    await waitForRow(wide, 'FIN-a');
    const wideRows = region(await rows(wide), 'a');
    const produced = Number(/sees (\d+) columns/.exec(wideRows[0])?.[1]);
    assert.equal(produced, await cols(wide));
    const source = words(paragraphs.map(({first, rest}) => `${first} ${rest}`).join(' '));
    assert.equal(readText(region(await logicalLines(wide), 'a')), source);

    const frames: (string | Buffer)[] = [];
    const narrow = await mesh.openPage('rw', NARROW, undefined, page => page.on('websocket', socket =>
      socket.on('framereceived', ({payload}) => { if (frames.length < 2) frames.push(payload); })));
    assert.ok(await cols(narrow) < produced, 'the narrow page is narrower than the program');
    const narrowLines = region(await logicalLines(narrow), 'a');
    assert.equal(readText(narrowLines), source, narrowLines.join('\n'));
    // server.py relayed the host's geometry before the replay: the wide page's size.
    const [geometry, replay] = frames;
    assert.equal(typeof geometry, 'string');
    assert.deepEqual(JSON.parse(geometry as string), {t: 'g', rows: await wide.evaluate(() => active.term.rows), cols: produced});
    assert.ok(Buffer.isBuffer(replay));

    await narrow.setViewportSize(WIDE);
    await narrow.waitForFunction(width => active.term.cols === width, produced);
    await narrow.waitForTimeout(300);
    assert.deepEqual(region(await rows(narrow), 'a'), wideRows);
    await narrow.context().close();
    await wide.context().close();
  });

  test("a pane that opens another session during a replay leaves that replay's size behind", async () => {
    await mesh.newShell('rs');   // born at 50x200, never attached: its replay is parsed at 200 columns
    await mesh.newShell('rb');
    const wide = await mesh.openPage('rb', WIDE);
    await typeLine(wide, `node ${WITNESS} b`);
    await waitForRow(wide, 'FIN-b');
    await wide.context().close();

    const page = await mesh.signIn(NARROW);
    await page.waitForFunction(() => active !== null);
    // xterm parses nothing until both replays have arrived: the first one is parsed while
    // the pane already belongs to the second session.
    await page.evaluate(() => {
      const w = window as unknown as Writes;
      w.__writes = []; w.__write = active.term.write;
      active.term.write = (data, done) => { w.__writes.push([data, done]); };
    });
    await page.locator('#list .item[data-id="rs"]').click();
    await page.waitForFunction(() => active.id === 'rs' && active.conn?.replaying === true, undefined, {timeout: 10000});
    assert.equal(await cols(page), 200, 'the first replay is parsed at its own width');
    await page.locator('#list .item[data-id="rb"]').click();
    await page.waitForFunction(() => active.id === 'rb' && active.conn?.replaying === true, undefined, {timeout: 10000});
    await page.evaluate(() => {
      const w = window as unknown as Writes;
      active.term.write = w.__write;
      for (const [data, done] of w.__writes) active.term.write(data, done);
    });
    await settle(page);
    const source = words(paragraphs.map(({first, rest}) => `${first} ${rest}`).join(' '));
    const lines = region(await logicalLines(page), 'b');
    assert.equal(readText(lines), source, lines.join('\n'));
    assert.equal(await cols(page), await page.evaluate(() => active.fit.proposeDimensions().cols));
    await page.context().close();
  });

  test('a socket that does not ask for the geometry gets the replay first, as before', async () => {
    await mesh.newShell('old');
    const page = await mesh.openPage('old', NARROW);
    const first = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://${location.host}/ws/old?rows=20&cols=80`);
      socket.binaryType = 'arraybuffer';
      socket.onmessage = event => { resolve(typeof event.data); socket.close(); };
      socket.onerror = () => reject(new Error('socket error'));
    }));
    assert.equal(first, 'object'); // an ArrayBuffer: the replay, no control message before it
    await page.context().close();
  });

  test('without a geometry before the replay (a host without the field), the replay is parsed at the pane size', async () => {
    await mesh.newShell('nog');   // born at 50x200, never attached: a current host names 200 columns
    // What the page sees from a PTY host that does not give replay_geometry: server.py then
    // sends no text message before the replay.
    const page = await mesh.signIn(NARROW, () => {
      const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        get() { return descriptor.get!.call(this); },
        set(handler: (event: MessageEvent) => void) {
          descriptor.set!.call(this, (event: MessageEvent) => {
            if (typeof event.data === 'string' && JSON.parse(event.data).t === 'g') return;
            handler.call(this, event);
          });
        },
      });
    });
    await page.waitForFunction(() => active !== null);
    await page.evaluate(() => {
      const w = window as unknown as {__cols: number[]};
      w.__cols = [];
      (active.term as unknown as {onResize(listener: (size: {cols: number}) => void): void})
        .onResize(({cols}) => w.__cols.push(cols));
    });
    await page.locator('#list .item[data-id="nog"]').click();
    await page.waitForFunction(() => active.id === 'nog' && active.conn?.ws?.readyState === 1, undefined, {timeout: 10000});
    await settle(page);
    const own = await cols(page);
    assert.notEqual(own, 200, 'the pane must be narrower than the session was born');
    const seen = await page.evaluate(() => (window as unknown as {__cols: number[]}).__cols);
    assert.ok(!seen.includes(200), `xterm took a geometry nobody named: ${JSON.stringify(seen)}`);
    await typeLine(page, "printf 'NO''GEOM-works\\n'");
    await waitForRow(page, 'NOGEOM-works');
    await page.context().close();
  });
});
