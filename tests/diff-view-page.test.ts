// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A `.diff` or `.patch` file opened in the side panel is rendered by the diff viewer
// (view.py: diff_page, static/diff.html, static/diff-view.js under /viewlib/). The page embeds
// the diff as JSON that cannot close its script element, runs under the rendered-Markdown policy
// (only its own scripts, by nonce, in the sandbox), and writes the diff into the page as text.
// The rendering part needs a Chromium: MESH_CHROMIUM=<path>; skipped without it
// (MESH_REQUIRE_BROWSER=1 makes the absence a failure).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skipBrowser = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const NONCE = 'test-nonce-0123456789';

const DIFF = `diff --git a/lib/a.ml b/lib/a.ml
--- a/lib/a.ml
+++ b/lib/a.ml
@@ -1,3 +1,3 @@
 let x = 1
-let s = "</script><!--"
+let s = "<img src=x onerror=alert(1)>"
 let z = 4
diff --git a/b.txt b/b.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+hello
`;

type Rendered = {page: string; csp: string; own: string[]; ext: string[]; served: string};

// Runs `code` with view.py importable and a throwaway HOME (exposed to it as HOME_DIR);
// `input` is its standard input; returns what it prints, parsed as JSON.
function python(code: string, input = ''): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-view-page-'));
  try {
    const prelude = `import sys, json\nsys.path.insert(0, ${JSON.stringify(REPO)})\nHOME_DIR = ${JSON.stringify(home)}\n`;
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', prelude + code],
      {cwd: REPO, env: {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: path.join(home, 'conf'), PYTHONIOENCODING: 'utf-8'}, encoding: 'utf8', input,
        maxBuffer: 64 * 1024 * 1024});
    return JSON.parse(output);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
}

function render(name: string, text: string): Rendered {
  return python(`from pathlib import Path
import view
print(json.dumps({"page": view.diff_page(Path(${JSON.stringify(name)}), sys.stdin.read(), ${JSON.stringify(NONCE)}),
                  "csp": view.markdown_csp(${JSON.stringify(NONCE)}), "own": sorted(view.VIEWLIB_OWN),
                  "ext": sorted(view.DIFF_EXT), "served": str(view.STATIC)}))`, text) as Rendered;
}

// What view._respond answers for a file of `content` (a Python bytes literal), with a `limit`
// standing for the 4 MiB one: the type served.
function served(content: string, query = '', limit = 64): string {
  return python(`import asyncio, os
from pathlib import Path
from aiohttp.test_utils import make_mocked_request
import view
view.DIFF_MAX_BYTES = ${limit}
path = Path(HOME_DIR) / "x.diff"
path.write_bytes(${content})
handle = open(path, "rb")
request = make_mocked_request("GET", "/view/x.diff${query}", headers={"Sec-Fetch-Dest": "iframe"})
response = asyncio.run(view._respond(request, path, handle))
kind = (response.headers.get("Content-Type") or response.content_type).split(";")[0]
handle.close()
print(json.dumps(kind))`) as string;
}

describe('the diff page', () => {
  const rendered = render('<b>x&"y.diff', DIFF);

  test('renders .diff and .patch files, with the bundle built from static/diff-view.ts', () => {
    assert.deepEqual(rendered.ext, ['.diff', '.patch']);
    assert.deepEqual(rendered.own, ['diff-view.js']);
    assert.ok(fs.existsSync(path.join(rendered.served, 'diff-view.js')));
  });

  test('embeds the diff as JSON that cannot close its script element', () => {
    const block = rendered.page.split('id="src">')[1]?.split('</script>')[0] ?? '';
    assert.ok(!block.includes('</') && !block.includes('<!--'));
    assert.equal(JSON.parse(block), DIFF);
  });

  test('escapes the file name and gives the scripts the nonce', () => {
    assert.ok(rendered.page.includes('<title>&lt;b&gt;x&amp;&quot;y.diff</title>'));
    assert.ok(!rendered.page.includes('{{'));
    assert.equal(rendered.page.match(new RegExp(`nonce="${NONCE}"`, 'g'))?.length, 2);
    assert.match(rendered.csp, /^sandbox allow-scripts allow-downloads; /);
    assert.ok(rendered.csp.includes(`script-src 'nonce-${NONCE}'`) && rendered.csp.includes("connect-src 'none'"));
  });
});

