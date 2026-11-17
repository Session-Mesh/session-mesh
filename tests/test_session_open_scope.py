# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""An HTML page opened by a session token only gets a file capability (R15)."""

import view


def test_file_scope_only_targets_get_a_file_capability(home_dir):
    (home_dir / "rep").mkdir()
    page = home_dir / "rep" / "x.html"
    page.write_text("<p>x</p>")
    assert view.describe_target(str(page))["url"].split("/")[2].startswith("v2.d.")
    view.file_scope_only(page)
    try:
        assert view.describe_target(str(page))["url"].split("/")[2].startswith("v2.f.")
    finally:
        view.FILE_SCOPE_ONLY.pop(page, None)


def test_the_restriction_expires(home_dir, monkeypatch):
    (home_dir / "rep2").mkdir()
    page = home_dir / "rep2" / "y.md"
    page.write_text("# y")
    view.file_scope_only(page)
    monkeypatch.setattr(view, "_now", lambda: __import__("time").time() + view.VIEW_TTL + 1)
    assert view.describe_target(str(page))["url"].split("/")[2].startswith("v2.d.")


# ---------------------------------------------------------------- the marker is never lost open

import pytest  # noqa: E402

import server  # noqa: E402
from session_helpers import add_session, clean_opens, listing  # noqa: E402,F401


def mode(page):
    return view.describe_target(str(page))["url"].split("/")[2][:4]


def restart():
    """What a new server process starts from: nothing in memory, the store on disk."""
    view.FILE_SCOPE_ONLY.clear()
    view.configure(server.TOKEN, server.CONF_DIR)


@pytest.fixture
def scope_state():
    yield
    view.FILE_SCOPE_ONLY.clear()
    (server.CONF_DIR / view.FILE_SCOPE_STORE_NAME).unlink(missing_ok=True)
    view.configure(server.TOKEN, server.CONF_DIR)
    assert not view.FILE_SCOPE_ONLY and view._file_scope_all_until() == 0


def report(home_dir, name):
    (home_dir / name).mkdir()
    page = home_dir / name / "index.html"
    page.write_text("<p>x</p>")
    return page


async def test_a_session_opened_document_stays_file_scoped_after_a_restart(
        client, auth_bearer, listing, home_dir, scope_state):
    page = report(home_dir, "kept")
    assert mode(page) == "v2.d"
    resp = await client.post("/api/open", json={"target": str(page)}, headers=add_session(listing, "alpha"))
    assert resp.status == 200
    restart()
    resp = await client.post("/api/view", json={"target": str(page)}, headers=auth_bearer)
    assert (await resp.json())["url"].split("/")[2].startswith("v2.f.")
    # a document no session opened keeps its directory scope
    assert mode(report(home_dir, "own")) == "v2.d"


def test_filling_the_table_never_gives_a_directory_scope_back(home_dir, monkeypatch, scope_state):
    monkeypatch.setattr(view, "FILE_SCOPE_MAX", 3)
    first = report(home_dir, "first")
    view.file_scope_only(first)
    for index in range(5):
        view.file_scope_only(home_dir / f"filler-{index}.html")
    assert len(view.FILE_SCOPE_ONLY) <= 3
    assert mode(first) == "v2.f"
    restart()
    assert mode(first) == "v2.f"
    # the fallback ends when the evicted markers would have ended
    monkeypatch.setattr(view, "_now", lambda: __import__("time").time() + view.VIEW_TTL + 1)
    assert mode(first) == "v2.d"


@pytest.mark.parametrize("damage", ["{", "[]", '{"version": 1, "paths": {"/x": "soon"}}', '{"version": 2}', "\xff"])
def test_an_unreadable_store_file_scopes_every_document(home_dir, monkeypatch, scope_state, damage):
    page = report(home_dir, "after-damage")
    (server.CONF_DIR / view.FILE_SCOPE_STORE_NAME).write_bytes(damage.encode("latin-1"))
    restart()
    assert mode(page) == "v2.f"
    restart()                               # the fallback itself survives a restart
    assert mode(page) == "v2.f"
    monkeypatch.setattr(view, "_now", lambda: __import__("time").time() + view.VIEW_TTL + 1)
    assert mode(page) == "v2.d"


async def test_a_marker_that_cannot_be_stored_refuses_the_open(client, listing, home_dir, monkeypatch, scope_state):
    page = report(home_dir, "unstored")

    def full_disk(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(view.fsutil, "atomic_write", full_disk)
    resp = await client.post("/api/open", json={"target": str(page)}, headers=add_session(listing, "alpha"))
    assert resp.status == 503
    assert not any(entry.get("target") == str(page) for entry in __import__("opens").OPENS)
