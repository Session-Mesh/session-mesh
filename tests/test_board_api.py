# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The private Excalidraw document route and its session lifecycle hooks."""

import asyncio

import pytest

import board
import opens
import respawn
import server
import sessiontoken
import signalbus
from session_helpers import OTHER_NONCE, add_session, listing  # noqa: F401
from respawn_helpers import mesh_item, snapshot_file  # noqa: F401


@pytest.fixture
def board_file(tmp_path, monkeypatch):
    path = tmp_path / "conf" / "board.json"
    monkeypatch.setattr(board, "FILE", path)
    return path


async def create(pty, name="alpha"):
    await pty.new(name)


async def wait_gone(pty, name):
    for _ in range(100):
        if not any(session["name"] == name for session in await pty.request({"op": "list"})):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"{name} was not reaped")


def document(version=0, elements=None):
    return {"elements": elements or [], "appState": {}, "files": {}, "version": version}


async def test_get_put_and_stale_cas(client, auth_cookie, pty, board_file):
    await create(pty)
    response = await client.get("/api/board/alpha", headers=auth_cookie)
    assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
    assert await response.json() == document()
    response = await client.put("/api/board/alpha", json=document(elements=[{"type": "rectangle"}]), headers=auth_cookie)
    saved = await response.json()
    assert response.status == 200 and saved["version"] == 1
    stale = await client.put("/api/board/alpha", json=document(), headers=auth_cookie)
    assert stale.status == 409 and await stale.text() == "409: Conflict"


async def test_accepted_write_constructs_only_a_content_free_reference(client, auth_cookie, pty, board_file, monkeypatch):
    await create(pty)
    called = []
    monkeypatch.setattr(board, "updated_envelope", lambda *args: called.append(args) or {})
    monkeypatch.setattr(server.SIGNALS, "publish", lambda envelope, identity=None: None)
    response = await client.put("/api/board/alpha", json=document(elements=[{"type": "text", "text": "private"}]),
                                headers=auth_cookie)
    assert response.status == 200
    assert len(called) == 1 and called[0][0:2] == ("alpha", 1)


async def test_board_write_publishes_only_after_a_successful_cas_and_sessions_snapshot_is_reference_only(
        client, auth_cookie, pty, board_file, monkeypatch):
    await create(pty)
    registry = signalbus.Registry()
    monkeypatch.setattr(server, "SIGNALS", registry)
    stale = await client.put("/api/board/alpha", json=document(version=1), headers=auth_cookie)
    assert stale.status == 409 and registry.snapshot() == []
    saved = await client.put("/api/board/alpha", json=document(elements=[{"type": "text", "text": "private"}]),
                             headers=auth_cookie)
    assert saved.status == 200
    first = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    second = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    expected = [{"v": 0, "type": "board.updated", "source": "alpha",
                 "object": {"kind": "board", "id": "alpha", "version": 1}, "at": pytest.approx(first["signals"][0]["at"])}]
    assert first["signals"] == expected
    assert second["signals"] == first["signals"]  # one reader never consumes another's hint
    assert "private" not in str(first["signals"])


async def test_non_live_invalid_and_bad_documents_are_rejected(client, auth_cookie, pty, board_file):
    assert (await client.get("/api/board/nope", headers=auth_cookie)).status == 404
    assert (await client.get("/api/board/a.dot", headers=auth_cookie)).status == 400
    await create(pty)
    bad = document(elements=[{"type": "image"}])
    assert (await client.put("/api/board/alpha", json=bad, headers=auth_cookie)).status == 400
    assert (await client.put("/api/board/alpha", data="[]", headers=auth_cookie)).status == 400


async def test_cookie_route_rejects_mesh_session_and_honours_origin(client, auth_cookie, pty, board_file):
    await create(pty)
    token = sessiontoken.issue("alpha", ptyhost_nonce(pty, "alpha"))
    assert (await client.get("/api/board/alpha", headers={"Authorization": "MeshSession " + token})).status == 401
    response = await client.put("/api/board/alpha", json=document(),
                                headers={**auth_cookie, "Origin": "https://evil.example"})
    assert response.status == 403


