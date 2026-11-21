# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Every route the app registers is classified, and each class is enforced.

The table below is the contract. A route added to ``server.make_app`` without an entry
here fails ``test_every_route_is_classified``: classify it in the same PR. The enforcement tests then send real requests
for every non-public route, so a class cannot be claimed without being true.

Classes
  PUBLIC   no credential needed (the handler or its own capability does the checking)
  COOKIE   the ``mesh_auth`` cookie or the master Bearer token; a session token is 401
  COOKIE_ONLY  an authenticated browser cookie; every Authorization header is 401
  SESSION  as COOKIE, and also a valid ``MeshSession`` token
  SESSION_ONLY  a valid ``MeshSession`` token, never a broader mesh credential
"""

import pytest

import server
import sessionauth
from session_helpers import add_session, clean_opens, listing  # noqa: F401

PUBLIC, COOKIE, COOKIE_ONLY, SESSION, SESSION_ONLY = (
    "public", "cookie", "cookie-only", "session", "session-only")


# (method, canonical path of the resource) -> class. HEAD is derived from GET.
EXPECTED = {
    ("GET", "/login"): PUBLIC,
    ("POST", "/login"): PUBLIC,
    ("GET", "/favicon.svg"): PUBLIC,
    ("GET", "/manifest.webmanifest"): PUBLIC,
    ("GET", "/sw.js"): PUBLIC,
    ("GET", "/view/{tail}"): PUBLIC,            # signed capability, checked by view.py
    ("GET", "/viewlib/monaco/{tail}"): PUBLIC,  # vendored libraries, no secret
    ("GET", "/viewlib/{name}"): PUBLIC,
    ("GET", "/"): COOKIE,
    ("GET", "/static"): COOKIE,                 # except the icons and login assets in server.PUBLIC
    ("GET", "/api/sessions"): COOKIE,
    ("GET", "/api/portfolio/diff/{selector}"): COOKIE,
    ("GET", "/api/dirs"): COOKIE,
    ("POST", "/api/dirs/recent"): COOKIE_ONLY,
    ("POST", "/api/projects/v1"): COOKIE,
    ("POST", "/api/work/v1"): COOKIE,           # its write op (answer) is cookie-only: tests/work-write-api.test.ts
    ("POST", "/api/projects/artifacts/v1"): COOKIE,
    ("POST", "/api/projects/issues/v1"): COOKIE,
    ("GET", "/api/docs"): COOKIE,
    ("GET", "/api/history"): COOKIE,
    ("GET", "/api/history/search"): COOKIE,
    ("GET", "/api/history/{agent}/{sid}"): COOKIE,
    ("DELETE", "/api/history/{agent}/{sid}"): COOKIE,
    ("POST", "/api/history/resume"): COOKIE,
    ("GET", "/api/push/key"): COOKIE,
    ("POST", "/api/push/subscribe"): COOKIE,
    ("POST", "/api/push/unsubscribe"): COOKIE,
    ("POST", "/api/push/detail"): COOKIE,
    ("POST", "/api/push/act"): COOKIE,
    ("POST", "/api/logout"): COOKIE,
    ("POST", "/api/logout-all"): COOKIE,
    ("GET", "/api/transcribe/config"): COOKIE,
    ("POST", "/api/transcribe"): COOKIE,
    ("GET", "/api/transcribe/request/{request_id}"): COOKIE,
    ("GET", "/api/transcribe/{job_id}"): COOKIE,
    ("POST", "/api/transcribe/{job_id}/cancel"): COOKIE,
    ("POST", "/api/transcribe/{job_id}/settle"): COOKIE,
    ("POST", "/api/new"): COOKIE,
    ("POST", "/api/adopt"): COOKIE,
    ("POST", "/api/kill/{name}"): COOKIE,
    ("GET", "/api/demo-scene/{name}"): COOKIE,
    ("GET", "/api/demo-scene/{name}/catalog"): COOKIE,
    ("GET", "/api/demo-scene/{name}/selected"): COOKIE,
    ("GET", "/api/demo-scene/{name}/selected/revisions"): COOKIE,
    ("POST", "/api/demo-scene/{name}/selected/restore"): COOKIE,
    ("GET", "/demo-scene/{name}/{version}"): COOKIE,
    ("GET", "/demo-scene/{name}/{demo_id}/{version}"): COOKIE,
    ("GET", "/api/board/{name}"): COOKIE,
    ("PUT", "/api/board/{name}"): COOKIE,
    ("GET", "/api/board/{name}/revisions"): COOKIE,
    ("GET", "/api/board/{name}/revision"): COOKIE,
    ("GET", "/api/board/{name}/revision/diff"): COOKIE,
    ("POST", "/api/board/{name}/revision/restore"): COOKIE,
    ("GET", "/api/board/@self"): SESSION_ONLY,
    ("PUT", "/api/board/@self"): SESSION_ONLY,
    ("GET", "/api/board/@self/revisions"): SESSION_ONLY,
    ("GET", "/api/board/@self/revision"): SESSION_ONLY,
    ("GET", "/api/board/@self/revision/diff"): SESSION_ONLY,
    ("GET", "/api/board/@self/latest-change"): SESSION_ONLY,
    ("POST", "/api/board/@self/open"): SESSION_ONLY,
    ("POST", "/api/board/@self/refresh"): SESSION_ONLY,
    ("POST", "/api/board/@self/revision/restore"): SESSION_ONLY,
    ("GET", "/api/demo-scene/@self"): SESSION_ONLY,
    ("PUT", "/api/demo-scene/@self"): SESSION_ONLY,
    ("GET", "/api/demo-scene/@self/revisions"): SESSION_ONLY,
    ("POST", "/api/demo-scene/@self/open"): SESSION_ONLY,
    ("POST", "/api/demo-scene/@self/open-named"): SESSION_ONLY,
    ("GET", "/api/demo-scene/@self/catalog"): SESSION_ONLY,
    ("POST", "/api/demo-scene/@self/catalog"): SESSION_ONLY,
    ("GET", "/api/demo-scene/@self/selected"): SESSION_ONLY,
    ("PUT", "/api/demo-scene/@self/selected"): SESSION_ONLY,
    ("GET", "/api/demo-scene/@self/selected/revisions"): SESSION_ONLY,
    ("POST", "/api/demo-scene/@self/selected/restore"): SESSION_ONLY,
    # The mailbox is bound to the verified caller identity. A cookie/master
    # credential cannot speak for an arbitrary session.
    ("GET", "/api/agent-mail/@self/peers"): SESSION_ONLY,
    ("GET", "/api/agent-mail/@self/inbox"): SESSION_ONLY,
    ("POST", "/api/agent-mail/@self/read"): SESSION_ONLY,
    ("POST", "/api/agent-mail/@self/send"): SESSION_ONLY,
    ("POST", "/api/agent-mail/@self/reply"): SESSION_ONLY,
    ("POST", "/api/agent-mail/@self/ack"): SESSION_ONLY,
    ("GET", "/api/agent-mail/@self/pi-wakes"): SESSION_ONLY,
    ("POST", "/api/agent-mail/@self/pi-wake-ack"): SESSION_ONLY,
    ("GET", "/api/agent-mail/consent"): COOKIE_ONLY,
    ("GET", "/api/agent-mail/overview"): COOKIE_ONLY,
    ("GET", "/api/agent-mail/messages"): COOKIE_ONLY,
    ("GET", "/api/update/notes"): COOKIE_ONLY,
    ("GET", "/api/update/image"): COOKIE_ONLY,
    ("GET", "/api/config"): COOKIE_ONLY,
    ("POST", "/api/config/elevate"): COOKIE_ONLY,
    ("POST", "/api/config/elevate/revoke"): COOKIE_ONLY,
    ("POST", "/api/config/launch"): COOKIE_ONLY,
    ("POST", "/api/agent-mail/consent/{request_id}/decision"): COOKIE_ONLY,
    ("POST", "/api/agent-mail/consent/revoke"): COOKIE_ONLY,
    ("GET", "/api/accounts/profiles"): COOKIE_ONLY,      # tests/accounts-routes.test.ts
    ("GET", "/api/accounts/consent"): COOKIE_ONLY,
    ("POST", "/api/accounts/consent/set-global"): COOKIE_ONLY,
    ("POST", "/api/accounts/consent/set-pair"): COOKIE_ONLY,
    ("POST", "/api/accounts/consent/remove-pair"): COOKIE_ONLY,
    ("POST", "/api/accounts/consent/reset"): COOKIE_ONLY,
    ("GET", "/api/session-actions/@self/request"): SESSION_ONLY,
    ("POST", "/api/session-actions/@self/request"): SESSION_ONLY,
    ("GET", "/api/session-actions/@self/accounts"): SESSION_ONLY,
    ("POST", "/api/session-actions/{request_id}/claim"): COOKIE,
    ("POST", "/api/session-actions/{request_id}/decision"): COOKIE,
    ("POST", "/api/organize"): COOKIE,
    ("POST", "/api/restore"): COOKIE,
    ("POST", "/api/restore/discard"): COOKIE,
    ("POST", "/api/upload"): COOKIE,
    ("POST", "/api/view"): COOKIE,
    ("POST", "/api/ls"): COOKIE,
    ("POST", "/api/external-open"): COOKIE,
    ("GET", "/ws/{name}"): COOKIE,
    ("POST", "/api/open"): SESSION,
    ("POST", "/api/stat"): SESSION,
    ("POST", "/api/event"): SESSION_ONLY,
}


def registered_routes():
    """{(method, canonical): concrete path} for every route in the app, HEAD included."""
    routes = {}
    for resource in server.make_app().router.resources():
        for route in resource:
            path = resource.canonical
            if path == "/static":
                path = "/static/app.js"
            for placeholder in ("{tail}", "{name}", "{demo_id}", "{version}", "{agent}", "{sid}", "{selector}", "{request_id}"):
                path = path.replace(placeholder, "x")
            routes[(route.method, resource.canonical)] = path
    return routes


def declared(method, canonical):
    """The class of a registered (method, path); HEAD follows GET."""
    return EXPECTED.get(("GET" if method == "HEAD" else method, canonical))


def of_class(*classes):
    return sorted((key, path) for key, path in registered_routes().items()
                  if declared(*key) in classes)


# ---------------------------------------------------------------- the table is complete

def test_every_route_is_classified():
    unclassified = sorted(key for key in registered_routes() if declared(*key) is None)
    assert not unclassified, (
        f"route(s) {unclassified} have no auth class. Add each to EXPECTED in "
        "tests/test_route_auth_table.py as PUBLIC, COOKIE or SESSION.")


def test_the_table_has_no_stale_entry():
    registered = {("GET" if method == "HEAD" else method, canonical)
                  for method, canonical in registered_routes()}
    stale = sorted(set(EXPECTED) - registered)
    assert not stale, f"EXPECTED lists route(s) the app no longer registers: {stale}"


def test_the_session_routes_are_exactly_the_session_token_route_set():
    in_table = {key for key, cls in EXPECTED.items() if cls in (SESSION, SESSION_ONLY)}
    assert in_table == sessionauth.ROUTES


def test_the_public_class_matches_the_middleware_list():
    for path in server.PUBLIC:
        if path.startswith("/static/"):
            assert EXPECTED[("GET", "/static")] == COOKIE  # the icons are carved out of it
        else:
            assert EXPECTED[("GET", path)] == PUBLIC, path


# ---------------------------------------------------------------- the classes are enforced

def ids(routes):
    return [f"{method} {canonical}" for (method, canonical), _ in routes]


@pytest.mark.parametrize("key,path", of_class(COOKIE, COOKIE_ONLY, SESSION, SESSION_ONLY),
                         ids=ids(of_class(COOKIE, COOKIE_ONLY, SESSION, SESSION_ONLY)))
async def test_a_non_public_route_refuses_a_request_without_credentials(client, key, path):
    method, _ = key
    resp = await client.request(method, path, allow_redirects=False)
    assert resp.status == 401 or (resp.status == 302 and resp.headers["Location"] == "/login"), \
        (resp.status, resp.headers.get("Location"))


@pytest.mark.parametrize("key,path", of_class(COOKIE, COOKIE_ONLY),
                         ids=ids(of_class(COOKIE, COOKIE_ONLY)))
async def test_a_session_token_is_401_on_every_cookie_route(client, listing, key, path):
    headers = add_session(listing, "alpha")
    method, _ = key
    resp = await client.request(method, path, headers=headers, allow_redirects=False)
    assert resp.status == 401


@pytest.mark.parametrize("key,path", of_class(COOKIE_ONLY), ids=ids(of_class(COOKIE_ONLY)))
async def test_cookie_only_routes_reject_master_bearer(client, key, path, auth_bearer):
    method, _ = key
    resp = await client.request(method, path, headers=auth_bearer, json={}, allow_redirects=False)
    assert resp.status == 401


@pytest.mark.parametrize("key,path", of_class(SESSION), ids=ids(of_class(SESSION)))
async def test_a_session_token_is_accepted_on_the_session_routes(client, listing, key, path):
    headers = add_session(listing, "alpha")
    method, _ = key
    resp = await client.request(method, path, headers=headers, json={"target": "x", "targets": []},
                                allow_redirects=False)
    assert resp.status != 401, "the session token was refused on a SESSION route"


@pytest.mark.parametrize("key,path", of_class(SESSION_ONLY), ids=ids(of_class(SESSION_ONLY)))
async def test_a_session_token_is_accepted_only_for_the_token_only_routes(client, listing, key, path, auth_cookie, auth_bearer):
    headers = add_session(listing, "alpha")
    method, _ = key
    document = {"elements": [], "appState": {}, "files": {}, "version": 0}
    response = await client.request(method, path, headers=headers, json=document, allow_redirects=False)
    assert response.status != 401, "the session token was refused on a SESSION_ONLY route"
    for credentials in (auth_cookie, auth_bearer):
        response = await client.request(method, path, headers=credentials, json=document, allow_redirects=False)
        assert response.status == 401, "a broad mesh credential bypassed SESSION_ONLY"


@pytest.mark.parametrize("path", ["/static/icons/icon-192.png", "/static/icons/icon-512.png",
                                  "/static/icons/maskable-512.png"])
async def test_the_three_icons_are_public_though_static_is_not(client, path):
    resp = await client.get(path, allow_redirects=False)
    assert resp.status == 200
    assert (await client.get("/static/app.js", allow_redirects=False)).status == 302


@pytest.mark.parametrize("key,path", of_class(PUBLIC), ids=ids(of_class(PUBLIC)))
async def test_a_public_route_is_not_gated_by_the_mesh_credentials(client, key, path):
    method, _ = key
    resp = await client.request(method, path, allow_redirects=False)
    assert resp.status != 401
    assert resp.headers.get("Location") != "/login"
