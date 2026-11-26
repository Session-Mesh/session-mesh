# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Private, per-session Pi agent directory for Pi's built-in MCP extension.

Pi >= 1.3 reads mcp.json from PI_CODING_AGENT_DIR.  Keep the owner's agent
configuration and transcripts by linking its other entries, but never modify
its ambient mcp.json.  This is Pi's native MCP configuration, not an MCP client.
"""

import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

import agentmcp


_VERSION = re.compile(r"(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\s*\Z")


class PiUnavailable(RuntimeError):
    pass


def binary(environ=None):
    environ = os.environ if environ is None else environ
    home = environ.get("HOME") or str(Path.home())
    # ptyhost puts ~/.local/bin first even if the Web process PATH omits it.
    search = os.pathsep.join(os.path.abspath(directory) for directory in
                            [str(Path(home) / ".local/bin"), *environ.get("PATH", "/usr/bin:/bin").split(os.pathsep)])
    executable = shutil.which("pi", path=search)
    if not executable:
        raise PiUnavailable("Pi not found in ~/.local/bin or PATH")
    executable = os.path.abspath(executable)
    try:
        probe = {"HOME": home, "PATH": search}
        if directory := environ.get("PI_CODING_AGENT_DIR"):
            probe["PI_CODING_AGENT_DIR"] = directory
        result = subprocess.run([executable, "--version"], capture_output=True, text=True,
                                timeout=3, check=True, env=probe, cwd="/")
    except (OSError, subprocess.SubprocessError) as exc:
        raise PiUnavailable("Could not check the Pi version") from exc
    match = _VERSION.fullmatch(result.stdout.strip())
    if not match:
        raise PiUnavailable("Unknown Pi version; Mesh MCP requires Pi 1.3.0 or later")
    version = tuple(map(int, match.groups()))
    if version < (1, 3, 0):
        raise PiUnavailable(f"Pi {'.'.join(map(str, version))} does not support Mesh MCP; Pi 1.3.0 or later required")
    return executable


def prepare(config_dir, environ=None):
    """Return (absolute Pi executable, private overlay) from one selected environment, or fail before launch."""
    environ = dict(os.environ if environ is None else environ)
    executable = binary(environ)
    board = Path(agentmcp.BOARD_MCP)
    if not board.is_file() or not os.access(board, os.X_OK):
        raise PiUnavailable(f"Mesh MCP server unavailable: {board}")
    home = Path(environ.get("HOME") or Path.home())
    base = Path(environ.get("PI_CODING_AGENT_DIR") or home / ".pi/agent").expanduser()
    sessions = base / "sessions"
    try:
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        sessions.mkdir(mode=0o700, exist_ok=True)
        ambient = base / "mcp.json"
        if ambient.exists():
            with ambient.open(encoding="utf-8") as source:
                payload = json.load(source)
            if not isinstance(payload, dict) or not isinstance(payload.get("mcpServers", {}), dict):
                raise PiUnavailable("Invalid Pi MCP configuration")
        else:
            payload = {}
        servers = dict(payload.get("mcpServers", {}))
        for server in agentmcp.mesh_servers("pi", bridge=str(board)):     # the user's "enabled": false stays
            off = isinstance(servers.get(server.name), dict) and servers[server.name].get("enabled") is False
            servers[server.name] = {"command": server.command, "args": server.args,
                                    "env": server.env, "exposure": "direct", "enabled": not off}
        payload["mcpServers"] = servers
        root = Path(config_dir) / "pi-agent-overlays"
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        overlay = Path(tempfile.mkdtemp(prefix="session-", dir=root))
        for entry in base.iterdir():
            if entry.name != "mcp.json":
                (overlay / entry.name).symlink_to(entry)
        fd = os.open(overlay / "mcp.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(payload, out, separators=(",", ":"))
            out.write("\n")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PiUnavailable("Invalid Pi MCP configuration") from exc
    except OSError as exc:
        raise PiUnavailable(f"Could not prepare Mesh MCP for Pi: {exc.strerror}") from exc
    return executable, overlay

def profile_overlay_matches(overlay, config_dir, profile):
    """Accept the private overlay created for this profile, without reading auth files."""
    path = Path(overlay)
    root = Path(config_dir) / "pi-agent-overlays"
    try:
        if not path.is_absolute() or path.parent.resolve(strict=True) != root.resolve(strict=True):
            return False
        for directory in (root, path):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                return False
        return (path / "sessions").readlink() == Path(profile) / "sessions"
    except OSError:
        return False
