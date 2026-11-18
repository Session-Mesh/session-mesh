# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The ordinary local entry of the Mesh, served by a minimal local fixture."""

import asyncio
import json
import os
from pathlib import Path
import select
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
pytestmark = [pytest.mark.browser, pytest.mark.skipif(
    not os.environ.get("MESH_CHROMIUM"), reason="explicit muted Chromium required")]


LOCAL_SERVER = r"""
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const [root] = process.argv.slice(2);
const assets = new Set(['index.html', 'style.css', 'themes.css', 'themes.js', 'vendor/xterm.css',
  'vendor/xterm.min.js', 'vendor/addon-fit.min.js',
  'folder-state.js', 'history-state.js', 'session-activity.js', 'demo-catalog.js',
  'pane-actions.js', 'workspace-spec.js', 'terminal-links.js', 'shortcuts.js', 'app.js', 'local-entry.js', 'i18n.js', 'i18n/languages.json', 'i18n/en.json',
  'i18n/fr.json', 'i18n/server-messages.json']);
const local = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/api/sessions') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({mesh: [], external: [], management: {state: 'observed'}})); return;
  }
  if (path === '/api/dirs') { response.setHeader('Content-Type', 'application/json'); response.end('[]'); return; }
  if (path === '/api/logout') { response.end('{}'); return; }
  if (path === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end('/* isolated local fixture */'); return; }
  if (path === '/login') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Local login</title>'); return; }
  const name = path === '/' ? 'index.html' : path.startsWith('/static/') ? path.slice(8) : '';
  if (!assets.has(name)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8'
    : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/javascript');
  response.end(readFileSync(join(root, 'static', name)));
});
await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({local: `http://127.0.0.1:${local.address().port}/`}));
process.on('SIGTERM', () => { local.close(); });
"""


@pytest.fixture(scope="module")
def mesh_context_servers():
    process = subprocess.Popen(
        ["node", "--input-type=module", "-", str(ROOT)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        process.stdin.write(LOCAL_SERVER)
        process.stdin.close()
        ready, _, _ = select.select([process.stdout], [], [], 20)
        assert ready, "local Mesh fixture server did not become ready"
        line = process.stdout.readline()
        assert line, process.stderr.read()
        yield json.loads(line)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.asyncio
async def test_ordinary_index_explicitly_starts_local(mesh_context_servers):
    from playwright.async_api import async_playwright, expect

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ["MESH_CHROMIUM"],
                                           headless=True, args=["--mute-audio"])
        try:
            page = await browser.new_page()
            await page.add_init_script("""
localStorage.setItem('mesh.font','18');
localStorage.setItem('mesh.side','410');
localStorage.setItem('mesh.treeHidden','true');
""")
            requests, errors = [], []
            page.on("request", lambda request: requests.append(request.url))
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(mesh_context_servers["local"])
            await page.wait_for_function("() => (panes.length === 1)")
            assert await page.evaluate("fontSize") == 18
            assert await page.evaluate("tree.hidden") is True
            assert await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--side').trim()") == "410px"
            assert sum(url.endswith("/api/sessions") for url in requests) == 1
            await expect(page.locator("#btn-new")).to_be_enabled()
            await page.locator("#btn-new").click()
            await expect(page.locator("#dlg-new")).to_be_visible()
            await page.locator("#dlg-new [data-close-dialog]").click()
            await expect(page.locator("#dlg-new")).not_to_be_visible()
            await page.locator("#btn-logout").evaluate("button => button.click()")
            await page.wait_for_url("**/login")
            assert any(url.endswith("/api/dirs") for url in requests)
            assert sum(url.endswith("/api/logout") for url in requests) == 1
            assert errors == []
        finally:
            await browser.close()


@pytest.mark.asyncio
async def test_disposed_local_logout_does_not_navigate(mesh_context_servers):
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ["MESH_CHROMIUM"],
                                           headless=True, args=["--mute-audio"])
        try:
            page = await browser.new_page()
            entered, release = asyncio.Event(), asyncio.Event()
            logout_requests = []

            async def hold_logout(route):
                logout_requests.append(route.request.url)
                entered.set()
                await release.wait()
                await route.fulfill(json={})

            await page.route("**/api/logout", hold_logout)
            await page.goto(mesh_context_servers["local"])
            await page.evaluate("localMesh.then(()=>undefined)")
            async with page.expect_response("**/api/logout") as response_info:
                await page.locator("#btn-logout").evaluate("button=>button.click()")
                await asyncio.wait_for(entered.wait(), timeout=5)
                await page.evaluate("localMesh.then(control=>control.dispose())")
                release.set()
            response = await response_info.value
            await response.finished()
            await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
            assert len(logout_requests) == 1  # already-issued logout is not undone or replayed
            assert page.url == mesh_context_servers["local"]
            assert await page.evaluate("localMeshEffectsAllowed()") is False
            # a stopped mesh leaves only "close" in a pane menu (no newtab, no reload)
            for kind in ("mesh", "web", "board"):
                ids = await page.evaluate("kind=>paneMenuActions({actionKind:kind}).map(action=>action.id)", kind)
                assert set(ids) <= {"close"}, (kind, ids)
        finally:
            await browser.close()


@pytest.mark.asyncio
async def test_compiled_inventory_cadence_preserves_local_initial_and_explicit(mesh_context_servers):
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ["MESH_CHROMIUM"],
                                           headless=True, args=["--mute-audio", "--disable-gpu"])
        try:
            local = await browser.new_page()
            await local.clock.install(time=1_000_000)
            await local.clock.pause_at(1_001_000)
            await local.add_init_script("""globalThis.inventoryHttpCalls=0;
const actualFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,...options)=>{if(typeof input==='string'&&new URL(input,location.href).pathname==='/api/sessions')inventoryHttpCalls++;return actualFetch(input,...options);};""")
            await local.goto(mesh_context_servers["local"])
            await local.evaluate("localMesh")
            assert await local.evaluate("inventoryHttpCalls") == 1
            await local.clock.run_for(3999)
            assert await local.evaluate("inventoryHttpCalls") == 1
            await local.clock.run_for(1)
            assert await local.evaluate("inventoryHttpCalls") == 2
            await local.evaluate("localMesh.then(control=>control.refresh())")
            assert await local.evaluate("inventoryHttpCalls") == 3
        finally:
            await browser.close()
