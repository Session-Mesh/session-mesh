# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The view policy table is the single source of truth.

The panel frame's sandbox comes from /api/view; the /view response's CSP is
built from the same table; static/app.js holds no flag or extension literal.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

import demo_scene
import view

REPO = Path(__file__).resolve().parent.parent
ACTIVE = ["page.html", "page.htm", "image.svg", "notes.txt", "readme.md"]
INERT = ["file.pdf", "image.png", "photo.jpg", "photo.jpeg", "anim.gif", "pic.webp"]


async def describe(client, auth_bearer, target):
    resp = await client.post("/api/view", json={"target": str(target)}, headers=auth_bearer)
    assert resp.status == 200, await resp.text()
    return await resp.json()


@pytest.mark.parametrize("name", ACTIVE)
async def test_active_documents_get_the_document_sandbox(client, auth_bearer, home_dir, name):
    doc = home_dir / name
    doc.write_text("x")
    assert (await describe(client, auth_bearer, doc))["sandbox"] == view.SANDBOX_DOC


@pytest.mark.parametrize("name", INERT)
async def test_inert_documents_get_no_sandbox(client, auth_bearer, home_dir, name):
    doc = home_dir / name
    doc.write_text("x")
    assert (await describe(client, auth_bearer, doc))["sandbox"] is None


@pytest.mark.parametrize("name", ACTIVE + INERT)
async def test_csp_header_follows_the_described_sandbox(client, auth_bearer, home_dir, name):
    doc = home_dir / name
    doc.write_text("x")
    data = await describe(client, auth_bearer, doc)
    resp = await client.get(data["url"])
    assert resp.status == 200
    csp = resp.headers.get("Content-Security-Policy")
    if data["sandbox"] is None:
        assert csp is None
    else:
        assert csp.split(";")[0] == "sandbox " + data["sandbox"]


def test_app_js_holds_no_sandbox_flags_or_inert_extensions():
    source = (REPO / "static" / "app.js").read_text()
    assert "allow-" not in source
    literals = re.findall(r"""["'`]\.(?:pdf|png|jpe?g|gif|webp)["'`]""", source)
    assert literals == []


def test_demo_frame_policy_is_the_single_source_for_its_csp():
    for scene in (
        {"format": "mesh-scene-v0"},
        {"format": "mesh-scene-v1"},
    ):
        sandbox = demo_scene.frame_sandbox(scene)
        directive = next(part.strip() for part in demo_scene.csp_for(scene).split(";")
                         if part.strip().startswith("sandbox"))
        assert directive == "sandbox" + (f" {sandbox}" if sandbox else "")


@pytest.mark.skipif(not (shutil.which("node") or Path("/opt/node22/bin/node").exists()),
                    reason="node not installed")
def test_app_js_parses():
    node = shutil.which("node") or "/opt/node22/bin/node"
    result = subprocess.run([node, "--check", str(REPO / "static" / "app.js")],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


# ---------------------------------------------------------------- step 4: no data out

ACTIVE_DIRECTIVES = [
    "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' data: blob:",
    "frame-src 'self'", "connect-src 'none'", "form-action 'none'", "worker-src 'none'",
    "object-src 'none'", "base-uri 'none'", "manifest-src 'none'",
]


def directives(csp):
    return [part.strip() for part in csp.split(";")]


def test_local_documents_lose_forms_modals_and_popups():
    assert view.SANDBOX_DOC == "allow-scripts allow-downloads"


# notes.txt is now a code page (stricter: scripts by nonce, test_codeview.py);
# data.bin stands for any other non-inert type served as an active document
@pytest.mark.parametrize("name,query", [("page.html", ""), ("image.svg", ""), ("data.bin", ""),
                                        ("readme.md", "?raw=1")])
async def test_active_csp_has_every_directive(client, signed_url, home_dir, name, query):
    doc = home_dir / name
    doc.write_text("x")
    resp = await client.get(await signed_url(doc) + query)
    assert resp.status == 200
    found = directives(resp.headers["Content-Security-Policy"])
    assert found[0] == "sandbox " + view.SANDBOX_DOC
    for directive in ACTIVE_DIRECTIVES:
        assert directive in found, directive


@pytest.mark.parametrize("name", ["page.html", "readme.md", "file.pdf", "image.png"])
async def test_every_view_response_sets_no_referrer(client, signed_url, home_dir, name):
    doc = home_dir / name
    doc.write_text("x")
    resp = await client.get(await signed_url(doc))
    assert resp.status == 200
    assert resp.headers["Referrer-Policy"] == "no-referrer"
    assert "Cross-Origin-Resource-Policy" not in resp.headers
