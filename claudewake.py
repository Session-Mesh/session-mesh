# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Wake a Claude session through its cross-session messaging socket, without typing.

Claude Code (from MIN_VERSION) accepts ``--messaging-socket-path``: a session
listens there, and a line ``{"type":"user","message":{...}}`` sent to it starts
a turn in an idle session, or is delivered after the running one, without any
keystroke in its terminal.

Mesh chooses the path itself when it launches a Claude session (launch_command):
``<socket directory>/<20 hex>.sock``, derived from the incarnation's nonce, which
only the server mints and only the PTY host's listing returns.  The wake
(Poster) connects only to the path it derives for the live incarnation, inside
that private directory, and sends one fixed line holding the number of waiting
messages and nothing else: no message text, no sender, nothing an agent wrote.

Mesh does not change Claude's ``crossSessionInbound`` setting.  It gives a
session a socket only when Claude will deliver the line without asking
(claudepolicy): otherwise the session keeps the typed notice.

A line written on the socket is a wake only once the agent looks at its
inbox afterwards, through the route of the ``agent_inbox`` tool
(Poster.note_inbox_read).  Claude may hold the line for the owner's approval in
a dialog of its terminal, drop it, or the session may have moved to bypass mode
since the launch.  Once a line has been written, Mesh types nothing in that
terminal for that wake, ever: a typed Enter could answer the dialog.  If the
inbox is not read within CONFIRM_SECONDS, the wake becomes "unconfirmed", a
state the owner sees in the page and in the session's mailbox panel; reading
the inbox, at any time, still confirms it.  A session without a socket, or a
line that could not be written, keeps the typed notice and its guards.  One
line is written per batch of messages.

