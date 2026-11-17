# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Independent security review of /view (2026-10-01), findings 1, 2, 4, 5, 7, 8, 9.

Ported from the reviewer's probes: a directory's symlinked ``index.html``,
the capability mode per type, aiohttp's ``.gz``/``.br`` sibling negotiation,
the resolve/open race, percent-encoding of the path, and a NUL in the path.
"""

import gzip
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

import pytest
from yarl import URL

import view
TEST_HOME = Path.home()      # the throwaway home set up by conftest.py
FD_DIR = "/proc/self/fd" if sys.platform == "linux" else "/dev/fd"


def capability(url):
    return url.split("/")[2]


def mode_of(url):
    return capability(url).split(".")[1]


async def get(client, url, **kwargs):
    resp = await client.get(URL(url, encoded=True), **kwargs)
    return resp.status, await resp.read(), resp


@pytest.fixture
def ssh_key():
    ssh = TEST_HOME / ".ssh"
    ssh.mkdir(exist_ok=True)
    key = ssh / "id_rsa"
    key.write_text("PRIVATE-KEY")
    yield key
    key.unlink(missing_ok=True)


@pytest.fixture
def outside_secret():
    secret = TEST_HOME / "outside-secret.txt"
    secret.write_text("OUTSIDE")
    yield secret
    secret.unlink(missing_ok=True)


def _getpath_from_proc(fd, cmd, buffer):
    """F_GETPATH as macOS answers it: the name, NUL-padded to the buffer's size."""
    assert cmd == _FAKE_FCNTL.F_GETPATH
    return os.fsencode(os.readlink(f"/proc/self/fd/{fd}")).ljust(len(buffer), b"\0")


_FAKE_FCNTL = SimpleNamespace(F_GETPATH=50, fcntl=_getpath_from_proc)


@pytest.fixture(params=["native", "macos"])
def descriptor_platform(request, monkeypatch):
    """Runs a test on this platform, then on Linux through view's macOS branch:
    F_GETPATH answered from /proc, files served through /dev/fd."""
    if request.param == "macos":
        if sys.platform != "linux":
            pytest.skip("the native run already is the real platform branch")
        monkeypatch.setattr(view, "_PLATFORM", "darwin")
        monkeypatch.setattr(view, "fcntl", _FAKE_FCNTL)
    return request.param


async def describe(client, auth_bearer, target):
    resp = await client.post("/api/view", json={"target": str(target)}, headers=auth_bearer)
    return resp.status, (await resp.json() if resp.status == 200 else await resp.text())


# ---------------------------------------------------------------- finding 1: index.html symlink

async def test_directory_index_symlink_cannot_leave_the_signed_scope(
        client, signed_url, home_dir, ssh_key, outside_secret):
    proj = home_dir / "proj"
    (proj / "sub").mkdir(parents=True)
    (proj / "sub2").mkdir()
    page = proj / "page.html"
    page.write_text("<p>hi</p>")
    (proj / "sub" / "index.html").symlink_to(ssh_key)
    (proj / "sub2" / "index.html").symlink_to(outside_secret)
    url = await signed_url(page)
    assert mode_of(url) == "d"
    base = url.rsplit("/", 1)[0]
    for tail in ("/sub/index.html", "/sub", "/sub/", "/sub2", "/sub2/"):
        status, body, _ = await get(client, base + tail)
        assert status in (403, 404), (tail, status, body)
        assert b"PRIVATE-KEY" not in body and b"OUTSIDE" not in body


async def test_api_view_on_a_directory_whose_index_links_into_ssh_is_refused(
        client, auth_bearer, home_dir, ssh_key):
    directory = home_dir / "x"
    directory.mkdir()
    (directory / "index.html").symlink_to(ssh_key)
    status, _ = await describe(client, auth_bearer, directory)
    assert status == 403


async def test_api_view_on_a_directory_whose_index_leaves_the_roots_is_refused(
        client, auth_bearer, home_dir):
    # outside both view roots, always present
    outside = Path("/proc/self/status" if sys.platform == "linux" else "/etc/hosts")
    directory = home_dir / "y"
    directory.mkdir()
    (directory / "index.html").symlink_to(outside)
    status, _ = await describe(client, auth_bearer, directory)
    assert status == 403


