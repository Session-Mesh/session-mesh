# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Source files in the panel: Monaco page, raw/binary fallbacks, library route."""

import codeview


async def fetch(client, url):
    resp = await client.get(url)
    return resp, await resp.read()


async def test_a_source_file_gets_the_monaco_page(client, home_dir, signed_url):
    doc = home_dir / "app.py"
    doc.write_text("def f():\n    return '</script><!--'\n")
    resp, body = await fetch(client, await signed_url(doc))
    assert resp.status == 200 and resp.content_type == "text/html"
    page = body.decode()
    assert '"python"' in page or "language: \"python\"" in page
    # the text is embedded as JSON that cannot close the script element
    assert "</script><!--" not in page.split('id="src"')[1].split("</script>")[0]
    csp = resp.headers["Content-Security-Policy"]
    assert "sandbox allow-scripts" in csp and "'strict-dynamic'" not in csp
    assert "connect-src 'none'" in csp and "worker-src 'none'" in csp
    assert "allow-same-origin" not in csp


async def test_raw_query_serves_plain_text(client, home_dir, signed_url):
    doc = home_dir / "x.ml"
    doc.write_text("let x = 1\n")
    resp, body = await fetch(client, await signed_url(doc) + "?raw=1")
    assert resp.content_type == "text/plain" and body == b"let x = 1\n"


async def test_binary_content_is_shown_as_text_not_downloaded(client, home_dir, signed_url):
    doc = home_dir / "blob.c"
    doc.write_bytes(b"\x00\x01\x02int")
    resp, body = await fetch(client, await signed_url(doc))
    assert resp.content_type == "text/plain" and body == b"\x00\x01\x02int"
    assert "sandbox" in resp.headers["Content-Security-Policy"]


async def test_large_files_are_served_whole(client, home_dir, signed_url):
    import codeview
    doc = home_dir / "big.log"
    doc.write_bytes(b"x" * (codeview.MAX_BYTES + 10) + b"TAIL_MARKER")
    url = await signed_url(doc)
    for suffix in ("", "?raw=1"):
        resp, body = await fetch(client, url + suffix)
        assert resp.content_type == "text/plain" and body.endswith(b"TAIL_MARKER")


async def test_large_markdown_is_plain_text(client, home_dir, signed_url):
    import view
    doc = home_dir / "big.md"
    doc.write_bytes(b"# x\n" + b"y" * (view.MD_MAX_BYTES + 10))
    resp, _ = await fetch(client, await signed_url(doc))
    assert resp.content_type == "text/plain"


async def test_language_detection():
    from pathlib import Path
    assert codeview.language_for(Path("a/Dockerfile")) == "dockerfile"
    assert codeview.language_for(Path("x.TS")) == "typescript"
    assert codeview.language_for(Path("x.unknownext")) is None


async def test_monaco_library_is_served_without_cookie(client):
    resp = await client.get("/viewlib/monaco/vs/loader.js")
    assert resp.status == 200


async def test_monaco_route_cannot_leave_its_directory(client):
    from yarl import URL
    for path in ("/viewlib/monaco/../../server.py", "/viewlib/monaco/vs/../../../view.py",
                 "/viewlib/monaco/%2e%2e/%2e%2e/server.py", "/viewlib/monaco/..%2f..%2fserver.py"):
        resp = await client.get(URL(path, encoded=True), allow_redirects=False)
        body = await resp.read()
        assert b"make_app" not in body and b"def view" not in body, path
        assert resp.status in (302, 401, 403, 404), (path, resp.status)


async def test_page_size_stays_close_to_the_file(client, home_dir, signed_url):
    doc = home_dir / "bad.py"
    doc.write_bytes(b"\xff" * 100_000)
    resp, body = await fetch(client, await signed_url(doc))
    assert resp.content_type == "text/html" and len(body) < 400_000   # was ~600 KB


async def test_line_separators_are_escaped(client, home_dir, signed_url):
    doc = home_dir / "ls.py"
    doc.write_text("a = '  '\n")
    _, body = await fetch(client, await signed_url(doc))
    assert " ".encode() not in body and b"\\u2028" in body


async def test_monaco_urls_carry_the_vendored_version(client, home_dir, signed_url):
    import codeview
    assert codeview.MONACO_VERSION == "0.52.2"
    doc = home_dir / "v.py"
    doc.write_text("x = 1\n")
    _, body = await fetch(client, await signed_url(doc))
    assert b"loader.js?v=0.52.2" in body and b'urlArgs: "v=0.52.2"' in body


def test_code_and_markdown_keep_their_scroll(home_dir):
    import view
    for name, expected in (("a.py", True), ("a.md", True), ("a.html", False), ("a.pdf", False)):
        doc = home_dir / name
        doc.write_text("x")
        assert view.describe_target(str(doc))["keeps_scroll"] is expected, name
