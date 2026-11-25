# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The snapshot keeps each session's label, folder and rank, and restore gives them back (respawn-organize)."""

import asyncio
import json
import os
import threading
import time

import pytest

import fsutil
import meshpaths
import organize
import ptyhost
import respawn
import server
from respawn_helpers import mesh_item, snapshot_file  # noqa: F401
from test_restore_api import FakeHost, restore


def organised(name, tmp_path, created=1.0, **org):
    return {**mesh_item(name, tmp_path, created), **org}


def write_lost(snapshot_file, tmp_path, **over):
    entry = {"name": "s", "cwd": str(tmp_path), "created": 1.0, "agent": None, "cmd": None, "lost_at": 5.0}
    entry.update(over)
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(json.dumps({"version": 1, "live": [], "lost": [entry]}))


NOTHING = {"label": None, "folder": None, "rank": None}


def test_an_entry_records_the_organisation_of_the_live_session(snapshot_file, tmp_path):
    respawn.update([organised("a", tmp_path, label="Mon projet", folder="projects", rank=3)], listed=True)
    [entry] = json.loads(snapshot_file.read_text())["live"]
    assert entry["org"] == {"label": "Mon projet", "folder": "projects", "rank": 3}


def test_an_unorganised_session_has_an_empty_organisation(snapshot_file, tmp_path):
    assert respawn.entry_of(mesh_item("a", tmp_path))["org"] == NOTHING


def test_the_organisation_follows_the_session_into_lost(snapshot_file, tmp_path):
    respawn.update([organised("a", tmp_path, label="L", folder="f", rank=0)], listed=True)
    respawn.update([], listed=True)
    assert respawn.lost_entry("a")["org"] == {"label": "L", "folder": "f", "rank": 0}


def test_folder_rename_propagates_a_required_snapshot_write_failure(snapshot_file, tmp_path, monkeypatch):
    respawn.update([organised("a", tmp_path, folder="f")], listed=True)

    def unwritable(*_args, **_kwargs):
        raise OSError("read-only snapshot")

    monkeypatch.setattr(respawn.fsutil, "atomic_write", unwritable)
    with pytest.raises(OSError, match="read-only snapshot"):
        respawn.rename_folder("f", "g")
    assert respawn._load()["live"][0]["org"]["folder"] == "f"


def test_a_changed_label_is_recorded_while_the_session_lives(snapshot_file, tmp_path):
    respawn.update([organised("a", tmp_path, label="old")], listed=True)
    respawn.update([organised("a", tmp_path, label="new")], listed=True)
    respawn.update([], listed=True)
    assert respawn.lost_entry("a")["org"]["label"] == "new"


def test_an_entry_written_before_this_field_still_loads(snapshot_file, tmp_path):
    write_lost(snapshot_file, tmp_path)
    assert respawn.lost_entry("s")["org"] == NOTHING


@pytest.mark.parametrize("org, expected", [
    ({"label": 5, "folder": "f", "rank": 2}, {"label": None, "folder": "f", "rank": 2}),
    ({"label": "l", "folder": ["x"], "rank": 2}, {"label": "l", "folder": None, "rank": 2}),
    ({"label": "l", "folder": "f", "rank": "2"}, {"label": "l", "folder": "f", "rank": None}),
    ({"label": "l", "folder": "f", "rank": True}, {"label": "l", "folder": "f", "rank": None}),
    ({"label": "l", "folder": "f", "rank": -1}, {"label": "l", "folder": "f", "rank": None}),
    ({"label": "l", "folder": "f", "rank": 1.5}, {"label": "l", "folder": "f", "rank": None}),
    ({"label": "a\x9bb\n c", "folder": "  f  ", "rank": 2}, {"label": "ab c", "folder": "f", "rank": 2}),
    ({"label": "   ", "folder": "", "rank": 0}, {"label": None, "folder": None, "rank": 0}),
    ("projects", NOTHING), (["a"], NOTHING), (7, NOTHING), (None, NOTHING),
])
def test_each_organisation_field_is_validated_on_read_and_the_session_is_still_offered(
        snapshot_file, tmp_path, org, expected):
    write_lost(snapshot_file, tmp_path, org=org)
    assert respawn.lost_entry("s")["org"] == expected


