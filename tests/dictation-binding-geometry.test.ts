// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {logicalLines, type PaneView, REPO, rows, skip, TerminalMesh, typeLine, waitForRow, WITNESS} from './terminal-browser-lib.ts';

declare const active: PaneView & {conn: {created: number}; fit: {proposeDimensions(): {cols: number}}};
const words = (text: string) => text.trim().split(/\s+/).join(' ');
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
function region(lines: string[]): string[] {
  const start = lines.findIndex(line => line.includes('witness binding: the program sees'));
  const end = lines.findIndex(line => line.endsWith('FIN-binding'));
  assert.ok(start >= 0 && end > start, lines.join('\n'));
  return lines.slice(start, end + 1);
}

test('conditional bound preserves owned replay, explicit size takeover and later widening', {skip, timeout: 30000}, async () => {
  const mesh = new TerminalMesh();
  const wideSize = {width: 2400, height: 1000}, narrowSize = {width: 2000, height: 1000};
  try {
    await mesh.start(); await mesh.newShell('binding-width');
    const wide = await mesh.openPage('binding-width', wideSize);
    await typeLine(wide, `node ${quote(WITNESS)} binding`); await waitForRow(wide, 'FIN-binding');
    const wideRows = region(await rows(wide));
    const produced = Number(/sees (\d+) columns/.exec(wideRows[0])?.[1]);
    const geometry = await wide.evaluate(() => ({rows: active.term.rows, cols: active.term.cols}));
    const created = await wide.evaluate(() => active.conn.created);
    assert.equal(produced, geometry.cols);
    const {paragraphs} = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'terminal-width-witness.json'), 'utf8'));
    const source = words(paragraphs.map(({first, rest}: {first: string; rest: string}) => `${first} ${rest}`).join(' '));
    assert.equal(words(region(await logicalLines(wide)).slice(1, -1).join(' ')), source);
    const frames: (string | Buffer)[] = [];
    const narrow = await mesh.openPage('binding-width', narrowSize, undefined, page => page.on('websocket', socket =>
      socket.on('framereceived', ({payload}) => {if (frames.length < 3) frames.push(payload);})));
    assert.equal(await narrow.evaluate(() => active.term.cols), produced, 'the second pane follows the first size owner');
    assert.equal(words(region(await logicalLines(narrow)).slice(1, -1).join(' ')), source);
    assert.equal(typeof frames[0], 'string');
    assert.equal(typeof frames[1], 'string');
    assert.deepEqual(JSON.parse(frames[0] as string), {t: 'bound', name: 'binding-width', created});
    assert.deepEqual(JSON.parse(frames[1] as string), {t: 'g', ...geometry});
    assert.ok(Buffer.isBuffer(frames[2]), 'original geometry precedes binary replay');
    await narrow.locator('.size-banner button').click();
    await narrow.waitForFunction(width => active.term.cols < width, produced);
    assert.equal(words(region(await logicalLines(narrow)).slice(1, -1).join(' ')), source);
    await narrow.setViewportSize(wideSize);
    await narrow.waitForFunction(width => active.term.cols === width, produced);
    await narrow.waitForTimeout(300);
    assert.deepEqual(region(await rows(narrow)), wideRows, 'widening reconstructs the original wide rows');
  } finally {await mesh.stop();}
});