async def test_browser_board_named_self_does_not_collide_with_capability(client, auth_cookie, pty, board_file):
    await create(pty, "self")
    response = await client.get("/api/board/self", headers=auth_cookie)
    assert response.status == 200 and await response.json() == document()


async def test_session_token_reaches_only_its_own_board(client, listing, board_file, auth_cookie, auth_bearer):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    for index, entry in enumerate(listing, 1):
        entry["created"] = float(index)
    saved = await client.put("/api/board/@self", headers=alpha,
                             json=document(elements=[{"type": "text", "text": "alpha only"}]))
    assert saved.status == 200 and (await saved.json())["version"] == 1
    beta_board = await client.get("/api/board/@self", headers=beta)
    assert beta_board.status == 200 and await beta_board.json() == document()
    alpha_board = await client.get("/api/board/@self", headers=alpha)
    assert (await alpha_board.json())["elements"] == [{"type": "text", "text": "alpha only"}]
    # The former named route stays private to the browser/master and cannot be
    # used by alpha to nominate beta.
    assert (await client.get("/api/board/beta", headers=alpha)).status == 401
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get("/api/board/@self", headers=credentials)).status == 401


async def test_self_board_token_dies_on_name_reuse(client, listing, board_file):
    old = add_session(listing, "alpha")
    listing[0]["created"] = 1.0
    assert (await client.get("/api/board/@self", headers=old)).status == 200
    listing.clear()
    fresh = add_session(listing, "alpha", OTHER_NONCE)
    listing[0]["created"] = 2.0
    assert (await client.get("/api/board/@self", headers=old)).status == 401
    assert (await client.get("/api/board/@self", headers=fresh)).status == 200


async def test_revision_routes_are_owner_or_self_only_and_return_safe_metadata(client, listing, board_file, auth_cookie, auth_bearer):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    listing[0]["created"], listing[1]["created"] = 1.0, 2.0
    assert (await client.put("/api/board/@self", headers=alpha,
                             json=document(elements=[{"id": "secret", "version": 0,
                                                     "text": "private", "x": 41, "y": 42}]))).status == 200
    assert (await client.put("/api/board/@self", headers=alpha,
                             json=document(1, [{"id": "secret", "version": 1, "text": "changed"}]))).status == 200
    owner = await client.get("/api/board/alpha/revisions", headers=auth_cookie)
    assert owner.status == 200 and await owner.json() == {"revisions": [
        {"version": 0, "element_count": 0, "status": "available", "provenance": "legacy-unknown"},
        {"version": 1, "element_count": 1, "status": "available", "provenance": "mcp-session"},
        {"version": 2, "element_count": 1, "status": "available", "provenance": "mcp-session"}]}
    diff = await client.get("/api/board/@self/revision/diff?from_version=1&to_version=2", headers=alpha)
    assert diff.status == 200 and await diff.json() == {"status": "available", "added": 0, "removed": 0, "modified": 1}
    assert (await client.get("/api/board/@self/revisions", headers=auth_cookie)).status == 401
    assert (await client.get("/api/board/alpha/revisions", headers=alpha)).status == 401
    assert (await client.get("/api/board/@self/revisions", headers=beta)).status == 200
    assert (await client.post("/api/board/@self/revisions", headers=alpha)).status == 401
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get("/api/board/@self/revision?version=1", headers=credentials)).status == 401


