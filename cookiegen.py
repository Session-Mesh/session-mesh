# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The cookie generation: one number, on disk, that every ``mesh_auth`` cookie is bound to.

The cookie value is an HMAC of the master token; folding the generation into it means that
raising the generation invalidates every cookie ever issued, at once ("log out all devices"),
without changing the master token. The master Bearer token and the per-session tokens do not
depend on it.

  generation 0   HMAC(token, "session-mesh"), the value of a fresh install (no suffix)
  generation n>0 HMAC(token, "session-mesh\\0gen=<n>")

The file (``cookie-generation`` in the config dir, 0600) is created at generation 0 on first
use and read again whenever it changes, so a bump made from outside the server (the CLI with
the server down, or any process) takes effect on the next request. A file that does not hold a
non-negative integer is never trusted as generation 0: that would revive old cookies. It is
replaced by a clock-based number, which no counter reaches, and every cookie is refused once.
"""

import hashlib
import hmac
import os
import time

import fsutil

FILE_NAME = "cookie-generation"


def cookie_value(token, generation):
    message = b"session-mesh" if generation == 0 else b"session-mesh\0gen=%d" % generation
    return hmac.new(token.encode(), message, hashlib.sha256).hexdigest()


def _parse(text):
    try:
        value = int(text.strip())
    except ValueError:
        return None
    return value if value >= 0 else None


def _write(path, generation):
    fsutil.atomic_write(path, f"{generation}\n", 0o600)


def read(path):
    """The generation in ``path``, which is created at 0 when absent and repaired when unreadable."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return read(path)
        with os.fdopen(fd, "w") as out:
            out.write("0\n")
        return 0
    value = _parse(text)
    if value is None:
        value = time.time_ns()
        print(f"session-mesh: {path} is not a generation number; every login is revoked", flush=True)
        _write(path, value)
    return value


def bump(path):
    """Raise the generation by one, atomically, and return the new one."""
    new = read(path) + 1
    _write(path, new)
    return new


class Generation:
    """The generation of one file, cached until the file is replaced (one ``stat`` per request)."""

    def __init__(self, path):
        self.path = path
        self._seen = None
        self._value = 0

    def _key(self):
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def current(self):
        key = self._key()
        if key is None or key != self._seen:
            self._value = read(self.path)
            self._seen = self._key()
        return self._value
