// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, how it starts: on a touch phone, a line that starts with `/` (or `$` in
// Codex) in an agent session goes to the terminal as it is typed, so the agent can show its
// completion; any other line stays the input line, composed locally and sent on Enter. This file
// covers what starts it, what never does, and the computer, which is unchanged.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {skip} from './terminal-browser-lib.ts';
import {
  direct, field, flashed, foreground, forget, frames, keyboardOpen, useMesh, waitForShellLine,
} from './phone-direct-line-lib.ts';

describe('phone direct writing: how it starts', {skip}, () => {
  const {mesh, phone, desktop} = useMesh();

  test('/ in a Claude Code session: the characters reach the terminal one by one and the field stays empty', async () => {
    const page = await phone('slash-claude', 'claude');
    await page.keyboard.type('/');
    assert.deepEqual(await frames(page), ['/']);
    assert.equal(await direct(page), true, 'the mode indicator shows');
    assert.equal(await keyboardOpen(page), true, 'the field keeps the focus, so the keyboard stays open');
    await waitForShellLine(page, '/');
    await page.keyboard.type('he');
    assert.deepEqual(await frames(page), ['/', 'h', 'e']);
    await waitForShellLine(page, '/he');
    assert.equal(await field(page), '', 'the terminal shows the line, not the field');
    assert.equal(await keyboardOpen(page), true);
  });

  test('$ starts it in Codex, and not in Claude Code', async () => {
    const codex = await phone('dollar-codex', 'codex');
    await codex.keyboard.type('$sk');
    assert.deepEqual(await frames(codex), ['$', 's', 'k']);
    assert.equal(await direct(codex), true);
    const claude = await phone('dollar-claude', 'claude');
    await claude.keyboard.type('$sk');
    assert.deepEqual(await frames(claude), []);
    assert.equal(await direct(claude), false);
    assert.equal(await field(claude), '$sk');
  });

  test('Pi takes / like the other agents', async () => {
    const page = await phone('slash-pi', 'pi');
    await page.keyboard.type('/s');
    assert.deepEqual(await frames(page), ['/', 's']);
  });

  test('any other first character keeps the input line: nothing is sent before Enter', async () => {
    const page = await phone('plain-claude', 'claude');
    await page.keyboard.type('hello /not-a-command');
    assert.deepEqual(await frames(page), []);
    assert.equal(await direct(page), false);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value === '' && linePending === null);
    const sent = (await frames(page)).join('');
    assert.ok(sent.includes('hello /not-a-command') && sent.endsWith('\r'), JSON.stringify(sent));
  });

  test('a / that is not the first character does not start it', async () => {
    const page = await phone('inner-slash', 'claude');
    await page.keyboard.type('a/b');
    assert.deepEqual(await frames(page), []);
    assert.equal(await direct(page), false);
  });

  test('a / inserted in front of text the field already holds does not start it and sends nothing', async () => {
    const page = await phone('slash-in-front', 'claude');
    await page.keyboard.type('ls');
    await page.keyboard.press('Home');   // the cursor is at the start of an ordinary line
    await page.keyboard.type('/');
    assert.equal(await field(page), '/ls', 'it stays one ordinary line');
    assert.equal(await direct(page), false);
    assert.deepEqual(await frames(page), []);
    await page.keyboard.type('x');
    assert.deepEqual(await frames(page), [], 'still held: nothing went out');
  });

  test('a plain shell keeps the input line for a path starting with /', async () => {
    const page = await phone('slash-shell', null);
    await page.keyboard.type('/usr/bin');
    assert.deepEqual(await frames(page), []);
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '/usr/bin');
  });

  test('a pasted line that starts with / stays an ordinary paste', async () => {
    const page = await phone('paste-claude', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('/tmp/a path with spaces'));
    await page.locator('#line-text').focus();
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value.length > 0);
    assert.equal(await direct(page), false);
    assert.deepEqual(await frames(page), []);
  });

  test('a multi-line insertion starting with / never starts the mode and sends no raw line break', async () => {
    const page = await phone('multiline-start', 'claude');
    await page.keyboard.insertText('/touch should-not-exist\nsecond');
    assert.equal(await direct(page), false);
    assert.deepEqual(await frames(page), [], 'nothing reaches the terminal: not even the first line');
    assert.equal(await field(page), '/touch should-not-exist\nsecond', 'it stays an ordinary line to review');
  });

  test('the foreground is refreshed when the mode starts', async () => {
    const page = await phone('foreground-entry', 'claude');
    foreground.set('foreground-entry', null);   // gone since the last poll
    await page.keyboard.type('/');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#line-direct')!.hidden, undefined, {timeout: 30000});
    await forget(page);
    await page.keyboard.type('x');
    assert.deepEqual(await frames(page), [], 'at most the first character went out');
    assert.equal(await field(page), 'x');
  });

  test('while writing directly the field takes no capital, correction or spell check, and gets them back after', async () => {
    const page = await phone('typing-attributes', 'claude');
    const attributes = () => page.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>('#line-text')!;
      return {capitalize: el.getAttribute('autocapitalize'), correct: el.getAttribute('autocorrect'), spellcheck: el.getAttribute('spellcheck')};
    });
    const ordinary = await attributes();
    assert.equal(ordinary.spellcheck, null, 'the field has no spellcheck attribute of its own');
    await page.keyboard.type('/a');
    assert.deepEqual(await attributes(), {capitalize: 'off', correct: 'off', spellcheck: 'false'});
    await page.locator('#line-direct').click();
    assert.deepEqual(await attributes(), ordinary, 'the attributes are as they were, an absent one absent');
  });

  test('text a keyboard composed before the cursor went to the start of the field: a composed / in front does not start it', async () => {
    const page = await phone('composed-front', 'claude');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {text: 'fix', selectionStart: 3, selectionEnd: 3});
    await cdp.send('Input.insertText', {text: 'fix'});
    assert.equal(await field(page), 'fix');
    await page.evaluate(() => (document.querySelector('#line-text') as HTMLTextAreaElement).setSelectionRange(0, 0));
    await cdp.send('Input.imeSetComposition', {text: '/x', selectionStart: 2, selectionEnd: 2});
    await cdp.send('Input.insertText', {text: '/x'});
    await page.waitForTimeout(300);
    assert.deepEqual(await frames(page), [], 'nothing was sent');
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '/xfix', 'an ordinary line');
  });

  test('a composition in progress when another pane becomes active does not start the mode on a connection that is not open yet', async () => {
    const page = await phone('not-ready', 'claude');
    foreground.set('not-ready-other', 'claude');
    await mesh.newShell('not-ready-other');
    await page.evaluate(() => refresh());
    await page.keyboard.type('/a');
    await forget(page);
    const open = await page.evaluate(async () => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      textarea.value = '/bc';
      setActive(addPane('not-ready-other')!);
      const open = !!active.conn?.terminal?.isOpen();   // just attached: the socket is not open
      textarea.dispatchEvent(new CompositionEvent('compositionend', {data: '/bc', bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 50));
      return open;
    });
    assert.equal(open, false, 'the case needs a connection that is not open yet');
    assert.equal(await field(page), '/bc', 'the word stays in the field');
    assert.equal(await direct(page), false);
    assert.deepEqual(await frames(page), []);
    assert.ok(!(await flashed(page)).includes('not delivered'), await flashed(page));
  });

  test('on a computer nothing changes: keys go to the terminal and there is no direct mode', async () => {
    const page = await desktop('desktop', 'claude');
    assert.equal(await page.locator('#line').isVisible(), false, 'no input line on a computer');
    await page.evaluate(() => active.term.focus());
    await page.keyboard.type('/x');
    await waitForShellLine(page, '/x');
    assert.deepEqual((await frames(page)).join(''), '/x');
    assert.equal(await direct(page), false);
    assert.equal(await flashed(page), '');
  });
});
