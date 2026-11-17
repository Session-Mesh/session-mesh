# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The rendered Markdown page.

Its scripts run only by nonce, the page is assembled in a single pass, and the
vendored DOMPurify matches the hash recorded in THIRD_PARTY.md.
"""

import hashlib
import json
import re
from pathlib import Path

import pytest

import view

REPO = Path(__file__).resolve().parent.parent
SCRIPT_TAG = re.compile(r"<script\b[^>]*>", re.I)


def script_src(csp):
    return next(part.strip() for part in csp.split(";") if part.strip().startswith("script-src"))


def source_block(body):
    match = re.search(r'<script type="application/json" id="src">(.*?)</script>', body, re.S)
    return match[1]


async def render(client, signed_url, doc):
    resp = await client.get(await signed_url(doc))
    assert resp.status == 200
    return resp.headers["Content-Security-Policy"], await resp.text()


async def test_markdown_scripts_run_by_nonce_only(client, signed_url, home_dir):
    doc = home_dir / "readme.md"
    doc.write_text("# hi\n")
    csp, body = await render(client, signed_url, doc)
    match = re.fullmatch(r"script-src 'nonce-([A-Za-z0-9_-]{16,})'", script_src(csp))
    assert match, csp
    nonce = match[1]
    assert "'unsafe-inline'" not in script_src(csp)
    executable = [tag for tag in SCRIPT_TAG.findall(body) if "application/json" not in tag]
    assert len(executable) >= 5      # marked, highlight, mermaid, purify, the renderer
    assert all(f'nonce="{nonce}"' in tag for tag in executable), executable
    csp_again, _ = await render(client, signed_url, doc)
    assert script_src(csp_again) != script_src(csp)


async def test_markdown_csp_keeps_data_in(client, signed_url, home_dir):
    doc = home_dir / "readme.md"
    doc.write_text("# hi\n")
    csp, _ = await render(client, signed_url, doc)
    parts = [part.strip() for part in csp.split(";")]
    assert parts[0] == "sandbox " + view.SANDBOX_DOC
    for directive in ("default-src 'none'", "img-src 'self' data: blob:", "connect-src 'none'",
                      "form-action 'none'", "frame-src 'none'", "base-uri 'none'",
                      "object-src 'none'", "worker-src 'none'"):
        assert directive in parts, directive


async def test_placeholders_are_substituted_once(client, signed_url, home_dir):
    doc = home_dir / "{{src}}.md"
    text = "{{nonce}} {{title}} {{src}}\n"
    doc.write_text(text)
    csp, body = await render(client, signed_url, doc)
    nonce = re.search(r"'nonce-([^']+)'", csp)[1]
    assert body.count('id="src"') == 1
    block = source_block(body)
    assert nonce not in block
    assert json.loads(block) == text
    assert "<title>{{src}}.md</title>" in body


async def test_html_comment_opener_cannot_swallow_the_page(client, signed_url, home_dir):
    # "<!--<script" inside script data would switch the parser to the double-escaped
    # state and run the source block into the renderer's own <script> tags
    doc = home_dir / "comment.md"
    text = "<!--<script>\n# after\n"
    doc.write_text(text)
    _, body = await render(client, signed_url, doc)
    block = source_block(body)
    assert "<!--" not in block
    assert json.loads(block) == text


def recorded_purify_sha256():
    notes = (REPO / "static" / "vendor" / "THIRD_PARTY.md").read_text()
    section = notes[notes.index("## DOMPurify"):]
    return re.search(r"sha256 `([0-9a-f]{64})`", section)[1]


async def test_vendored_purify_matches_the_recorded_hash(client):
    resp = await client.get("/viewlib/purify.min.js")
    assert resp.status == 200
    assert hashlib.sha256(await resp.read()).hexdigest() == recorded_purify_sha256()


@pytest.mark.parametrize("name", ["purify.min.js"])
def test_purify_is_whitelisted(name):
    assert name in view.VIEWLIB
