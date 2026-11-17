# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The server announces its client version (CV-1): a short hash of the served client files, in
every /api/sessions reply and in the page itself, that changes when a client file changes."""

import re
import shutil

import pytest

import server


@pytest.fixture
def static_copy(tmp_path, monkeypatch):
    copy = tmp_path / "static"
    shutil.copytree(server.STATIC, copy, ignore=shutil.ignore_patterns("vendor"))
    monkeypatch.setattr(server, "STATIC", copy)
    monkeypatch.setattr(server, "_client_version_cache", ((), ""))
    return copy


async def test_sessions_carries_a_short_client_version(client, auth_cookie):
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert re.fullmatch(r"[0-9a-f]{12}", data["client_version"])


async def test_the_page_carries_the_version_it_was_served(client, auth_cookie):
    html = await (await client.get("/", headers=auth_cookie)).text()
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert f'<meta name="client-version" content="{data["client_version"]}">' in html
    assert "__CLIENT_VERSION__" not in html


async def test_the_page_versions_the_checked_in_typescript_bundle(client, auth_cookie):
    html = await (await client.get("/", headers=auth_cookie)).text()
    assert re.search(r'<script src="/static/folder-state\.js\?v=\d+"></script>', html)
    assert re.search(r'<script src="/static/session-activity\.js\?v=\d+"></script>', html)
    assert re.search(r'<script src="/static/demo-catalog\.js\?v=\d+"></script>', html)
    assert re.search(r'<script src="/static/workspace-spec\.js\?v=\d+"></script>', html)


@pytest.mark.parametrize("name", server.client_files())
def test_the_version_changes_when_a_client_file_changes(static_copy, name):
    before = server.client_version()
    assert server.client_version() == before
    with open(static_copy / name, "a") as f:
        f.write("\n/* deployed */\n")
    assert server.client_version() != before


def test_the_version_covers_the_translation_runtime_and_catalogs():
    names = server.client_files()
    assert "i18n.js" in names
    for catalog in ("i18n/en.json", "i18n/fr.json", "i18n/languages.json", "i18n/server-messages.json"):
        assert catalog in names


def test_the_version_changes_when_a_language_is_added(static_copy):
    before = server.client_version()
    (static_copy / "i18n" / "de.json").write_text("{}\n")
    assert server.client_version() != before