The lines are remembered in a small file of the private directory (wakestate),
written before a line is sent, so that a restart of the server neither writes a
second line for the same batch nor forgets an unconfirmed one.  A file that is
lost or damaged, or a directory that stops being private, is never read as "no
line was written": an invalid entry is dropped on its own, and every
incarnation that is alive then is put in doubt (Poster.holds).  The doubt lasts
until the session restarts; a read of the inbox does not lift it.  Meanwhile
that incarnation gets neither a line nor a typed notice, with or without a
socket, and its wakes are shown as unconfirmed.
"""

import asyncio
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import time
from pathlib import Path

import agentmcp
import claudepolicy
from wakestate import STATE_FILE, MAX_TRACKED, LineStore, initialize_state, private_directory  # noqa: F401  (STATE_FILE: re-export)

# The first release in which Mesh verified --messaging-socket-path end to end.
MIN_VERSION = (2, 1, 325)
SOCKET_OPTION = "--messaging-socket-path"
DIRECTORY_NAME = "claude-wake"
CONNECT_SECONDS = 1.0
VERSION_SECONDS = 3.0
# A Unix socket path is limited to 104 bytes on macOS (108 on Linux).
MAX_SOCKET_PATH = 103
BUSY_TURNS = frozenset(("working", "waiting_permission", "waiting_question"))
# A socket nobody lists any more is removed once it is this old (a launch lists
# its incarnation before Claude creates the socket: the grace only covers races).
STALE_SECONDS = 60.0
SWEEP_SECONDS = 30.0
_VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+) \(Claude Code\)")
_NONCE = re.compile(r"[0-9a-f]{32}")
_SOCKET_NAME = re.compile(r"[0-9a-f]{20}\.sock")


def _confirm_seconds():
    """How long a line may wait for the agent's look at its inbox (default 20 s).

    MESH_CLAUDE_WAKE_CONFIRM_SECONDS shortens it for tests; out of 1..300 it is ignored."""
    try:
        value = float(os.environ.get("MESH_CLAUDE_WAKE_CONFIRM_SECONDS", ""))
    except ValueError:
        return 20.0
    return value if 1.0 <= value <= 300.0 else 20.0


CONFIRM_SECONDS = _confirm_seconds()
_version_cache = {}


def wake_line(count):
    """The only text ever written on a socket: a fixed sentence and a number."""
    text = (f"Mesh: {count} new message(s) in your inbox; check agent_inbox "
            "and ask yes/no/always before reading.")
    return (json.dumps({"type": "user", "message": {"role": "user", "content": text}},
                       separators=(",", ":")) + "\n").encode()


# ----------------------------------------------------------- the Claude binary


def _executable(env):
    """The ``claude`` the session's shell will run: first on the session's PATH."""
    return shutil.which("claude", path=env.get("PATH") or "/usr/bin:/bin")


def _fingerprint(real):
    info = os.stat(real)
    return (real, info.st_mtime_ns, info.st_size, info.st_ino, info.st_dev)


def supported(env):
    """Whether the Claude that a session with this environment runs accepts the socket option.

    The ``claude`` found on env's PATH is the one the session launches.  Its
    answer is cached per (path, mtime, size, inode): an update that replaces
    the file in place, or moves the ``claude`` link, is checked again.  The
    check runs with no standard input, from ``/``, and is short."""
    executable = _executable(env)
    if executable is None:
        return False
    try:
        key = _fingerprint(os.path.realpath(executable))
    except OSError:
        return False
    if key not in _version_cache:
        try:
            result = subprocess.run([executable, "--version"], capture_output=True, text=True,
                                    timeout=VERSION_SECONDS, check=True, stdin=subprocess.DEVNULL,
                                    cwd="/", env=dict(env))
        except (OSError, ValueError, subprocess.SubprocessError):
            return False          # not cached: a transient failure is retried
        match = _VERSION.fullmatch(result.stdout.strip())
        if len(_version_cache) >= 16:
            _version_cache.clear()
        _version_cache[key] = bool(match) and tuple(map(int, match.groups())) >= MIN_VERSION
    return _version_cache[key]


# ------------------------------------------------------- the socket directory


def wake_directory(preferred, fallback_root="/tmp"):
    """Where the sockets go: ``preferred`` when a socket path fits there, else a short directory.

    A Unix socket path holds 103 bytes on macOS, and the default runtime
    directory there (under /var/folders) is too long for any.  The fallback is
    ``<fallback_root>/session-mesh-<uid>-<8 hex of the preferred path>``: one
    short directory per user and per mesh instance, so that two instances never
    clean each other's sockets.  It is checked like the preferred one
    (ensure_directory), so another user who creates the name first only
    prevents the socket wake: the typed notice remains."""
    preferred = Path(preferred)
    if len(os.fsencode(preferred / ("0" * 20 + ".sock"))) <= MAX_SOCKET_PATH:
        return preferred
    tag = hashlib.sha256(os.fsencode(preferred)).hexdigest()[:8]
    return Path(fallback_root) / f"session-mesh-{os.getuid()}-{tag}"


def ensure_directory(directory):
    """Create the socket directory (0700) if needed; refuse a symlink or a shared one."""
    directory = Path(directory)
    try:
        directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=True)
    except OSError:
        return False
    return private_directory(directory)


def _socket_name(nonce):
    if not isinstance(nonce, str) or not _NONCE.fullmatch(nonce):
        return None
    return hashlib.sha256(b"session-mesh/claude-wake\0" + nonce.encode()).hexdigest()[:20] + ".sock"


def socket_path(directory, nonce):
    """The path of one incarnation's socket, or None when it cannot be used."""
    name = _socket_name(nonce)
    if name is None:
        return None
    path = Path(directory) / name
    if not path.is_absolute() or len(os.fsencode(path)) > MAX_SOCKET_PATH:
        return None
    return path


# ------------------------------------------------------------------- launching


def _has_socket_option(argv):
    return any(arg == SOCKET_OPTION or arg.startswith(SOCKET_OPTION + "=") for arg in argv)


def _has_board_entry(argv):
    """Whether the board bridge is installed and this command carries its ``--mcp-config`` entry.

    The entry is what gives the session the ``agent_inbox`` tool: a command
    that lacks it (another mechanism built it, or the bridge was stripped)
    could never confirm a wake."""
    return agentmcp.board_available() and agentmcp.strip_board("claude", argv) != argv


