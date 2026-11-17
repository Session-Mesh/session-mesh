# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Small file helpers shared by the mesh's state files."""

import os
import tempfile
from pathlib import Path


def atomic_write(path, text, mode=0o600, *, sync_dir=False):
    """Replace ``path`` with ``text`` in one step: written to a unique
    temporary file next to it, flushed, then renamed over it. A crash or a
    concurrent writer never leaves a half-written file. ``sync_dir``: also
    flush the directory, so the rename itself survives a power loss."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if sync_dir:
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def atomic_create(path, text, mode=0o600):
    """Create ``path`` holding ``text`` in one step, only if nothing is there:
    written whole to a temporary file next to it, flushed, then linked under
    its name. The name never designates an empty or half-written file, and an
    existing file is left untouched. Returns whether this call created it."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        try:
            os.link(tmp, path)
        except FileExistsError:
            return False
        return True
    finally:
        os.unlink(tmp)


def read_bounded(path, max_bytes):
    """The UTF-8 text of ``path`` (``~`` expanded), or None when it is longer
    than ``max_bytes``. One descriptor and ``max_bytes + 1`` bytes: no stat
    then read, so a file replaced meanwhile cannot exceed the bound. Raises
    OSError or UnicodeError like the reads it makes."""
    with Path(path).expanduser().open("rb") as handle:
        data = handle.read(max_bytes + 1)
    return None if len(data) > max_bytes else data.decode("utf-8")
