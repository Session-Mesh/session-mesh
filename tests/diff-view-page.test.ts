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
import {chromium, type Browser} from 'playwright-core';

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

function render(name: string, text: string): Rendered {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-view-page-'));
  try {
    const code = `import sys, json
sys.path.insert(0, ${JSON.stringify(REPO)})
from pathlib import Path
import view
print(json.dumps({"page": view.diff_page(Path(${JSON.stringify(name)}), ${JSON.stringify(text)}, ${JSON.stringify(NONCE)}),
                  "csp": view.markdown_csp(${JSON.stringify(NONCE)}), "own": sorted(view.VIEWLIB_OWN),
                  "ext": sorted(view.DIFF_EXT), "served": str(view.STATIC)}))`;
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', code],
      {cwd: REPO, env: {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: path.join(home, 'conf')}, encoding: 'utf8'});
    return JSON.parse(output) as Rendered;
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
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

describe('the diff page in a browser', {skip: skipBrowser}, () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch({executablePath: CHROMIUM, args: ['--no-sandbox', '--mute-audio']}); });
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
});
