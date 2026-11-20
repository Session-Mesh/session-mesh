# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Strict, opt-in launch settings for Mesh-owned agent plans.

The file is deliberately narrow: it can restrict workspace roots and choose
among already integrated agent identifiers.  It cannot name a binary, command,
credential, URL, plugin, or arbitrary environment variable.
"""

import contextlib
from dataclasses import dataclass, replace
import hashlib
import json
import os
from pathlib import Path
import unicodedata

import fsutil
import launchplan


ENV = "MESH_LAUNCH_SETTINGS"
MAX_BYTES = 16 * 1024
VERSION = 1
MAX_ROOTS = 16
MAX_PATH = 1024
_FIELDS = frozenset(("v", "workspace_roots", "enabled_agents"))
KNOWN_AGENTS = frozenset(launchplan.catalogue())


class InvalidLaunchSettings(ValueError):
    """The optional settings file is invalid and must not partly apply."""


@dataclass(frozen=True)
class LaunchSettings:
    roots: tuple[Path, ...]
    enabled_agents: frozenset[str]
    configured: bool
    source: Path | None = None      # the settings file these values were read from

    def allows_cwd(self, cwd: str | Path) -> bool:
        """Whether an existing physical directory belongs to a configured root."""
        if not self.configured:
            return True
        try:
            candidate = Path(cwd).resolve(strict=True)
        except OSError:
            return False
        return any(candidate.is_relative_to(root) for root in self.roots)

    def doctor(self) -> dict:
        """A read-only, JSON-safe local report; it does not launch anything."""
        return {"v": VERSION, "configured": self.configured,
                "workspace_roots": [str(root) for root in self.roots],
                "enabled_agents": sorted(self.enabled_agents)}


def _root(value: object, home: Path) -> Path:
    if not isinstance(value, str) or not value or len(value) > MAX_PATH:
        raise InvalidLaunchSettings("workspace root is invalid")
    path = Path(value)
    if not path.is_absolute():
        raise InvalidLaunchSettings("workspace root must be absolute")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, ValueError) as exc:    # ValueError: a NUL byte, a lone surrogate
        raise InvalidLaunchSettings("workspace root is unavailable") from exc
    if not resolved.is_dir() or not resolved.is_relative_to(home):
        raise InvalidLaunchSettings("workspace root is outside the Mesh home perimeter")
    return resolved


def parse(value: object, *, home: Path | None = None) -> LaunchSettings:
    """Validate the complete v1 object; unknown fields and duplicates fail closed."""
    home = (home or Path.home()).resolve(strict=True)
    if not isinstance(value, dict) or set(value) != _FIELDS or value.get("v") != VERSION:
        raise InvalidLaunchSettings("launch settings must be exactly v1")
    roots = value.get("workspace_roots")
    agents = value.get("enabled_agents")
    if (not isinstance(roots, list) or not 1 <= len(roots) <= MAX_ROOTS
            or not isinstance(agents, list) or not agents):
        raise InvalidLaunchSettings("workspace roots and enabled agents are required")
    resolved_roots = tuple(_root(root, home) for root in roots)
    if len(set(resolved_roots)) != len(resolved_roots):
        raise InvalidLaunchSettings("workspace roots must be unique")
    if any(not isinstance(agent, str) for agent in agents) or len(set(agents)) != len(agents):
        raise InvalidLaunchSettings("enabled agents must be unique identifiers")
    enabled = frozenset(agents)
    if not enabled <= KNOWN_AGENTS:
        raise InvalidLaunchSettings("enabled agent is not integrated")
    return LaunchSettings(resolved_roots, enabled, True)


def revision_of(raw: bytes) -> str:
    """The revision of a settings file: the SHA-256 of its exact bytes."""
    return hashlib.sha256(raw).hexdigest()


def defaults(home: Path | None = None) -> dict:
    """The factory values: every integrated agent, and the home directory as the one root."""
    return {"enabled_agents": sorted(KNOWN_AGENTS),
            "workspace_roots": [str((home or Path.home()).resolve(strict=True))]}


def _file_from_env(env: dict[str, str]) -> Path | None:
    selected = env.get(ENV)
    if selected is None:
        return None
    if not isinstance(selected, str) or not selected:
        raise InvalidLaunchSettings(f"{ENV} is invalid")
    path = Path(selected)
    if not path.is_absolute() or path.is_symlink():
        raise InvalidLaunchSettings(f"{ENV} must name a physical absolute file")
    return path


def _read(path: Path) -> bytes:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise InvalidLaunchSettings(f"{ENV} is unavailable") from exc
    if len(raw) > MAX_BYTES:
        raise InvalidLaunchSettings(f"{ENV} is too large")
    return raw


def load_with_revision(env: dict[str, str] | None = None, *,
                       home: Path | None = None) -> tuple[LaunchSettings, str | None]:
    """The settings and the revision of the bytes they were parsed from (None: no file)."""
    env = os.environ if env is None else env
    path = _file_from_env(env)
    if path is None:
        return LaunchSettings((), KNOWN_AGENTS, False), None
    raw = _read(path)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidLaunchSettings(f"{ENV} is not JSON") from exc
    return replace(parse(value, home=home), source=path), revision_of(raw)


def load_from_env(env: dict[str, str] | None = None, *, home: Path | None = None) -> LaunchSettings:
    """Load the opt-in file once at startup, or preserve legacy behaviour."""
    return load_with_revision(env, home=home)[0]


class ConflictError(Exception):
    """The write was refused for a reason that is not a validation error."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _protected(root: str, resolved: Path, deny: tuple[Path, ...]) -> bool:
    """Whether the folder, as typed or once resolved, is one of the protected entries or inside one."""
    typed = Path(os.path.abspath(root))
    return any(typed.is_relative_to(os.path.abspath(entry)) or resolved.is_relative_to(entry.resolve())
               for entry in deny)