def launch_command(command, nonce, directory, cwd, env):
    """A Claude launch command with Mesh's socket, or command unchanged.

    The socket is added only when this Claude accepts it, when Claude will
    deliver Mesh's line automatically (claudepolicy), when the board bridge is
    installed (the session then has the ``agent_inbox`` tool that confirms the
    wake; without it every wake would stay unconfirmed), and when the directory
    is private.  Nothing here may fail a session's creation: any doubt, or
    any error, returns command.  Blocking (it may run ``claude --version`` and
    reads settings files): call it from a worker thread.

    cwd: the session's folder.  env: the environment its shell will get."""
    try:
        argv = shlex.split(command)
        if not argv or argv[0] != "claude" or _has_socket_option(argv) or not supported(env):
            return command
        if not _has_board_entry(argv):
            return command      # no agent_inbox tool: no wake could ever be confirmed
        if not claudepolicy.delivers_automatically(argv, cwd, env):
            return command
        path = socket_path(directory, nonce)
        if path is None or not ensure_directory(directory):
            return command
        initialize_state(directory)
        return shlex.join([*argv, SOCKET_OPTION, str(path)])
    except Exception:       # a wake option must never fail a launch
        return command


# --------------------------------------------------------------------- waking


class Poster(LineStore):
    """One fixed wake line per batch of messages, for each live incarnation."""

    def __init__(self, directory, confirm_seconds=None, clock=time.time):
        self._confirm = CONFIRM_SECONDS if confirm_seconds is None else confirm_seconds
        self._clock = clock
        self._reads = {}      # (name, created) -> time of the last look at the inbox
        self._next_sweep = 0.0
        super().__init__(directory)

    def target(self, nonce):
        """The socket of an incarnation when it is there to be used, else None."""
        path = socket_path(self._directory, nonce)
        return str(path) if path is not None and self._usable(path) else None

    def _usable(self, path):
        """Only a socket of this user, in Mesh's private directory, under Mesh's naming."""
        path = Path(path)
        if path.parent != self._directory or _SOCKET_NAME.fullmatch(path.name) is None \
                or not private_directory(self._directory):
            return False
        try:
            info = os.lstat(path)
        except OSError:
            return False
        return stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()

    def retain(self, identities):
        """Forget the lines of incarnations the PTY host no longer lists."""
        keep = set(identities)
        gone = [key for key in self._lines if key not in keep]
        for key in gone:
            del self._lines[key]
            self._reads.pop(key, None)
        if self._doubt_before is not None and not any(created <= self._doubt_before for _, created in keep):
            self._doubt_before = None       # every incarnation that was in doubt is gone
            gone.append(None)
        if gone:
            self._save()

    def unconfirmed(self):
        """The (name, created) of every incarnation whose last line nobody followed."""
        return {key for key, line in self._lines.items() if line["state"] == "unconfirmed"}

    def has_line(self, request):
        """Whether a line was written for this notification: nothing may be typed for it."""
        line = self._lines.get((request["name"], request["created"]))
        return line is not None and line["id"] == request["notification_id"]

    def holds(self, request):
        """Whether nothing may be typed for this notification.

        True once a line was written for it, and also for an incarnation put in
        doubt by a lost or damaged state file: a line may have been written for
        it, and a typed Enter could answer the dialog that holds the line."""
        return self.has_line(request) or self._doubted((request["name"], request["created"]))

    def note_inbox_read(self, name, created):
        """The agent of this incarnation looked at its inbox (the agent_inbox route)."""
        key = (name, created)
        now = self._clock()
        self._reads.pop(key, None)
        self._reads[key] = now
        while len(self._reads) > MAX_TRACKED:
            self._reads.pop(next(iter(self._reads)))
        line = self._lines.get(key)
        if line is not None and line["state"] != "confirmed" and line["at"] <= now \
                and not self._doubted(key):
            line["state"] = "confirmed"
            self._save()

    def _remember(self, key, notification_id, at, state="sent"):
        """Record a line and write the record to disk; False when it could not be made durable."""
        self._lines.pop(key, None)
        self._lines[key] = {"id": notification_id, "at": at, "state": state}
        while len(self._lines) > MAX_TRACKED:
            self._lines.pop(next(iter(self._lines)))
        return self._save()

    def _forget(self, key):
        self._lines.pop(key, None)
        self._save()

    async def post(self, request, wake):
        """A notify result for the dispatcher, or None when no line was written for this batch.

        wake: {"path", "turn", "generation"} from the server's own listing, or
        None when the session has no socket any more.  None is the only answer
        that lets the caller type the notice, and it is never given once a line
        was written for the batch.

        - a line written for this batch: accepted once the inbox was read since;
          ``not_confirmed`` (the dispatcher asks again) until CONFIRM_SECONDS;
          then, once the session is idle, ``unconfirmed``: a durable state shown
          to the owner, left as it is until the inbox is read; never a second
          line and never a keystroke;
        - an incarnation in doubt (a lost or damaged state file, or a state
          directory that stopped being private): the batch is recorded
          ``unconfirmed`` and no line is written, so nothing is typed either.
          The doubt lasts until the session restarts: a read of the inbox does
          not lift it (no read is known to close the dialog that may hold the
          earlier line), so the next batches stay ``unconfirmed`` too, and the
          owner keeps seeing it;
        - a new batch: ``not_idle`` while a turn runs, else one line is written
          (None when it cannot be).  The record is made durable before the line
          is sent, and withdrawn only when the connection itself failed."""
        key = (request["name"], request["created"])
        line = self._lines.get(key)
        if line is not None and line["id"] == request["notification_id"]:
            return self._after_line(key, line, wake or {})
        if self._doubted(key):
            self._remember(key, request["notification_id"], self._clock(), "unconfirmed")
            return {"ok": False, "reason": "unconfirmed"}
        if wake is None:
            return None
        if wake.get("turn") in BUSY_TURNS:
            return {"ok": False, "reason": "not_idle"}   # one line at the end of the turn
        count = request["count"]
        if not (isinstance(count, int) and not isinstance(count, bool) and count > 0) \
                or not self._usable(wake["path"]):
            return None
        if not self._remember(key, request["notification_id"], self._clock()):
            self._forget(key)
            return None            # a line must never exist without its durable record
        if not await self._send(wake["path"], wake_line(count)):
            self._forget(key)      # nothing was written: the typed notice is allowed again
            return None
        return {"ok": False, "reason": "not_confirmed"}

    def _after_line(self, key, line, wake):
        if line["state"] != "confirmed" and self._reads.get(key, float("-inf")) >= line["at"] \
                and not self._doubted(key):
            line["state"] = "confirmed"
            self._save()
        if line["state"] == "confirmed":
            return {"ok": True, "accepted": True}
        if line["state"] == "unconfirmed":
            return {"ok": False, "reason": "unconfirmed"}
        if 0 <= self._clock() - line["at"] < self._confirm:
            return {"ok": False, "reason": "not_confirmed"}
        if wake.get("turn") in BUSY_TURNS:
            return {"ok": False, "reason": "not_idle"}   # judged at the turn's end
        line["state"] = "unconfirmed"
        self._save()
        return {"ok": False, "reason": "unconfirmed"}

    def sweep(self, live_nonces):
        """Remove the sockets of incarnations that are no longer listed; return how many.

        Only inside the private directory, only sockets of this user under
        Mesh's naming, only when STALE_SECONDS old, and at most every
        SWEEP_SECONDS.  live_nonces: every nonce of the PTY host's listing."""
        now = self._clock()
        if now < self._next_sweep or not private_directory(self._directory):
            return 0
        self._next_sweep = now + SWEEP_SECONDS
        alive = {_socket_name(nonce) for nonce in live_nonces}
        removed = 0
        try:
            names = [entry.name for entry in os.scandir(self._directory)]
        except OSError:
            return 0
        for name in names:
            if _SOCKET_NAME.fullmatch(name) is None or name in alive:
                continue
            path = self._directory / name
            try:
                info = os.lstat(path)
                if (stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
                        and time.time() - info.st_mtime >= STALE_SECONDS):
                    os.unlink(path)
                    removed += 1
            except OSError:
                continue
        return removed

    @staticmethod
    async def _send(path, line):
        """False only when the connection failed, so that no line can have been written.

        A write or a close that fails or times out after the connection may
        have delivered the line: that answers True, and the record stays."""
        try:
            _, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), CONNECT_SECONDS)
        except (OSError, asyncio.TimeoutError):
            return False
        try:
            writer.write(line)
            await asyncio.wait_for(writer.drain(), CONNECT_SECONDS)
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), CONNECT_SECONDS)
            except (OSError, asyncio.TimeoutError):
                pass
        return True
