# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Directory listings for the file tree in the sidebar.

Only for the page (cookie or master token, never a session token): the same
roots and protections as /view apply — under ~, /tmp or macOS's $TMPDIR, nothing protected
(~/.ssh, the mesh's config…), a directory as written or once resolved.
"""

import asyncio
import os
import stat
from pathlib import Path

from aiohttp import web

import view

MAX_ENTRIES = 2000


def _resolve_dir(target, bases):
    """The directory a path names (relative to the first base it exists under)."""
    path = Path(os.path.expanduser(target))
    candidates = [path] if path.is_absolute() else [Path(b) / path for b in bases or [str(Path.home())]]
    for candidate in candidates:
        if view._lexically_denied(candidate):
            raise web.HTTPForbidden(text="Protected folder")
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if view._root_of(resolved) is None:
            raise web.HTTPForbidden(text="Outside the allowed folders")
        if view._denied(resolved):
            raise web.HTTPForbidden(text="Protected folder")
        if resolved.is_dir():
            return resolved
    raise web.HTTPNotFound(text=f"Folder not found: {target}")


def listing(target, bases=()):
    directory = _resolve_dir(target, bases)
    entries = []
    try:
        with os.scandir(directory) as it:
            for entry in it:
                try:
                    st = entry.stat()                     # follows links: show what they lead to
                    is_dir = stat.S_ISDIR(st.st_mode)
                    size = 0 if is_dir else st.st_size
                except OSError:
                    is_dir, size = False, None            # a dangling link
                entries.append({"name": entry.name, "dir": is_dir, "size": size,
                                "link": entry.is_symlink()})
                if len(entries) >= MAX_ENTRIES:
                    break
    except PermissionError:
        raise web.HTTPForbidden(text="Read denied")
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    root = view._root_of(directory)
    return {"path": str(directory), "parent": str(directory.parent) if directory != root else None,
            "entries": entries, "truncated": len(entries) >= MAX_ENTRIES}


async def api_ls(request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict) or view._clean_path_arg(body.get("path")) is None:
        raise web.HTTPBadRequest(text="Path expected")
    bases = view.clean_bases(body.get("base"), body.get("bases"))
    return web.json_response(await asyncio.to_thread(listing, body["path"], bases))
