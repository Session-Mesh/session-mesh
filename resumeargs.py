# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The command line that reopens an agent's conversation in the mesh.

An agent's original argv cannot simply be replayed with a resume flag added:
its positional argument is the first prompt (`claude "fix the tests"`), which
would be sent again as a new turn, and some options start or pick another
session. The argv is therefore rebuilt from an allow-list:

- known options that shape the session (model, permissions, directories…)
  are kept, with their value;
- options that pick or start a session, and every positional, are dropped;
- an unknown option (whose arity we cannot tell) stops the reading there: the
  options recognised so far are kept, and the resume is refused when a
  restrictive option (--disallowedTools, --permission-mode, --sandbox…) follows,
  since dropping it would widen what the agent may do;
- a wrapped agent keeps its options only when the argv shape is recognised with
  certainty (see entry_args): the options are read from the arguments that follow
  the agent's entry point. The command is always rebuilt as a bare `claude` /
  `codex` from PATH: nothing taken from argv[0] or the script path is ever run;
- a codex subcommand other than resume (review, fork…) is not an interactive
  session: the bare resume is used; a `codex exec` session is never resumed;
- a bare resume (unrecognised wrapper or subcommand) is refused when an unread word
  names a restrictive option.
"""

import copy
import hashlib
import json
import os
import re
import shlex
import uuid
from pathlib import Path

import agentmcp
import fsutil
from agentcap import CODEX_SUBCOMMANDS, entry_args, shell_command_index
from agentwake import THREAD_RE

# Keep Codex in xterm's normal buffer with its ordinary rich rendering.
# Both settings are invocation-local; neither changes global configuration.
# The user can still opt into append-only output with Codex's /raw command.
CODEX_INLINE = "--no-alt-screen"
CODEX_STANDARD_OUTPUT = "tui.raw_output_mode=false"

# Taken from the installation (agentmcp.runtime_bin, which keeps current/ of a
# release install unresolved), never looked up in PATH: a hook runs inside the
# agent's process, whose PATH is user-controlled and unrelated to this mesh.
MESH_EVENT = str(agentmcp.runtime_bin() / "mesh-event")
_CLAUDE_HOOK_EVENTS = agentmcp.hook_events("claude", "state")
_MAX_SETTINGS_BYTES = 1024 * 1024


def _mesh_hooks():
    """A fresh hook fragment: callers may merge it without sharing lists.  The state hooks, then the
    read-only project context hook (agentmcp.project_context_hooks: SessionStart, when it is on)."""
    timeout = agentmcp.hook_timeout("claude")
    hook = {"hooks": [{"type": "command", "command": f"{shlex.quote(MESH_EVENT)} claude", "timeout": timeout}]}
    hooks = {event: [copy.deepcopy(hook)] for event in _CLAUDE_HOOK_EVENTS}
    for event, argv in agentmcp.project_context_hooks("claude"):
        hooks.setdefault(event, []).append({"hooks": [{"type": "command", "command": shlex.join(argv), "timeout": timeout}]})
    return {"hooks": hooks}


def _settings_object(value):
    """Read one Claude --settings value as an object, or return None.

    A settings value is either an inline JSON object or a path.  A bad value is
    never replaced: losing a user's settings just to install observability
    hooks would be worse than having no hook for that resumed session.
    """
    if not isinstance(value, str):
        return None
    text = value.lstrip()
    if text.startswith(("{", "[")):
        raw = value
    else:
        try:
            raw = fsutil.read_bounded(value, _MAX_SETTINGS_BYTES)
        except (OSError, UnicodeError):
            return None
        if raw is None:
            return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


# An event hook is recognised by the helper it runs, never by a list of names
# nor by today's timeout or other keys: a command hook ``<absolute helper> claude``.
# Two helpers are replaced: this installation's own (MESH_EVENT), wherever it
# lives (MESH_BIN_DIR need not be named ``bin``), in any event; and another
# installation's, ``<absolute directory>/bin/<prefix>-event``, only when the
# same helper is hooked on every event an installation writes
# (_CLAUDE_HOOK_EVENTS), as every installation under whatever name writes it.
# A restored command thus reports to this one only, and a user's own hook of
# that name shape on fewer events is kept.
_EVENT_SUFFIX = "-event"


def _event_helper(hook):
    """The absolute helper of a ``<helper> claude`` command hook, else None."""
    command = hook.get("command") if isinstance(hook, dict) and hook.get("type") == "command" else None
    try:
        words = shlex.split(command) if isinstance(command, str) else []
    except ValueError:
        return None
    return words[0] if len(words) == 2 and words[1] == "claude" and os.path.isabs(words[0]) else None


def _is_other_event_helper(executable):
    path = Path(executable)
    return path.parent.name == "bin" and path.name.endswith(_EVENT_SUFFIX) and path.name != _EVENT_SUFFIX


def _helpers_of(entries):
    """The event helpers named in one event's hook groups."""
    helpers = set()
    for group in entries if isinstance(entries, list) else []:
        inner = group.get("hooks") if isinstance(group, dict) else None
        if isinstance(inner, list):
            helpers.update(filter(None, map(_event_helper, inner)))
    return helpers


def _installed_helpers(hooks):
    """This installation's helper, and every other installation's helper that
    is hooked on each event an installation writes."""
    others = [{helper for helper in _helpers_of(hooks.get(event)) if _is_other_event_helper(helper)}
              for event in _CLAUDE_HOOK_EVENTS]
    return {MESH_EVENT, *set.intersection(*others)}


