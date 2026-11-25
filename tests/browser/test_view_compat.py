# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Compatibility baseline (C1-C6): what users do with the panel today
must keep working under the hardened /view."""

import aiohttp
from conftest import ui

import docs
import server
import view


async def goto(page, url):
    response = await page.goto(url)
    assert response.status == 200, f"{url}: {response.status}"
    return response


async def assert_report_assets_load(page, mesh, home_dir):
    await goto(page, await mesh.url(docs.report(home_dir)))
    color = await page.eval_on_selector("#mark", "e => getComputedStyle(e).color")
    assert color == docs.STYLE_COLOR
    await page.wait_for_function("document.getElementById('logo').complete")
    assert await page.eval_on_selector("#logo", "e => e.naturalWidth") > 0


async def test_c1_report_relative_css_and_image_load(page, mesh, home_dir):
    await assert_report_assets_load(page, mesh, home_dir)


async def test_c2_report_inline_script_runs(page, mesh, home_dir):
    await goto(page, await mesh.url(docs.report(home_dir)))
    assert await page.evaluate("document.body.dataset.ran") == "1"


async def test_c3_markdown_renders_mermaid_highlight_image_table_tasks(page, mesh, home_dir):
    await goto(page, await mesh.url(docs.readme(home_dir)))
    await page.wait_for_selector("pre.mermaid svg", timeout=15000)
    assert await page.locator("code.hljs .hljs-keyword").count() > 0
    await page.wait_for_function("[...document.images].every((i) => i.complete)")
    assert await page.eval_on_selector("#doc img", "e => e.naturalWidth") > 0
    assert await page.locator("#doc table td").count() == 2
    assert await page.locator("#doc input[type=checkbox]").count() == 2


async def test_c4_image_top_level_and_pdf_unsandboxed(page, mesh, home_dir):
    image = docs.write(home_dir, "rep/pic.png", docs.png())
    await goto(page, await mesh.url(image))
    assert await page.evaluate("document.images[0].naturalWidth") > 0
    pdf = docs.write(home_dir, "rep/doc.pdf", b"%PDF-1.4\n%%EOF\n")
    described = await mesh.describe(pdf)
    assert described["sandbox"] is None
    async with aiohttp.ClientSession() as session:
        async with session.get(mesh.origin + described["url"]) as resp:
            assert resp.status == 200
            assert resp.headers["Content-Type"] == "application/pdf"
            assert "Content-Security-Policy" not in resp.headers


async def open_mesh(page, mesh):
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("typeof openWeb === 'function' && panes.length > 0")


async def test_c5_mesh_frame_sandbox_follows_the_server(page, mesh, home_dir):
    md = docs.readme(home_dir)
    pdf = docs.write(home_dir, "rep/doc.pdf", b"%PDF-1.4\n%%EOF\n")
    await open_mesh(page, mesh)
    frame = page.locator("iframe.web:not([hidden])")

    await page.evaluate("(t) => openWeb(t)", str(md))
    await frame.wait_for()
    expected = (await mesh.describe(md))["sandbox"]
    assert await frame.get_attribute("sandbox") == expected

    # The initial iframe load invalidates menus captured against its loading view.
    await page.wait_for_function(
        "(target) => panes.some(pane => pane.id === 'web:' + target "
        "&& pane.identityLoad === 'frame-loaded')", arg=str(md))
    pane = page.locator("section.pane", has=frame)
    await pane.locator('[data-act="more"]').click()
    async with page.expect_response(
        lambda r: r.request.method == "POST" and r.url.endswith("/api/view")
    ) as described:
        await pane.get_by_role("menuitem", name=ui("paneActions.action.reload")).click()
    assert (await described.value).ok, "reload did not successfully re-describe the document"

    await page.evaluate("(t) => openWeb(t)", str(pdf))
    await page.wait_for_function("document.querySelector('iframe.web:not([hidden])')"
                                 "&& new URL(document.querySelector('iframe.web:not([hidden])').src)"
                                 ".pathname.endsWith('/doc.pdf')")
    assert await frame.get_attribute("sandbox") is None


async def test_c6_self_matches_the_server_inside_the_sandbox(page, mesh, home_dir, monkeypatch):
    strict = f"sandbox {view.SANDBOX_DOC}; default-src 'none'; img-src 'self'; style-src 'self'"
    monkeypatch.setattr(view, "active_csp", lambda: strict)
    await assert_report_assets_load(page, mesh, home_dir)
