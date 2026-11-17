# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Where the mesh keeps its state: the one place the config and cache directories are derived.

``MESH_CONF_DIR`` / ``MESH_CACHE_DIR`` move them (a pre-production mesh from a worktree, see
scripts/preprod.sh) without touching ``HOME``, which claude and codex need for their logins.
Unset or empty, they are ``~/.config/session-mesh`` and ``~/.cache/session-mesh``, as ever.
A set value must be an absolute path: a relative one would depend on the working directory.
"""

import os
from pathlib import Path


def _dir(variable, default):
    value = os.environ.get(variable, "")
    if not value:
        return default
    path = Path(value)
    if not path.is_absolute():
        raise SystemExit(f"session-mesh: {variable} must be an absolute path (got {value!r})")
    return path


def conf_dir(): return _dir("MESH_CONF_DIR", Path.home() / ".config" / "session-mesh")


def cache_dir(): return _dir("MESH_CACHE_DIR", Path.home() / ".cache" / "session-mesh")


CONF_DIR = conf_dir()
CACHE_DIR = cache_dir()


def local_url(route):
    """The local mesh's URL for ``route``, where the CLIs send their credential.

    MESH_PORT is the only variable part and must be a port number: anything
    else (``7690@host``, ``7690/x``) would be read as another part of the URL."""
    value = os.environ.get("MESH_PORT") or "7690"
    if not (value.isascii() and value.isdigit() and len(value) <= 5 and 1 <= int(value) <= 65535):
        raise SystemExit(f"session-mesh: MESH_PORT must be a port number between 1 and 65535 (got {value!r})")
    return f"http://127.0.0.1:{int(value)}{route}"