describe('the diff page is served', () => {
  test('rendered when it is text within the limit', () => {
    assert.equal(served(String.raw`b"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"`), 'text/html');
  });

  test('reads at most one byte past the limit when the file grew after its size was checked', () => {
    const result = python(`import asyncio
from pathlib import Path
from aiohttp.test_utils import make_mocked_request
import view
view.DIFF_MAX_BYTES = 64
path = Path(HOME_DIR) / "grown.diff"
path.write_bytes(b"+" * 1000)
view._size = lambda handle: 10           # the size seen before the file grew
reads = []
to_thread = asyncio.to_thread
async def recorded(function, *args):
    reads.append(list(args))
    return await to_thread(function, *args)
view.asyncio.to_thread = recorded
handle = open(path, "rb")
request = make_mocked_request("GET", "/view/grown.diff", headers={"Sec-Fetch-Dest": "iframe"})
response = asyncio.run(view._respond(request, path, handle))
handle.close()
print(json.dumps({"type": response.headers.get("Content-Type", "").split(";")[0], "reads": reads}))`) as {type: string; reads: number[][]};
    assert.deepEqual(result, {type: 'text/plain', reads: [[65]]});
  });

  test('as plain text past the limit, read bounded (a growing file is not read whole)', () => {
    assert.equal(served(String.raw`b"+" * 65`), 'text/plain');
    assert.equal(served(String.raw`b"+" * 64`), 'text/html');
  });

  test('as plain text when it holds a NUL byte, like the code viewer', () => {
    assert.equal(served(String.raw`b"--- a/x\n\x00"`), 'text/plain');
    // anywhere in what is read, not only in the first 8 KiB
    assert.equal(served(String.raw`b"+" * 9000 + b"\x00"`, '', 20_000), 'text/plain');
    assert.equal(served(String.raw`b"+" * 9000`, '', 20_000), 'text/html');
  });

  test('as plain text with ?raw=1, and in the code viewer with ?source=1 (line targets)', () => {
    assert.equal(served(String.raw`b"+a\n"`, '?raw=1'), 'text/plain');
    assert.equal(served(String.raw`b"+a\n"`, '?source=1'), 'text/html');
  });
});