def validate_update(agents: object, roots: object, *, home: Path | None = None,
                    deny: tuple[Path, ...] = ()) -> LaunchSettings:
    """Validate an owner's edit with the same rules as the file; the message names the offender.

    ``deny``: places that cannot be a work folder, the credential stores and Mesh's own
    configuration folder that ``/view`` also refuses."""
    home = (home or Path.home()).resolve(strict=True)
    if not isinstance(roots, list) or not 1 <= len(roots) <= MAX_ROOTS:
        raise InvalidLaunchSettings(f"between 1 and {MAX_ROOTS} workspace folders are required")
    if not isinstance(agents, list) or not agents:
        raise InvalidLaunchSettings("at least one agent must stay enabled")
    for agent in agents:
        if not isinstance(agent, str) or agent not in KNOWN_AGENTS:
            raise InvalidLaunchSettings(f"unknown agent: {str(agent)[:40]}")
    resolved = []
    for root in roots:
        shown = root[:80] if isinstance(root, str) else "?"
        try:
            path = _root(root, home)
        except InvalidLaunchSettings as exc:
            raise InvalidLaunchSettings(f"{shown}: {exc}") from exc
        if _protected(root, path, deny):
            raise InvalidLaunchSettings(f"{shown}: this folder holds credentials or Mesh's own "
                                        "configuration and cannot be a work folder")
        resolved.append(str(path))
    return parse({"v": VERSION, "workspace_roots": resolved, "enabled_agents": list(agents)}, home=home)


