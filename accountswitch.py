"""Bind a default account to its observed agent environment, without retaining secrets."""

import hashlib
import os
from pathlib import Path


class UnboundDefault(ValueError):
    """The effective default account cannot be established safely."""


_KINDS = {"codex": ("CODEX_HOME", ".codex"), "claude": ("CLAUDE_CONFIG_DIR", ".claude")}
_OVERRIDES = {
    "codex": ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"),
    "claude": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
               "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
               "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY",
               "ANTHROPIC_BASE_URL"),
}


def default_context(kind, environ):
    """Return only the root and its interoperable carry revision, or fail closed."""
    if kind not in _KINDS or any(environ.get(name) for name in _OVERRIDES[kind]):
        raise UnboundDefault("Default account environment is not identifiable")
    variable, directory = _KINDS[kind]
    home = environ.get("HOME", "")
    value = environ.get(variable, "")
    if value and not os.path.isabs(value):
        raise UnboundDefault("Default account folder is not absolute")
    if not value and not os.path.isabs(home):
        raise UnboundDefault("Default home folder is not absolute")
    root = value or os.path.join(home, directory)
    if "\x00" in root:
        raise UnboundDefault("Invalid default account folder")
    digest = hashlib.sha256(f"mesh-default-v1\0{kind}\0{root}".encode()).hexdigest()
    return {"root": root, "context_revision": digest}


def process_default_context(kind, pid, proc_root=Path("/proc")):
    """Read an owned Linux process's startup environment and bind its process identity.

    Refuse a disappearing/reused process, inaccessible procfs or duplicated relevant variables.
    The caller must independently establish that this PID is the session's foreground agent.
    """
    if type(pid) is not int or pid <= 0 or kind not in _KINDS:
        raise UnboundDefault("Agent process is unavailable")
    folder = proc_root / str(pid)
    try:
        if folder.stat().st_uid != os.geteuid():
            raise UnboundDefault("Agent process has a different owner")
        def start_time():
            # comm is parenthesized and may itself contain spaces or parentheses.
            fields = (folder / "stat").read_bytes().rsplit(b")", 1)[1].split()
            return fields[19]

        started = start_time()
        raw = (folder / "environ").read_bytes()
        if len(raw) > 2_000_000 or started != start_time() or folder.stat().st_uid != os.geteuid():
            raise UnboundDefault("Agent process identity changed")
        selected = {"HOME", _KINDS[kind][0], *_OVERRIDES[kind]}
        values = {}
        for part in raw.split(b"\0"):
            key, separator, value = part.partition(b"=")
            if not separator:
                continue
            name = os.fsdecode(key)
            if name in selected:
                if name in values:
                    raise UnboundDefault("Agent environment has duplicate keys")
                values[name] = os.fsdecode(value)
        context = default_context(kind, values)
        context.update(process_pid=pid, process_start=started.decode("ascii"))
        return context
    except (OSError, UnicodeError, IndexError) as exc:
        raise UnboundDefault("Agent environment is unavailable") from exc
