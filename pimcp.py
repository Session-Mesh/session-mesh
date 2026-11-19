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
import subprocess
import tempfile

import agentmcp


_VERSION = re.compile(r"(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\s*\Z")


class PiUnavailable(RuntimeError):
    pass


def binary():
    # ptyhost puts ~/.local/bin first even if the Web process PATH omits it.
    search = str(Path.home() / ".local/bin") + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin")
    executable = shutil.which("pi", path=search)
    if not executable:
        raise PiUnavailable("Pi not found in ~/.local/bin or PATH")
    try:
        result = subprocess.run([executable, "--version"], capture_output=True, text=True,
                                timeout=3, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PiUnavailable("Could not check the Pi version") from exc
    match = _VERSION.fullmatch(result.stdout.strip())
    if not match:
        raise PiUnavailable("Unknown Pi version; Mesh MCP requires Pi 1.3.0 or later")
    version = tuple(map(int, match.groups()))
    if version < (1, 3, 0):
        raise PiUnavailable(f"Pi {'.'.join(map(str, version))} does not support Mesh MCP; Pi 1.3.0 or later required")
    return executable


def prepare(config_dir):
    """Return (absolute Pi executable, private overlay), or fail before launch."""
    executable = binary()
    board = Path(agentmcp.BOARD_MCP)
    if not board.is_file() or not os.access(board, os.X_OK):
        raise PiUnavailable(f"Mesh MCP server unavailable: {board}")
    base = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi/agent").expanduser()
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
        servers[agentmcp.SERVER_NAME] = {
            "command": str(board), "args": agentmcp.BOARD_MCP_ARGS,
            "env": {}, "exposure": "direct", "enabled": True,
        }
        if work := agentmcp.work_server("pi"):
            servers[agentmcp.WORK_SERVER_NAME] = {**work, "exposure": "direct", "enabled": True}
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
