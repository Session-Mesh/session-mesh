#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""ptyhost: the Python client of the native PTY host (``mesh-ptyhost``).

The host itself is the OCaml program ``mesh-ptyhost``: it owns the mesh's
pseudo-terminals and runs apart from the web server, so that sessions survive web
restarts. This module is what the web server and the scripts use to talk to it over
its Unix socket: framing, one-shot requests, attach, and the host's identity.

Wire format on the unix socket: frames of  type(1) | length(4, BE) | payload.
  C  JSON control (first frame of every connection, and replies)
  D  terminal bytes, both directions
  R  JSON {"rows", "cols"}  client -> host
  X  JSON {"code"}          host -> client, program exited
"""
import asyncio
import json
import math
import os
import pwd
import re
import socket
import struct
import sys
import time
from pathlib import Path

import discover


def _default_runtime_dir():
    """/run/user/<uid>; on macOS the native host's default, below the home directory of the
    user database (not $HOME, so that a client run with another HOME finds the same socket)."""
    if sys.platform != "darwin":
        return Path(f"/run/user/{os.getuid()}")
    try:
        home = pwd.getpwuid(os.geteuid()).pw_dir
    except KeyError:
        home = str(Path.home())
    return Path(home, "Library", "Application Support", "session-mesh", "run")


# MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR, else the default above, as the native host. An empty
# value counts as unset: it would make the path relative. Only the native host validates (and
# on macOS creates) the directory; the clients apply the order as is.
SOCK = Path(os.environ.get("MESH_RUNTIME_DIR") or os.environ.get("XDG_RUNTIME_DIR")
            or _default_runtime_dir()) / "session-mesh" / "ptyhost.sock"

# The variables the native host keeps from its own environment for a session's shell
# (``Mesh_ptyhost.whitelist``): the web server needs the same view to judge a launch before it is made.
_KEEP_ENV = ("HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
             "XDG_RUNTIME_DIR", "MESH_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
             "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "SSH_AUTH_SOCK", "EDITOR",
             "VISUAL")


def clean_env(extra=None):
    """The environment the native host gives a session's shell: no agent's or multiplexer's context,
    ``~/.local/bin`` on the PATH, ``extra`` (already validated MESH_* names) added on top."""
    env = {k: v for k, v in os.environ.items() if k in _KEEP_ENV}
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    local_bin = str(Path.home() / ".local" / "bin")
    if local_bin not in env.get("PATH", "").split(":"):
        env["PATH"] = local_bin + ":" + env.get("PATH", "/usr/bin:/bin")
    env.update(extra or {})
    return env


# ---------------------------------------------------------------- framing

# Largest payload accepted per frame kind: terminal bytes (a replay is at most
# 2 MiB), small JSON for the others. A bigger length is a broken or
# hostile peer, not something to buffer (the header allows 4 GiB).
MAX_FRAME = {b"D": 8 * 1024 * 1024}
MAX_SMALL_FRAME = 256 * 1024


async def read_frame(reader):
    head = await reader.readexactly(5)
    kind, n = head[:1], struct.unpack(">I", head[1:])[0]
    if n > MAX_FRAME.get(kind, MAX_SMALL_FRAME):
        raise ConnectionError(f"frame {kind!r} of {n} bytes refused")
    return kind, await reader.readexactly(n)


def frame(kind, payload):
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        payload = json.dumps(payload).encode()
    return kind + struct.pack(">I", len(payload)) + bytes(payload)


# ---------------------------------------------------------------- client helpers

# A host that accepts but never answers (frozen by a stuck session) must not hang
# the web server: handshakes are bounded. The resulting asyncio.TimeoutError is an
# OSError only from Python 3.11 on: callers name it, for 3.10.
REQUEST_TIMEOUT = 5
CONDITIONAL_INPUT = "conditional_input_v1"


def supports(reply, capability):
    """Only a well-formed, duplicate-free capability set is evidence."""
    capabilities = reply.get("pty_capabilities") if isinstance(reply, dict) else None
    return (isinstance(capabilities, list)
            and all(isinstance(value, str) for value in capabilities)
            and len(capabilities) == len(set(capabilities))
            and capability in capabilities)


async def conditional_input_supported(name, created):
    """An uncached extension hint, never identity admission or retry permission."""
    try:
        listed = await request({"op": "list"})
    except (OSError, ValueError, RecursionError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        return False
    if not isinstance(listed, list):
        return False
    matches = [row for row in listed if isinstance(row, dict) and row.get("name") == name]
    return (len(matches) == 1 and type(matches[0].get("created")) in (int, float)
            and matches[0]["created"] == created and supports(matches[0], CONDITIONAL_INPUT))


async def _exchange(writer, reader, req):
    writer.write(frame(b"C", req))
    await writer.drain()
    kind, payload = await read_frame(reader)
    if kind != b"C":
        raise ValueError("invalid control reply")
    return json.loads(payload)


class NotSent(OSError):
    """The connection to the host failed: the request was not sent, nothing happened."""


async def request(req, timeout=None):
    """One request and its reply, bounded by ``timeout`` seconds (an operation known to take longer passes more);
    None: REQUEST_TIMEOUT, read at each call."""
    timeout = REQUEST_TIMEOUT if timeout is None else timeout
    async def run():
        try:
            reader, writer = await asyncio.open_unix_connection(str(SOCK))
        except OSError as exc:
            raise NotSent(str(exc)) from exc
        try:
            return await _exchange(writer, reader, req)
        finally:
            writer.close()
    return await asyncio.wait_for(run(), timeout)


def _arm(conn, deadline):
    """Give the next blocking call on ``conn`` only what is left of ``deadline``."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("ptyhost reply")
    conn.settimeout(remaining)


