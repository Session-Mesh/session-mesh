# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A Markdown document never runs its own script (X1-X12).

Each payload tries to change document.title, which the renderer sets to the
file name, and to reach the sink. Audit probe 2 (X1) ran before this fix.
"""

import pytest

import docs

PWNED = "document.title='pwned'"

CSP_LOG = """
document.addEventListener("securitypolicyviolation", (e) => {
  (window.__csp = window.__csp || []).push(`${e.effectiveDirective} ${e.blockedURI}`);
});
"""


async def render(page, mesh, home_dir, name, text):
    doc = docs.write(home_dir, f"md/{name}.md", text)
    await page.add_init_script(CSP_LOG)
    await page.goto(await mesh.url(doc))
    await page.wait_for_function("document.getElementById('doc').childElementCount > 0")
    return f"{name}.md"


async def assert_inert(page, sink, title):
    await sink.assert_untouched()
    assert await page.title() == title
    assert page.dialogs == []


async def test_x1_img_onerror(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x1",
                         f"<img src=x onerror=\"{PWNED};new Image().src='{sink.origin}/x1'\">")
    await assert_inert(page, sink, title)
    assert await page.locator("#doc img[onerror]").count() == 0


async def test_x2_inline_script(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x2", f"hi\n\n<script>{PWNED}</script>\n")
    await assert_inert(page, sink, title)
    assert await page.locator("#doc script").count() == 0


async def test_x3_javascript_link(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x3", f"[clique](javascript:{PWNED})\n")
    link = page.locator("#doc a")
    assert await link.get_attribute("href") is None
    await link.click()
    await assert_inert(page, sink, title)


async def test_x4_meta_refresh(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x4",
                         f'<meta http-equiv="refresh" content="0;url={sink.origin}/x4">\n\nhi\n')
    url = page.url
    await assert_inert(page, sink, title)
    assert page.url == url
    assert await page.locator("#doc meta").count() == 0


async def test_x5_form(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x5",
                         f'<form action="{sink.origin}/x5"><input name="a"><button>ok</button></form>\n')
    await assert_inert(page, sink, title)
    assert await page.locator("#doc form").count() == 0


async def test_x6_iframe(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x6", f'hi\n\n<iframe src="{sink.origin}/x6"></iframe>\n')
    await assert_inert(page, sink, title)
    assert await page.locator("#doc iframe").count() == 0


async def test_x7_code_fence_language_attribute(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x7",
                         f"```x\"onmouseover=\"{PWNED}\"\nprint(1)\n```\n")
    assert await page.locator("#doc [onmouseover]").count() == 0
    await page.locator("#doc pre code").hover()
    await assert_inert(page, sink, title)


async def test_x8_svg_onload_and_svg_script(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x8",
                         f'<svg onload="{PWNED}"></svg>\n\n<svg><script>{PWNED}</script></svg>\n')
    await assert_inert(page, sink, title)
    assert await page.locator("#doc [onload]").count() == 0
    assert await page.locator("#doc script").count() == 0


async def test_x9_style_overlay(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x9",
                         '<div id="o" style="position:fixed;inset:0;background:red">faux mesh</div>\n')
    await assert_inert(page, sink, title)
    assert await page.locator("#doc [style]").count() == 0


async def test_x10_mermaid_click_and_html_label(page, mesh, sink, home_dir):
    text = ("```mermaid\ngraph TD\n"
            f"  A[\"<img src=x onerror={PWNED}>\"] --> B\n"
            f"  click B href \"javascript:{PWNED}\"\n```\n")
    title = await render(page, mesh, home_dir, "x10", text)
    await page.wait_for_selector("pre.mermaid svg, pre.mermaid .err", timeout=15000)
    nodes = page.locator("pre.mermaid svg .node")
    for index in range(await nodes.count()):
        await nodes.nth(index).click(force=True)
    await assert_inert(page, sink, title)


async def test_x11_remote_image_is_not_loaded(page, mesh, sink, home_dir):
    title = await render(page, mesh, home_dir, "x11", f"![badge]({sink.origin}/badge.svg)\n")
    await assert_inert(page, sink, title)


async def test_x12_renderer_scripts_raise_no_csp_violation(page, mesh, sink, home_dir):
    doc = docs.readme(home_dir)
    await page.add_init_script(CSP_LOG)
    await page.goto(await mesh.url(doc))
    await page.wait_for_selector("pre.mermaid svg", timeout=15000)
    assert await page.locator("code.hljs .hljs-keyword").count() > 0
    violations = await page.evaluate("window.__csp || []")
    assert [v for v in violations if v.startswith(("script-src", "eval"))] == [], violations


@pytest.mark.parametrize("link", ["https://example.org/x"])
async def test_external_links_get_noopener_noreferrer(page, mesh, home_dir, link):
    await render(page, mesh, home_dir, "links", f"[ext]({link})\n")
    assert await page.locator("#doc a").get_attribute("rel") == "noopener noreferrer"
