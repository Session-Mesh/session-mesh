# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Mesh session names, folders and order (organize.py, POST /api/organize)."""

import json

import pytest

import organize
import server


@pytest.fixture(autouse=True)
def mesh_file(tmp_path, monkeypatch):
    path = tmp_path / "mesh.json"
    monkeypatch.setattr(organize, "FILE", path)
    return path


def live(*names, created=1.0):
    return [{"name": n, "created": created} for n in names]


@pytest.mark.parametrize("capabilities,expected", [
    (None, []),
    (["human_input_lease_v1"], []),
    (["acknowledged_input_v1"], ["acknowledged_input_v1"]),
    (["acknowledged_input_v2"], ["acknowledged_input_v2"]),
    (["acknowledged_input_v1", "acknowledged_input_v2"],
     ["acknowledged_input_v2", "acknowledged_input_v1"]),
    (["acknowledged_input_v1", "acknowledged_input_v1"], []),
    (["acknowledged_input_v2", "acknowledged_input_v2"], []),
    (["acknowledged_input_v1", 1], []),
    ("acknowledged_input_v1", []),
])
def test_public_listing_projects_only_valid_native_ack_capability(capabilities, expected, monkeypatch):
    monkeypatch.setattr(server.discover, "snapshot", lambda: {})
    monkeypatch.setattr(server.discover, "external_sessions", lambda *a, **kw: [])
    raw = {**live("s1")[0], "pid": 123, "activity": 1.0, "attached": 0, "meta": {}}
    if capabilities is not None:
        raw["pty_capabilities"] = capabilities
    (session,) = server.list_sessions([raw])["mesh"]
    assert session["pty_capabilities"] == expected


def test_rename_and_clear_label():
    s = live("a")
    assert organize.apply({"op": "rename", "id": "a", "label": "  mon\tprojet \x07 "}, s)["sessions"]["a"]["label"] == "mon projet"
    assert organize.apply({"op": "rename", "id": "a", "label": ""}, s)["sessions"]["a"]["label"] is None


def test_label_is_capped():
    out = organize.apply({"op": "rename", "id": "a", "label": "x" * 500}, live("a"))
    assert len(out["sessions"]["a"]["label"]) == organize.MAX_LEN


def test_unknown_session_is_refused():
    with pytest.raises(ValueError):
        organize.apply({"op": "rename", "id": "ghost", "label": "x"}, live("a"))


def test_move_into_folder_and_order():
    s = live("a", "b", "c")
    organize.apply({"op": "folder-add", "name": "projects"}, s)
    organize.apply({"op": "move", "id": "c", "folder": "projects", "before": None}, s)
    out = organize.apply({"op": "move", "id": "a", "folder": "projects", "before": "c"}, s)
    assert out["folders"] == ["projects"]
    assert out["sessions"]["a"]["folder"] == "projects" and out["sessions"]["c"]["folder"] == "projects"
    assert out["sessions"]["a"]["rank"] < out["sessions"]["c"]["rank"]
    assert out["sessions"]["b"] == {"label": None, "folder": None, "rank": None}


def test_move_to_unknown_folder_is_refused():
    with pytest.raises(ValueError):
        organize.apply({"op": "move", "id": "a", "folder": "nope"}, live("a"))


def test_folder_rename_carries_sessions_and_refuses_duplicates():
    s = live("a")
    organize.apply({"op": "folder-add", "name": "x"}, s)
    organize.apply({"op": "folder-add", "name": "y"}, s)
    organize.apply({"op": "move", "id": "a", "folder": "x"}, s)
    out = organize.apply({"op": "folder-rename", "old": "x", "new": "z"}, s)
    assert out["folders"] == ["z", "y"] and out["sessions"]["a"]["folder"] == "z"
    with pytest.raises(ValueError):
        organize.apply({"op": "folder-rename", "old": "z", "new": "y"}, s)


def test_folder_remove_puts_sessions_back_at_top_level():
    s = live("a")
    organize.apply({"op": "folder-add", "name": "x"}, s)
    organize.apply({"op": "move", "id": "a", "folder": "x"}, s)
    out = organize.apply({"op": "folder-remove", "name": "x"}, s)
    assert out["folders"] == [] and out["sessions"]["a"]["folder"] is None


def test_folder_move_reorders():
    s = live()
    for f in ("a", "b", "c"):
        organize.apply({"op": "folder-add", "name": f}, s)
    assert organize.apply({"op": "folder-move", "name": "c", "before": "a"}, s)["folders"] == ["c", "a", "b"]


