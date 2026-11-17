# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The remembered wake lines of claudewake: a small file in the private socket directory.

One entry per incarnation (name, created): the last line written for it, with
the id of its notification, the time and a state.  The file is written before a
line is sent, so that a restart of the server neither writes a second line for
the same batch nor forgets an unconfirmed one.  A file that is lost or damaged
is never read as "no line was written": see LineStore.
"""

import json
import math
import os
import stat
from pathlib import Path

import claudepolicy

MAX_TRACKED = 1024
STATE_FILE = "wake-lines.json"
_LINE_STATES = frozenset(("sent", "confirmed", "unconfirmed"))


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def private_directory(directory):
    """True when directory is a real directory of this user, closed to others."""
    try:
        info = os.lstat(directory)
    except OSError:
        return False
    return (stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) & 0o077 == 0)


def _valid_entry(item):
    return (isinstance(item, dict) and isinstance(item.get("name"), str) and number(item.get("created"))
            and isinstance(item.get("id"), str) and number(item.get("at"))
            and isinstance(item.get("state"), str) and item["state"] in _LINE_STATES)


def initialize_state(directory):
    """Create the empty remembered-lines file when there is none; never replace one.

    A launch with a socket does it, so that a later absence of the file means
    that it was lost (LineStore._load)."""
    path = Path(directory) / STATE_FILE
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError:
        return
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "lines": []}, handle, separators=(",", ":"))


class LineStore:
    """The lines and the doubt of a Poster, and their file.

    The doubt: incarnations created up to ``_doubt_before`` may have had a line
    written whose record is gone.  It lasts until they are all gone (the
    restart of their session): nothing a session does lifts it, since no read
    of the inbox is known to close a dialog that holds a line.

    Subclasses provide ``_clock``."""

    def __init__(self, directory):
        self._directory = Path(directory)
        self._lines = {}      # (name, created) -> {"id", "at", "state"}: the last line written
        self._doubt_before = None
        self._directory_lost = False   # the doubt for a directory that stopped being private was raised
        self._load()

    def _load(self):
        """The lines of a previous run of the server, keeping every valid entry.

        The file is created by the first launch with a socket (initialize_state),
        so a missing file in an existing private directory means it was lost; an
        unreadable one, or an entry that is not valid, means lines may be lost.
        None of that is read as "no line was written": the incarnations that
        exist now are put in doubt (see _doubted), and the doubt is saved."""
        if not private_directory(self._directory):
            return
        try:
            stored = claudepolicy.read_settings(self._directory / STATE_FILE)
        except claudepolicy.Unreadable:
            stored = None
        damaged = stored is None or self._adopt(stored)
        if damaged:
            self._doubt_before = max(self._doubt_before or 0.0, self._clock())
            self._save()

    def _adopt(self, stored):
        """Take the valid entries of a stored state; True when anything in it was not valid."""
        items = stored.get("lines", [])
        if not isinstance(items, list):
            return True
        damaged = len(items) > MAX_TRACKED
        for item in items[:MAX_TRACKED]:
            if not _valid_entry(item):
                damaged = True
                continue
            self._lines[(item["name"], item["created"])] = {
                "id": item["id"], "at": item["at"], "state": item["state"]}
        if "doubt_before" in stored:
            if number(stored["doubt_before"]):
                # A value in the future would put every new incarnation in doubt for good.
                self._doubt_before = min(stored["doubt_before"], self._clock())
            else:
                damaged = True
        return damaged

    def _save(self):
        """Write the lines atomically, inside the private directory; False when that failed."""
        if not private_directory(self._directory):
            return False
        lines = [{"name": name, "created": created, **line} for (name, created), line in self._lines.items()]
        state = {"version": 1, "lines": lines}
        if self._doubt_before is not None:
            state["doubt_before"] = self._doubt_before
        temporary = self._directory / f"{STATE_FILE}.{os.getpid()}.tmp"
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._directory / STATE_FILE)
            return True
        except OSError:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            return False

    def _watch_directory(self):
        """Put the live incarnations in doubt when the directory that holds lines stops being private.

        A directory that is deleted, or opened to others (0755), after a line
        was recorded no longer holds a record we can trust, and the next line
        cannot be recorded: lines already written may be forgotten.  Raised
        once, until the directory is private again: an incarnation launched
        meanwhile gets no socket, so nothing is lost for it.  Before any line
        was recorded there is nothing to lose: the typed notice stays."""
        if private_directory(self._directory):
            self._directory_lost = False
        elif self._lines and not self._directory_lost:
            self._directory_lost = True
            self._doubt_before = max(self._doubt_before or 0.0, self._clock())

    def _doubted(self, key):
        """Whether a line may have been written for this incarnation and then forgotten."""
        self._watch_directory()
        return self._doubt_before is not None and key[1] <= self._doubt_before