def test_the_organisation_is_never_shown_in_the_offer(snapshot_file, tmp_path):
    respawn.update([organised("a", tmp_path, label="secret-label", folder="f", rank=1)], listed=True)
    assert "secret-label" not in repr(respawn.update([], listed=True))


# ---- through the server: the owner's scenario

@pytest.fixture
def fake_host(monkeypatch, snapshot_file, tmp_path):
    monkeypatch.setattr(organize, "FILE", tmp_path / "mesh.json")
    # The fake host has no relationship with this machine's process table.
    monkeypatch.setattr(server.discover, "snapshot", lambda: {})
    monkeypatch.setattr(server.discover, "describe", lambda _procs, _pid: {
        "cwd": str(tmp_path), "cmd": "test shell", "agent": None,
    })
    host = FakeHost()
    monkeypatch.setattr(ptyhost, "request", host.request)
    return host


async def api_get(client, headers):
    return await (await client.get("/api/sessions", headers=headers)).json()


async def organise_three(client, headers, fake_host, tmp_path):
    for name, created in (("a", 1.0), ("b", 2.0), ("c", 3.0)):
        fake_host.sessions.append({"name": name, "pid": os.getpid(), "cwd": str(tmp_path), "created": created,
                                   "activity": 0, "attached": 0, "meta": {}})
    for op in ({"op": "folder-add", "name": "projects"}, {"op": "folder-add", "name": "notes"},
               {"op": "rename", "id": "a", "label": "Alpha"},
               {"op": "move", "id": "a", "folder": "projects", "order": ["b", "a", "c"]},
               {"op": "move", "id": "c", "folder": "notes", "order": ["b", "a", "c"]}):
        resp = await client.post("/api/organize", json=op, headers=headers)
        assert resp.status == 200, await resp.text()
    await api_get(client, headers)             # the snapshot sees the organised mesh


async def wipe_ptyhost(client, headers, fake_host):
    fake_host.sessions.clear()                 # ptyhost restarted
    data = await api_get(client, headers)      # organize prunes everything here, as on the owner's mesh
    assert data["restorable"] and json.loads(organize.FILE.read_text())["sessions"] == {}