def _is_project_hook(hook):
    """A project context hook of any installation: ``<absolute dir>/work-read context --format claude``."""
    command = hook.get("command") if isinstance(hook, dict) and hook.get("type") == "command" else None
    try:
        words = shlex.split(command) if isinstance(command, str) else []
    except ValueError:
        return False
    return (len(words) == 4 and os.path.isabs(words[0]) and os.path.basename(words[0]) == "work-read"
            and words[1:] == ["context", "--format", "claude"])


def _without_event_hooks(entries, helpers):
    """One event's hook groups without the hooks running one of helpers or a
    project context hook: a restored command must report to this deployment
    only, under its current switch.  A group left with no hook is dropped;
    everything else is kept as it is."""
    kept = []
    for group in entries:
        inner = group.get("hooks") if isinstance(group, dict) else None
        remaining = ([hook for hook in inner if _event_helper(hook) not in helpers and not _is_project_hook(hook)]
                     if isinstance(inner, list) else None)
        if remaining is None or len(remaining) == len(inner):
            kept.append(group)
        elif remaining:
            kept.append({**group, "hooks": remaining})
    return kept


def _merged_settings(value):
    """An inline settings JSON with Mesh hooks, or None when preservation wins."""
    settings = _settings_object(value) if value is not None else {}
    if settings is None:
        return None
    settings = copy.deepcopy(settings)
    hooks = settings.get("hooks")
    if hooks is None:
        hooks = {}
        settings["hooks"] = hooks
    if not isinstance(hooks, dict):
        return None
    helpers = _installed_helpers(hooks)
    for event, existing in list(hooks.items()):
        if isinstance(existing, list):
            hooks[event] = _without_event_hooks(existing, helpers)
            if existing and not hooks[event]:
                del hooks[event]
    for event, additions in _mesh_hooks()["hooks"].items():
        existing = hooks.get(event)
        existing = [] if existing is None else existing
        if not isinstance(existing, list):
            return None
        hooks[event] = existing + additions
    settings.setdefault("tui", "default")
    return json.dumps(settings, separators=(",", ":"), ensure_ascii=False)


def claude_args(args=()):
    """Mesh-owned Claude arguments plus one safe, per-session settings value.

    There is deliberately no write to a user, project, or global configuration
    file.  If the recorded command has one valid ``--settings`` it is read and
    merged, then emitted inline because Claude accepts only one setting layer.
    Unknown, malformed, and duplicate settings flags are retained untouched and
    receive no Mesh hook rather than changing what the user asked Claude to do.
    """
    args = list(args)
    found = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--settings" and i + 1 < len(args):
            found.append((i, i + 2, args[i + 1]))
            i += 2
        elif arg.startswith("--settings="):
            found.append((i, i + 1, arg.split("=", 1)[1]))
            i += 1
        else:
            i += 1
    if not found:
        return args + ["--settings", _merged_settings(None)]
    if len(found) != 1:
        return args
    start, end, value = found[0]
    merged = _merged_settings(value)
    if merged is None:
        return args
    return args[:start] + ["--settings", merged] + args[end:]


def codex_args(args=()):
    """Mesh-owned Codex terminal presentation arguments.

    Replace recorded raw-output settings, including Mesh's former forced-true
    default, with ordinary rich rendering. This avoids relying on the ordering
    of repeated CLI configuration values. The rebuilt process alone receives
    the override; users can still enable /raw interactively.
    """
    args = agentmcp.without_codex_config(args, [agentmcp.RAW_OUTPUT_KEY])
    if CODEX_INLINE not in args:
        args.append(CODEX_INLINE)
    return [*args, "-c", CODEX_STANDARD_OUTPUT]


# Public for the small number of command builders and their tests.  The value
# is deterministic for this checkout, unlike a shell fragment assembled later.
CLAUDE_INLINE = claude_args()