describe('the diff page in a browser', {skip: skipBrowser}, () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio'])); });
  after(async () => { await browser?.close(); });

  test('shows each file, the changed words, and the diff as text only', async () => {
    const {page: html, csp} = render('change.diff', DIFF);
    const page = await browser.newPage();
    const violations: string[] = [];
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    page.on('console', message => { if (/Content.Security.Policy/i.test(message.text())) violations.push(message.text()); });
    await page.route('http://mesh.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/viewlib/diff-view.js') {
        return route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(REPO, 'static', 'diff-view.js'))});
      }
      return route.fulfill({contentType: 'text/html', body: html, headers: {'Content-Security-Policy': csp}});
    });
    await page.goto('http://mesh.test/view/change.diff');
    await page.waitForSelector('details.file');

    assert.equal(await page.locator('details.file').count(), 2);
    assert.deepEqual(await page.locator('summary .path').allTextContents(), ['lib/a.ml', 'b.txt']);
    assert.equal(await page.locator('.badge.added').textContent(), 'new');
    // the payload is shown as text: no element was created from it, nothing ran
    assert.equal(await page.locator('main img').count(), 0);
    assert.ok((await page.locator('td.code.add').first().textContent())?.includes('<img src=x onerror=alert(1)>'));
    assert.deepEqual(await page.locator('td.add .w').allTextContents(), ['img src=x onerror=alert(1)']);
    assert.deepEqual(await page.locator('td.ln.del').evaluateAll(cells => cells.map(cell => cell.getAttribute('data-n'))), ['2', null]);

    await page.getByRole('button', {name: 'split'}).click();
    assert.equal(await page.locator('table.split').count(), 2);
    await page.getByRole('button', {name: 'words'}).click();
    assert.equal(await page.locator('td .w').count(), 0);

    assert.deepEqual(dialogs, []);
    assert.deepEqual(violations, []);
    await page.close();
  });

  // A page serving `text` as the diff, routed like the one above; `seen` collects the URLs loaded.
  async function open(text: string, hash = '', seen: string[] = []) {
    const {page: html, csp} = render('big.diff', text);
    const page = await browser.newPage();
    await page.route('http://mesh.test/**', route => {
      const url = new URL(route.request().url());
      seen.push(url.pathname + url.search);
      if (url.pathname === '/viewlib/diff-view.js') {
        return route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(REPO, 'static', 'diff-view.js'))});
      }
      return route.fulfill({contentType: 'text/html', body: html, headers: {'Content-Security-Policy': csp}});
    });
    await page.goto(`http://mesh.test/view/big.diff?dt=t${hash}`);
    return page;
  }

  const added = (name: string, count: number): string =>
    `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n${Array.from({length: count}, (_, k) => `+line ${k}\n`).join('')}`;
  const git = (name: string, count: number): string => `diff --git a/${name} b/${name}\n${added(name, count)}`;
  // `count` files whose mode only changed (no hunk)
  const chmods = (count: number): string =>
    Array.from({length: count}, (_, k) => `diff --git a/m${k} b/m${k}\nold mode 100644\nnew mode 100755\n`).join('');
  // the mode badge of each file (null without one)
  const modeBadges = (page: Page): Promise<(string | null)[]> =>
    page.locator('details.file').evaluateAll(nodes => nodes.map(node => node.querySelector('.badge.mode')?.textContent ?? null));

  test('builds a large diff in parts, and the files past the first screens folded', async () => {
    const page = await open(added('one', 4500) + added('two', 3000) + added('three', 10));
    await page.waitForSelector('details.file');
    const files = page.locator('details.file');
    assert.deepEqual(await files.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open)), [true, true, false]);
    // the first chunk of 2000 positions: the hunk header and 1999 lines
    assert.equal(await files.nth(0).locator('tr').count(), 2000);
    assert.equal(await files.nth(2).locator('tr').count(), 0);
    await files.nth(0).getByRole('button', {name: /^show 2000 more lines \(2501 left\)$/}).click();
    assert.equal(await files.nth(0).locator('tr').count(), 4000);
    // a view change rebuilds the rows already shown, no more
    await page.getByRole('button', {name: 'split'}).click();
    assert.equal(await files.nth(0).locator('tr').count(), 4000);
    await files.nth(2).locator('summary').click();
    await files.nth(2).locator('table').waitFor();
    assert.equal(await files.nth(2).locator('tr').count(), 11);
    await page.close();
  });

  test('keeps the keyboard focus on the toolbar across view changes', async () => {
    const page = await open(DIFF);
    await page.waitForSelector('details.file');
    await page.getByRole('button', {name: 'split'}).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('table.split').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'split');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    assert.equal(await page.getByRole('button', {name: 'words'}).getAttribute('aria-pressed'), 'false');
    await page.close();
  });

  test('shows a carriage return that belongs to the file, without an element per return', async () => {
    const page = await open(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-line\r\n+line${'\r'.repeat(500)}x\n`);
    await page.waitForSelector('details.file');
    assert.deepEqual(await page.locator('td.del .w').allTextContents(), ['␍']);
    assert.equal(await page.locator('td.add').last().evaluate(cell => cell.querySelectorAll('*').length), 1);
    assert.equal(await page.locator('td.add .w').textContent(), `${'␍'.repeat(500)}x`);
    await page.close();
  });

  const replaced = (name: string, count: number): string =>
    `--- a/${name}\n+++ b/${name}\n@@ -1,${count} +1,${count} @@\n${'-old\n'.repeat(count)}${'+new\n'.repeat(count)}`;

  // The lines a page shows, as "-old" or "+new" line numbers.
  const visibleLines = (page: Awaited<ReturnType<typeof open>>): Promise<string[]> =>
    page.locator('td.ln.del[data-n], td.ln.add[data-n]').evaluateAll(cells =>
      cells.map(cell => `${cell.classList.contains('del') ? '-' : '+'}${cell.getAttribute('data-n')}`));

  test('keeps the lines shown across views, both ways, when partly loaded', async () => {
    const page = await open(replaced('pairs', 3000));
    await page.waitForSelector('details.file');
    // unified: the hunk header and the first 1999 deleted lines
    const unified = await visibleLines(page);
    assert.equal(unified.length, 1999);
    await page.getByRole('button', {name: 'split'}).click();
    const split = new Set(await visibleLines(page));
    for (const line of unified) assert.ok(split.has(line), `${line} still shown in split`);
    // each deleted line comes with the added line it pairs with
    assert.equal(split.size, 2 * 1999);
    await page.getByRole('button', {name: 'unified'}).click();
    const back = new Set(await visibleLines(page));
    for (const line of split) assert.ok(back.has(line), `${line} still shown in unified`);
    await page.close();
  });

  test('builds one chunk at a time after a view change, however far the pairs reach', async () => {
    const page = await open(replaced('long', 20_000));
    await page.waitForSelector('details.file');
    const rows = page.locator('details.file tr:not(.hunk)');
    await page.getByRole('button', {name: 'split'}).click();
    assert.equal(await rows.count(), 1999);            // the pairs of the 1999 deleted lines shown
    await page.getByRole('button', {name: 'words'}).click();
    assert.equal(await rows.count(), 1999);            // a rebuild in the same view builds the same rows
    // the next chunk: 2000 pairs, so 4000 lines
    assert.equal(await page.locator('button.more').textContent(), 'show 4000 more lines (36002 left)');
    await page.locator('button.more').click();
    assert.equal(await rows.count(), 3999);            // one chunk more
    assert.equal(await page.locator('button.more').textContent(), 'show 4000 more lines (32002 left)');
    // back to unified: the added lines split showed are 18000 positions ahead, more than two
    // chunks, so the unified view shows the deleted lines up to the cursor
    await page.getByRole('button', {name: 'unified'}).click();
    assert.equal(await rows.count(), 3999);
    await page.close();
  });

  test('keeps a file fully loaded in split fully shown in unified', async () => {
    const page = await open(replaced('pairs', 3000));
    await page.waitForSelector('details.file');
    await page.getByRole('button', {name: 'split'}).click();
    while (await page.locator('button.more').count()) await page.locator('button.more').click();
    assert.equal((await visibleLines(page)).length, 6000);
    await page.getByRole('button', {name: 'unified'}).click();
    assert.equal((await visibleLines(page)).length, 6000);
    await page.close();
  });

  // The layout switch of #157 at a desktop and a phone width: a file fully loaded in split keeps
  // every line in unified, past two chunks of difference too (5000 deleted, then 5000 added).
  for (const width of [1440, 390]) {
    test(`keeps 5000 replaced lines fully loaded in split fully shown in unified (${width} px)`, async () => {
      const page = await open(replaced('pairs', 5000));
      await page.setViewportSize({width, height: 900});
      await page.waitForSelector('details.file');
      await page.getByRole('button', {name: 'split'}).click();
      while (await page.locator('button.more').count()) await page.locator('button.more').click();
      assert.equal((await visibleLines(page)).length, 10_000);
      await page.getByRole('button', {name: 'unified'}).click();
      assert.equal(await page.locator('button.more').count(), 0);
      assert.equal((await visibleLines(page)).length, 10_000);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
      await page.close();
    });
  }

  test('shows the mode change of a file, with or without a content change', async () => {
    const page = await open('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
      + 'diff --git a/new.sh b/new.sh\nnew file mode 100755\n--- /dev/null\n+++ b/new.sh\n@@ -0,0 +1 @@\n+x\n'
      + 'diff --git a/same b/same\nindex 1..2 100644\n--- a/same\n+++ b/same\n@@ -1 +1 @@\n-a\n+b\n'
      + 'diff --git a/kept b/kept\nold mode 100644\nnew mode 100644\n');
    await page.setViewportSize({width: 390, height: 800});
    await page.waitForSelector('details.file');
    assert.deepEqual(await modeBadges(page), ['mode 100644 → 100755', 'mode 100755', null, null]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
    await page.close();
  });

  // A format-patch series: the message of the second patch (lines that read like modes, one of
  // them very long) follows the chmod-only first patch and is not shown as its mode.
  test('shows no mode from the message of the next patch in a series', async () => {
    const page = await open('From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 1/2] chmod\n\n---\n'
      + 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n-- \n2.47.0\n\n'
      + `From 2 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] notes\n\nold mode notes\nnew mode 100600 explained here ${'7'.repeat(5000)}\n---\n`
      + 'diff --git a/notes b/notes\nindex 1..2 100644\n--- a/notes\n+++ b/notes\n@@ -1 +1 @@\n-a\n+b\n');
    await page.setViewportSize({width: 390, height: 800});
    await page.waitForSelector('details.file');
    assert.deepEqual(await modeBadges(page), ['mode 100644 → 100755', null]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
    await page.close();
  });

  // The worst case of GROW_STEPS: a file of 4000 lines and one of 24000 take 14 "show more" steps,
  // then 1998 folded files one step each, more than MAX_DIFF_FILES + 5 steps in all.
  test('a watched reload loads in one call every file a deep position needs', async () => {
    const page = await open(git('f0', 4000) + git('f1', 24_000) + chmods(1998));
    await page.waitForSelector('details.file');
    await page.evaluate('page.growTo(1e9)');
    assert.equal(await page.locator('details.file[open]').count(), 2000);
    assert.equal(await page.locator('button.more').count(), 0);
    await page.close();
  });

  // Reading the page height lays the page out: a watched reload reads it once every few steps, not
  // after each one (2000 files of 20 lines took about 29 s that way), and still opens every file.
  test('a watched reload of 2000 small files reads the page height only every few steps', async () => {
    const page = await open(Array.from({length: 2000}, (_, k) => git(`s${k}`, 20)).join(''));
    await page.waitForSelector('details.file');
    const reads = await page.evaluate(`(() => {
      const read = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight').get;
      let reads = 0;
      Object.defineProperty(document.documentElement, 'scrollHeight', {configurable: true, get() { reads += 1; return read.call(this); }});
      page.growTo(1e9);
      return reads;
    })()`) as number;
    assert.equal(await page.locator('details.file[open]').count(), 2000);
    assert.equal(await page.locator('button.more').count(), 0);
    assert.ok(reads > 0 && reads <= 2000 / 8, `${reads} height reads`);
    await page.close();
  });

  // A height within reach stops the loading soon after it: at most GROW_MEASURE_STEPS (32) steps
  // more than it needs (about six files of 20 lines make 2000 px).
  test('a watched reload stops loading a few steps after the height it needs', async () => {
    const page = await open(Array.from({length: 2000}, (_, k) => git(`s${k}`, 20)).join(''));
    await page.waitForSelector('details.file');
    const before = await page.locator('details.file[open]').count();
    const [height, reached] = await page.evaluate(`(() => {
      const height = document.documentElement.scrollHeight + 2000;
      page.growTo(height);
      return [height, document.documentElement.scrollHeight];
    })()`) as [number, number];
    const after = await page.locator('details.file[open]').count();
    assert.ok(reached >= height, `${reached} px for ${height}`);
    assert.ok(after > before + 1 && after <= before + 64, `${before} then ${after} files open`);
    await page.close();
  });

  // Large files are not unfolded a few at a time: the height is read again once a chunk's worth of
  // positions was built (here, the rest of the third file and the fourth one).
  test('a watched reload reads the height again after a chunk of large files', async () => {
    const page = await open(Array.from({length: 30}, (_, k) => git(`l${k}`, 1500)).join(''));
    await page.waitForSelector('details.file');
    assert.equal(await page.locator('details.file[open]').count(), 3);
    await page.evaluate('page.growTo(document.documentElement.scrollHeight + 1)');
    assert.equal(await page.locator('details.file[open]').count(), 4);
    await page.close();
  });

  test('keeps the keyboard focus on "show more", then on the first row of the last chunk', async () => {
    const page = await open(added('one', 4500));
    await page.waitForSelector('details.file');
    await page.locator('button.more').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'more');
    assert.equal(await page.locator('button.more').textContent(), 'show 501 more lines (501 left)');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('button.more').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector('td.ln.add[data-n]')?.getAttribute('data-n')), '4000');
    await page.close();
  });

  test('past the file limit, says so and links to the plain text instead of rendering', async () => {
    const modes = Array.from({length: 2001}, (_, k) => `diff --git a/f${k} b/f${k}\nold mode 100644\nnew mode 100755\n`).join('');
    const page = await open(modes);
    await page.waitForSelector('.note.large');
    assert.equal(await page.locator('.note.large').textContent(),
      'This diff has 2001 files, more than the diff viewer shows (2000). Open it as plain text.');
    assert.equal(await page.locator('details').count(), 0);
    await page.close();
  });

  test('counts each file block against the initial limit', async () => {
    const git = (name: string, count: number): string => `diff --git a/${name} b/${name}\n${added(name, count)}`;
    const modes = Array.from({length: 1997}, (_, k) => `diff --git a/f${k} b/f${k}\nold mode 100644\nnew mode 100755\n`).join('');
    // 4000 - (1 + 2000) - 1997 blocks = 2 left: the next file opens, the one after starts folded
    // (without the blocks counted, it would open too)
    const page = await open(git('big', 3000) + modes + git('next', 10) + git('after', 10));
    await page.waitForSelector('details.file');
    const unfolded = await page.locator('details.file').evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open));
    assert.equal(unfolded.length, 2000);
    assert.deepEqual(unfolded.slice(-2), [true, false]);
    await page.close();
  });

  test('counts hunk headers against the limits', async () => {
    const page = await open(`--- a/x\n+++ b/x\n${'@@ -1,0 +1,0 @@\n'.repeat(5000)}`);
    await page.waitForSelector('details.file');
    assert.equal(await page.locator('tr.hunk').count(), 2000);
    assert.equal(await page.locator('button.more').textContent(), 'show more');
    await page.close();
  });

  test('shares the lines of the first screens out over the files, in order', async () => {
    // a block and 2000 positions, then a block and 1997: one position is left for the third file
    const page = await open(added('a', 1999) + added('b', 1996) + added('c', 10) + added('d', 10));
    await page.waitForSelector('details.file');
    const files = page.locator('details.file');
    assert.deepEqual(await files.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open)), [true, true, true, false]);
    assert.equal(await files.nth(2).locator('tr').count(), 1);
    assert.equal(await files.nth(2).locator('button.more').textContent(), 'show 10 more lines (10 left)');
    await page.close();
  });

  test('rebuilds a file unfolded after a view change in that view', async () => {
    const page = await open(DIFF);
    await page.waitForSelector('details.file');
    await page.locator('details.file summary').first().click();
    await page.getByRole('button', {name: 'split'}).click();
    await page.locator('details.file summary').first().click();
    await page.locator('details.file').first().locator('table.split').waitFor();   // on the toggle event
    assert.equal(await page.locator('details.file').first().locator('table.split').count(), 1);
    assert.equal(await page.locator('details.file').first().locator('table.unified').count(), 0);
    await page.close();
  });

  test('loads again the rows a watched reload scrolls back to', async () => {
    const page = await open(added('one', 4500) + added('two', 3000) + added('three', 10));
    await page.waitForSelector('details.file');
    const rows = page.locator('details.file tr:not(.hunk)');
    assert.equal(await rows.count(), 1999 + 1998);
    // what the "scrollto" message of the mesh does (diff.html), for a position past the rows built
    await page.evaluate('page.growTo(document.documentElement.scrollHeight + 50000)');
    assert.ok(await rows.count() > 1999 + 1998);
    await page.close();
  });

  test('sends a line target to the code viewer of the same document', async () => {
    const seen: string[] = [];
    const page = await open(DIFF, '#L3', seen);
    await page.waitForURL(/source=1/);
    assert.ok(seen.includes('/view/big.diff?dt=t&source=1'), seen.join(' '));
    assert.match(page.url(), /#L3$/);
    await page.close();
  });

  test('past the line limit, says so and links to the plain text instead of rendering', async () => {
    const page = await open(added('many', 50_001));
    await page.waitForSelector('.note.large');
    assert.match(await page.locator('.note.large').textContent() ?? '', /^This diff has 50004 lines, more than the diff viewer shows \(50000\)\. Open it as plain text\.$/);
    assert.equal(await page.locator('.note.large a').getAttribute('href'), '?raw=1');
    assert.equal(await page.locator('tr, button').count(), 0);
    await page.close();
  });

  test('names the group of view buttons', async () => {
    const page = await open(DIFF);
    await page.waitForSelector('details.file');
    assert.equal(await page.getByRole('group', {name: 'view'}).getByRole('button').count(), 2);
    await page.close();
  });
});
