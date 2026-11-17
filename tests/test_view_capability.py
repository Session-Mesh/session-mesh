# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""/view capability scheme.

A /view URL is ``/view/v2.<mode>.<exp>.<mac>/<absolute path>``: mode ``f`` grants
exactly one file, mode ``d`` a bounded, non-dot directory scope; both expire.
URLs come from POST /api/view (``signed_url``); only the tamper tests build
capabilities by hand.
"""

import hashlib
import hmac
from pathlib import Path

import pytest

import server
import view

EXPIRED_TEXT = "Link expired"


def make_doc(directory, relpath, content="x"):
    path = directory / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def capability(url):
    """The capability segment of a /view URL."""
    return url.split("/")[2]


def mode_of(url):
    return capability(url).split(".")[1]


def swap_path(url, signed_doc, other_path):
    return url[: -len(str(signed_doc))] + str(other_path)


def with_capability(url, cap):
    parts = url.split("/")
    parts[2] = cap
    return "/".join(parts)


async def status(client, url):
    resp = await client.get(url)
    await resp.read()
    return resp.status


@pytest.fixture
def frozen_clock(monkeypatch):
    clock = {"now": 1_900_000_000.0}
    monkeypatch.setattr(view, "_now", lambda: clock["now"])
    return clock


# ---------------------------------------------------------------- modes and scope

async def test_readme_in_a_project_is_issued_in_directory_mode(client, signed_url, home_dir):
    readme = make_doc(home_dir, "proj/README.md", "# proj")
    url = await signed_url(readme)
    assert mode_of(url) == "d"
    assert await status(client, url) == 200


async def test_directory_scope_reaches_two_levels_not_three(client, signed_url, home_dir):
    readme = make_doc(home_dir, "proj/README.md")
    url = await signed_url(readme)
    for rel, expected in [("img/a.png", 200), ("a/b/c.png", 200), ("a/b/c/d.png", 403)]:
        target = make_doc(home_dir / "proj", rel)
        assert await status(client, swap_path(url, readme, target)) == expected, rel


async def test_directory_scope_skips_dot_entries(client, signed_url, home_dir):
    readme = make_doc(home_dir, "proj/README.md")
    url = await signed_url(readme)
    for rel in ("sub/.env", ".git/config", ".env"):
        target = make_doc(home_dir / "proj", rel, "SECRET=1")
        resp = await client.get(swap_path(url, readme, target))
        assert resp.status == 403, rel
        assert "SECRET" not in await resp.text()


async def test_document_directly_in_home_is_file_mode(client, signed_url):
    home = Path.home()
    doc = make_doc(home, "evil-cap.md", "# hi")
    other = make_doc(home, "other-cap.md", "# other")
    try:
        url = await signed_url(doc)
        assert mode_of(url) == "f"
        assert await status(client, url) == 200
        assert await status(client, swap_path(url, doc, server.TOKEN_FILE)) == 403
        assert await status(client, swap_path(url, doc, other)) == 403
    finally:
        doc.unlink()
        other.unlink()


async def test_document_directly_in_tmp_is_file_mode(client, signed_url):
    doc = make_doc(Path("/tmp"), "smesh-cap-x.html", "<p>x</p>")
    image = make_doc(Path("/tmp"), "smesh-cap-y.png", "png")
    try:
        url = await signed_url(doc)
        assert mode_of(url) == "f"
        assert await status(client, url) == 200
        assert await status(client, swap_path(url, doc, image)) == 403
    finally:
        doc.unlink()
        image.unlink()


async def test_dot_directory_anchor_is_file_mode(client, signed_url):
    plans = Path.home() / ".claude" / "plans"
    plan = make_doc(plans, "p.md", "# p")
    sibling = make_doc(plans, "q.md", "# q")
    url = await signed_url(plan)
    assert mode_of(url) == "f"
    assert await status(client, url) == 200
    assert await status(client, swap_path(url, plan, sibling)) == 403


async def test_document_inside_a_hidden_project_directory_is_file_mode(signed_url, home_dir):
    doc = make_doc(home_dir, "proj/.hidden/doc.html", "<p>x</p>")
    assert mode_of(await signed_url(doc)) == "f"


async def test_inert_document_is_file_mode(signed_url, home_dir):
    pdf = make_doc(home_dir, "proj/doc.pdf", "%PDF")
    assert mode_of(await signed_url(pdf)) == "f"


@pytest.mark.parametrize("relpath", [".config/session-mesh/token", ".ssh/k", ".gnupg/k"])
async def test_protected_directories_are_never_signed(client, auth_bearer, relpath):
    target = Path.home() / relpath
    if not target.exists():
        make_doc(Path.home(), relpath, "secret")
    resp = await client.post("/api/view", json={"target": str(target)}, headers=auth_bearer)
    assert resp.status == 403
    body = await resp.text()
    assert "/view/" not in body


# ---------------------------------------------------------------- expiry

async def test_capability_expires_after_the_ttl(client, signed_url, home_dir, frozen_clock):
    doc = make_doc(home_dir, "proj/page.html", "<p>x</p>")
    url = await signed_url(doc)
    exp = int(capability(url).split(".")[2])
    assert exp == int(frozen_clock["now"]) + view.VIEW_TTL == int(frozen_clock["now"]) + 12 * 3600
    frozen_clock["now"] = exp - 1
    assert await status(client, url) == 200
    frozen_clock["now"] = exp
    resp = await client.get(url)
    assert resp.status == 403
    assert EXPIRED_TEXT in await resp.text()


# ---------------------------------------------------------------- tampering

async def test_tampered_capabilities_are_403(client, signed_url, home_dir):
    doc = make_doc(home_dir, "proj/page.html", "<p>x</p>")
    other = make_doc(home_dir, "proj2/other.html", "<p>y</p>")  # another anchor
    url = await signed_url(doc)
    _, mode, exp, mac = capability(url).split(".")
    other_mac = capability(await signed_url(other)).split(".")[3]
    flipped = "f" if mode == "d" else "d"
    old_mac = hmac.new(server.TOKEN.encode(), f"view:{doc.parent}".encode(),
                       hashlib.sha256).hexdigest()[:32]
    for cap in (f"v2.{mode}.{int(exp) + 3600}.{mac}",
                f"v2.{flipped}.{exp}.{mac}",
                f"v2.{mode}.{exp}.{other_mac}",
                f"v2.{mode}.{exp}",
                f"v3.{mode}.{exp}.{mac}",
                f"v2.{mode}.-1.{mac}",
                f"v2.{mode}.0{exp}.{mac}",   # non-canonical expiry: same value, other text
                "",
                old_mac):
        assert await status(client, with_capability(url, cap)) == 403, cap


async def test_symlinks_out_of_the_scope_are_403(client, signed_url, home_dir):
    readme = make_doc(home_dir, "proj/README.md")
    url = await signed_url(readme)
    link = home_dir / "proj" / "t"
    link.symlink_to(server.TOKEN_FILE)
    elsewhere = make_doc(home_dir, "elsewhere/x.html", "<p>x</p>")
    (home_dir / "proj" / "out").symlink_to(elsewhere.parent)
    assert await status(client, swap_path(url, readme, link)) == 403
    assert await status(client, swap_path(url, readme, home_dir / "proj" / "out" / "x.html")) == 403


async def test_parent_of_the_anchor_is_out_of_scope(client, signed_url, home_dir):
    page = make_doc(home_dir, "proj/docs/page.html")
    style = make_doc(home_dir, "proj/style.css", "body{}")
    assert await status(client, swap_path(await signed_url(page), page, style)) == 403


async def test_symlinked_home_root_is_still_a_root(client, signed_url, home_dir, monkeypatch):
    link = home_dir.parent / f"{home_dir.name}-link"
    link.symlink_to(home_dir)
    try:
        monkeypatch.setattr(view, "VIEW_ROOTS", (link, Path("/tmp")))
        doc = make_doc(home_dir, "top.md", "# top")
        url = await signed_url(doc)
        assert mode_of(url) == "f"
        assert await status(client, url) == 200
    finally:
        link.unlink()


# ---------------------------------------------------------------- contracts

async def test_mesh_open_contract(client, auth_bearer, home_dir):
    doc = make_doc(home_dir, "proj/report.html", "<p>report</p>")
    resp = await client.post("/api/open", json={"target": str(doc)}, headers=auth_bearer)
    assert resp.status == 200
    data = await resp.json()
    assert data["target"] == str(doc)
    assert await status(client, data["url"]) == 200


async def test_directory_target_resolves_to_index(client, signed_url, home_dir):
    index = make_doc(home_dir, "site/index.html", "<p>index</p>")
    resp = await client.post("/api/view", json={"target": str(index.parent)},
                             headers={"Authorization": f"Bearer {server.TOKEN}"})
    data = await resp.json()
    assert data["target"] == str(index)
    assert await status(client, data["url"]) == 200


def test_signing_without_a_key_fails_closed(monkeypatch):
    monkeypatch.setattr(view, "VIEW_KEY", b"")
    with pytest.raises(RuntimeError):
        view.view_url(Path.home() / "x" / "page.html")