# agent -> option kinds, as each parser reads them (`claude --help`, `codex --help`). "value": takes
# the next word (also --opt=value, -Xvalue); "multi": every following non-option word; "optional": a
# value only when the next word is not an option (a kept one only attached, so a following prompt is
# never kept). "restrictive": options whose loss would widen what the agent may do (_refuse_weaker).
_CLAUDE = {
    "keep_multi": {"--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
                   "--mcp-config", "--betas", "--tools", "--plugin-dir"},
    "keep_value": {"--effort", "--agent", "--agents", "--name", "-n", "--debug-file", "--model", "--permission-mode",
                   "--append-system-prompt", "--system-prompt", "--settings", "--fallback-model",
                   "--setting-sources", "--autocompact", "--plugin-url", "--system-prompt-snapshot"},
    "keep_optional": {"--debug", "-d"},
    "keep_flag": {"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--verbose", "--chrome",
                  "--no-chrome", "--ide", "--strict-mcp-config", "--bare", "--ax-screen-reader", "--brief",
                  "--disable-slash-commands", "--restricted", "--exclude-dynamic-system-prompt-sections", "--safe-mode"},
    # Session pickers, worktree creation, print mode, cloud and background runs:
    # none of them describes the resumed interactive session.
    "drop_multi": {"--file"},
    "drop_value": {"--session-id", "--output-format", "--input-format", "--json-schema", "--max-budget-usd",
                   "--permission-prompts", "--permission-prompt-tool", "--environment",
                   "--remote-control-session-name-prefix", "--messaging-socket-path"},
    "drop_optional": {"--resume", "-r", "--teleport", "--from-pr", "--worktree", "-w", "--tmux", "--cloud",
                      "--remote-control", "--prompt-suggestions"},
    "drop_flag": {"--continue", "-c", "--fork-session", "--print", "-p", "--bg", "--background", "--desktop",
                  "--forward-subagent-text", "--include-hook-events", "--include-partial-messages",
                  "--replay-user-messages", "--no-session-persistence", "--help", "-h", "--version", "-v"},
    "restrictive": {"--permission-mode", "--disallowedTools", "--disallowed-tools", "--tools", "--settings",
                    "--setting-sources", "--strict-mcp-config", "--restricted", "--safe-mode", "--bare",
                    "--disable-slash-commands", "--system-prompt", "--append-system-prompt", "--agent", "--agents",
                    "--plugin-dir", "--plugin-url"},
}
_CODEX = {
    "keep_value": {"--model", "-m", "--config", "-c", "--profile", "-p", "--sandbox", "-s", "--ask-for-approval",
                   "-a", "--cd", "-C", "--add-dir", "--enable", "--disable", "--local-provider", "--remote",
                   "--remote-auth-token-env"},
    "keep_flag": {"--yolo", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--search", "--oss",
                  "--approve-for-me", "--no-daemon", "--strict-config", "--dangerously-bypass-hook-trust",
                  CODEX_INLINE},
    "drop_value": {"--image", "-i"},
    "drop_flag": {"--last", "--worktree"},          # a resume would create another worktree, like claude -w
    "restrictive": {"--sandbox", "-s", "--ask-for-approval", "-a", "--config", "-c", "--profile", "-p",
                    "--strict-config", "--disable", "--cd", "-C"},
}
# opencode 1.18 (`opencode --help`). Its server options (--port, --hostname, --mdns, --cors) are dropped: a
# resumed TUI must not bind the port of the one it replaces, and dropping them never widens what the agent
# may do. --pure (no external plugins) and --agent (a read-only agent such as plan) restrict, so a resume
# that cannot read them is refused; --auto is the user's explicit choice and is kept, as --yolo is for codex.
_OPENCODE = {
    "keep_value": {"--model", "-m", "--agent", "--log-level", "--replay-limit"},
    "keep_flag": {"--auto", "--pure", "--mini", "--no-replay", "--print-logs"},
    "drop_value": {"--session", "-s", "--prompt", "--port", "--hostname", "--mdns-domain"},
    "drop_multi": {"--cors"},
    "drop_flag": {"--continue", "-c", "--fork", "--mdns", "--help", "-h", "--version", "-v"},
    "restrictive": {"--pure", "--agent"},
}
# gemini 0.68 (`gemini --help`).  The sandbox, the policies, the approval mode and the tool and MCP
# allow-lists restrict what the agent may do: kept, and a resume that cannot read them is refused.
# --yolo is the user's explicit choice and is kept, as it is for codex.  A prompt, a worktree and the
# session pickers describe how a conversation was started, not the conversation, and are dropped.
_GEMINI = {
    "keep_value": {"--model", "-m", "--approval-mode"},
    "keep_multi": {"--policy", "--admin-policy", "--allowed-mcp-server-names", "--allowed-tools", "--extensions",
                   "-e", "--include-directories"},
    "keep_flag": {"--sandbox", "-s", "--yolo", "-y", "--skip-trust", "--screen-reader", "--debug", "-d"},
    "drop_value": {"--prompt", "-p", "--prompt-interactive", "-i", "--resume", "-r", "--session-id", "--session-file",
                   "--delete-session", "--output-format", "-o"},
    "drop_optional": {"--worktree", "-w"},
    "drop_flag": {"--acp", "--experimental-acp", "--list-extensions", "-l", "--list-models", "--list-sessions",
                  "--raw-output", "--accept-raw-output-risk", "--help", "-h", "--version", "-v"},
    "restrictive": {"--sandbox", "-s", "--approval-mode", "--policy", "--admin-policy", "--allowed-mcp-server-names",
                    "--allowed-tools", "--extensions", "-e"},
}
GEMINI_SUBCOMMANDS = {"mcp", "extensions", "extension", "skills", "skill", "hooks", "hook", "gemma", "models"}
# agy 1.5.9 (`agy --help`; Go flag parsing, so `-x` and `--x` are the same word, and `-x=v` is `--x=v`:
# _go_word rewrites every word of two or more letters behind one dash into the `--x` form before it is
# read, so `-sandbox` and `-mode=plan` are the restrictive options they are; Go has no attached value, so
# `-pfoo` is the flag `pfoo`, never `-p` with a value). Dropped: the conversation pickers, the print mode and its output options (not an interactive
# conversation), the initial prompt, the log file and the remote connection. --sandbox, --mode (plan),
# --agent and --settings (strict permissions) restrict, so they are kept and a resume that cannot read them
# is refused; --dangerously-skip-permissions is the user's explicit choice and is kept, as --yolo is for codex.
_AGY = {
    "keep_value": {"--model", "--effort", "--agent", "--mode", "--project", "--add-dir", "--settings"},
    "keep_flag": {"--dangerously-skip-permissions", "--sandbox", "--remote-agent", "--disable-slash-commands"},
    "drop_value": {"--conversation", "-i", "--prompt-interactive", "-p", "--print", "--prompt", "--print-timeout",
                   "--input-format", "--output-format", "--json-schema", "--log-file"},
    "drop_flag": {"-c", "--continue", "--new-project", "--remote-control", "-h", "--help"},
    "restrictive": {"--sandbox", "--mode", "--agent", "--settings"},
}
_SPEC = {"claude": _CLAUDE, "codex": _CODEX, "opencode": _OPENCODE, "gemini": _GEMINI, "agy": _AGY}
# vibe 3.1 (`vibe --help`).  -p/--prompt and the options that only exist in headless mode describe a one-shot
# run, never an interactive conversation.  --agent (ask is read-only-ish, a custom agent may restrict) and
# the tool lists restrict, so a resume that cannot read them is refused; --auto-approve/--yolo and
# --smart-approve are the user's explicit choice and are kept.  --trust and --worktree are dropped: the
# first only skipped a prompt and the second would create another worktree.  --add-dir is kept except the
# Mesh hooks directory, which a launch adds again (agentmcp.vibe_hooks_dir).
_VIBE = {
    "keep_value": {"--agent", "--enabled-tools", "--disabled-tools", "--add-dir"},
    "keep_flag": {"--auto-approve", "--yolo", "--smart-approve"},
    "drop_value": {"--workdir", "--model", "--output", "--max-turns", "--max-price", "--max-tokens",
                   "--time-limit", "--system-prompt-file", "--output-dir"},
    "drop_optional": {"--worktree", "--resume"},
    "drop_flag": {"--continue", "-c", "--setup", "--trust", "--check-upgrade", "--help", "-h", "--version", "-v"},
    "restrictive": {"--agent", "--enabled-tools", "--disabled-tools"},
}
# A first positional of vibe is the initial prompt or one of these subcommands; these options only
# exist for a one-shot (headless) run.
VIBE_SUBCOMMANDS = {"mcp", "config", "help", "update"}
_SPEC["vibe"] = _VIBE
VIBE_ONE_SHOT = {"-p", "--prompt", "--prompt-file"}
_VIBE_SHORT_FLAGS = "chv"       # -c, -h, -v: a cluster of them can precede -p (-cp)


