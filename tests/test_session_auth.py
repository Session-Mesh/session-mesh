# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""What a session token (`Authorization: MeshSession ...`) may and may not do.

The ptyhost list is faked here; tests/test_session_e2e.py runs the same checks against
a real ptyhost and a real shell environment."""

import logging
import os

import pytest

import opens
import server
import sessiontoken
from session_helpers import NONCE, OTHER_NONCE, add_session, clean_opens, listing  # noqa: F401


@pytest.fixture
def doc(home_dir):
    path = home_dir / "note.md"
    path.write_text("# note\n")
    return path


async def post_open(client, headers, doc, **extra):
    return await client.post("/api/open", json={"target": str(doc), **extra}, headers=headers)


async def open_board(client, headers, **kwargs):
    return await client.post("/api/board/@self/open", headers=headers, **kwargs)


# ---------------------------------------------------------------- what it may do

async def test_a_session_token_opens_a_document_for_its_own_session(client, listing, doc):
    headers = add_session(listing, "alpha")
    resp = await post_open(client, headers, doc)
    assert resp.status == 200
    assert opens.OPENS[-1]["session"] == "alpha"
    assert opens.OPENS[-1]["target"] == str(doc)


async def test_a_session_token_can_request_only_its_own_board(client, listing):
    alpha = add_session(listing, "alpha")
    add_session(listing, "beta", OTHER_NONCE)
    response = await open_board(client, alpha)
    assert response.status == 200 and await response.json() == {"ok": True}
    assert opens.OPENS == [{"kind": "board-open", "session": "alpha",
                            "seq": opens.OPENS[0]["seq"], "at": opens.OPENS[0]["at"]}]


async def test_the_session_comes_from_the_token_never_the_body(client, listing, doc):
    headers = add_session(listing, "alpha")
    add_session(listing, "beta", OTHER_NONCE)
    for field in ("session", "name", "mesh_session", "id"):
        resp = await post_open(client, headers, doc, **{field: "beta"})
        assert resp.status == 200
        assert opens.OPENS[-1]["session"] == "alpha", field


async def test_a_master_request_carries_no_session_whatever_the_body_says(
        client, auth_bearer, listing, doc):
    add_session(listing, "alpha")
    resp = await post_open(client, auth_bearer, doc, session="alpha")
    assert resp.status == 200
    assert opens.OPENS[-1]["session"] is None
    resp = await post_open(client, auth_bearer, doc)
    assert opens.OPENS[-1]["session"] is None


async def test_the_session_response_carries_no_capability_url(client, listing, auth_bearer, doc):
    headers = add_session(listing, "alpha")
    body = await (await post_open(client, headers, doc)).json()
    assert body == {"kind": "file", "target": str(doc)}
    master = await (await post_open(client, auth_bearer, doc)).json()
    assert master["url"].startswith("/view/")        # unchanged for the master token


async def test_a_session_token_cannot_open_what_the_view_policy_refuses(client, listing):
    headers = add_session(listing, "alpha")
    secret = server.CONF_DIR / "token"
    resp = await client.post("/api/open", json={"target": str(secret)}, headers=headers)
    assert resp.status == 403
    assert opens.OPENS == []


@pytest.mark.parametrize("flags,expected", [
    ({}, (False, False)),
    ({"reload": True}, (True, False)),
    ({"watch": True}, (True, True)),               # watching implies reloading
    ({"reload": "yes", "watch": 1}, (False, False)),   # only real booleans count
])
async def test_reload_and_watch_are_recorded_as_booleans(client, listing, doc, flags, expected):
    headers = add_session(listing, "alpha")
    assert (await post_open(client, headers, doc, **flags)).status == 200
    entry = opens.OPENS[-1]
    assert (entry["reload"], entry["watch"]) == expected


async def test_a_watched_open_records_the_baseline_mtime(client, listing, doc):
    headers = add_session(listing, "alpha")
    await post_open(client, headers, doc, watch=True)
    assert opens.OPENS[-1]["mtime"] == str(doc.stat().st_mtime_ns)
    await post_open(client, headers, doc)
    assert "mtime" not in opens.OPENS[-1]


async def test_a_web_page_cannot_be_opened(client, listing):
    headers = add_session(listing, "alpha")
    resp = await client.post("/api/open", json={"target": "https://example.com/x", "watch": True},
                             headers=headers)
    assert resp.status == 400
    assert opens.OPENS == []


@pytest.mark.parametrize("path", ["/api/open", "/api/stat"])
async def test_an_oversized_body_is_413_before_it_is_parsed(client, listing, path):
    headers = add_session(listing, "alpha")
    huge = b'{"target": "' + b"a" * (300 * 1024) + b'"}'
    assert (await client.post(path, data=huge, headers=headers)).status == 413

    async def pieces():
        yield huge[:100000]
        yield huge[100000:]

    assert (await client.post(path, data=pieces(), headers=headers)).status == 413


@pytest.mark.parametrize("body", [b"not json", b"[1]", b"null", b'"x"'])
async def test_a_malformed_open_body_is_400(client, auth_bearer, body):
    resp = await client.post("/api/open", data=body, headers=auth_bearer)
    assert resp.status == 400


# ---------------------------------------------------------------- what it may not do

ELSEWHERE = [
    ("GET", "/api/sessions"), ("GET", "/api/dirs"), ("GET", "/api/docs"),
    ("POST", "/api/new"), ("POST", "/api/adopt"), ("POST", "/api/kill/alpha"),
    ("POST", "/api/upload"), ("POST", "/api/view"),
    ("POST", "/api/external-open"),
    ("GET", "/api/open"), ("GET", "/api/stat"), ("PUT", "/api/open"), ("DELETE", "/api/open"),
    ("GET", "/"), ("GET", "/ws/alpha"), ("GET", "/nonexistent"), ("GET", "/static/app.js"),
]


@pytest.mark.parametrize("method,path", ELSEWHERE)
async def test_a_session_token_is_401_on_every_other_route(client, listing, method, path):
    headers = add_session(listing, "alpha")
    resp = await client.request(method, path, headers=headers, allow_redirects=False)
    assert resp.status == 401, (method, path, resp.status)


@pytest.mark.parametrize("path", ["/api/open/", "/api/open%2F", "/api/Open", "/api/stat/.",
                                  "/x/../api/view", "/api/stat/../view", "/api/openx", "/api/open/x"])
async def test_a_path_that_only_resembles_an_allowed_route_is_401(client, listing, doc, path):
    headers = add_session(listing, "alpha")
    resp = await client.post(path, json={"target": str(doc), "targets": []}, headers=headers,
                             allow_redirects=False)
    assert resp.status == 401, (path, resp.status)


async def test_the_session_branch_rejects_before_it_touches_ptyhost(client, listing):
    headers = add_session(listing, "alpha")
    listing.state["requests"].clear()
    resp = await client.get("/api/sessions", headers=headers)
    assert resp.status == 401 and listing.state["requests"] == []


async def test_a_session_token_is_not_a_bearer_token(client, listing):
    token = sessiontoken.issue("alpha", NONCE)
    add_session(listing, "alpha")
    resp = await client.get("/api/sessions", headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 401


@pytest.mark.parametrize("credential", [
    f"MeshSession {server.TOKEN}",                       # the master token under the session scheme
    f"MeshSession {server.cookie_value()}",
    "MeshSession ", "MeshSession", "MeshSession  ",
])
async def test_the_master_token_is_not_a_session_token(client, listing, doc, credential):
    add_session(listing, "alpha")
    resp = await client.post("/api/open", json={"target": str(doc)},
                             headers={"Authorization": credential})
    assert resp.status == 401
    assert opens.OPENS == []


async def test_the_scheme_is_case_sensitive(client, listing, doc):
    token = sessiontoken.issue("alpha", NONCE)
    add_session(listing, "alpha")
    for scheme in ("meshsession", "MESHSESSION", "Meshsession"):
        resp = await client.post("/api/open", json={"target": str(doc)},
                                 headers={"Authorization": f"{scheme} {token}"})
        assert resp.status == 401, scheme


async def test_credentials_are_not_mixed(client, listing, auth_cookie, doc):
    # a bad session token is never rescued by a valid cookie, and the reverse
    add_session(listing, "alpha")
    forged = {"Authorization": "MeshSession ms1.alpha." + NONCE + "." + "0" * 64}
    resp = await client.post("/api/open", json={"target": str(doc)},
                             headers={**forged, **auth_cookie})
    assert resp.status == 401
    good = {"Authorization": "MeshSession " + sessiontoken.issue("alpha", NONCE)}
    resp = await client.get("/api/sessions", headers={**good, **auth_cookie})
    assert resp.status == 401        # the cookie does not widen a session token


async def test_a_session_token_still_needs_a_same_origin_post(client, listing, doc):
    headers = add_session(listing, "alpha")
    resp = await post_open(client, {**headers, "Origin": "https://evil.example"}, doc)
    assert resp.status == 403


async def test_board_open_is_token_only_and_same_origin(client, listing, auth_cookie, auth_bearer):
    token = add_session(listing, "alpha")
    for credentials in (auth_cookie, auth_bearer):
        assert (await open_board(client, credentials)).status == 401
    assert (await open_board(client, {**token, "Origin": "https://evil.example"})).status == 403
    assert opens.OPENS == []


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
async def test_board_open_has_no_other_session_token_method(client, listing, method):
    token = add_session(listing, "alpha")
    response = await client.request(method, "/api/board/@self/open", headers=token)
    assert response.status == 401
    assert opens.OPENS == []


async def test_board_open_rejects_forged_stale_and_reused_session_tokens(client, listing):
    old = add_session(listing, "alpha")
    forged = {"Authorization": "MeshSession ms1.alpha." + NONCE + "." + "0" * 64}
    assert (await open_board(client, forged)).status == 401
    assert (await open_board(client, old)).status == 200
    old_seq = opens.OPENS[-1]["seq"]
    listing.clear()
    assert (await open_board(client, old)).status == 401
    fresh = add_session(listing, "alpha", OTHER_NONCE)
    assert (await open_board(client, old)).status == 401
    assert (await open_board(client, fresh)).status == 200
    assert len(opens.OPENS) == 1
    assert opens.OPENS[-1]["session"] == "alpha" and opens.OPENS[-1]["seq"] > old_seq


@pytest.mark.parametrize("body", [b"{}", b"x", b" ", b"\x00"])
async def test_board_open_requires_an_actually_empty_body(client, listing, body):
    token = add_session(listing, "alpha")
    response = await open_board(client, token, data=body)
    assert response.status == 400
    assert opens.OPENS == []


async def test_board_open_rejects_chunked_nonempty_body_before_enqueueing(client, listing):
    token = add_session(listing, "alpha")

    async def chunks():
        yield b""
        yield b"not empty"

    response = await open_board(client, token, data=chunks())
    assert response.status == 400
    assert opens.OPENS == []


# ---------------------------------------------------------------- forgery, staleness, reuse

async def test_a_forged_token_is_401(client, listing, doc):
    add_session(listing, "alpha")
    for token in ("ms1.alpha." + NONCE + "." + "0" * 64,
                  "ms1.alpha." + NONCE + "." + sessiontoken._mac("beta", NONCE),
                  "ms1.alpha.x.y", "garbage", ""):
        resp = await post_open(client, {"Authorization": f"MeshSession {token}"}, doc)
        assert resp.status == 401, token
        assert (await resp.text()) == "401: Unauthorized"


async def test_a_token_for_a_vanished_session_is_401(client, listing, doc):
    headers = add_session(listing, "alpha")
    assert (await post_open(client, headers, doc)).status == 200
    listing.clear()
    assert (await post_open(client, headers, doc)).status == 401


async def test_a_reused_name_does_not_inherit_the_old_token(client, listing, doc):
    old = add_session(listing, "alpha", NONCE)
    listing.clear()
    new = add_session(listing, "alpha", OTHER_NONCE)
    assert (await post_open(client, old, doc)).status == 401
    assert (await post_open(client, new, doc)).status == 200


async def test_a_session_from_an_older_ptyhost_without_a_nonce_matches_no_token(client, listing, doc):
    listing.append({"name": "alpha", "meta": {"agent": None}})
    headers = {"Authorization": "MeshSession " + sessiontoken.issue("alpha", NONCE)}
    assert (await post_open(client, headers, doc)).status == 401


async def test_a_session_token_is_503_when_ptyhost_is_down(client, listing, doc):
    headers = add_session(listing, "alpha")
    listing.state["down"] = True
    assert (await post_open(client, headers, doc)).status == 503


async def test_a_forged_token_is_401_even_when_ptyhost_is_down(client, listing, doc):
    listing.state["down"] = True
    resp = await post_open(client, {"Authorization": "MeshSession ms1.a.b.c"}, doc)
    assert resp.status == 401


# ---------------------------------------------------------------- /api/stat

async def stat(client, headers, *targets):
    return await client.post("/api/stat", json={"targets": list(targets)}, headers=headers)


async def test_stat_reports_the_mtime_of_what_the_session_opened(client, listing, doc):
    headers = add_session(listing, "alpha")
    await post_open(client, headers, doc)
    resp = await stat(client, headers, str(doc))
    assert resp.status == 200
    assert (await resp.json()) == {"mtimes": {str(doc): str(doc.stat().st_mtime_ns)}}


async def test_stat_for_a_session_is_limited_to_what_that_session_opened(
        client, listing, doc, home_dir):
    headers = add_session(listing, "alpha")
    other = add_session(listing, "beta", OTHER_NONCE)
    await post_open(client, other, doc)
    unseen = home_dir / "unseen.md"
    unseen.write_text("x")
    resp = await stat(client, headers, str(doc), str(unseen))
    assert (await resp.json()) == {"mtimes": {str(doc): None, str(unseen): None}}


async def test_stat_for_the_browser_follows_the_view_policy(client, auth_bearer, doc, home_dir):
    secret = server.CONF_DIR / "token"
    missing = home_dir / "missing.md"
    resp = await stat(client, auth_bearer, str(doc), str(secret), str(missing), "/etc/passwd",
                      "https://example.com/x")
    assert (await resp.json()) == {"mtimes": {
        str(doc): str(doc.stat().st_mtime_ns), str(secret): None, str(missing): None,
        "/etc/passwd": None, "https://example.com/x": None}}


async def test_stat_sees_a_change(client, auth_bearer, doc):
    os.utime(doc, ns=(1, 1_000_000_000))
    before = (await (await stat(client, auth_bearer, str(doc))).json())["mtimes"][str(doc)]
    os.utime(doc, ns=(1, 2_000_000_000))
    after = (await (await stat(client, auth_bearer, str(doc))).json())["mtimes"][str(doc)]
    assert (before, after) == ("1000000000", "2000000000")


@pytest.mark.parametrize("body", [{}, {"targets": "x"}, {"targets": [1]}, {"targets": ["a"] * 21},
                                  {"target": "x"}, [], None])
async def test_stat_rejects_a_bad_body(client, auth_bearer, body):
    resp = await client.post("/api/stat", json=body, headers=auth_bearer)
    assert resp.status == 400


async def test_stat_needs_credentials(client):
    assert (await client.post("/api/stat", json={"targets": []})).status == 401


# ---------------------------------------------------------------- review: logs, restarts, bodies

async def test_no_token_reaches_the_logs_or_a_response_body(client, listing, auth_bearer, doc, caplog):
    caplog.set_level(logging.DEBUG)
    headers = add_session(listing, "alpha")
    token = headers["Authorization"].split(" ", 1)[1]
    bodies = []
    for creds in (headers, auth_bearer, {"Authorization": "MeshSession ms1.alpha.bad.bad"}):
        bodies.append(await (await post_open(client, creds, doc)).text())
    bodies.append(await (await client.post("/api/open", data=b"not json", headers=headers)).text())
    for secret in (token, token.split(".")[3], token.split(".")[2], server.TOKEN, server.cookie_value()):
        assert secret not in caplog.text
        assert not [b for b in bodies if secret in b]


async def test_a_token_survives_a_web_server_restart(aiohttp_client, listing, doc):
    headers = add_session(listing, "alpha")
    first = await aiohttp_client(server.make_app())
    assert (await post_open(first, headers, doc)).status == 200
    await first.close()
    second = await aiohttp_client(server.make_app())          # a new app: nothing was stored
    assert (await post_open(second, headers, doc)).status == 200


async def test_open_sequence_numbers_are_clock_seeded(client, auth_bearer, doc):
    await post_open(client, auth_bearer, doc)
    first = opens.OPENS[-1]["seq"]
    await post_open(client, auth_bearer, doc)
    assert opens.OPENS[-1]["seq"] > first
    assert first > 10 ** 12        # a restarted server starts above any earlier run's numbers
