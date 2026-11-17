# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Opening an explicitly clicked web URL in the user's system browser.

This is deliberately narrower than a generic command endpoint: only an absolute
HTTP(S) URL is accepted and it is always passed as one argument to the desktop
opener, never to a shell.
"""

import asyncio
import shutil
from urllib.parse import urlsplit

from aiohttp import web


def external_url(value):
    """Return a safe absolute HTTP(S) URL, or ``None``.

    ``urlsplit`` also makes protocol-relative URLs and embedded control
    characters unambiguous.  Credentials are accepted: they are an ordinary
    URL feature and preserving them avoids silently opening a different URL.
    """
    if not isinstance(value, str) or len(value) > 16 * 1024 or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return value


def opener_argv(url):
    """The first available desktop opener, represented as a shell-free argv."""
    if shutil.which("xdg-open"):
        return ["xdg-open", url]
    if shutil.which("gio"):
        return ["gio", "open", url]
    return None


async def api_external_open(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Invalid JSON body")
    url = external_url(body.get("url") if isinstance(body, dict) else None)
    if url is None:
        raise web.HTTPBadRequest(text="Absolute http(s) URL expected")
    argv = opener_argv(url)
    if argv is None:
        raise web.HTTPServiceUnavailable(text="No system browser available")
    try:
        await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.DEVNULL,
                                             stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        raise web.HTTPServiceUnavailable(text="Could not launch the system browser")
    return web.json_response({"ok": True})