async def test_directory_index_is_served_from_its_resolved_path(client, auth_bearer, home_dir):
    site = home_dir / "site"
    site.mkdir()
    real = site / "real.html"
    real.write_text("<p>real</p>")
    (site / "index.html").symlink_to(real)
    status, described = await describe(client, auth_bearer, site)
    assert status == 200
    assert described["target"] == str(real)
    status, body, _ = await get(client, described["url"])
    assert (status, body) == (200, b"<p>real</p>")


# ---------------------------------------------------------------- finding 2 / 9: mode per type

@pytest.mark.parametrize("name, expected", [
    ("page.html", "d"), ("page.HTM", "d"), ("pic.svg", "d"), ("README.md", "d"),
    ("notes.markdown", "d"), ("data.json", "f"), ("notes.txt", "f"), ("app.js", "f"),
    ("style.css", "f"), ("clip.mp4", "f"), ("doc.pdf", "f"), ("pic.png", "f"),
    ("Makefile", "f"),
])
async def test_directory_mode_only_for_types_that_load_relative_subresources(
        signed_url, home_dir, name, expected):
    doc = home_dir / "proj" / name
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text("x")
    assert mode_of(await signed_url(doc)) == expected


@pytest.mark.parametrize("name, expected", [("README.md", True), ("x.markdown", True),
                                            ("page.html", False), ("pic.svg", False),
                                            ("doc.pdf", False)])
async def test_only_rendered_markdown_may_ask_the_mesh_to_open_links(
        client, auth_bearer, home_dir, name, expected):
    doc = home_dir / name
    doc.write_text("x")
    status, described = await describe(client, auth_bearer, doc)
    assert status == 200
    assert described["opens_links"] is expected


@pytest.mark.parametrize("name, expected", [("README.md", True), ("x.markdown", True),
                                            ("page.html", True), ("page.htm", True),
                                            ("pic.svg", False), ("doc.pdf", False),
                                            ("notes.txt", False)])
async def test_only_markdown_and_local_html_may_ask_the_mesh_to_show_a_conversation(
        client, auth_bearer, home_dir, name, expected):
    doc = home_dir / name
    doc.write_text("x")
    status, described = await describe(client, auth_bearer, doc)
    assert status == 200
    assert described["opens_sessions"] is expected


def test_local_documents_cannot_open_popups():
    for flags in (view.SANDBOX_DOC, view.active_csp(), view.markdown_csp("n")):
        assert "allow-popups" not in flags


# ---------------------------------------------------------------- finding 4: no sibling negotiation

@pytest.mark.parametrize("suffix, encoding, packed", [
    (".gz", "gzip", gzip.compress(b"OTHER-FILE")), (".br", "br", b"OTHER-FILE")])
@pytest.mark.usefixtures("descriptor_platform")
async def test_only_the_signed_file_is_served_whatever_the_accept_encoding(
        client, signed_url, suffix, encoding, packed):
    doc = TEST_HOME / "notes.html"           # parent is a view root: mode f
    doc.write_text("<p>signed</p>")
    sibling = TEST_HOME / ("notes.html" + suffix)
    sibling.write_bytes(packed)
    try:
        url = await signed_url(doc)
        assert mode_of(url) == "f"
        status, body, resp = await get(client, url, headers={"Accept-Encoding": encoding},
                                       auto_decompress=False)
        assert status == 200
        assert body == b"<p>signed</p>"
        assert "Content-Encoding" not in resp.headers
    finally:
        doc.unlink()
        sibling.unlink()


# ---------------------------------------------------------------- finding 5: resolve / open race

