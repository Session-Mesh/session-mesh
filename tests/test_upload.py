# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Upload storage and name sanitizing (server.py:502-530)."""

import re
from pathlib import Path

import pytest

import server


@pytest.fixture
def upload_dir(tmp_path, monkeypatch):
    path = tmp_path / "uploads"
    monkeypatch.setattr(server, "UPLOAD_DIR", path)
    return path


async def upload(client, headers, name, data):
    params = {} if name is None else {"name": name}
    return await client.post("/api/upload", params=params, data=data, headers=headers)


@pytest.mark.parametrize("name,expected", [
    ("../../x", "x"),
    ("../../etc/passwd", "passwd"),
    (".bashrc", "bashrc"),
    ("..hidden.", "hidden"),
    ("café 😀.txt", "café_.txt"),
    ("a b;c$(rm).txt", "a_b_c_rm_.txt"),
    ("", "file"),
    ("...", "file"),
    ("/", "file"),
    (None, "file"),
])
async def test_upload_name_is_sanitized_and_stays_in_the_day_dir(
        client, auth_cookie, upload_dir, name, expected):
    resp = await upload(client, auth_cookie, name, b"payload")
    assert resp.status == 200
    stored = Path((await resp.json())["path"])
    assert stored.name == expected
    assert stored.parent.parent == upload_dir
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", stored.parent.name)
    assert stored.read_bytes() == b"payload"


async def test_upload_duplicates_get_a_numbered_suffix(client, auth_cookie, upload_dir):
    names = []
    for content in (b"1", b"2", b"3"):
        resp = await upload(client, auth_cookie, "shot.png", content)
        names.append(Path((await resp.json())["path"]))
    assert [p.name for p in names] == ["shot.png", "shot-2.png", "shot-3.png"]
    assert [p.read_bytes() for p in names] == [b"1", b"2", b"3"]


async def test_upload_duplicate_without_extension(client, auth_cookie, upload_dir):
    first = await (await upload(client, auth_cookie, "notes", b"a")).json()
    second = await (await upload(client, auth_cookie, "notes", b"b")).json()
    assert Path(first["path"]).name == "notes"
    assert Path(second["path"]).name == "notes-2"


async def test_empty_upload_is_400(client, auth_cookie, upload_dir):
    resp = await upload(client, auth_cookie, "empty.txt", b"")
    assert resp.status == 400
    assert not upload_dir.exists() or not any(upload_dir.rglob("*.txt"))


def test_cleanup_never_follows_a_symlink(upload_dir, tmp_path):
    import os
    import server
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "precious.txt").write_text("keep")
    os.utime(victim, (0, 0))
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / "2020-01-01").symlink_to(victim, target_is_directory=True)
    server._store_upload("x.txt", b"x")
    assert (victim / "precious.txt").exists()


def test_cleanup_errors_do_not_fail_the_upload(upload_dir):
    import os
    import server
    old = upload_dir / "2020-01-01"
    (old / "sub").mkdir(parents=True)          # a subdirectory: rmdir fails
    os.utime(old, (0, 0))
    assert server._store_upload("y.txt", b"y").endswith("y.txt")
