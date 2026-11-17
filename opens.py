# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""mesh-open's server side: the open requests every page picks up, and the mtime probe.

``POST /api/open`` records a request in ``OPENS``; the pages read it from
``/api/sessions`` and show the document. A request made with a session token carries
that session's name, taken from the verified token (``request["mesh_session"]``, set
by the auth middleware) and never from the body: the pages that display that session
show the document next to it. ``POST /api/stat`` lets a page (or the session) ask
whether a document changed, which a watched pane polls instead of ``/api/view``
(every ``/api/view`` call mints a new URL).
"""

import asyncio
import itertools
import json
import time

from aiohttp import web

import view

OPENS = []          # recent closed-union requests which a page may handle
# Kept out of the public queue: a queued command must be tied to the live
# incarnation of the visible session name without exposing that identity to a
# browser.
_BOARD_OPEN_IDENTITIES = {}
_BOARD_REFRESH_IDENTITIES = {}
_DEMO_OPEN_IDENTITIES = {}
KEEP_OPENS = 20
BOARD_OPEN_TTL = 12
MAX_STAT_TARGETS = 20
MAX_BODY = 256 * 1024
# seeded from the clock: a restarted server must not reuse numbers a page already handled
_sequence = itertools.count(int(time.time() * 1000))


async def _body(request):
    """The request body, refused beyond MAX_BODY (tighter than the app-wide 1 MB limit)."""
    chunks, size = [], 0
    async for chunk in request.content.iter_chunked(8192):
        size += len(chunk)
        if size > MAX_BODY:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=size)
        chunks.append(chunk)
    return b"".join(chunks)


async def _json_object(request):
    try:
        body = json.loads(await _body(request))
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid JSON body")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object expected")
    return body


def _record(description, session, body):
    """The OPENS entry for an accepted request; only real booleans set the flags."""
    watch = body.get("watch") is True and description["kind"] == "file"
    # no signed URL in the broadcast: every page asks /api/view for its own
    public = {k: v for k, v in description.items() if k != "url"}
    entry = {**public, "seq": next(_sequence), "at": time.time(), "session": session,
             "reload": watch or body.get("reload") is True, "watch": watch}
    if watch:
        entry["mtime"] = view.stat_target(description["target"])
    return entry


def _prune(now=None, live=None):
    """Drop expired board commands, then retain a small bounded broadcast queue.

    Document requests deliberately retain their historical behaviour (the most
    recent ``KEEP_OPENS`` entries).  A board-open is different: it is an
    ephemeral request, not an acknowledgement protocol, so it expires after
    three ordinary page polls even when the document queue remains busy.
    """
    now = time.time() if now is None else now
    def keep(entry):
        if entry.get("kind") not in ("board-open", "board-refresh", "demo-scene-open"):
            return True
        identities = {"board-open": _BOARD_OPEN_IDENTITIES, "board-refresh": _BOARD_REFRESH_IDENTITIES,
                      "demo-scene-open": _DEMO_OPEN_IDENTITIES}[entry["kind"]]
        identity = identities.get(entry.get("seq"))
        return (isinstance(entry.get("at"), (int, float)) and now - entry["at"] < BOARD_OPEN_TTL
                and identity is not None
                and (live is None or live.get(entry.get("session")) == identity))

    OPENS[:] = [entry for entry in OPENS if keep(entry)]
    del OPENS[:-KEEP_OPENS]
    for kind, identities in (("board-open", _BOARD_OPEN_IDENTITIES), ("board-refresh", _BOARD_REFRESH_IDENTITIES),
                             ("demo-scene-open", _DEMO_OPEN_IDENTITIES)):
        live_sequences = {entry.get("seq") for entry in OPENS if entry.get("kind") == kind}
        for seq in list(identities):
            if seq not in live_sequences:
                del identities[seq]


def snapshot(live=None):
    """The current queue, pruning transient board-open commands first."""
    _prune(live=live)
    return list(OPENS)


def record_board_open(session, identity):
    """Request the authenticated session's board once for a short poll window.

    ``session`` comes only from the verified MeshSession token.  The tagged
    record is intentionally a closed union member: unlike a document entry it
    carries no target, URL, body, browser selector, or credential.
    """
    now = time.time()
    _prune(now)
    if any(entry.get("kind") == "board-open" and entry.get("session") == session
           and _BOARD_OPEN_IDENTITIES.get(entry.get("seq")) == identity for entry in OPENS):
        return False
    # A newly-created session with the same name cannot inherit an old
    # request, even before the next page poll has discarded it.
    OPENS[:] = [entry for entry in OPENS
                if entry.get("kind") != "board-open" or entry.get("session") != session]
    seq = next(_sequence)
    OPENS.append({"kind": "board-open", "session": session, "seq": seq, "at": now})
    _BOARD_OPEN_IDENTITIES[seq] = identity
    _prune(now)
    return True


def discard_board_open(session, identity=None):
    """Forget all transient board commands for a killed or restored name."""
    OPENS[:] = [entry for entry in OPENS
                if entry.get("kind") not in ("board-open", "board-refresh")
                or entry.get("session") != session
                or (identity is not None and
                    (_BOARD_OPEN_IDENTITIES if entry["kind"] == "board-open" else _BOARD_REFRESH_IDENTITIES)
                    .get(entry.get("seq")) != identity)]
    _prune()


def record_demo_scene_open(session, identity, demo_id=None):
    """Short-lived, same-incarnation, content-free request to show a demo scene."""
    now = time.time()
    _prune(now)
    if demo_id is None and any(entry.get("kind") == "demo-scene-open" and entry.get("session") == session
           and entry.get("demo_id") == demo_id
           and _DEMO_OPEN_IDENTITIES.get(entry.get("seq")) == identity for entry in OPENS):
        return False
    OPENS[:] = [entry for entry in OPENS if entry.get("kind") != "demo-scene-open" or entry.get("session") != session]
    seq = next(_sequence)
    entry = {"kind": "demo-scene-open", "session": session, "seq": seq, "at": now}
    if demo_id is not None:
        entry["demo_id"] = demo_id
    OPENS.append(entry)
    _DEMO_OPEN_IDENTITIES[seq] = identity
    _prune(now)
    return True


def discard_demo_scene_open(session, identity=None):
    OPENS[:] = [entry for entry in OPENS
                if entry.get("kind") != "demo-scene-open" or entry.get("session") != session
                or (identity is not None and _DEMO_OPEN_IDENTITIES.get(entry.get("seq")) != identity)]
    _prune()


def record_board_refresh(session, identity):
    """Ask an already open board to refresh from the server.

    This is a closed queue member, deliberately without a version, URL, or
    browser selector.  The iframe remains authoritative for whether a local
    scene can be replaced: it reloads by itself only when nothing local would be
    lost (no unsaved or in-progress drawing) and otherwise offers the reload,
    which then waits for the person's explicit click.
    """
    now = time.time()
    _prune(now)
    if any(entry.get("kind") == "board-refresh" and entry.get("session") == session
           and _BOARD_REFRESH_IDENTITIES.get(entry.get("seq")) == identity for entry in OPENS):
        return False
    OPENS[:] = [entry for entry in OPENS if entry.get("kind") != "board-refresh" or entry.get("session") != session]
    seq = next(_sequence)
    OPENS.append({"kind": "board-refresh", "session": session, "seq": seq, "at": now})
    _BOARD_REFRESH_IDENTITIES[seq] = identity
    _prune(now)
    return True


async def api_board_refresh(request):
    """Queue a scoped, explicitly-confirmed refresh offer for this session."""
    await _require_empty_body(request)
    record_board_refresh(request["mesh_session"], request["mesh_session_created"])
    return web.json_response({"ok": True})


async def _require_empty_body(request):
    """Refuse every byte, including one supplied by chunked transfer encoding."""
    async for chunk in request.content.iter_chunked(8192):
        if chunk:
            raise web.HTTPBadRequest(text="Empty body expected")


async def api_board_open(request):
    """Ask pages already displaying this session to show its own whiteboard."""
    await _require_empty_body(request)
    record_board_open(request["mesh_session"], request["mesh_session_created"])
    return web.json_response({"ok": True})


async def api_open(request):
    """mesh-open: ask the open pages to show a document in a side panel."""
    body = await _json_object(request)
    description = await asyncio.to_thread(view.describe_target, body.get("target"), body.get("base"))
    session = request.get("mesh_session")
    if session is not None and description.get("ext") in view.SESSION_FILE_SCOPE_EXT:
        view.file_scope_only(description["target"])
    _prune()
    OPENS.append(_record(description, session, body))
    del OPENS[:-KEEP_OPENS]
    if session is not None:
        # a session token must not be a read capability: no signed URL goes back to it
        return web.json_response({"kind": description["kind"], "target": description["target"]})
    return web.json_response(description)


def _stat_targets(body):
    targets = body.get("targets")
    if (not isinstance(targets, list) or len(targets) > MAX_STAT_TARGETS
            or not all(isinstance(target, str) for target in targets)):
        raise web.HTTPBadRequest(text="targets: list of paths expected")
    return targets


def _mtimes(targets, session):
    """target -> mtime; a session only learns about the documents it opened itself."""
    opened = None if session is None else {e["target"] for e in OPENS if e["session"] == session}
    return {target: view.stat_target(target) if opened is None or target in opened else None
            for target in targets}


async def api_stat(request):
    targets = _stat_targets(await _json_object(request))
    mtimes = await asyncio.to_thread(_mtimes, targets, request.get("mesh_session"))
    return web.json_response({"mtimes": mtimes})
