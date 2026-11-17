# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""File tree listings (browse.py) and the ?source=1 view of rendered types."""

import pytest

import view


async def ls(client, headers, path, **extra):
    return await client.post("/api/ls", json={"path": path, **extra}, headers=headers)


async def test_lists_a_directory_dirs_first(client, auth_bearer, home_dir):
    (home_dir / "b.txt").write_text("x")
    (home_dir / "a").mkdir()
    (home_dir / "C.md").write_text("x")
    resp = await ls(client, auth_bearer, str(home_dir))
    assert resp.status == 200
    data = await resp.json()
    assert [(e["name"], e["dir"]) for e in data["entries"]] == [("a", True), ("b.txt", False), ("C.md", False)]
    assert data["path"] == str(home_dir.resolve())


async def test_relative_to_a_base(client, auth_bearer, home_dir):
    (home_dir / "proj" / "src").mkdir(parents=True)
    resp = await ls(client, auth_bearer, "src", bases=[str(home_dir / "proj")])
    assert (await resp.json())["path"].endswith("proj/src")


@pytest.mark.parametrize("path", ["/etc", "/"])
async def test_outside_the_roots_is_refused(client, auth_bearer, path):
    assert (await ls(client, auth_bearer, path)).status == 403


async def test_protected_directories_are_refused(client, auth_bearer):
    ssh = view.Path.home() / ".ssh"
    ssh.mkdir(exist_ok=True)
    view._deny_inodes.cache = None
    assert (await ls(client, auth_bearer, str(ssh))).status == 403


async def test_a_session_token_cannot_list(client, home_dir):
    resp = await client.post("/api/ls", json={"path": str(home_dir)},
                             headers={"Authorization": "MeshSession ms1.x.y.z"})
    assert resp.status == 401


async def test_bad_bodies_are_400(client, auth_bearer):
    for body in ([1], {"path": 5}, {"path": "a\0b"}):
        assert (await client.post("/api/ls", json=body, headers=auth_bearer)).status == 400


async def test_source_of_markdown_is_the_code_viewer(client, home_dir, signed_url):
    doc = home_dir / "s.md"
    doc.write_text("# title\n")
    url = await signed_url(doc)
    rendered = await (await client.get(url, headers={"Sec-Fetch-Dest": "iframe"})).text()
    source = await (await client.get(url + "?source=1", headers={"Sec-Fetch-Dest": "iframe"})).text()
    assert "marked" in rendered and 'language: "markdown"' in source