def swap_after_authorize(monkeypatch, swap):
    """Runs the real checks, then ``swap``, then lets the open proceed: the
    race window between the checks and the open, hit deterministically."""
    authorize = view._authorize

    def authorize_then_swap(path, *args):
        protected = authorize(path, *args)
        swap()
        return protected

    monkeypatch.setattr(view, "_authorize", authorize_then_swap)


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_file_swapped_for_a_symlink_after_the_checks_is_not_served(
        client, signed_url, home_dir, ssh_key, monkeypatch):
    doc = home_dir / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>page</p>")
    url = await signed_url(doc)

    def swap():
        doc.unlink()
        doc.symlink_to(ssh_key)

    swap_after_authorize(monkeypatch, swap)
    status, body, _ = await get(client, url)
    assert status == 404
    assert b"PRIVATE-KEY" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_directory_swapped_for_a_symlink_after_the_checks_is_not_served(
        client, signed_url, home_dir, monkeypatch):
    proj = home_dir / "proj"
    (proj / "sub").mkdir(parents=True)
    doc = proj / "sub" / "page.html"
    doc.write_text("<p>page</p>")
    elsewhere = home_dir / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "page.html").write_text("ELSEWHERE")
    url = await signed_url(doc)

    def swap():
        (proj / "sub").rename(proj / "old")
        (proj / "sub").symlink_to(elsewhere)

    swap_after_authorize(monkeypatch, swap)
    status, body, _ = await get(client, url)
    assert status == 404
    assert b"ELSEWHERE" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_markdown_is_read_from_the_checked_file(client, signed_url, home_dir, ssh_key,
                                                      monkeypatch):
    doc = home_dir / "proj" / "README.md"
    doc.parent.mkdir()
    doc.write_text("# readme")
    url = await signed_url(doc)

    def swap():
        doc.unlink()
        doc.symlink_to(ssh_key)

    swap_after_authorize(monkeypatch, swap)
    status, body, _ = await get(client, url)
    assert status == 404
    assert b"PRIVATE-KEY" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_hard_link_to_a_protected_file_swapped_in_after_the_checks_is_not_served(
        client, signed_url, home_dir, ssh_key, monkeypatch):
    doc = home_dir / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>page</p>")
    url = await signed_url(doc)

    def swap():
        doc.unlink()
        os.link(ssh_key, doc)         # same name, so the descriptor's name still matches

    swap_after_authorize(monkeypatch, swap)
    status, body, _ = await get(client, url)
    assert status == 404
    assert b"PRIVATE-KEY" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_hard_link_to_a_key_created_after_the_checks_is_not_served(
        client, signed_url, home_dir, ssh_key, monkeypatch):
    doc = home_dir / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>page</p>")
    url = await signed_url(doc)
    new_key = ssh_key.parent / "id_new"

    def swap():
        new_key.write_text("NEW-PRIVATE-KEY")      # unknown to the checks' walk
        doc.unlink()
        os.link(new_key, doc)

    swap_after_authorize(monkeypatch, swap)
    try:
        status, body, _ = await get(client, url)
    finally:
        new_key.unlink(missing_ok=True)
    assert status == 404
    assert b"NEW-PRIVATE-KEY" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_protected_directory_renamed_into_place_after_the_checks_is_not_served(
        client, signed_url, home_dir, ssh_key, monkeypatch):
    proj = home_dir / "proj"
    proj.mkdir()
    (proj / "id_rsa").write_text("harmless")
    url = await signed_url(proj / "id_rsa")
    ssh_dir = ssh_key.parent

    def swap():
        (proj / "id_rsa").unlink()
        proj.rmdir()
        os.rename(ssh_dir, proj)      # ~/.ssh no longer exists for a fresh walk

    swap_after_authorize(monkeypatch, swap)
    try:
        status, body, _ = await get(client, url)
    finally:
        if proj.exists() and not ssh_dir.exists():
            os.rename(proj, ssh_dir)
    assert status == 404
    assert b"PRIVATE-KEY" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_served_files_leave_no_descriptor_open(client, signed_url, home_dir):
    doc = home_dir / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>page</p>")
    url = await signed_url(doc)
    await get(client, url)                   # warm up
    before = len(os.listdir(FD_DIR))
    for _ in range(20):
        assert (await get(client, url))[0] == 200
        assert (await get(client, url + "x"))[0] == 404
    assert len(os.listdir(FD_DIR)) <= before + 2


@pytest.mark.usefixtures("descriptor_platform")
async def test_range_requests_still_work(client, signed_url, home_dir):
    doc = home_dir / "proj" / "clip.mp4"
    doc.parent.mkdir()
    doc.write_bytes(bytes(range(256)) * 4)
    url = await signed_url(doc)
    status, body, resp = await get(client, url, headers={"Range": "bytes=10-19"})
    assert status == 206
    assert body == bytes(range(10, 20))
    assert resp.headers["Content-Type"] == "video/mp4"


# ---------------------------------------------------------------- finding 7: percent-encoding

@pytest.mark.parametrize("name", ["a#b.html", "q?x=1.html", "100%41.html", "sp ace.html",
                                  "é.html", "a%2Fb.html", "%2e%2e.html"])
