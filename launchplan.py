# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Code-owned, validated launch vectors for Mesh's known interactive CLIs.

This is deliberately not a user configuration format and it never invokes a
shell.  Custom terminal commands retain their separate, explicitly requested
path in ``server.api_new``; a known agent always starts from this catalogue.
"""

from dataclasses import dataclass
from types import MappingProxyType

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


# Owner-supplied options Mesh must not accept. Two classes only, on purpose: the flags that make an
# agent run without approvals and without a sandbox (the class the "codex-yolo" preset reserves to
# the owner), and the options that pick the conversation, which Mesh records before the agent starts
# and which would therefore be duplicated or contradicted. Everything else is the owner's choice.
_YOLO_FLAGS = MappingProxyType({
    "codex": frozenset({"--yolo", "--dangerously-bypass-approvals-and-sandbox",
                        "--dangerously-bypass-hook-trust"}),
    "claude": frozenset({"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"}),
})
_YOLO_PAIRS = MappingProxyType({
    "codex": frozenset({("-a", "never"), ("--ask-for-approval", "never"),
                        ("-s", "danger-full-access"), ("--sandbox", "danger-full-access")}),
    "claude": frozenset({("--permission-mode", "bypassPermissions")}),
})
# ``codex -c key=value`` reaches the same class through its configuration overrides.
_YOLO_OVERRIDES = frozenset({("approval_policy", "never"), ("ask_for_approval", "never"),
                             ("sandbox_mode", "danger-full-access"),
                             ("sandbox", "danger-full-access")})
_CONVERSATION_OPTIONS = MappingProxyType({
    "claude": frozenset({"--session-id", "--continue", "-c", "--resume", "-r", "--fork-session"}),
    "codex": frozenset(),      # ``codex resume`` is a subcommand: refused as a positional below
    "pi": frozenset({"--session-id", "--session", "--session-dir", "--continue", "-c",
                      "--resume", "-r", "--fork"}),
})
# The agents whose positional argument is a subcommand rather than a first prompt.
_SUBCOMMAND_AGENTS = frozenset({"codex"})


def _option_pairs(tokens: tuple[str, ...]) -> tuple[list[tuple[str, str | None]], tuple[str, ...]]:
    """The option/value pairs of ``tokens`` and the first positional, if any.

    Handles ``--opt=value``, ``-o value`` and ``-o=value``. Reading stops at the first token that is
    not an option: what follows is a prompt, where a word like ``--yolo`` is text, not a flag.
    """
    pairs: list[tuple[str, str | None]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not isinstance(token, str) or not token.startswith("-") or token == "-":
            break
        name, separator, inline = token.partition("=")
        if separator:
            pairs.append((name, inline))
            index += 1
            continue
        following = tokens[index + 1] if index + 1 < len(tokens) else None
        if following is not None and not following.startswith("-"):
            pairs.append((name, following))
            index += 2
        else:
            pairs.append((name, None))
            index += 1
    return pairs, tokens[index:]


def refusal(kind: str, tokens) -> str | None:
    """The first owner option Mesh must not accept for ``kind``, or None.

    ``tokens`` are the options the owner supplied (stored or typed for one launch). The code-owned
    preset vector is deliberately not checked here, so the ``codex-yolo`` preset keeps its own
    ``--yolo`` while the same flag typed into an options field is refused.
    """
    agent = agent_type(kind)
    options = tuple(tokens)
    if not options:
        return None
    pairs, positional = _option_pairs(options)
    yolo_flags = _YOLO_FLAGS.get(agent, frozenset())
    yolo_pairs = _YOLO_PAIRS.get(agent, frozenset())
    conversation = _CONVERSATION_OPTIONS.get(agent, frozenset())
    for name, value in pairs:
        if name in yolo_flags:
            return name
        if (name, value) in yolo_pairs:
            return f"{name} {value}"
        if agent == "codex" and name in ("-c", "--config") and value:
            key, _, setting = value.partition("=")
            override = (key.strip().strip('"'), setting.strip().strip('"').strip("'"))
            if override in _YOLO_OVERRIDES:
                return f"{name} {value}"
        if name in conversation:
            return name
    if agent in _SUBCOMMAND_AGENTS and positional:
        return positional[0]
    return None


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