def _vibe_one_shot(arg):
    """True for -p, --prompt, --prompt-file (with or without =value) and for -p stuck to its value
    (-phello) or to flags before it (-cp): argparse reads all of those as -p."""
    if arg.split("=", 1)[0] in VIBE_ONE_SHOT:
        return True
    if len(arg) < 3 or arg[0] != "-" or arg[1] == "-":
        return False
    for char in arg[1:]:
        if char == "p":
            return True
        if char not in _VIBE_SHORT_FLAGS:
            return False
    return False
# A first positional of opencode is a project path or one of these subcommands. `run` is a one-shot
# prompt, never an interactive conversation.
# 1.x and 2.x subcommands together (2.x adds service, pair, api, mini and reload).
OPENCODE_SUBCOMMANDS = {
    "completion", "acp", "mcp", "attach", "run", "debug", "providers", "auth", "agent", "upgrade", "uninstall",
    "serve", "web", "models", "stats", "export", "import", "github", "pr", "session", "plugin", "plug", "db",
    "service", "pair", "api", "mini", "reload"}


class OpenCode2Refused(ValueError):
    """The command has an option OpenCode 2 would not take as the saved command meant it."""


# opencode 2.3 (`opencode --help`) takes --standalone, --server, --auto, --continue/-c, --session/-s, --prompt
# and the global --log-level and --print-logs; it rejects any other option with its help text.  A command
# saved from 1.x may hold options 2.x no longer has: --model/-m, --mini, --replay-limit and --no-replay only
# tune the display or the model of that run and are dropped (the conversation keeps its own model);
# --pure and --agent restrict what the agent may do, --fork and --server change what is resumed or where
# the agent runs: the command is refused rather than started without them.
_OPENCODE2_FLAGS = {"--standalone", "--auto", "--continue", "-c", "--print-logs", "--help", "-h", "--version", "-v"}
_OPENCODE2_VALUES = {"--session", "-s", "--prompt", "--log-level"}
_OPENCODE2_DROPPED_FLAGS = {"--mini", "--no-replay"}
_OPENCODE2_DROPPED_VALUES = {"--model", "-m", "--replay-limit"}


def opencode2_command(words):
    """The argv words of an OpenCode launch rewritten for OpenCode 2: ``--standalone`` (a private server,
    not the shared background service) after the program name, and only the options 2.x takes.

    Raises OpenCode2Refused for an option that cannot be dropped without changing what the saved command
    meant or that 2.x does not know."""
    if not words or os.path.basename(words[0]) != "opencode":
        raise OpenCode2Refused("not an opencode command")
    out, i = [words[0], "--standalone"], 1
    while i < len(words):
        word = words[i]
        name, has_value = word.split("=", 1)[0], "=" in word
        if not word.startswith("-") or word == "-":
            out.append(word)                            # a project directory, or a subcommand
        elif name == "--standalone":
            pass                                        # already added
        elif name in _OPENCODE2_FLAGS and not has_value:
            out.append(word)
        elif name in _OPENCODE2_VALUES:
            out.append(word)
            if not has_value and i + 1 < len(words):
                i += 1
                out.append(words[i])
        elif name in _OPENCODE2_DROPPED_FLAGS or name in _OPENCODE2_DROPPED_VALUES:
            if name in _OPENCODE2_DROPPED_VALUES and not has_value:
                i += 1
        else:
            raise OpenCode2Refused(f"OpenCode 2 does not take the option {name}: launch refused "
                                   f"rather than started without it")
        i += 1
    return out


