# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Malformed inputs get 4xx, not 500 (R18)."""

import pytest


@pytest.mark.parametrize("route,body", [
    ("/api/adopt", {"pid": "x", "mode": "resume"}),
    ("/api/adopt", {"pid": None, "mode": "resume"}),
    ("/api/adopt", [1]),
    ("/api/new", "x"),
    ("/api/organize", [1]),
    ("/api/organize", {"op": "folder-add", "name": {"a": 1}}),
    ("/api/organize", {"op": "rename", "id": "s", "label": ["x"]}),
])
async def test_malformed_bodies_are_400(client, auth_bearer, pty, route, body):
    resp = await client.post(route, json=body, headers=auth_bearer)
    assert resp.status == 400, (route, body, resp.status)


async def test_nul_in_a_monaco_path_is_404(client):
    from yarl import URL
    resp = await client.get(URL("/viewlib/monaco/vs/loader.js%00", encoded=True))
    assert resp.status == 404


async def test_bad_ws_size_does_not_500(client, auth_bearer, pty):
    await pty.new("w1")
    resp = await client.get("/ws/w1?rows=abc&cols=1e999", headers=auth_bearer)
    assert resp.status != 500


async def test_a_plain_get_on_ws_attaches_nothing(client, auth_bearer, pty):
    await pty.new("w2")
    for _ in range(3):
        resp = await client.get("/ws/w2", headers=auth_bearer)
        assert resp.status == 400
    listing = await pty.request({"op": "list"})
    assert [s["attached"] for s in listing if s["name"] == "w2"] == [0]


async def test_a_trailing_newline_is_not_part_of_a_valid_name_or_id(client, auth_bearer, pty):
    # `$` also matches before a final newline: identifiers are checked with fullmatch
    import server
    for pattern, value in ((server.NAME_RE, "name"), (server.SID_RE, "abcdefgh"),
                           (server.EVENT_ID_RE, "id"), (server.EVENT_DETAIL_KEY_RE, "key")):
        assert pattern.fullmatch(value) and not pattern.fullmatch(value + "\n")
    resp = await client.post("/api/history/resume", json={"agent": "claude", "id": "abcdefgh\n"}, headers=auth_bearer)
    assert resp.status == 400
    for method, route, status in (("GET", "/api/history/claude/abcdefgh%0A", 400),
                                  ("DELETE", "/api/history/claude/abcdefgh%0A", 400),
                                  ("POST", "/api/kill/name%0A", 400), ("GET", "/ws/name%0A", 403)):
        resp = await client.request(method, route, headers=auth_bearer)
        assert resp.status == status, (method, route, resp.status, await resp.text())
        assert await resp.text() in ("400: Bad Request", "403: Forbidden"), (method, route, await resp.text())