async def test_latest_change_is_session_scoped_and_content_free(client, listing, board_file, auth_cookie):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    listing[0]["created"], listing[1]["created"] = 1.0, 2.0
    assert (await client.put("/api/board/@self", headers=alpha,
                             json=document(elements=[{"id": "secret", "version": 0,
                                                     "text": "private", "x": 41, "y": 42}]))).status == 200
    assert (await client.put("/api/board/@self", headers=alpha,
                             json=document(1, [{"id": "secret", "version": 1, "text": "changed"}]))).status == 200
    response = await client.get("/api/board/@self/latest-change", headers=alpha)
    body = await response.json()
    assert response.status == 200 and body == {"status": "available",
        "from": {"version": 1, "element_count": 1, "provenance": "mcp-session"},
        "to": {"version": 2, "element_count": 1, "provenance": "mcp-session"},
        "diff": {"added": 0, "removed": 0, "modified": 1}}
    assert all(value not in str(body) for value in ("secret", "private", "changed", "41", "42"))
    assert (await client.get("/api/board/@self/latest-change", headers=auth_cookie)).status == 401
    assert (await client.get("/api/board/alpha/latest-change", headers=auth_cookie)).status == 404
    assert (await client.get("/api/board/@self/latest-change?x=1", headers=alpha)).status == 400
    response = await client.get("/api/board/@self/latest-change", headers=beta)
    assert response.status == 200 and await response.json() == {"status": "unavailable"}


async def test_revision_schema_and_invalid_diff_are_closed(client, auth_cookie, pty, board_file):
    await create(pty)
    assert (await client.get("/api/board/alpha/revision", headers=auth_cookie)).status == 400
    assert (await client.get("/api/board/alpha/revision?version=-1", headers=auth_cookie)).status == 400
    response = await client.get("/api/board/alpha/revision/diff?from_version=0&to_version=0", headers=auth_cookie)
    assert response.status == 200 and await response.json() == {"status": "unavailable"}


async def test_session_scoped_restore_is_cas_and_refresh_has_no_body(client, auth_cookie, listing, board_file):
    alpha = add_session(listing, "alpha")
    listing[0]["created"] = 1.0
    doc = {"elements": [{"id": "old", "type": "rectangle"}], "appState": {}, "files": {}, "version": 0}
    response = await client.put("/api/board/@self", headers=alpha, json=doc)
    assert response.status == 200
    remote = {"elements": [{"id": "new", "type": "rectangle"}], "appState": {}, "files": {}, "version": 1}
    response = await client.put("/api/board/@self", headers=alpha, json=remote)
    assert response.status == 200 and (await response.json())["version"] == 2
    response = await client.post("/api/board/@self/revision/restore", headers=alpha,
                                 json={"version": 1, "expected_version": 2})
    assert response.status == 200 and (await response.json())["version"] == 3
    assert (await client.post("/api/board/@self/revision/restore", headers=alpha,
                              json={"version": 1, "expected_version": 2})).status == 409
    assert (await client.post("/api/board/@self/refresh", headers=alpha)).status == 200
    assert (await client.post("/api/board/@self/refresh", headers=auth_cookie)).status == 401
    assert (await client.post("/api/board/@self/refresh", headers=alpha, data=b"x")).status == 400


async def test_an_agent_write_queues_a_board_refresh_but_the_owners_does_not(
        client, auth_cookie, listing, board_file, monkeypatch):
    monkeypatch.setattr(opens, "OPENS", [])
    monkeypatch.setattr(opens, "_BOARD_REFRESH_IDENTITIES", {})
    refreshes = lambda: [entry for entry in opens.OPENS if entry.get("kind") == "board-refresh"]
    alpha = add_session(listing, "alpha")
    listing[0]["created"] = 1.0
    # The owner's own drawing never asks the page to refresh itself.
    assert (await client.put("/api/board/alpha", headers=auth_cookie, json=document())).status == 200
    assert refreshes() == []
    # An agent's write does: a closed, content-free member naming only the session.
    assert (await client.put("/api/board/@self", headers=alpha, json=document(version=1))).status == 200
    (entry,) = refreshes()
    assert set(entry) == {"kind", "session", "seq", "at"} and entry["session"] == "alpha"
    # A rejected write queues nothing new.
    seq = entry["seq"]
    assert (await client.put("/api/board/@self", headers=alpha, json=document(version=1))).status == 409
    assert [item["seq"] for item in refreshes()] == [seq]
    # So does restoring a retained revision.
    opens.OPENS.clear()
    opens._BOARD_REFRESH_IDENTITIES.clear()
    restored = await client.post("/api/board/@self/revision/restore", headers=alpha,
                                 json={"version": 1, "expected_version": 2})
    assert restored.status == 200
    assert [item["session"] for item in refreshes()] == ["alpha"]


