# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The auth boundary and the same-origin check (server.py:51-104)."""

import os
from http.cookies import SimpleCookie

import pytest

import ptyhost
import server

PROTECTED = [
    ("GET", "/api/sessions"),
    ("GET", "/api/dirs"),
    ("GET", "/api/docs"),
    ("POST", "/api/new"),
    ("POST", "/api/adopt"),
    ("POST", "/api/kill/x"),
    ("POST", "/api/upload"),
    ("POST", "/api/view"),
    ("POST", "/api/projects/artifacts/v1"),
    ("POST", "/api/projects/issues/v1"),
    ("POST", "/api/open"),
    ("POST", "/api/external-open"),
]


def parse_cookie(resp):
    jar = SimpleCookie()
    for header in resp.headers.getall("Set-Cookie", []):
        jar.load(header)
    return jar


# ---------------------------------------------------------------- isolation guard

def test_import_globals_point_at_the_test_root():
    root = os.environ["SMESH_TEST_ROOT"]
    for path in (server.TOKEN_FILE, server.PENDING_FILE, server.UPLOAD_DIR, ptyhost.SOCK):
        assert str(path).startswith(root + "/"), path
    assert server.TOKEN_FILE.stat().st_mode & 0o777 == 0o600


# ---------------------------------------------------------------- unauthenticated