async def test_restored_sessions_return_to_their_folders_with_their_labels_and_order(
        client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    before = {s["name"]: (s["label"], s["folder"]) for s in (await api_get(client, auth_cookie))["mesh"]}
    assert before == {"a": ("Alpha", "projects"), "b": (None, None), "c": (None, "notes")}
    await wipe_ptyhost(client, auth_cookie, fake_host)
    status, body = await restore(client, auth_cookie, "a", "b", "c")
    assert status == 200 and all(r["ok"] for r in body["results"].values()), body
    mesh = (await api_get(client, auth_cookie))["mesh"]
    assert {s["name"]: (s["label"], s["folder"]) for s in mesh} == before
    assert [s["name"] for s in mesh] == ["b", "a", "c"]


async def test_the_restored_order_does_not_depend_on_the_order_of_the_request(
        client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    await restore(client, auth_cookie, "c", "a", "b")
    assert [s["name"] for s in (await api_get(client, auth_cookie))["mesh"]] == ["b", "a", "c"]


async def test_a_folder_that_no_longer_exists_is_not_recreated(client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    resp = await client.post("/api/organize", json={"op": "folder-remove", "name": "projects"}, headers=auth_cookie)
    assert resp.status == 200
    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["ok"]
    data = await api_get(client, auth_cookie)
    got = {s["name"]: s for s in data["mesh"]}["a"]
    assert (got["label"], got["folder"]) == ("Alpha", None)
    assert "projects" not in data["folders"]


async def test_renaming_a_folder_updates_pending_restore_organisation(client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)

    resp = await client.post("/api/organize", json={"op": "folder-rename", "old": "projects", "new": "projets"},
                             headers=auth_cookie)
    assert resp.status == 200, await resp.text()
    assert respawn.lost_entry("a")["org"]["folder"] == "projets"

    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["ok"]
    restored = {s["name"]: s for s in (await api_get(client, auth_cookie))["mesh"]}["a"]
    assert (restored["label"], restored["folder"]) == ("Alpha", "projets")


async def test_folder_rename_rolls_back_if_the_recovery_snapshot_cannot_be_written(
        client, auth_cookie, fake_host, tmp_path, monkeypatch):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)

    def unavailable_snapshot(_old, _new):
        raise OSError("read-only snapshot")

    monkeypatch.setattr(respawn, "rename_folder", unavailable_snapshot)
    response = await client.post("/api/organize", json={"op": "folder-rename", "old": "projects", "new": "projets"},
                                 headers=auth_cookie)
    assert response.status == 503
    assert json.loads(organize.FILE.read_text())["folders"] == ["projects", "notes"]
    assert respawn.lost_entry("a")["org"]["folder"] == "projects"


async def test_concurrent_folder_renames_serialize_the_snapshot_with_the_mesh(
        client, auth_cookie, fake_host, tmp_path, monkeypatch):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    original = respawn.rename_folder
    entered, release = threading.Event(), threading.Event()

    def pause_first_snapshot_rename(old, new):
        if (old, new) == ("projects", "projets"):
            entered.set()
            assert release.wait(2), "test did not release the first rename"
        return original(old, new)

    monkeypatch.setattr(respawn, "rename_folder", pause_first_snapshot_rename)
    first = asyncio.create_task(client.post("/api/organize",
                                             json={"op": "folder-rename", "old": "projects", "new": "projets"},
                                             headers=auth_cookie))
    assert await asyncio.to_thread(entered.wait, 1), "first rename did not reach snapshot migration"
    second = asyncio.create_task(client.post("/api/organize",
                                              json={"op": "folder-rename", "old": "projets", "new": "archive"},
                                              headers=auth_cookie))
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(second), 0.05)
    release.set()
    first_response, second_response = await asyncio.gather(first, second)
    assert first_response.status == second_response.status == 200
    assert json.loads(organize.FILE.read_text())["folders"] == ["archive", "notes"]
    assert respawn.lost_entry("a")["org"]["folder"] == "archive"


async def test_listing_cannot_restore_a_stale_folder_after_a_rename(
        client, auth_cookie, fake_host, tmp_path, monkeypatch):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    original = server.list_sessions
    entered, release = threading.Event(), threading.Event()

    def pause_after_observing_the_old_folder(raw, listed=True, read_at=None):
        observed = original(raw, listed, read_at)
        entered.set()
        assert release.wait(2), "test did not release the stale listing"
        return observed

    monkeypatch.setattr(server, "list_sessions", pause_after_observing_the_old_folder)
    listing = asyncio.create_task(client.get("/api/sessions", headers=auth_cookie))
    assert await asyncio.to_thread(entered.wait, 5), "listing did not observe the old folder"
    # The organisation lock covers the writes of a listing, not its reads: the rename does not wait
    # for the description, and the snapshot written after it still records the new folder.
    rename_response = await asyncio.wait_for(client.post(
        "/api/organize", json={"op": "folder-rename", "old": "projects", "new": "projets"}, headers=auth_cookie), 5)
    release.set()
    listing_response = await listing
    assert listing_response.status == rename_response.status == 200
    assert next(entry for entry in respawn._load()["live"] if entry["name"] == "a")["org"]["folder"] == "projets"


async def test_folder_rename_waits_for_restore_organisation(client, auth_cookie, fake_host, tmp_path, monkeypatch):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    original = server.restore_organisation
    entered, release = asyncio.Event(), asyncio.Event()

    async def pause_before_assigning_the_restored_folder(new, org):
        entered.set()
        await release.wait()
        await original(new, org)

    monkeypatch.setattr(server, "restore_organisation", pause_before_assigning_the_restored_folder)
    restore_task = asyncio.create_task(client.post("/api/restore", json={"names": ["a"]}, headers=auth_cookie))
    await asyncio.wait_for(entered.wait(), 1)
    rename = asyncio.create_task(client.post("/api/organize",
                                              json={"op": "folder-rename", "old": "projects", "new": "projets"},
                                              headers=auth_cookie))
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(rename), 0.05)
    release.set()
    restore_response, rename_response = await asyncio.gather(restore_task, rename)
    assert restore_response.status == rename_response.status == 200
    restored = {s["name"]: s for s in (await api_get(client, auth_cookie))["mesh"]}["a"]
    assert restored["folder"] == "projets"