def write_update(agents: object, roots: object, expected_revision: str, applied_revision: str | None,
                 env: dict[str, str] | None = None, *, home: Path | None = None,
                 deny: tuple[Path, ...] = ()) -> tuple[LaunchSettings, str]:
    """Validate, then atomically replace the settings file. The caller serialises calls.

    ``expected_revision`` is what the browser saw; ``applied_revision`` is what this process
    enforces. The file must still hold exactly the applied bytes, or the write is refused."""
    env = os.environ if env is None else env
    path = _file_from_env(env)
    if path is None:
        raise ConflictError("not-configured", f"{ENV} is not set: there is no settings file to edit")
    if applied_revision is None or expected_revision != applied_revision:
        raise ConflictError("stale-revision", "the settings changed since this page loaded")
    if revision_of(_read(path)) != applied_revision:
        raise ConflictError("file-changed", "the settings file was edited outside Mesh; restart the server to apply it")
    settings = validate_update(agents, roots, home=home, deny=deny)
    text = json.dumps({"v": VERSION, "workspace_roots": [str(r) for r in settings.roots],
                       "enabled_agents": sorted(settings.enabled_agents)}, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise InvalidLaunchSettings("settings are too large")
    mode = path.stat().st_mode & 0o777
    fsutil.atomic_write(path, text, mode)
    return replace(settings, source=path), revision_of(text.encode("utf-8"))


# Runner settings: values shared by every device of this runner, in one JSON object in Mesh's configuration
# folder. RUNNER_LIMITS bounds each one (a text: characters; a list: entries), _RUNNER_CHECKS holds its typed
# validator. The owner edits those of RUNNER_OWNER_EDITABLE (elevated); the server alone records the recent
# folders (server.api_new). The server never acts on these values.
RUNNER_SETTINGS_FILE = "settings.json"
RUNNER_LIMITS = {"operator_name": 40, "recent_folders": 8}
RUNNER_OWNER_EDITABLE = frozenset(("operator_name",))
RUNNER_MAX_MARKS = 3   # combining marks (Mn, Me) in a row, after NFC
_HIDDEN = frozenset(("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"))   # control, format (bidi), unassigned
# Invisible or blank-looking characters of other categories (static/operator-name.ts refuses the same): combining
# grapheme joiner, Hangul fillers, Mongolian variation selectors, Braille blank, object replacement, variation selectors.
_INVISIBLE_MARKS = frozenset("\u034f\u115f\u1160\u180b\u180c\u180d\u180f\u2800\u3164\uffa0\ufffc"
                             + "".join(map(chr, [*range(0xFE00, 0xFE10), *range(0xE0100, 0xE01F0)])))


def _mark_run_too_long(text: str) -> bool:
    run = 0
    for c in text:
        run = run + 1 if unicodedata.category(c) in ("Mn", "Me") else 0
        if run > RUNNER_MAX_MARKS:
            return True
    return False


def _runner_text(key: str, value: object) -> str:
    """The value in NFC, trimmed; its length is counted in code points after normalisation."""
    text = unicodedata.normalize("NFC", value).strip() if isinstance(value, str) else None
    if text is None or len(text) > RUNNER_LIMITS[key] or _mark_run_too_long(text) or any(
            unicodedata.category(c) in _HIDDEN or c in _INVISIBLE_MARKS for c in text):
        raise InvalidLaunchSettings(f"{key}: at most {RUNNER_LIMITS[key]} characters, no control, bidi or invisible "
                                    f"character, at most {RUNNER_MAX_MARKS} combining marks in a row")
    return text


def plain_folder(value: object) -> bool:
    """An absolute path as os.path.normpath writes it (no '.', '..', '//' or trailing '/'), at most MAX_PATH bytes
    once written as JSON, with no control, format or unassigned character. Its shape only: nothing is resolved."""
    try:
        return (isinstance(value, str) and value.startswith("/") and not value.startswith("//")
                and value == os.path.normpath(value)
                and len(json.dumps(value, ensure_ascii=False).encode("utf-8")) <= MAX_PATH + 2
                and not any(unicodedata.category(c) in _HIDDEN for c in value))
    except UnicodeEncodeError:   # a lone surrogate: a file name that is not UTF-8
        return False


def _runner_folders(key: str, value: object) -> list:
    """The plain folders of a list, in order, once each, at most RUNNER_LIMITS[key]; any other entry is dropped."""
    if not isinstance(value, list):
        raise InvalidLaunchSettings(f"{key}: a list of folders is expected")
    return list(dict.fromkeys(entry for entry in value if plain_folder(entry)))[:RUNNER_LIMITS[key]]


_RUNNER_CHECKS = {"operator_name": _runner_text, "recent_folders": _runner_folders}   # the typed validator of each key
_RUNNER_DEFAULTS = {"operator_name": "", "recent_folders": ()}


def read_runner_settings(path: Path) -> dict:
    """Every runner setting: its stored value when valid, else its default (also for a missing or broken file)."""
    values = {key: list(default) if isinstance(default, tuple) else default for key, default in _RUNNER_DEFAULTS.items()}
    # Unreadable, not JSON, nested too deep for the parser, not an object: all read as the defaults.
    with contextlib.suppress(OSError, ValueError, AttributeError, RecursionError):
        stored = json.loads(path.read_bytes()[:MAX_BYTES].decode("utf-8"))
        for key in RUNNER_LIMITS.keys() & stored.keys():
            with contextlib.suppress(InvalidLaunchSettings):
                values[key] = _RUNNER_CHECKS[key](key, stored[key])
    return values


def _save_runner_settings(path: Path, values: dict) -> dict:
    fsutil.atomic_write(path, json.dumps({"v": VERSION, **values}, ensure_ascii=False, indent=2) + "\n", 0o600)
    return values


def write_runner_settings(path: Path, changes: object) -> dict:
    """Validate the owner's changed settings, merge them and replace the file atomically (the caller serialises)."""
    if not isinstance(changes, dict) or not changes or not changes.keys() <= RUNNER_OWNER_EDITABLE:
        raise InvalidLaunchSettings("unknown runner setting")
    changed = {key: _RUNNER_CHECKS[key](key, value) for key, value in changes.items()}
    return _save_runner_settings(path, {**read_runner_settings(path), **changed})


def add_recent_folders(path: Path, folders: list, *, newest: bool) -> list:
    """Put folders in the recent list: first (``newest``: a session just started there), or after the ones kept
    (a list moved from a browser); once each, at most 8. The caller has checked that each one may hold a session,
    and serialises the calls."""
    values = read_runner_settings(path)
    kept = values["recent_folders"]
    values["recent_folders"] = _runner_folders("recent_folders", [*folders, *kept] if newest else [*kept, *folders])
    return _save_runner_settings(path, values)["recent_folders"]


if __name__ == "__main__":
    print(json.dumps(load_from_env().doctor(), separators=(",", ":")))