async def test_root_redirects_to_login(client):
    resp = await client.get("/", allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == "/login"


@pytest.mark.parametrize("method,path", PROTECTED)
async def test_api_without_credentials_is_401(client, method, path):
    resp = await client.request(method, path, allow_redirects=False)
    assert resp.status == 401


async def test_websocket_without_credentials_is_401(client):
    resp = await client.get("/ws/x", allow_redirects=False)
    assert resp.status == 401


@pytest.mark.parametrize("path", ["/login", "/favicon.svg", "/viewlib/marked.min.js"])
async def test_public_routes_need_no_credentials(client, path):
    resp = await client.get(path, allow_redirects=False)
    assert resp.status == 200


@pytest.mark.parametrize("headers", [
    {"Cookie": f"{server.COOKIE}=not-the-cookie"},
    {"Cookie": f"{server.COOKIE}={server.TOKEN}"},          # the token is not the cookie
    {"Authorization": "Bearer wrong"},
    {"Authorization": server.TOKEN},                         # missing "Bearer " prefix
    {"Authorization": f"Bearer {server.cookie_value()}"},     # the cookie is not the token
], ids=["bad-cookie", "token-as-cookie", "bad-bearer", "no-bearer-prefix", "cookie-as-bearer"])
async def test_wrong_credentials_are_401(client, headers):
    resp = await client.get("/api/sessions", headers=headers)
    assert resp.status == 401


# ---------------------------------------------------------------- authenticated

async def test_cookie_grants_index(client, auth_cookie):
    resp = await client.get("/", headers=auth_cookie)
    assert resp.status == 200
    assert "text/html" in resp.headers["Content-Type"]


async def test_cookie_grants_api_without_ptyhost(client, auth_cookie):
    resp = await client.get("/api/sessions", headers=auth_cookie)
    assert resp.status == 200
    data = await resp.json()
    assert data["mesh"] == []          # socket missing -> falls back to an empty list
    assert data["ptyhost"] is False


async def test_bearer_grants_api(client, auth_bearer):
    resp = await client.get("/api/sessions", headers=auth_bearer)
    assert resp.status == 200


# ---------------------------------------------------------------- login

async def test_login_post_with_wrong_token_redirects_to_bad(client):
    resp = await client.post("/login", data={"token": "wrong"}, allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == "/login?bad=1"
    assert server.COOKIE not in parse_cookie(resp)


async def test_login_get_with_wrong_token_sets_no_cookie(client):
    resp = await client.get("/login", params={"token": "wrong"}, allow_redirects=False)
    assert resp.status == 200
    assert server.COOKIE not in parse_cookie(resp)


async def test_an_empty_token_authenticates_nothing(client, monkeypatch):
    # load_token() refuses an empty token at startup; the checks do not rely on it
    monkeypatch.setattr(server, "TOKEN", "")
    assert not server.secret_matches("", "")
    assert not server.secret_matches("", server.cookie_value())
    resp = await client.get("/login", params={"token": ""}, allow_redirects=False)
    assert resp.status == 200 and server.COOKIE not in parse_cookie(resp)
    resp = await client.post("/login", data={"token": ""}, allow_redirects=False)
    assert resp.headers["Location"] == "/login?bad=1" and server.COOKIE not in parse_cookie(resp)
    for headers in ({"Authorization": "Bearer "}, {"Authorization": "Bearer"}, {"Cookie": f"{server.COOKIE}="}):
        assert (await client.get("/api/dirs", headers=headers)).status == 401


@pytest.mark.parametrize("token", ["jeton-é", "\udcff\udcfe", "٣" * 32])
async def test_a_non_ascii_credential_is_refused_not_an_error(client, token):
    assert not server.secret_matches(token, server.TOKEN)
    resp = await client.get("/login", params={"token": "jeton-é"}, allow_redirects=False)
    assert resp.status == 200 and server.COOKIE not in parse_cookie(resp)


@pytest.mark.parametrize("via", ["post", "get"])
async def test_login_sets_strict_httponly_cookie(client, via):
    if via == "post":
        resp = await client.post("/login", data={"token": server.TOKEN}, allow_redirects=False)
    else:
        resp = await client.get("/login", params={"token": server.TOKEN}, allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == "/"
    morsel = parse_cookie(resp)[server.COOKIE]
    assert morsel.value == server.cookie_value()
    assert morsel.value != server.TOKEN
    assert morsel["httponly"] is True
    assert morsel["samesite"].lower() == "strict"
    assert morsel["max-age"] == str(30 * 86400)
    assert not morsel["secure"]          # plain http, no proxy header


# What `tailscale serve` sends to the backend: the browser's Host kept, declared again in
# X-Forwarded-Host, and the scheme it terminated (ipn/ipnlocal/serve.go, addProxyForwardedHeaders).
TAILSCALE = {"Host": "mesh.example.ts.net", "X-Forwarded-Host": "mesh.example.ts.net",
             "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.7"}


async def test_login_behind_https_proxy_sets_secure_cookie(client):
    resp = await client.post("/login", data={"token": server.TOKEN}, headers=TAILSCALE, allow_redirects=False)
    assert resp.status == 302
    assert parse_cookie(resp)[server.COOKIE]["secure"] is True


async def test_a_bare_forwarded_proto_is_not_believed(client):
    # no proxy declared itself: the scheme stays the one of the connection
    resp = await client.post("/login", data={"token": server.TOKEN},
                             headers={"X-Forwarded-Proto": "https"}, allow_redirects=False)
    assert resp.status == 302
    assert not parse_cookie(resp)[server.COOKIE]["secure"]


# ---------------------------------------------------------------- origin

@pytest.fixture
def doc_target(home_dir):
    doc = home_dir / "origin.md"
    doc.write_text("# origin\n")
    return {"target": str(doc)}


async def test_foreign_origin_on_post_is_403(client, auth_cookie, doc_target):
    resp = await client.post("/api/view", json=doc_target,
                             headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403


async def test_missing_origin_is_allowed(client, auth_cookie, doc_target):
    # mesh-open sends no Origin; SameSite=Strict covers browsers
    resp = await client.post("/api/view", json=doc_target, headers=auth_cookie)
    assert resp.status == 200


async def test_same_host_origin_is_allowed(client, auth_cookie, doc_target):
    origin = f"http://{client.server.host}:{client.server.port}"
    resp = await client.post("/api/view", json=doc_target, headers={**auth_cookie, "Origin": origin})
    assert resp.status == 200


async def post_view(client, auth_cookie, doc_target, **headers):
    return (await client.post("/api/view", json=doc_target, headers={**auth_cookie, **headers})).status


async def test_the_origin_through_tailscale_serve_is_allowed(client, auth_cookie, doc_target):
    assert await post_view(client, auth_cookie, doc_target, Origin="https://mesh.example.ts.net", **TAILSCALE) == 200
    assert await post_view(client, auth_cookie, doc_target, Origin="https://MESH.example.ts.net", **TAILSCALE) == 200


async def test_the_scheme_of_the_origin_is_compared(client, auth_cookie, doc_target):
    direct = f"{client.server.host}:{client.server.port}"
    assert await post_view(client, auth_cookie, doc_target, Origin=f"http://{direct}") == 200
    assert await post_view(client, auth_cookie, doc_target, Origin=f"https://{direct}") == 403
    assert await post_view(client, auth_cookie, doc_target, Origin="http://mesh.example.ts.net", **TAILSCALE) == 403
    for malformed in ("null", direct, f"//{direct}", f"http://{direct}/", f"http://{direct}@evil.example", ""):
        assert await post_view(client, auth_cookie, doc_target, Origin=malformed) == (200 if malformed == "" else 403), malformed


async def test_a_forwarded_host_never_replaces_the_host_without_a_declared_proxy(client, auth_cookie, doc_target):
    # X-Forwarded-Host alone (Host is still the server's own address): not tailscale serve's shape
    forged = {"X-Forwarded-Host": "mesh.example.ts.net", "X-Forwarded-Proto": "https"}
    assert await post_view(client, auth_cookie, doc_target, Origin="https://mesh.example.ts.net", **forged) == 403
    # and it does not get in the way of the direct origin either
    direct = f"http://{client.server.host}:{client.server.port}"
    assert await post_view(client, auth_cookie, doc_target, Origin=direct, **forged) == 200


async def test_a_declared_proxy_may_rewrite_the_host(client, auth_cookie, doc_target, monkeypatch):
    # MESH_TRUST_PROXY=1: a local reverse proxy that sets Host to the backend (nginx's default)
    forwarded = {"X-Forwarded-Host": "mesh.example.org", "X-Forwarded-Proto": "https"}
    assert await post_view(client, auth_cookie, doc_target, Origin="https://mesh.example.org", **forwarded) == 403
    monkeypatch.setattr(server, "TRUST_PROXY", True)
    assert await post_view(client, auth_cookie, doc_target, Origin="https://mesh.example.org", **forwarded) == 200
    assert await post_view(client, auth_cookie, doc_target, Origin="http://mesh.example.org", **forwarded) == 403
    assert await post_view(client, auth_cookie, doc_target, Origin="https://evil.example", **forwarded) == 403


@pytest.mark.parametrize("peer,believed", [(("127.0.0.1", 5), True), (("::1", 5, 0, 0), True),
                                           (("::ffff:127.0.0.1", 5, 0, 0), True), (("192.0.2.7", 5), False),
                                           (("198.51.100.7", 5), False), ("/run/x.sock", False), (None, False)])
def test_forwarded_headers_count_only_from_a_loopback_peer(monkeypatch, peer, believed):
    from types import SimpleNamespace
    request = SimpleNamespace(scheme="http", host="mesh.example.ts.net", headers=TAILSCALE,
                              transport=SimpleNamespace(get_extra_info=lambda name: peer))
    assert server.public_origin(request) == (("https" if believed else "http"), "mesh.example.ts.net")
    monkeypatch.setattr(server, "TRUST_PROXY", True)
    request.headers = {"X-Forwarded-Host": "other.example", "X-Forwarded-Proto": "https"}
    assert server.public_origin(request) == (("https", "other.example") if believed else ("http", "mesh.example.ts.net"))


async def test_websocket_with_foreign_origin_is_403(client, auth_cookie):
    resp = await client.get("/ws/anything", headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403


async def test_websocket_with_invalid_name_is_403(client, auth_cookie):
    resp = await client.get("/ws/bad.name", headers=auth_cookie)
    assert resp.status == 403
