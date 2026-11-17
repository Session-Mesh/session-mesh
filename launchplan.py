# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Code-owned, validated launch vectors for Mesh's known interactive CLIs.

This is deliberately not a user configuration format and it never invokes a
shell.  Custom terminal commands retain their separate, explicitly requested
path in ``server.api_new``; a known agent always starts from this catalogue.
"""

from dataclasses import dataclass

import agentcap
import agentmcp
import resumeargs


class InvalidLaunchPlan(ValueError):
    """A caller requested a launch plan outside Mesh's fixed catalogue."""


@dataclass(frozen=True)
class LaunchPlan:
    """An exact executable argv vector for one known interactive agent."""

    kind: str
    argv: tuple[str, ...]

    def __post_init__(self):
        if not isinstance(self.kind, str) or self.kind not in _EXECUTABLES:
            raise InvalidLaunchPlan(f"unknown Mesh agent: {self.kind!r}")
        if not isinstance(self.argv, tuple):
            raise InvalidLaunchPlan("launch argv must be an immutable tuple")
        if not self.argv or self.argv[0] != _EXECUTABLES[self.kind]:
            raise InvalidLaunchPlan("launch executable does not match agent")
        if any(not isinstance(arg, str) or not arg or "\0" in arg for arg in self.argv):
            raise InvalidLaunchPlan("launch argv contains an invalid argument")

    def command(self) -> list[str]:
        """A fresh list for a process launcher; never a shell command string."""
        return list(self.argv)


_EXECUTABLES = {
    "claude": "claude",
    "codex": "codex",
    "codex-yolo": "codex",
    "opencode": "opencode",
    "agy": "agy",
    "copilot": "copilot",
    "gemini": "gemini",
    "pi": "pi",
    "vibe": "vibe",
}


def agent_type(kind: str) -> str:
    """The agent a preset id launches: ``codex-yolo`` is Codex, like ``codex``."""
    if not isinstance(kind, str) or kind not in _EXECUTABLES:
        raise InvalidLaunchPlan(f"unknown Mesh agent: {kind!r}")
    return _EXECUTABLES[kind]


def build(kind: str) -> LaunchPlan:
    """Return the only fresh-session command supported for ``kind``.

    Capability checks remain adjacent to the one adapter that uses them.  The
    plain clients intentionally receive no guessed MCP configuration, and
    Claude/Codex receive the board bridge only when it is installed
    (agentmcp.inject).
    """
    if not isinstance(kind, str) or kind not in _EXECUTABLES:
        raise InvalidLaunchPlan(f"unknown Mesh agent: {kind!r}")
    if kind == "claude":
        agentcap.require_supported(kind, agentcap.Feature.BOARD_MCP)
        argv = agentmcp.inject(kind, ["claude", *resumeargs.claude_args()])
    elif kind in ("codex", "codex-yolo"):
        agentcap.require_supported("codex", agentcap.Feature.BOARD_MCP)
        # "codex" keeps Codex's own approvals and sandbox; only "codex-yolo"
        # passes --yolo (no approvals, no sandbox).
        bypass = ["--yolo"] if kind == "codex-yolo" else []
        argv = agentmcp.inject("codex", ["codex", *bypass, *resumeargs.codex_args()])
    elif kind in ("pi", "opencode", "gemini", "agy", "vibe"):
        # OpenCode's and Gemini's board server and state reports are added by the environment
        # (server.new_session), so its argv stays the bare command; agy has no per-session
        # configuration at all (the user installs the Mesh plugin once, scripts/agy-setup.sh).
        agentcap.require_supported(kind, agentcap.Feature.BOARD_MCP)
        argv = agentmcp.inject(kind, [kind])
    else:
        argv = [kind]
    return LaunchPlan(kind=kind, argv=tuple(argv))


def catalogue() -> dict[str, list[str]]:
    """The legacy UI catalogue, derived from typed plans without shell parsing."""
    return {kind: build(kind).command() for kind in _EXECUTABLES}
