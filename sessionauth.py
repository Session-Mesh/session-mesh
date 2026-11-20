# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Authentication of a request that carries a session token (``Authorization: MeshSession``).

A session token is valid for ``ROUTES`` only and is judged alone: no cookie or Bearer
on the same request is looked at, and a request that cannot be authenticated this way
is refused, never handed on to the master-token check. The failure is always a bare
401, so a caller cannot tell a forged token from a stale one."""

import hmac
import math

from aiohttp import web

import sessiontoken

SCHEME = "MeshSession "
ROUTES = {("POST", "/api/open"), ("POST", "/api/stat"),
          ("GET", "/api/board/@self"), ("PUT", "/api/board/@self"),
          ("GET", "/api/board/@self/revisions"),
          ("GET", "/api/board/@self/revision"),
          ("GET", "/api/board/@self/revision/diff"),
          ("GET", "/api/board/@self/latest-change"),
          ("POST", "/api/board/@self/open"), ("POST", "/api/board/@self/refresh"),
          ("POST", "/api/board/@self/revision/restore"), ("POST", "/api/event")}
ROUTES.update({("GET", "/api/demo-scene/@self"), ("PUT", "/api/demo-scene/@self"),
               ("GET", "/api/demo-scene/@self/revisions"),
               ("POST", "/api/demo-scene/@self/open"),
               ("POST", "/api/demo-scene/@self/open-named"),
               ("GET", "/api/demo-scene/@self/catalog"),
               ("POST", "/api/demo-scene/@self/catalog"),
               ("GET", "/api/demo-scene/@self/selected"),
               ("PUT", "/api/demo-scene/@self/selected"),
               ("GET", "/api/demo-scene/@self/selected/revisions"),
               ("POST", "/api/demo-scene/@self/selected/restore")})
ROUTES.update({("GET", "/api/agent-mail/@self/peers"),
               ("GET", "/api/agent-mail/@self/inbox"),
               ("POST", "/api/agent-mail/@self/read"),
               ("POST", "/api/agent-mail/@self/send"),
               ("POST", "/api/agent-mail/@self/reply"),
               ("POST", "/api/agent-mail/@self/ack")})
ROUTES.update({("POST", "/api/session-actions/@self/request"),
               ("GET", "/api/session-actions/@self/request"),
               ("GET", "/api/session-actions/@self/accounts")})
ROUTES.update({("GET", "/api/agent-mail/@self/pi-wakes"),
               ("POST", "/api/agent-mail/@self/pi-wake-ack")})
# These routes name a session solely by a MeshSession token.  In contrast with
# ``/api/open`` and ``/api/stat``, a browser cookie or the master Bearer token
# must not be able to select a board by obtaining broader mesh authority.
TOKEN_ONLY_ROUTES = {("GET", "/api/board/@self"), ("PUT", "/api/board/@self"),
                     ("GET", "/api/board/@self/revisions"),
                     ("GET", "/api/board/@self/revision"),
                     ("GET", "/api/board/@self/revision/diff"),
                     ("GET", "/api/board/@self/latest-change"),
                     ("POST", "/api/board/@self/open"), ("POST", "/api/board/@self/refresh"),
                     ("POST", "/api/board/@self/revision/restore"), ("POST", "/api/event")}
TOKEN_ONLY_ROUTES.update({("GET", "/api/demo-scene/@self"), ("PUT", "/api/demo-scene/@self"),
                          ("GET", "/api/demo-scene/@self/revisions"),
                          ("POST", "/api/demo-scene/@self/open"),
                          ("POST", "/api/demo-scene/@self/open-named"),
                          ("GET", "/api/demo-scene/@self/catalog"),
                          ("POST", "/api/demo-scene/@self/catalog"),
                          ("GET", "/api/demo-scene/@self/selected"),
                          ("PUT", "/api/demo-scene/@self/selected"),
                          ("GET", "/api/demo-scene/@self/selected/revisions"),
                          ("POST", "/api/demo-scene/@self/selected/restore")})
TOKEN_ONLY_ROUTES.update({("GET", "/api/agent-mail/@self/peers"),
                          ("GET", "/api/agent-mail/@self/inbox"),
                          ("POST", "/api/agent-mail/@self/read"),
                          ("POST", "/api/agent-mail/@self/send"),
                          ("POST", "/api/agent-mail/@self/reply"),
                          ("POST", "/api/agent-mail/@self/ack")})
TOKEN_ONLY_ROUTES.update({("POST", "/api/session-actions/@self/request"),
                          ("GET", "/api/session-actions/@self/request"),
                          ("GET", "/api/session-actions/@self/accounts")})
TOKEN_ONLY_ROUTES.update({("GET", "/api/agent-mail/@self/pi-wakes"),
                           ("POST", "/api/agent-mail/@self/pi-wake-ack")})
ROUTES.add(("POST", "/api/session-artifacts/@self/notes"))
TOKEN_ONLY_ROUTES.add(("POST", "/api/session-artifacts/@self/notes"))


def is_session_request(request):
    return request.headers.get("Authorization", "").startswith(SCHEME)


def token_only(request):
    return ((_method(request), request.path)) in TOKEN_ONLY_ROUTES


def _method(request):
    """aiohttp derives HEAD from GET; authorise it as that same read route."""
    return "GET" if request.method == "HEAD" else request.method


async def authenticate(request, list_sessions):
    """The name and incarnation of the session the request speaks for, or HTTP 401.

    Cheapest checks first: the route, then the MAC (no I/O), then ptyhost's list, which
    must still hold a session of that name with the nonce the token was minted for."""
    token = request.headers["Authorization"][len(SCHEME):]
    claim = sessiontoken.signed(token)
    if (_method(request), request.path) not in ROUTES or claim is None:
        raise web.HTTPUnauthorized()
    sessions = await list_sessions()
    name = sessiontoken.verify(token, sessions)
    if name is None:
        raise web.HTTPUnauthorized()
    _, nonce = claim
    for session in sessions:
        meta = session.get("meta") if isinstance(session, dict) else None
        recorded = meta.get("nonce") if isinstance(meta, dict) else None
        created = session.get("created") if isinstance(session, dict) else None
        if (session.get("name") == name and isinstance(recorded, str)
                and hmac.compare_digest(recorded, nonce)
                and isinstance(created, (int, float)) and not isinstance(created, bool)
                and math.isfinite(created)):
            return name, created
    raise web.HTTPUnauthorized()