def ptyhost_nonce(pty, name):
    # The in-process daemon stores metadata but a valid-looking session token is
    # sufficient here: COOKIE routes reject its scheme before token verification.
    return "n"


async def test_kill_forgets_the_live_document_and_its_signal(client, auth_cookie, pty, board_file, monkeypatch):
    registry = signalbus.Registry()
    monkeypatch.setattr(server, "SIGNALS", registry)
    await create(pty)
    assert (await client.put("/api/board/alpha", json=document(), headers=auth_cookie)).status == 200
    assert "alpha" in json_board(board_file)["boards"]
    assert registry.snapshot()
    created = next(s["created"] for s in await pty.request({"op": "list"}) if s["name"] == "alpha")
    assert (await client.post("/api/kill/alpha", json={"created": created}, headers=auth_cookie)).status == 200
    assert "alpha" not in json_board(board_file)["boards"]
    assert registry.snapshot() == []


async def test_reused_name_purges_an_old_board_signal(client, auth_cookie, pty, board_file, monkeypatch):
    registry = signalbus.Registry()
    monkeypatch.setattr(server, "SIGNALS", registry)
    await create(pty, "alpha")
    assert (await client.put("/api/board/alpha", json=document(), headers=auth_cookie)).status == 200
    assert registry.snapshot()
    # This path bypasses Mesh's kill route, as a ptyhost restart/crash can: the
    # next listing must still recognise a same-name new identity and forget it.
    assert await pty.request({"op": "kill", "name": "alpha"}) == {"ok": True}
    await wait_gone(pty, "alpha")
    await create(pty, "alpha")
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert [session["name"] for session in data["mesh"]] == ["alpha"]
    assert data["signals"] == []


async def test_restore_transfers_document_before_forgetting_lost(client, auth_cookie, pty, board_file, snapshot_file, tmp_path, monkeypatch):
    registry = signalbus.Registry()
    monkeypatch.setattr(server, "SIGNALS", registry)
    old = mesh_item("old", tmp_path, 22.0)
    respawn.update([old], listed=True)
    respawn.update([], listed=True)
    board.replace("old", document(elements=[{"type": "text", "text": "kept"}]), [{"name": "old", "created": 22.0}])
    registry.publish(board.updated_envelope("old", 1, 1.0))
    response = await client.post("/api/restore", json={"names": ["old"]}, headers=auth_cookie)
    body = await response.json()
    assert body["results"]["old"]["ok"]
    listed = await pty.request({"op": "list"})
    recreated = next(session for session in listed if session["name"] == "old")
    got = board.get("old", listed)
    assert got["elements"] == [{"type": "text", "text": "kept"}]
    assert board.remove("old", 22.0) is False
    assert recreated["created"] != 22.0
    assert registry.snapshot() == []


async def test_discard_removes_lost_document_and_signal(client, auth_cookie, board_file, snapshot_file, tmp_path, monkeypatch):
    registry = signalbus.Registry()
    monkeypatch.setattr(server, "SIGNALS", registry)
    old = mesh_item("old", tmp_path, 22.0)
    respawn.update([old], listed=True)
    respawn.update([], listed=True)
    board.replace("old", document(), [{"name": "old", "created": 22.0}])
    registry.publish(board.updated_envelope("old", 1, 1.0))
    response = await client.post("/api/restore/discard", json={"names": ["old"]}, headers=auth_cookie)
    assert response.status == 200
    assert "old" not in json_board(board_file)["boards"]
    assert registry.snapshot() == []


def json_board(path):
    import json
    return json.loads(path.read_text())
