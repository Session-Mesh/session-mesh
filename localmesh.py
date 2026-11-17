# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""What the local CLIs (mesh-attach, mesh-rename) share: the master token,
creating a session the way the server does, and finding the session a
process runs in."""

import os
import sys

import discover
import meshpaths
import ptyhost
import sessiontoken

TOKEN_FILE = meshpaths.CONF_DIR / "token"


def master_token():
    return TOKEN_FILE.read_text().strip()


def session_env(name):
    """(env, meta) for a new session, as the server makes them: the session's
    own name and token (mesh-open then opens documents next to it, with a
    credential valid for that session only), bound by a fresh nonce."""
    sessiontoken.configure(master_token())
    nonce = sessiontoken.new_nonce()
    env = {"MESH_SESSION": name, "MESH_SESSION_TOKEN": sessiontoken.issue(name, nonce)}
    return env, {"nonce": nonce}


def _parent(pid):
    if sys.platform != "linux":   # no /proc: read_stat asks the PTY host
        stat = discover.read_stat(pid)
        if stat is None or stat[2] < 0:   # gone, or present with details unknown
            raise OSError(f"parent of {pid} unknown")
        return stat[2]
    return int(discover.read_proc_text(f"/proc/{pid}/stat").rsplit(")", 1)[1].split()[1])


def current_session(sessions, pid=None):
    """The mesh session whose shell is an ancestor of this process. The
    process ancestry is the evidence; an inherited MESH_SESSION (a tmux server
    or a GUI app started from a session, a name reused since) only counts when
    the ancestry says nothing and it names a live session."""
    shells = {s["pid"]: s["name"] for s in sessions}
    pid = pid or os.getpid()
    while pid > 1:
        if pid in shells:
            return shells[pid]
        try:
            pid = _parent(pid)
        except (OSError, ValueError, IndexError):
            break
    named = os.environ.get("MESH_SESSION")
    return named if named in shells.values() else None


async def list_sessions():
    return await ptyhost.request({"op": "list"})
