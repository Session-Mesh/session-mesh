# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""/view signatures, scope, CSP and the viewlib whitelist (view.py).

Signed URLs are always obtained the way clients get them, through
POST /api/view with the Bearer token, never by calling the signing helpers:
the signature scheme is expected to change and these tests must
survive that. A URL is treated as an opaque prefix followed by the document's
absolute path, which is how relative links resolve next to a document.
"""

import asyncio
from pathlib import Path
import subprocess
import sys

import pytest
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

import server
import view
from helpers import expect_fixed

BAD_SIG = "0" * 32


def make_doc(directory, relpath, content):
    path = directory / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def swap_path(url, signed_doc, other_path):
    """The same signed prefix, pointing at another absolute path."""
    return url[: -len(str(signed_doc))] + str(other_path)


def raw_get(client, path, **kwargs):
    """GET a path verbatim: no client-side normalization of '..' segments.

    URL.join() and URL(path) both remove dot segments, which would make a
    traversal test vacuous; an encoded absolute URL is sent as written.
    """
    url = URL(f"http://{client.server.host}:{client.server.port}{path}", encoded=True)
    return client.session.get(url, allow_redirects=False, **kwargs)


# ---------------------------------------------------------------- signature and scope

async def test_valid_signature_serves_the_file_without_cookie(client, signed_url, home_dir):
    doc = make_doc(home_dir, "page.html", "<p>hello</p>")
    resp = await client.get(await signed_url(doc))
    assert resp.status == 200
    assert await resp.text() == "<p>hello</p>"


async def test_an_html_frame_gets_the_local_history_bridge_before_its_first_link(client, signed_url, home_dir):
    doc = make_doc(home_dir, "page.html", "<!-- provenance --><!doctype html><html lang='fr' data-note=\"a>b\"><head data-head='c>d'><title>x</title></head><body><a>hello</a></body>")
    resp = await client.get(await signed_url(doc), headers={"Sec-Fetch-Dest": "iframe"})
    assert resp.status == 200
    body = await resp.text()
    bridge = view.FRAME_HISTORY_BRIDGE.decode()
    assert body.index(bridge) < body.index("<a>hello</a>")
    assert body.startswith("<!-- provenance --><!doctype html><html lang='fr' data-note=\"a>b\"><head data-head='c>d'>" + bridge)
    assert body.endswith("<title>x</title></head><body><a>hello</a></body>")
    assert resp.headers["Content-Security-Policy"] == view.active_csp()


@pytest.mark.parametrize(("bom", "encoding"), [
    (b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be"),
    (b"\xff\xfe\x00\x00", "utf-32-le"), (b"\x00\x00\xfe\xff", "utf-32-be"),
])
async def test_html_frame_keeps_multibyte_bom_documents_unmodified(client, signed_url, home_dir, bom, encoding):
    source = "<!doctype html><html><head><title>encoded</title></head><body><p>hello</p></body></html>"
    expected = bom + source.encode(encoding)
    doc = home_dir / f"page-{encoding}.html"
    doc.write_bytes(expected)
    resp = await client.get(await signed_url(doc), headers={"Sec-Fetch-Dest": "iframe"})
    assert resp.status == 200
    body = await resp.read()
    assert body == expected
    assert view.FRAME_HISTORY_BRIDGE not in body


async def test_html_frame_keeps_utf8_bom_ahead_of_the_history_bridge(client, signed_url, home_dir):
    bom = b"\xef\xbb\xbf"
    doc = home_dir / "utf8-bom.html"
    doc.write_bytes(bom + b"<!-- provenance --><!doctype html><html data-note='ok'><head><title>x</title></head><body><a>hello</a></body>")
    resp = await client.get(await signed_url(doc), headers={"Sec-Fetch-Dest": "iframe"})
    assert resp.status == 200
    body = await resp.read()
    assert body.startswith(bom + b"<!-- provenance --><!doctype html><html data-note='ok'><head>" + view.FRAME_HISTORY_BRIDGE)
    assert body.index(view.FRAME_HISTORY_BRIDGE) < body.index(b"<a>hello</a>")


def test_malformed_html_prologue_scans_promptly_without_backtracking():
    # The prologue is scanned on the request event loop. A nested-quantifier
    # regex used to spend more than five seconds backtracking on this input.
    # Run the exact minimal case in a child process so a regression is bounded
    # rather than freezing the test worker itself.
    result = subprocess.run(
        [sys.executable, "-c", "import view; assert view._history_bridge_offset(b'<html ' + b'a' * 8192) == 0"],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, result.stderr


async def test_html_frame_range_keeps_the_descriptor_response(client, signed_url, home_dir):
    doc = make_doc(home_dir, "page.html", "<p>hello</p>")
    resp = await client.get(await signed_url(doc), headers={
        "Sec-Fetch-Dest": "iframe", "Range": "bytes=0-2"})
    assert resp.status == 206
    assert await resp.read() == b"<p>"


async def test_api_view_describes_the_document(client, auth_cookie, home_dir):
    doc = make_doc(home_dir, "page.html", "<p>hello</p>")
    resp = await client.post("/api/view", json={"target": str(doc)}, headers=auth_cookie)
    assert resp.status == 200
    data = await resp.json()
    assert {k: data[k] for k in ("kind", "target", "ext")} == {
        "kind": "file", "target": str(doc), "ext": ".html"}


def test_concurrent_document_and_config_refresh_across_app_loops(monkeypatch, home_dir):
    doc = make_doc(home_dir, "page.html", "<p>hello</p>")
    signature = [None]
    gate = [None]
    calls = []

    monkeypatch.setattr(server, "_accounts_signature", lambda: signature[0])

    async def accounts_program(*args):
        calls.append(args)
        if gate[0] is not None:
            entered, release = gate[0]
            entered.set()
            await release.wait()
        return {"accounts": [], "protected_roots": []}

    monkeypatch.setattr(server, "_accounts_program", accounts_program)

    async def run_app(number):
        client = TestClient(TestServer(server.make_app(
            session_request_path=home_dir / f"session-requests-{number}.sqlite3")))
        await client.start_server()
        try:
            entered, release, second_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
            gate[0] = entered, release
            signature[0] = ("ordinary-refresh", number)
            before = len(calls)
            describe = asyncio.create_task(client.post(
                "/api/view", json={"target": str(doc)},
                headers={"Authorization": f"Bearer {server.TOKEN}"}))
            await asyncio.wait_for(entered.wait(), 5)

            original = server.declared_accounts

            async def next_refresh():
                second_entered.set()
                await original()

            monkeypatch.setattr(server, "declared_accounts", next_refresh)
            config = asyncio.create_task(client.get(
                "/api/config", headers={"Cookie": f"{server.COOKIE}={server.cookie_value()}"}))
            await asyncio.wait_for(second_entered.wait(), 5)
            await asyncio.sleep(0)
            release.set()
            described, configured = await asyncio.wait_for(asyncio.gather(describe, config), 5)
            assert described.status == configured.status == 200
            assert (await described.json())["target"] == str(doc)
            await configured.read()
            assert len(calls) == before + 1
        finally:
            monkeypatch.setattr(server, "declared_accounts", original)
            gate[0] = None
            await client.close()

    asyncio.run(run_app(1))
    asyncio.run(run_app(2))


async def test_api_view_refuses_documents_outside_the_roots(client, auth_bearer):
    resp = await client.post("/api/view", json={"target": "/etc/passwd"}, headers=auth_bearer)
    assert resp.status == 403


async def test_wrong_signature_is_403(client, home_dir):
    doc = make_doc(home_dir, "page.html", "x")
    resp = await client.get(f"/view/{BAD_SIG}{doc}")
    assert resp.status == 403


async def test_signature_of_a_sibling_directory_is_403(client, signed_url, home_dir):
    page_a = make_doc(home_dir, "a/page.html", "a")
    other = make_doc(home_dir, "b/secret.txt", "b")
    resp = await client.get(swap_path(await signed_url(page_a), page_a, other))
    assert resp.status == 403


async def test_subdirectory_of_the_signed_directory_is_served(client, signed_url, home_dir):
    # documented behavior: relative subresources keep working (css, images, pages)
    page = make_doc(home_dir, "page.html", "p")
    image = make_doc(home_dir, "img/logo.svg", "<svg/>")
    resp = await client.get(swap_path(await signed_url(page), page, image))
    assert resp.status == 200


async def test_missing_file_in_scope_is_404(client, signed_url, home_dir):
    page = make_doc(home_dir, "page.html", "p")
    resp = await client.get(swap_path(await signed_url(page), page, home_dir / "nope.html"))
    assert resp.status == 404


async def test_path_outside_the_roots_is_refused_even_with_a_valid_signature(client, signed_url, home_dir):
    # the signature does not cover this path: the same 403 as any refusal (R14)
    page = make_doc(home_dir, "page.html", "p")
    resp = await client.get(swap_path(await signed_url(page), page, "/etc/passwd"))
    assert resp.status == 403
    assert "root:" not in await resp.text()


async def test_dotdot_out_of_the_roots_is_not_served(client, signed_url, home_dir):
    page = make_doc(home_dir, "page.html", "p")
    escape = "/.." * (len(home_dir.parts) + 2)
    target = swap_path(await signed_url(page), page, f"{home_dir}{escape}/etc/passwd")
    async with raw_get(client, target) as resp:
        assert resp.status in (403, 404)
        assert "root:" not in await resp.text()


async def test_dotdot_out_of_the_signed_directory_is_403(client, signed_url, home_dir):
    page = make_doc(home_dir, "docs/page.html", "p")
    make_doc(home_dir, "other/secret.txt", "SECRET")
    target = swap_path(await signed_url(page), page, f"{home_dir}/docs/../other/secret.txt")
    async with raw_get(client, target) as resp:
        assert resp.status == 403
        assert "SECRET" not in await resp.text()


# ---------------------------------------------------------------- headers

@pytest.mark.parametrize("name,sandboxed", [
    ("doc.html", True),
    ("doc.htm", True),
    ("image.svg", True),
    ("notes.txt", True),
    ("readme.md", True),
    ("file.pdf", False),
    ("image.png", False),
    ("photo.jpg", False),
])
async def test_csp_sandbox_on_active_types_only(client, signed_url, home_dir, name, sandboxed):
    doc = make_doc(home_dir, name, "content")
    resp = await client.get(await signed_url(doc))
    assert resp.status == 200
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    csp = resp.headers.get("Content-Security-Policy")
    if sandboxed:
        assert csp is not None and csp.startswith("sandbox ")
        assert "allow-same-origin" not in csp     # opaque origin: no cookie, no API
    else:
        assert csp is None


async def test_markdown_raw_is_plain_text(client, signed_url, home_dir):
    source = "# Title\n\n<script>alert(1)</script>\n"
    doc = make_doc(home_dir, "readme.md", source)
    resp = await client.get(await signed_url(doc), params={"raw": "1"})
    assert resp.status == 200
    assert resp.headers["Content-Type"].startswith("text/plain")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert await resp.text() == source


async def test_markdown_render_escapes_closing_script_tags(client, signed_url, home_dir):
    payload = "</script><script>alert(1)</script>"
    doc = make_doc(home_dir, "evil.md", f"# hi\n\n{payload}\n")
    resp = await client.get(await signed_url(doc))
    assert resp.status == 200
    assert resp.headers["Content-Type"].startswith("text/html")
    body = await resp.text()
    assert payload not in body
    assert "<\\/script><script>alert(1)<\\/script>" in body


async def test_markdown_title_is_html_escaped(client, signed_url, home_dir):
    doc = make_doc(home_dir, 'a<b>"c.md', "x")
    body = await (await client.get(await signed_url(doc))).text()
    assert "a&lt;b&gt;&quot;c.md" in body
    assert 'a<b>"c.md' not in body


# ---------------------------------------------------------------- viewlib

@pytest.mark.parametrize("name", sorted(view.VIEWLIB))
async def test_viewlib_serves_whitelisted_names(client, name):
    resp = await client.get(f"/viewlib/{name}")
    assert resp.status == 200


@pytest.mark.parametrize("name", ["xterm.min.js", "addon-fit.min.js", "THIRD_PARTY.md",
                                  "nope.js", "..%2F..%2Fserver.py"])
async def test_viewlib_rejects_other_names(client, name):
    async with raw_get(client, f"/viewlib/{name}") as resp:
        assert resp.status == 404


# ---------------------------------------------------------------- regressions (signature scheme, fixed)
#
# These were strict xfails while H1 was open; they now pass unmarked. A
# KnownDefect raised here means the H1 leak is back.

async def test_home_signature_does_not_serve_the_token(client, signed_url):
    home = Path.home()
    token_file = home / ".config" / "session-mesh" / "token"
    token = token_file.read_text().strip()
    doc = make_doc(home, "evil.md", "# hi")
    try:
        resp = await client.get(swap_path(await signed_url(doc), doc, token_file))
        body = await resp.text()
        expect_fixed(resp.status != 200 and token not in body,
                     f"token served with status {resp.status}")
    finally:
        doc.unlink()


async def test_readme_signature_does_not_serve_dotenv(client, signed_url, home_dir):
    readme = make_doc(home_dir, "proj/README.md", "# proj")
    dotenv = make_doc(home_dir, "proj/sub/.env", "SECRET=1\n")
    resp = await client.get(swap_path(await signed_url(readme), readme, dotenv))
    body = await resp.text()
    expect_fixed(resp.status != 200 and "SECRET=1" not in body,
                 f".env served with status {resp.status}")