AGY_SUBCOMMANDS = {"acp", "agent", "agents", "changelog", "help", "install", "mcp", "mic-serve", "models",
                   "plugin", "plugins", "remote-control", "update"}


# copilot 1.0 (`copilot --help` of 1.0.86, the packaged one; the options of the 1.0.112 a launcher keeps in
# its cache, which could not be read here, stay from the earlier list: the union of both). `--remote*` (the
# remote control and export of a session) are dropped, never carried over to a resume; `--no-remote*` are kept
# and count as restrictive: a resume that dropped them would re-enable what the user turned off. `--resume=<id>` is how a conversation is reopened. The options that pick or
# start another session, a prompt, an output format or a share are dropped; the permission, tool, path and
# URL options are kept, and the ones that only restrict (--deny-tool, --available-tools, --disable-mcp-server,
# --secret-env-vars...) make a resume that cannot read them refused. --allow-all / --yolo are the user's
# explicit choice and are kept, as --yolo is for codex. Mesh's own --plugin-dir and --additional-mcp-config are
# removed first (agentmcp.without_copilot_mesh) and added again at launch (server._copilot_command).
_COPILOT = {
    "keep_value": {"--add-dir", "--add-github-mcp-tool", "--add-github-mcp-toolset", "--additional-mcp-config",
                   "--agent", "--auto-tier", "--context", "--disable-mcp-server", "--dynamic-retrieval",
                   "--enable-mcp-server", "--extension-sdk-path", "--log-dir", "--log-level", "--max-ai-credits",
                   "--max-autopilot-continues", "--mcp-github-auth", "--mode", "--model", "--plugin-dir",
                   "--reasoning-effort", "--stream", "-C"},
    "keep_multi": {"--allow-tool", "--deny-tool", "--allow-url", "--deny-url", "--available-tools",
                   "--excluded-tools", "--secret-env-vars"},
    "keep_optional": {"--mouse", "--bash-env", "--sync-session"},
    "keep_flag": {"--allow-all", "--yolo", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls",
                  "--allow-all-mcp-server-instructions", "--assisted-approval", "--autopilot", "--plan",
                  "--banner", "--disable-builtin-mcps", "--disable-client-telemetry", "--disallow-temp-dir",
                  "--enable-all-github-mcp-tools", "--enable-memory", "--experimental", "--no-experimental",
                  "--no-ask-user", "--no-auto-update", "--no-bash-env", "--no-color", "--no-custom-instructions",
                  "--no-mouse", "--no-remote", "--no-remote-export", "--no-eager-powershell-resolution",
                  "--plain-diff", "--screen-reader"},
    "drop_value": {"--session-id", "--name", "-n", "--prompt", "-p", "--interactive", "-i", "--output-format",
                   "--attachment", "--usage-output-file"},
    "drop_optional": {"--resume", "-r", "--connect", "--share"},
    "drop_flag": {"--continue", "--acp", "--fleet", "--share-gist", "--silent", "-s", "--trust-folder",
                  "--remote", "--remote-export", "--help", "-h", "--version", "-v"},
    "restrictive": {"--deny-tool", "--deny-url", "--available-tools", "--excluded-tools", "--disable-mcp-server",
                    "--disable-builtin-mcps", "--disallow-temp-dir", "--secret-env-vars", "--no-custom-instructions",
                    "--max-ai-credits", "--agent", "--plan", "--mode", "--no-remote",
                    "--no-remote-export"},
}
_SPEC["copilot"] = _COPILOT
# A first positional of copilot is a subcommand (`copilot --help`); none of them is an interactive conversation.
COPILOT_SUBCOMMANDS = {
    "app", "login", "help", "init", "config", "update", "version", "workflow", "sessions", "memories", "plugin",
    "mcp", "skill", "instruction", "lsp", "sandbox", "completion"}
# Print mode and the ACP server end after their work: nothing to resume.
COPILOT_ONE_SHOT = {"-p", "--prompt", "--acp"}


def _copilot_resume(args, sid):
    """argv that resumes conversation sid of a Copilot CLI started with args (the words after its entry)."""
    args = agentmcp.without_copilot_mesh(list(args))
    if any(word.split("=", 1)[0] in COPILOT_ONE_SHOT or (word.startswith("-p") and not word.startswith("--"))
           for word in args if word.startswith("-")):
        raise WeakerResume("the session was started with copilot -p or --acp, which is not interactive: "
                           "resume refused")
    kept = _kept_options("copilot", args)
    if kept is None:          # a subcommand
        _refuse_weaker("copilot", args, "subcommand")
        kept = []
    return ["copilot", f"--resume={sid}", *kept]


