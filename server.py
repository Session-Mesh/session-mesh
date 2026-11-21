#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""session-mesh: a small web terminal over the mesh's pseudo-terminals.

Terminals are owned by ptyhost (a separate daemon, no screen emulation); the
browser attaches through a websocket relayed to ptyhost, so xterm.js is the
real terminal. Other terminals (Terminator tabs, SSH logins…) are listed
read-only; a recognised agent running in one can be resumed in the mesh. (reptyr -T was tried and hangs while
ptrace-attached to Terminator, so it is not offered.)"""

import asyncio
import concurrent.futures
import contextlib
from collections import deque
import glob
import hashlib
import hmac
import ipaddress
import itertools
import json
import math
import os
import re
import secrets
import shlex
import shutil
import signal
import stat
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import NamedTuple

import aiohttp
from aiohttp import web

import agentmcp
import agentmail
import agentwake
import agentcap
import claudewake
import launchplan
import launchsettings
import discover
import external
import fsutil
import browse
import board
import demo_scene
import cookiegen
import codeview
import organize
import resumeargs
import respawn
import management
import observability
import opens
import portfolio
import projectartifacts
import projectissues
import history
import conversation_names
import meshpaths
import notify
import webpush
import ptyhost
import pimcp
import piwake
import sessionauth
import sessiontoken
import sessionrequests
import signalbus
import view

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CONF_DIR = meshpaths.CONF_DIR
TOKEN_FILE = CONF_DIR / "token"
GENERATION_FILE = CONF_DIR / cookiegen.FILE_NAME
SESSION_REQUESTS_FILE = CONF_DIR / "session-requests.sqlite3"
HOST = os.environ.get("MESH_HOST", "127.0.0.1")
PORT = int(os.environ.get("MESH_PORT", "7690"))
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
SID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$")   # never an option: it ends up in argv
SIGNALS = signalbus.Registry()
EVENT_TYPES = frozenset(("working", "waiting_permission", "waiting_question", "done", "error"))
EVENT_KEYS = frozenset(("v", "type", "at", "id", "detail"))
EVENT_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
EVENT_DETAIL_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
EVENT_BODY_MAX = 8192
EVENT_DETAIL_MAX = 2048
EVENT_DEDUP_MAX = 64
EVENT_BUCKET_CAPACITY = 30
EVENT_BUCKET_RATE = 10.0
# Seconds by which the wall clock may fall behind the monotonic clock since a
# finished turn before its idle evidence is withdrawn (NTP slewing is far less).
WALL_CLOCK_STEP_TOLERANCE = 1.0


def checked_listen_host(host, environ):
    """The listen address, refused before anything listens unless it is loopback (127.0.0.0/8, ::1 or
    the exact word localhost). An empty value would listen on every interface: refused too, as are the
    IPv4-mapped (::ffff:127.0.0.1) and scoped (::1%lo) forms, which do not bind. Only
    MESH_ALLOW_NON_LOOPBACK=1 (read at startup, no route changes it) lets another address through, with a
    warning: the cookie is a static HMAC of the token, so plain HTTP off the host exposes it."""
    if host == "localhost":
        return host
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    # Exactly ::1 for IPv6: the equality also rejects a scope id (::1%lo) and the mapped forms.
    if address is not None and ((address.version == 4 and address.is_loopback) or address == ipaddress.IPv6Address("::1")):
        return host
    if environ.get("MESH_ALLOW_NON_LOOPBACK") == "1":
        print(f"session-mesh: WARNING: listening on {host!r}, outside loopback (MESH_ALLOW_NON_LOOPBACK=1); "
              "the token and cookie travel in clear unless a TLS proxy fronts every request", file=sys.stderr, flush=True)
        return host
    raise SystemExit(f"session-mesh: refusing MESH_HOST={host!r}: not a loopback address "
                     "(127.0.0.0/8, ::1, localhost); set MESH_ALLOW_NON_LOOPBACK=1 to override")


if __name__ == "__main__":
    # Checked before load_token() below: a refused address leaves the config dir untouched.
    HOST = checked_listen_host(HOST, os.environ)


# ---------------------------------------------------------------- auth

# What secrets.token_urlsafe(24) yields. A shorter token is never one the mesh
# wrote whole: the server refuses to start on it rather than accept a guessable
# or empty credential.
MIN_TOKEN_CHARS = 32


def load_token():
    """The master token: created whole and 0600 from the start (never readable
    by others, never empty or partial under its name, even for an instant), in
    a 0700 config dir; loose modes are tightened. A token that is empty, too
    short or unreadable stops the server: an empty one would authenticate an
    empty credential."""
    CONF_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not os.path.lexists(TOKEN_FILE):
        fsutil.atomic_create(TOKEN_FILE, secrets.token_urlsafe(24) + "\n", mode=0o600)
    for path, mode in ((CONF_DIR, 0o700), (TOKEN_FILE, 0o600)):
        try:
            path.chmod(mode)
        except OSError as e:     # not ours (a managed or read-only config): warn, keep going
            print(f"session-mesh: cannot set mode {oct(mode)} on {path} ({e})", flush=True)
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as e:
        raise SystemExit(f"session-mesh: refusing to start: the token in {TOKEN_FILE} is unreadable ({e})")
    if len(token) < MIN_TOKEN_CHARS:
        problem = "empty" if not token else f"too short ({len(token)} characters, at least {MIN_TOKEN_CHARS} expected)"
        raise SystemExit(f"session-mesh: refusing to start: the token in {TOKEN_FILE} is {problem}. "
                         "Delete that file and start again to get a new token (browsers will have to log in again).")
    return token


TOKEN = load_token()
COOKIE = "mesh_auth"
DIFF_SELECTOR_KEY = secrets.token_bytes(32)
MAX_CONTEXTUAL_DIFF_PROCESSES = 2
GENERATION = cookiegen.Generation(GENERATION_FILE)
GENERATION.current()    # created at 0 on first run, so a damaged or unwritable file shows at startup
sessiontoken.configure(TOKEN)


def cookie_value():
    """The one cookie value valid now: bound to the generation on disk (see cookiegen.py)."""
    return cookiegen.cookie_value(TOKEN, GENERATION.current())


def secret_matches(candidate, secret):
    """Constant-time comparison of a client-supplied credential with a secret.

    Bytes are compared: hmac.compare_digest raises TypeError on a non-ASCII
    str, which would turn a wrong credential into a 500. An empty candidate or
    an empty secret never matches, whatever the other side is."""
    if not isinstance(candidate, str) or not candidate or not secret:
        return False
    try:
        supplied = candidate.encode("utf-8")
    except UnicodeEncodeError:     # header bytes that were not UTF-8 (surrogates)
        return False
    return hmac.compare_digest(supplied, secret.encode("utf-8"))


def has_owner_cookie(request):
    return secret_matches(request.cookies.get(COOKIE, ""), cookie_value())


def authed(request):
    if has_owner_cookie(request):
        return True
    # local CLI (bin/mesh-open) authenticates with the token itself
    bearer = request.headers.get("Authorization", "")
    return bearer.startswith("Bearer ") and secret_matches(bearer[7:], TOKEN)


# MESH_TRUST_PROXY=1: a local reverse proxy that sets Host to the backend's address (nginx's
# default) fronts the server, and its X-Forwarded-Host / X-Forwarded-Proto are believed.
# `tailscale serve` needs no setting: it keeps the browser's Host (see public_origin).
TRUST_PROXY = os.environ.get("MESH_TRUST_PROXY") == "1"


def _from_loopback(request):
    peer = request.transport.get_extra_info("peername") if request.transport is not None else None
    try:
        address = ipaddress.ip_address(peer[0])
    except (TypeError, ValueError, IndexError):     # no transport, a Unix socket
        return False
    address = getattr(address, "ipv4_mapped", None) or address
    return address.is_loopback


def public_origin(request):
    """(scheme, host) of the address the browser used, as far as this request proves it.

    The connection gives ("http", Host). X-Forwarded-* say otherwise only when
    the request comes from this machine (a reverse proxy runs here; a remote
    client can write any header) and, either the proxy is the kind that keeps
    the browser's Host and repeats it in X-Forwarded-Host, as `tailscale
    serve` does: then only its scheme is new information; or MESH_TRUST_PROXY=1
    declares a proxy that rewrites Host: then its X-Forwarded-Host counts too.
    A forwarded host alone never replaces Host."""
    scheme, host = request.scheme, request.host
    if not _from_loopback(request):
        return scheme, host
    forwarded_host = request.headers.get("X-Forwarded-Host")
    forwarded_proto = request.headers.get("X-Forwarded-Proto")
    if TRUST_PROXY:
        host = forwarded_host or host
    elif forwarded_host != host:
        return scheme, host
    return (forwarded_proto if forwarded_proto in ("http", "https") else scheme), host


def same_origin(request):
    """No Origin (a CLI), or exactly this server's own origin: scheme and host."""
    origin = request.headers.get("Origin")
    if not origin:
        return True
    scheme, host = public_origin(request)
    return origin.lower() == f"{scheme}://{host}".lower()


# Fetched without the cookie (the manifest, by browsers) or before login: no secrets.
# Exact paths only: a prefix would also let "/static/icons/..%2fapp.js" through.
PUBLIC = frozenset(("/login", "/favicon.svg", "/manifest.webmanifest", "/sw.js",
                    "/static/login.js", "/static/login.css",
                    "/static/icons/icon-192.png", "/static/icons/icon-512.png", "/static/icons/maskable-512.png"))

# Content-Security-Policy of the interface page (/). The page holds the owner's shells, so an
# injected script must not run even where an innerHTML forgets its esc(): no inline script, no
# eval, no foreign origin. The exceptions, each needed by something the page really does:
#   style-src 'unsafe-inline'  xterm.js 5.5 inserts <style> elements at run time, and app.js
#                              builds markup with style="" attributes (tree indentation). Inline
#                              style cannot run code; scripts stay restricted to 'self'.
#   img-src / media-src blob:  the photo and voice-note previews (URL.createObjectURL).
#   connect-src 'self'         fetch and the terminal WebSocket of the same host (CSP 3 'self'
#                              covers ws:/wss: of the page's own host and port).
#   frame-src 'self'           the panes: /view, /viewlib, /static/board.html, /demo-scene.
#   worker-src 'self'          the service worker /sw.js.
INDEX_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
             "img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; "
             "worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
# The sign-in page: its own script and style files only, no exception.
LOGIN_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; "
             "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
# The whiteboard (/static/board.html, generated by tools/build-board.mjs) carries its fetch
# policy in a <meta>; this header repeats it and adds what a <meta> cannot say: it is framed only
# by the interface itself, and submits no form. Excalidraw needs inline style, data:/blob: images
# and a blob: worker.
BOARD_CSP = ("default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-src 'none'; "
             "img-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src blob:; "
             "object-src 'none'; frame-ancestors 'self'; form-action 'none'")


# Any other file under /static opened as a document (code.html and markdown.html are raw
# templates, an SVG icon, ...) runs nothing and loads nothing.
STATIC_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox"


def static_policy(path):
    """The policy of the file a /static URL resolves to, whatever its spelling: a trailing slash
    or a dot segment still reaches the same file, so the policy follows the file, not the URL."""
    resolved = os.path.normpath(os.path.join(str(STATIC), path[len("/static/"):].strip("/")))
    return {str(STATIC / "board.html"): BOARD_CSP, str(STATIC / "index.html"): INDEX_CSP,
            str(STATIC / "login.html"): LOGIN_CSP}.get(resolved, STATIC_CSP)


async def static_page_policy(request, response):
    """on_response_prepare: every response under /static carries the policy of its file."""
    if request.path.startswith("/static/"):
        response.headers["Content-Security-Policy"] = static_policy(request.path)


@web.middleware
async def auth_mw(request, handler):
    if request.path in PUBLIC or request.path.startswith(("/view/", "/viewlib/")):
        return await handler(request)  # /view checks its own signed scope; the rest holds no secret
    if sessionauth.is_session_request(request):
        # a session token is judged alone: no cookie or Bearer is ever mixed in
        request["mesh_session"], request["mesh_session_created"] = await sessionauth.authenticate(
            request, lambda: host({"op": "list"}))
        # The verifier above has checked this claim's MAC and live incarnation.
        # Keep the nonce in request-local context only: event shadow state is
        # attached to an incarnation, never merely to a reusable session name.
        request["mesh_session_nonce"] = sessiontoken.signed(
            request.headers["Authorization"][len(sessionauth.SCHEME):])[1]
    elif sessionauth.token_only(request):
        # The board bridge has no master credential and cannot name a board.
        # Do this before ordinary cookie/Bearer authentication so those wider
        # credentials cannot be used as an accidental bypass.
        raise web.HTTPUnauthorized()
    elif not authed(request):
        if request.path.startswith("/api") or request.path.startswith("/ws"):
            raise web.HTTPUnauthorized()
        raise web.HTTPFound("/login")
    if request.method != "GET" and not same_origin(request):
        raise web.HTTPForbidden()
    return await handler(request)


def set_cookie(resp, request):
    secure = public_origin(request)[0] == "https"
    resp.set_cookie(COOKIE, cookie_value(), max_age=30 * 86400, httponly=True,
                    samesite="Strict", secure=secure)


async def api_logout(request):
    """Log this device out: the cookie is cleared here; other devices keep theirs."""
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE)
    return resp


async def api_logout_all(request):
    """Raise the cookie generation: every browser login, this one included, is revoked at once.
    The master Bearer token and the session tokens are untouched. Open terminal sockets are closed
    (they were authenticated by a cookie that no longer counts); the pages then land on /login."""
    generation = cookiegen.bump(GENERATION_FILE)
    ELEVATIONS.clear()
    ELEVATION_FAILURES.clear()
    for ws in list(request.app["sockets"]):
        await ws.close(code=aiohttp.WSCloseCode.POLICY_VIOLATION, message=b"logout")
    resp = web.json_response({"ok": True, "generation": generation})
    resp.del_cookie(COOKIE)
    return resp


async def login_page(request):
    tok = request.query.get("token")
    if tok is not None:
        if secret_matches(tok, TOKEN):
            resp = web.HTTPFound("/")
            set_cookie(resp, request)
            raise resp
        await asyncio.sleep(1)
    return web.FileResponse(STATIC / "login.html", headers={"Content-Security-Policy": LOGIN_CSP})


async def login_post(request):
    form = await request.post()
    if secret_matches(str(form.get("token", "")), TOKEN):
        resp = web.HTTPFound("/")
        set_cookie(resp, request)
        raise resp
    await asyncio.sleep(1)
    raise web.HTTPFound("/login?bad=1")


# ---------------------------------------------------------------- ptyhost

class HostNotReached(web.HTTPServiceUnavailable):
    """The connection to the PTY host failed before anything was sent: nothing was created, a retry
    is safe (unlike CreationUncertain)."""


async def host(req, timeout=None):
    """The PTY host's reply; ``timeout``: seconds instead of ptyhost.REQUEST_TIMEOUT, for a longer operation."""
    try:
        reply = await (ptyhost.request(req) if timeout is None else ptyhost.request(req, timeout))
    except ptyhost.NotSent as exc:
        raise HostNotReached(text="ptyhost is not responding (systemctl --user start session-mesh-pty)") from exc
    except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        # asyncio.TimeoutError is an OSError only from Python 3.11 on: named for 3.10
        # IncompleteReadError: an older ptyhost closes some failed requests without replying
        raise web.HTTPServiceUnavailable(text="ptyhost is not responding (systemctl --user start session-mesh-pty)")
    if isinstance(reply, dict) and reply.get("error"):
        raise web.HTTPBadRequest(text=reply["error"])
    return reply


async def unique_name(base, keep=32):
    """A free session name from ``base`` (cut to ``keep`` characters); a counter is added when taken,
    and the whole stays within the 48 characters the session token allows."""
    taken = {s["name"] for s in await host({"op": "list"})}
    base = re.sub(r"[^A-Za-z0-9_-]+", "-", base).strip("-")[:keep] or "term"
    name, i = base, 2
    while name in taken:
        suffix = f"-{i}"
        name, i = f"{base[:48 - len(suffix)]}{suffix}", i + 1
    return name


def _mesh_reach_env():
    """The port actually served and the config dir in use, always: clean_env drops MESH_* from the
    environment, and the session tools (mesh-open, mesh-event, mesh-board-mcp) must reach this mesh,
    not the default one on 7690, whether or not MESH_CONF_DIR is set."""
    return {"MESH_CONF_DIR": str(CONF_DIR), "MESH_PORT": str(PORT)}


# ---- Account aliases: accounts.json in the config folder, written by the operator on the runner and validated by
# `mesh-platform accounts` (ocaml/accounts/mesh_accounts.mli). A page only ever names an alias id; the folders
# stay here. Mesh hands the folder to the agent as CLAUDE_CONFIG_DIR or CODEX_HOME; it never reads the login
# files in it (it does read settings.json for the Claude policy check and the conversations to restore them).
ACCOUNTS_FILE = CONF_DIR / "accounts.json"
# Every folder an alias has declared while this runner ran: /view keeps refusing their login files even when
# accounts.json is later refused or the alias removed (the folders and the logins stay on disk).
ACCOUNTS_PROTECTED_FILE = CONF_DIR / "accounts-protected.json"
_ACCOUNTS_PROTECTED_MAX = 1024  # fits every credential root of a 128-profile registry, plus historical roots
ACCOUNT_ID_RE = re.compile(r"[a-z0-9-]{1,32}")
_ACCOUNT_PATH_RE = re.compile(r"/[A-Za-z0-9._+@/-]{1,1023}")
ACCOUNT_MEMBER = {"claude": ("claude_config_dir", "CLAUDE_CONFIG_DIR", "Claude"),
                  "codex": ("codex_home", "CODEX_HOME", "Codex")}
# The variables that make the agent use another credential or provider than the login kept in the alias's
# folder (Claude Code: authentication precedence in its documentation; Codex: its environment variables). A login
# shell profile may export them for the default account: an alias launch unsets them (with_account).
ACCOUNT_OVERRIDES = {
    "CLAUDE_CONFIG_DIR": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
                          "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                          "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY"),
    "CODEX_HOME": ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"),
}
ACCOUNT_AGENTS_ONLY = "An account alias applies to Claude and Codex sessions only"
ACCOUNT_UNKNOWN = "Unknown account alias (accounts.json on the runner)"
ACCOUNT_REFUSED = "Account alias refused: check accounts.json and its folders on the runner (details in the server log)"
# the first reading always runs; "file": absent, refused or ok (what an agent is told of accounts.json)
_ACCOUNTS = {"signature": "not read yet", "accounts": [], "protected": None, "file": "absent"}
DEFAULT_ACCOUNT = {"id": "default", "label": "Default account", "claude": True, "codex": True}


class AccountsUnavailable(Exception):
    """accounts.json, one of its folders, or the program that checks them was refused; ``code``: the program's
    refusal code when it gave one (accounts carry, accounts resolve); ``candidates``: the accounts an ambiguous
    name matched (accounts resolve), as the program printed them."""

    def __init__(self, reason, code=None, candidates=None):
        super().__init__(reason)
        self.code, self.candidates = code, candidates


def _accounts_signature():
    signatures = []
    for file in (CONF_DIR / "backend-profiles.json", CONF_DIR / "backend-profiles.migrated", ACCOUNTS_FILE):
        try:
            st = os.lstat(file)
            signatures.append((st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode))
        except FileNotFoundError:
            signatures.append(None)
        except OSError as exc:
            signatures.append(("unreadable", repr(exc)))
    return tuple(signatures) if any(value is not None for value in signatures) else None


async def _accounts_program(*args, timeout=10, env=None):
    """The JSON answer of `mesh-platform accounts ARGS`; AccountsUnavailable on any refusal."""
    program, proc = work_command("mesh-platform"), None
    if not program:
        raise AccountsUnavailable("mesh-platform not found")
    try:
        proc = await asyncio.create_subprocess_exec(program, "accounts", *args, env=env or work_child_env(),
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        answer = json.loads(out)
    except (OSError, ValueError, asyncio.TimeoutError) as exc:
        raise AccountsUnavailable(repr(exc)) from exc
    finally:
        if proc is not None and proc.returncode is None:
            proc.kill()
    if proc.returncode != 0 or not isinstance(answer, dict):
        code = answer.get("code") if isinstance(answer, dict) else None
        candidates = answer.get("candidates") if isinstance(answer, dict) else None
        raise AccountsUnavailable(str(answer.get("error") if isinstance(answer, dict) else answer),
                                  code if isinstance(code, str) else None,
                                  candidates if isinstance(candidates, list) else None)
    return answer


def _valid_account(value):
    """The alias as the program described it, checked again (an id, a label, absolute shell-safe folders)."""
    ok = (isinstance(value, dict) and isinstance(value.get("id"), str) and ACCOUNT_ID_RE.fullmatch(value["id"])
          and value["id"] != "default" and isinstance(value.get("label"), str) and 0 < len(value["label"]) <= 24
          and all(value.get(field) is None
                  or (isinstance(value[field], str) and _ACCOUNT_PATH_RE.fullmatch(value[field]))
                  for field, _, _ in ACCOUNT_MEMBER.values()))
    if not ok:
        raise AccountsUnavailable("unexpected answer")
    labels = value.get("backend_labels", {})
    if (not isinstance(labels, dict) or not labels.keys() <= ACCOUNT_MEMBER.keys()
            or not all(isinstance(label, str) and 0 < len(label) <= 24 for label in labels.values())):
        raise AccountsUnavailable("unexpected backend labels")
    return value


def _protected_folders(accounts, profile_roots=()):
    """The folders whose login files /view refuses: the ones declared now and every one declared before, kept in
    accounts-protected.json (never shrunk: a refused accounts.json or a removed alias leaves the logins on disk).
    A file that cannot be read or written only loses the earlier runs' folders, never this run's."""
    known = _ACCOUNTS["protected"]
    if known is None:
        known = []
        try:
            stored = json.loads(ACCOUNTS_PROTECTED_FILE.read_text())
            known = [p for p in stored if isinstance(p, str) and _ACCOUNT_PATH_RE.fullmatch(p)] \
                if isinstance(stored, list) else []
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            print(f"accounts-protected.json unreadable: {exc!r}", flush=True)
    declared = [a[field] for a in accounts for field, _, _ in ACCOUNT_MEMBER.values() if a.get(field)]
    declared.extend(p for p in profile_roots if isinstance(p, str) and _ACCOUNT_PATH_RE.fullmatch(p))
    merged = list(dict.fromkeys([*known, *declared]))[-_ACCOUNTS_PROTECTED_MAX:]
    if merged != known:
        try:
            fsutil.atomic_write(ACCOUNTS_PROTECTED_FILE, json.dumps(merged))
        except OSError as exc:
            print(f"accounts-protected.json not written: {exc!r}", flush=True)
    _ACCOUNTS["protected"] = merged
    return list(dict.fromkeys([*merged, *declared]))  # never truncate a currently declared credential root


async def declared_accounts():
    """The native resolver's aliases; a configured profile registry supersedes legacy accounts.json.
    An invalid registry never silently falls back to legacy credentials."""
    signature = await asyncio.to_thread(_accounts_signature)
    if signature != _ACCOUNTS["signature"]:
        accounts, state, protected = [], "absent", []
        if signature is not None:
            try:
                answer = await _accounts_program("list", str(ACCOUNTS_FILE))
                accounts, state = [_valid_account(value) for value in answer.get("accounts") or []], "ok"
                protected = answer.get("protected_roots", [])
                if not isinstance(protected, list) or not all(isinstance(p, str) and _ACCOUNT_PATH_RE.fullmatch(p) for p in protected):
                    raise AccountsUnavailable("unexpected protected roots")
            except AccountsUnavailable as exc:
                print(f"accounts.json refused, no alias offered: {exc}", flush=True)
                accounts, state, protected = [], "refused", []
        _ACCOUNTS.update(signature=signature, accounts=accounts, file=state)
        view.deny_account_files(await asyncio.to_thread(_protected_folders, accounts, protected))
    return _ACCOUNTS["accounts"]


def accounts_projection():
    """What a page is told of the aliases: id, label and which agents each serves, never a folder."""
    return [{"id": a["id"], "label": a["label"], "claude": bool(a.get("claude_config_dir")),
             "codex": bool(a.get("codex_home")),
             **({"backend_labels": a["backend_labels"]} if "backend_labels" in a else {})} for a in _ACCOUNTS["accounts"]]


def account_label(account, backend=None):
    """The label of a known alias, or its id (an alias removed from the file since)."""
    return next((a.get("backend_labels", {}).get(backend, a["label"])
                 for a in _ACCOUNTS["accounts"] if a["id"] == account), account)


def session_account(session):
    """The alias a session was started with (its meta), or None."""
    account = (session.get("meta") or {}).get("account")
    return account if isinstance(account, str) and ACCOUNT_ID_RE.fullmatch(account) else None


def account_folder(account, kind):
    """The folder of ``kind`` (claude, codex) the alias declares, from the last reading, or None."""
    field = ACCOUNT_MEMBER.get(kind, (None,))[0]
    found = next((a for a in _ACCOUNTS["accounts"] if a["id"] == account), None)
    return found.get(field) if found and field else None


async def account_environment(account, agent):
    """{CLAUDE_CONFIG_DIR|CODEX_HOME: folder} of an alias for an agent, its folder created (0700) if missing;
    {} for the default account (None). Refused (400) for another agent, an unknown alias, or an alias without
    a folder for this agent: never a silent fall back to the default account."""
    if account is None:
        return {}
    if agent not in ACCOUNT_MEMBER:
        raise web.HTTPBadRequest(text=ACCOUNT_AGENTS_ONLY)
    if not any(a["id"] == account for a in await declared_accounts()):
        raise web.HTTPBadRequest(text=ACCOUNT_UNKNOWN)
    field, variable, shown = ACCOUNT_MEMBER[agent]
    try:
        prepared = _valid_account((await _accounts_program("prepare", str(ACCOUNTS_FILE), account)).get("account"))
    except AccountsUnavailable as exc:   # the reason names folders: the log only, never the page
        print(f"account alias {account} refused: {exc}", flush=True)
        raise web.HTTPBadRequest(text=ACCOUNT_REFUSED) from exc
    if not prepared.get(field):
        raise web.HTTPBadRequest(text=f"The account alias {prepared['label']} has no {shown} folder")
    return {variable: prepared[field]}


def with_account(command, environment):
    """The launch line run with the alias's variable: ``env -u OVERRIDE… VAR=folder command``. The variables that
    would put another credential first (ACCOUNT_OVERRIDES, perhaps exported by the login shell's profile) are
    unset, so the agent uses the alias's login. ptyhost only forwards MESH_* names; ``env`` because csh and tcsh
    refuse ``VAR=value command``."""
    if not environment:
        return command
    unset = [f"-u {name}" for variable in environment for name in ACCOUNT_OVERRIDES.get(variable, ())]
    assigned = [f"{name}={shlex.quote(value)}" for name, value in environment.items()]
    return " ".join(["env", *unset, *assigned, command])


async def _pi_runtime():
    try:
        return await asyncio.to_thread(pimcp.prepare, CONF_DIR)
    except pimcp.PiUnavailable as exc:
        raise web.HTTPServiceUnavailable(text=str(exc)) from exc


def _pi_command(command, runtime):
    argv = shlex.split(command)
    if not argv or argv[0] != "pi":
        raise web.HTTPBadRequest(text="Non-canonical Pi command")
    executable, overlay = runtime
    extension = Path(__file__).with_name("pi_mesh_wake.mjs")
    return f"PI_CODING_AGENT_DIR={shlex.quote(str(overlay))} " + shlex.join(
        [executable, "--extension", str(extension), *argv[1:]])


OPENCODE_UNSUPPORTED_RESUME_REFUSED = ("This OpenCode version is not supported by session-mesh (only 1.x and 2.x are): "
                                       "a conversation cannot be resumed")
OPENCODE_UNREADABLE_RESUME_REFUSED = ("The OpenCode version could not be read (opencode not found, or no version "
                                      "answer): a conversation cannot be resumed")
OPENCODE_UNKNOWN_SESSION = ("OpenCode 2 would start an empty conversation: the conversation is not in OpenCode's "
                            "store, resume refused")
_OPENCODE_RESUME_ARGS = {"--session", "-s", "--continue", "-c", "--fork"}


def _opencode_resumed_id(words):
    """The conversation ``--session``, ``-s`` or ``--session=`` names in an OpenCode command, if any."""
    for index, word in enumerate(words):
        if word in ("--session", "-s"):
            return words[index + 1] if index + 1 < len(words) else ""
        if word.startswith("--session="):
            return word.split("=", 1)[1]
    return None


async def _opencode_command(command, cwd="/"):
    """The command line of an OpenCode session and the notice it carries (None when supported).

    The per-session configuration (board server, Mesh event plugin) travels in the environment, and
    ptyhost only forwards MESH_* names: set it on the command, as Pi's overlay is.

    The line is typed into the user's interactive shell, so it is visible on the screen, in the replay
    and in the shell's history: the configuration must never hold a secret (opencode_config adds none).
    ``env`` carries the assignment because ``VAR=value command`` is not valid in csh and tcsh.

    OpenCode 1.x: the v1 configuration.  OpenCode 2.x: ``--standalone`` (a private server, so the
    configuration and MESH_SESSION_TOKEN are this terminal's own, not those of a shared background service),
    the v2 configuration and plugin, only the options 2.x takes, and a resumed conversation that is checked
    in OpenCode's store first (an unknown ``--session`` would create an empty one).  Any other major, or a
    version that cannot be read, gets no injection at all (see agentmcp): the line is
    ``env -u MESH_SESSION_TOKEN opencode ...`` so the shell's session token is not inherited, and a request
    to resume a conversation is refused."""
    executable, major = await asyncio.to_thread(agentmcp.opencode_resolved)
    words = shlex.split(command)
    if executable and words and words[0] == "opencode":
        # The binary that was read is the one that runs, not whatever the terminal's shell finds first.
        words[0] = executable
    if major == 1:
        config = agentmcp.opencode_config(reach=_mesh_reach_env())
        return f"env {agentmcp.OPENCODE_CONFIG_ENV}={shlex.quote(config)} {shlex.join(words)}", None
    if major == 2:
        return await _opencode_v2_command(words, cwd), None
    unreadable = major is None
    if any(word.split("=", 1)[0] in _OPENCODE_RESUME_ARGS for word in words):
        raise web.HTTPConflict(text=OPENCODE_UNREADABLE_RESUME_REFUSED if unreadable
                               else OPENCODE_UNSUPPORTED_RESUME_REFUSED)
    notice = agentmcp.OPENCODE_UNREADABLE_NOTICE if unreadable else agentmcp.OPENCODE_UNSUPPORTED_NOTICE
    return f"env -u MESH_SESSION_TOKEN {shlex.join(words)}", notice


async def _opencode_v2_command(words, cwd):
    try:
        words = resumeargs.opencode2_command(words)
    except resumeargs.OpenCode2Refused as exc:
        raise web.HTTPConflict(text=str(exc)) from exc
    resumed = _opencode_resumed_id(words)
    if resumed is not None and not await asyncio.to_thread(discover.opencode_session_exists, resumed):
        raise web.HTTPConflict(text=OPENCODE_UNKNOWN_SESSION)
    off = await asyncio.to_thread(agentmcp.opencode_user_disabled_servers, cwd)
    config = agentmcp.opencode_config_v2(reach=_mesh_reach_env(),     # unreadable: no server is injected
                                         disabled=agentmcp.MESH_SERVER_NAMES if off is None else off)
    return f"env {agentmcp.OPENCODE_CONFIG_ENV}={shlex.quote(config)} {shlex.join(words)}"


COPILOT_CONVERSATION_UNKNOWN = ("The conversation of a Copilot running outside the mesh cannot be known (no hook reports it, "
                                "and a /new or /resume may have changed it since it started): the agent was not stopped")


class GeminiSettingsRefused(web.HTTPServiceUnavailable):
    """The user's Gemini settings cannot be read faithfully: this launch is refused (503 for a direct launch).
    A batch (restore) reports it for that entry only; ptyhost being down is a plain 503 and stops the batch."""


async def _gemini_command(command):
    """Gemini reads its settings from GEMINI_CLI_HOME: a private overlay of the user's ~/.gemini with the
    board server and the state hooks (agentmcp.gemini_home). Refused when the user's settings are unreadable."""
    try:
        home = await asyncio.to_thread(agentmcp.gemini_home, CONF_DIR, _mesh_reach_env())
    except (OSError, ValueError) as exc:
        raise GeminiSettingsRefused(text=f"Gemini settings: {exc}") from exc
    assignments = " ".join(f"{name}={shlex.quote(value)}"
                           for name, value in agentmcp.gemini_environment(home).items())
    return f"env {assignments} {command}"


def _copilot_command(command):
    """Copilot CLI takes the board server and the Mesh state plugin as options of this run, and its
    hooks find the event helper through MESH_EVENT_BIN (ptyhost only forwards MESH_* names, so it is set
    on the command, through ``env`` because ``VAR=value command`` is not valid in csh and tcsh). Mesh's own
    options come last: Copilot lets a later --additional-mcp-config win."""
    argv = shlex.split(command)
    if not argv or argv[0] != "copilot":
        raise web.HTTPBadRequest(text="Non-canonical Copilot command")
    own = agentmcp.copilot_args(reach=_mesh_reach_env())
    helper = shlex.quote(str(agentmcp.runtime_bin() / "mesh-event"))
    return f"env {agentmcp.COPILOT_EVENT_ENV}={helper} {shlex.join([*argv, *own])}"   # env: csh and tcsh refuse VAR=value cmd


class VibeLaunch(NamedTuple):
    """A Vibe command ready to start, with the id of the hooks directory it names (None without one)."""
    command: str
    hooks: str | None


def _vibe_launch(command, cwd):
    """Mistral Vibe takes its board server from VIBE_MCP_SERVERS and its state hooks from the
    ``.vibe/hooks.toml`` of a directory given with ``--add-dir`` (agentmcp.vibe_hooks_dir); ptyhost only
    forwards MESH_* names, so both are set on the command: the line is ``/bin/sh -c '<script>' sh vibe ...`` (not
    ``VAR=value command``, which csh and tcsh refuse, and not ``env VAR=value``, whose argv would hold the
    expanded token).  The session token stays a ``"$MESH_SESSION_TOKEN"`` word of the script, which the inner
    ``sh`` expands from its environment before it execs Vibe: no command line or file holds its value.

    Blocking (it reads the configuration files and writes the hooks directory); everything that can fail
    is done here, so a caller runs it before stopping anything.  HTTP 409/503 for what it refuses."""
    argv = shlex.split(command)
    if not argv or os.path.basename(argv[0]) != "vibe":
        # Without the hooks and the board entry the session would start silently bare: say so instead.
        raise web.HTTPBadRequest(text="Non-canonical Vibe command")
    launch_id = f"vibe-{secrets.token_hex(12)}"
    try:
        limits = {name: agentmcp.vibe_user_limits(cwd, name=name) for name in agentmcp.MESH_SERVER_NAMES}
        hooks = agentmcp.vibe_hooks_dir(CONF_DIR, launch_id)
    except agentmcp.VibeRefused as exc:
        raise web.HTTPConflict(text=f"Mistral Vibe: {exc}") from exc
    except (OSError, MemoryError) as exc:
        raise web.HTTPServiceUnavailable(
            text=f"Mistral Vibe: the hooks directory could not be prepared ({type(exc).__name__}): no Vibe session was started") from exc
    words = [argv[0], *(["--add-dir", hooks] if hooks else []), *argv[1:]]
    value = agentmcp.vibe_mcp_value(_mesh_reach_env(), limits)
    if value is None:
        return VibeLaunch(shlex.join(words), launch_id if hooks else None)
    # The pty shell expands every unquoted "$VAR" of the line before it runs the command, so the token must
    # not be written there (it would reach the argv of the first process, readable in /proc/<pid>/cmdline).
    # The script is one single-quoted argument of ``/bin/sh -c`` (an absolute path: a ``sh`` found through the
    # PATH of the pty shell could be any program a writable PATH directory names): the inner ``sh`` expands
    # the token from its inherited environment and execs Vibe, so no argument of any process holds the value.
    # The tracker's MESH_SESSION and WL_HOME are expanded the same way (agentmcp.vibe_shell_words).
    script = (f'export {agentmcp.VIBE_MCP_ENV}={shlex.quote(value[0])}"$MESH_SESSION_TOKEN"'
              f'{agentmcp.vibe_shell_words(value[1])}; exec "$@"')
    return VibeLaunch(f"/bin/sh -c {shlex.quote(script)} sh {shlex.join(words)}", launch_id if hooks else None)


async def _prepare_vibe(command, cwd):
    return await asyncio.to_thread(_vibe_launch, command, cwd)


async def sweep_vibe_hooks(grace=agentmcp.VIBE_HOOKS_GRACE):
    """Delete the hooks directories no live session claims (its end, a failed launch, a crash); the
    PTY host's list says which ones are claimed.  Nothing is deleted while the host does not answer."""
    try:
        listed = await ptyhost.request({"op": "list"})
    except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError, RecursionError):
        return 0        # ValueError: a reply that is not JSON (UnicodeDecodeError and JSONDecodeError are)
    if not isinstance(listed, list):
        return 0
    keep = {item["meta"].get("vibe_hooks") for item in listed
            if isinstance(item, dict) and isinstance(item.get("meta"), dict)}
    return await asyncio.to_thread(agentmcp.purge_vibe_hooks, CONF_DIR, keep, grace)


async def vibe_hooks_sweeper(app):
    """Sweep at start (leftovers of a crash or of an older layout), then every minute.  Every round, the
    first included, is guarded: one bad round must not end the task for the life of the server.  The grace
    also applies at start: a launch in flight has made its directory but is not in the host's list yet."""
    while True:
        try:
            await sweep_vibe_hooks()
        except Exception as e:
            print(f"vibe hooks sweep: {e!r}", flush=True)
        await asyncio.sleep(60)


async def start_vibe_hooks_sweeper(app):
    app["vibe_hooks_task"] = asyncio.create_task(vibe_hooks_sweeper(app))


async def stop_vibe_hooks_sweeper(app):
    app["vibe_hooks_task"].cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await app["vibe_hooks_task"]


OUTSIDE_WORKSPACE_ROOTS = "Folder outside the allowed workspace roots"
GEMINI_IN_HOME = ("Gemini CLI is not started in the home directory: it would take the real ~/.gemini "
                  "for a project folder (settings loaded twice, hooks run twice, ~/.agents/skills not "
                  "found). Choose a subfolder.")
# The same text for a restart refused before the agent is stopped: a whole literal, so that the table of server
# messages (static/i18n/server-messages.json) can give it its own row.
GEMINI_IN_HOME_AGENT_KEPT = ("Gemini CLI is not started in the home directory: it would take the real ~/.gemini "
                             "for a project folder (settings loaded twice, hooks run twice, ~/.agents/skills not "
                             "found). Choose a subfolder. The agent was not stopped.")


def _is_home_directory(cwd):
    try:
        return os.path.realpath(cwd) == os.path.realpath(Path.home())
    except (OSError, RuntimeError, ValueError):
        return False


NAME_TAKEN = "Name already taken"
REPLY_NOT_UNDERSTOOD = "ptyhost reply not understood: the session may still appear"


class CreationUncertain(web.HTTPServiceUnavailable):
    """The `new` request was sent to the PTY host and its outcome is unknown (timeout, transport
    error): the session may still appear. Any other 503 of new_session came before the send."""


async def _send_new(request):
    """Send a `new` request. HostNotReached when the connection failed (nothing was sent), the host's own
    refusal as it is (final), and CreationUncertain for anything after the send (a timeout, a transport
    error, a reply that cannot be read): the session may still appear."""
    try:
        await host(request)
    except HostNotReached:
        raise
    except web.HTTPServiceUnavailable as exc:
        raise CreationUncertain(text=exc.text) from exc
    except web.HTTPException:   # the host's own refusal (an error reply): final
        raise
    except Exception as exc:   # noqa: BLE001  after the send (a malformed reply): the session may still appear
        print(f"new: ptyhost reply not understood: {exc!r}", flush=True)
        raise CreationUncertain(text=REPLY_NOT_UNDERSTOOD) from exc


async def new_session(base, cwd, command=None, agent=None, known_agent=None, keep=32, pi_runtime=None,
                      notice=None, vibe=None, opencode=None, exact=False, nonce=None, conversation=None,
                      account=None, account_env=None):
    """Start a session. Every way to start one ends here ("New session", a
    conversation resumed from the history, a restored session, an agent moved
    in from another terminal, a restart), so workspace_roots is applied here.
    ``vibe`` is a VibeLaunch prepared earlier (before an agent was stopped): its command replaces
    ``command``, and its hooks directory is recorded in the session so that the sweeper keeps it.
    ``opencode`` is the (command, notice) pair ``_opencode_command`` returned earlier, for the same reason:
    its private probe (``opencode api get <target> --standalone``, with ``/api/config`` and a URL-encoded
    ``location[directory]`` query parameter for ``cwd``) is run once per launch.
    ``exact``: the name is ``base`` or nothing (409 when taken), never a suffixed one.
    ``nonce``: the session nonce, when the caller recorded it before the creation (exact restore).
    ``conversation``: (agent, id, evidence) of the conversation the command launches (_send_launch).
    ``account``: the operator's alias whose folder the agent runs with (account_environment), None: the default.
    ``account_env``: its account_environment, when the caller prepared it (replace_session: a shell started
    without its command, which comes later)."""
    if not LAUNCH_SETTINGS.allows_cwd(cwd):
        raise web.HTTPForbidden(text=OUTSIDE_WORKSPACE_ROOTS)
    if known_agent == "gemini" and _is_home_directory(cwd):
        raise web.HTTPBadRequest(text=GEMINI_IN_HOME)
    if account_env is None:
        account_env = await account_environment(account, known_agent if command else None)
    if exact:
        if any(s.get("name") == base for s in await host({"op": "list"})):
            raise web.HTTPConflict(text=NAME_TAKEN)
        name = base
    else:
        name = await unique_name(base, keep)
    if known_agent == "pi" and command:
        command = _pi_command(command, pi_runtime or await _pi_runtime())
    if known_agent == "opencode" and command:
        command, notice = opencode or await _opencode_command(command, cwd)
    if known_agent == "gemini" and command:
        command = await _gemini_command(command)
    if known_agent == "copilot" and command:
        command = _copilot_command(command)
    if known_agent == "vibe" and command:
        vibe = vibe or await _prepare_vibe(command, cwd)
        command = vibe.command
    nonce = nonce or sessiontoken.new_nonce()
    if known_agent == "claude" and command:
        command = await asyncio.to_thread(claudewake.launch_command, command, nonce, CLAUDE_WAKE_DIR,
                                          cwd, ptyhost.clean_env(account_env))
    if command:
        command = with_account(command, account_env)
    env = {"MESH_SESSION": name, "MESH_SESSION_TOKEN": sessiontoken.issue(name, nonce), **_mesh_reach_env()}
    meta = {"agent": agent, "known_agent": known_agent, "nonce": nonce, **({"notice": notice} if notice else {}),
            **({"account": account} if account_env else {})}
    if vibe and vibe.hooks:
        meta["vibe_hooks"] = vibe.hooks
    await _send_launch({"op": "new", "name": name, "cwd": cwd, "command": command, "env": env, "meta": meta},
                       conversation)
    return name


async def _send_launch(request, conversation):
    """Send a `new` request. With ``conversation`` (agent, id, evidence), the id is first recorded as
    ``chosen`` in the identity registry (I2), durably: when it cannot be, or another live session holds
    that conversation in the registry (whatever the source: the listing may not show it), nothing is
    sent (a record that failed after its file was replaced is dropped again). A refusal that is final
    drops the record again; a cancellation or an unknown outcome keeps it
    (the session may still appear)."""
    agent, sid, evidence = conversation or (None, None, None)
    pattern = respawn.CONVERSATION_RE.get(agent)
    if not (pattern and isinstance(sid, str) and pattern.fullmatch(sid)):   # an id of another form is not recorded
        return await _send_new(request)
    session = {"name": request["name"], "created": None, "nonce": request["meta"]["nonce"]}
    live = [{"name": s["name"], "created": s["created"], "nonce": s["meta"].get("nonce")}
            for s in await host({"op": "list"})]
    try:
        state = await asyncio.to_thread(respawn.claim_identity, session, agent, sid, "chosen", evidence,
                                        live=live, required=True)
    except OSError as exc:   # the file may hold the record although its folder was not flushed: nothing is sent
        print(f"new: conversation of {request['name']} not recorded: {exc!r}", flush=True)
        await _forget_launch(session)
        raise web.HTTPConflict(text="The conversation could not be recorded: nothing was started") from exc
    if state == "held":
        raise web.HTTPConflict(text=CONVERSATION_RUNNING_REFUSAL)
    if state != "active":
        await _forget_launch(session)
        raise web.HTTPConflict(text="This conversation is claimed by another session: nothing was started")
    try:
        await _send_new(request)
    except (CreationUncertain, asyncio.CancelledError):   # the session may still appear: its record stays
        raise
    except BaseException:
        await _forget_launch(session)
        raise


CONVERSATION_RUNNING_REFUSAL = "This conversation is already running (another session): nothing was started"


async def _forget_launch(session):
    """Drop the record of a launch refused for good; a failure is logged, never raised over the refusal."""
    try:
        await asyncio.to_thread(respawn.forget_identity, session)
    except OSError as exc:
        print(f"new: conversation record of {session['name']} not dropped: {exc!r}", flush=True)


async def _prepared_launch(known_agent, command, cwd):
    """(command, notice, vibe) of an agent launch prepared while the source still runs: everything that can
    fail is done here, before anything is stopped."""
    notice = vibe = None
    if known_agent == "pi":
        command = _pi_command(command, await _pi_runtime())
    elif known_agent == "opencode":
        command, notice = await _opencode_command(command, cwd)
    elif known_agent == "gemini":
        command = await _gemini_command(command)
    elif known_agent == "copilot":
        command = _copilot_command(command)
    elif known_agent == "vibe":
        vibe = await _prepare_vibe(command, cwd)
        command = vibe.command
    return command, notice, vibe


# How long _wait_source_gone waits: past the PTY host's SIGKILL of a session that ignores SIGHUP (kill_if: SIGHUP
# again after 0.25, 0.5, 1, 2 and 4 s, then SIGKILL 4 s later, 11.75 s after the first), so that such a source,
# an agent that is the session's program among them, ends before the replacement starts instead of leaving it dormant.
SOURCE_GONE_TIMEOUT = 15


async def _wait_source_gone(old_name, old_created, standby):
    """Wait (SOURCE_GONE_TIMEOUT at most) until the stopped incarnation is no longer listed; 503 naming the standby
    session when it is still there."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SOURCE_GONE_TIMEOUT
    while True:
        listed = await host({"op": "list"})
        if not any(item.get("name") == old_name and item.get("created") == old_created for item in listed):
            return
        if loop.time() >= deadline:
            raise web.HTTPServiceUnavailable(text=f"Conversation still active; standby session waiting: {standby}")
        await asyncio.sleep(0.05)


class AccountSwitchUndone(Exception):
    """The conversation could not be carried to the other account: it resumed under its own, in session ``name``."""

    def __init__(self, name, code, reason):
        super().__init__(reason)
        self.name, self.code = name, code


async def replace_session(old_name, old_created, base, cwd, command, agent, known_agent, account=None,
                          switch=None, source=None):
    """Prepare a dormant shell, retire the source, then start the replacement.

    ``source``: the source's listing item. When its PTY host serves ``agent_relaunch_v1``, the agent restarts in
    the same session and terminal instead (relaunch_in_place), under the same rules.

    A failed spawn leaves the source intact.  The replacement receives no
    agent command until ``kill_if`` has claimed the exact old incarnation and that incarnation left the listing.
    ``kill_if`` signals the shell's process group, and SIGKILL follows only while the shell lives: an agent that
    ignores SIGHUP in another group of the session (job control on) or in the shell's group (job control off) can
    outlive it and run the conversation beside the replacement.  With an older PTY host this remains possible; with
    one that serves ``agent_relaunch_v1`` the whole session is replaced only after the ``no_shell`` refusal, where the
    agent is the session's leader, which SIGKILL ends before the replacement starts.
    ``account``: the source's alias, kept by the replacement (refused before
    anything is stopped when it can no longer be used, never the default).
    ``switch``: (target alias or None for the default account, carry) of an account switch: the replacement runs
    under the target once ``await carry()`` copied the conversation, after the source stopped. When the carry
    fails, the conversation resumes under ``account`` and AccountSwitchUndone names that session.
    """
    if known_agent in IN_PLACE_AGENTS and _relaunches_in_place(source):
        try:
            return await relaunch_in_place(source, cwd, command, agent, known_agent, account, switch)
        except WholeSessionOnly as exc:   # nothing was signalled: the whole session is replaced, as before
            print(f"agent of {old_name} not stopped alone ({exc}): replacing the session", flush=True)
    return await _replace_with_new_session(old_name, old_created, base, cwd, command, agent, known_agent, account,
                                           switch)


async def _replace_with_new_session(old_name, old_created, base, cwd, command, agent, known_agent, account, switch):
    """replace_session in a new session: the PTY host stops the whole source (kill_if)."""
    target = switch[0] if switch else account
    account_env = await account_environment(target, known_agent)
    source_env = await account_environment(account, known_agent) if switch else account_env
    command, notice, vibe = await _prepared_launch(known_agent, command, cwd)
    name = await new_session(base, cwd, None, agent, known_agent, keep=48, notice=notice, vibe=vibe,
                             account=target, account_env=account_env)
    listed = await host({"op": "list"})
    replacement = next((item for item in listed if item.get("name") == name), None)
    if replacement is None:
        raise web.HTTPServiceUnavailable(text="ptyhost did not confirm the prepared session")
    saved = await _arrangement_of(old_name, old_created)
    killed = await host({"op": "kill_if", "name": old_name, "created": old_created})
    if killed != {"ok": True}:
        await host({"op": "kill_if", "name": name, "created": replacement["created"]})
        raise web.HTTPConflict(text="Session replaced or stop already requested")
    await _carry_arrangement((old_name, old_created), name, saved, replacement["created"])
    await _wait_source_gone(old_name, old_created, name)
    if switch:
        try:
            await switch[1]()
        except AccountsUnavailable as exc:   # nothing changed under the source account: the conversation goes on there
            print(f"account switch of {old_name} undone: {exc}", flush=True)
            standby = (name, replacement["created"])   # what the owner arranged meanwhile is on the standby
            saved = await _arrangement_of(*standby) or saved
            await host({"op": "kill_if", "name": name, "created": replacement["created"]})
            resumed = await new_session(base, cwd, command, agent, known_agent, keep=48, account=account,
                                        account_env=source_env)
            await _carry_arrangement(standby, resumed, saved)
            raise AccountSwitchUndone(resumed, exc.code or "carry_failed", str(exc)) from exc
    await _start_replacement(replacement, cwd, command, known_agent, account_env)
    return name


async def _start_replacement(replacement, cwd, command, known_agent, account_env):
    """Start the agent in the prepared ``replacement`` session (its listing item), once its source is gone."""
    if known_agent == "claude":
        command = await asyncio.to_thread(claudewake.launch_command, command,
                                          replacement["meta"].get("nonce"), CLAUDE_WAKE_DIR,
                                          cwd, ptyhost.clean_env(account_env))
    command = with_account(command, account_env)
    started = await host({"op": "start_if", "name": replacement["name"],
                          "created": replacement["created"], "command": command})
    if started != {"ok": True}:
        raise web.HTTPServiceUnavailable(
            text=f"Conversation stopped, but a standby session is available: {replacement['name']}")


async def _arrangement_of(name, created):
    """organize.arrangement of the incarnation (name, created), None when it cannot be read: logged, and the restart
    goes on without it."""
    try:
        return await asyncio.to_thread(organize.arrangement, name, created)
    except (OSError, ValueError) as exc:
        print(f"organisation of {name} not read before its restart: {exc!r}", flush=True)
        return None


async def _carry_arrangement(source, name, saved, created=None):
    """Give session ``name`` (incarnation ``created``, else the one the host lists now) the label, folder and rank
    of the incarnation ``source`` (name, created) it continues; ``saved``: organize.arrangement of ``source`` read
    before it stopped. A failure is logged: the restart itself goes on."""
    try:
        if created is None:
            created = next((s["created"] for s in await host({"op": "list"}) if s.get("name") == name), None)
        if created is not None:
            await asyncio.to_thread(organize.carry, source, (name, created), saved)
    except (OSError, ValueError, web.HTTPException) as exc:
        print(f"organisation of {source[0]} not carried to {name}: {exc!r}", flush=True)


# The agents the PTY host recognises in a terminal's foreground (mesh_ptyhost.ml, is_agent_name): only these
# restart in place. Pi is not among them.
IN_PLACE_AGENTS = frozenset(("claude", "codex", "opencode", "gemini", "copilot", "vibe"))

# stop_agent_if answers within about 4 s (SIGKILL 3 s after SIGHUP, then 1 s, and its process scans): the server
# waits well beyond that, so that a late reply is never taken for a host that does not answer.
STOP_AGENT_TIMEOUT = 15

# The refusals of stop_agent_if (mesh_pty_agent_stop.mli) after which the whole session is replaced, as before the
# operation existed: the agent is the session's leader, which kill_if ends (SIGKILL while it lives) before the
# replacement starts. Nothing was signalled. After any other refusal the request fails and nothing is stopped: a
# program that is not the agent is never stopped, and when the host cannot see what runs (process_scan_failed,
# no_terminal) or the agent shares the shell's group (no_job_control), kill_if could leave an agent that ignores
# SIGHUP running beside the replacement (it outlives its shell, and SIGKILL follows only while the shell lives).
WHOLE_SESSION_REASONS = frozenset(("no_shell",))

_NOT_SEEN = ("ptyhost cannot tell what holds the terminal of session {name}: nothing was stopped. Quit the agent "
             "there, then resume the conversation")

# What the operator can do about the other refusals.
STOP_REFUSALS = {
    "process_scan_failed": _NOT_SEEN,
    "no_terminal": _NOT_SEEN,
    "no_job_control": "The shell of session {name} runs the agent without job control: it cannot be stopped alone, "
                      "and nothing was stopped. Quit the agent there, then resume the conversation",
    "unsupported_foreground": "Another program holds the terminal of session {name}: nothing was stopped. Quit it, or "
                              "bring the agent back to the foreground, then ask again",
    "agent_not_foreground": "The agent of session {name} does not hold its terminal (it runs in the background, or "
                            "beside another agent): nothing was stopped. Bring it to the foreground, then ask again",
}


class WholeSessionOnly(Exception):
    """stop_agent_if refused without signalling anything, for a reason of WHOLE_SESSION_REASONS."""


def _relaunches_in_place(source):
    """Whether the PTY host serving ``source`` (a listing item) can restart its agent in the same terminal."""
    capabilities = source.get("pty_capabilities") if isinstance(source, dict) else None
    return isinstance(capabilities, list) and "agent_relaunch_v1" in capabilities


async def relaunch_in_place(source, cwd, command, agent, known_agent, account=None, switch=None):
    """Stop the agent of session ``source`` and start it again in the same session, shell and terminal: the PTY host
    (stop_agent_if) answers once the old agent is gone, so no two processes ever run the conversation, and the
    session continues as a new incarnation (its ``created``) with its name, attachments and output. Everything that
    can fail is prepared before the stop. ``switch``: as for replace_session; the carry runs between the stop and
    the start, and when it fails the agent resumes under ``account`` in the same terminal (AccountSwitchUndone)."""
    if known_agent == "gemini" and _is_home_directory(cwd):   # new_session's refusal, before anything stops
        raise web.HTTPBadRequest(text=GEMINI_IN_HOME)
    target = switch[0] if switch else account
    account_env = await account_environment(target, known_agent)
    source_env = await account_environment(account, known_agent) if switch else account_env
    command, notice, vibe = await _prepared_launch(known_agent, command, cwd)
    saved = await _arrangement_of(source["name"], source["created"])
    incarnation = (source["name"], source["created"])
    try:
        created = await _stop_agent(source, known_agent)
    except web.HTTPServiceUnavailable:   # a late reply: the agent may be stopped all the same, the session moved on
        await _carry_arrangement(incarnation, source["name"], saved)
        raise
    # the new incarnation keeps the session's label, folder and rank (bound to ``created``, which moved on)
    await _carry_arrangement(incarnation, source["name"], saved, created)
    launch = (source, created, cwd, command, agent, known_agent, notice, vibe)
    if switch:
        try:
            await switch[1]()
        except AccountsUnavailable as exc:   # nothing changed under the source account: the conversation goes on there
            print(f"account switch of {source['name']} undone: {exc}", flush=True)
            await _start_in_place(*launch, account, source_env)
            raise AccountSwitchUndone(source["name"], exc.code or "carry_failed", str(exc)) from exc
    await _start_in_place(*launch, target, account_env)
    return source["name"]


def _not_started_again(name):
    return web.HTTPServiceUnavailable(
        text=f"Conversation stopped; its agent could not be started again in session {name}")


async def _stop_agent(source, known_agent):
    """stop_agent_if on the incarnation ``source``: the new ``created`` once the agent is gone. WholeSessionOnly or
    HTTPConflict when the host stopped nothing. A reply that comes too late is checked in the listing: when the
    incarnation moved on, the agent was stopped and the session is still there, and the error says so."""
    try:
        stopped = await host({"op": "stop_agent_if", "name": source["name"], "created": source["created"],
                              "agent": known_agent}, timeout=STOP_AGENT_TIMEOUT)
    except web.HTTPServiceUnavailable:
        if await _incarnation_moved_on(source):
            raise _not_started_again(source["name"]) from None
        raise
    if isinstance(stopped, dict) and stopped.get("ok") is True and _finite_number(stopped.get("created")):
        return stopped["created"]
    reason = stopped.get("reason") if isinstance(stopped, dict) else None
    reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,40}", reason) else "refused"
    if reason in WHOLE_SESSION_REASONS:
        raise WholeSessionOnly(reason)
    if reason in STOP_REFUSALS:
        raise web.HTTPConflict(text=STOP_REFUSALS[reason].format(name=source["name"]))
    raise web.HTTPConflict(text=f"The agent was not stopped ({reason}): nothing was started")


async def _incarnation_moved_on(source):
    """Whether session ``source`` (same name, same shell) is now listed as another incarnation."""
    try:
        listed = await host({"op": "list"})
    except web.HTTPException:
        return False
    return any(isinstance(item, dict) and item.get("name") == source["name"] and item.get("pid") == source.get("pid")
               and item.get("created") != source["created"] for item in listed or ())


async def _start_in_place(source, created, cwd, command, agent, known_agent, notice, vibe, account, account_env):
    """Start the agent in the incarnation stop_agent_if left (``created``), under ``account``, with the session's
    meta for that launch (as new_session writes it; the nonce, hence the session token, is kept). A Claude's wake
    socket path follows from the nonce: the socket the stopped Claude left there is removed first, so that the new
    one can listen on it."""
    nonce = (source.get("meta") or {}).get("nonce")
    if known_agent == "claude":
        await asyncio.to_thread(claudewake.clear_socket, CLAUDE_WAKE_DIR, nonce)
        command = await asyncio.to_thread(claudewake.launch_command, command, nonce, CLAUDE_WAKE_DIR,
                                          cwd, ptyhost.clean_env(account_env))
    meta = {"agent": agent, "known_agent": known_agent, **({"nonce": nonce} if nonce else {}),
            **({"notice": notice} if notice else {}), **({"account": account} if account_env else {}),
            **({"vibe_hooks": vibe.hooks} if vibe and vibe.hooks else {})}
    started = await host({"op": "start_if", "name": source["name"], "created": created,
                          "command": with_account(command, account_env), "meta": meta})
    if started != {"ok": True}:
        raise _not_started_again(source["name"])


# ---------------------------------------------------------------- listing

HOST_PIDS = set()   # ptyhost pid(s): their shells are mesh sessions, not external ones


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _valid_ptyhost_list_item(item):
    """Whether one delivered ptyhost list item is safe for every consumer below.

    This deliberately preserves ptyhost's own name authority: its names need
    only be non-empty text here, not a server-side name policy.  It validates
    just the complete shape emitted by ``Session.info()`` before discovery,
    organization, event and snapshot code can treat the reply as observation.
    """
    return (isinstance(item, dict)
            and isinstance(item.get("name"), str) and bool(item["name"])
            and isinstance(item.get("pid"), int) and not isinstance(item["pid"], bool) and item["pid"] > 0
            and isinstance(item.get("cwd"), str)
            and _finite_number(item.get("created")) and _finite_number(item.get("activity"))
            and isinstance(item.get("attached"), int) and not isinstance(item["attached"], bool)
            and item["attached"] >= 0 and isinstance(item.get("meta"), dict))


def _valid_ptyhost_list(reply):
    """A list is authoritative only when every item has the ptyhost list shape."""
    return isinstance(reply, list) and all(_valid_ptyhost_list_item(item) for item in reply)


def _session_notice(raw):
    notice = (raw.get("meta") or {}).get("notice")
    return notice if notice in (agentmcp.OPENCODE_UNSUPPORTED_NOTICE, agentmcp.OPENCODE_UNREADABLE_NOTICE) else None


def _mesh_order(d):
    """Sessions created since the last move first (newest on top), then the owner's order."""
    return d["rank"] is not None, d["rank"] if d["rank"] is not None else -d["created"]


def _account_fields(session):
    """A listed session's alias and its label (shown on the row and the pane header), or nothing."""
    account = session_account(session)
    meta = session.get("meta") or {}
    return {"account": account, "account_label": account_label(account, meta.get("known_agent") or meta.get("agent"))} if account else {}


def list_sessions(mesh_raw, listed=True, read_at=None):
    with discover.listing_scope():      # one codex process scan for the whole listing
        return _list_sessions(mesh_raw, listed, read_at)


def _list_sessions(mesh_raw, listed, read_at=None):
    procs = discover.snapshot()
    for s in mesh_raw:
        if s["pid"] in procs:
            HOST_PIDS.add(procs[s["pid"]][2])
    mesh = []
    org = organize.view(mesh_raw, prune=listed, read_at=read_at)
    for s in mesh_raw:
        d = discover.describe(procs, s["pid"])
        known_agent = (s.get("meta") or {}).get("known_agent")
        d.update(id=s["name"], name=s["name"], kind="mesh", created=s["created"],
                 attached=s["attached"], activity=s["activity"],
                 known_agent=known_agent if known_agent in AGENT_TYPES else None,
                 notice=_session_notice(s), **_account_fields(s),
                 **org["sessions"][s["name"]])
        if d["notice"]:     # launched bare: no state, no conversation, nothing to resume or restore
            d["agent"] = None
        mesh.append(d)
    mesh.sort(key=_mesh_order)
    term = discover.external_sessions(procs, exclude_parents={os.getpid(), *HOST_PIDS})
    term.sort(key=lambda d: -((d["agent"] or {}).get("updated") or 0))
    discover.drop_duplicate_guessed_ids(mesh + term)
    for t in term:
        t["pending"] = t["pid"] in PENDING
    data_folders = org["folders"]
    return {"mesh": mesh, "external": term, "folders": data_folders, "moved": {f"t{k}": v for k, v in DONE.items()},
            "opens": opens.OPENS,
            "home": str(Path.home()), "now": time.time()}


# The hook state of the running app. Every listing applies it, not only the page's: a listing that
# did not (the snapshot loop, the watcher, an action) would record the session without the agent state
# and conversation its hooks reported, and that record is what a restore resumes.
_LIVE_EVENT_STATE = None


async def _read_host():
    """The host's listing, whether it succeeded, the host's identity on both sides of it, when it listed
    (wall clock), and its order: time.monotonic() at the start of the read, which orders reads."""
    listed, order = True, time.monotonic()
    # The host's identity on both sides of the listing: a restart in between leaves it unknown.
    host_before = await ptyhost.host_identity()
    try:
        raw = await ptyhost.request({"op": "list"})
    except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError, json.JSONDecodeError,
            UnicodeDecodeError, RecursionError):
        raw, listed = [], False   # ptyhost slow or gone: show nothing, forget nothing
    else:
        # A delivered JSON value can still be a malformed list reply.  It has
        # no authority to stand in for an empty observed inventory, and is not
        # an excuse to mask unrelated programming errors with a broad catch.
        if not _valid_ptyhost_list(raw):
            raw, listed = [], False
    at = time.time()    # when the host listed them: what a listing of these rows observed (conversation_names)
    return raw, listed, host_before if host_before == await ptyhost.host_identity() else None, at, order


_RECORDED = [0.0]   # the order (_read_host) of the host list whose description the snapshot last recorded


async def _record_listing(data, read, order):
    """The writes of a listing: the recovery snapshot, and the prune of the organisation when
    ``read`` is None (``read``: the host's listing the rows come from, already pruned).

    The two files are deliberately separate, but their *meaning* is one transition: a recovery
    entry must not retain a folder name that the live mesh view has already replaced.  Callers
    which can race an organisation mutation run this under the organisation lock, which also
    covers folder rename and recovery assignment; the reads of the listing stay outside it.
    Those read the host again here, inside the lock: a listing read before a restore created a
    session, and pruned after the restore wrote that session's organisation, would not know the
    session and would forget its label, folder and rank. Every session the host lists is
    ``seen`` by the snapshot, also one the listing did not describe: its previous entry is
    kept, it is never taken for a lost one. A description of an older host list (``order``) than the
    one already recorded is never written over it."""
    read_at = time.time()   # an organisation bound after this (a restart's carry) is not judged by this list
    raw, listed, host, _, _ = read or await _read_host()
    if not listed:
        return [], False
    seen = {(s["name"], s["created"]) for s in raw}
    if read is None:
        org = await asyncio.to_thread(organize.view, raw, True, read_at)
        data["mesh"] = [d for d in data["mesh"] if (d["name"], d["created"]) in seen]
        for d in data["mesh"]:
            d.update(org["sessions"][d["name"]])
        data["mesh"].sort(key=_mesh_order)
        data["folders"] = org["folders"]
    if order < _RECORDED[0]:
        return await asyncio.to_thread(respawn.restorable), False
    _RECORDED[0] = order
    nonces = {(s["name"], s["created"]): (s.get("meta") or {}).get("nonce") for s in raw}   # binds identities
    return await asyncio.to_thread(respawn.record, data["mesh"], True, host=host, seen=seen,
                                   nonces=nonces, order=order)


async def sessions(event_state=None, organisation_lock=None):
    return (await _listing(event_state, organisation_lock))[0]


async def _listing(event_state=None, organisation_lock=None, read=None):
    """One full listing, and whether the host listed. ``read``: the host's listing, already read."""
    if event_state is None:
        event_state = _LIVE_EVENT_STATE
    await declared_accounts()
    read_at = None if read else time.time()   # what a restart's carry bound after it is not judged by this list
    read = read or await _read_host()
    raw, listed, _, observed_at, order = read
    # ``list_sessions`` does CPU/filesystem discovery in a worker.  With a lock, it only reads: the
    # prune of the organisation is a write, made under the lock (_record_listing).  Keep the mutable
    # open queue on the event-loop thread: pruning it from the worker could race a board-open request.
    data = await asyncio.to_thread(list_sessions, raw, listed and organisation_lock is None, read_at)
    if event_state is not None and listed:
        # Before the recovery snapshot below: the conversation an OpenCode plugin reported is
        # what a restart restores.
        _apply_hook_state(event_state, data["mesh"], raw, history_identity=False)
        await run_history_identity(_apply_history_identity, data["mesh"])   # reads the index: off the loop, and off HISTORY_READS
    await asyncio.to_thread(conversation_names.observe, data["mesh"], listed=listed, now=observed_at)
    await asyncio.to_thread(conversation_names.active_aliases, data["mesh"])
    data["restorable"], durable = [], False
    if listed:   # lock order: restore_lock, then organisation_lock; only the latter is taken here
        async with organisation_lock or contextlib.AsyncExitStack():
            data["restorable"], durable = await _record_listing(data, None if organisation_lock else read, order)
    if durable:   # the list was read and the offers are on disk: agent mail may be pruned again
        agentmail.release_pruning()
    # A failed listing says nothing about which live session identities exist.
    # In particular it must not turn an ordinary ptyhost hiccup into a purge of
    # every shadow hint, dedup window and rate bucket.
    if event_state is not None and listed:
        # This is deliberately aggregate-only: it lets the owner assess the
        # hook experiment through the already authenticated listing without
        # giving a hook sender, the browser UI, or another process new power.
        data["hook_shadow"] = event_state.report()
    # Replace the worker's compatibility snapshot on the event-loop thread:
    # pruning the mutable queue in that worker could race an authenticated
    # board-open request. Listings run in parallel: one of an older host list than the one recorded
    # (_RECORDED) prunes nothing by liveness, it would forget a session created since its read.
    stale = listed and order < _RECORDED[0]
    live_open_identities = {session.get("name"): session.get("created") for session in raw
                            if isinstance(session, dict) and isinstance(session.get("name"), str)
                            and isinstance(session.get("created"), (int, float))}
    data["opens"] = opens.snapshot(None if stale else live_open_identities)
    if listed and not stale:
        _purge_invalid_board_signals(raw)
    data["ptyhost"] = bool(raw) or ptyhost.SOCK.exists()
    recovery = await asyncio.to_thread(respawn.management_lost, data["now"])
    data["management"] = await asyncio.to_thread(management.snapshot, data["mesh"], data["external"],
                                                   listed, recovery, data["now"], order)
    data["management"] = await asyncio.to_thread(observability.enrich, raw=raw,
                                                   management=data["management"], listed=listed,
                                                   now=data["now"])
    # The worktree observer gets only CWDs from this just-authenticated snapshot;
    # it has no route or client-selected path and cannot alter a repository.
    data["portfolio"] = portfolio.observed_inventory(data["mesh"], listed=listed,
                                                       observed_at=data["now"])
    await portfolio.collect_worktrees(data["portfolio"], root=ROOT, observed_at=data["now"])
    # The selector is issued only inside this authenticated listing after the
    # same CWD was observed as a repository.  It binds that directory to one
    # current session incarnation; it is not a path API.
    portfolio.attach_diff_selectors(data["portfolio"], key=DIFF_SELECTOR_KEY, now=data["now"])
    # A snapshot is intentionally non-consuming: another logged-in browser
    # must not lose its local hint because this one happened to refresh first.
    data["signals"] = SIGNALS.snapshot()
    return data, listed


async def _update_notice(failed=None):
    """The PTY host's update notice (a dict), None for a reply without one (an older host answers an error),
    ``failed`` when the request fails (a silent one is bounded by its timeout). Never raises (cancellation aside)."""
    try:
        reply = await ptyhost.request({"op": "update_notice"})
        update = reply.get("update") if isinstance(reply, dict) and reply.get("ok") is True else None
        return update if isinstance(update, dict) else None
    except Exception:    # any failure of this optional notice must leave /api/sessions intact
        return failed


# ---- "What's new" (static/update-notes.ts): the notes of the announced release, which the PTY host keeps from the
# releases list it already fetches, and their images, which `mesh-platform update-image` checks and fetches
# (ocaml/lib/mesh_update_image.mli). Both routes only relay, for the owner's page alone.
async def _update_notes(request, query):
    _require_owner_cookie(request)
    if not same_origin(request) or request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise web.HTTPForbidden()
    if list(request.query) != query:
        raise web.HTTPBadRequest()
    try:
        notes = (await ptyhost.request({"op": "update_notes"})).get("notes")
    except Exception:  # an older host or a failure: no notes, as with none announced
        notes = None
    if not isinstance(notes, dict) or not isinstance(notes.get("body"), str):
        raise web.HTTPNotFound(text="no release notes")
    return notes


async def api_update_notes(request):
    return web.json_response(await _update_notes(request, []), headers={"Cache-Control": "no-store"})


async def api_update_image(request):
    """The program reads {"url", "notes"} and answers one JSON line, {"status"[, "type"]}, then the image."""
    notes, proc = await _update_notes(request, ["url"]), None
    query = json.dumps({"url": request.query["url"], "notes": notes["body"]}).encode()
    env = work_child_env() | {k: os.environ[k] for k in ("MESH_CACHE_DIR", "MESH_UPDATE_IMAGE_TEST_HOSTS") if k in os.environ}
    try:
        proc = await asyncio.create_subprocess_exec(work_command("mesh-platform") or "", "update-image", env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        head, _, body = (await asyncio.wait_for(proc.communicate(query), 40))[0].partition(b"\n")
        status, kind = (answer := json.loads(head))["status"], answer.get("type")
    except (OSError, ValueError, KeyError, TypeError, asyncio.TimeoutError):
        status = 502
    finally:
        if proc is not None and proc.returncode is None:
            proc.kill()
    if status != 200:
        return web.Response(status=status if status in (400, 404, 413, 415, 429) else 502, headers={"Cache-Control": "no-store"})
    return web.Response(body=body, content_type=kind, headers={
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin"})


def _wait_setting(text):
    """MESH_SESSIONS_WAIT in seconds: 2 when unset, or when not a decimal number >= 0 (said once)."""
    if re.fullmatch(r"[0-9]{1,6}(\.[0-9]*)?", text or "2"):
        return float(text or 2)
    print(f"session-mesh: MESH_SESSIONS_WAIT={text!r} is not a number of seconds; using 2", flush=True)
    return 2.0


# How long a request without ``since`` (a page load, or a client that expects a session it just created to be
# listed) waits for a read of the host's list that starts after it (or for the round it also asks for), before
# it answers from the state as it is: a session created before the request is listed (ready: false) however
# long a round lasts. A request with ``since`` never waits: a round reads /proc and the transcripts.
SESSIONS_WAIT = _wait_setting(os.environ.get("MESH_SESSIONS_WAIT"))
# Tests only: such a request waits for its whole round, also before the first listing and past a silent host.
WAIT_COMPLETE = os.environ.get("MESH_TEST_SESSIONS_COMPLETE") == "1"
HOST_SILENT_AFTER = 1.0     # a host list pending longer: answers say host "silent"
REMOVED_KEEP = 600          # seconds a removal stays answerable to ``since``


class SessionsState:
    """What GET /api/sessions answers: the session list kept by the one background round
    (snapshot_loop), never a listing per request. Each read of the host's list is published at once
    (membership): a session it newly lists is a row with ``ready: false`` built from the host's list,
    mesh.json and the recovery snapshot until a round describes it; before the first listing, every row
    is (the skeleton). ``generation`` grows when a row's public content changes; it starts from the start
    time in ms, so that it never goes back across a restart. See docs/sessions-api.md."""

    def __init__(self):
        self.generation = self.floor = int(time.time() * 1000)
        self.instance = secrets.token_hex(8)   # this process: a generation of another one means nothing here
        self.rows, self.marks, self.removed = {}, {}, {}   # name -> row, (generation, print), (generation, time)
        self.top, self.external_mark, self.ready = None, (self.generation, None), 0
        self.texts = {"external": "[]", "folders": "[]", "management": '{"state": "pending"}'}   # top's, encoded
        self.host, self.identity, self.reading, self.listed = "ok", None, {}, (0.0, set())
        self.extras = {"update": None, "sessionRequests": [], "agentMailConsent": []}
        self.started, self.finished, self.read_done = 0, 0, 0.0   # rounds; the order of the newest read handled
        self.wanted, self.read_wanted, self._tick, self._extras = asyncio.Event(), asyncio.Event(), asyncio.Event(), None

    def changed(self):
        self._tick.set()
        self._tick = asyncio.Event()

    def silent(self):
        """A failed last read, or a read pending too long that started after the last one handled."""
        now = time.monotonic()
        return self.host == "silent" or any(now - began > HOST_SILENT_AFTER
                                            for began in self.reading.values() if began > self.read_done)

    async def wait(self, seconds):
        """Ask for a round and a read of the host's list, and wait, at most ``seconds``, for the first read
        that starts after this request to be published (or fail), or for the round; at most HOST_SILENT_AFTER
        while the host is known silent (its last read failed). With WAIT_COMPLETE, for the round."""
        self.wanted.set()
        self.read_wanted.set()
        ticket, start = self.started + 1, time.monotonic()   # the next round to start begins after this request

        def answered():
            waited = time.monotonic() - start
            if self.finished >= ticket or waited > seconds:
                return True
            return not WAIT_COMPLETE and (self.read_done >= start or self.host == "silent" and waited > HOST_SILENT_AFTER)
        while seconds > 0 and not answered():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._tick.wait(), 0.05)

    def publish(self, rows, top):
        """Take the rows of a listing and its other fields; one generation for every changed row."""
        now, fresh, changed = time.time(), {}, []
        for row in rows:
            fresh[row["name"]] = row
            mark = json.dumps(row, sort_keys=True, default=str)
            if self.marks.get(row["name"], (0, None))[1] != mark:
                changed.append((row["name"], mark))
        gone = [name for name in self.rows if name not in fresh]
        external = json.dumps(top.get("external"), sort_keys=True, default=str)
        if changed or gone or external != self.external_mark[1]:
            self.generation += 1
        for name, mark in changed:
            self.marks[name] = self.generation, mark
            self.removed.pop(name, None)
        for name in gone:
            del self.marks[name]
            self.removed[name] = self.generation, now
        if external != self.external_mark[1]:
            self.external_mark = self.generation, external
        for name, (generation, at) in list(self.removed.items()):
            if now - at > REMOVED_KEEP:    # older ``since`` values get a full answer
                del self.removed[name]
                self.floor = max(self.floor, generation)
        self.rows, self.top = fresh, top
        self.texts = {key: json.dumps(value, default=str) for key, value in top.items() if key != "now"}
        self.ready = sum(row["ready"] for row in fresh.values())
        self.changed()

    def answer(self, since, **fields):
        """The JSON text of an answer: the rows changed after ``since`` (a generation) and the names
        removed since, or every row (``full``) when ``since`` is absent or unknown here. The listing's
        texts are encoded once, by publish, not again for each of the pages that poll; ``now`` is the
        answer's time."""
        delta = self.top is not None and since is not None and self.floor <= since <= self.generation
        texts = self.texts
        rows = [self.marks[name][1] for name in self.rows if not delta or self.marks[name][0] > since]
        if delta:
            fields["removed"] = [name for name, (generation, _) in self.removed.items() if generation > since]
            if self.external_mark[0] <= since:
                texts = {key: text for key, text in texts.items() if key != "external"}
        fields.update(self.extras, client_version=client_version(), restore_guard=RESTORE_GUARD, now=time.time(),
                      generation=self.generation, full=not delta, counts={"total": len(self.rows), "ready": self.ready},
                      complete=self.top is not None and self.ready == len(self.rows), instance=self.instance,
                      host="silent" if self.silent() else self.host)
        parts = [f"{json.dumps(key)}: {text}" for key, text in texts.items()]
        return "{" + ", ".join([*parts, json.dumps(fields)[1:-1], f'"mesh": [{",".join(rows)}]']) + "}"

    async def read(self, key):
        """The host's list (_read_host); while it is pending, ``reading[key]`` says since when."""
        self.reading[key] = time.monotonic()
        try:
            return await _read_host()
        finally:
            del self.reading[key]

    async def read_loop(self):
        """Read the host's list whenever a request asks, apart from the rounds, and publish it."""
        while True:
            await self.read_wanted.wait()
            self.read_wanted.clear()
            try:
                await self.membership(await self.read("request"))
            except Exception as e:   # one bad read must not end the loop
                print(f"sessions: host read: {e!r}", flush=True)

    def live(self, rows):
        """The first row of each session of the latest host list among ``rows``, in the listing's order."""
        kept = {}
        for row in rows:
            if (row["name"], row["created"]) in self.listed[1]:
                kept.setdefault(row["name"], row)
        return sorted(kept.values(), key=_mesh_order)

    async def membership(self, read):
        """Publish a host list at once: the sessions it newly lists as rows with ``ready: false``, from the
        host's list, mesh.json and the recovery snapshot only (no /proc, no transcript), and without the
        sessions it no longer lists. A read older than the latest one published changes nothing; else a
        failed one makes the host "silent", a successful one ends that. Then ``read_done`` holds its order,
        unless a newer read is published, or being published: that one sets it when its rows are."""
        raw, listed, _, _, order = read
        if order >= self.listed[0]:
            self.host = "silent" if not listed else "ok" if self.host == "silent" else self.host
            if listed:
                await self._members(raw, order)
        if order >= self.listed[0]:
            self.read_done = max(self.read_done, order)
        self.changed()

    def _attached(self, raw):
        """The current rows whose attachment count differs from the host's, with the host's count."""
        return [dict(row, attached=s["attached"]) for s in raw if (row := self.rows.get(s["name"]))
                and row["created"] == s["created"] and row.get("attached") != s["attached"]]

    async def _members(self, raw, order):
        self.listed = order, {(s["name"], s["created"]) for s in raw}
        new = [s for s in raw if self.rows.get(s["name"], {}).get("created") != s["created"]]
        if self.top is not None and not new and not self._attached(raw) and len(self.rows) == len(raw):
            return
        org = await asyncio.to_thread(organize.view, raw, False)
        known = await asyncio.to_thread(respawn.provisional)
        if order < self.listed[0]:   # a newer read was published meanwhile; rows: as a round published them since
            return
        rows = []
        for s in new:
            entry = known.get((s["name"], s["created"])) or {"agent": None, "cmd": None}
            notice, kind = _session_notice(s), (s.get("meta") or {}).get("known_agent")
            agent = entry["agent"] and not notice and dict(entry["agent"], provisional=True)
            rows.append({"id": s["name"], "name": s["name"], "kind": "mesh", "created": s["created"], "pid": s["pid"],
                         "cwd": s["cwd"], "cmd": entry["cmd"] or "", "attached": s["attached"], "activity": s["activity"],
                         "known_agent": kind if kind in AGENT_TYPES else None, "notice": notice, "agent": agent or None,
                         **_account_fields(s),
                         "ready": False, **org["sessions"][s["name"]]})
        self.publish(self.live([*self._attached(raw), *self.rows.values(), *rows]), self.top or {
            "external": [], "folders": org["folders"], "home": str(Path.home()), "restorable": [],
            "management": {"state": "pending"}, "ptyhost": True,
            "opens": opens.snapshot({s["name"]: s["created"] for s in raw})})

    def read_extras(self, app):
        """Start reading the answer's fields that are not the listing's, unless a read still runs."""
        if self._extras is None or self._extras.done():
            self._extras = asyncio.ensure_future(self._read_extras(app))
        return self._extras

    async def _read_extras(self, app):
        """Each field on its own: one that fails keeps its last value and never stops a listing."""
        reads = {"update": _update_notice(self.extras["update"])}   # a failed read keeps the notice shown
        if app:
            reads |= {"sessionRequests": asyncio.to_thread(
                          lambda: [_with_account_labels(item) for item in app["session_requests"].pending()]),
                      "agentMailConsent": asyncio.to_thread(lambda: agentmail.consent_projection()["requests"])}
        for key, value in zip(reads, await asyncio.gather(*reads.values(), return_exceptions=True)):
            if isinstance(value, BaseException):   # also a child cancelled on its own
                print(f"sessions: {key}: {value!r}", flush=True)
            else:
                self.extras[key] = value


async def produce_round(app, read):
    """The rows of one round, given the host's list: today the full listing of this process. This is
    the one place a native producer replaces."""
    return await _listing(app["event_state"] if app else None, app["organisation_lock"] if app else None, read)


async def sessions_round(app, state):
    """One round of the background state: the host's list, published at once (membership), then the
    listing. A host that does not list leaves the state and the snapshot as they are (with no state
    yet, the state is the listing of no session)."""
    read = await state.read("round")
    _, listed, identity, _, _ = read
    if listed:
        state.host = "restarted" if None not in (identity, state.identity) and identity != state.identity else "ok"
        state.identity = identity or state.identity
    await state.membership(read)
    if not listed and state.top is not None:
        return
    data, listed = await produce_round(app, read)
    if listed or state.top is None:
        # A wake line nobody followed: shown on the session, never typed (claudewake).
        unconfirmed = app["claude_wakes"].unconfirmed() | app["codex_wakes"].unconfirmed() if app else set()
        rows = [dict(row, ready=True, **({"wake_unconfirmed": True} if (row["name"], row["created"]) in unconfirmed else {}))
                for row in data.pop("mesh")]
        state.publish(state.live([*rows, *state.rows.values()]), data)


async def api_sessions(request):
    """The session list from the background state (SessionsState): a request never runs a listing.
    A request with ``since`` asks for a round, not for a read of the host's list, and never waits."""
    state = request.app["sessions_state"]
    since = request.query.get("since", "")
    since = int(since) if re.fullmatch(r"[0-9]{1,16}", since) else None
    if since is None:
        await state.wait(SESSIONS_WAIT)
    else:
        state.wanted.set()
    return web.Response(text=state.answer(since), content_type="application/json")


async def api_portfolio_diff(request):
    """Return a bounded read-only contextual diff for a just-revalidated CWD."""
    # A query would be a second client input channel.  Treat it exactly like a
    # stale capability: the owner gets no information about the rejected path.
    if request.query:
        raise web.HTTPNotFound()
    try:
        live = await ptyhost.request({"op": "list"})
    except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        raise web.HTTPNotFound()
    cwd = portfolio.revalidate_diff_selector(request.match_info.get("selector"), live,
                                              key=DIFF_SELECTOR_KEY)
    if cwd is None:
        raise web.HTTPNotFound()
    # A page refresh must not be able to accumulate an unbounded number of
    # child processes while each individual child waits for its time limit.
    async with request.app["contextual_diff_semaphore"]:
        result = await portfolio._run_contextual_diff(portfolio.contextual_diff_path(ROOT), cwd)
    return web.json_response(result)


# ---------------------------------------------------------------- hook events (shadow mode)

class EventState:
    """Small, process-local hook hints keyed by the live token incarnation.

    The session file and normal discovery remain authoritative. This store is
    deliberately not persisted, pushed, exposed to terminals, or read by the
    client; it merely makes bounded shadow data observable in the
    authenticated session listing for comparison work.

    Aggregate, content-free comparison counters compare a
    winning hook event only with the existing discovery heuristic at snapshots:
    ``busy -> working``, ``waiting/permission prompt -> waiting_permission``,
    ``waiting/input needed -> waiting_question``, ``idle -> done`` and
    ``shell -> working`` (the existing idle heuristic deliberately treats a
    background shell as non-idle).  ``error`` has no old heuristic equivalent;
    it and unknown agent shapes are recorded as unobservable, never as an
    agreement.  A changed heuristic for the same winning hook is a new sample;
    repeated polls of the same pair are not.
    """

    def __init__(self):
        self._states = {}
        self._seen = {}
        self._buckets = {}
        self._compared = {}
        # Each applied event gets the next value of one process-wide counter:
        # a generation names one winning event exactly, unlike a timestamp.
        self._generation = 0
        self._generations = {}
        # The first conversation an agy hook reported for an incarnation: see ``foreign``.
        self._pinned = {}
        self._metrics = {"samples": 0, "agree": 0, "unobservable": 0,
                         "disagreements": {}}

    @staticmethod
    def _key(name, nonce):
        return name, nonce

    def take_token(self, name, nonce):
        key = self._key(name, nonce)
        now = time.monotonic()
        tokens, then = self._buckets.get(key, (float(EVENT_BUCKET_CAPACITY), now))
        tokens = min(float(EVENT_BUCKET_CAPACITY), tokens + (now - then) * EVENT_BUCKET_RATE)
        # A tenth of a second at 10/s must restore one token even when its
        # binary float representation lands infinitesimally below 1.
        if tokens + 1e-9 < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (max(0.0, tokens - 1), now)
        return True

    def duplicate(self, name, nonce, event_id):
        if event_id is None:
            return False
        key = self._key(name, nonce)
        ids = self._seen.setdefault(key, deque(maxlen=EVENT_DEDUP_MAX))
        if event_id in ids:
            return True
        ids.append(event_id)
        return False

    def foreign(self, name, nonce, event, agent):
        """Why ``event`` does not speak for this session's agent, or None when it does.

        A hook or plugin may be installed for every instance of its agent, so one started inside
        a session (``agy -p`` run by Claude, say) inherits the session's token and reports under
        it. Such an event must change nothing: not the state, not the conversation, not the
        wake gate (a nested agent's ``done`` would open the gate while the session's own agent
        sits at a permission prompt, and the notice's Enter would answer it).

        ``agent`` is the agent the session was launched as; a session without one (a plain
        shell) has nothing to compare with. For an agy session only the first conversation it
        reports counts: the process tree cannot tell a nested agy (a child of the same terminal)
        from the session's own, but a second conversation id can. Once one is pinned, an agy
        event without a conversation id is refused for the same reason."""
        if agent is None:
            return None
        detail = event.get("detail")
        source = detail.get("source") if isinstance(detail, dict) else None
        if source != agent:
            return "foreign_source"
        if agent != "agy":
            return None
        key = self._key(name, nonce)
        conversation = detail.get("session")
        pinned = self._pinned.get(key)
        if pinned is None:
            if isinstance(conversation, str):
                self._pinned[key] = conversation
            return None
        return None if conversation == pinned else "foreign_conversation"

    def apply(self, name, nonce, event):
        """Keep the newest event; False when ``event`` is older than the current one.

        ``at`` is the hook's own time, already clamped to the server's receipt
        (``_event_record``): an event dated in the future cannot outrank one
        that really comes after it. Any event other than a finished turn
        replaces a finished turn whatever its date: it may be the start of a
        turn, and the idle gate must close rather than wait for a clock.
        """
        key = self._key(name, nonce)
        old = self._states.get(key)
        if old is not None and self._older(old, event):
            return False
        self._states[key] = event
        self._generation += 1
        self._generations[key] = self._generation
        # Only the current winning event is ever compared.  This leaves at
        # most one entry for each normalized heuristic value, rather than an
        # unbounded history for a long-running session.
        self._compared[key] = set()
        return True

    @staticmethod
    def _sequence(event):
        """The sender's own event number (``detail.seq``), None when it sends none."""
        value = (event.get("detail") or {}).get("seq")
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    @classmethod
    def _older(cls, old, event):
        """Whether ``event`` must not replace ``old``.

        Senders that number their events (the OpenCode plugin posts each one as its own request, and
        two requests can land out of order) are ordered by that number alone: a late ``working`` must
        not replace the ``done`` that really came after it.  The others are ordered by date."""
        new_seq, old_seq = cls._sequence(event), cls._sequence(old)
        if new_seq is not None and old_seq is not None:
            return new_seq <= old_seq
        return event["at"] < old["at"] and not (old["type"] == "done" and event["type"] != "done")

    @staticmethod
    def _heuristic(agent):
        """Normalize only states the pre-hook code already understands.

        This contains no timing or text inference: an unfamiliar client shape
        is evidence that is unavailable, not a claim that it agrees.
        """
        if not isinstance(agent, dict):
            return None
        status = agent.get("status")
        if status == "busy" or status == "shell":
            return "working"
        if status == "idle":
            return "done"
        if status != "waiting":
            return None
        waiting_for = agent.get("waiting_for")
        if waiting_for == "permission prompt":
            return "waiting_permission"
        if waiting_for == "input needed":
            return "waiting_question"
        return None

    def _compare(self, key, agent):
        event = self._states.get(key)
        if event is None:
            return
        hook = event["type"]
        heuristic = self._heuristic(agent)
        # `apply` clears this bounded window when the winning event changes;
        # details, ids, names and timestamps never enter the report.
        sample = hook, heuristic
        compared = self._compared.setdefault(key, set())
        if sample in compared:
            return
        compared.add(sample)
        self._metrics["samples"] += 1
        if hook == "error" or heuristic is None:
            self._metrics["unobservable"] += 1
        elif hook == heuristic:
            self._metrics["agree"] += 1
        else:
            disagreement = f"{hook}->{heuristic}"
            disagreements = self._metrics["disagreements"]
            disagreements[disagreement] = disagreements.get(disagreement, 0) + 1

    def current_type(self, name, nonce):
        """The type of this incarnation's winning event, or None."""
        event = self._states.get(self._key(name, nonce))
        return None if event is None else event["type"]

    def idle_since(self, name, nonce):
        """When this incarnation last reported a finished turn, or None.

        Only a winning ``done`` counts: any later hook (a prompt, a tool, a
        permission request) replaces it. The hook's own time, never later than
        the server's receipt, is used, so a hook cannot date itself into the
        future and hide input typed after it from the PTY host's check.

        The PTY host compares this wall-clock time with the wall-clock time of
        the last input. A wall clock set back after the event would date later
        input before it, so a step backwards since the receipt (seen against
        the monotonic clock) withdraws the evidence until the next ``done``.
        """
        event = self._states.get(self._key(name, nonce))
        if event is None or event["type"] != "done":
            return None
        received_steady = event.get("received_steady")
        if received_steady is None:
            return None
        wall_elapsed = time.time() - event["received"]
        if wall_elapsed < time.monotonic() - received_steady - WALL_CLOCK_STEP_TOLERANCE:
            return None
        return event["at"]

    def idle_generation(self, name, nonce):
        """The generation of the finished turn ``idle_since`` reports, or None."""
        if self.idle_since(name, nonce) is None:
            return None
        return self._generations.get(self._key(name, nonce))

    def still_idle(self, name, generation):
        """True while ``generation`` is still the winning finished turn of ``name``."""
        return generation is not None and any(
            key[0] == name and value == generation and self._states[key]["type"] == "done"
            for key, value in self._generations.items() if key in self._states)

    def report(self):
        """Return the owner-readable, aggregate-only shadow report."""
        return {"v": 0,
                "mapping": {"busy": "working", "shell": "working",
                            "waiting_permission": "waiting_permission",
                            "waiting_question": "waiting_question", "idle": "done"},
                "samples": self._metrics["samples"],
                "agree": self._metrics["agree"],
                "unobservable": self._metrics["unobservable"],
                "disagreements": dict(sorted(self._metrics["disagreements"].items()))}

    def expose(self, mesh, raw):
        """Add each current incarnation's hint and forget non-live entries."""
        live = {(s.get("name"), (s.get("meta") or {}).get("nonce"))
                for s in raw if isinstance(s, dict) and isinstance(s.get("name"), str)
                and isinstance(s.get("meta"), dict) and isinstance(s["meta"].get("nonce"), str)}
        self._states = {key: value for key, value in self._states.items() if key in live}
        self._seen = {key: value for key, value in self._seen.items() if key in live}
        self._buckets = {key: value for key, value in self._buckets.items() if key in live}
        self._compared = {key: value for key, value in self._compared.items() if key in live}
        self._generations = {key: value for key, value in self._generations.items() if key in live}
        self._pinned = {key: value for key, value in self._pinned.items() if key in live}
        nonce_by_name = {name: nonce for name, nonce in live}
        for entry in mesh:
            key = entry["name"], nonce_by_name.get(entry["name"])
            self._compare(key, entry.get("agent"))
            event = self._states.get(key)
            # The monotonic receipt time is meaningful to this process only.
            entry["hook"] = None if event is None else {
                field: value for field, value in event.items() if field != "received_steady"}


_OPENCODE_HOOK_STATUS = {"working": ("busy", None), "done": ("idle", None),
                         "waiting_permission": ("waiting", "permission prompt"),
                         "waiting_question": ("waiting", "input needed")}
# Agents whose state and conversation are reported by their own hook or plugin, and the form of the
# conversation id each may report (it ends up in argv on resume).
_HOOK_SESSION_RE = {"opencode": re.compile(r"^ses_[0-9A-Za-z]{8,60}$"),
                    "gemini": re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"),
                    "agy": re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$"),
                    "vibe": re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")}


# agy reports the start of a turn and its end, but not a permission prompt, and not an interruption:
# after a refused or cancelled prompt it is back at its input line without any ``Stop``, so the last
# report stays "working" for good (observed with a signed-in agy). A terminal silent for this long
# since that report is either at a prompt or waiting to be told what to do instead: either way it
# waits for the user. A model call or a command that stays silent as long shows the same, wrongly,
# until its output resumes. The terminal's last output is the only signal: no hook marks the
# interruption.
AGY_QUIET_DEFAULT, AGY_QUIET_RANGE = 30.0, (1.0, 600.0)


def _agy_quiet_seconds(raw):
    """The silence from MESH_AGY_QUIET_SECONDS: a finite number of seconds within AGY_QUIET_RANGE,
    else the default, said once in the log (a bad value must neither stop the server from starting,
    nor make every working session waiting at once, nor switch the detection off)."""
    if raw is None or raw.strip() == "":
        return AGY_QUIET_DEFAULT
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if math.isfinite(value) and AGY_QUIET_RANGE[0] <= value <= AGY_QUIET_RANGE[1]:
        return value
    print(f"MESH_AGY_QUIET_SECONDS={raw!r} ignored: expected a number of seconds from "
          f"{AGY_QUIET_RANGE[0]:g} to {AGY_QUIET_RANGE[1]:g}; using {AGY_QUIET_DEFAULT:g}", flush=True)
    return AGY_QUIET_DEFAULT


AGY_QUIET_SECONDS = _agy_quiet_seconds(os.environ.get("MESH_AGY_QUIET_SECONDS"))


def _agy_waits_for_you(entry, hook):
    last = max(hook.get("received") or 0, entry.get("activity") or 0)
    return last > 0 and time.time() - last >= AGY_QUIET_SECONDS


def _hook_predates_process(agent, hook):
    """Whether the report is of an earlier process of the agent in this terminal (quit, then
    ``opencode --session C`` or ``copilot --resume=C`` typed by hand): the hook state outlives the process,
    so a report received before this one started says nothing about it (2 s of slack: the start time is
    read from the boot time, in seconds).  Applies to every agent whose discovery reports its start time
    (OpenCode, Gemini, Antigravity, Copilot, Vibe)."""
    started = agent.get("started")
    return isinstance(started, (int, float)) and started > 0 and (hook.get("received") or 0) < started - 2


def _apply_reported_state(mesh):
    """OpenCode, Gemini, Antigravity and Vibe keep no transcript Mesh can follow turn by turn (a SQLite store,
    JSON chats, protobuf stores) and have no prompt Mesh can recognise on the screen: their plugin or hooks
    report the state, and the conversation they are in. A report replaces the store-based guess of the
    state; the conversation OpenCode's plugin reports replaces the one discovery read, the others only fill
    in a missing one."""
    for entry in mesh:
        agent, hook = entry.get("agent"), entry.get("hook")
        kind = agent.get("type") if isinstance(agent, dict) else None
        if kind not in _HOOK_SESSION_RE or not isinstance(hook, dict):
            continue
        if _hook_predates_process(agent, hook):
            continue
        state = _OPENCODE_HOOK_STATUS.get(hook.get("type"))
        if state is not None:
            agent["status"], agent["waiting_for"] = state
        if agent["type"] == "agy" and hook.get("type") == "working" and _agy_waits_for_you(entry, hook):
            agent["status"], agent["waiting_for"] = "waiting", None
        session = (hook.get("detail") or {}).get("session")
        # The OpenCode plugin names the conversation the process is in now; discovery only reads what it
        # was started with (``--session``, or the one conversation written since), so after the user opens
        # another conversation it would resume the wrong one.  Gemini's hooks only fill in a missing one.
        replaces = kind == "opencode" or agent.get("session_id") is None
        if replaces and isinstance(session, str) and _HOOK_SESSION_RE[kind].fullmatch(session):
            agent["session_id"], agent["identity_source"] = session, f"{kind}_hook"


# A UUID, like the one discover reads from argv: Copilot names its conversations with nothing else.
_COPILOT_SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _apply_copilot_hooks(mesh):
    """Copilot CLI has no prompt Mesh can recognise on the screen and keeps no transcript it follows
    turn by turn: the hooks of Mesh's per-session plugin (copilot-mesh-plugin/, through bin/mesh-event)
    report the state and the conversation. The latest report names the conversation the terminal is in
    (a /new or /resume inside Copilot changes it), so it replaces the one read from argv."""
    for entry in mesh:
        agent, hook = entry.get("agent"), entry.get("hook")
        if not (isinstance(agent, dict) and agent.get("type") == "copilot" and isinstance(hook, dict)):
            continue
        if _hook_predates_process(agent, hook):
            continue
        state = _OPENCODE_HOOK_STATUS.get(hook.get("type"))
        if state is not None:
            agent["status"], agent["waiting_for"] = state
        session = (hook.get("detail") or {}).get("session")
        if isinstance(session, str) and _COPILOT_SESSION_RE.fullmatch(session):
            agent["session_id"], agent["identity_source"] = session, "copilot_hooks"


def _apply_hook_state(event_state, mesh, raw, history_identity=True):
    """What the hooks reported, applied to a described mesh (``raw``: the PTY host's list of it).
    ``history_identity=False``: the caller runs _apply_history_identity itself (it reads files and
    scans the history index, so a caller on the event loop does it in a worker)."""
    event_state.expose(mesh, raw)
    _apply_reported_state(mesh)
    _apply_copilot_hooks(mesh)
    if history_identity:
        _apply_history_identity(mesh)


# Agents whose hooks may not have reported a conversation yet (before the first prompt, or hooks silenced):
# the history index names the one conversation *started* in the agent's folder since the process started.
_HISTORY_IDENTITY = ("gemini", "agy", "copilot")


def _history_wanting(mesh):
    """The agents without a conversation that history may name, by (type, folder), and the conversation
    ids every session of the mesh already holds, by type."""
    held, wanting = {}, {}
    for entry in mesh:
        agent = entry.get("agent")
        if not isinstance(agent, dict):
            continue
        if agent.get("session_id"):
            held.setdefault(agent.get("type"), set()).add(agent["session_id"])
        elif agent.get("type") in _HISTORY_IDENTITY:
            cwd, started = entry.get("cwd") or agent.get("cwd"), agent.get("started")
            if cwd and isinstance(started, (int, float)):
                wanting.setdefault((agent["type"], cwd), []).append((agent, started))
    return held, wanting


def _apply_history_identity(mesh):
    """A guess, marked ``history_cwd`` (respawn.entry_of never stores it as the session's conversation):
    only for an agent alone in its folder, from a conversation that started after it did and that no other
    session holds. Two agents of one kind in one folder cannot be told apart: neither gets one."""
    held, wanting = _history_wanting(mesh)
    for (kind, cwd), group in wanting.items():
        if len(group) != 1:
            continue
        agent, started = group[0]
        sid = history.newest_for(kind, cwd, started - 2, held.get(kind, ()))
        if sid:
            agent["session_id"], agent["identity_source"] = sid, "history_cwd"


def _describe_with_hooks(listed):
    """``list_sessions`` with the running app's hook state applied (a Copilot started bare has its
    conversation from its hooks only)."""
    described = list_sessions(listed, False)
    if _LIVE_EVENT_STATE is not None:
        _apply_hook_state(_LIVE_EVENT_STATE, described["mesh"], listed)
    return described


async def _event_body(request):
    """Read the v0 envelope with its smaller, route-specific byte limit."""
    chunks, size = [], 0
    async for chunk in request.content.iter_chunked(EVENT_BODY_MAX + 1):
        size += len(chunk)
        if size > EVENT_BODY_MAX:
            raise web.HTTPRequestEntityTooLarge(max_size=EVENT_BODY_MAX, actual_size=size)
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks).decode("utf-8"),
                          parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise web.HTTPBadRequest(text="JSON object expected")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object expected")
    return body


def _event_detail(value):
    try:
        compact = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text="Invalid detail")
    if len(compact) > EVENT_DETAIL_MAX:
        raise web.HTTPRequestEntityTooLarge(max_size=EVENT_DETAIL_MAX, actual_size=len(compact))
    if not isinstance(value, dict) or len(value) > 8:
        raise web.HTTPBadRequest(text="Invalid detail")
    for key, item in value.items():
        if not isinstance(key, str) or not EVENT_DETAIL_KEY_RE.fullmatch(key):
            raise web.HTTPBadRequest(text="Invalid detail")
        if isinstance(item, str):
            if len(item) > 256:
                raise web.HTTPBadRequest(text="Invalid detail")
        elif isinstance(item, bool) or item is None:
            pass
        elif not isinstance(item, (int, float)) or not math.isfinite(item):
            raise web.HTTPBadRequest(text="Invalid detail")
    return value


def _event_record(body):
    if set(body) - EVENT_KEYS:
        raise web.HTTPBadRequest(text="Unknown event field")
    if body.get("v", 0) != 0 or isinstance(body.get("v", 0), bool):
        raise web.HTTPBadRequest(text="Invalid event version")
    kind = body.get("type")
    if not isinstance(kind, str) or kind not in EVENT_TYPES:
        raise web.HTTPBadRequest(text="Invalid event type")
    received, received_steady = time.time(), time.monotonic()
    at = body.get("at", received)
    if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at) \
            or not received - 24 * 3600 <= at <= received + 60:
        raise web.HTTPBadRequest(text="Invalid event date")
    # A hook's clock may run a little ahead (accepted above), but an event
    # never happened after its receipt: ordering and idle evidence use this.
    at = min(at, received)
    event_id = body.get("id")
    if "id" in body and (not isinstance(event_id, str) or not EVENT_ID_RE.fullmatch(event_id)):
        raise web.HTTPBadRequest(text="Invalid event ID")
    detail = _event_detail(body["detail"]) if "detail" in body else None
    return {"type": kind, "at": at, "received": received, "received_steady": received_steady,
            "id": event_id, "detail": detail}


async def _session_agent(name, created):
    """The agent this live session was launched as (``known_agent``), or None for a plain shell."""
    for item in await host({"op": "list"}):
        if item.get("name") == name and item.get("created") == created:
            meta = item.get("meta") or {}
            agent = meta.get("known_agent") or meta.get("agent")
            return agent if isinstance(agent, str) and agent else None
    return None


async def api_event(request):
    state = request.app["event_state"]
    name, nonce = request["mesh_session"], request["mesh_session_nonce"]
    # Invalid envelopes deliberately spend a token too: the endpoint is a hint,
    # not an unlimited parsing service for a compromised session process.
    if not state.take_token(name, nonce):
        raise web.HTTPTooManyRequests(headers={"Retry-After": "1"})
    event = _event_record(await _event_body(request))
    agent = await _session_agent(name, request["mesh_session_created"])
    reason = state.foreign(name, nonce, event, agent)
    if reason is not None:
        reported = (event["detail"] or {}).get("source")
        print(f"event: ignored {event['type']} for {name}: {reason} "
              f"(session agent {agent}, reported source {reported!r})", flush=True)
        return web.json_response({"ok": True, "applied": False, "reason": reason})
    if state.duplicate(name, nonce, event["id"]):
        return web.json_response({"ok": True, "applied": False, "reason": "duplicate"})
    previous = state.current_type(name, nonce)
    if not state.apply(name, nonce, event):
        return web.json_response({"ok": True, "applied": False, "reason": "stale"})
    if event["type"] == "done" and "agent_wakes" in request.app:
        request.app["agent_wakes"].trigger()   # a deferred wake may now be typed
    elif previous == "done":
        await _cancel_pending_notice(name, request["mesh_session_created"])
    # Last: a newer finished turn applied while the record is written keeps its notice's Enter.
    await _claim_reported_conversation(name, nonce, request["mesh_session_created"], agent, event["detail"])
    return web.json_response({"ok": True, "applied": True})


HOOK_FILLS_ONLY = ("gemini", "agy", "vibe")


async def _claim_reported_conversation(name, nonce, created, agent, detail):
    """The conversation a hook of the session's own agent reported (``detail.session``), into the identity
    registry as ``hook`` (I5). The session comes from the token, never from the body; an id of another
    form, or of another agent, is ignored. Best effort: the next report tries again. As in
    _apply_reported_state, the hooks of Gemini, Antigravity and Vibe only fill in a missing conversation:
    they never replace the one the registry holds for the session."""
    sid = (detail or {}).get("session")
    if agent is None or not isinstance(sid, str):
        return
    hook = (detail or {}).get("hook")
    evidence = f"hook:{hook}" if isinstance(hook, str) and respawn.EVIDENCE_RE.fullmatch(f"hook:{hook}") else "hook:report"
    try:
        await asyncio.to_thread(respawn.claim_identity, {"name": name, "created": created, "nonce": nonce},
                                agent, sid, "hook", evidence, fill_only=agent in HOOK_FILLS_ONLY)
    except OSError as exc:
        print(f"event: conversation of {name} not recorded: {exc!r}", flush=True)


async def _cancel_pending_notice(name, created):
    """A turn started after a finished one: withdraw a notice's Enter still waiting.

    A notice is typed only while the last event is a finished turn; its Enter
    follows the text after WAKE_SUBMIT_DELAY. Best effort: a PTY host without
    this operation answers an error, and the event is applied all the same."""
    try:
        await host({"op": "cancel_submit", "name": name, "created": created})
    except web.HTTPException:
        pass


def _startable_dir(path, home, places):
    """A folder a session may start in (allows_cwd), whose resolved place stays in the home folder and is not
    protected (``places``: launchsettings.deny_places of view.VIEW_DENY): a symlink cannot lead the list out of
    them. Its resolved path and modification time, or None."""
    try:
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except (OSError, RuntimeError):
        return None
    if not (stat.S_ISDIR(info.st_mode) and resolved.is_relative_to(home) and LAUNCH_SETTINGS.allows_cwd(resolved)) \
            or launchsettings.protected(str(path), resolved, places):
        return None
    return resolved, info.st_mtime


def _visible_dir_entry(entry):
    """A visible entry that is a folder (a symlink followed). One that cannot be examined (a symlink loop, a link
    into a folder that cannot be entered) is left out alone: it must not hide its siblings."""
    try:
        return not entry.name.startswith(".") and entry.is_dir()
    except (OSError, RuntimeError):
        return False


def _listed_children(parent, home, places, scanned, per_parent):
    """The visible sub-folders of one parent a session may start in, newest first: at most ``per_parent`` of its
    first ``scanned`` entries. A file is left out before anything is resolved (DirEntry.is_dir)."""
    with os.scandir(parent) as entries:
        found = [Path(e.path) for e in itertools.islice(entries, scanned)
                 if _visible_dir_entry(e)]
    dirs = [(path, checked[1]) for path in found if (checked := _startable_dir(path, home, places))]
    return [path for path, _ in sorted(dirs, key=lambda entry: -entry[1])[:per_parent]]


def project_dirs(per_parent=80, scanned=2000, total=200):
    """GET /api/dirs, a plain list of paths: the home folder and the allowed work folders, then the visible
    sub-folders of each work folder (of ~/dev when none is configured), newest first; at most ``per_parent``
    of one folder among its first ``scanned`` entries, ``total`` in all: no further folder is read once
    ``total`` are listed. The protected places are resolved once per call."""
    home = Path.home().resolve()
    places = launchsettings.deny_places(view.VIEW_DENY)
    parents = list(LAUNCH_SETTINGS.roots) if LAUNCH_SETTINGS.configured else [Path.home() / "dev"]
    out = dict.fromkeys(str(p) for p in dict.fromkeys([Path.home(), *LAUNCH_SETTINGS.roots])
                        if _startable_dir(p, home, places))
    for parent in parents:
        if len(out) >= total:
            break
        with contextlib.suppress(OSError):
            out.update(dict.fromkeys(str(p) for p in _listed_children(parent, home, places, scanned, per_parent)))
    return list(out)[:total]


async def api_dirs(request):
    return web.json_response(await asyncio.to_thread(project_dirs))


def _usable_recent_folders(folders):
    """The folders (from a browser) that GET /api/dirs could list: plain, in the home folder, allowed, not
    protected; resolved. Runs in a worker thread: it touches the file system."""
    home, places = Path.home().resolve(), launchsettings.deny_places(view.VIEW_DENY)
    return [str(checked[0]) for folder in folders
            if launchsettings.plain_folder(folder) and (checked := _startable_dir(Path(folder), home, places))]


def _move_recent_folders(folders):
    return launchsettings.add_recent_folders(RUNNER_SETTINGS, _usable_recent_folders(folders), newest=False)


async def api_dirs_recent(request):
    """A browser moves the recent folders it kept before they were a runner setting: the owner's cookie only.
    A folder is kept only when GET /api/dirs could list it, and goes after the runner's own recent folders. A
    settings file that cannot be read whole is left as it is: 503, so the browser keeps its copy for later."""
    _require_owner_cookie(request)
    body = await _bounded_json_object(request, CONFIG_BODY_MAX)
    folders = body.get("folders")
    if set(body) != {"folders"} or not isinstance(folders, list) \
            or len(folders) > launchsettings.RUNNER_MAX_ENTRIES["recent_folders"]:
        raise web.HTTPBadRequest(text="Invalid fields")
    try:
        async with LAUNCH_WRITE_LOCK:
            kept = await asyncio.to_thread(_move_recent_folders, folders)
    except (OSError, launchsettings.InvalidLaunchSettings) as exc:
        print(f"dirs/recent: recent folders not moved: {exc!r}", flush=True)
        return _json_reply({"error": "settings-unreadable"}, 503)
    return _json_reply({"recent_folders": kept})


def _record_folder(cwd):
    """The folder a session started in, resolved, first in the runner's recent folders (in a worker thread)."""
    usable = _usable_recent_folders([os.path.realpath(cwd)])
    if usable:
        launchsettings.add_recent_folders(RUNNER_SETTINGS, usable, newest=True)


async def _record_recent_folder(request, cwd):
    """After the owner's browser started a session (POST /api/new, cookie and no Authorization header): its
    folder goes first in the runner's recent folders. A failure here (a settings file that cannot be read
    whole is left as it is) is logged and never fails the start."""
    if request.headers.get("Authorization") or not has_owner_cookie(request):
        return
    try:
        async with LAUNCH_WRITE_LOCK:
            await asyncio.to_thread(_record_folder, cwd)
    except Exception as exc:   # noqa: BLE001 -- the session has started: report, never turn it into a 500
        print(f"new: recent folder not recorded: {exc!r}", flush=True)


PROJECT_HOST_OPS = frozenset(("project_capabilities", "project_list", "project_read",
                              "project_create", "project_settings", "project_status",
                              "project_observation_status", "project_observation_start",
                              "project_observation_page", "project_observation_cancel"))


async def api_project_artifacts(request):
    return await projectartifacts.handle(request)


async def api_project_issues(request):
    return await projectissues.handle(request)


async def api_projects(request):
    """Owner-authenticated transport only; the native host owns project data."""
    data = bytearray()
    async for chunk in request.content.iter_chunked(16384):
        if len(data) + len(chunk) > 128 * 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=128 * 1024,
                                               actual_size=len(data) + len(chunk))
        data.extend(chunk)
    try:
        body = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Invalid project request")
    if not isinstance(body, dict) or not isinstance(body.get("op"), str) \
            or body["op"] not in PROJECT_HOST_OPS:
        raise web.HTTPBadRequest(text="Unsupported project operation")
    return web.json_response(await host(body), headers={"Cache-Control": "no-store"})


# The Projects view's relay: `work-read --request`, or `work-write --request` for a write op, which only the
# owner's signed-in browser may send. The programs check the request themselves. No other logic here.
WORK_SLOTS, WORK_TIMEOUT = asyncio.Semaphore(4), os.environ.get("MESH_WORK_READ_TIMEOUT", "5").strip()
WORK_TIMEOUT = (float(WORK_TIMEOUT) if re.fullmatch(r"\d{1,5}(\.\d+)?", WORK_TIMEOUT) else 0) or 5.0  # bad: 5 s
WORK_WRITE_OPS, WORK_MAX_BODY = frozenset(("answer",)), 16384


def work_error(status, code, message):
    return web.json_response({"error": {"code": code, "message": message}}, status=status,
                             headers={"Cache-Control": "no-store"})


def work_command(program):
    """MESH_WORK_READ_CMD / MESH_WORK_WRITE_CMD (absolute, else none), else bin/<program>, else the switch's."""
    if (explicit := os.environ.get(f"MESH_{program.upper().replace('-', '_')}_CMD")) is not None:
        return explicit if os.path.isabs(explicit) and os.path.isfile(explicit) else None
    dirs = [agentmcp.runtime_bin()] + ([] if os.environ.get("MESH_BIN_DIR") else [agentmcp.switch_bin()])
    return next((str(d / program) for d in dirs if (d / program).is_file()), None)


def work_program(request, body):
    """work-write for a write op, with the owner's browser cookie only (never a bearer) and a JSON content type,
    as the config routes ask; else work-read."""
    try:
        write = json.loads(body).get("op") in WORK_WRITE_OPS
    except (ValueError, AttributeError, TypeError, RecursionError):  # the program refuses it
        write = False
    if write:
        _require_owner_cookie(request)
        if request.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType(text="Content-Type must be application/json")
    return "work-write" if write else "work-read"


def work_child_env():
    """HOME and WL_HOME, and the absolute entries of PATH so that work-write finds git where the owner has it (an
    empty or relative entry would search the server's working directory). No token or session variable."""
    env = {k: os.environ[k] for k in ("HOME", "WL_HOME") if k in os.environ}
    if path := os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if os.path.isabs(p)):
        env["PATH"] = path  # without one, the libc default path
    return env


async def api_work(request):
    """The request body (16 KiB at most) is the standard input of the program, its one JSON line the reply:
    a timeout, a 2 MiB line cap, a private process group and at most four programs at once."""
    body, proc = b"", None  # read at most one byte over the cap: a larger body is refused unread
    while len(body) <= WORK_MAX_BODY and (chunk := await request.content.read(WORK_MAX_BODY + 1 - len(body))):
        body += chunk
    if len(body) > WORK_MAX_BODY or not body.lstrip().startswith(b"{"):  # the program checks the rest
        return work_error(400, "invalid_input", f"a JSON object of at most {WORK_MAX_BODY} bytes is expected")
    if (command := work_command(program := work_program(request, body))) is None:
        return work_error(503, "not_available", f"{program} is not installed")
    if WORK_SLOTS.locked():  # no await between this check and the acquire
        return work_error(503, "busy", "too many work requests")
    async with WORK_SLOTS:
        try:
            proc = await asyncio.create_subprocess_exec(
                command, "--request", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=2 * 1024 * 1024, start_new_session=True,
                env=work_child_env())
            proc.stdin.write(body)
            proc.stdin.close()
            limit = WORK_TIMEOUT if program == "work-read" else max(WORK_TIMEOUT, 30.0)  # a write may wait for the lock and git
            out, code = await asyncio.wait_for(asyncio.gather(proc.stdout.readline(), proc.wait()), limit)
            if code < 0 or not out.endswith(b"\n"):  # killed by a signal, or no complete line
                return work_error(502, "internal", f"{program} gave no complete answer")
        except asyncio.TimeoutError:
            return work_error(504, "timeout", f"{program} took too long")
        except ValueError:  # the line is over the cap
            return work_error(502, "output_too_large", f"{program} output too large")
        except OSError:
            return work_error(503, "not_available", f"{program} could not start")
        finally:
            if proc is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
                proc._transport.close()  # unread output would keep wait() pending (Python 3.11, 3.12)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), 5)
    return web.Response(body=out, status={0: 200, 2: 400, 3: 404, 8: 409}.get(code, 502),
                        content_type="application/json", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- actions

# Codex uses the normal terminal buffer with rich rendering. ``codex_args`` keeps these
# per-invocation settings in one place for fresh sessions and resumes.

# This is deliberately a launch catalogue, not a claim that every CLI has the
# same integration. Claude/Codex have per-process board bridges; Pi uses its
# verified private agent-directory overlay. Other CLIs keep upstream defaults.
LAUNCH_SETTINGS, LAUNCH_REVISION = launchsettings.load_with_revision()
AGENT_PRESETS = {kind: argv for kind, argv in launchplan.catalogue().items()
                 if kind in LAUNCH_SETTINGS.enabled_agents}

# Only these entries have a transcript reader and a conservative argv rebuild.
# Keeping the others out means a ptyhost restart never guesses at a resume
# command or restarts a fresh conversation in the owner's name.
# A preset id is not always an agent type: "codex" and "codex-yolo" both launch
# the agent "codex".  Everything keyed by the running agent (resume, known_agent,
# mail, wake, capability checks) uses the type; only the launch catalogue uses ids.
def _derived_launch_state():
    types = frozenset(launchplan.agent_type(kind) for kind in AGENT_PRESETS)
    resumable = frozenset(
        kind for kind in types
        if agentcap.status(kind, agentcap.Feature.RESUME) is agentcap.Status.SUPPORTED)
    return types, resumable


AGENT_TYPES, RESUMABLE_AGENT_PRESETS = _derived_launch_state()
AGENT_MAIL_PRESETS = frozenset(("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe"))
# Agents into whose terminal a wake notice may be typed. The notice ends with
# Enter, so it is typed only when the agent is known to be idle at its prompt:
# an Enter that lands on an approval prompt would answer it. Claude reports the
# end of each turn through the Mesh hooks (``Stop`` -> ``done``). Codex has no
# reliable idle signal in Mesh: its ``notify`` program is not installed (it
# could replace the user's own) and also fires for Codex's title helper turn.
# Codex is never typed into: only when the owner turned it on (MESH_CODEX_QUEUE_WAKE=1,
# off by default) is it woken by ``codex queue`` for an exact conversation (agentwake.CodexQueue);
# otherwise its message stays in the inbox.
# Pi is woken by its own extension.
# Where Mesh puts the messaging socket of each Claude session it launches
# (claudewake): next to the PTY host's socket, in a private directory, or in a
# short one when a socket path would not fit there (macOS).
CLAUDE_WAKE_DIR = claudewake.wake_directory(ptyhost.SOCK.parent / claudewake.DIRECTORY_NAME)
# OpenCode's Mesh plugin (opencode-mesh-plugin.ts) reports session.idle as ``done``, and
# ``session.status`` busy, a permission or a question as the states that close the gate.
# Gemini's hooks (bin/mesh-event gemini) report AfterAgent as ``done`` and BeforeAgent, tools and a
# permission notification as the states that close the gate.
# agy is deliberately absent, like Codex. Its hooks (bin/mesh-event agy) report ``Stop`` with
# ``fullyIdle`` as ``done``, but nobody has observed that ``Stop`` stays silent (or not fully idle)
# while a permission prompt is open: if it fires, the notice's Enter would answer the prompt. Add
# "agy" back only after a real agy has been observed doing that.
# Vibe's hooks (bin/mesh-event vibe) report the same states: a notification of a turn that
# ended is ``done``, a prompt or a tool is ``working``, an approval or a question closes the gate.
AGENT_WAKE_PRESETS = frozenset(("claude", "opencode", "gemini", "vibe"))
PRESETS = {"shell": None, **{kind: shlex.join(argv) for kind, argv in AGENT_PRESETS.items()}}


def apply_launch_settings(settings, revision):
    """Make owner-edited launch settings effective for the next launch, without a restart.

    Every launch path reads these module values at call time, so rebinding them is the whole
    effect; no await sits between the assignments. Sessions already running are not touched."""
    global LAUNCH_SETTINGS, LAUNCH_REVISION, AGENT_PRESETS, PRESETS, AGENT_TYPES, RESUMABLE_AGENT_PRESETS
    presets = {kind: argv for kind, argv in launchplan.catalogue().items() if kind in settings.enabled_agents}
    previous = AGENT_PRESETS
    AGENT_PRESETS = presets
    try:
        types, resumable = _derived_launch_state()
    except BaseException:
        AGENT_PRESETS = previous
        raise
    PRESETS = {"shell": None, **{kind: shlex.join(argv) for kind, argv in presets.items()}}
    AGENT_TYPES, RESUMABLE_AGENT_PRESETS = types, resumable
    LAUNCH_SETTINGS, LAUNCH_REVISION = settings, revision


async def api_new(request):
    body = await json_object(request)
    cwd = os.path.expanduser(str(body.get("cwd") or "~"))
    if not os.path.isdir(cwd):
        raise web.HTTPBadRequest(text=f"Folder not found: {cwd}")
    if not LAUNCH_SETTINGS.allows_cwd(cwd):
        raise web.HTTPForbidden(text=OUTSIDE_WORKSPACE_ROOTS)
    kind = body.get("preset", "shell")
    if kind not in {"shell", "custom", *AGENT_PRESETS}:
        raise web.HTTPBadRequest(text="Unknown or disabled preset")
    command = str(body.get("command") or "").strip() if kind == "custom" else PRESETS.get(kind)
    name = str(body.get("name") or "").strip()
    if name and not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest(text="Invalid name (letters, digits, - and _)")
    agent = launchplan.agent_type(kind) if kind in AGENT_PRESETS else None
    account = body.get("account")   # absent or null: the default account; anything else must be an alias id
    if account is not None and not (isinstance(account, str) and ACCOUNT_ID_RE.fullmatch(account)):
        raise web.HTTPBadRequest(text=ACCOUNT_UNKNOWN)
    conversation = None
    if agent:
        argv, conversation = _chosen_launch(agent, AGENT_PRESETS[kind])
        command = shlex.join(argv)
    name = await new_session(name or f"{Path(cwd).name}-{kind if kind != 'custom' else 'cmd'}",
                             cwd, command, agent if agent in RESUMABLE_AGENT_PRESETS else None,
                             agent, conversation=conversation, account=account)
    await _record_recent_folder(request, cwd)
    return web.json_response({"id": name})


def _chosen_launch(agent, argv):
    """(argv, conversation) of a new agent. A new Claude is given the conversation id the mesh chooses (I2:
    ``--session-id`` with a UUIDv4), recorded before it starts; the other agents choose their own."""
    if agent != "claude":
        return argv, None
    sid = str(uuid.uuid4())
    return [*argv, "--session-id", sid], ("claude", sid, "launch:session_id")


def _resume_argv(info):
    """The launch line that reopens the agent's conversation. An id guessed from the folder's history is
    display-only (it may be another session's): no reported id, so refused as before the guess existed."""
    sid = info.get("session_id")
    if not sid or info.get("identity_source") in respawn.GUESSED_SOURCES:
        raise web.HTTPBadRequest(text="Session ID not found")
    kind = info["type"]
    try:
        agentcap.require_supported(kind, agentcap.Feature.RESUME)
    except agentcap.UnsupportedCapability as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    if kind == "pi":
        path = discover.pi_session_path(sid)
        if not path:
            raise web.HTTPConflict(text="Pi conversation missing or ambiguous; resume refused")
        return agentmcp.inject("pi", ["pi", "--session", path])
    try:
        argv = resumeargs.resume_argv(kind, info.get("argv") or [], sid)
    except resumeargs.WeakerResume as exc:
        raise web.HTTPConflict(text=str(exc)) from exc
    return agentmcp.inject(kind, argv)


# Why the agent of a restored session was not relaunched (I6): the note the page shows, and what the
# line typed in its shell says. Never a new conversation, never the resume of a contested one.
NOT_RELAUNCHED = {
    "unknown": ("Unknown conversation ID: restarted as a plain shell", "its conversation ID is unknown"),
    "contested": ("Conversation claimed by another session: restarted as a plain shell",
                  "its conversation is claimed by another session (contested)"),
    "not found": ("Conversation not found: restarted as a plain shell", "its conversation no longer exists"),
}


def _not_relaunched_line(agent, reason):
    """The one line typed in the shell of a restored session whose agent is not relaunched, or None."""
    if not agent or reason not in NOT_RELAUNCHED:
        return None
    return shlex.join(["printf", "%s\\n", f"Session Mesh: {agent['type']} not relaunched: {NOT_RELAUNCHED[reason][1]}"])


def _conversation_layout(kind, sid):
    """(folder variable, home folder, data folder, glob of the transcript) of a Claude or Codex conversation."""
    return {"claude": ("CLAUDE_CONFIG_DIR", ".claude", "projects", ("*", f"{sid}.jsonl")),
            "codex": ("CODEX_HOME", ".codex", "sessions", ("*", "*", "*", f"rollout-*-{sid}.jsonl"))}.get(kind)


def _conversation_found(kind, sid, account):
    """Whether the transcript of the conversation is in the folder `accounts carry` reads it from: the alias's
    (``account``), or for the default account (None) ``$CLAUDE_CONFIG_DIR`` or ``$CODEX_HOME`` when absolute, else
    the home folder's. Unlike _conversation_missing, a missing folder is not found."""
    variable, default, data, pattern = _conversation_layout(kind, sid)
    if account is None:
        configured = os.environ.get(variable) or ""
        root = configured if os.path.isabs(configured) else os.path.join(discover.HOME, default)
    else:
        root = account_folder(account, kind)
    folder = os.path.join(root, data) if root else None
    return bool(folder) and os.path.isdir(folder) and any(
        os.path.isfile(match) for match in glob.glob(os.path.join(glob.escape(folder), *pattern)))


def _conversation_missing(kind, sid, account=None):
    """Whether the conversation is known to be gone: no Claude transcript, no Codex rollout of that id.
    Pi and OpenCode are checked when their launch line is built; the others are not checked. Claude's and
    Codex's data folders are looked for in ``$CLAUDE_CONFIG_DIR`` and ``$CODEX_HOME`` (absolute) and in
    the home folder; with none of them present, nothing is known to be gone. A session of an alias
    (``account``) is looked for in that alias's folder only: never in the default account's."""
    layout = _conversation_layout(kind, sid)
    if layout is None:
        return False
    variable, default, data, pattern = layout
    configured = os.environ.get(variable) or ""
    roots = [configured] if os.path.isabs(configured) else []
    folders = [os.path.join(root, data) for root in [*roots, os.path.join(discover.HOME, default)]]
    if account is not None:
        folder = account_folder(account, kind)
        folders = [os.path.join(folder, data)] if folder else []
    present = [folder for folder in folders if os.path.isdir(folder)]
    return bool(present) and not any(os.path.isfile(match) for folder in present   # a dangling link is no transcript
                                     for match in glob.glob(os.path.join(glob.escape(folder), *pattern)))


def _restored_conversation(agent):
    """The conversation a restore launches, recorded as chosen before it starts (new_session)."""
    return agent["type"], agent["session_id"], "launch:restore"


def _restore_identity(entry):
    """respawn.restore_identity, then the conversation looked for on disk (blocking: run it in a worker)."""
    entry, reason = respawn.restore_identity(entry)
    agent = entry["agent"]
    if agent and agent["session_id"] and _conversation_missing(agent["type"], agent["session_id"], entry.get("account")):
        return {**entry, "agent": {**agent, "session_id": None}}, "not found"
    return entry, reason


async def _wait_dead(pid, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        stat = discover.read_stat(pid)
        if stat is None or stat[1] == "Z":    # gone, or a zombie
            return True
        await asyncio.sleep(0.2)
    return False


RESUMING = set()   # agent pids being resumed: a second resume of the same agent is refused


async def resume_target(target):
    """Stop the agent in its terminal (Terminator tab, SSH login…) and reopen the same conversation in
    the mesh. Returns the mesh session name."""
    agent = target["agent"]
    if not agent:
        raise web.HTTPBadRequest(text="No recognized agent in this session")
    cwd = target["cwd"] or str(Path.home())
    argv = _resume_argv(agent)
    command = shlex.join(argv)
    # Everything the relaunch needs is checked before the agent is stopped:
    # a failure afterwards would leave it neither in its terminal nor in the mesh.
    if not os.path.isdir(cwd):
        raise web.HTTPConflict(text=f"Folder not found ({cwd}): the agent was not stopped")
    if not LAUNCH_SETTINGS.allows_cwd(cwd):
        raise web.HTTPForbidden(text=OUTSIDE_WORKSPACE_ROOTS)      # before the stop: the agent keeps running
    if agent["type"] == "gemini" and _is_home_directory(cwd):
        raise web.HTTPBadRequest(text=GEMINI_IN_HOME_AGENT_KEPT)
    if agent["type"] == "copilot" and agent.get("identity_source") != "copilot_hooks":
        # Outside the mesh a Copilot has no hooks: its conversation is the one its arguments named when it
        # started, which a /new or a /resume inside Copilot may have changed since.  Relaunching it would
        # reopen the wrong conversation, so it is refused before the agent is stopped.
        raise web.HTTPConflict(text=COPILOT_CONVERSATION_UNKNOWN)
    prepared = {}
    if agent["type"] == "opencode":
        # The launch line is built (version read, conversation checked) before the agent is stopped: a
        # refusal afterwards would leave it neither in its terminal nor in the mesh.  The result is the
        # one the relaunch uses.
        prepared["opencode"] = await _opencode_command(command, cwd)
    if agent["pid"] in RESUMING:
        raise web.HTTPConflict(text="A restart is already in progress for this agent")
    RESUMING.add(agent["pid"])
    try:
        pi_runtime = await _pi_runtime() if agent["type"] == "pi" else None
        if agent["type"] == "vibe":
            prepared["vibe"] = await _prepare_vibe(command, cwd)
        return await _stop_and_relaunch(agent, cwd, command, pi_runtime, **prepared)
    finally:
        RESUMING.discard(agent["pid"])


async def _stop_and_relaunch(agent, cwd, command, pi_runtime=None, vibe=None, opencode=None):
    await host({"op": "list"})          # 503 here if ptyhost is down: nothing stopped yet
    try:
        os.kill(agent["pid"], signal.SIGTERM)
    except ProcessLookupError:
        pass                    # it exited on its own meanwhile: just relaunch
    if not await _wait_dead(agent["pid"]):
        raise web.HTTPConflict(text="The process did not stop; nothing was restarted")
    try:
        return await new_session(f"{Path(cwd).name}-{agent['type']}", cwd, command, agent["type"],
                                 agent["type"], pi_runtime=pi_runtime, vibe=vibe, opencode=opencode)
    except Exception as e:
        reason = e.text if isinstance(e, web.HTTPException) else repr(e)
        raise web.HTTPServiceUnavailable(
            text=f"The agent is stopped but the restart failed ({reason}); restart it by hand: cd {shlex.quote(cwd)} && {command}")


def find_target(data, pid):
    return next((t for t in data["external"] if t["pid"] == pid), None)


async def api_adopt(request):
    body = await json_object(request)
    pid, mode = body.get("pid"), body.get("mode")
    if not isinstance(pid, int) or isinstance(pid, bool):
        raise web.HTTPBadRequest(text="Integer pid expected")
    data = await sessions(organisation_lock=request.app["organisation_lock"])
    target = find_target(data, pid)
    if not target:
        raise web.HTTPNotFound(text="Session not found")
    if mode == "resume":
        name = await resume_target(target)
        if PENDING.pop(pid, None) is not None:   # resumed by hand: the watcher must not do it again
            save_pending()
        return web.json_response({"id": name})
    if mode == "when-idle":
        if not target["agent"]:
            raise web.HTTPBadRequest(text="No recognized agent in this session")
        if target["agent"]["type"] == "pi":
            raise web.HTTPBadRequest(text="Pi does not report a reliable idle state; manual restart only")
        if target["agent"]["type"] not in IDLE_OBSERVABLE:
            raise web.HTTPBadRequest(text="This agent does not report a reliable idle state; manual restart only")
        PENDING[pid] = {"since": time.time(), "agent_pid": target["agent"]["pid"]}
        save_pending()
        return web.json_response({"pending": True})
    if mode == "cancel":
        PENDING.pop(pid, None)
        save_pending()
        return web.json_response({"pending": False})
    raise web.HTTPBadRequest(text="Unknown mode")


# ---------------------------------------------------------------- resume when idle
#
# A pending tab is resumed once its agent has looked idle on two consecutive
# polls: claude reports its own status (idle, or waiting for an answer); codex has none, so "idle" means its
# rollout has not been written for CODEX_QUIET seconds.

PENDING_FILE = CONF_DIR / "pending.json"
CODEX_QUIET = 90
PENDING = {}
DONE = {}   # external session pid -> mesh name, so the UI can follow the move


def load_pending():
    try:
        PENDING.update({int(k): v for k, v in json.loads(PENDING_FILE.read_text()).items()})
    except (OSError, ValueError):
        pass


def save_pending():
    fsutil.atomic_write(PENDING_FILE, json.dumps({str(k): v for k, v in PENDING.items()}))


# The agents whose idle state Mesh can observe: Claude reports its status, Codex and OpenCode write files
# that go quiet. Copilot (and Pi) report nothing a process listing can read: a turn, a permission prompt and
# an idle prompt look the same from outside, so a restart that SIGTERMs the agent is never offered "when idle".
IDLE_OBSERVABLE = frozenset(("claude", "codex", "opencode"))


def looks_idle(agent):
    if agent["type"] not in IDLE_OBSERVABLE:
        return False
    if agent["type"] == "claude":
        # "waiting" = blocked on a question or a permission prompt: nothing is
        # running, and answering it is exactly what the mesh is for. "shell" (turn over,
        # a background shell still runs) is not idle: resuming SIGTERMs the agent and
        # would kill that shell. Unknown statuses are not idle either.
        return agent.get("status") in ("idle", "waiting")
    if agent["type"] == "opencode" and agent.get("status") != "idle":
        # A busy turn (discover._opencode_busy, which has no time limit for a live process, or the plugin's
        # report) stays busy however quiet its store is: a long tool call writes nothing for minutes, and
        # the restart would SIGTERM it.
        return False
    updated = agent.get("updated")
    # No timestamp (an OpenCode with no conversation found) is no evidence of quiet.
    return bool(updated) and time.time() - updated > CODEX_QUIET


async def idle_watcher(app):
    streak = {}
    while True:
        await asyncio.sleep(5)
        if not PENDING:
            continue
        try:
            data = await sessions(organisation_lock=app["organisation_lock"] if app else None)
        except Exception as e:
            print("watcher:", e, flush=True)
            continue
        for pid in list(PENDING):
            # one bad tab must not stop the watcher for every other one
            try:
                await _watch_one(pid, data, streak)
            except Exception as e:
                PENDING.pop(pid, None)
                streak.pop(pid, None)
                print(f"watcher: {pid} dropped after an error: {e!r}", flush=True)
                try:
                    save_pending()
                except OSError:
                    pass


async def _watch_one(pid, data, streak):
    """One poll for one pending tab: drop it if its agent changed, resume it
    after two idle polls in a row."""
    wanted = PENDING.get(pid)
    if wanted is None:          # cancelled meanwhile
        return
    target = find_target(data, pid)
    agent = target and target["agent"]
    if not agent or agent["pid"] != wanted["agent_pid"] or agent["type"] not in IDLE_OBSERVABLE:
        # The agent exited, was replaced, or is of a kind whose idle state is not observable (a request
        # saved before that kind was refused "when idle"): it would never be resumed, so it is dropped.
        PENDING.pop(pid, None)
        streak.pop(pid, None)
        save_pending()
        return
    streak[pid] = streak.get(pid, 0) + 1 if looks_idle(agent) else 0
    if streak[pid] < 2:
        return
    try:
        DONE[pid] = await resume_target(target)
        print(f"watcher: resumed {pid} -> {DONE[pid]}", flush=True)
    except web.HTTPException as e:
        print(f"watcher: resume {pid} failed: {e.text}", flush=True)
        streak.pop(pid, None)   # two fresh idle polls before another try: no tight loop
        # Transient (ptyhost unreachable before the stop, another resume running): keep
        # the request. Lasting (agent ignores SIGTERM, cwd gone, no session id): drop it.
        transient = isinstance(e, web.HTTPServiceUnavailable) or "already in progress" in (e.text or "")
        if not transient:
            PENDING.pop(pid, None)
            save_pending()
        return
    PENDING.pop(pid, None)
    streak.pop(pid, None)
    save_pending()


async def start_watcher(app):
    load_pending()
    app["watcher"] = asyncio.create_task(idle_watcher(app))


async def stop_watcher(app):
    app["watcher"].cancel()


# ---------------------------------------------------------------- web panel
#
# Documents open in a side panel under signed, expiring /view URLs; the
# capability scheme, the view policy and the Markdown page live in view.py.

view.configure(TOKEN, CONF_DIR)


def recent_docs(limit=40):
    roots = [Path.home() / "notes", Path.home() / "dev"]
    found = []
    for root in roots:
        if not root.is_dir():
            continue
        depth = 4 if root.name == "notes" else 3
        # notes: every document; code trees: only html/pdf (markdown there is mostly repo docs)
        kinds = (".html", ".htm", ".md", ".pdf") if root.name == "notes" else (".html", ".htm", ".pdf")
        for dirpath, dirnames, filenames in os.walk(root):
            rel = Path(dirpath).relative_to(root)
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "_build", "target", "vendor")]
            if len(rel.parts) >= depth:
                dirnames[:] = []
            for f in filenames:
                if f.endswith(kinds):
                    fp = Path(dirpath) / f
                    try:
                        found.append((fp.stat().st_mtime, str(fp)))
                    except OSError:
                        pass
    found.sort(reverse=True)
    return [p for _, p in found[:limit]]


async def api_docs(request):
    return web.json_response(await asyncio.to_thread(recent_docs))

# ---------------------------------------------------------------- history
#
# Past claude / codex sessions from their transcripts (history.py). The list is
# large, so a client passes the generation it already has and gets
# {"unchanged": true} back when nothing moved.

HISTORY_AGENTS = history.AGENTS   # the agents whose conversations the history index reads
# History reads and deletes run here, not in asyncio's default executor: a slow database or a big
# index must not take the threads /api/sessions and the other handlers need (history.py's own calls
# give up on a busy database after a fraction of a second, but a lock scan can still be slow).
HISTORY_READS = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="history-read")


def run_history(function, *args):
    """Await a blocking history call in HISTORY_READS."""
    return asyncio.get_running_loop().run_in_executor(HISTORY_READS, function, *args)


# /api/sessions applies the history identity on every listing, so it must never queue behind the searches
# and deletes that can fill HISTORY_READS (a search scans OpenCode's store for up to 20 s; a delete waits
# for the database helper): its own small executor. The OpenCode store search has a third, single-worker one.
HISTORY_IDENTITY = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="history-identity")
HISTORY_STORE_SEARCH = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="history-store-search")


def run_history_identity(function, *args):
    """Await the history identity of a listing, in an executor no search or delete can fill."""
    return asyncio.get_running_loop().run_in_executor(HISTORY_IDENTITY, function, *args)


async def _search_store(q):
    """OpenCode's store search, one at a time: a newer search (typing went on), or a client that went away,
    cancels the one running, and one still queued returns at once."""
    cancel = threading.Event()
    previous, _search["store_cancel"] = _search.get("store_cancel"), cancel
    if previous is not None:
        previous.set()
    try:
        return await asyncio.get_running_loop().run_in_executor(HISTORY_STORE_SEARCH, history.search_db, q, cancel)
    finally:
        cancel.set()


def _hist_key(request):
    agent, sid = request.match_info["agent"], request.match_info["sid"]
    if agent not in HISTORY_AGENTS or not SID_RE.fullmatch(sid):
        raise web.HTTPBadRequest()
    return agent, sid


def _guessed_identity(session):
    """Whether the session's conversation id was guessed from the folder's history (display-only)."""
    return (session.get("agent") or {}).get("identity_source") in respawn.GUESSED_SOURCES


async def live_where(sid, agent=None):
    """Where a conversation is running right now: a mesh session name, a terminal id, or None. A session
    whose id the agent reported or was launched with is preferred to one whose id was guessed."""
    data = await sessions()
    found = [s for s in data["mesh"] + data["external"]
             if (s["agent"] or {}).get("session_id") == sid and (agent is None or s["agent"].get("type") == agent)]
    return min(found, key=_guessed_identity, default=None)


async def api_history(request):
    scan = history_scan()
    try:   # a re-scan takes a fraction of a second; the first one can take minutes
        await asyncio.wait_for(asyncio.shield(scan), 2)
    except asyncio.TimeoutError:
        pass
    indexing = not scan.done()
    since = _int_param(request.query.get("gen"), None, 0, 2 ** 63)
    gen = history.gen
    # Mesh names/closures change independently of transcript generations.
    entries = await asyncio.to_thread(conversation_names.snapshot)
    names_gen = hashlib.sha256(json.dumps(entries, sort_keys=True, ensure_ascii=False,
                                          separators=(",", ":")).encode()).hexdigest()[:16]
    names_unchanged = request.query.get("names_gen") == names_gen
    metadata = {"names_gen": names_gen, "names_unchanged": names_unchanged,
                "degraded": _hist_degraded["on"] or history.scan_degraded(), "skipped": history.skipped_count()}
    if not names_unchanged:
        metadata["mesh_names"] = entries
    if since == gen:
        resp = web.json_response({"gen": gen, "unchanged": True, "indexing": indexing, **metadata})
        resp.enable_compression()
        return resp
    try:
        items, gone, full = await run_history(history.listing, since)
    except Exception as e:   # the index could not be listed: the client keeps what it has
        print(f"history: listing failed ({type(e).__name__})", flush=True)
        # No generation, no list: the client must neither advance its generation (it would lose the changes
        # between its own and this one) nor take an empty full listing for the whole index.
        metadata["degraded"] = True
        resp = web.json_response({"listing_failed": True, "indexing": indexing, **metadata})
        resp.enable_compression()
        return resp
    resp = web.json_response({"gen": gen, "full": full, "sessions": items, "gone": gone, "indexing": indexing, **metadata})
    resp.enable_compression()
    return resp


SEARCH_TIMEOUT = 60
_search = {"proc": None}   # the full-text search running: a newer one replaces it


async def api_history_search(request):
    """The conversations that mention q: the database's ranked hits first (when it is synced), then what the
    literal search of the transcripts finds that they do not (substrings, an exact phrase, a tool output the
    index does not hold), then OpenCode's SQLite store. Each id appears once, at its best place."""
    q = request.query.get("q", "").strip()
    if len(q) < 3 or "\n" in q or "\r" in q:   # the same guard before every backend
        return web.json_response([])
    ranked = await run_history(history.db_search, q) or []
    argv = history.search_argv(q)
    found = await run_history(history.search_ids, await _literal_search(argv)) if argv else []
    stored = await _search_store(q)
    merged = list(dict.fromkeys(ranked + found + stored))
    return web.json_response(merged)


async def _literal_search(argv):
    """The paths ripgrep (or grep) lists for the command; a newer search kills the one running."""
    if _search["proc"] and _search["proc"].returncode is None:
        _search["proc"].kill()   # typing went on: the previous query is obsolete
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.DEVNULL)
    _search["proc"] = proc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), SEARCH_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise web.HTTPGatewayTimeout(text="Search took too long")
    finally:
        if _search["proc"] is proc:
            _search["proc"] = None
    if proc.returncode < 0:
        raise web.HTTPConflict(text="Search replaced by a newer one")
    return out.decode("utf-8", "surrogateescape").splitlines()


async def history_detail(agent, sid):
    """A session's detail, or 404. While the index is being built, a session not
    indexed yet may only be late: wait for the scan (bounded) before saying so."""
    d = await run_history(history.detail, agent, sid)
    if not d and not history_scan().done():
        try:
            await asyncio.wait_for(asyncio.shield(history_scan()), 10)
        except asyncio.TimeoutError:
            raise web.HTTPServiceUnavailable(text="History is being indexed, try again in a moment")
        d = await run_history(history.detail, agent, sid)
    if not d:
        raise web.HTTPNotFound(text="Session not found")
    return d


async def api_history_detail(request):
    detail = await history_detail(*_hist_key(request))
    return web.json_response(conversation_names.enrich(detail, await asyncio.to_thread(conversation_names.snapshot)))


async def api_history_delete(request):
    agent, sid = _hist_key(request)
    # ``live_where`` takes a recovery snapshot as part of its observed
    # listing.  Keep that snapshot inside the same organization transition
    # without widening its small, independently used helper signature.
    async with request.app["organisation_lock"]:
        live = await live_where(sid, agent)
    if live:
        raise web.HTTPConflict(text=f"{agent} is still running in {live.get('host') or 'the mesh'}: stop it first")
    await history_detail(agent, sid)   # waits for an index still being built
    try:
        await run_history(history.delete, agent, sid)
    except LookupError:
        raise web.HTTPNotFound(text="Session not found")
    except history.Unsupported:
        raise web.HTTPBadRequest(text=f"Mesh does not delete {agent} conversations: remove it with {agent} itself")
    except history.Busy:
        raise web.HTTPConflict(text="Transcript modified less than 2 min ago: the session may still be running")
    await asyncio.to_thread(conversation_names.forget, agent, sid)
    return web.json_response({"ok": True})


async def api_history_resume(request):
    body = await json_object(request)
    agent, sid = str(body.get("agent")), str(body.get("id"))
    if agent not in respawn.AGENT_TYPES or not SID_RE.fullmatch(sid):
        raise web.HTTPBadRequest()
    if (agent, sid) in HIST_RESUMING:
        raise web.HTTPConflict(text="Resume already in progress")
    HIST_RESUMING.add((agent, sid))
    try:
        async with request.app["restore_lock"]:   # the order a restore takes them in: no restore in flight
            if sid in recent_conversations(request.app):
                raise web.HTTPConflict(text="This conversation was just restored: nothing was started")
            async with request.app["organisation_lock"]:
                name = await _resume_history(agent, sid)
    except BaseException as exc:
        HIST_RESUMING.discard((agent, sid))
        if isinstance(exc, (CreationUncertain, asyncio.CancelledError)):   # the agent may still start: hold the conversation
            remember_conversations(request.app, [sid])
        raise
    # the new agent shows up as live only once it has opened its transcript: hold the conversation as long as a restore does
    remember_conversations(request.app, [sid])
    asyncio.get_running_loop().call_later(HIST_RESUME_GRACE, HIST_RESUMING.discard, (agent, sid))
    return web.json_response({"id": name})


def _history_grace(raw, default=20.0, low=1.0, high=60.0):
    """The seconds a resumed History conversation stays in HIST_RESUMING (MESH_HISTORY_RESUME_GRACE, so that
    a test need not wait the whole 20 s): a finite number from ``low`` to ``high``, else the default, said once in
    the log (a bad value must not stop the server from starting)."""
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if math.isfinite(value) and low <= value <= high:
        return value
    print(f"MESH_HISTORY_RESUME_GRACE={raw!r} ignored: expected a number of seconds from {low:g} to {high:g}; "
          f"using {default:g}", flush=True)
    return default


NOT_RESUMABLE_HERE = {   # what History cannot resume, and why (a card's `resumable` is false)
    "gemini": "Mesh starts Gemini in a private home of its own: a conversation of your own ~/.gemini cannot "
              "be resumed here, only with the command on the card",
    "agy": "Antigravity does not record this conversation's folder: resume it from its folder with the command on the card",
}
HIST_RESUMING = set()    # (agent, sid) just resumed: a second click must not start a second agent
HIST_RESUME_GRACE = _history_grace(os.environ.get("MESH_HISTORY_RESUME_GRACE"))


async def _resume_history(agent, sid):
    live = await live_where(sid, agent)
    if live and _guessed_identity(live):   # live_where prefers a reported id: every candidate is a guess
        raise web.HTTPConflict(text=f"{agent} may still be running in {live.get('host') or 'the mesh'}: "
                                    "its conversation id is only a guess, check that terminal first")
    if live and live["kind"] == "mesh":
        return live["id"]
    if live:
        raise web.HTTPConflict(text=f"This conversation is running in {live['host']}: use “Restart” on that terminal")
    d = await history_detail(agent, sid)
    if not d["resumable"]:
        raise web.HTTPConflict(text=NOT_RESUMABLE_HERE[agent])
    cwd = d["cwd"] or str(Path.home())
    if not os.path.isdir(cwd):
        raise web.HTTPBadRequest(text=f"The session folder no longer exists: {cwd}")
    if agent == "pi":
        # Pi creates a new transcript for a missing --session path. Resolve the
        # exact existing UUID first; never pass an unchecked pin as a filename.
        path = await asyncio.to_thread(discover.pi_session_path, sid)
        if path is None:
            raise web.HTTPNotFound(text="Pi transcript missing or ambiguous")
        name = await new_session(f"{Path(cwd).name}-pi", cwd,
                                 shlex.join(["pi", "--session", str(path)]), known_agent="pi",
                                 conversation=(agent, sid, "launch:history"))
        return await _with_last_label(name, agent, sid)
    argv = agentmcp.inject(agent, resumeargs.resume_argv(agent, [], sid))
    name = await new_session(f"{Path(cwd).name}-{agent}", cwd, shlex.join(argv), agent, agent,
                             conversation=(agent, sid, "launch:history"))
    return await _with_last_label(name, agent, sid)


async def _with_last_label(name, agent, sid):
    """``name``, the session just started for the conversation, with the label the owner last gave that
    conversation ("rename" is an organisation label: the host keeps the generated name, so the new
    incarnation would show it again). Nothing is applied when a live session already shows that name
    (its label, or its host name), so the sidebar never holds two alike. The agent is running by now:
    a failure here is logged, it never fails the resume."""
    try:
        label = await asyncio.to_thread(conversation_names.last_label, agent, sid)
        live = await host({"op": "list"})
        if not _valid_ptyhost_list(live):
            raise ValueError("the host's list is not usable")
        others = {session["name"] for session in live if session["name"] != name}
        meta = (await asyncio.to_thread(organize.view, live, False))["sessions"]
        shown = others | {meta[other]["label"] for other in others if other in meta}
        if label and label != name and label not in shown:
            await asyncio.to_thread(organize.apply, {"op": "rename", "id": name, "label": label}, live)
    except Exception as error:   # the session is running: whatever fails here, a second click must not start another
        print(f"history resume: label of {name} not restored: {error!r}", flush=True)
    return name


# Scans run on their own thread, so that a long first indexing never holds the
# default pool that the session list relies on.
HISTORY_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="history")


_hist_scan = None   # concurrent future: it must outlive individual aiohttp/test loops


_hist_degraded = {"on": False}   # the last scan raised (history.scan_degraded() covers a step that failed): the index served is the last good one


def _guarded_refresh():
    """history.refresh, whose failure never reaches a request: it is logged (type only), flagged as degraded
    in the answers of /api/history, and the last good index keeps being served until a scan works again."""
    try:
        changed = history.refresh()
    except Exception as e:
        _hist_degraded["on"] = True
        print(f"history: scan failed, serving the last index ({type(e).__name__})", flush=True)
        return False
    _hist_degraded["on"] = False
    return changed


def history_scan():
    """The running scan of the transcripts, bound to this caller's event loop.

    The worker future is process-wide, whereas aiohttp creates a fresh event
    loop for an app (and pytest may create one per test).  Do not cache the
    loop-bound future returned by ``run_in_executor``: a later request would
    otherwise try to await it from the wrong loop.
    """
    global _hist_scan
    if _hist_scan is None or _hist_scan.done():
        _hist_scan = HISTORY_POOL.submit(_guarded_refresh)
    return asyncio.wrap_future(_hist_scan, loop=asyncio.get_running_loop())


async def start_history(app):
    history_scan()   # the first indexing can take minutes: start it before anyone asks


async def stop_history(app):
    await asyncio.to_thread(history.flush)


# ---------------------------------------------------------------- uploads
#
# Files pasted or dropped in the browser live on the viewer's machine; claude
# and codex read the clipboard of *this* machine. So the browser uploads the
# file here and types its path, which both agents attach like a dropped file.

UPLOAD_DIR = meshpaths.CACHE_DIR / "uploads"
BODY_MAX = 1024 * 1024
UPLOAD_MAX = 200 * 1024 * 1024
UPLOAD_KEEP_DAYS = 14


def _private_dir(path):
    """Make or keep `path` an owner-only directory (0700) whatever the umask, never through a link."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def _store_upload(filename, data):
    day = UPLOAD_DIR / time.strftime("%Y-%m-%d")
    _private_dir(UPLOAD_DIR)
    _private_dir(day)
    name = re.sub(r"[^\w.@+-]+", "_", Path(filename).name).strip("._") or "file"
    stem, suffix = Path(name).stem, Path(name).suffix
    path, i = day / name, 2
    while True:
        try:   # exclusive create: two same-name uploads never overwrite each other
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except FileExistsError:
            path, i = day / f"{stem}-{i}{suffix}", i + 1
            continue
        try:
            with os.fdopen(fd, "wb") as out:
                os.fchmod(out.fileno(), 0o600)   # owner-only whatever the umask
                out.write(data)
        except OSError:
            path.unlink(missing_ok=True)   # no half-written file left behind (disk full…)
            raise
        break
    _clean_old_uploads()
    return str(path)


def _clean_old_uploads():
    """Best effort, never following a symlink: a link planted in the uploads
    dir must not make the mesh delete files elsewhere, and a cleanup error
    must not fail an upload that is already stored."""
    cutoff = time.time() - UPLOAD_KEEP_DAYS * 86400
    try:
        entries = list(os.scandir(UPLOAD_DIR))
    except OSError:
        return
    for day in entries:
        try:
            if not day.is_dir(follow_symlinks=False) or day.stat(follow_symlinks=False).st_mtime >= cutoff:
                continue
            for f in os.scandir(day.path):
                if f.is_file(follow_symlinks=False) or f.is_symlink():
                    os.unlink(f.path)
            os.rmdir(day.path)
        except OSError as e:
            print(f"uploads: cleanup of {day.path} skipped ({e})", flush=True)


async def _read_upload(request):
    """The upload body, streamed: only this route may send up to UPLOAD_MAX
    (every other body is capped by the app's client_max_size)."""
    if (request.content_length or 0) > UPLOAD_MAX:
        raise web.HTTPRequestEntityTooLarge(max_size=UPLOAD_MAX, actual_size=request.content_length)
    chunks, size = [], 0
    async for chunk in request.content.iter_chunked(1 << 20):
        size += len(chunk)
        if size > UPLOAD_MAX:
            raise web.HTTPRequestEntityTooLarge(max_size=UPLOAD_MAX, actual_size=size)
        chunks.append(chunk)
    return b"".join(chunks)


async def api_upload(request):
    filename = request.query.get("name") or "file"
    data = await _read_upload(request)
    if not data:
        raise web.HTTPBadRequest(text="Empty file")
    return web.json_response({"path": await asyncio.to_thread(_store_upload, filename, data)})


async def json_object(request):
    """The request body as a JSON object, or 400."""
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object expected")
    return body


def _int_param(value, default, low=2, high=1000):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


async def api_organize(request):
    """Rename, file and order mesh sessions; manage folders (organize.py)."""
    body = await json_object(request)
    async with request.app["organisation_lock"]:
        # ``organize.apply`` and the recovery migration are one logical
        # transition.  Serializing the whole pair also keeps a concurrent
        # listing from writing an older organization back into the snapshot.
        live = await host({"op": "list"})
        try:
            result = await asyncio.to_thread(organize.apply, body, live)
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e))
        if body.get("op") == "folder-rename":
            old, new = organize.clean(body.get("old")), organize.clean(body.get("new"))
            try:
                # Unlike periodic snapshots, a successful owner mutation must
                # not silently leave recovery state behind.  ``rename_folder``
                # therefore propagates a failed atomic write.
                await asyncio.to_thread(respawn.rename_folder, old, new)
            except OSError as error:
                # The snapshot write is atomic; if it failed, restore the
                # equally atomic mesh configuration before reporting failure.
                # A rollback failure is explicit rather than pretending the
                # owner has a coherent recovery arrangement.
                try:
                    await asyncio.to_thread(organize.apply,
                                            {"op": "folder-rename", "old": new, "new": old}, live)
                except (OSError, ValueError) as rollback:
                    raise web.HTTPInternalServerError(
                        text="Rename interrupted: check the organization and the recovery") from rollback
                raise web.HTTPServiceUnavailable(
                    text="Rename cancelled: the recovery snapshot could not be updated") from error
            result["folder_rename"] = {"old": old, "new": new}
    return web.json_response(result)


async def api_kill(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="created required")
    created = body.get("created") if isinstance(body, dict) else None
    if (not isinstance(created, (int, float)) or isinstance(created, bool)
            or not math.isfinite(created)):
        raise web.HTTPBadRequest(text="created required")
    listed = await host({"op": "list"})
    previous = next((session for session in listed if session.get("name") == name
                     and session.get("created") == created), None)
    if previous is None:
        raise web.HTTPConflict(text="Session replaced or missing")
    # Capture discovery before killing the process which owns the identity.
    described = await asyncio.to_thread(_describe_with_hooks, listed)
    await asyncio.to_thread(conversation_names.observe, described["mesh"])
    try:
        killed = await host({"op": "kill_if", "name": name, "created": created})
    except web.HTTPBadRequest as exc:
        # An old host rejects the new op. Never retry with name-only kill.
        raise web.HTTPServiceUnavailable(text="ptyhost does not support conditional stop") from exc
    if killed == {"ok": False}:
        raise web.HTTPConflict(text="Session replaced or stop already requested")
    if killed != {"ok": True}:
        raise web.HTTPServiceUnavailable(text="Invalid ptyhost reply")
    await asyncio.to_thread(conversation_names.close, name, created)
    await asyncio.to_thread(respawn.forget_live, name, created)   # forget only the killed identity
    await asyncio.to_thread(board.remove, name, created)
    SIGNALS.discard_if(lambda reference, identity: reference.get("type") == "board.updated"
                       and reference.get("object", {}).get("id") == name and identity == created)
    opens.discard_board_open(name, created)
    opens.discard_demo_scene_open(name, created)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------- Excalidraw whiteboard

async def _demo_scene_get(name, version=None, expected_created=None, demo_id=None):
    listed = await host({"op": "list"})
    if expected_created is not None and demo_scene._live(listed).get(name) != expected_created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        if demo_id is None:
            scene = await asyncio.to_thread(demo_scene.get, name, listed, version)
        else:
            scene = await asyncio.to_thread(demo_scene.get_demo, name, demo_id, listed, version)
    except demo_scene.NotLive:
        raise web.HTTPNotFound(text="Demo session missing")
    except demo_scene.DemoNotFound:
        raise web.HTTPNotFound(text="Demo missing")
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if demo_scene._live(confirmed).get(name) != demo_scene._live(listed).get(name):
        raise web.HTTPConflict(text="Demo session replaced")
    if expected_created is not None and demo_scene._live(confirmed).get(name) != expected_created:
        raise web.HTTPConflict(text="Demo session replaced")
    if scene is None:
        raise web.HTTPNotFound(text="Demo revision unavailable")
    return scene


def _demo_json_response(value):
    headers = {"Cache-Control": "no-store"}
    if isinstance(value, dict) and value.get("format") in ("mesh-scene-v0", "mesh-scene-v1"):
        headers["X-Mesh-Frame-Sandbox"] = demo_scene.frame_sandbox(value)
    return web.json_response(value, headers=headers)


async def api_demo_scene_self_get(request):
    return _demo_json_response(await _demo_scene_get(
        request["mesh_session"], expected_created=request["mesh_session_created"]))


async def api_demo_scene_self_revisions(request):
    name = request["mesh_session"]
    created = request["mesh_session_created"]
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        summary = await asyncio.to_thread(demo_scene.revisions, name, listed)
    except demo_scene.NotLive:
        raise web.HTTPNotFound(text="Demo session missing")
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if demo_scene._live(confirmed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    return web.json_response(summary, headers={"Cache-Control": "no-store"})


async def api_demo_scene_owner_get(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    try:
        created = float(request.query["created"])
    except (KeyError, TypeError, ValueError):
        raise web.HTTPBadRequest()
    if not math.isfinite(created):
        raise web.HTTPBadRequest()
    try:
        version = int(request.query["version"]) if "version" in request.query else None
    except (TypeError, ValueError):
        raise web.HTTPBadRequest()
    return _demo_json_response(await _demo_scene_get(
        name, version=version, expected_created=created))


def _demo_owner_identity(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    try:
        created = float(request.query["created"])
    except (KeyError, TypeError, ValueError):
        raise web.HTTPBadRequest()
    if not math.isfinite(created):
        raise web.HTTPBadRequest()
    return name, created


async def api_demo_scene_owner_catalog(request):
    name, created = _demo_owner_identity(request)
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        rows = await asyncio.to_thread(demo_scene.list_demos, name, listed)
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    if demo_scene._live(await host({"op": "list"})).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    return web.json_response(rows, headers={"Cache-Control": "no-store"})


async def api_demo_scene_owner_selected(request):
    name, created = _demo_owner_identity(request)
    demo_id = request.query.get("demo_id")
    if demo_id is None:
        raise web.HTTPBadRequest(text="Demo ID required")
    try:
        version = int(request.query["version"]) if "version" in request.query else None
    except (TypeError, ValueError):
        raise web.HTTPBadRequest()
    return _demo_json_response(await _demo_scene_get(
        name, version=version, expected_created=created, demo_id=demo_id))


async def _demo_owner_catalog_call(request, operation, *args):
    name, created = _demo_owner_identity(request)
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        result = await asyncio.to_thread(operation, name, *args, listed)
    except demo_scene.NotLive:
        raise web.HTTPNotFound(text="Demo session missing")
    except demo_scene.DemoNotFound:
        raise web.HTTPNotFound(text="Demo missing")
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    except demo_scene.Conflict as exc:
        raise web.HTTPConflict(text=str(exc) or "Demo version out of date")
    except demo_scene.CapacityError as exc:
        raise web.HTTPInsufficientStorage(text=str(exc))
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    if demo_scene._live(await host({"op": "list"})).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    return _demo_json_response(result)


async def api_demo_scene_owner_named_revisions(request):
    if set(request.query) != {"created", "demo_id"}:
        raise web.HTTPBadRequest(text="Invalid revisions request")
    demo_id = request.query.get("demo_id")
    if demo_id is None:
        raise web.HTTPBadRequest(text="Demo ID required")
    return await _demo_owner_catalog_call(request, demo_scene.demo_revisions, demo_id)


async def _read_demo_scene_body(request):
    if request.content_length is not None and request.content_length > demo_scene.MAX_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=demo_scene.MAX_BYTES, actual_size=request.content_length)
    chunks, size = [], 0
    async for chunk in request.content.iter_chunked(8192):
        size += len(chunk)
        if size > demo_scene.MAX_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=demo_scene.MAX_BYTES, actual_size=size)
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Invalid demo scene")


async def api_demo_scene_self_put(request):
    scene = await _read_demo_scene_body(request)
    name = request["mesh_session"]
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != request["mesh_session_created"]:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        saved = await asyncio.to_thread(demo_scene.replace, name, scene, listed)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    except demo_scene.NotLive:
        raise web.HTTPNotFound(text="Demo session missing")
    except demo_scene.Conflict:
        raise web.HTTPConflict(text="Demo version out of date")
    except demo_scene.CapacityError as exc:
        raise web.HTTPInsufficientStorage(text=str(exc))
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if demo_scene._live(confirmed).get(name) != demo_scene._live(listed).get(name):
        raise web.HTTPConflict(text="Demo session replaced")
    if demo_scene._live(confirmed).get(name) != request["mesh_session_created"]:
        raise web.HTTPConflict(text="Demo session replaced")
    return _demo_json_response(saved)


async def _demo_catalog_call(request, operation, *args):
    name = request["mesh_session"]
    created = request["mesh_session_created"]
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        result = await asyncio.to_thread(operation, name, *args, listed)
    except demo_scene.NotLive:
        raise web.HTTPNotFound(text="Demo session missing")
    except demo_scene.DemoNotFound:
        raise web.HTTPNotFound(text="Demo missing")
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    except demo_scene.Conflict as exc:
        raise web.HTTPConflict(text=str(exc) or "Demo version out of date")
    except demo_scene.CapacityError as exc:
        raise web.HTTPInsufficientStorage(text=str(exc))
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if demo_scene._live(confirmed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    return _demo_json_response(result)


async def api_demo_scene_self_catalog(request):
    return await _demo_catalog_call(request, demo_scene.list_demos)


async def api_demo_scene_self_create(request):
    return await _demo_catalog_call(request, demo_scene.create_demo, await _read_demo_scene_body(request))


async def api_demo_scene_self_selected_get(request):
    demo_id = request.query.get("demo_id")
    if demo_id is None:
        raise web.HTTPBadRequest(text="Demo ID required")
    return await _demo_catalog_call(request, demo_scene.get_demo, demo_id)


async def api_demo_scene_self_selected_put(request):
    demo_id = request.query.get("demo_id")
    if demo_id is None:
        raise web.HTTPBadRequest(text="Demo ID required")
    return await _demo_catalog_call(request, demo_scene.update_demo, demo_id, await _read_demo_scene_body(request))


async def api_demo_scene_self_named_revisions(request):
    if set(request.query) != {"demo_id"}:
        raise web.HTTPBadRequest(text="Invalid revisions request")
    demo_id = request.query.get("demo_id")
    if demo_id is None:
        raise web.HTTPBadRequest(text="Demo ID required")
    return await _demo_catalog_call(request, demo_scene.demo_revisions, demo_id)


async def _read_demo_restore_body(request):
    limit = 256
    if request.content_length is not None and request.content_length > limit:
        raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=request.content_length)
    raw = await request.content.read(limit + 1)
    if len(raw) > limit:
        raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(raw))
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Invalid demo restore")
    if (not isinstance(body, dict)
            or set(body) != {"demo_id", "version", "expected_version"}
            or not isinstance(body["demo_id"], str)):
        raise web.HTTPBadRequest(text="Invalid demo restore")
    return body


async def api_demo_scene_self_named_restore(request):
    body = await _read_demo_restore_body(request)
    return await _demo_catalog_call(request, demo_scene.restore_demo,
                                    body["demo_id"], body["version"],
                                    body["expected_version"])


async def api_demo_scene_owner_named_restore(request):
    if set(request.query) != {"created"}:
        raise web.HTTPBadRequest(text="Invalid restore request")
    body = await _read_demo_restore_body(request)
    return await _demo_owner_catalog_call(request, demo_scene.restore_demo,
                                          body["demo_id"], body["version"],
                                          body["expected_version"])


async def api_demo_scene_self_open(request):
    await opens._require_empty_body(request)
    opens.record_demo_scene_open(request["mesh_session"], request["mesh_session_created"])
    return web.json_response({"ok": True})


async def api_demo_scene_self_open_named(request):
    if request.content_length is not None and request.content_length > 128:
        raise web.HTTPRequestEntityTooLarge(max_size=128, actual_size=request.content_length)
    raw = await request.content.read(129)
    if len(raw) > 128:
        raise web.HTTPRequestEntityTooLarge(max_size=128, actual_size=len(raw))
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Invalid demo ID")
    if not isinstance(body, dict) or set(body) != {"demo_id"} or not isinstance(body["demo_id"], str):
        raise web.HTTPBadRequest(text="Invalid demo ID")
    name, created = request["mesh_session"], request["mesh_session_created"]
    listed = await host({"op": "list"})
    if demo_scene._live(listed).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    try:
        await asyncio.to_thread(demo_scene.get_demo, name, body["demo_id"], listed)
    except (ValueError, demo_scene.DemoNotFound):
        raise web.HTTPNotFound(text="Demo missing")
    except demo_scene.StorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    if demo_scene._live(await host({"op": "list"})).get(name) != created:
        raise web.HTTPConflict(text="Demo session replaced")
    opens.record_demo_scene_open(name, created, body["demo_id"])
    return web.json_response({"ok": True})


async def demo_scene_frame(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    try:
        version = int(request.match_info["version"])
    except ValueError:
        raise web.HTTPBadRequest()
    if version < 0 or version > 2**31 - 1:
        raise web.HTTPBadRequest()
    try:
        created = float(request.query["created"])
    except (KeyError, TypeError, ValueError):
        raise web.HTTPBadRequest()
    if not math.isfinite(created):
        raise web.HTTPBadRequest()
    scene = await _demo_scene_get(name, version, expected_created=created,
                                  demo_id=request.match_info.get("demo_id"))
    return web.Response(text=demo_scene.render(scene), content_type="text/html", headers={
        "Cache-Control": "no-store", "Content-Security-Policy": demo_scene.csp_for(scene),
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin"})


# ---------------------------------------------------------------- Excalidraw whiteboard

def board_response(document):
    return web.json_response(document, headers={"Cache-Control": "no-store"})


def _purge_board_signal(name):
    SIGNALS.discard("board.updated", "board", name)


def _purge_board_open(name):
    opens.discard_board_open(name)


def _purge_invalid_board_signals(listed):
    """Forget a board hint as soon as its `(name, created)` stops being live."""
    live = board._live(listed)
    SIGNALS.discard_if(lambda reference, created:
                       reference["type"] == "board.updated" and reference["object"]["kind"] == "board"
                       and live.get(reference["object"]["id"]) != created)


async def api_board_get(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    return await api_board_get_for(name)


async def api_board_put(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    document = await json_object(request)
    return await api_board_put_for(name, document, "owner")


async def api_board_self_get(request):
    """The board of the authenticated live session, never a client-supplied name."""
    return await api_board_get_for(request["mesh_session"])


async def api_board_self_put(request):
    """CAS-write only the authenticated live session's board."""
    document = await json_object(request)
    return await api_board_put_for(request["mesh_session"], document, "mcp-session")


async def api_board_get_for(name):
    listed = await host({"op": "list"})
    try:
        document = await asyncio.to_thread(board.get, name, listed)
    except board.BoardNotLive:
        raise web.HTTPNotFound()
    except board.BoardStorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if board._live(confirmed).get(name) != board._live(listed).get(name):
        raise web.HTTPConflict(text="Session replaced: reload the whiteboard")
    return board_response(document)


def _publish_board_update(name, saved, confirmed, provenance):
    """Tell the pages a board changed; an agent's write also asks an open pane to refresh itself.

    Both are content-free references. The pane, not the server, decides whether a
    local drawing is at risk: it reloads by itself only when nothing local would be
    lost and otherwise offers the reload.
    """
    identity = board._live(confirmed)[name]
    SIGNALS.publish(board.updated_envelope(name, saved["version"], time.time()), identity)
    if provenance == "mcp-session":
        opens.record_board_refresh(name, identity)


async def api_board_put_for(name, document, provenance):
    listed = await host({"op": "list"})
    try:
        saved = await asyncio.to_thread(board.replace, name, document, listed, provenance, time.time())
    except board.BoardNotLive:
        raise web.HTTPNotFound()
    except board.BoardConflict:
        raise web.HTTPConflict()
    except board.BoardStorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    confirmed = await host({"op": "list"})
    if board._live(confirmed).get(name) != board._live(listed).get(name):
        raise web.HTTPConflict(text="Session replaced: reload the whiteboard")
    # Publish only after every check that can reject this CAS write.  The
    # declared reference is content-free and the bounded registry copies it.
    _publish_board_update(name, saved, confirmed, provenance)
    return board_response(saved)


def _revision_version(request, key):
    raw = request.query.get(key)
    if raw is None or not raw.isascii() or not raw.isdecimal() or len(raw) > 9:
        raise web.HTTPBadRequest()
    value = int(raw)
    if value > 1_000_000_000:
        raise web.HTTPBadRequest()
    return value


async def _board_revision_response(name, request, mode):
    listed = await host({"op": "list"})
    try:
        if mode == "latest":
            response = await asyncio.to_thread(board.latest_change, name, listed)
        elif mode == "list":
            result = await asyncio.to_thread(board.revisions, name, listed)
            response = {"revisions": result}
        elif mode == "read":
            response = await asyncio.to_thread(board.revision, name, _revision_version(request, "version"), listed)
        else:
            response = await asyncio.to_thread(board.revision_diff, name,
                                                _revision_version(request, "from_version"),
                                                _revision_version(request, "to_version"), listed)
    except board.BoardNotLive:
        raise web.HTTPNotFound()
    except board.BoardStorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if board._live(confirmed).get(name) != board._live(listed).get(name):
        raise web.HTTPConflict(text="Session replaced")
    return web.json_response(response, headers={"Cache-Control": "no-store"})


async def api_board_revisions(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name) or request.query:
        raise web.HTTPBadRequest()
    return await _board_revision_response(name, request, "list")


async def api_board_revision(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name) or set(request.query) != {"version"}:
        raise web.HTTPBadRequest()
    return await _board_revision_response(name, request, "read")


async def api_board_revision_diff(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name) or set(request.query) != {"from_version", "to_version"}:
        raise web.HTTPBadRequest()
    return await _board_revision_response(name, request, "diff")


async def api_board_self_revisions(request):
    if request.query:
        raise web.HTTPBadRequest()
    return await _board_revision_response(request["mesh_session"], request, "list")


async def api_board_self_revision(request):
    if set(request.query) != {"version"}:
        raise web.HTTPBadRequest()
    return await _board_revision_response(request["mesh_session"], request, "read")


async def api_board_self_revision_diff(request):
    if set(request.query) != {"from_version", "to_version"}:
        raise web.HTTPBadRequest()
    return await _board_revision_response(request["mesh_session"], request, "diff")


async def api_board_self_latest_change(request):
    if request.query:
        raise web.HTTPBadRequest()
    return await _board_revision_response(request["mesh_session"], request, "latest")


def _restore_body(body):
    if set(body) != {"version", "expected_version"}:
        raise web.HTTPBadRequest()
    values = (body["version"], body["expected_version"])
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 1_000_000_000
           for value in values):
        raise web.HTTPBadRequest()
    return values


async def _board_restore_for(name, request, provenance):
    version, expected_version = _restore_body(await json_object(request))
    listed = await host({"op": "list"})
    try:
        saved = await asyncio.to_thread(board.restore, name, version, expected_version, listed, provenance, time.time())
    except board.BoardNotLive:
        raise web.HTTPNotFound()
    except board.BoardConflict:
        raise web.HTTPConflict(text="Whiteboard version out of date")
    except ValueError:
        raise web.HTTPNotFound(text="Whiteboard revision unavailable")
    except board.BoardStorageError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))
    confirmed = await host({"op": "list"})
    if board._live(confirmed).get(name) != board._live(listed).get(name):
        raise web.HTTPConflict(text="Session replaced: reload the whiteboard")
    _publish_board_update(name, saved, confirmed, provenance)
    return board_response(saved)


async def api_board_restore(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name):
        raise web.HTTPBadRequest()
    return await _board_restore_for(name, request, "owner")


async def api_board_self_restore(request):
    return await _board_restore_for(request["mesh_session"], request, "mcp-session")


# ---------------------------------------------------------------- agent mailbox

def _agent_mail_live(listed):
    """The deliberately small cross-session identity surface.

    A mailbox address is a live terminal incarnation, not a terminal command,
    cwd or a bearer token.
    """
    if not _valid_ptyhost_list(listed):
        raise web.HTTPServiceUnavailable(text="Invalid session list")
    result = []
    for item in listed:
        meta = item["meta"]
        agent = meta.get("known_agent") or meta.get("agent")
        if agent in AGENT_MAIL_PRESETS and not _session_notice(item):   # a bare launch has no mailbox
            result.append({"id": item["name"], "created": item["created"], "agent": agent})
    return result


async def _agent_mail_context(request):
    listed = await host({"op": "list"})
    live = _agent_mail_live(listed)
    source = next((identity for identity in live
                   if identity["id"] == request["mesh_session"]
                   and identity["created"] == request["mesh_session_created"]), None)
    if source is None:
        # A MeshSession token from a shell is not an agent-to-agent capability.
        raise web.HTTPForbidden(text="Only agent sessions can use messaging")
    return source, live


def _codex_threads(listed, wanted):
    """{(name, created): conversation UUID} for the Codex incarnations of ``wanted`` whose conversation is
    exact: the agent is Codex in the foreground and holds its rollout open (``open_rollout``), the only
    source that names the conversation the process is in. A guess (``cwd_unique``) or no conversation is
    absent: never a name, never a guess."""
    procs = discover.snapshot()
    found = {}
    for item in listed:
        key = (item["name"], item["created"])
        if key not in wanted:
            continue
        agent = discover.describe(procs, item["pid"])["agent"]
        thread = agent.get("session_id") if agent else None
        if (agent and agent.get("type") == "codex" and agent.get("identity_source") == "open_rollout"
                and agent.get("foreground") is True and isinstance(thread, str)
                and agentwake.THREAD_RE.fullmatch(thread)):
            found[key] = thread
    return found


async def _codex_thread(name, created):
    """The exact conversation of one live Codex incarnation right now, or None."""
    listed = await host({"op": "list"})
    if not _valid_ptyhost_list(listed):
        return None
    return (await asyncio.to_thread(_codex_threads, listed, {(name, created)})).get((name, created))


async def _codex_exact_for(listed, live, codex_wakes):
    """{(name, created): conversation UUID} of the live Codex incarnations that can be woken."""
    if codex_wakes is None or not codex_wakes.enabled:
        return {}
    await asyncio.to_thread(codex_wakes.retain, [(item.get("name"), item.get("created")) for item in listed])
    codex_live = {(i["id"], i["created"]) for i in live if i["agent"] == "codex"}
    if not codex_live or codex_wakes.executable() is None:
        return {}
    return await asyncio.to_thread(_codex_threads, listed, codex_live)


async def _claude_wake_housekeeping(listed, claude_wakes):
    """Forget the sockets and the remembered wake lines of Claude incarnations the host no longer lists."""
    if claude_wakes is None:
        return
    # Sockets of incarnations the host no longer lists (a Claude killed abruptly).
    await asyncio.to_thread(claude_wakes.sweep, [(item.get("meta") or {}).get("nonce") for item in listed])
    # The remembered wake lines of incarnations that are gone.
    await asyncio.to_thread(claude_wakes.retain, [(item.get("name"), item.get("created")) for item in listed])


async def _agent_wake_live(pi_connections=None, event_state=None, claude_wakes=None, codex_wakes=None):
    listed = await host({"op": "list"})
    live = _agent_mail_live(listed)
    codex_exact = await _codex_exact_for(listed, live, codex_wakes)
    await _claude_wake_housekeeping(listed, claude_wakes)
    by_incarnation = {(item["name"], item["created"]): item for item in listed}
    for identity in live:
        item = by_incarnation[(identity["id"], identity["created"])]
        capabilities = item.get("pty_capabilities")
        thread = codex_exact.get((identity["id"], identity["created"]))
        if identity["agent"] == "codex" and thread is not None:
            # No idle signal, so nothing is typed: `codex queue` for this exact conversation.
            identity["wake_codex"] = {"thread": thread}
            identity["wake_capable"] = True
            continue
        if identity["agent"] != "pi" and identity["agent"] not in AGENT_WAKE_PRESETS:
            identity["wake_unsupported"] = True   # no idle signal: never typed
        elif identity["agent"] in AGENT_WAKE_PRESETS:
            nonce = item["meta"].get("nonce")
            known = event_state is not None and isinstance(nonce, str)
            identity["idle_since"] = event_state.idle_since(identity["id"], nonce) if known else None
            # Carried with the snapshot: compared again once the notice is typed.
            identity["idle_generation"] = (
                event_state.idle_generation(identity["id"], nonce) if known else None)
            path = claude_wakes.target(nonce) if claude_wakes is not None else None
            if path is not None:
                # Server-derived from this incarnation's nonce, never from a request.
                identity["wake_socket"] = {
                    "path": path,
                    "turn": event_state.current_type(identity["id"], nonce) if known else None}
        # Missing, malformed and partial declarations are deliberately
        # incapable.  In particular, a Web update can safely run against an
        # older PTY owner without probing it with an unknown operation.
        identity["wake_capable"] = (
            (identity["agent"] == "pi" and pi_connections is not None
             and pi_connections.connected(identity)) or (
            identity["agent"] in AGENT_WAKE_PRESETS
            and isinstance(capabilities, list)
            and all(isinstance(value, str) for value in capabilities)
            and len(capabilities) == len(set(capabilities))
            and {"agent_wake_v1", "human_input_lease_v1"}.issubset(capabilities))
        )
    return live


async def api_pi_wake_stream(request):
    source, _ = await _agent_mail_context(request)
    if source["agent"] != "pi":
        raise web.HTTPForbidden()
    return await request.app["pi_wakes"].stream(request, source)


async def api_pi_wake_ack(request):
    source, _ = await _agent_mail_context(request)
    if source["agent"] != "pi":
        raise web.HTTPForbidden()
    body = await json_object(request)
    if set(body) != {"notification_id"} or not isinstance(body["notification_id"], str) \
            or not agentmail.ID_RE.fullmatch(body["notification_id"]):
        raise web.HTTPBadRequest()
    if not request.app["pi_wakes"].acknowledge(source, body["notification_id"]):
        raise web.HTTPConflict()
    return web.json_response({"ok": True})


async def start_agent_wakes(app):
    await app["agent_wakes"].start()


async def stop_agent_wakes(app):
    await app["agent_wakes"].close()


def _agent_mail_failure(exc):
    if isinstance(exc, (agentmail.MailNotLive, agentmail.MailNotFound)):
        raise web.HTTPNotFound(text="Agent message or session unavailable")
    if isinstance(exc, agentmail.MailFull):
        raise web.HTTPConflict(text="Agent inbox full")
    if isinstance(exc, agentmail.MailStorageError):
        raise web.HTTPServiceUnavailable(text=str(exc))
    if isinstance(exc, agentmail.MailInvalidRequest):
        raise web.HTTPBadRequest(text=str(exc))
    raise exc


def _agent_mail_body(body, expected):
    if set(body) != expected:
        raise web.HTTPBadRequest(text="Invalid agent message fields")
    return body


async def api_agent_mail_peers(request):
    if request.query:
        raise web.HTTPBadRequest()
    source, live = await _agent_mail_context(request)
    try:
        peers = await asyncio.to_thread(agentmail.peers, source, live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    return web.json_response({"peers": peers}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_inbox(request):
    if request.query:
        raise web.HTTPBadRequest()
    source, live = await _agent_mail_context(request)
    try:
        messages = await asyncio.to_thread(agentmail.inbox, source, live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    # The agent looked at its inbox: this confirms a wake line sent on its socket.
    request.app["claude_wakes"].note_inbox_read(source["id"], source["created"])
    request.app["codex_wakes"].note_inbox_read(source["id"], source["created"])
    request.app["agent_wakes"].trigger()
    return web.json_response({"messages": messages}, headers={"Cache-Control": "no-store"})


# ------------------------------------------------------ owner-approved session actions

async def _session_action_source(request):
    source, _live = await _agent_mail_context(request)
    listed = await host({"op": "list"})
    raw = next((item for item in listed if item["name"] == source["id"]
                and item["created"] == source["created"]), None)
    if raw is None:
        raise web.HTTPConflict(text="Requesting session replaced")
    return {**source, "cwd": raw["cwd"]}


async def api_session_action_request(request):
    source = await _session_action_source(request)
    if request.method == "GET":
        if set(request.query) != {"id"}:
            raise web.HTTPBadRequest(text="Request ID required")
        item = request.app["session_requests"].own(request.query["id"], source)
        if item is None:
            raise web.HTTPNotFound()
        return web.json_response({"request": item}, headers={"Cache-Control": "no-store"})
    body, current = await json_object(request), None
    if body.get("action") == "switch_account" and set(body) == {"action", "account"}:
        body, current = await _switch_request(source, body)
    try:
        item = request.app["session_requests"].create(
            source, body, enabled_agents=set(AGENT_PRESETS),
            resumable=RESUMABLE_AGENT_PRESETS, current_account=current)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    return web.json_response({"request": item}, status=202,
                             headers={"Cache-Control": "no-store"})


# ---- Account switch requests (session_account_switch_request): the session's agent asks to continue its
# conversation under another account. Checked here before it is queued, then, once the owner approved it: the
# exact source stopped, `mesh-platform accounts carry` copies the conversation, the agent resumes under the target;
# a failed carry resumes it under its own account. The agent kind is the session's (its token), never the body's.
CARRY_TIMEOUT = 300
# The carry's refusal codes (Mesh_accounts_carry): these two may pass when asked again later; these two leave
# something in the target folder for the operator to look at (named in the service log). Every other code is a
# refusal that asking again does not change. Each carry runs as its own mesh-platform process: its fcntl lock does
# not exclude two carries of one process.
CARRY_RETRYABLE = frozenset(("carry_in_progress", "target_no_space"))
CARRY_NEEDS_OPERATOR = frozenset(("carry_restore_failed", "carry_rollback_incomplete"))


def _switch_undone_text(from_account, exc):
    """What the agent relays of an undone switch: where the conversation went on, the carry's cause, what next."""
    advice = (" Asking again later may work." if exc.code in CARRY_RETRYABLE
              else " The operator must check the target account's folder (see the service log) before another "
                   "switch; do not ask again." if exc.code in CARRY_NEEDS_OPERATOR
              else " Asking again does not change this.")
    return f"Switch undone: the conversation resumed under account {from_account}. Cause: {exc.code}: {str(exc).rstrip('.')}.{advice}"


def _switch_refusal(code, message):
    """A refused switch request: {"error": {"code", "message"}}, which the mesh-board client hands the agent."""
    return web.HTTPBadRequest(text=json.dumps({"error": {"code": code, "message": message}}),
                              content_type="application/json")


_ACCOUNTS_REFUSED_TEXT = "accounts.json is missing or refused on the runner; no alias is offered (details in the " \
                         "service log)."


def _shown_accounts(accounts):
    """``id (label), …`` of accounts as a refusal lists them: ids and labels, never a folder."""
    return ", ".join(f"{a['id']} ({a['label']})" for a in accounts
                     if isinstance(a, dict) and isinstance(a.get("id"), str) and isinstance(a.get("label"), str))


def _resolve_refusal(exc, name, kind, unknown):
    """The coded refusal of a name `mesh-platform accounts resolve` refused; its reason goes to the log only."""
    print(f"account name for a switch refused: {exc.code}: {exc}", flush=True)
    if exc.code == "account_ambiguous":
        return _switch_refusal("account_ambiguous", f"“{name}” matches several accounts: "
                               f"{_shown_accounts(exc.candidates or [])}. Name one by an id that is no other "
                               "account's label, or ask the operator to change a label.")
    if exc.code == "account_no_agent":
        declared = next((a for a in accounts_projection() if a["id"] == name), None)
        if declared is not None:
            serves = ", ".join(ACCOUNT_MEMBER[k][2] for k in ACCOUNT_MEMBER if declared[k])
            return _switch_refusal("account_no_agent", f"Account {declared['label']} has no "
                                   f"{ACCOUNT_MEMBER[kind][2]} folder; it serves: {serves}.")
        return _switch_refusal("account_no_agent", f"Account {name} has no {ACCOUNT_MEMBER[kind][2]} folder.")
    if exc.code == "account_unknown":
        return unknown
    return _switch_refusal("accounts_refused", _ACCOUNTS_REFUSED_TEXT)


async def _switch_target(name, kind):
    """{"id", "label"} of the account ``name`` designates for a ``kind`` agent, as `mesh-platform accounts resolve`
    answers (Mesh_account_resolver, the one place that matches names): its exact id, else the one label equal to it
    ignoring ASCII case; never a prefix, never another agent's account, and a name that is one account's id and
    another's label designates neither. Without a usable accounts.json only ``default`` can be named."""
    shown = name if isinstance(name, str) and 0 < len(name) <= 64 and name.isprintable() else None
    offered = [DEFAULT_ACCOUNT, *({**a, "label": account_label(a["id"], kind)} for a in accounts_projection() if a[kind])]
    unknown = _switch_refusal("account_unknown", f"No {ACCOUNT_MEMBER[kind][2]} account “{shown or '?'}” is "
                              f"declared. Available: {_shown_accounts(offered)}.")
    if shown is None:
        raise unknown
    if _ACCOUNTS["file"] != "ok":
        if name == DEFAULT_ACCOUNT["id"]:
            return DEFAULT_ACCOUNT
        raise _switch_refusal("accounts_refused", _ACCOUNTS_REFUSED_TEXT) if _ACCOUNTS["file"] == "refused" else unknown
    try:
        answer = (await _accounts_program("resolve", str(ACCOUNTS_FILE), kind, name)).get("account")
    except AccountsUnavailable as exc:
        raise _resolve_refusal(exc, shown, kind, unknown) from exc
    if (not isinstance(answer, dict) or answer.get("backend") != kind or not isinstance(answer.get("label"), str)
            or not (answer.get("id") == DEFAULT_ACCOUNT["id"] or ACCOUNT_ID_RE.fullmatch(str(answer.get("id"))))):
        print(f"accounts resolve answered an unexpected account for a switch: {answer!r}", flush=True)
        raise _switch_refusal("accounts_refused", _ACCOUNTS_REFUSED_TEXT)
    return {"id": answer["id"], "label": answer["label"]}


def _switch_conversation(described, source):
    """The exact conversation id of the source's agent, or None (unknown, another agent running, or guessed: every
    source the listing counts as a guess, Codex's cwd_unique included, since a guess may be another conversation)."""
    entry = next((e for e in described["mesh"] if e["id"] == source["id"] and e["created"] == source["created"]), None)
    agent = entry and entry.get("agent")
    if (not agent or agent.get("type") != source["agent"] or not agent.get("session_id")
            or discover._guessed_source(agent.get("identity_source"))):
        return None
    return agent["session_id"]


async def _switch_request(source, body):
    """({"action", "account": target id}, current account id) of a switch request that can be carried out now,
    else a coded refusal. The target folder is prepared (created 0700 when missing) as for a launch."""
    kind = source["agent"]
    if kind not in ACCOUNT_MEMBER:
        raise _switch_refusal("agent_unsupported", "Account switching applies to Claude and Codex only.")
    await declared_accounts()
    target = await _switch_target(body["account"], kind)
    listed = await host({"op": "list"})
    raw = next((item for item in listed if item["name"] == source["id"] and item["created"] == source["created"]), None)
    if raw is None:
        raise web.HTTPConflict(text="Requesting session replaced")
    current = session_account(raw) or DEFAULT_ACCOUNT["id"]
    if target["id"] == current:
        raise _switch_refusal("account_same", f"This session already runs under {target['label']}.")
    sid = _switch_conversation(await asyncio.to_thread(_describe_with_hooks, listed), source)
    if sid is None:
        raise _switch_refusal("conversation_unknown",
                              "The exact conversation id is unknown; it cannot be resumed elsewhere.")
    folder = None if current == DEFAULT_ACCOUNT["id"] else current
    if not await asyncio.to_thread(_conversation_found, kind, sid, folder):
        raise _switch_refusal("conversation_not_found", "The conversation is not in the current account's folder.")
    try:
        await account_environment(None if target["id"] == DEFAULT_ACCOUNT["id"] else target["id"], kind)
    except web.HTTPBadRequest as exc:
        raise _switch_refusal("account_folder_refused", f"The folder of account {target['label']} is refused; see "
                              "the service log.") from exc
    return {"action": "switch_account", "account": target["id"]}, current


def _carry_env(kind):
    """The carry's environment: the server's, with the default account's folder variable when it is absolute
    (what the default account's agents use, as _conversation_missing reads it)."""
    variable = ACCOUNT_MEMBER[kind][1]
    configured = os.environ.get(variable) or ""
    return {**work_child_env(), **({variable: configured} if os.path.isabs(configured) else {})}


async def _switch_session(item, raw, conversation, argv):
    """Carry out an approved switch: the source stopped, its conversation carried, then resumed under the target
    (a failed carry: under the source again, AccountSwitchUndone)."""
    kind, account = item["source"]["agent"], session_account(raw)
    if (account or DEFAULT_ACCOUNT["id"]) != item["from_account"]:
        raise web.HTTPConflict(text="The session's account changed since the request")

    async def carry():
        await _accounts_program("carry", str(ACCOUNTS_FILE), kind, conversation, item["from_account"],
                                item["account"], timeout=CARRY_TIMEOUT, env=_carry_env(kind))

    target = None if item["account"] == DEFAULT_ACCOUNT["id"] else item["account"]
    try:
        name = await replace_session(raw["name"], raw["created"], raw["name"], raw["cwd"], shlex.join(argv), kind,
                                     kind, account=account, switch=(target, carry), source=raw)
    except AccountSwitchUndone:   # the source was stopped all the same
        await asyncio.to_thread(respawn.forget_live, raw["name"], raw["created"])
        raise
    await asyncio.to_thread(respawn.forget_live, raw["name"], raw["created"])
    return {"id": name, "account": item["account"]}


def _account_label_of(account, backend=None):
    """The label of an account id of a request, "default" included."""
    return DEFAULT_ACCOUNT["label"] if account == DEFAULT_ACCOUNT["id"] else account_label(account, backend)


def _with_account_labels(item):
    """A pending request as the page shows it: a switch carries the labels of both accounts."""
    if item.get("action") != "switch_account":
        return item
    backend = item["source"]["agent"]
    return {**item, "account_label": _account_label_of(item["account"], backend),
            "from_label": _account_label_of(item["from_account"], backend)}


async def api_session_accounts(request):
    """The account alias the calling session's agent runs under and the declared aliases (ids, labels and the
    agents each serves; never a folder), for the mesh-board `session_accounts` tool. The session is the token's
    and the agent kind the one recorded at launch: the route takes no parameter."""
    if request.query:
        raise web.HTTPBadRequest(text="This route takes no parameter")
    source, _live = await _agent_mail_context(request)
    listed = await host({"op": "list"})
    raw = next((item for item in listed if item["name"] == source["id"]
                and item["created"] == source["created"]), None)
    if raw is None:
        raise web.HTTPConflict(text="Requesting session replaced")
    declared = await declared_accounts()
    current = session_account(raw)
    return web.json_response({
        "agent": source["agent"],
        "switch_qualified": False,
        "accounts_file": _ACCOUNTS["file"],
        "current": ({"id": current, "label": account_label(current, source["agent"]),
                     "declared": any(a["id"] == current for a in declared)} if current
                    else {"id": DEFAULT_ACCOUNT["id"], "label": DEFAULT_ACCOUNT["label"], "declared": True}),
        "accounts": [DEFAULT_ACCOUNT, *accounts_projection()],
    }, headers={"Cache-Control": "no-store"})


def _model_argv(argv, model):
    if model is None:
        return list(argv)
    kept, i = [], 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--model", "-m") and i + 1 < len(argv):
            i += 2
        elif arg.startswith("--model="):
            i += 1
        else:
            kept.append(arg)
            i += 1
    return [*kept, "--model", model]


async def _execute_session_action(item):
    source = item["source"]
    listed = await host({"op": "list"})
    raw = next((entry for entry in listed if entry["name"] == source["id"]
                and entry["created"] == source["created"]), None)
    if raw is None:
        raise web.HTTPConflict(text="Requesting session replaced")
    if not os.path.isdir(raw["cwd"]):
        raise web.HTTPConflict(text="Session folder not found")
    if not LAUNCH_SETTINGS.allows_cwd(raw["cwd"]):
        raise web.HTTPForbidden(text=OUTSIDE_WORKSPACE_ROOTS)
    if item["action"] == "create":
        if item["preset"] not in AGENT_PRESETS:
            raise web.HTTPConflict(text=f"Agent {item['preset']} is disabled in the configuration")
        agent = launchplan.agent_type(item["preset"])
        argv, conversation = _chosen_launch(agent, _model_argv(AGENT_PRESETS[item["preset"]], item["model"]))
        name = await new_session(item["name"] or f"{Path(raw['cwd']).name}-{item['preset']}",
                                 raw["cwd"], shlex.join(argv),
                                 agent if agent in RESUMABLE_AGENT_PRESETS else None, agent,
                                 conversation=conversation)
        return {"id": name}

    described = await asyncio.to_thread(_describe_with_hooks, listed)
    current = next((entry for entry in described["mesh"] if entry["id"] == source["id"]
                    and entry["created"] == source["created"]), None)
    agent = current and current.get("agent")
    if not agent or agent.get("type") != source["agent"]:
        raise web.HTTPConflict(text="Agent to resume unavailable")
    argv = _model_argv(_resume_argv(agent), item["model"])
    if item["action"] == "switch_account":   # checked again: the conversation may only be guessed by now
        if _switch_conversation(described, source) is None:
            raise web.HTTPConflict(text="The exact conversation id is unknown; it cannot be resumed elsewhere")
        if not await asyncio.to_thread(_conversation_found, source["agent"], agent["session_id"],
                                       session_account(raw)):   # checked again: nothing to carry, nothing stopped
            raise web.HTTPConflict(text="The conversation is not in the current account's folder")
        return await _switch_session(item, raw, agent["session_id"], argv)
    name = await replace_session(raw["name"], raw["created"], raw["name"], raw["cwd"],
                                 shlex.join(argv), source["agent"], source["agent"], account=session_account(raw),
                                 source=raw)
    await asyncio.to_thread(respawn.forget_live, raw["name"], raw["created"])
    return {"id": name}


async def _run_session_action(app, request_id):
    """Cross the durable execution boundary once, then record its outcome."""
    item = app["session_requests"].begin_execution(request_id)
    if item is None:
        return app["session_requests"].status(request_id)
    try:
        result = await _execute_session_action(item)
    except AccountSwitchUndone as exc:
        return app["session_requests"].finish(
            request_id, error=_switch_undone_text(item["from_account"], exc),
            detail={"rolled_back": True, "id": exc.name, "code": exc.code, "retryable": exc.code in CARRY_RETRYABLE,
                    "operator_action": exc.code in CARRY_NEEDS_OPERATOR})
    except web.HTTPException as exc:
        return app["session_requests"].finish(
            request_id, error=exc.text or "Action failed")
    except asyncio.CancelledError:
        # Leave `executing` durable. The next process reports an uncertain
        # result and, critically, never invokes the external mutation again.
        raise
    except Exception:
        return app["session_requests"].finish(request_id, error="Action failed")
    return app["session_requests"].finish(request_id, result=result)


def _schedule_session_action(app, request_id):
    tasks = app["session_action_tasks"]
    current = tasks.get(request_id)
    if current is not None and not current.done():
        return current
    task = asyncio.create_task(_run_session_action(app, request_id),
                               name=f"session-action:{request_id}")
    tasks[request_id] = task
    task.add_done_callback(lambda done, rid=request_id: tasks.pop(rid, None)
                           if tasks.get(rid) is done else None)
    return task


async def start_session_actions(app):
    for item in app["session_requests"].approved():
        _schedule_session_action(app, item["id"])


async def stop_session_actions(app):
    tasks = tuple(app["session_action_tasks"].values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def api_session_action_decision(request):
    request_id = request.match_info["request_id"]
    body = await json_object(request)
    if (set(body) != {"approve", "claim_nonce"} or not isinstance(body["approve"], bool)
            or not isinstance(body["claim_nonce"], str)):
        raise web.HTTPBadRequest(text="Invalid decision")
    item = request.app["session_requests"].decide(
        request_id, body["approve"], body["claim_nonce"])
    if item is None:
        raise web.HTTPConflict(text="Request missing, lease lost or incompatible decision")
    if not body["approve"]:
        return web.json_response({"request": item})
    if item["state"] != "approved":
        status = 202 if item["state"] == "executing" else 200
        return web.json_response({"request": item}, status=status,
                                 headers={"Cache-Control": "no-store"})
    # The task is app-owned. A disconnected browser loses only its response;
    # cancelling this handler cannot cancel or replay the mutation.
    finished = await asyncio.shield(_schedule_session_action(request.app, request_id))
    return web.json_response({"request": finished})


async def api_session_action_claim(request):
    request_id = request.match_info["request_id"]
    body = await json_object(request)
    if (set(body) not in ({"tab_nonce"}, {"tab_nonce", "claim_nonce"})
            or not isinstance(body["tab_nonce"], str)
            or ("claim_nonce" in body and not isinstance(body["claim_nonce"], str))):
        raise web.HTTPBadRequest(text="Invalid tab identity")
    try:
        claim = request.app["session_requests"].claim(
            request_id, body["tab_nonce"], body.get("claim_nonce"))
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    if claim is None:
        status = request.app["session_requests"].status(request_id)
        if status is None:
            raise web.HTTPNotFound()
        return web.json_response({"request": status}, status=409,
                                 headers={"Cache-Control": "no-store"})
    return web.json_response(claim, headers={"Cache-Control": "no-store"})


async def api_agent_mail_read(request):
    body = _agent_mail_body(await json_object(request), {"message_id"})
    source, live = await _agent_mail_context(request)
    try:
        message = await asyncio.to_thread(agentmail.read, source, body["message_id"], live)
    except agentmail.MailConsentPending as exc:
        return web.json_response({"pending": exc.request}, status=202,
                                 headers={"Cache-Control": "no-store"})
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    return web.json_response({"message": message}, headers={"Cache-Control": "no-store"})


def _require_owner_cookie(request):
    """Consent is a human-browser decision, never a master/session bearer action: any Authorization header, even
    an empty one, is refused (a browser sends none on these routes)."""
    if "Authorization" in request.headers:
        raise web.HTTPUnauthorized()
    if not has_owner_cookie(request):
        raise web.HTTPUnauthorized()


# ---- Account profiles and confirmation preferences (docs/backend-account-profiles.md, "HTTP routes"): the owner's
# browser reads and edits them through `mesh-profile --http OP`, which holds the registry, the store and every
# refusal. Only these six operations have a route: profiles.resolve (it returns folders) and any switch stay on the
# host. The server checks the caller and the request's bounds, then relays the helper's envelope and its status.
ACCOUNTS_ROUTES = {"/api/accounts/profiles": "profiles.list", "/api/accounts/consent": "consent.get",
                   "/api/accounts/consent/set-global": "consent.set_global",
                   "/api/accounts/consent/set-pair": "consent.set_pair",
                   "/api/accounts/consent/remove-pair": "consent.remove_pair",
                   "/api/accounts/consent/reset": "consent.reset"}
# The time limit outlasts the helper's own SQLite busy timeout (5 s, ocaml/lib/mesh_backend_store.ml), so that a
# contended store gives the helper's coded answer rather than ours.
ACCOUNTS_MAX_BODY, ACCOUNTS_TIMEOUT, ACCOUNTS_MAX_REPLY = 16384, 8.0, 1024 * 1024
ACCOUNTS_SLOTS = asyncio.Semaphore(4)
# Four helpers run and eight requests wait at most: one more is 503 busy at once, so a burst cannot pile up.
ACCOUNTS_MAX_PENDING, ACCOUNTS_QUEUE = 4 + 8, {"pending": 0}
_ACCOUNTS_STATUSES = frozenset((200, 400, 404, 409, 413, 503))
_ACCOUNTS_PUBLIC_PROFILE = {"id", "label", "backend", "enabled", "context_revision", "switch_qualified"}
_ACCOUNTS_POLICY, _ACCOUNTS_PAIR = {"version", "revision", "global", "pairs"}, {"a", "b", "confirmation"}
_ACCOUNTS_ACCOUNT, _ACCOUNTS_BACKENDS = {"backend", "id", "context_revision"}, ("claude", "codex", "opencode-v2", "pi")
_ACCOUNTS_CONFIRMATIONS = ("ask", "skip")
# A refusal's code and status as the helper pairs them (http_status in ocaml/bin/mesh_profile_main.ml; any other
# code is 503). tests/accounts-routes.test.ts compares the two.
_ACCOUNTS_CODE_STATUS = {
    "request-too-large": 413,
    "consent-revision-conflict": 409, "profile-registry-changed": 409, "profile-context-changed": 409,
    "consent-rule-capacity": 409, "consent-revision-exhausted": 409,
    "unknown-profile": 404, "profiles-unconfigured": 404,
    "invalid-request": 400, "unsupported-request-version": 400, "invalid-account-pair": 400,
    "invalid-account-reference": 400, "profile-backend-mismatch": 400, "unsupported-operation": 400}
_ACCOUNTS_CODE_RE = re.compile(r"[a-z0-9-]{1,64}")
_ACCOUNTS_DIGEST_RE = re.compile(r"[0-9a-f]{64}")   # a SHA-256 digest in hex


def _accounts_id(value):
    """A profile id as the helper accepts one (Mesh_accounts.valid_id, ocaml/accounts/mesh_accounts.ml: the alias id
    rule, not "default"); tests/accounts-routes.test.ts compares the two."""
    return isinstance(value, str) and value != "default" and ACCOUNT_ID_RE.fullmatch(value) is not None


def _accounts_digest(value):
    return isinstance(value, str) and _ACCOUNTS_DIGEST_RE.fullmatch(value) is not None


def accounts_refusal(status, code):
    """A refusal the server gives itself, in the helper's envelope (the page reads both the same way)."""
    return web.json_response({"http_status": status, "version": 1, "ok": False, "code": code}, status=status,
                             headers={"Cache-Control": "no-store"})


async def _profile_run(op, body):
    """(exit code, first line) of `mesh-profile --http OP` given BODY, or None: no helper, no start, no complete
    line within the time limit. Closed argv, its own process group, an environment that names the config folder
    only (no token, credential or provider variable of the server's)."""
    command, proc = work_command("mesh-profile"), None
    if command is None:
        return None
    async with ACCOUNTS_SLOTS:
        try:
            proc = await asyncio.create_subprocess_exec(
                command, "--http", op, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=ACCOUNTS_MAX_REPLY, start_new_session=True,
                env={"MESH_CONF_DIR": str(CONF_DIR), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            proc.stdin.write(body)
            proc.stdin.close()
            out, code = await asyncio.wait_for(asyncio.gather(proc.stdout.readline(), proc.wait()), ACCOUNTS_TIMEOUT)
        except (OSError, ValueError, asyncio.TimeoutError) as exc:   # ValueError: a line over the cap
            print(f"accounts: mesh-profile {op} gave no answer: {type(exc).__name__}", flush=True)
            return None
        finally:
            if proc is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
                proc._transport.close()  # unread output would keep wait() pending (Python 3.11, 3.12)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), 5)
    return code, out


def _profile_envelope(op, code, out):
    """The helper's reply when it is exactly its envelope (closed keys, a known status that agrees with `ok` and
    with the exit code; exactly the public listing for profiles.list), else None. A line without its newline is
    an incomplete answer."""
    if not out.endswith(b"\n"):
        return None
    try:
        reply = json.loads(out, object_pairs_hook=_accounts_unique_keys)
    except (ValueError, RecursionError):
        return None
    if not isinstance(reply, dict) or type(reply.get("version")) is not int or reply["version"] != 1:
        return None
    if type(reply.get("ok")) is not bool:
        return None
    ok, status = reply["ok"], reply.get("http_status")
    if set(reply) != {"http_status", "version", "ok", "data" if ok else "code"} or type(status) is not int:
        return None
    if status not in _ACCOUNTS_STATUSES or ok != (status == 200) or code != (0 if ok else 1):
        return None
    if not ok:
        code_text = reply["code"]
        known = isinstance(code_text, str) and _ACCOUNTS_CODE_RE.fullmatch(code_text)
        return reply if known and _ACCOUNTS_CODE_STATUS.get(code_text, 503) == status else None
    shape = _public_listing if op == "profiles.list" else _consent_policy   # every other route is a consent.* op
    return reply if shape(reply["data"]) else None


def _accounts_unique_keys(pairs):
    """A JSON object without a repeated name: json.loads keeps the last value, the relayed bytes would hold both."""
    if len({key for key, _ in pairs}) != len(pairs):
        raise ValueError("duplicate key")
    return dict(pairs)


def _public_listing(data):
    """profiles.list data with its three keys (a boolean, null or a digest, the list) and, for each profile, its six
    public fields with their types."""
    if not isinstance(data, dict) or set(data) != {"configured", "registry_revision", "profiles"}:
        return False
    revision, profiles = data["registry_revision"], data["profiles"]
    if type(data["configured"]) is not bool or not (revision is None or _accounts_digest(revision)):
        return False
    return isinstance(profiles, list) and all(_public_profile(p) for p in profiles)


def _public_profile(p):
    """A listed profile: a helper id, a label, a known backend, a boolean, its context digest; never a switch."""
    return (isinstance(p, dict) and set(p) == _ACCOUNTS_PUBLIC_PROFILE and _accounts_id(p["id"])
            and isinstance(p["label"], str) and p["backend"] in _ACCOUNTS_BACKENDS
            and _accounts_digest(p["context_revision"]) and type(p["enabled"]) is bool
            and p["switch_qualified"] is False)


def _consent_policy(data):
    """consent.* data: the store's policy exactly, its four keys, an integer revision, the global choice and the
    pairs, each with its two accounts (backend, id, context revision) and its choice."""
    if not isinstance(data, dict) or set(data) != _ACCOUNTS_POLICY or not isinstance(data["pairs"], list):
        return False
    revision = data["revision"]
    return (type(data["version"]) is int and data["version"] == 1 and type(revision) is int and revision >= 0
            and data["global"] in _ACCOUNTS_CONFIRMATIONS and all(_consent_pair(pair) for pair in data["pairs"]))


def _consent_pair(pair):
    """A stored pair as the helper keeps one: two accounts of one backend, two different ids."""
    if not (isinstance(pair, dict) and set(pair) == _ACCOUNTS_PAIR and pair["confirmation"] in _ACCOUNTS_CONFIRMATIONS):
        return False
    a, b = pair["a"], pair["b"]
    return (_consent_account(a) and _consent_account(b) and a["backend"] == b["backend"] and a["id"] != b["id"])


def _consent_account(account):
    return (isinstance(account, dict) and set(account) == _ACCOUNTS_ACCOUNT and account["backend"] in _ACCOUNTS_BACKENDS
            and _accounts_id(account["id"]) and _accounts_digest(account["context_revision"]))


async def _accounts_body(request):
    """(body, None) for the helper, or (None, refusal): a JSON content type, 16 KiB at most, an object's text."""
    if request.content_type != "application/json":
        return None, accounts_refusal(415, "unsupported-media-type")
    body = b""   # read at most one byte over the cap: a larger body is refused unread
    while len(body) <= ACCOUNTS_MAX_BODY and (chunk := await request.content.read(ACCOUNTS_MAX_BODY + 1 - len(body))):
        body += chunk
    if len(body) > ACCOUNTS_MAX_BODY:
        return None, accounts_refusal(413, "request-too-large")
    if not body.lstrip().startswith(b"{"):   # the helper checks the rest
        return None, accounts_refusal(400, "invalid-request")
    return body, None


async def api_accounts(request):
    """The six account routes: the owner's browser only (no Authorization header at all, the owner cookie, this
    server's Origin on reads too, as for the update notes), then the helper's envelope with the status it names."""
    _require_owner_cookie(request)
    if not same_origin(request) or request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise web.HTTPForbidden()
    op = ACCOUNTS_ROUTES[request.path]
    if request.query:
        return accounts_refusal(400, "invalid-request")
    body = b"{}"
    if request.method == "POST":
        body, refusal = await _accounts_body(request)
        if refusal is not None:
            return refusal
    if ACCOUNTS_QUEUE["pending"] >= ACCOUNTS_MAX_PENDING:   # no await between this check and the count
        return accounts_refusal(503, "busy")
    ACCOUNTS_QUEUE["pending"] += 1
    try:
        ran = await _profile_run(op, body)
    finally:
        ACCOUNTS_QUEUE["pending"] -= 1
    reply = _profile_envelope(op, *ran) if ran is not None else None
    if reply is None:
        if ran is not None:
            print(f"accounts: mesh-profile {op} answered outside its envelope (exit {ran[0]})", flush=True)
        return accounts_refusal(503, "backend-helper-unavailable")
    return web.Response(body=ran[1], status=reply["http_status"], content_type="application/json",
                        headers={"Cache-Control": "no-store"})


async def api_agent_mail_consent(request):
    _require_owner_cookie(request)
    if request.query:
        raise web.HTTPBadRequest()
    projection = await asyncio.to_thread(agentmail.consent_projection)
    return web.json_response(projection, headers={"Cache-Control": "no-store"})


async def api_agent_mail_overview(request):
    _require_owner_cookie(request)
    if request.query:
        raise web.HTTPBadRequest()
    live = _agent_mail_live(await host({"op": "list"}))
    overview = await asyncio.to_thread(agentmail.owner_overview, live)
    unconfirmed = request.app["claude_wakes"].unconfirmed() | request.app["codex_wakes"].unconfirmed()
    for row in overview:
        row["wake_unconfirmed"] = (row["identity"]["id"], row["identity"]["created"]) in unconfirmed
    return web.json_response({"sessions": overview}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_messages(request):
    """Owner-only mailbox of one live session: texts included, nothing consumed."""
    _require_owner_cookie(request)
    query = request.rel_url.query
    if set(query) != {"session", "created"} or len(query) != 2:
        raise web.HTTPBadRequest()
    name = query["session"]
    try:
        created = float(query["created"])
    except ValueError:
        raise web.HTTPBadRequest() from None
    if not NAME_RE.fullmatch(name) or not _finite_number(created):
        raise web.HTTPBadRequest()
    live = _agent_mail_live(await host({"op": "list"}))
    identity = next((item for item in live
                     if item["id"] == name and item["created"] == created), None)
    if identity is None:
        raise web.HTTPNotFound(text="Agent session unavailable")
    try:
        mailbox = await asyncio.to_thread(agentmail.owner_mailbox, identity, live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    return web.json_response(mailbox, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- configuration (read-only)
#
# What the owner sees in the "Configuration" dialog: effective paths, versions, detected agents,
# network and notification state. Facts only: no token, cookie, key, file content, environment
# dump, process argument, or path of a secret file (token, vapid.pem, push.json, request store).

def _exe_name(pid):
    """Base name of a process's executable, never its arguments: /proc on Linux; elsewhere the process
    name that the PTY host reports in its process facts."""
    if sys.platform != "linux":
        try:
            stat = discover.read_stat(int(pid))
        except (OSError, ValueError):
            return None
        return stat[0] if stat and stat[0] != discover.UNKNOWN_NAME else None
    try:
        return os.path.basename(os.readlink(f"/proc/{int(pid)}/exe")) or None
    except (OSError, ValueError):
        return None


def _host_kind(exe):
    """The implementation behind a host's executable name: the installed ``mesh-ptyhost*`` and the
    ``mesh_ptyhost_*`` binaries of a development build are the native one."""
    if exe.startswith(("mesh-ptyhost", "mesh_ptyhost")):
        return "native"
    return "python" if exe.startswith("python") else "other"


async def _config_host():
    """What the host socket shows: ``running`` means a process accepts connections on it;
    ``reply_valid`` is false when it accepts but answers with something that is not a JSON list."""
    try:
        identity = await ptyhost.host_identity()
    except (OSError, ValueError):
        identity = None
    exe = _exe_name(identity.split(":")[0]) if identity else None
    kind = None if exe is None else _host_kind(exe)
    capabilities = set()
    reply_valid = answered = True
    try:
        raw = await host({"op": "list"})
    except HostNotReached:      # no process accepts connections on the socket: a fact to report
        raw, answered = [], False
    except web.HTTPException:   # one accepted the connection, then failed or refused the request
        raw = []
    except ValueError:          # bytes that are not JSON: the host answers, but badly
        raw, reply_valid = [], False
    if identity is not None and not isinstance(raw, list):
        reply_valid = False
    if isinstance(raw, list):
        for item in raw:
            caps = item.get("pty_capabilities") if isinstance(item, dict) else None
            if isinstance(caps, list):
                capabilities.update(c for c in caps if isinstance(c, str) and len(c) <= 64)
    # Off Linux the identity comes from the host's own answer (ptyhost.host_identity), which a host
    # answering bad bytes cannot give: that it answered at all still shows a process on the socket.
    return {"running": identity is not None or answered, "reply_valid": reply_valid, "kind": kind, "executable": exe,
            "version": None, "capabilities": sorted(capabilities)[:32]}


def launch_projection():
    """The editable launch settings, their revision, limits and factory values."""
    return {"configured": LAUNCH_SETTINGS.configured,
            "workspace_roots": [str(root) for root in LAUNCH_SETTINGS.roots],
            "enabled_agents": sorted(LAUNCH_SETTINGS.enabled_agents),
            "known_agents": sorted(launchsettings.KNOWN_AGENTS),
            "editable": LAUNCH_REVISION is not None, "revision": LAUNCH_REVISION,
            "limits": {"max_roots": launchsettings.MAX_ROOTS, "max_path": launchsettings.MAX_PATH},
            "defaults": launchsettings.defaults()}


def config_report(origin, host_report):
    """The closed, secret-free configuration projection."""
    bin_dir = agentmcp.runtime_bin()
    board_bin = Path(agentmcp.BOARD_MCP)
    agents = []
    for agent in sorted({launchplan.agent_type(kind) for kind in launchplan.catalogue()}):
        enabled = any(launchplan.agent_type(kind) == agent for kind in LAUNCH_SETTINGS.enabled_agents)
        agents.append({"agent": agent, "path": shutil.which(agent), "version": None, "enabled": enabled})
    scheme, public_host = origin
    return {
        "paths": {
            "config_dir": str(CONF_DIR), "runtime_dir": str(ptyhost.SOCK.parent.parent),
            "host_socket": str(ptyhost.SOCK), "host_socket_present": ptyhost.SOCK.exists(),
            "cache_dir": str(meshpaths.CACHE_DIR), "uploads_dir": str(UPLOAD_DIR),
            "install_dir": str(ROOT), "bin_dir": str(bin_dir),
            "launch_settings": str(LAUNCH_SETTINGS.source) if LAUNCH_SETTINGS.source else None,
            "mesh_open": str(bin_dir / "mesh-open"), "mesh_open_present": (bin_dir / "mesh-open").exists(),
            "mesh_open_on_path": shutil.which("mesh-open"),
            "board_mcp": str(board_bin), "board_mcp_present": agentmcp.board_available(),
        },
        "version": {"client": client_version(), "install_name": ROOT.name or None},
        "capabilities": {"account_settings": True},
        "host": host_report,
        "agents": agents,
        "launch": launch_projection(),
        "runner_settings": runner_settings_projection(),
        "network": {"port": PORT, "listen_host": HOST, "loopback_only": HOST in ("127.0.0.1", "::1", "localhost"),
                    "trust_proxy": TRUST_PROXY, "request_scheme": scheme, "request_host": public_host,
                    "tailscale": "inferred" if public_host.split(":")[0].endswith(".ts.net") else "not-seen"},
        "notifications": {"vapid_key_present": webpush.KEY_FILE.exists(),
                          "subscriptions": len(webpush.load_subs())},
    }


async def api_config(request):
    """Owner-only, read-only configuration: the cookie alone, never a bearer or session token."""
    _require_owner_cookie(request)
    if request.query:
        raise web.HTTPBadRequest()
    report = await asyncio.to_thread(config_report, public_origin(request), await _config_host())
    await declared_accounts()
    report["accounts"] = accounts_projection()
    report["elevation"] = {"active": (left := elevation_seconds_left(request)) > 0, "seconds_left": left,
                           "duration": ELEVATION_SECONDS}
    return web.json_response(report, headers={"Cache-Control": "no-store"})


# Editing the configuration needs the owner cookie and a short elevation: the master token,
# typed again. The elevation is a random value in an HttpOnly cookie (path /api/config) that the
# server remembers with its expiry and the hash of the current owner cookie, so it dies with
# "log out everywhere", with a restart, with its expiry, and when the owner revokes it. The token
# is compared in constant time, is never stored, echoed or logged, and failures are rate limited.
ELEVATION_COOKIE = "mesh_elev"
ELEVATION_SECONDS = 600
ELEVATION_MAX_FAILURES, ELEVATION_FAILURE_WINDOW = 5, 300
ELEVATION_BODY_MAX = 4096
CONFIG_BODY_MAX = 32 * 1024
ELEVATIONS = {}          # nonce -> (monotonic expiry, sha256 of the owner cookie it was granted to)
ELEVATION_FAILURES = deque()
LAUNCH_WRITE_LOCK = asyncio.Lock()
RUNNER_SETTINGS = CONF_DIR / launchsettings.RUNNER_SETTINGS_FILE


def runner_settings_projection(values=None):
    """The runner settings shared by every device and their bounds: characters of a text (max_length), entries
    of a list (max_entries). The recent folders shown are the ones GET /api/dirs could list (_usable_recent_folders):
    one recorded before that rule, or no longer startable, is not offered."""
    values = dict(launchsettings.read_runner_settings(RUNNER_SETTINGS) if values is None else values)
    values["recent_folders"] = list(dict.fromkeys(_usable_recent_folders(values.get("recent_folders", []))))
    return {"values": values,
            "max_length": launchsettings.RUNNER_MAX_LENGTH, "max_entries": launchsettings.RUNNER_MAX_ENTRIES}


def _owner_binding():
    return hashlib.sha256(cookie_value().encode("utf-8")).hexdigest()


def elevation_seconds_left(request):
    now = time.monotonic()
    for nonce in [n for n, (expiry, _) in ELEVATIONS.items() if expiry <= now]:
        del ELEVATIONS[nonce]
    entry = ELEVATIONS.get(request.cookies.get(ELEVATION_COOKIE, ""))
    if entry is None or not hmac.compare_digest(entry[1], _owner_binding()):
        return 0
    return max(0, math.ceil(entry[0] - now))


def _json_reply(payload, status=200):
    return web.json_response(payload, status=status, headers={"Cache-Control": "no-store"})


async def _bounded_json_object(request, limit):
    """A strict JSON object body: content type application/json, at most ``limit`` bytes."""
    if request.query:
        raise web.HTTPBadRequest()
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text="Content-Type must be application/json")
    declared = request.content_length
    if declared is not None and declared > limit:
        raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=declared)
    raw = bytearray()
    while chunk := await request.content.read(limit + 1 - len(raw)):    # one read may return less than the body
        raw += chunk
        if len(raw) > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(raw))
    try:
        body = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        body = None
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object expected")
    return body


async def api_config_elevate(request):
    """Owner cookie plus the master token: a short, revocable permission to edit settings."""
    _require_owner_cookie(request)
    body = await _bounded_json_object(request, ELEVATION_BODY_MAX)
    if set(body) != {"token"}:
        raise web.HTTPBadRequest(text="Invalid fields")
    now = time.monotonic()
    while ELEVATION_FAILURES and ELEVATION_FAILURES[0] <= now - ELEVATION_FAILURE_WINDOW:
        ELEVATION_FAILURES.popleft()
    if len(ELEVATION_FAILURES) >= ELEVATION_MAX_FAILURES:
        retry = max(1, math.ceil(ELEVATION_FAILURES[0] + ELEVATION_FAILURE_WINDOW - now))
        return web.json_response({"error": "too-many-attempts", "retry_after": retry}, status=429,
                                 headers={"Retry-After": str(retry), "Cache-Control": "no-store"})
    if not secret_matches(body["token"], TOKEN):
        ELEVATION_FAILURES.append(now)
        return _json_reply({"error": "wrong-token"}, 403)
    ELEVATION_FAILURES.clear()
    nonce = secrets.token_urlsafe(32)
    ELEVATIONS[nonce] = (now + ELEVATION_SECONDS, _owner_binding())
    resp = _json_reply({"seconds_left": ELEVATION_SECONDS})
    resp.set_cookie(ELEVATION_COOKIE, nonce, max_age=ELEVATION_SECONDS, httponly=True, samesite="Strict",
                    secure=public_origin(request)[0] == "https", path="/api/config")
    return resp


async def api_config_elevate_revoke(request):
    _require_owner_cookie(request)
    if await _bounded_json_object(request, ELEVATION_BODY_MAX):
        raise web.HTTPBadRequest(text="Invalid fields")
    ELEVATIONS.pop(request.cookies.get(ELEVATION_COOKIE, ""), None)
    resp = _json_reply({"seconds_left": 0})
    resp.del_cookie(ELEVATION_COOKIE, path="/api/config")
    return resp


async def api_config_launch(request):
    """Edit the two launch settings: enabled agents and allowed workspace folders.

    Owner cookie plus an active elevation; anything else is refused. The file is rewritten
    atomically, only if its revision is the one the page saw; the change applies to the next
    launch with no restart, and no running session is touched."""
    _require_owner_cookie(request)
    if elevation_seconds_left(request) <= 0:
        return _json_reply({"error": "elevation-required"}, 403)
    body = await _bounded_json_object(request, CONFIG_BODY_MAX)
    if set(body) == {"settings"}:
        return await _write_runner_settings(request, body["settings"])
    if set(body) != {"revision", "enabled_agents", "workspace_roots"} or not isinstance(body["revision"], str):
        raise web.HTTPBadRequest(text="Invalid fields")
    async with LAUNCH_WRITE_LOCK:
        # The elevation can end while the body is read or the lock is awaited (log out
        # everywhere, Lock, expiry): ask again, last thing before the write.
        if elevation_seconds_left(request) <= 0:
            return _json_reply({"error": "elevation-required"}, 403)
        try:
            settings, revision = await asyncio.to_thread(
                launchsettings.write_update, body["enabled_agents"], body["workspace_roots"],
                body["revision"], LAUNCH_REVISION, deny=view.VIEW_DENY)
        except launchsettings.ConflictError as exc:
            return _json_reply({"error": exc.code, "message": str(exc), "revision": LAUNCH_REVISION}, 409)
        except launchsettings.InvalidLaunchSettings as exc:
            return _json_reply({"error": "invalid", "message": str(exc)}, 400)
        apply_launch_settings(settings, revision)
    return _json_reply({"launch": launch_projection()})


async def _write_runner_settings(request, changes):
    """A body {"settings": {...}} on the launch route: the runner settings, under the same rules."""
    async with LAUNCH_WRITE_LOCK:
        if elevation_seconds_left(request) <= 0:
            return _json_reply({"error": "elevation-required"}, 403)
        try:
            values = await asyncio.to_thread(launchsettings.write_runner_settings, RUNNER_SETTINGS, changes)
        except launchsettings.InvalidLaunchSettings as exc:
            return _json_reply({"error": "invalid", "message": str(exc)}, 400)
    return _json_reply({"runner_settings": runner_settings_projection(values)})


async def api_agent_mail_consent_decision(request):
    _require_owner_cookie(request)
    body = _agent_mail_body(await json_object(request), {"decision"})
    try:
        result = await request.app["agent_wakes"].mutate(
            agentmail.decide_consent, request.match_info["request_id"], body["decision"])
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    if result["decision"] != "no":
        request.app["agent_wakes"].trigger()
    return web.json_response({"consent": result}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_consent_revoke(request):
    _require_owner_cookie(request)
    body = _agent_mail_body(await json_object(request), {"policy_id"})
    try:
        policy = await asyncio.to_thread(agentmail.revoke_consent, body["policy_id"])
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    return web.json_response({"revoked": policy}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_send(request):
    body = _agent_mail_body(await json_object(request), {"target", "target_created", "kind", "text"})
    target_name, target_created = body["target"], body["target_created"]
    if (not isinstance(target_name, str) or not NAME_RE.fullmatch(target_name)
            or not _finite_number(target_created)):
        raise web.HTTPBadRequest(text="Invalid agent recipient")
    source, live = await _agent_mail_context(request)
    target = next((identity for identity in live
                   if identity["id"] == target_name and identity["created"] == target_created), None)
    if target is None:
        raise web.HTTPNotFound(text="Recipient agent session unavailable")
    try:
        receipt = await asyncio.to_thread(agentmail.send, source, target, body["kind"], body["text"], live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    request.app["agent_wakes"].trigger()
    return web.json_response({"receipt": receipt}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_reply(request):
    body = _agent_mail_body(await json_object(request), {"message_id", "kind", "text"})
    source, live = await _agent_mail_context(request)
    try:
        receipt = await asyncio.to_thread(agentmail.reply, source, body["message_id"], body["kind"], body["text"], live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    request.app["agent_wakes"].trigger()
    return web.json_response({"receipt": receipt}, headers={"Cache-Control": "no-store"})


async def api_agent_mail_ack(request):
    body = _agent_mail_body(await json_object(request), {"message_ids"})
    source, live = await _agent_mail_context(request)
    try:
        acknowledged = await request.app["agent_wakes"].mutate(
            agentmail.acknowledge, source, body["message_ids"], live)
    except agentmail.MailError as exc:
        _agent_mail_failure(exc)
    return web.json_response({"acknowledged": acknowledged}, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- restore after a ptyhost restart
#
# respawn.py keeps the snapshot; these routes recreate the sessions it offers. Nothing is
# restored without a request: relaunching an agent (with the command line it was started
# with, `--yolo` included for a codex-yolo session) is never unattended.

RESTORE_MAX = 50
# Announced by GET /api/sessions: this server answers a restore carrying ``expected`` with the guard (exact name,
# offer compared, intent written before the creation). A server that does not announce it runs such a body as a
# page restore without any guard: a tool reads this BEFORE sending and never targets a server without it.
RESTORE_GUARD = "exact-v1"
SNAPSHOT_EVERY = 10


async def names_body(request):
    return names_of(await json_object(request))


def names_of(body):
    names = body.get("names")
    if not (isinstance(names, list) and len(names) <= RESTORE_MAX
            and all(isinstance(n, str) and respawn.NAME_RE.fullmatch(n) for n in names)):
        raise web.HTTPBadRequest(text=f"names: a list of at most {RESTORE_MAX} session names")
    return list(dict.fromkeys(names))


def running_conversations(data):
    """Conversation ids of the agents running now, in the mesh or in another terminal."""
    agents = [s.get("agent") for s in data["mesh"] + data["external"]]
    return {a["session_id"] for a in agents if a and a.get("session_id")}


async def restore_organisation(new, org):
    """Give a recreated session its label, folder and rank back, through organize.apply (what the
    sidebar uses). A folder that is gone is not recreated: the session stays at the top level."""
    live = await host({"op": "list"})
    ops = []
    if org["label"]:
        ops.append({"op": "rename", "id": new, "label": org["label"]})
    folders = (await asyncio.to_thread(organize.view, live, False))["folders"]
    folder = org["folder"] if org["folder"] in folders else None
    if folder or org["rank"] is not None:      # a move is what ranks a session (appended after those already restored)
        ops.append({"op": "move", "id": new, "folder": folder})
    for op in ops:
        await asyncio.to_thread(organize.apply, op, live)


RESTORING_REFUSAL = "An exact restore is in progress for this offer: repeat the exact request, or discard the offer"
RECENT_CONVERSATION_SECONDS = 120


def recent_conversations(app):
    """Conversation ids restored during the last RECENT_CONVERSATION_SECONDS: the agent just
    started may not show in any listing yet, and two offers can share one conversation."""
    recent = app["recent_conversations"]
    now = time.monotonic()
    for sid in [sid for sid, at in recent.items() if now - at > RECENT_CONVERSATION_SECONDS]:
        del recent[sid]
    return set(recent)


def resuming_conversations():
    """Conversation ids a history resume has just started (HIST_RESUMING): not listed yet either."""
    return {sid for _agent, sid in HIST_RESUMING}


def remember_conversations(app, conversations):
    now = time.monotonic()
    app["recent_conversations"].update(dict.fromkeys(conversations, now))


OFFER_HELD_REFUSAL = ("A restore of this offer was sent a moment ago and its outcome is unknown: the session may "
                      "still appear. Wait a little, then look at the sessions again")
HELD_OFFERS = {}   # (name, created) -> time.monotonic() of a restore sent to the host without a confirmation


def hold_offer(name, created):
    HELD_OFFERS[(name, created)] = time.monotonic()


def offer_held(name, created):
    """Whether a restore of this very offer was sent to the host in the last RECENT_CONVERSATION_SECONDS
    and not confirmed: a shell has no conversation to hold, so the offer itself is held."""
    now = time.monotonic()
    for key in [key for key, at in HELD_OFFERS.items() if now - at > RECENT_CONVERSATION_SECONDS]:
        del HELD_OFFERS[key]
    return (name, created) in HELD_OFFERS


async def _transfer_restored_mail(entry, new, listed, expected_nonce=None, notes=None):
    """Carry the agent mail of the offered incarnation ``entry`` to its restored session ``new``.
    None when done or nothing applies, else the warning to show in the result: the mail then
    stays retained, with the offer, for the offer's lifetime, and the caller must not end the
    offer. ``notes`` (a list) receives the informational "mail expired" line when nothing was
    found to move although the retention of the offer had ended: not a failure, the offer ends. The mapping must be exact: a resumed conversation
    (the offer's agent kind and conversation id), one session of that name in ``listed``, of
    that agent kind, a different incarnation than the offer, and, when the caller recorded the
    nonce it gave the session, that very nonce. The name alone proves nothing."""
    agent = entry["agent"]
    if not (agent and agent["session_id"] and agent["type"] in AGENT_MAIL_PRESETS):
        return None
    found = [session for session in listed if session.get("name") == new]
    meta = found[0].get("meta") if len(found) == 1 else None
    if (not isinstance(meta, dict) or meta.get("known_agent") != agent["type"]
            or found[0].get("created") == entry["created"]
            or (expected_nonce is not None and meta.get("nonce") != expected_nonce)):
        return "agent mail not transferred (kept for the old identity): the restored session is not exactly the offered one"
    try:
        moved = await asyncio.to_thread(agentmail.transfer_incarnation,
                                        {"id": entry["name"], "created": entry["created"], "agent": agent["type"]},
                                        {"id": new, "created": found[0]["created"], "agent": agent["type"]})
    except agentmail.MailError as exc:
        print(f"restore: agent mail of {entry['name']} not transferred: {exc!r}", flush=True)
        return "agent mail not transferred (kept for the old identity)"
    if not moved and notes is not None and respawn.mail_retention_ended(entry):
        notes.append("mail expired: agent mail is kept 24 hours after the loss; none was found for this session")
    return None


async def _settle_restored(name, new, entry, recreated, warnings, offer_done):
    """What follows a created session: its board, the stale signals and, when ``offer_done``,
    the end of the offer. Without it (the agent mail was not transferred) the restoration is
    partial: the session exists, the offer and the retained mail stay at the old identity, and
    ``warnings`` says so. Appends the warnings it adds."""
    # board.transfer is False both for "no board to move" and for a refused move: not told apart here
    await asyncio.to_thread(board.transfer, name, entry["created"], new, recreated["created"])
    if new != name:
        warnings.append(f"restored under another name: {new}")
    _purge_board_signal(name)
    _purge_board_open(name)
    if new != name:
        _purge_board_signal(new)
        _purge_board_open(new)
    if offer_done:
        await asyncio.to_thread(respawn.drop_lost, [name])
    try:
        await restore_organisation(new, entry["org"])
    except (ValueError, OSError, asyncio.IncompleteReadError) as e:   # the session is back: say so, not 500
        print(f"restore: organisation of {new} not restored: {e!r}", flush=True)
        warnings.append("organisation not restored")


async def _create_restored(name, entry, running, reason=None):
    """The page path's creation: (the new session's name, None), or (None, the refusal result). A creation sent to
    the host whose outcome is unknown holds the conversation (``running``) and the offer, then re-raises.
    ``reason``: why the agent has no conversation to resume (NOT_RELAUNCHED), said in its shell."""
    agent = entry["agent"]
    resumable = bool(agent and agent["session_id"])
    try:
        command = shlex.join(_resume_argv(agent)) if resumable else _not_relaunched_line(agent, reason)
        new = await new_session(name, entry["cwd"], command, agent["type"] if resumable else None,
                                agent["type"] if resumable else None, keep=48,
                                conversation=_restored_conversation(agent) if resumable else None,
                                account=entry.get("account") if resumable else None)
    except (web.HTTPBadRequest, web.HTTPConflict, web.HTTPForbidden, GeminiSettingsRefused) as e:
        return None, {"ok": False, "error": e.text}
    except (CreationUncertain, asyncio.CancelledError):   # sent, outcome unknown: the agent may still start
        hold_offer(name, entry["created"])
        if resumable:
            running.add(agent["session_id"])
        raise
    if resumable:
        running.add(agent["session_id"])
    return new, None


async def restore_one(name, running, organisation_lock):
    """Recreate one lost session; the outcome the page shows. 503 when ptyhost is down.
    ``running`` (conversation ids already live) grows with every conversation resumed here:
    never two agents on one conversation."""
    async with organisation_lock:
        # Keep a recovery entry's organization coupled to its assignment.  A
        # rename cannot otherwise remove the old folder between ``lost_entry``
        # and ``restore_organisation``, which would quietly put the restored
        # session at the root.
        entry = await asyncio.to_thread(respawn.lost_entry, name)
        if entry is None:
            return {"ok": False, "error": "Not found, already restored or folder gone"}
        if "restoring" in entry:    # an exact restore already recorded its session: never a second one
            return {"ok": False, "error": RESTORING_REFUSAL}
        if offer_held(name, entry["created"]):
            return {"ok": False, "error": OFFER_HELD_REFUSAL}
        entry, reason = await asyncio.to_thread(_restore_identity, entry)   # the registry's conversation
        agent = entry["agent"]
        resumable = bool(agent and agent["session_id"])
        if resumable and agent["session_id"] in running:
            return {"ok": False, "error": "This conversation is already running (another session): nothing was restarted"}
        new, refusal = await _create_restored(name, entry, running, reason)
        if refusal:
            return refusal
        try:
            return await _complete_restored(name, entry, new, resumable, reason)
        except BaseException:    # the session exists and the offer is not settled: no second shell for a click
            hold_offer(name, entry["created"])
            raise


async def _complete_restored(name, entry, new, resumable, reason=None):
    """What follows the creation of a restored session on the page path: confirm it, carry the agent
    mail, settle the board and the offer; the outcome the page shows."""
    agent = entry["agent"]
    listed = await host({"op": "list"})
    recreated = next((session for session in listed if session.get("name") == new), None)
    if recreated is None:
        raise web.HTTPServiceUnavailable(text="ptyhost did not confirm the restored session")
    warnings = []
    mail_warning = await _transfer_restored_mail(entry, new, listed, notes=warnings)
    if mail_warning:
        warnings.insert(0, mail_warning)
    await _settle_restored(name, new, entry, recreated, warnings, offer_done=mail_warning is None)
    out = {"ok": True, "id": new, "resumed": resumable}
    if warnings:
        out["warnings"] = warnings
    if agent and not resumable:
        out["note"] = NOT_RELAUNCHED.get(reason, NOT_RELAUNCHED["unknown"])[0]
    return out


async def api_restore(request):
    body = await json_object(request)
    await declared_accounts()   # the folders a restored alias session is looked for in
    if "expected" in body:
        expected = _expected_body(body)
        return web.json_response({"results": {expected["name"]: await restore_exact(request.app, expected)}})
    names = names_of(body)
    async with request.app["restore_lock"]:     # a double click must not start two sessions
        organisation_lock = request.app["organisation_lock"]
        running = running_conversations(await sessions(organisation_lock=organisation_lock))
        running |= recent_conversations(request.app) | resuming_conversations()
        before = set(running)
        names = await asyncio.to_thread(respawn.by_rank, names)   # restored in the saved order
        results = {}
        try:
            for name in names:
                results[name] = await restore_one(name, running, organisation_lock)
        finally:   # also when a restore raised: what was started or attempted stays held
            remember_conversations(request.app, running - before)
    return web.json_response({"results": results})


# Exact restore: body {"names": [N], "expected": {name: N, created, agent_kind, resume_id, cwd}}
# (nothing else), answered {"results": {N: result}} like the page's restore, with status 200 (but a
# 5xx from the checks of _precheck_exact, before the intent is written).
# Restores that very offer or refuses. A failure result is {"ok": false, "code", "phase", "error"}:
#   phase "not-started": THIS request created no session (an earlier one may have: not-found after
#       a lost success) (codes expected-mismatch, target-occupied,
#       conversation-running, not-found, not-resumable, launch-refused, not-restored);
#   phase "created": the session exists, the rest failed: id and created say which; repeat the
#       same request to complete (code completion-failed);
#   phase "uncertain": a session may or may not exist (restore-interrupted, host-error).

def _result(code, phase, error, **more):
    return {"ok": False, "code": code, "phase": phase, "error": error, **more}


def _expected_body(body):
    if set(body) != {"names", "expected"}:
        raise web.HTTPBadRequest(text="a guarded restore is exactly {names: [name], expected: {...}}")
    try:
        expected = respawn.parse_expected(body["expected"])
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from exc
    if body["names"] != [expected["name"]]:
        raise web.HTTPBadRequest(text="names: exactly [expected.name]")
    return expected


async def _finish_exact(name, entry, created, listed, nonce):
    """Everything after the session exists: board, agent mail, snapshot, organisation. Idempotent,
    so a retry after a failure here (the marker is already written) runs it again without a second
    shell. A mail transfer that did not complete raises: the offer and the marker stay (phase
    created), and the retry resumes the transfer."""
    await asyncio.to_thread(board.transfer, name, entry["created"], name, created)
    _purge_board_signal(name)
    _purge_board_open(name)
    mail_warning = await _transfer_restored_mail(entry, name, listed, expected_nonce=nonce)
    if mail_warning:
        raise RuntimeError(mail_warning)
    await asyncio.to_thread(respawn.drop_lost, [name], required=True)
    try:
        await restore_organisation(name, entry["org"])
    except (ValueError, OSError, asyncio.IncompleteReadError) as e:
        print(f"restore: organisation of {name} not restored: {e!r}", flush=True)


async def _precheck_exact(app, name, entry, running):
    """The refusal of an unmarked offer that cannot be restored now, or None. Run under the
    restore and organisation locks, so ``recent_conversations`` is read where it cannot move."""
    agent = entry["agent"]
    sid = agent["session_id"] if agent else None
    if agent and not sid:
        return _result("not-resumable", "not-started",
                       "An agent without a conversation id is not restored as a plain shell by a guarded restore")
    if sid and (sid in running or sid in recent_conversations(app) or sid in resuming_conversations()):
        return _result("conversation-running", "not-started",
                       "This conversation is already running: nothing was restarted")
    if offer_held(name, entry["created"]) or any(s.get("name") == name for s in await host({"op": "list"})):
        return _result("target-occupied", "not-started", NAME_TAKEN)   # a held offer's session may be about to take it
    return None


async def _create_exact(name, entry, nonce):
    """Create the session of an offer whose intent is recorded; the refusal response, or None."""
    agent = entry["agent"]
    resumable = bool(agent and agent["session_id"])
    try:
        command = shlex.join(_resume_argv(agent)) if resumable else None
        await new_session(name, entry["cwd"], command, agent["type"] if resumable else None,
                          agent["type"] if resumable else None, keep=48, exact=True, nonce=nonce,
                          conversation=_restored_conversation(agent) if resumable else None,
                          account=entry.get("account") if resumable else None)
    except CreationUncertain:
        raise
    except (web.HTTPBadRequest, web.HTTPConflict, web.HTTPForbidden, web.HTTPServiceUnavailable) as e:
        # a 503 that is not CreationUncertain came before the send (Pi runtime, listing of the host)
        if e.text == NAME_TAKEN:
            return _result("target-occupied", "not-started", e.text)
        return _result("launch-refused", "not-started", e.text, status=e.status)
    return None


def _session_of(listed, name, marker):
    """The listed session ``marker`` designates (its name, its nonce, and its birth date once
    bound), or None: a missing session, or one that is not the one created for the offer."""
    live = next((s for s in listed if s.get("name") == name), None)
    if live is None or (live.get("meta") or {}).get("nonce") != marker["nonce"]:
        return None
    if "created" in marker and live.get("created") != marker["created"]:
        return None
    return live


async def _withdraw_intent(name, entry):
    """The host refused the creation for good (or it was refused before anything was sent): no
    session can appear, so drop the intent. If the write fails the intent stays, and a retry
    answers restore-interrupted rather than risking a second shell."""
    try:
        await asyncio.to_thread(respawn.clear_restoring, name, entry["created"])
    except (OSError, LookupError) as e:
        print(f"restore: intent of {name} kept: {e!r}", flush=True)


async def _start_exact(app, name, entry, running):
    """Everything before the session exists, for an unmarked offer: the checks, then the intent
    written durably, then the creation. (refusal, marker): exactly one is None. A failed intent
    write creates nothing."""
    refusal = await _precheck_exact(app, name, entry, running)
    if refusal is not None:
        return refusal, None
    marker = {"nonce": sessiontoken.new_nonce()}
    try:
        await asyncio.to_thread(respawn.begin_restoring, name, entry["created"], marker["nonce"])
    except (OSError, LookupError) as e:
        print(f"restore: intent of {name} not recorded: {e!r}", flush=True)
        await _withdraw_intent(name, entry)   # the file may hold it although the directory sync failed
        return _result("not-restored", "not-started", "Nothing was created (the restore intent could not be "
                       "recorded): repeat the same request; if it answers restore-interrupted, discard the offer"), None
    agent = entry["agent"]
    conversation = [agent["session_id"]] if agent and agent["session_id"] else []
    try:
        refusal = await _create_exact(name, entry, marker["nonce"])
    except asyncio.CancelledError:   # sent or not: unknown. Keep the intent (and hold the conversation).
        remember_conversations(app, conversation)
        raise
    except Exception as e:   # noqa: BLE001  CreationUncertain or unexpected: the host may create the session later
        print(f"restore: creation of {name} not confirmed: {e!r}", flush=True)
        remember_conversations(app, conversation)
        return _result("host-error", "uncertain", "ptyhost did not confirm the creation; the session may still "
                       "appear: repeat the same request"), None
    if refusal is not None:
        await _withdraw_intent(name, entry)
        return refusal, None
    remember_conversations(app, conversation)
    return None, marker


async def restore_exact(app, expected):
    """Restore exactly the offer ``expected`` describes, once. Checked inside the restore and
    organisation locks and before the PTY is created: the offer still exists and equals
    ``expected``, the name is free (no suffix), the conversation is not running (nor restored in
    the last RECENT_CONVERSATION_SECONDS). The intent (``restoring``: the nonce the session will
    carry in its host meta) is written durably BEFORE the creation; if that write fails nothing is
    created. A retry finds the session by its nonce and completes without a second shell, or
    answers restore-interrupted when no such session lives."""
    name = expected["name"]
    organisation_lock = app["organisation_lock"]
    async with app["restore_lock"]:
        running = running_conversations(await sessions(organisation_lock=organisation_lock))
        async with organisation_lock:
            entry = await asyncio.to_thread(respawn.lost_entry, name)
            if entry is None:
                return _result("not-found", "not-started", "Not found, already restored or folder gone")
            differs = [key for key in respawn.offer_mismatch(entry, expected) if key != "resume_id"]
            if differs:   # the conversation is compared below, with the one the restore would resume
                return _result("expected-mismatch", "not-started", "The offer is not the expected one",
                               mismatched=differs)
            entry, refusal = await _exact_identity(entry, expected)
            if refusal is not None:
                return refusal
            marker = entry.get("restoring")
            if marker is None:
                refusal, marker = await _start_exact(app, name, entry, running)
                if refusal is not None:
                    return refusal
            return await _complete_exact(name, entry, marker)


async def _exact_identity(entry, expected):
    """(the offer with the conversation the restore resumes: the registry's first, a refusal or None): a
    guarded restore resumes exactly the expected conversation, never one that is contested or gone, never
    turns an expected one into a shell, and never resumes one when it expected none. The retry of a restore
    whose session was created (``restoring``) does not look for the conversation on disk again: that session
    runs it already, and the retry only completes it."""
    marked = entry.get("restoring") is not None
    resolved, reason = await asyncio.to_thread(respawn.restore_identity if marked else _restore_identity, entry)
    agent = resolved["agent"]
    if agent and expected["resume_id"] and reason in ("contested", "not found"):
        why = NOT_RELAUNCHED[reason][0].split(":")[0]
        return resolved, _result("not-resumable", "not-started", f"{why}: a guarded restore does not start a plain shell")
    if (agent["session_id"] if agent else None) != expected["resume_id"]:
        return resolved, _result("expected-mismatch", "not-started", "The offer is not the expected one",
                                 mismatched=["resume_id"])
    return resolved, None


async def _complete_exact(name, entry, marker):
    """The session of the offer exists (just created, or recorded by ``marker``): bind it, finish,
    answer."""
    agent = entry["agent"]
    try:
        listed = await host({"op": "list"})
        live = _session_of(listed, name, marker)
    except Exception as e:   # noqa: BLE001  the intent is written: a session may exist, never a 5xx
        print(f"restore: {name} not confirmed by the host: {e!r}", flush=True)
        return _result("host-error", "uncertain", "ptyhost did not answer; the session may exist: repeat the same request")
    if live is None:
        return _result("restore-interrupted", "uncertain",
                       "No session of this offer is running (it ended, was never created, or the host "
                       "does not show it yet): discard the offer, or repeat the request")
    try:
        if "created" not in marker:
            try:   # informative only: the nonce already identifies the session
                await asyncio.to_thread(respawn.bind_restoring, name, entry["created"], marker["nonce"],
                                        live["created"])
            except (OSError, LookupError) as e:
                print(f"restore: birth date of {name} not recorded: {e!r}", flush=True)
        await _finish_exact(name, entry, live["created"], listed, marker["nonce"])
    except Exception as e:   # noqa: BLE001  the session exists: say so, and that a retry completes
        print(f"restore: {name} created but not completed: {e!r}", flush=True)
        return _result("completion-failed", "created", "The session exists; repeat the same request to complete",
                       id=name, created=live["created"])
    return {"ok": True, "id": name, "created": live["created"], "resumed": bool(agent), "guarded": True,
            "previous": {"name": name, "created": entry["created"]}}


async def api_restore_discard(request):
    names = await names_body(request)
    async with request.app["organisation_lock"]:
        entries = [await asyncio.to_thread(respawn.lost_entry, name) for name in names]
        await asyncio.to_thread(respawn.drop_lost, names)
    for entry in entries:
        if entry is not None:
            await asyncio.to_thread(board.remove, entry["name"], entry["created"])
            _purge_board_signal(entry["name"])
            _purge_board_open(entry["name"])
    return web.json_response({"ok": True})


async def snapshot_loop(app):
    """The one background round (sessions_round): it keeps the state GET /api/sessions answers from
    and the recovery snapshot current, also with no page open. A round starts when a request asks
    for one, or SNAPSHOT_EVERY after the last; never two at once, so the requests that arrive
    during a round share the next."""
    state = app["sessions_state"] if app else SessionsState()
    reader = asyncio.ensure_future(state.read_loop())
    try:
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(state.wanted.wait(), SNAPSHOT_EVERY)
            state.wanted.clear()
            state.started += 1
            extras = state.read_extras(app)   # beside the round: a slow or failing one never holds it
            try:
                # With the hook state: the conversation a Copilot (or OpenCode) plugin reported is what the
                # snapshot keeps, also while no page is open.
                await sessions_round(app, state)
                await asyncio.wait([extras], timeout=HOST_SILENT_AFTER)
            except Exception as e:   # one bad round must not end the loop
                print(f"snapshot loop: {e!r}", flush=True)
            finally:
                state.finished += 1
                state.changed()
    finally:
        for task in (reader, state._extras):   # the session-requests store closes after this (make_app)
            task and task.cancel()


async def start_snapshot(app):
    app["snapshot_task"] = asyncio.create_task(snapshot_loop(app))


async def stop_snapshot(app):
    app["snapshot_task"].cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await app["snapshot_task"]


# ---------------------------------------------------------------- terminal bridge

def browser_control_frame(text, pty_size=False):
    """Translate a strict browser control message into one PTY host frame. With ``pty_size``
    (a browser that follows the PTY size another one owns, ws_term), a resize without "size"
    is a claim, applied only while no other attachment owns the size; "take" (the banner's
    explicit take-over) and "keep" (a redraw at the PTY's size) are passed on. See the size
    owner rule in ocaml/lib/mesh_pty_size.mli."""
    try:
        message = json.loads(text)
        if not isinstance(message, dict):
            return None
        if set(message) == {"t", "rows", "cols"} and message["t"] == "r":
            claim = {"size": "claim"} if pty_size else {}
            return ptyhost.frame(b"R", {"rows": int(message["rows"]), "cols": int(message["cols"]), **claim})
        if (pty_size and set(message) == {"t", "rows", "cols", "size"} and message["t"] == "r"
                and message["size"] in ("take", "keep")):
            return ptyhost.frame(b"R", {"rows": int(message["rows"]), "cols": int(message["cols"]),
                                        "size": message["size"]})
        if (set(message) == {"t", "client_id", "dirty"} and message["t"] == "h"
                and isinstance(message["client_id"], str)
                and re.fullmatch(r"[A-Za-z0-9_.:-]{8,96}", message["client_id"])
                and isinstance(message["dirty"], bool)):
            return ptyhost.frame(b"H", {"client_id": message["client_id"],
                                         "dirty": message["dirty"]})
        return None
    except (KeyError, TypeError, ValueError, OverflowError):   # OverflowError: 1e999
        return None


def pty_size_message(payload):
    """The host's S frame as the browser's {t:"s"} message, or None when it is malformed."""
    try:
        size = json.loads(payload)
    except (TypeError, ValueError):
        return None
    valid = (isinstance(size, dict) and set(size) == {"rows", "cols", "owner"}
             and all(type(size[key]) is int and 2 <= size[key] <= 65535 for key in ("rows", "cols"))
             and size["owner"] in ("you", "other", "none"))
    return json.dumps({"t": "s", **size}) if valid else None


def releases_human_input(text):
    """True only for a validated clean human-input lease transition."""
    try:
        message = json.loads(text)
    except (TypeError, ValueError):
        return False
    return (isinstance(message, dict)
            and set(message) == {"t", "client_id", "dirty"}
            and message["t"] == "h"
            and isinstance(message["client_id"], str)
            and re.fullmatch(r"[A-Za-z0-9_.:-]{8,96}", message["client_id"]) is not None
            and message["dirty"] is False)


def attach_supports(reply, capability):
    """Fail closed for optional frames not announced by this exact attach."""
    capabilities = reply.get("pty_capabilities") if isinstance(reply, dict) else None
    return (isinstance(capabilities, list)
            and all(isinstance(value, str) for value in capabilities)
            and len(capabilities) == len(set(capabilities))
            and capability in capabilities)


async def ws_term(request):
    name = request.match_info["name"]
    if not NAME_RE.fullmatch(name) or not same_origin(request):
        raise web.HTTPForbidden()
    rows = _int_param(request.query.get("rows"), 40)
    cols = _int_param(request.query.get("cols"), 120)
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=4 * 1024 * 1024)
    if not ws.can_prepare(request).ok:     # not a websocket upgrade: nothing to attach
        raise web.HTTPBadRequest(text="WebSocket expected")
    # pty_size=1: a browser that follows the PTY size another one owns. Its attach claims the
    # size (applied only while no other attachment owns it) and it receives {t:"s"} messages.
    pty_size = request.query.get("pty_size") == "1"
    try:
        reader, writer, attach_reply = await ptyhost.attach_info(name, rows, cols,
                                                                 size="claim" if pty_size else None)
    except (OSError, LookupError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        # IncompleteReadError: an older ptyhost closes some failed requests without replying
        raise web.HTTPNotFound()
    human_input_lease = attach_supports(attach_reply, "human_input_lease_v1")
    # The geometry the host's replay was produced at, for a browser that asks for it; the
    # browser validates it. A host that does not give it sends nothing more.
    geometry = attach_reply.get("replay_geometry") if request.query.get("replay_geometry") == "1" else None
    try:
        await ws.prepare(request)
    except BaseException:
        writer.close()          # never leave a ptyhost client attached for a failed upgrade
        raise
    request.app["sockets"].add(ws)

    async def downstream():
        try:
            if isinstance(geometry, dict):   # before the replay, the host's first D frame
                await ws.send_str(json.dumps({"t": "g", "rows": geometry.get("rows"), "cols": geometry.get("cols")}))
            while True:
                kind, payload = await ptyhost.read_frame(reader)
                if kind == b"D":
                    await ws.send_bytes(payload)
                elif kind == b"S" and pty_size:
                    size = pty_size_message(payload)
                    if size:
                        await ws.send_str(size)
                elif kind == b"X":
                    break
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        await ws.close()

    pump = asyncio.ensure_future(downstream())
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                writer.write(ptyhost.frame(b"D", msg.data))
            elif msg.type == web.WSMsgType.TEXT:
                control = browser_control_frame(msg.data, pty_size)
                # H is an optional extension.  Forwarding it to the former
                # OCaml owner closes the whole attachment, including ordinary
                # keyboard D frames.  R remains part of the baseline protocol.
                if control and (control[:1] != b"H" or human_input_lease):
                    writer.write(control)
                    if human_input_lease and releases_human_input(msg.data):
                        request.app["agent_wakes"].trigger()
            await writer.drain()
    except (ConnectionError, ValueError):
        pass
    finally:
        request.app["sockets"].discard(ws)
        pump.cancel()
        writer.close()
    return ws


async def close_sockets(app):
    # browsers reconnect on their own; don't make systemd wait for them
    for ws in list(app["sockets"]):
        await ws.close(code=1012, message=b"restart")


# ---------------------------------------------------------------- app

CLIENT_FILES = ("index.html", "i18n.js", "folder-state.js", "history-state.js", "session-activity.js", "demo-catalog.js", "pane-actions.js", "workspace-spec.js", "terminal-links.js", "shortcuts.js", "update-notice.js", "sessions-progress.js", "projects.js", "project-catalog.js", "work-view.js", "app.js", "local-entry.js", "style.css", "themes.js", "themes.css", "sw.js", "board.html")
_client_version_cache = ((), "")   # (stat signature, version)


def client_files():
    """CLIENT_FILES plus every catalog under static/i18n/, so a translation update (or a new
    language) changes the client version and the page reloads its catalogs past the cache."""
    return CLIENT_FILES + tuple(sorted(f"i18n/{path.name}" for path in (STATIC / "i18n").glob("*.json")))


def client_version():
    """Short hash of the client files as they are now. The page carries the one it was served
    (a <meta>); /api/sessions announces the current one, so a page left open across a deploy
    notices it is stale. Re-hashed only when a file's mtime or size changes."""
    global _client_version_cache
    names = client_files()
    stats = tuple((name, st.st_mtime_ns, st.st_size) for name, st in ((n, (STATIC / n).stat()) for n in names))
    if _client_version_cache[0] != stats:
        digest = hashlib.sha256()
        for name in names:
            digest.update(name.encode() + b"\0" + (STATIC / name).read_bytes() + b"\0")
        _client_version_cache = (stats, digest.hexdigest()[:12])
    return _client_version_cache[1]


async def index(request):
    # Stamp our own assets with their mtime so a browser never keeps stale code.
    html = (STATIC / "index.html").read_text().replace("__CLIENT_VERSION__", client_version())
    for name in ("folder-state.js", "history-state.js", "session-activity.js", "demo-catalog.js", "pane-actions.js", "workspace-spec.js", "terminal-links.js", "shortcuts.js", "app.js", "local-entry.js", "style.css", "themes.js", "themes.css"):
        v = int((STATIC / name).stat().st_mtime)
        html = html.replace(f"/static/{name}", f"/static/{name}?v={v}")
    return web.Response(text=html, content_type="text/html",
                        headers={"Cache-Control": "no-store", "Content-Security-Policy": INDEX_CSP})


# ---------------------------------------------------------------- push
#
# Browsers that subscribed get a notification when an agent starts waiting or
# stops working (notify.py), even with the mesh closed (webpush.py).

async def api_push_key(request):
    if not webpush.AVAILABLE:
        return web.json_response({"available": False})
    try:
        return web.json_response({"available": True, "key": await asyncio.to_thread(webpush.public_key)})
    except (OSError, ValueError) as e:
        print(f"push: VAPID key unusable: {e}", flush=True)
        return web.json_response({"available": False})


async def api_push_subscribe(request):
    body = await json_object(request)
    if not webpush.AVAILABLE:
        raise web.HTTPServiceUnavailable(text="Push unavailable (Python cryptography package missing)")
    try:
        sub = webpush.parse_subscription(body.get("subscription"))
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))
    try:
        await asyncio.to_thread(webpush.public_key)   # the key exists before anything is bound to it
    except (OSError, ValueError) as e:
        raise web.HTTPServiceUnavailable(text=f"Unreadable VAPID key: {e}")
    detail = body.get("detail")
    if detail is not None and not isinstance(detail, bool):
        raise web.HTTPBadRequest(text="detail: boolean expected")
    detail = await asyncio.to_thread(webpush.add_sub, sub, detail)   # absent: this device's earlier choice
    sent = await webpush.send_all(request.app["push_http"], {"title": "Session Mesh", "body": "Notifications enabled.", "id": ""},
                                  [sub]) if body.get("test") else None
    return web.json_response({"ok": True, "sent": sent, "detail": detail})


async def api_push_detail(request):
    """A device's choice between the minimal notification (default) and the detailed one."""
    body = await json_object(request)
    if not isinstance(body.get("detail"), bool):
        raise web.HTTPBadRequest(text="detail: boolean expected")
    if not await asyncio.to_thread(webpush.set_detail, str(body.get("endpoint") or ""), body["detail"]):
        raise web.HTTPNotFound(text="Device not subscribed")
    return web.json_response({"ok": True, "detail": body["detail"]})


async def api_push_unsubscribe(request):
    body = await json_object(request)
    removed = await asyncio.to_thread(webpush.remove_sub, str(body.get("endpoint") or ""))
    return web.json_response({"ok": True, "removed": removed})


PUSH_EVERY = 5


def answer_buttons_enabled(environ):
    """The owner's switch for answering from a notification: only MESH_ANSWER_BUTTONS=1 turns it on.
    Read once at startup from the server's own environment (the systemd unit); no route, session or
    page can change it. Off until it is verified that "input needed" means only claude's question dialog."""
    return environ.get("MESH_ANSWER_BUTTONS") == "1"


ANSWER_BUTTONS = answer_buttons_enabled(os.environ)

# Answering from the notification: the first two choices of a single-choice claude
# question in a mesh session become buttons. A button carries a single-use token
# bound to that session and that question (its tool_use id); it types the choice's
# number only if the session still waits on that very question, unanswered.
ACTION_TTL = 600
ACTIONS = {}   # token -> {"id", "ask_id" (the question's tool_use id), "choices", "exp"}


def with_actions(message, s):
    if not ANSWER_BUTTONS:
        return message
    a = s.get("agent") or {}
    # "input needed" is what claude reports for its question dialog (seen on a live session)
    if s.get("kind") != "mesh" or a.get("status") != "waiting" or a.get("waiting_for") != "input needed" \
            or not a.get("choices") or not a.get("ask_id"):
        return message
    now = time.time()
    for t in [t for t, e in ACTIONS.items() if e["exp"] < now]:
        del ACTIONS[t]
    token = secrets.token_urlsafe(18)
    ACTIONS[token] = {"id": s["id"], "ask_id": a["ask_id"], "choices": a["choices"], "exp": now + ACTION_TTL}
    return {**message, "token": token,
            "actions": [{"action": str(i), "title": label} for i, label in enumerate(a["choices"][:2])]}


async def type_into(name, data):
    """Type data into a mesh session: attach (no size, so no resize), send, detach."""
    async def run():
        reader, writer = await asyncio.open_unix_connection(str(ptyhost.SOCK), limit=4 * 1024 * 1024)
        try:
            reply = await ptyhost._exchange(writer, reader, {"op": "attach", "name": name})
            if not reply.get("ok"):
                raise LookupError(reply.get("error"))
            writer.write(ptyhost.frame(b"D", data))
            writer.write_eof()   # our side is done: ptyhost relays the frame, then hangs up
            await writer.drain()
            # read the replay ptyhost sends on attach until it closes: leaving it unread
            # made ptyhost drop the connection before taking our keystroke
            while await reader.read(1 << 20):
                pass
        finally:
            writer.close()
    await asyncio.wait_for(run(), ptyhost.REQUEST_TIMEOUT)


async def api_push_act(request):
    if not ANSWER_BUTTONS:
        raise web.HTTPForbidden(text="Answer buttons disabled: the owner enables them with MESH_ANSWER_BUTTONS=1 in the server environment")
    body = await json_object(request)
    entry = ACTIONS.pop(str(body.get("token") or ""), None)   # single use
    if not entry or entry["exp"] < time.time():
        raise web.HTTPGone(text="Action expired: open the session")
    try:
        index = int(body.get("action"))
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text="Invalid action")
    if not 0 <= index < min(2, len(entry["choices"])):
        raise web.HTTPBadRequest(text="Invalid action")
    data = await sessions(organisation_lock=request.app["organisation_lock"])
    s = next((d for d in data["mesh"] if d["id"] == entry["id"]), None)
    a = (s or {}).get("agent") or {}
    if a.get("status") != "waiting" or a.get("waiting_for") != "input needed" or a.get("ask_id") != entry["ask_id"]:
        raise web.HTTPConflict(text="The session is no longer waiting for this answer: open it")
    try:
        await type_into(entry["id"], str(index + 1).encode())
    except (OSError, LookupError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError) as e:
        raise web.HTTPServiceUnavailable(text=f"Session unreachable: {e}")
    print(f"push: answered {entry['id']} with choice {index + 1} ({entry['choices'][index]})", flush=True)
    return web.json_response({"ok": True, "choice": entry["choices"][index]})



def deliveries(event, s, subs):
    """[(message, devices)] for one event: the minimal message to every device, except those that
    opted in to details, which get the detailed one. Only they get the answer buttons: their
    titles are the question's choices, which the minimal notification must not carry."""
    out = []
    for detail in (False, True):
        group = [sub for sub in subs if (sub.get("detail") is True) == detail]   # no flag: minimal
        if group:
            message = notify.message(event, detail)
            out.append((with_actions(message, s) if detail else message, group))
    return out


async def push_watcher(app):
    """Notify subscribed browsers of session changes; idle while nobody subscribed."""
    watcher = notify.Watcher()
    while True:
        await asyncio.sleep(PUSH_EVERY)
        try:
            subs = await asyncio.to_thread(webpush.load_subs)
            if not subs:
                watcher = notify.Watcher()   # subscribing later must not replay old changes
                continue
            data = await sessions(organisation_lock=app["organisation_lock"])
            by_id = {s["id"]: s for s in data["mesh"] + data["external"]}
            for event in watcher.changes(data):
                for message, group in deliveries(event, by_id.get(event["id"], {}), subs):
                    await webpush.send_all(app["push_http"], message, group)
        except Exception as e:   # one bad round must not end the watcher
            print(f"push watcher: {e!r}", flush=True)


async def start_push(app):
    import aiohttp
    app["push_http"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
    if webpush.AVAILABLE:
        app["push_task"] = asyncio.create_task(push_watcher(app))


async def stop_push(app):
    if app.get("push_task"):
        app["push_task"].cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await app["push_task"]
    await app["push_http"].close()


async def service_worker(request):
    # served from / so that its scope covers the whole mesh; revalidated on each check
    return web.FileResponse(STATIC / "sw.js", headers={"Content-Type": "text/javascript; charset=utf-8",
                                                       "Cache-Control": "no-cache"})


async def manifest(request):
    return web.FileResponse(STATIC / "manifest.webmanifest", headers={"Content-Type": "application/manifest+json",
                                                                      "Cache-Control": "no-cache"})


def make_app(*, session_request_path=None):
    # 1 MB for every body (login form, JSON); uploads stream their own (_read_upload)
    app = web.Application(middlewares=[auth_mw], client_max_size=BODY_MAX)
    app[projectartifacts.READER] = projectartifacts.Reader(lambda body: host(body))
    app[projectissues.KEY] = projectissues.Reader(lambda body: host(body))
    app["sockets"] = set()
    app.on_response_prepare.append(static_page_policy)
    app["restore_lock"] = asyncio.Lock()
    app["recent_conversations"] = {}     # conversation id -> monotonic time of its last restore
    # A folder name is shared by mesh.json, the restart snapshot and restore.
    # Serialise those cross-file transitions at the HTTP boundary; each file
    # still keeps its own process-safe atomic writer.
    app["organisation_lock"] = asyncio.Lock()
    app["contextual_diff_semaphore"] = asyncio.Semaphore(MAX_CONTEXTUAL_DIFF_PROCESSES)
    global _LIVE_EVENT_STATE
    app["event_state"] = _LIVE_EVENT_STATE = EventState()
    app["sessions_state"] = SessionsState()
    try:
        app["session_requests"] = sessionrequests.Requests(
            SESSION_REQUESTS_FILE if session_request_path is None else session_request_path)
    except ValueError as exc:   # a symlinked or shared database: one line, not a restart loop of tracebacks
        raise SystemExit(f"session-mesh: refusing to start: {exc}") from None
    app["session_action_tasks"] = {}
    app.on_startup.append(start_session_actions)
    app.on_cleanup.append(stop_session_actions)
    async def close_session_requests(_app):
        _app["session_requests"].close()
    app["pi_wakes"] = piwake.Connections(lambda: app["agent_wakes"].trigger())
    async def stop_pi_wakes(_app):
        await _app["pi_wakes"].close()
    app.on_shutdown.append(stop_pi_wakes)
    async def wake_notify(message):
        if message["agent"] == "pi":
            return await app["pi_wakes"].notify(message)
        codex = message.pop("wake_codex", None)
        if message["agent"] == "codex":
            return await app["codex_wakes"].post(message, codex)
        generation = message.pop("idle_generation", None)
        socket = message.pop("wake_socket", None)
        poster = app["claude_wakes"]
        if socket is not None or poster.holds(message):
            # No keystroke: one fixed line on the session's own socket, then the
            # agent must look at its inbox. Once a line was written for this
            # batch nothing is ever typed for it (a typed Enter could answer the
            # dialog Claude opened to hold the line), even if the socket has
            # since gone: the wake becomes "unconfirmed" and the owner sees it.
            # None (no line could be written) falls back to the typed notice.
            result = await poster.post(message, socket)
            if result is not None:
                return result
        if message.get("idle_since") is None:
            # No finished turn since the last input: deferred, not typed.
            return {"ok": False, "reason": "not_idle"}
        result = await host(message)
        # A turn may have begun between the idle snapshot and the notice: its
        # event's own cancel then found nothing to withdraw. The Enter still
        # waits WAKE_SUBMIT_DELAY, so withdraw it now.
        if result.get("ok") and result.get("accepted") is True \
                and not app["event_state"].still_idle(message["name"], generation):
            await _cancel_pending_notice(message["name"], message["created"])
        return result
    app["claude_wakes"] = claudewake.Poster(CLAUDE_WAKE_DIR)
    app["codex_wakes"] = agentwake.CodexQueue(CONF_DIR / "codex-queue-wakes.json", ptyhost.clean_env,
                                              _codex_thread, enabled=agentwake.queue_wake_enabled())
    app["agent_wakes"] = agentwake.Dispatcher(
        lambda: _agent_wake_live(app["pi_wakes"], app["event_state"], app["claude_wakes"], app["codex_wakes"]),
        wake_notify)
    app.on_startup.append(start_agent_wakes)
    app.on_startup.append(lambda _app: declared_accounts())   # the labels of the listing's alias sessions
    app.on_cleanup.append(stop_agent_wakes)
    app.on_startup.append(start_watcher)
    app.on_shutdown.append(close_sockets)
    app.on_cleanup.append(stop_watcher)
    app.on_startup.append(start_history)
    app.on_cleanup.append(stop_history)
    app.on_startup.append(start_snapshot)
    app.on_cleanup.append(stop_snapshot)
    app.on_cleanup.append(close_session_requests)   # after the snapshot loop, whose extras read it
    app.on_startup.append(start_vibe_hooks_sweeper)
    app.on_cleanup.append(stop_vibe_hooks_sweeper)
    app.on_startup.append(start_push)
    app.on_cleanup.append(stop_push)
    app.router.add_get("/login", login_page)
    app.router.add_post("/login", login_post)
    app.router.add_post("/api/logout", api_logout)
    app.router.add_post("/api/logout-all", api_logout_all)
    app.router.add_get("/", index)
    app.router.add_get("/sw.js", service_worker)
    app.router.add_get("/manifest.webmanifest", manifest)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/agent-mail/@self/pi-wakes", api_pi_wake_stream, allow_head=False)
    app.router.add_post("/api/agent-mail/@self/pi-wake-ack", api_pi_wake_ack)
    app.router.add_get("/api/portfolio/diff/{selector}", api_portfolio_diff)
    app.router.add_post("/api/event", api_event)
    app.router.add_get("/api/dirs", api_dirs)
    app.router.add_post("/api/dirs/recent", api_dirs_recent)
    app.router.add_post("/api/projects/v1", api_projects)
    app.router.add_post("/api/work/v1", api_work)
    app.router.add_post("/api/projects/artifacts/v1", api_project_artifacts)
    app.router.add_post("/api/projects/issues/v1", api_project_issues)
    app.router.add_post("/api/new", api_new)
    app.router.add_post("/api/adopt", api_adopt)
    app.router.add_post("/api/kill/{name}", api_kill)
    # ``@self`` cannot be a session name (NAME_RE excludes ``@``), so the
    # MeshSession-only capability cannot shadow a browser board named "self".
    app.router.add_get("/api/board/@self", api_board_self_get)
    app.router.add_put("/api/board/@self", api_board_self_put)
    app.router.add_get("/api/board/@self/revisions", api_board_self_revisions)
    app.router.add_get("/api/board/@self/revision", api_board_self_revision)
    app.router.add_get("/api/board/@self/revision/diff", api_board_self_revision_diff)
    app.router.add_get("/api/board/@self/latest-change", api_board_self_latest_change)
    app.router.add_post("/api/board/@self/open", opens.api_board_open)
    app.router.add_post("/api/board/@self/refresh", opens.api_board_refresh)
    app.router.add_post("/api/board/@self/revision/restore", api_board_self_restore)
    # The mailbox is reachable only through the sending agent's own
    # MeshSession capability.  It never writes to a peer terminal.
    app.router.add_get("/api/agent-mail/@self/peers", api_agent_mail_peers)
    app.router.add_get("/api/agent-mail/@self/inbox", api_agent_mail_inbox)
    app.router.add_post("/api/agent-mail/@self/read", api_agent_mail_read)
    app.router.add_post("/api/agent-mail/@self/send", api_agent_mail_send)
    app.router.add_post("/api/agent-mail/@self/reply", api_agent_mail_reply)
    app.router.add_post("/api/agent-mail/@self/ack", api_agent_mail_ack)
    app.router.add_get("/api/update/notes", api_update_notes)
    app.router.add_get("/api/update/image", api_update_image)
    app.router.add_get("/api/agent-mail/consent", api_agent_mail_consent)
    app.router.add_get("/api/agent-mail/overview", api_agent_mail_overview)
    app.router.add_get("/api/agent-mail/messages", api_agent_mail_messages)
    app.router.add_get("/api/config", api_config)
    app.router.add_post("/api/config/elevate", api_config_elevate)
    app.router.add_post("/api/config/elevate/revoke", api_config_elevate_revoke)
    app.router.add_post("/api/config/launch", api_config_launch)
    app.router.add_post("/api/agent-mail/consent/{request_id}/decision",
                        api_agent_mail_consent_decision)
    app.router.add_post("/api/agent-mail/consent/revoke", api_agent_mail_consent_revoke)
    # account profiles and confirmation preferences: no route for profiles.resolve, nor for any switch
    app.router.add_get("/api/accounts/profiles", api_accounts)
    app.router.add_get("/api/accounts/consent", api_accounts)
    app.router.add_post("/api/accounts/consent/set-global", api_accounts)
    app.router.add_post("/api/accounts/consent/set-pair", api_accounts)
    app.router.add_post("/api/accounts/consent/remove-pair", api_accounts)
    app.router.add_post("/api/accounts/consent/reset", api_accounts)
    app.router.add_get("/api/session-actions/@self/request", api_session_action_request)
    app.router.add_post("/api/session-actions/@self/request", api_session_action_request)
    app.router.add_get("/api/session-actions/@self/accounts", api_session_accounts)
    app.router.add_post("/api/session-actions/{request_id}/claim", api_session_action_claim)
    app.router.add_post("/api/session-actions/{request_id}/decision", api_session_action_decision)
    app.router.add_get("/api/demo-scene/@self", api_demo_scene_self_get)
    app.router.add_get("/api/demo-scene/@self/revisions", api_demo_scene_self_revisions)
    app.router.add_put("/api/demo-scene/@self", api_demo_scene_self_put)
    app.router.add_post("/api/demo-scene/@self/open", api_demo_scene_self_open)
    app.router.add_post("/api/demo-scene/@self/open-named", api_demo_scene_self_open_named)
    app.router.add_get("/api/demo-scene/@self/catalog", api_demo_scene_self_catalog)
    app.router.add_post("/api/demo-scene/@self/catalog", api_demo_scene_self_create)
    app.router.add_get("/api/demo-scene/@self/selected", api_demo_scene_self_selected_get)
    app.router.add_put("/api/demo-scene/@self/selected", api_demo_scene_self_selected_put)
    app.router.add_get("/api/demo-scene/@self/selected/revisions", api_demo_scene_self_named_revisions)
    app.router.add_post("/api/demo-scene/@self/selected/restore", api_demo_scene_self_named_restore)
    app.router.add_get("/api/demo-scene/{name}/catalog", api_demo_scene_owner_catalog)
    app.router.add_get("/api/demo-scene/{name}/selected", api_demo_scene_owner_selected)
    app.router.add_get("/api/demo-scene/{name}/selected/revisions", api_demo_scene_owner_named_revisions)
    app.router.add_post("/api/demo-scene/{name}/selected/restore", api_demo_scene_owner_named_restore)
    app.router.add_get("/api/demo-scene/{name}", api_demo_scene_owner_get)
    app.router.add_get("/demo-scene/{name}/{demo_id}/{version}", demo_scene_frame)
    app.router.add_get("/demo-scene/{name}/{version}", demo_scene_frame)
    app.router.add_get("/api/board/{name}/revisions", api_board_revisions)
    app.router.add_get("/api/board/{name}/revision", api_board_revision)
    app.router.add_get("/api/board/{name}/revision/diff", api_board_revision_diff)
    app.router.add_post("/api/board/{name}/revision/restore", api_board_restore)
    app.router.add_get("/api/board/{name}", api_board_get)
    app.router.add_put("/api/board/{name}", api_board_put)
    app.router.add_post("/api/organize", api_organize)
    app.router.add_post("/api/restore", api_restore)
    app.router.add_post("/api/restore/discard", api_restore_discard)
    app.router.add_post("/api/upload", api_upload)
    app.router.add_post("/api/view", view.api_view)
    app.router.add_post("/api/ls", browse.api_ls)
    app.router.add_post("/api/open", opens.api_open)
    app.router.add_post("/api/external-open", external.api_external_open)
    app.router.add_post("/api/stat", opens.api_stat)
    app.router.add_get("/api/docs", api_docs)
    app.router.add_get("/view/{tail:.*}", view.view)
    app.router.add_get("/viewlib/monaco/{tail:.+}", codeview.monaco_lib)
    app.router.add_get("/viewlib/{name}", view.viewlib)
    app.router.add_get("/api/push/key", api_push_key)
    app.router.add_post("/api/push/subscribe", api_push_subscribe)
    app.router.add_post("/api/push/unsubscribe", api_push_unsubscribe)
    app.router.add_post("/api/push/detail", api_push_detail)
    app.router.add_post("/api/push/act", api_push_act)
    app.router.add_get("/api/history", api_history)
    app.router.add_get("/api/history/search", api_history_search)
    app.router.add_post("/api/history/resume", api_history_resume)
    app.router.add_get("/api/history/{agent}/{sid}", api_history_detail)
    app.router.add_delete("/api/history/{agent}/{sid}", api_history_delete)
    app.router.add_get("/ws/{name}", ws_term)
    app.router.add_get("/favicon.svg", lambda r: web.FileResponse(STATIC / "favicon.svg"))
    app.router.add_static("/static", STATIC)
    return app


if __name__ == "__main__":
    print(f"session-mesh on http://{HOST}:{PORT}  (token in {TOKEN_FILE})", flush=True)
    agentmail.hold_pruning()   # until the first PTY list is read and the restore offers are saved
    web.run_app(make_app(), host=HOST, port=PORT, print=None, shutdown_timeout=3)