def _recv_exactly(conn, size, deadline):
    data = b""
    while len(data) < size:
        _arm(conn, deadline)
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise ConnectionError("ptyhost closed the connection")
        data += chunk
    return data


def request_sync(req, timeout):
    """``request`` for a caller outside the event loop, bounded by ``timeout`` in all:
    the reply, or None on any failure. Strings keep a byte that is not UTF-8 as a
    lone surrogate (surrogateescape): process names and paths are the kernel's bytes."""
    deadline = time.monotonic() + timeout
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            _arm(conn, deadline)
            conn.connect(str(SOCK))
            _arm(conn, deadline)
            conn.sendall(frame(b"C", req))
            head = _recv_exactly(conn, 5, deadline)
            size = struct.unpack(">I", head[1:])[0]
            if head[:1] != b"C" or size > MAX_SMALL_FRAME:
                return None
            payload = _recv_exactly(conn, size, deadline)
        return json.loads(payload.decode("utf-8", "surrogateescape"))
    except (OSError, ValueError, RecursionError):
        return None


async def _identity_from_host():
    """``"<pid>:<incarnation>"`` from the host's processes reply, None if unknown."""
    try:
        reply = await request({"op": "processes", "pids": []})
    except (OSError, EOFError, ValueError, RecursionError, asyncio.TimeoutError):
        return None
    host = reply.get("host") if isinstance(reply, dict) else None
    pid, start = (host.get("pid"), host.get("incarnation")) if isinstance(host, dict) else (None, None)
    if type(pid) is not int or pid <= 0 or not isinstance(start, str):
        return None
    identity = f"{pid}:{start}"
    return identity if re.fullmatch(r"[0-9]{1,10}:[0-9]{1,20}", identity) else None


async def host_identity():
    """``"<pid>:<start ticks>"`` of the process listening on the socket, None if unknown.

    Read from the socket's peer credentials, so it needs no protocol support and names
    any implementation; the start time keeps a reused pid from passing for the same
    host. respawn tells a ptyhost restart from sessions that ended by this value.
    Outside Linux, where neither exists, the host names itself in its process facts."""
    if sys.platform != "linux":
        return await _identity_from_host()
    async def probe():
        reader, writer = await asyncio.open_unix_connection(str(SOCK))
        try:
            sock = writer.get_extra_info("socket")
            creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        finally:
            writer.close()
        return struct.unpack("3i", creds)[0]
    try:
        pid = await asyncio.wait_for(probe(), REQUEST_TIMEOUT)
        stat = discover.read_proc_text(f"/proc/{pid}/stat")
        start = int(stat.rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError, asyncio.TimeoutError):
        return None
    return f"{pid}:{start}" if pid > 0 else None


async def attach_info(name, rows, cols, created=None, size=None, input_ack=None, input_ack_v2=None):
    """Attach by name for legacy callers, or conditionally to exactly ``created``.

    A conditional success is the native attach_if C/ok handshake, not an inventory
    check. Refusal or an indeterminate/malformed handshake never falls back to attach.
    A conditional request never carries initial geometry. Only a positively
    advertised extension requests size watching; its exact C ack must confirm
    support before the browser can resize or capture input. Missing metadata
    keeps ordinary I/O available, without discovering features by denial/retry.
    """
    if created is not None and (type(created) not in (int, float)
                                or not math.isfinite(created) or created <= 0):
        raise ValueError("invalid terminal incarnation")

    watch = size == "claim" and (created is None or await conditional_input_supported(name, created))
    async def handshake():
        reader, writer = await asyncio.open_unix_connection(str(SOCK), limit=4 * 1024 * 1024)
        try:
            req = {"op": "attach" if created is None else "attach_if", "name": name}
            if created is None:
                req.update(rows=rows, cols=cols)
            if created is not None:
                req["created"] = created
            if size is not None and (created is None or watch):
                req["size"] = size
            if input_ack is not None:
                req["input_ack_created"], req["input_ack_id"] = input_ack
            if input_ack_v2 is not None:
                req["input_ack_v2"] = input_ack_v2
            writer.write(frame(b"C", req))
            await writer.drain()
            kind, payload = await read_frame(reader)
            reply = json.loads(payload)
            if (kind != b"C" or not isinstance(reply, dict) or reply.get("ok") is not True
                    or "outcome" in reply):
                raise LookupError("terminal attachment refused")
        except BaseException:
            writer.close()
            raise
        return reader, writer, reply

    reader, writer, reply = await asyncio.wait_for(handshake(), REQUEST_TIMEOUT)
    if created is not None:
        # Relay-local policy, not a native field: require both the read-only
        # preselection and confirmation from this exact connected stream.
        reply["_conditional_input_verified"] = watch and supports(reply, CONDITIONAL_INPUT)
    return reader, writer, reply


async def attach(name, rows, cols):
    reader, writer, _reply = await attach_info(name, rows, cols)
    return reader, writer


# A unit left by an earlier install still runs this file as the PTY host. Fail loudly (78,
# EX_CONFIG: systemd marks the unit failed) rather than exit 0 and leave no host running.
if __name__ == "__main__":
    sys.stderr.write(
        "ptyhost.py: the Python PTY host was removed; the PTY host is now the native mesh-ptyhost.\n"
        "To switch (this ends every mesh session):\n"
        "  systemctl --user disable --now session-mesh-pty\n"
        "  rm ~/.config/systemd/user/session-mesh-pty.service\n"
        "  systemctl --user daemon-reload\n"
        "  systemctl --user reset-failed session-mesh-pty\n"
        "  ./install.sh\n"
        "Or install a release: its install.sh replaces this unit itself (docs/install.md, \"Install a release\").\n"
        "See docs/operations.md, \"Replacing the PTY host\" and \"Moving a source install to a release\".\n"
    )
    sys.exit(78)