def _bare(kind, sid):
    if kind == "agy":
        return ["agy", "--conversation", sid]
    if kind == "copilot":
        return ["copilot", f"--resume={sid}"]
    if kind == "opencode":
        return ["opencode", "--session", sid]
    if kind == "gemini":
        return ["gemini", "--resume", sid]
    if kind == "vibe":
        return ["vibe", "--resume", sid]
    return (["claude", "--resume", sid, *claude_args()]
            if kind == "claude" else ["codex", "resume", sid, *codex_args()])


class WeakerResume(ValueError):
    """The saved command cannot be read far enough to keep a restrictive option."""


# One whole template per cause, so that the interface can translate each one.
_WEAKER = {
    "option": "the saved command has an option Mesh cannot read ({option}) and names {name}: "
              "resume refused rather than restarted without {name}",
    "subcommand": "the saved command has a codex subcommand and names {name}: "
                  "resume refused rather than restarted without {name}",
    "vibe_subcommand": "the saved command has a vibe subcommand and names {name}: "
                       "resume refused rather than restarted without {name}",
    "launcher": "the saved command has a launcher Mesh cannot read and names {name}: "
                "resume refused rather than restarted without {name}",
}


def _category(spec, name):
    return next((category for category, names in spec.items()
                 if category != "restrictive" and name in names), None)


def _go_word(word):
    """``-name`` and ``-name=v`` as agy's Go flag parser reads them: the word ``--name`` / ``--name=v``.

    A one-letter option (``-p``, ``-p=v``) keeps its form: it is already the word the table lists."""
    if word.startswith("-") and not word.startswith("--") and len(word.split("=", 1)[0]) >= 3:
        return "-" + word
    return word


def _short_option(kind, arg):
    """``(-X, rest)`` for a ``-Xrest`` word whose -X is a known short option.

    Both parsers read the rest of the word as -X's value when -X takes one;
    commander reads it as further flags when -X is a flag (``-pc``).  ``-X=v``
    is read as an option with a value instead."""
    if len(arg) < 3 or arg[0] != "-" or arg[1] == "-" or arg[2] == "=":
        return None
    return (arg[:2], arg[2:]) if _category(_SPEC[kind], arg[:2]) else None


def _restriction(kind, words):
    """The first restrictive option one of words names (--opt, --opt=value, -Xvalue), else None."""
    for word in words:
        word = _go_word(word) if kind == "agy" else word
        short = _short_option(kind, word)
        name = short[0] if short else word.split("=", 1)[0]
        if word.startswith("-") and name in _SPEC[kind]["restrictive"]:
            return name
    return None


def _refuse_weaker(kind, words, cause, option=None):
    """Refuse when a word Mesh did not read names a restrictive option: what follows an unknown
    option, or a wrapper's arguments, cannot be read with certainty, and resuming without that
    option would widen what the agent may do.  Codex configuration that restricts nothing (the
    items Mesh sets again itself, see agentmcp.without_free_codex_config) is not such an option."""
    name = _restriction(kind, agentmcp.without_free_codex_config(words) if kind == "codex" else words)
    if name:
        template = _WEAKER["vibe_subcommand" if kind == "vibe" and cause == "subcommand" else cause]
        raise WeakerResume(template.format(option=option, name=name))


# The words an option that takes an optional value (``--mouse off``) accepts as that value: any other word after
# it is a positional (a prompt), dropped as such, and the option stands alone.
OPTIONAL_SWITCH_VALUES = {"on", "off", "true", "false"}


def _read_option(category, args, i, has_value, strict):
    """``(words kept, next index)`` for the option of that category at args[i]."""
    takes_next = not has_value and i + 1 < len(args)
    if strict and category.endswith(("multi", "value")) and not has_value and (
            not takes_next or args[i + 1].startswith("-")):
        raise ValueError("missing saved option value")
    if strict and has_value and category.endswith("flag"):
        raise ValueError("ambiguous saved flag value")
    end = i + 1
    if category.endswith("multi"):
        while not has_value and end < len(args) and not args[end].startswith("-"):
            end += 1
    elif takes_next and (category.endswith("value")
                         or category == "drop_optional" and not args[i + 1].startswith("-")
                         or category == "keep_optional" and args[i + 1] in OPTIONAL_SWITCH_VALUES):
        end = i + 2
    if not category.startswith("keep") or (category == "keep_value" and not has_value and not takes_next):
        return [], end      # dropped, or a kept option left without its value
    return args[i:end], end


def _is_subcommand(kind, arg):
    """Whether ``arg``, the first positional of a saved ``kind`` command, names one of its subcommands (a
    non-interactive one, or ``resume`` for codex: a saved command that has one is not a plain session)."""
    subcommands = {"gemini": GEMINI_SUBCOMMANDS, "vibe": VIBE_SUBCOMMANDS, "opencode": OPENCODE_SUBCOMMANDS,
                   "copilot": COPILOT_SUBCOMMANDS, "codex": CODEX_SUBCOMMANDS, "agy": AGY_SUBCOMMANDS}
    return arg in subcommands.get(kind, ())


_ONE_SHOT_SUBCOMMANDS = {
    ("opencode", "run"): "the session was started with opencode run, which is not interactive: resume refused",
    ("codex", "exec"): "the session was started with codex exec, which is not interactive: resume refused",
    ("codex", "e"): "the session was started with codex exec, which is not interactive: resume refused",
}