async def test_file_names_with_url_syntax_round_trip(client, auth_bearer, home_dir, name):
    doc = home_dir / "proj" / name
    doc.parent.mkdir(exist_ok=True)
    doc.write_text(f"<p>{name}</p>")
    status, described = await describe(client, auth_bearer, doc)
    assert status == 200
    url = described["url"]
    assert "#" not in url and "?" not in url and " " not in url
    assert unquote(url).endswith(str(doc))
    status, body, _ = await get(client, url)
    assert (status, body) == (200, f"<p>{name}</p>".encode())


async def test_a_name_that_decodes_to_another_file_does_not_reach_it(client, auth_bearer, home_dir):
    proj = home_dir / "proj"
    proj.mkdir()
    (proj / "100%41.html").write_text("PERCENT")
    (proj / "100A.html").write_text("DECODED-TWICE")
    status, described = await describe(client, auth_bearer, proj / "100%41.html")
    status, body, _ = await get(client, described["url"])
    assert body == b"PERCENT"


@pytest.mark.parametrize("tail", ["/..%2F.env", "/%2e%2e/.env", "/../.env", "/..%2F..%2Fsibling.txt",
                                  "/%2e%2e/%2e%2e/sibling.txt", "/%252e%252e/.env",
                                  "/b/c/d/deep.txt", "/b/c/d/../../c/d/deep.txt", "/DOC.HTML"])
@pytest.mark.usefixtures("descriptor_platform")
async def test_encoded_traversal_stays_inside_the_scope(client, signed_url, home_dir, tail):
    proj = home_dir / "p"
    (proj / "a" / "b" / "c" / "d").mkdir(parents=True)
    (proj / "a" / "doc.html").write_text("x")
    (proj / ".env").write_text("DOTSECRET")
    (home_dir / "sibling.txt").write_text("SIBLING")
    (proj / "a" / "b" / "c" / "d" / "deep.txt").write_text("DEEP")
    base = (await signed_url(proj / "a" / "doc.html")).rsplit("/", 1)[0]
    status, body, _ = await get(client, base + tail)
    assert status in (403, 404), (tail, status, body)


# ---------------------------------------------------------------- finding 8: NUL byte

async def test_a_nul_byte_in_the_served_path_is_refused(client, signed_url, home_dir):
    doc = home_dir / "proj" / "doc.html"
    doc.parent.mkdir()
    doc.write_text("x")
    url = await signed_url(doc)
    status, _, _ = await get(client, url + "%00.png")
    assert status == 403     # refused before any filesystem access (R14)


async def test_a_nul_byte_in_an_api_view_target_is_404(client, auth_bearer, home_dir):
    status, _ = await describe(client, auth_bearer, str(home_dir) + "/doc\0.html")
    assert status == 404


# ---------------------------------------------------------------- the descriptor check per platform

def test_macos_refuses_a_descriptor_named_like_the_path_but_not_the_file_there(
        home_dir, monkeypatch):
    """F_GETPATH keeps an unlinked file's last name: the file at the path must be it."""
    doc = home_dir / "doc.txt"
    doc.write_text("NOW")
    old = home_dir / "old.txt"
    old.write_text("BEFORE")
    monkeypatch.setattr(view, "_PLATFORM", "darwin")
    monkeypatch.setattr(view, "fcntl", SimpleNamespace(
        F_GETPATH=50, fcntl=lambda fd, cmd, buf: os.fsencode(str(doc)).ljust(len(buf), b"\0")))
    with open(old, "rb") as handle:
        assert not view._descriptor_is(handle.fileno(), doc)
    with open(doc, "rb") as handle:
        assert view._descriptor_is(handle.fileno(), doc)


def test_macos_compares_the_name_exactly(home_dir, monkeypatch):
    """A case-insensitive volume answers the on-disk case; another spelling is refused."""
    doc = home_dir / "Doc.txt"
    doc.write_text("x")
    monkeypatch.setattr(view, "_PLATFORM", "darwin")
    monkeypatch.setattr(view, "fcntl", SimpleNamespace(
        F_GETPATH=50, fcntl=lambda fd, cmd, buf: os.fsencode(str(doc)).ljust(len(buf), b"\0")))
    with open(doc, "rb") as handle:
        assert not view._descriptor_is(handle.fileno(), home_dir / "doc.txt")


def test_a_platform_that_cannot_name_a_descriptor_serves_nothing(home_dir, monkeypatch):
    doc = home_dir / "doc.txt"
    doc.write_text("x")
    monkeypatch.setattr(view, "_PLATFORM", "freebsd14")
    with pytest.raises(view.web.HTTPNotFound):
        view._open_checked(doc)

