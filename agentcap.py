# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Mesh's static, fail-closed integration capabilities for interactive CLIs.

These describe what Mesh currently implements, not every feature of an
upstream agent.  In particular, ``unavailable`` never means that an upstream
CLI cannot support the feature in a future, separately reviewed adapter.
The entry points Mesh recognises for an agent's command line (entry_args)
are described here too.
"""

import os
import re
from enum import Enum
from types import MappingProxyType


class Feature(str, Enum):
    BOARD_MCP = "board_mcp"
    HISTORY = "history"
    RESUME = "resume"
    STRUCTURED_OUTPUT = "structured_output"


class Status(str, Enum):
    SUPPORTED = "supported"
    UNAVAILABLE = "unavailable"
    UNKNOWN = "unknown"


class UnsupportedCapability(ValueError):
    """A Mesh integration was requested without a verified implementation."""


_INTEGRATED = MappingProxyType({
    Feature.BOARD_MCP: Status.SUPPORTED,
    Feature.HISTORY: Status.SUPPORTED,
    Feature.RESUME: Status.SUPPORTED,
    Feature.STRUCTURED_OUTPUT: Status.UNKNOWN,
})
_PLAIN = MappingProxyType({
    Feature.BOARD_MCP: Status.UNAVAILABLE,
    Feature.HISTORY: Status.UNAVAILABLE,
    Feature.RESUME: Status.UNAVAILABLE,
    Feature.STRUCTURED_OUTPUT: Status.UNKNOWN,
})
# The History tab reads each agent's own conversation store (history.py): claude, codex and Pi transcripts;
# OpenCode's SQLite database (read-only); Gemini's chats/session-*.jsonl (the user's own store and Mesh's
# private overlay home); Antigravity's brain/<id>/.system_generated/logs/transcript.jsonl; Copilot's
# session-state/<id>/events.jsonl; Vibe's unified store (meta.json + chunks).
# Resume per agent: OpenCode `-s <id>`, Gemini `--resume <id>`, Antigravity `--conversation <id>`,
# Copilot `--resume=<id>`, Vibe `--resume <id>`. Board bridge: OpenCode OPENCODE_CONFIG_CONTENT, Gemini a private
# GEMINI_CLI_HOME overlay, Antigravity one plugin the user installs (scripts/agy-setup.sh), Copilot
# --additional-mcp-config, Vibe VIBE_MCP_SERVERS.
_HISTORY_RESUME = MappingProxyType({Feature.BOARD_MCP: Status.SUPPORTED,
                                    Feature.HISTORY: Status.SUPPORTED,
                                    Feature.RESUME: Status.SUPPORTED,
                                    Feature.STRUCTURED_OUTPUT: Status.UNKNOWN})
MATRIX = MappingProxyType({
    "claude": _INTEGRATED,
    "codex": _INTEGRATED,
    "opencode": _HISTORY_RESUME,
    "agy": _HISTORY_RESUME,
    "copilot": _HISTORY_RESUME,
    "gemini": _HISTORY_RESUME,
    "pi": _HISTORY_RESUME,
    "vibe": _HISTORY_RESUME,
})


def status(agent: str, feature: Feature) -> Status:
    if not isinstance(feature, Feature):
        raise UnsupportedCapability(f"unknown Mesh feature: {feature!r}")
    try:
        return MATRIX[agent][feature]
    except KeyError as exc:
        raise UnsupportedCapability(f"unknown Mesh agent: {agent!r}") from exc


def require_supported(agent: str, feature: Feature) -> None:
    actual = status(agent, feature)
    if actual is not Status.SUPPORTED:
        raise UnsupportedCapability(f"{agent} {feature.value}: {actual.value}")


# What the wrapped entry points look like. Anything else (a shell script, an
# unknown launcher, node with options of its own) is not recognised: the
# arguments after it may belong to the wrapper, so they are not read.
_NODE = {"node", "nodejs"}
_NODE_ENTRY = {"claude": ("@anthropic-ai", "claude-code", "cli.js"),
               "codex": ("@openai", "codex", "bin", "codex.js"),
               "opencode": ("opencode-ai", "bin", "opencode"),
               "gemini": ("@google", "gemini-cli", "bundle", "gemini.js")}
_PACKAGE = {"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex", "opencode": "opencode-ai",
            "gemini": "@google/gemini-cli"}
_RUNNERS = {"npx", "bunx"}
_RUNNER_FLAGS = {"-y", "--yes"}
_VERSION = re.compile(r"\d+\.\d+\.\d+")        # claude's native binary: .../claude/versions/2.1.283
_PACKAGE_VERSION = re.compile(r"[0-9A-Za-z._-]+")


CODEX_SUBCOMMANDS = {   # codex 0.169 (`codex --help`) except resume
    "exec", "e", "review", "fork", "apply", "a", "login", "logout", "mcp", "proto", "cloud", "queue",
    "completion", "sandbox", "debug", "agents", "plugin", "app-server", "remote-control", "update", "doctor",
    "archive", "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive", "exec-server", "features", "help"}


def _is_node_entry(kind, script):
    want = _NODE_ENTRY.get(kind)
    return want is not None and script.startswith("/") and tuple(script.split("/")[-len(want):]) == want


def _is_package(kind, spec):
    name = _PACKAGE.get(kind)
    if name is None:
        return False
    return spec == name or (spec.startswith(name + "@") and _PACKAGE_VERSION.fullmatch(spec[len(name) + 1:]) is not None)


def entry_args(kind, argv):
    """The arguments that follow the entry point of a `kind` agent started with argv, or None when
    the shape is not one of the recognised ones:

    - the agent's own binary (basename claude / codex / opencode / gemini / agy / vibe, or vibe-rs), or claude's versioned native binary;
    - node <abs path>/@anthropic-ai/claude-code/cli.js, node <abs path>/@openai/codex/bin/codex.js;
    - npx / bunx [-y] <package>[@version].
    """
    if not argv:
        return None
    first = os.path.basename(argv[0])
    if first == kind or (kind == "vibe" and first == "vibe-rs"):   # `vibe` execs its bundled TUI, vibe-rs
        return argv[1:]
    if (kind == "claude" and argv[0].startswith("/") and _VERSION.fullmatch(first)
            and argv[0].split("/")[-3:-1] == ["claude", "versions"]):
        return argv[1:]
    if first in _NODE and kind in _NODE_ENTRY and len(argv) > 1 and _is_node_entry(kind, argv[1]):
        return argv[2:]
    if kind == "gemini" and first in _NODE:
        # `node /path/bin/gemini` (the installed link) or its relaunch `node --max-old-space-size=N ...`
        rest = argv[1:]
        while rest and rest[0].startswith("-"):
            rest = rest[1:]
        if rest and rest[0].startswith("/") and os.path.basename(rest[0]) in ("gemini", "gemini.js"):
            return rest[1:]
    if first in _RUNNERS:
        rest = argv[1:]
        while rest and rest[0] in _RUNNER_FLAGS:
            rest = rest[1:]
        if rest and kind in _PACKAGE and _is_package(kind, rest[0]):
            return rest[1:]
    return None


_SHELLS = {"sh", "bash", "dash", "zsh"}


def shell_command_index(argv):
    """The index of the command string of a shell run with -c (``sh -c``, ``bash -lc``…), else None."""
    if argv and os.path.basename(argv[0]) in _SHELLS:
        for i, word in enumerate(argv[1:], 1):
            if not word.startswith("-") or word.startswith("--"):
                break
            if "c" in word[1:] and i + 1 < len(argv):
                return i + 1
    return None