def _refuse_one_shot(kind, arg):
    """A subcommand that runs one prompt and exits has no conversation to resume: refuse, say why."""
    message = _ONE_SHOT_SUBCOMMANDS.get((kind, arg))
    if message:
        raise WeakerResume(message)


def _negated_opencode_flag(kind, category, arg, short, following):
    """yargs reads ``--auto false`` as the flag turned off: dropping the word would resume with ``--auto`` on,
    which is more permissive than the saved command, so the flag and its word are kept together."""
    return (kind == "opencode" and category == "keep_flag" and "=" not in arg and not short
            and following in (["true"], ["false"]))


def _kept_options(kind, args, *, strict=False):
    """The options of args worth keeping, or None for a non-interactive codex
    subcommand. Reading stops at the first unknown option (see _refuse_weaker)."""
    spec, kept, i = _SPEC[kind], [], 0
    subcommand_seen = False
    if kind == "agy":
        args[:] = [_go_word(word) for word in args]
    while i < len(args):
        arg = args[i]
        if kind == "agy" and (arg == "--" or not arg.startswith("-") or arg == "-") \
                and not (not subcommand_seen and arg in AGY_SUBCOMMANDS):
            # Go's flag package stops at the first positional (or `--`): what follows is text for
            # agy, so an option there was never applied and must not be kept, but a restrictive one
            # still refuses (the reading is conservative, see _refuse_weaker)
            _refuse_weaker(kind, args[i + 1:], "option", "a word after the first positional")
            break
        if not arg.startswith("-") or arg == "-":
            # codex: the first positional may be the "resume" subcommand; any
            # other subcommand (exec, fork…) is not an interactive session
            if not subcommand_seen and _is_subcommand(kind, arg):
                _refuse_one_shot(kind, arg)
                if strict:
                    raise ValueError("non-interactive saved command")
                return None
            subcommand_seen = subcommand_seen or arg == "resume"
            i += 1          # a positional: a prompt or a session id, dropped
            continue
        if kind == "vibe" and _vibe_one_shot(arg):
            raise WeakerResume("the session was started with vibe --prompt, which is not interactive: "
                               "resume refused")
        short = _short_option(kind, arg)
        category = _category(spec, short[0] if short else arg.split("=", 1)[0])
        if short and category.endswith("flag"):
            args[i:i + 1] = [short[0], "-" + short[1]]
            continue
        if category is None:
            if strict:
                raise ValueError("unknown saved option")
            _refuse_weaker(kind, args[i + 1:], "option", arg.split("=", 1)[0])
            break           # unknown option: its arity (and what follows) cannot be read
        if _negated_opencode_flag(kind, category, arg, short, args[i + 1:i + 2]):
            kept += args[i:i + 2]
            i += 2
            continue
        words, i = _read_option(category, args, i, bool(short) or "=" in arg, strict)
        kept += words
    return kept


def _shell_words(text):
    try:
        return shlex.split(text)
    except ValueError:
        raise WeakerResume("the saved command is a shell string Mesh cannot parse: resume refused") from None


def _launcher_words(argv):
    """``(words, split)``: the words a launcher Mesh cannot read hands the agent, and the shell
    string already split into them.  A shell run with -c (``-lc``…) carries a command in one
    string: split it like the shell, so a quoted prompt stays one word."""
    at = shell_command_index(argv)
    return (argv[1:], None) if at is None else (_shell_words(argv[at]) + argv[at + 1:], argv[at])


def _refuse_unread_launcher(kind, argv):
    """The bare fallback.  Shell forms _launcher_words does not read (``bash --login -c '…'``,
    ``env bash -c '…'``) hide a command in one word: scan those too.  Accepted limit: a script
    wrapper (``sh /path/script``) may add restrictions internally and cannot be inspected; the
    bare resume runs the agent from PATH without them."""
    words, split = _launcher_words(argv)
    words += [w for word in argv[1:] if word is not split and len(word.split()) > 1 for w in _shell_words(word)]
    _refuse_weaker(kind, words, "launcher")


def _without_mesh_hooks(kept):
    """Kept vibe options without ``--add-dir <Mesh hooks directory>`` (``mesh-vibe-hooks/<launch>``, or the
    shared ``mesh-vibe-hooks`` of an older layout): the relaunch adds a new one."""
    words, i = [], 0
    while i < len(kept):
        value = kept[i + 1] if kept[i] == "--add-dir" and i + 1 < len(kept) else kept[i].partition("=")[2]
        parts = Path(value.rstrip("/")).parts[-2:]
        if kept[i].startswith("--add-dir") and agentmcp.VIBE_HOOKS_DIRNAME in parts:
            i += 2 if kept[i] == "--add-dir" else 1
            continue
        words.append(kept[i])
        i += 1
    return words


def resume_argv(kind, argv, sid):
    """argv that resumes conversation sid of a `kind` agent ("claude" or
    "codex") started with argv. Never carries the original prompt."""
    args = entry_args(kind, argv)
    if args is None:
        _refuse_unread_launcher(kind, argv)
        return _bare(kind, sid)
    if kind == "copilot":
        return _copilot_resume(args, sid)
    kept = _kept_options(kind, list(args))
    if kept is None:          # a non-interactive codex subcommand
        _refuse_weaker(kind, args, "subcommand")
        return _bare(kind, sid)
    if kind == "claude":
        return ["claude", "--resume", sid, *claude_args(kept)]
    if kind == "opencode":
        return ["opencode", "--session", sid, *kept]
    if kind == "gemini":
        return ["gemini", "--resume", sid, *kept]
    if kind == "agy":
        return ["agy", "--conversation", sid, *kept]
    if kind == "vibe":
        return ["vibe", "--resume", sid, *_without_mesh_hooks(kept)]
    return ["codex", "resume", sid, *codex_args(kept)]


