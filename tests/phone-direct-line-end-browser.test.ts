// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, how it ends without Enter: the chip, a control key, another pane or
// view, a lost connection or reconnection, a key that cannot be delivered, and the agent leaving
// the foreground (what is said, and the warning before the next ordinary line).
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {skip} from './terminal-browser-lib.ts';
import {
  direct, field, flashed, foreground, forget, frames, keyboardOpen, leaseDirty, screenRows, useMesh,
  waitForFlash, waitForShellLine,
} from './phone-direct-line-lib.ts';

describe('phone direct writing: how it ends', {skip}, () => {
  const {mesh, phone} = useMesh();

  test('the indicator leaves direct writing without sending anything and keeps the keyboard', async () => {
    const page = await phone('chip', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    await page.locator('#line-direct').click();
    assert.deepEqual(await frames(page), [], 'nothing is sent, no Enter, no erasing');
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '');
    assert.equal(await keyboardOpen(page), true);
    await waitForShellLine(page, '/a');   // what was typed stays visible in the terminal
    const message = await flashed(page);
    assert.ok(message.includes('stays in the agent'), message);
    assert.ok(!/empty/i.test(message), 'the chip does not claim the agent line is empty');
    await page.keyboard.type('hi');
    assert.deepEqual(await frames(page), [], 'an ordinary line again');
  });

  test('^C of the key bar ends it', async () => {
    const page = await phone('leave-cc', 'claude');
    await page.keyboard.type('/c');
    await waitForShellLine(page, '/c');
    await forget(page);
    await page.locator('#keys [data-k="cc"]').click();
    await page.waitForFunction(() => window.__input.length >= 1);
    assert.deepEqual(await frames(page), ['\x03']);
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '');
  });

  test('an armed Ctrl and a letter send the control key and end the mode', async () => {
    const page = await phone('ctrl', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    await page.locator('#keys [data-k="ctrl"]').click();
    await page.keyboard.type('c');
    await page.waitForFunction(() => window.__input.length >= 1);
    assert.deepEqual(await frames(page), ['\x03']);
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '');
  });

  test('an armed Ctrl and m is Enter: it ends the line and leaves no dirty input lease, as on the ordinary line', async () => {
    const page = await phone('ctrl-m', 'claude');
    await page.keyboard.type('/a');
    assert.equal(await leaseDirty(page), true, 'a line is in progress');
    await waitForShellLine(page, '/a');
    await forget(page);
    await page.locator('#keys [data-k="ctrl"]').click();
    await page.keyboard.type('m');
    await page.waitForFunction(() => window.__input.length >= 1);
    assert.deepEqual(await frames(page), ['\r']);
    assert.equal(await direct(page), false);
    await page.waitForFunction(() => !(active as unknown as {inputLease: {dirty: boolean}}).inputLease.dirty);
    assert.equal(await leaseDirty(page), false, 'the carriage return completed the line');
  });

  test('switching session in the same pane drops the mode', async () => {
    const page = await phone('switch-a', 'claude');
    await page.keyboard.type('/a');
    await mesh.newShell('switch-b');
    await page.evaluate(() => refresh());
    await page.evaluate(() => { document.querySelector<HTMLElement>('#btn-menu')!.click(); });
    await page.locator('#list .item[data-id="switch-b"]').click();
    await page.waitForFunction(() => active?.id === 'switch-b');
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '');
  });

  test('another pane becoming active drops the mode at once, before any inventory refresh', async () => {
    const page = await phone('pane-a', 'claude');
    await mesh.newShell('pane-b');
    await page.evaluate(() => refresh());
    // A second pane with a live connection, so that the key bar stays visible when it takes over
    // and only setActive can end the mode.
    await page.evaluate(() => { addPane('pane-b'); });
    await page.waitForFunction(() => panes.length === 2 && panes.every(p => p.conn?.ws?.readyState === 1));
    await page.evaluate(() => setActive(panes[0]!));
    await page.locator('#line-text').focus();
    await page.keyboard.type('/a');
    const state = await page.evaluate(() => {
      const before = lineDirect !== null, first = active;
      setActive(panes.find(p => p !== first)!);
      return {before, changed: active !== first, after: lineDirect !== null,
        chip: !document.querySelector<HTMLElement>('#line-direct')!.hidden};
    });
    assert.deepEqual(state, {before: true, changed: true, after: false, chip: false});
    assert.equal(await field(page), '');
  });

  test('a change of view drops the mode', async () => {
    const page = await phone('view', 'claude');
    await page.keyboard.type('/a');
    assert.equal(await direct(page), true);
    await page.evaluate(() => setExplorer(true));
    assert.equal(await direct(page), false);
  });

  test('the agent leaving the foreground ends the mode and nothing is sent after', async () => {
    const page = await phone('foreground-lost', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    assert.deepEqual(await frames(page), ['/', 'a']);
    foreground.set('foreground-lost', null);   // /exit, ^C twice or a crash: the shell is back
    await page.evaluate(() => refresh());
    assert.equal(await direct(page), false, 'the mode ended with the inventory');
    await waitForFlash(page, 'no longer in the foreground');
    await forget(page);
    await page.keyboard.type('bc');
    await page.keyboard.press('Backspace');
    assert.deepEqual(await frames(page), [], 'no frame after: the keys went to the ordinary line');
    assert.equal(await field(page), 'b');
    assert.equal(await direct(page), false);
  });

  test('keys typed before the inventory noticed the agent left may have reached the program: the message says so, and the next line waits for a second Enter', async () => {
    const page = await phone('residue', 'claude');
    await page.keyboard.type('/rev');
    await waitForShellLine(page, '/rev');
    foreground.set('residue', null);   // the agent left; the page does not know yet
    await page.keyboard.type('ls');    // the residual window: these keys still go out
    await waitForShellLine(page, '/revls');
    assert.equal((await frames(page)).join(''), '/revls');
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#line-direct')!.hidden);
    const message = await flashed(page);
    assert.ok(message.includes('may have reached the program'), message);
    assert.ok(!message.includes('nothing was sent'), 'the message does not claim what is false');
    await forget(page);
    await page.keyboard.type('echo X');
    await page.keyboard.press('Enter');
    assert.deepEqual(await frames(page), [], 'the first Enter only warns: the input lease is dirty');
    assert.equal(await field(page), 'echo X', 'the line is kept');
    await waitForFlash(page, 'check the terminal');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__input.join('').endsWith('\r'));
    assert.ok((await frames(page)).join('').includes('echo X'));
    assert.equal(await field(page), '');
    await forget(page);
    await page.keyboard.type('echo Y');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__input.join('').endsWith('\r'));
    assert.ok((await frames(page)).join('').includes('echo Y'), 'warned once: the next line goes at once');
  });

  /** The agent left during direct writing and the page learnt it: the next send is held once. */
  async function agentLeft(name: string): Promise<Page> {
    const page = await phone(name, 'claude');
    await page.keyboard.type('/rev');
    await waitForShellLine(page, '/rev');
    foreground.set(name, null);
    await page.keyboard.type('ls');   // the residual window
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#line-direct')!.hidden);
    await forget(page);
    return page;
  }

  test('the key bar ⏎ outside the mode is held back once after the agent left, like the ordinary line', async () => {
    const page = await agentLeft('residue-bar');
    await page.locator('#keys [data-k="enter"]').click();
    assert.deepEqual(await frames(page), [], 'the first ⏎ only warns');
    await waitForFlash(page, 'check the terminal');
    await page.locator('#keys [data-k="enter"]').click();
    assert.deepEqual(await frames(page), ['\r'], 'the second goes');
    await page.locator('#keys [data-k="enter"]').click();
    assert.deepEqual(await frames(page), ['\r', '\r'], 'held once only');
  });

  test('the hold expires: a line or a ⏎ sent long after the agent left is not held', async () => {
    for (const via of ['line', 'bar'] as const) {
      const page = await agentLeft(`residue-expired-${via}`);
      await page.evaluate(() => { directResidue!.since -= DIRECT_RESIDUE_MS + 1000; });
      if (via === 'line') {
        await page.keyboard.type('echo X');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__input.join('').endsWith('\r'));
        assert.ok((await frames(page)).join('').includes('echo X'), 'sent at once');
      } else {
        await page.locator('#keys [data-k="enter"]').click();
        assert.deepEqual(await frames(page), ['\r'], 'sent at once');
      }
      assert.equal(await page.evaluate(() => directResidue), null, 'nothing stays attached to the pane');
    }
  });

  test('the other keys of the bar are not held after the agent left: only a line that can be submitted is', async () => {
    const page = await agentLeft('residue-tab');
    await page.locator('#keys [data-k="tab"]').click();
    assert.deepEqual(await frames(page), ['\t']);
  });

  test('a lost connection ends the mode with a message', async () => {
    const page = await phone('lost', 'claude');
    await page.keyboard.type('/a');
    await page.evaluate(() => { active.conn!.ws!.close(); });
    await waitForFlash(page, 'connection lost');
    assert.equal(await direct(page), false);
    await forget(page);
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#flash')!.hidden, undefined, {timeout: 30000});
    await page.keyboard.type('z');
    assert.deepEqual(await frames(page), []);
  });

  test('a reconnection in the same pane ends the mode: the next key is not sent to the new connection', async () => {
    const page = await phone('reconnect', 'claude');
    await page.keyboard.type('/a');
    await forget(page);
    const state = await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      (active as unknown as {attach(id: string): void}).attach(active.id);   // a new connection replaces the old one in the same pane
      textarea.value = 'x';
      textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: 'x', bubbles: true}));
      return {mode: lineDirect !== null, value: textarea.value};
    });
    assert.deepEqual(state, {mode: false, value: 'x'}, 'the key stays in the field as an ordinary line');
    assert.ok(!(await frames(page)).includes('x'));
  });

  test('the connection object of the pane replaced under a running mode ends it, even if the old one was not closed', async () => {
    const page = await phone('conn-identity', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    await page.evaluate(() => { active.conn = {...active.conn!} as typeof active.conn; });   // same session, another connection
    await page.keyboard.type('x');
    assert.deepEqual(await frames(page), [], 'nothing goes out on a connection the mode did not start on');
    assert.equal(await direct(page), false);
    assert.equal(await field(page), 'x');
    await waitForFlash(page, 'connection lost');
  });

  test('keys that cannot be delivered say so', async () => {
    const page = await phone('keys-fail', 'claude');
    await page.keyboard.type('/h');
    await waitForShellLine(page, '/h');
    await page.evaluate(() => {
      (active as unknown as {inputAck: {write: () => boolean}}).inputAck.write = () => false;
    });
    await page.keyboard.type('e');
    await waitForFlash(page, 'keys not delivered');
    assert.equal(await direct(page), false);
  });

  test('Enter that cannot be delivered says so, and nothing is lost silently', async () => {
    const page = await phone('enter-fails', 'claude');
    await page.keyboard.type('/he');
    await waitForShellLine(page, '/he');
    await forget(page);
    await page.evaluate(() => {   // acknowledged input cannot retain Enter
      (active as unknown as {inputAck: {write: () => boolean}}).inputAck.write = () => false;
    });
    await page.keyboard.press('Enter');
    await waitForFlash(page, 'Enter was not delivered');
    assert.deepEqual(await frames(page), []);
    assert.equal(await direct(page), false);
    assert.equal((await screenRows(page))[0]!.endsWith('/he'), true, 'the line is still there, in the terminal');
  });
});