def test_ended_session_is_forgotten_and_a_reused_name_starts_clean(mesh_file):
    organize.apply({"op": "rename", "id": "a", "label": "old"}, live("a", created=1.0))
    out = organize.view(live("a", created=2.0))   # same name, new session
    assert out["sessions"]["a"]["label"] is None
    assert "a" not in json.loads(mesh_file.read_text())["sessions"]


async def test_api_organize_and_listing(client, auth_cookie, pty, monkeypatch):
    monkeypatch.setattr(server.discover, "external_sessions", lambda *a, **k: [])
    await pty.new("s1")
    resp = await client.post("/api/organize", json={"op": "folder-add", "name": "proj"}, headers=auth_cookie)
    assert resp.status == 200
    resp = await client.post("/api/organize", json={"op": "move", "id": "s1", "folder": "proj"}, headers=auth_cookie)
    assert resp.status == 200
    resp = await client.post("/api/organize", json={"op": "rename", "id": "s1", "label": "Mon shell"}, headers=auth_cookie)
    assert resp.status == 200
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert data["folders"] == ["proj"]
    (s1,) = [s for s in data["mesh"] if s["id"] == "s1"]
    assert s1["label"] == "Mon shell" and s1["folder"] == "proj"
    assert s1["pty_capabilities"] == ["acknowledged_input_v2", "acknowledged_input_v1"]
    bad = await client.post("/api/organize", json={"op": "move", "id": "s1", "folder": "nope"}, headers=auth_cookie)
    assert bad.status == 400


async def test_api_organize_needs_auth(client):
    resp = await client.post("/api/organize", json={"op": "folder-add", "name": "x"})
    assert resp.status == 401


async def test_a_failed_listing_does_not_wipe_the_organisation(mesh_file, monkeypatch):
    organize.apply({"op": "folder-add", "name": "f"}, live("a"))
    organize.apply({"op": "move", "id": "a", "folder": "f"}, live("a"))
    organize.apply({"op": "rename", "id": "a", "label": "kept"}, live("a"))

    async def slow(_req):
        raise TimeoutError("ptyhost slow")
    monkeypatch.setattr(server.ptyhost, "request", slow)
    monkeypatch.setattr(server.discover, "external_sessions", lambda *a, **k: [])
    await server.sessions()
    saved = json.loads(mesh_file.read_text())
    assert saved["sessions"]["a"]["label"] == "kept" and saved["sessions"]["a"]["folder"] == "f"


def test_a_corrupt_file_is_set_aside_not_overwritten(mesh_file):
    mesh_file.write_text("{not json")
    organize.apply({"op": "folder-add", "name": "f"}, live())
    aside = list(mesh_file.parent.glob("mesh.json.corrupt-*"))
    assert len(aside) == 1 and aside[0].read_text() == "{not json"


def test_a_wrong_shape_is_set_aside(mesh_file):
    mesh_file.write_text('{"sessions": [1, 2]}')
    assert organize.view(live("a"))["folders"] == []
    assert list(mesh_file.parent.glob("mesh.json.corrupt-*"))


def test_writes_are_atomic_and_private(mesh_file):
    import os
    organize.apply({"op": "folder-add", "name": "f"}, live())
    assert oct(os.stat(mesh_file).st_mode & 0o777) == "0o600"
    assert not [p for p in mesh_file.parent.iterdir() if p.name.startswith(".mesh.json.")]


def test_a_move_adopts_the_displayed_order():
    s = live("A", "B", "C")
    # nothing ranked yet; the page shows C, B, A (newest first). Drop A before B:
    out = organize.apply({"op": "move", "id": "A", "folder": None, "before": "B", "order": ["C", "B", "A"]}, s)
    ranked = sorted(out["sessions"], key=lambda n: out["sessions"][n]["rank"])
    assert ranked == ["C", "A", "B"]


def test_a_reused_name_starts_unranked():
    organize.apply({"op": "move", "id": "a", "folder": None, "before": None, "order": ["a"]}, live("a", created=1.0))
    out = organize.view(live("a", created=2.0))
    assert out["sessions"]["a"]["rank"] is None


def test_c1_controls_and_bidi_overrides_are_stripped():
    out = organize.apply({"op": "rename", "id": "a", "label": "a\u009b31mb‮c⁦d"}, live("a"))
    assert out["sessions"]["a"]["label"] == "a31mbcd"   # the CSI byte goes, its text stays inert


def test_a_folder_stored_with_old_rules_can_still_be_removed(mesh_file):
    mesh_file.write_text(json.dumps({"folders": ["pro‮jet"], "sessions": {}, "order": []}))
    out = organize.apply({"op": "folder-remove", "name": "projet"}, live())
    assert out["folders"] == []