def resumed_codex_id(argv):
    """The conversation a Codex started as ``codex [options] resume <id> ...`` names, or None.  The options
    before ``resume`` are read with the codex table, so a value (``-c resume``) is never the subcommand; an
    unknown option, another subcommand, a prompt, or a word after ``resume`` that is not a thread id
    (``--last``, ``--all``, an option, nothing) names none.  Anything after the id is not read."""
    args = entry_args("codex", list(argv))
    i = 0
    while args is not None and i < len(args):
        arg = args[i]
        if arg == "resume":
            following = args[i + 1] if i + 1 < len(args) else ""
            return following if THREAD_RE.fullmatch(following) else None
        if not arg.startswith("-") or arg in ("-", "--"):
            return None
        short = _short_option("codex", arg)
        category = _category(_CODEX, short[0] if short else arg.split("=", 1)[0])
        if category is None:
            return None
        attached = bool(short) or "=" in arg
        i += 2 if category.endswith("value") and not attached else 1
    return None


def build_resume_profile(kind, saved_argv, conversation_id):
    """Normalize sensitive runner-local resume data for a held named preset.

    This does not authorize a launch or select an executable/CWD. The native
    startup configuration supplies those separately. Reuse the existing resume
    policy so prompts and recorded wrappers are never replayed and restrictive
    known options are not silently dropped.
    """
    if kind not in ("claude", "codex") or not isinstance(conversation_id, str):
        raise ValueError("closed resume profile")
    try:
        parsed = uuid.UUID(conversation_id)
    except (ValueError, AttributeError) as exc:
        raise ValueError("canonical conversation ID") from exc
    if str(parsed) != conversation_id or parsed.int == 0:
        raise ValueError("canonical conversation ID")
    if (not isinstance(saved_argv, (list, tuple)) or len(saved_argv) > 256
            or any(not isinstance(arg, str) or "\0" in arg or len(arg.encode("utf-8")) > 16384
                   for arg in saved_argv)):
        raise ValueError("bounded saved arguments")
    args = entry_args(kind, saved_argv)
    if args is None:
        raise ValueError("ambiguous saved entry point")
    # Remote provisioning must account for the complete option stream: the
    # historical local fallback may truncate unknown arity or an unknown wrapper
    # and consequently lose later restrictions. Keep that local compatibility,
    # but never turn its incomplete interpretation into an admitted preset.
    _kept_options(kind, list(args), strict=True)
    arguments = resume_argv(kind, list(saved_argv), conversation_id)[1:]
    profile = {"version": 1, "kind": kind, "conversationId": conversation_id,
               "arguments": arguments}
    encoded = json.dumps(profile, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(arguments) > 256 or len(encoded) > 1048576:
        raise ValueError("bounded resume profile")
    return {**profile, "fingerprint": hashlib.sha256(encoded).hexdigest()}


def build_resume_snapshot(launchers, saved_descriptors):
    """Build a sensitive startup-only native snapshot from local descriptors.

    Launchers come from runner-owned startup configuration, never from saved
    argv or a client. This pure builder neither writes files nor grants launch
    authority; the native loader separately checks admitted bytes, custody,
    executable hashes and held CWDs. Source is canonical Mesh_wire metadata
    supplied by the local inventory producer and revalidated by that loader.
    """
    if (not isinstance(launchers, dict) or set(launchers) - {"claude", "codex"}
            or not isinstance(saved_descriptors, (list, tuple)) or len(saved_descriptors) > 200):
        raise ValueError("closed startup snapshot")
    entries = []
    receipts = set()
    for descriptor in saved_descriptors:
        if not isinstance(descriptor, dict) or set(descriptor) != {
            "source", "receipt", "cwd", "kind", "conversationId", "savedArgv"
        }:
            raise ValueError("closed saved descriptor")
        source, receipt, cwd = (descriptor[key] for key in ("source", "receipt", "cwd"))
        if (not isinstance(source, str) or len(source.encode("utf-8")) > 2048 or "\0" in source
                or not isinstance(receipt, str)
                or re.fullmatch(r"[0-9a-f]{64}:[0-7][0-9a-f]{15}", receipt) is None
                or receipt[-16:] == "0" * 16 or receipt in receipts
                or not isinstance(cwd, str) or not cwd.startswith("/")
                or len(cwd.encode("utf-8")) > 4096 or "\0" in cwd):
            raise ValueError("bounded local source")
        kind = descriptor["kind"]
        profile = build_resume_profile(kind, descriptor["savedArgv"], descriptor["conversationId"])
        if kind not in launchers:
            raise ValueError("unconfigured agent")
        receipts.add(receipt)
        entries.append({"source": source, "receipt": receipt, "cwd": cwd, "profile": profile})
    # No mutable aliases to caller configuration after producing the snapshot.
    snapshot = {"version": 1, "launchers": copy.deepcopy(launchers), "presets": entries}
    if len(json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > 4194304:
        raise ValueError("bounded startup snapshot")
    return snapshot
