# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Will Claude Code deliver Mesh's wake line without asking the user first?

Claude Code 2.1.325 treats a line written on its messaging socket according to
the ``crossSessionInbound`` setting, read in this order, the first value found
winning:

1. the administrator's policy (``managed-settings.json`` then the sorted
   ``managed-settings.d/*.json`` of ``/etc/claude-code``, or of
   ``/Library/Application Support/ClaudeCode`` on macOS);
2. the ``--settings`` of the command line;
3. the user's settings (``settings.json`` in ``$CLAUDE_CONFIG_DIR``, else
   ``~/.claude``).

The project's settings can only tighten: a value other than ``accept`` there wins,
``accept`` there is ignored.  Claude reads ``<cwd>/.claude/settings.json``; and
``settings.local.json`` from the canonical root of the cwd's repository (the main
checkout, for a linked worktree) when the user owns that root, its repository
entry and its ``.claude``, plus the older ``<cwd>/.claude/settings.local.json``.
Mesh resolves that root as Claude does (``_store_root``), and answers "no" when
it cannot be determined with certainty.  ``refuse`` drops the line, ``hold`` waits for an approval.  With no
value, a line is delivered when the sender's permission-mode class matches the
session's, and a sender that states no class (Mesh) is set aside only when the
session bypasses permissions.

Mesh never writes this setting.  ``delivers_automatically`` computes what
Claude will do with Mesh's line, and the answer is True only for ``accept``, or
for no value in a session that does not bypass permissions.  Everything else,
and every file Mesh cannot read with certainty, answers False: no socket, the
typed notice.  The managed policy delivered by MDM or by the organisation's
server is not a file and cannot be seen; the delivery confirmation of
claudewake covers it.
"""

import json
import os
import stat
import sys
from pathlib import Path

KEY = "crossSessionInbound"
ACCEPT = "accept"
_VALUES = frozenset((ACCEPT, "hold", "refuse"))
BYPASS = "bypassPermissions"
SETTINGS_BYTES = 1024 * 1024
MAX_DROP_INS = 64
_BYPASS_FLAGS = frozenset(("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"))
_SOURCES = frozenset(("user", "project", "local"))
PROJECT_ROOT_OPTION = "--project-config-root"
POINTER_BYTES = 4096
GIT_ENTRY = ".git"
_euid = os.geteuid        # replaced by a test: a file of another user cannot be made here


class Unreadable(Exception):
    """A settings source Mesh cannot read with certainty: the answer is "no"."""


def managed_directory():
    if sys.platform == "darwin":
        return Path("/Library/Application Support/ClaudeCode")
    return Path("/etc/claude-code")


def read_settings(path):
    """The settings object of one file, None when there is no such file.

    Raises Unreadable for anything else: unreadable, too large, not UTF-8 JSON,
    not an object, a FIFO or another file that is not regular.  The file is
    opened without blocking, and the type is checked on the opened descriptor
    after an lstat, so a file swapped for a FIFO meanwhile cannot hang Mesh."""
    path = str(path)
    try:
        os.lstat(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise Unreadable(path) from exc
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise Unreadable(path) from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > SETTINGS_BYTES:
            raise Unreadable(path)
        data = os.read(fd, SETTINGS_BYTES + 1)
        if len(data) > SETTINGS_BYTES:
            raise Unreadable(path)
        return _object(data.decode("utf-8"), path)
    except (OSError, UnicodeError) as exc:
        raise Unreadable(path) from exc
    finally:
        os.close(fd)


def _object(text, origin):
    try:
        settings = json.loads(text)
    except ValueError as exc:
        raise Unreadable(origin) from exc
    if not isinstance(settings, dict):
        raise Unreadable(origin)
    return settings


def _managed_settings():
    """The managed files in Claude's merge order: the base file, then the drop-ins."""
    directory = managed_directory()
    found = [read_settings(directory / "managed-settings.json")]
    drop_in = directory / "managed-settings.d"
    try:
        names = sorted(entry.name for entry in os.scandir(drop_in)
                       if entry.name.endswith(".json") and not entry.name.startswith("."))
    except FileNotFoundError:
        names = []
    except (OSError, ValueError) as exc:
        raise Unreadable(str(drop_in)) from exc
    if len(names) > MAX_DROP_INS:
        raise Unreadable(str(drop_in))
    return found + [read_settings(drop_in / name) for name in names]


def _flag_values(argv, option):
    """Every value of a ``--option value`` or ``--option=value`` in argv."""
    values = [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == option]
    return values + [arg.split("=", 1)[1] for arg in argv if arg.startswith(option + "=")]


def _command_settings(argv, cwd):
    """The single --settings value of the command: inline JSON or a file."""
    values = _flag_values(argv, "--settings")
    if "--settings" in argv[-1:] or len(values) > 1:
        raise Unreadable("--settings")
    if not values:
        return None
    value = values[0].strip()
    if value.startswith("{"):
        return _object(value, "--settings")
    settings = read_settings(Path(cwd) / os.path.expanduser(value))
    if settings is None:
        raise Unreadable(value)
    return settings


def _sources(argv):
    """The settings sources the command lets Claude read (--setting-sources)."""
    values = _flag_values(argv, "--setting-sources")
    if "--setting-sources" in argv[-1:] or len(values) > 1:
        raise Unreadable("--setting-sources")
    if not values:
        return _SOURCES
    names = frozenset(name.strip() for name in values[0].split(",") if name.strip())
    if not names <= _SOURCES:
        raise Unreadable("--setting-sources")
    return names


def _user_settings(env):
    home = env.get("HOME") or str(Path.home())
    base = env.get("CLAUDE_CONFIG_DIR") or str(Path(home) / ".claude")
    if not os.path.isabs(base):
        raise Unreadable(base)
    return read_settings(Path(base) / "settings.json")


def _read_small(path):
    """The text of a small regular file (a repository pointer, ``commondir``, ``gitdir``)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except (OSError, ValueError) as exc:
        raise Unreadable(str(path)) from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Unreadable(str(path))
        data = os.read(fd, POINTER_BYTES + 1)
        if len(data) > POINTER_BYTES:
            raise Unreadable(str(path))
        return data.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise Unreadable(str(path)) from exc
    finally:
        os.close(fd)


def _repository_root(directory):
    """The nearest folder, from ``directory`` upwards, holding a repository entry; None if none.

    The entry is the ``.git`` directory or file.  A symbolic link or another
    type is a repository Mesh cannot judge: Unreadable."""
    current = Path(directory)
    while True:
        try:
            mode = os.lstat(current / GIT_ENTRY).st_mode
        except FileNotFoundError:
            mode = None
        except (OSError, ValueError) as exc:
            raise Unreadable(str(current)) from exc
        if mode is not None:
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise Unreadable(str(current / GIT_ENTRY))
            return current
        if current.parent == current:
            return None
        current = current.parent


def _canonical_root(root):
    """The main checkout a linked worktree belongs to, else ``root``, read as Claude reads it.

    A directory entry means ``root`` itself.  A file entry ``gitdir: <path>``
    names the worktree's folder inside the main repository: its ``commondir``
    leads back to the main repository's directory, and its ``gitdir`` file must
    lead back to this entry.  An entry without ``commondir`` (a submodule) is
    ``root``.  A pointer that does not check out is ambiguous: Unreadable."""
    entry = root / GIT_ENTRY
    if stat.S_ISDIR(os.lstat(entry).st_mode):
        return root
    text = _read_small(entry).strip()
    if not text.startswith("gitdir:"):
        return root
    target = text[len("gitdir:"):].strip()
    if not target or "\0" in target:
        raise Unreadable(str(entry))
    worktree = Path(os.path.normpath(root / target))
    try:
        os.lstat(worktree / "commondir")
    except FileNotFoundError:
        return root
    common_text = _read_small(worktree / "commondir").strip()
    if not common_text or "\0" in common_text:
        raise Unreadable(str(worktree))
    common = Path(os.path.normpath(worktree / common_text))
    if worktree.parent != common / "worktrees" or common.name != GIT_ENTRY:
        raise Unreadable(str(worktree))
    back = _read_small(worktree / "gitdir").strip()
    if not back or os.path.realpath(worktree / back) != os.path.join(os.path.realpath(root), GIT_ENTRY):
        raise Unreadable(str(worktree))
    return common.parent


def _owned(root):
    """Claude keeps the root only when the user owns it, its repository entry and its ``.claude``."""
    uid = _euid()
    try:
        claude_uid = os.lstat(root / ".claude").st_uid
    except FileNotFoundError:
        claude_uid = None
    return (os.stat(root).st_uid == uid and os.lstat(root / GIT_ENTRY).st_uid == uid
            and claude_uid in (None, uid))


def _store_root(cwd, home):
    """The folder whose ``.claude/settings.local.json`` Claude reads for this cwd.

    Claude's rule: the canonical root of the cwd's repository, unless there is
    none, it is the cwd itself, it is the user's home, or its owner (root,
    repository entry, ``.claude``) is not the user: then the cwd.  Any error
    while looking is Unreadable, never a guess."""
    cwd = Path(os.path.realpath(cwd))
    try:
        found = _repository_root(cwd)
        if found is None:
            return cwd
        root = Path(os.path.realpath(_canonical_root(found)))
        if root == cwd or root == Path(os.path.realpath(home)):
            return cwd
        return root if _owned(root) else cwd
    except (OSError, ValueError) as exc:
        raise Unreadable(str(cwd)) from exc


def _project_settings(cwd, allowed, home):
    """The project's settings objects, as Claude reads them for this cwd.

    ``settings.json`` from the cwd's ``.claude``; ``settings.local.json`` from
    the repository's canonical root, and the older copy in the cwd's own
    ``.claude``.  The cwd is the physical folder: the raw path is resolved with
    realpath, ``..`` after a symbolic link included, as the PTY host's chdir
    does, and Claude reads the working directory the kernel reports."""
    if not allowed & {"project", "local"}:
        return []
    if not isinstance(cwd, str) or not os.path.isabs(os.path.expanduser(cwd)):
        raise Unreadable("cwd")
    physical = Path(os.path.realpath(os.path.expanduser(cwd)))
    found = []
    if "project" in allowed:
        found.append(read_settings(physical / ".claude" / "settings.json"))
    if "local" in allowed:
        folders = []
        for candidate in (_store_root(physical, home), physical):
            if candidate not in folders:
                folders.append(candidate)
        found.extend(read_settings(folder / ".claude" / "settings.local.json") for folder in folders)
    return found


def _inbound(settings):
    """(present, value) of crossSessionInbound in one settings object."""
    if settings is None or KEY not in settings:
        return False, None
    value = settings[KEY]
    return True, value if isinstance(value, str) and value in _VALUES else None


def _bypass_flag(argv):
    modes = _flag_values(argv, "--permission-mode")
    return bool(_BYPASS_FLAGS.intersection(argv)) or BYPASS in modes


def _bypass_setting(settings):
    permissions = None if settings is None else settings.get("permissions")
    return isinstance(permissions, dict) and permissions.get("defaultMode") == BYPASS


def _effective(tiers):
    """The first value found in the tiers, "absent" when none, None when invalid."""
    for settings in tiers:
        present, value = _inbound(settings)
        if present:
            return value
    return "absent"


def _evaluate(argv, cwd, env):
    if PROJECT_ROOT_OPTION in argv or any(arg.startswith(PROJECT_ROOT_OPTION + "=") for arg in argv):
        return False        # it moves where Claude reads the project's settings
    managed = _managed_settings()
    command = _command_settings(argv, cwd)
    allowed = _sources(argv)
    user = _user_settings(env) if "user" in allowed else None
    project = _project_settings(cwd, allowed, env.get("HOME") or str(Path.home()))
    everything = [*managed, command, user, *project]
    if any(present and value is None for present, value in map(_inbound, everything)):
        return False        # an unrecognised value: Claude holds the messages
    if any(present and value != ACCEPT for present, value in map(_inbound, project)):
        return False        # a project can only tighten
    # Within the managed tier a later file overrides an earlier one.
    effective = _effective([*reversed(managed), command, user])
    if effective != "absent":
        return effective == ACCEPT
    return not (_bypass_flag(argv) or any(map(_bypass_setting, everything)))


def delivers_automatically(argv, cwd, env):
    """Whether Claude will deliver Mesh's line without an approval; False when unsure.

    argv: the Claude command words (``claude`` first); cwd: the session's
    folder; env: the environment the session will get."""
    try:
        return _evaluate(list(argv[1:]), cwd, env)
    except (Unreadable, OSError, ValueError, TypeError, AttributeError):
        return False