async def test_a_session_restored_under_a_new_name_gets_the_organisation_under_that_name(
        client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    fake_host.sessions.append({"name": "a", "pid": 999998, "cwd": str(tmp_path), "created": 9.0, "activity": 0,
                               "attached": 0, "meta": {}})
    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["id"] == "a-2"
    mesh = {s["name"]: s for s in (await api_get(client, auth_cookie))["mesh"]}
    assert (mesh["a-2"]["label"], mesh["a-2"]["folder"]) == ("Alpha", "projects")
    assert (mesh["a"]["label"], mesh["a"]["folder"]) == (None, None)


async def test_ignoring_a_lost_session_drops_its_organisation(client, auth_cookie, fake_host, tmp_path):
    await organise_three(client, auth_cookie, fake_host, tmp_path)
    await wipe_ptyhost(client, auth_cookie, fake_host)
    resp = await client.post("/api/restore/discard", json={"names": ["a"]}, headers=auth_cookie)
    assert resp.status == 200
    assert respawn.lost_entry("a") is None
    snapshot = json.loads(respawn.FILE.read_text())
    assert {entry["name"] for entry in snapshot["lost"]} == {"b", "c"}
    assert all(entry["org"]["label"] != "Alpha" for entry in snapshot["live"] + snapshot["lost"])
    _, body = await restore(client, auth_cookie, "a")
    assert not body["results"]["a"]["ok"]
    data = await api_get(client, auth_cookie)
    assert all(session["name"] != "a" for session in data["mesh"])
    assert all(session["label"] != "Alpha" for session in data["mesh"])
    assert all(entry["name"] != "a" for entry in data["restorable"])


async def test_a_description_of_an_older_host_list_never_overwrites_a_newer_one(snapshot_file, tmp_path, monkeypatch):
    # Listings describe in parallel (round, watchers, actions): the one of the older host list may finish last.
    monkeypatch.setattr(server, "_RECORDED", [0.0])
    read = ([{"name": "a", "created": 1.0}], True, None)
    await server._record_listing({"mesh": [organised("a", tmp_path, label="new")]}, (*read, 0.0, 200.0), 200.0)
    _, durable = await server._record_listing({"mesh": [organised("a", tmp_path, label="old")]}, (*read, 0.0, 100.0), 100.0)
    assert not durable
    [entry] = json.loads(snapshot_file.read_text())["live"]
    assert entry["org"]["label"] == "new"


def hosted(name, tmp_path, created):
    """One item of the host's ``list``: a live process, so that a listing describes it."""
    return {"name": name, "pid": os.getpid(), "cwd": str(tmp_path), "created": created, "activity": created,
            "attached": 0, "meta": {}}


async def test_a_wall_clock_stepped_back_does_not_order_the_host_reads(snapshot_file, tmp_path, monkeypatch):
    # NTP correcting a fast clock, an RTC in local time, a manual change: reads stay ordered by time.monotonic().
    listed = [hosted("a", tmp_path, 1.0)]

    async def fake_request(request):
        assert request == {"op": "list"}
        return list(listed)

    async def identity():
        return "1:1"
    monkeypatch.setattr(ptyhost, "request", fake_request)
    monkeypatch.setattr(ptyhost, "host_identity", identity)
    monkeypatch.setattr(server, "_RECORDED", [0.0])
    state = server.SessionsState()
    await server.sessions_round(None, state)
    wall = time.time
    monkeypatch.setattr(time, "time", lambda: wall() - 3600)
    listed.append(hosted("b", tmp_path, 2.0))
    await state.membership(await state.read("request"))
    assert sorted(state.rows) == ["a", "b"], "a request's read lists the new session"
    listed.pop(0)
    await server.sessions_round(None, state)
    assert [(name, row["ready"]) for name, row in state.rows.items()] == [("b", True)]
    assert [entry["name"] for entry in json.loads(snapshot_file.read_text())["live"]] == ["b"]


async def test_membership_never_publishes_an_older_host_list_over_a_newer_one(snapshot_file, tmp_path):
    state = server.SessionsState()
    await state.membership(([hosted("a", tmp_path, 1.0), hosted("x", tmp_path, 2.0)], True, None, 0.0, 2.0))
    await state.membership(([hosted("a", tmp_path, 1.0)], True, None, 0.0, 1.0))
    assert sorted(state.rows) == ["a", "x"]
    assert state.read_done == 2.0
    await state.membership(([], False, None, 0.0, 3.0))
    assert json.loads(state.answer(None))["host"] == "silent"
    await state.membership(([hosted("a", tmp_path, 1.0)], True, None, 0.0, 4.0))
    assert json.loads(state.answer(None))["host"] == "ok", "a successful read ends a silent host"


async def test_membership_projects_input_ack_before_discovery_finishes(snapshot_file, tmp_path):
    state = server.SessionsState()
    modern = dict(hosted("modern", tmp_path, 1.0),
                  pty_capabilities=["human_input_lease_v1", "acknowledged_input_v1"])
    old = hosted("old", tmp_path, 2.0)
    malformed = dict(hosted("malformed", tmp_path, 3.0), pty_capabilities="acknowledged_input_v1")
    await state.membership(([modern, old, malformed], True, None, 0.0, 1.0))
    assert {row["id"]: (row["ready"], row["pty_capabilities"])
            for row in json.loads(state.answer(None))["mesh"]} == {
                "modern": (False, ["acknowledged_input_v1"]),
                "old": (False, []),
                "malformed": (False, []),
            }


async def test_a_read_slower_than_a_publish_never_puts_older_rows_back(snapshot_file, tmp_path, monkeypatch):
    # A read's awaits (organisation, snapshot) let a round, or a newer read, publish in between.
    entered, release, view = threading.Event(), threading.Event(), server.organize.view

    def slow_view(raw, prune=True, read_at=None):
        entered.set()
        assert release.wait(5)
        return view(raw, prune, read_at)

    async def held(state, raw, order):
        entered.clear()
        release.clear()
        monkeypatch.setattr(server.organize, "view", slow_view)
        read = asyncio.create_task(state.membership((raw, True, None, 0.0, order)))
        assert await asyncio.to_thread(entered.wait, 5)
        monkeypatch.setattr(server.organize, "view", view)
        return read
    state = server.SessionsState()
    await state.membership(([hosted("a", tmp_path, 1.0)], True, None, 0.0, 1.0))
    read = await held(state, [dict(hosted("a", tmp_path, 1.0), attached=1)], 2.0)
    state.publish([dict(state.rows["a"], ready=True)], state.top)   # a round describes a meanwhile
    release.set()
    await read
    assert (state.rows["a"]["ready"], state.rows["a"]["attached"]) == (True, 1)
    read = await held(state, [hosted("a", tmp_path, 1.0)], 3.0)    # a read while the client was detached...
    await state.membership(([dict(hosted("a", tmp_path, 1.0), attached=1)], True, None, 0.0, 4.0))   # ...one after it reattached
    release.set()
    await read
    assert state.rows["a"]["attached"] == 1
    # A read overtaken by one still being published does not answer the requests waiting for that one.
    newer = await held(state, [hosted("a", tmp_path, 1.0), hosted("b", tmp_path, 2.0)], 6.0)
    await state.membership(([hosted("a", tmp_path, 1.0), hosted("b", tmp_path, 2.0)], True, None, 0.0, 5.0))
    assert state.read_done == 4.0
    release.set()
    await newer
    assert (sorted(state.rows), state.read_done) == (["a", "b"], 6.0)


async def test_listing_and_recovery_do_not_wait_for_slow_accounts(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def slow_accounts():
        calls.append("refresh")
        entered.set()
        await release.wait()
        return []

    recorded = []

    async def record(data, read, order):
        recorded.append(order)
        return [], True

    monkeypatch.setattr(server, "declared_accounts", slow_accounts)
    monkeypatch.setattr(server, "_record_listing", record)
    monkeypatch.setattr(server, "_LIVE_EVENT_STATE", None)
    monkeypatch.setattr(server, "_LISTING_ACCOUNT_REFRESH", (None, None, 0.0), raising=False)
    try:
        await asyncio.wait_for(server._listing(None, None, ([], True, None, 123.0, 1.0)), 1)
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.wait_for(server._listing(None, None, ([], True, None, 124.0, 2.0)), 1)
        assert calls == ["refresh"]
        assert recorded == [1.0, 2.0]
    finally:
        release.set()
        task = server._LISTING_ACCOUNT_REFRESH[1]
        if task is not None:
            await task


async def test_listing_refresh_cooldown_does_not_throttle_strict_callers(monkeypatch):
    calls = []

    async def refresh():
        calls.append("refresh")
        return []

    monkeypatch.setattr(server, "declared_accounts", refresh)
    monkeypatch.setattr(server, "_LISTING_ACCOUNT_REFRESH", (None, None, 0.0))
    monkeypatch.setattr(server, "_LISTING_ACCOUNT_RETRY_SECONDS", 60.0)
    server._schedule_listing_account_refresh()
    await server._LISTING_ACCOUNT_REFRESH[1]
    await asyncio.sleep(0)  # let the completion callback set the deadline
    server._schedule_listing_account_refresh()
    assert calls == ["refresh"]
    await server.declared_accounts()
    assert calls == ["refresh", "refresh"]


async def test_startup_does_not_bypass_strict_document_refresh(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_accounts():
        entered.set()
        await release.wait()
        return []

    monkeypatch.setattr(server, "declared_accounts", slow_accounts)
    monkeypatch.setattr(server, "_LISTING_ACCOUNT_REFRESH", (None, None, 0.0))
    await asyncio.wait_for(server._start_listing_account_refresh(None), 1)
    await asyncio.wait_for(entered.wait(), 1)
    strict = asyncio.create_task(server.refresh_document_account_protection())
    try:
        await asyncio.sleep(0)
        assert not strict.done()
    finally:
        release.set()
        await strict
        await server._stop_listing_account_refresh(None)


async def test_a_listing_observes_the_conversations_at_the_time_of_its_host_read(fake_host, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_RECORDED", [0.0])
    monkeypatch.setattr(meshpaths, "CONF_DIR", tmp_path)
    monkeypatch.setattr(server, "_LIVE_EVENT_STATE", None)
    raw = [hosted("observed", tmp_path, 100.0)]
    observed_at = float(int(time.time()) - 10)
    await server._listing(None, None, (raw, True, None, observed_at, 0.0))
    [entry] = fsutil.conversation_request("snapshot")
    assert entry["name"] == "observed"
    assert entry["seen"] == observed_at


@pytest.mark.parametrize("reply, kept", [(asyncio.CancelledError(), True), (ConnectionResetError(), True),
                                          (asyncio.TimeoutError(), True), ({"ok": True}, False)])
async def test_an_extra_that_fails_keeps_its_last_value(monkeypatch, reply, kept):
    async def request(req):   # a failure (also a child cancelled on its own), or a reply without a notice
        if isinstance(reply, BaseException):
            raise reply
        return reply
    monkeypatch.setattr(ptyhost, "request", request)
    state = server.SessionsState()
    state.extras["update"] = {"tag": "v9"}
    await state._read_extras(None)
    expected = {"tag": "v9"} if kept else None
    assert state.extras["update"] == expected
    assert json.loads(state.answer(None))["update"] == expected


@pytest.mark.parametrize("text, seconds", [(None, 2.0), ("", 2.0), ("0", 0.0), ("0.5", 0.5), ("60", 60.0),
                                           ("2s", 2.0), ("inf", 2.0), ("nan", 2.0), ("-1", 2.0), ("1e1", 2.0)])
def test_the_sessions_wait_setting_falls_back_to_two_seconds(text, seconds):
    assert server._wait_setting(text) == seconds
