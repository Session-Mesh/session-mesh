# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Per-invocation MCP configuration for agents started by Session Mesh.

The board bridge receives its session identity only through the environment
minted by :func:`server.new_session`.  In particular, neither a board name nor
a MeshSession credential is ever put in an argv/configuration value, where a
process listing or an agent transcript could disclose it.
"""

import json
import errno
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path
from typing import NamedTuple


# Binary distributions supply MESH_BIN_DIR; source builds install the public
# executable through scripts/bootstrap.sh into an opam switch as a fallback.
# Launch it directly rather than asking each MCP client to find ``opam`` and to
# reconstruct a switch context.  Claude/Codex both start stdio servers with a
# deliberately reduced environment, so an absolute executable is materially
# more reliable.  No source-tree ``_build`` path is a runtime contract.
#
# One convention with the bootstrap: MESH_OPAM_SWITCH names the switch (an opam
# switch name, or an absolute directory).  Its bin directory is the one
# ``opam var --switch=... bin`` gives: <OPAMROOT>/<name>/bin for a named switch,
# <directory>/_opam/bin for a local switch.  An absolute directory that is itself
# the prefix of a named switch (it has bin/ and no _opam/, such as
# ~/.opam/<name>) resolves to <directory>/bin.  Unset, the switch of the current
# opam environment (OPAM_SWITCH_PREFIX) is used, and otherwise a local switch in
# this checkout.
def switch_bin(environ=os.environ):
    switch = environ.get("MESH_OPAM_SWITCH")
    if not switch:
        prefix = environ.get("OPAM_SWITCH_PREFIX")
        return Path(prefix) / "bin" if prefix else Path(__file__).resolve().parent / "_opam" / "bin"
    if os.path.isabs(switch):
        directory = Path(switch).resolve()
        if not (directory / "_opam").exists() and (directory / "bin").is_dir():
            return directory / "bin"
        return directory / "_opam" / "bin"
    return Path(environ.get("OPAMROOT") or Path.home() / ".opam") / switch / "bin"


def runtime_bin(environ=os.environ):
    """Installation-owned helpers, never a PATH search in an agent's workspace.

    Binary distributions set MESH_BIN_DIR before importing the server. Keeping
    an explicit directory authoritative makes a broken installation visible
    rather than silently running a different development copy of the bridge.

    Symbolic links are kept, not resolved: in a release install the directory is
    current/bin, and the MCP command and event hook given to a long-running agent
    must follow current to the installed release, not name a release that a later
    upgrade deletes.
    """
    configured = environ.get("MESH_BIN_DIR")
    if configured:
        if not os.path.isabs(configured):
            raise ValueError("MESH_BIN_DIR must be an absolute directory")
        return Path(os.path.normpath(configured))
    return Path(os.path.abspath(__file__)).parent / "bin"


def mesh_executable(name, environ=os.environ):
    bundled = runtime_bin(environ) / name
    if environ.get("MESH_BIN_DIR") or bundled.is_file():
        return bundled
    return switch_bin(environ) / name


def board_executable(environ=os.environ):
    return mesh_executable("mesh-board-mcp", environ)


SWITCH_BIN = str(switch_bin())  # Development fallback, not the distribution layout.
BOARD_MCP = str(board_executable())
BOARD_MCP_ARGS = []
SERVER_NAME = "mesh-board"
# Codex deliberately filters the process environment of stdio MCP servers.
# This is an allow-list of *names*, never token values.
CODEX_ENV_VARS = ["MESH_SESSION_TOKEN", "MESH_PORT", "MESH_RUNNER_DEMO_CAP"]
# The project tracker (docs/work-mcp.md), found like the board.  Its entry names the agent kind (WL_AGENT);
# the session name (MESH_SESSION) and a WL_HOME the user set come from the agent's environment.
WORK_MCP = str(mesh_executable("work-mcp"))
WORK_SERVER_NAME = "mesh-work"
NOTES_SERVER_NAME = "mesh-notes"
WORK_ENV_VARS = ["MESH_SESSION", "WL_HOME"]
# Reserved names.  Whatever a command, a snapshot or a user's configuration defines under one of them, the
# definition (command, arguments, environment) is Mesh's, and the user's restrictions on it (server turned
# off, tools disabled, approvals required) are kept.  The recognisers and the removal on resume use this list.
MESH_SERVER_NAMES = (SERVER_NAME, WORK_SERVER_NAME, NOTES_SERVER_NAME)

# The agent hook model (docs/agent-hooks.md): which native hook of each agent every Mesh consumer is
# installed on, its timeout, and the project context hook's program, arguments and switch come from this
# one table; each generator below only shapes them.
AGENT_HOOKS = json.loads((Path(__file__).resolve().parent / "agent-hooks.json").read_text(encoding="utf-8"))
PROJECT_CONTEXT = next(c for c in AGENT_HOOKS["consumers"] if c["name"] == "project_context")
PROJECT_HOOKS_ENV = PROJECT_CONTEXT["switch"]


def hook_source(agent):
    return next(row for row in AGENT_HOOKS["sources"] if row["agent"] == agent)


def hook_entries(agent, consumer):
    """The table entries (event, native, label) of ``agent`` that ``consumer`` is installed on, in order."""
    row = hook_source(agent)
    return tuple(next(e for e in row["events"] if e["event"] == event) for event in row["subscriptions"].get(consumer, ()))


def hook_events(agent, consumer):
    return tuple(entry["native"] for entry in hook_entries(agent, consumer))


def hook_timeout(agent):
    return hook_source(agent)["timeout"]["value"]


def project_context_hooks(agent, environ=os.environ):
    """``((native event, argv), ...)`` of the read-only project context hook of ``agent``: none when the
    switch is off (MESH_PROJECT_HOOKS=0), when work-read is not installed, or for an agent not wired."""
    if environ.get(PROJECT_HOOKS_ENV, "1").strip().lower() in ("0", "off", "false", "no"):
        return ()
    reader = mesh_executable(PROJECT_CONTEXT["program"], environ)
    if not _is_executable(reader):
        return ()
    row = hook_source(agent)
    return tuple((entry["native"], [str(reader), *PROJECT_CONTEXT["args"], row["inject"][entry["event"]]])
                 for entry in hook_entries(agent, "project_context"))


_missing_board_reported = False


def _is_executable(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def board_available():
    """True when the board bridge is installed. It comes from the optional OCaml build:
    without it, an injected entry would only be an MCP server failing at every launch.

    A configured bundle or development switch expects the bridge: its absence
    is reported once on stderr instead of silently disabling the board."""
    global _missing_board_reported
    available = _is_executable(BOARD_MCP)
    setting = "MESH_BIN_DIR" if os.environ.get("MESH_BIN_DIR") else "MESH_OPAM_SWITCH"
    if not available and os.environ.get(setting) and not _missing_board_reported:
        _missing_board_reported = True
        print(f"agentmcp: {setting}={os.environ[setting]} but no executable "
              f"{BOARD_MCP}: agent sessions start without the {SERVER_NAME} MCP server",
              file=sys.stderr, flush=True)
    return available


def work_available():
    return _is_executable(WORK_MCP)


class MeshServer(NamedTuple):
    """One stdio MCP server Mesh adds to an agent it launches (see mesh_servers).

    ``env`` holds literal values only, never a credential or the session's name.  The server reads
    ``env_names`` from the agent's environment (Codex's allow-list).  ``identity_env``, a part of them,
    carries the session's identity or data place: a client that filters its servers' environment
    receives these names as a reference (Gemini) or a launch-time expansion (Vibe), never as values."""
    name: str
    command: str
    args: list
    env: dict
    env_names: list
    identity_env: list


def mesh_servers(kind, reach=None, bridge=None):
    """The servers Mesh injects into an agent of ``kind``, in order.  Each agent adapter only shapes them.

    One rule for every agent: no server without the board bridge (``bridge``, by default the installed
    one), and the tracker beside the board when work-mcp is installed.  ``reach`` (MESH_PORT, MESH_CONF_DIR,
    never a credential) goes in the board's own environment block when the caller gives it."""
    installed = board_available() if bridge is None else _is_executable(bridge)
    return _with_board(kind, reach, bridge) if installed else []


def _with_board(kind, reach=None, bridge=None):
    """mesh_servers once the board bridge is known to be installed."""
    servers = [MeshServer(SERVER_NAME, BOARD_MCP if bridge is None else bridge, list(BOARD_MCP_ARGS),
                          dict(reach or {}), CODEX_ENV_VARS, ["MESH_SESSION_TOKEN"])]
    # Adapter opt-in is not a Notes grant. The server independently checks its
    # private per-incarnation grants; no board wildcard approval covers this name.
    if os.environ.get("MESH_NOTES_ADAPTER") == "1":
        servers.append(MeshServer(NOTES_SERVER_NAME, BOARD_MCP if bridge is None else bridge, ["--notes"],
                                  dict(reach or {}), CODEX_ENV_VARS, ["MESH_SESSION_TOKEN"]))
    if work_available():
        servers.append(MeshServer(WORK_SERVER_NAME, WORK_MCP, [], {"WL_AGENT": kind}, WORK_ENV_VARS, WORK_ENV_VARS))
    return servers


def _stdio_entry(server):
    """The common ``command``/``args``/``env`` shape (Claude, Copilot, agy, Pi); an empty ``env`` is left out."""
    return {"command": server.command, "args": server.args, **({"env": server.env} if server.env else {})}


def _claude_config(servers=None):
    """Claude's --mcp-config value: ``servers``, by default those of an installation with the board."""
    servers = _with_board("claude") if servers is None else servers
    return (json.dumps({"mcpServers": {server.name: _stdio_entry(server) for server in servers}},
                       separators=(",", ":")) if servers else None)


# OpenCode reads an inline JSON configuration from OPENCODE_CONFIG_CONTENT and merges it
# over the user's and the project's (objects key by key, "plugin" lists concatenated).  The
# board server therefore needs neither a file nor any change to the user's configuration, and
# only what this block sets is overridden: a user's ``enabled: false`` on the board, their
# ``permission`` rules (for instance ``"mesh-board_*": "ask"``) and their other MCP servers stay.
# The stdio server inherits MESH_SESSION_TOKEN from the pty (OpenCode passes its own
# environment on), so no credential is written into the configuration.
OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"
OPENCODE_PLUGIN = Path(__file__).resolve().parent / "opencode-mesh-plugin.ts"


# OpenCode 1.x and 2.x are supported (2.3.0 tested), any other major is launched bare: no injection, no
# session token in the agent (opencode_supported_major returns None), with a notice.  OpenCode 2 (package
# @opencode/cli, same ``opencode`` command) runs through one background service that is not bound to HOME
# unless it is started with ``--standalone``; Mesh always starts it that way (server._opencode_command), so
# the injected configuration and MESH_SESSION_TOKEN are those of the terminal's own process.  Its plugin
# format, configuration shape (``mcp.servers``, ``plugins``) and events differ from 1.x's: see
# opencode_config_v2 and opencode-mesh-plugin-v2/.
OPENCODE_UNSUPPORTED_NOTICE = "opencode-unsupported"      # a major other than 1 and 2
OPENCODE_UNREADABLE_NOTICE = "opencode-unreadable"        # not found, or its version cannot be read
OPENCODE_PLUGIN_V2 = Path(__file__).resolve().parent / "opencode-mesh-plugin-v2"
OPENCODE_SUPPORTED_MAJORS = (1, 2)
_OPENCODE_VERSION = re.compile(r"(?:opencode\s+)?v?(\d+)\.\d+\.\d+[0-9A-Za-z.+-]*")
_OPENCODE_VERSION_TIMEOUT = 5
_OPENCODE_CONFIG_TIMEOUT = 15
_opencode_major_cache = {}      # (real path, size, mtime_ns) -> major version, only for readable outputs


# Where OpenCode's installers put the binary that the session's shell will find: the PTY host puts
# ~/.local/bin first, and OpenCode's own installer puts it in ~/.opencode/bin and adds that directory to the
# PATH of the user's shell startup files, which the session's interactive shell reads.  The probed binary must
# be the one the shell will launch, so both are searched before the PATH of the web server, which (under a
# systemd unit) is shorter than the shell's and is the remaining limit: an OpenCode that only a PATH set
# elsewhere finds is not probed and is launched bare, with a notice.
_OPENCODE_USER_BIN_DIRS = (".local/bin", ".opencode/bin")


def _opencode_executable(environ=os.environ):
    home = Path.home()
    search = os.pathsep.join([*(str(home / sub) for sub in _OPENCODE_USER_BIN_DIRS),
                              environ.get("PATH", "/usr/bin:/bin")])
    return shutil.which("opencode", path=search)


def _read_opencode_major(executable, environ):
    try:
        real = os.path.realpath(executable)
        info = os.stat(real)
        key = (real, info.st_size, info.st_mtime_ns)
    except OSError:
        return None
    if key in _opencode_major_cache:
        return _opencode_major_cache[key]
    probe_env = {"PATH": environ.get("PATH", "/usr/bin:/bin"), "HOME": environ.get("HOME", str(Path.home())),
                 "OPENCODE_DISABLE_AUTOUPDATE": "1"}
    try:
        result = subprocess.run([executable, "--version"], stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=_OPENCODE_VERSION_TIMEOUT, check=True, cwd="/", env=probe_env)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        return None
    match = _OPENCODE_VERSION.fullmatch(result.stdout.strip())
    if not match:
        return None
    _opencode_major_cache[key] = int(match.group(1))
    return _opencode_major_cache[key]


def opencode_resolved(environ=os.environ):
    """(executable, major) of the ``opencode`` Mesh resolves: the executable is None when none is found on
    ``~/.local/bin`` and the server's PATH, the major None when ``--version`` cannot be read.

    Reads ``opencode --version`` with stdin closed, from a neutral folder, under a short timeout and a
    minimal environment (no Mesh variable, so no credential).  Cached by real path, size and mtime.  The
    launch line names this very executable (server._opencode_command), so the version read is the one of the
    binary that runs, whatever the PATH of the terminal's shell holds."""
    executable = _opencode_executable(environ)
    return executable, (_read_opencode_major(executable, environ) if executable else None)


def opencode_major(environ=os.environ):
    """The major version of the resolved ``opencode``, or None when it is not found or cannot be read."""
    return opencode_resolved(environ)[1]


def opencode_supported_major(environ=os.environ):
    """1 or 2 when the resolved ``opencode`` reports that major version, else None
    (unreadable, or a major Mesh has not been tested with)."""
    major = opencode_major(environ)
    return major if major in OPENCODE_SUPPORTED_MAJORS else None


def opencode_config(plugin=OPENCODE_PLUGIN, reach=None):
    """The inline OpenCode configuration that adds the board server and the Mesh event plugin.

    ``reach`` (the mesh's MESH_PORT and MESH_CONF_DIR, never a credential) is set in the server's
    own environment block: a project's opencode.json merges below this one, so it cannot point the
    bridge, which sends the session token, at another local port."""
    config = {}
    if servers := _opencode_servers(reach):     # without the bridge an entry would only fail at every launch
        config["mcp"] = servers
    if Path(plugin).is_file():
        config["plugin"] = [Path(plugin).as_uri()]
    return json.dumps(config, separators=(",", ":"))


def _opencode_servers(reach, disabled=()):
    """The OpenCode (1 and 2) shape of mesh_servers, without the ``disabled`` names."""
    return {server.name: {"type": "local", "command": [server.command, *server.args],
                          **({"environment": server.env} if server.env else {})}
            for server in mesh_servers("opencode", reach) if server.name not in disabled}


def _opencode_config_sources(executable, cwd, environ):
    """The configuration documents OpenCode 2 reads for ``cwd``, in precedence order (``debug config``
    lists them normalised: ``mcp.servers``, ``disabled``, ``permissions``), or None when it cannot say.

    ``--standalone`` keeps the probe out of the shared background service.  The environment holds the
    locations OpenCode reads (HOME, XDG_*, OPENCODE_*) and no Mesh variable, so no credential."""
    probe_env = {"PATH": environ.get("PATH", "/usr/bin:/bin"), "HOME": environ.get("HOME", str(Path.home())),
                 "OPENCODE_DISABLE_AUTOUPDATE": "1"}
    probe_env.update({name: value for name, value in environ.items()
                      if name.startswith(("XDG_", "OPENCODE_")) and name != "OPENCODE_DISABLE_AUTOUPDATE"})
    try:
        result = subprocess.run([executable, "debug", "config", "--standalone"], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=_OPENCODE_CONFIG_TIMEOUT, check=True,
                                cwd=cwd, env=probe_env)
        sources = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError, ValueError):
        return None
    return sources if isinstance(sources, list) else None


def opencode_user_disabled_servers(cwd, environ=os.environ):
    """Which of MESH_SERVER_NAMES the user's own OpenCode 2 configuration (global, project, inline) turns off.

    OpenCode 2 replaces a server's whole object with the injected one, so a ``disabled: true`` (v1:
    ``enabled: false``) the user set on a Mesh server would be lost: Mesh reads the documents and does not
    inject a server when any of them disables it (the stricter choice wins, whatever the precedence).
    None when the configuration cannot be read; the caller then injects no server either."""
    executable = _opencode_executable(environ)
    sources = _opencode_config_sources(executable, cwd, environ) if executable else None
    if sources is None:
        return None
    disabled = set()
    for source in sources:
        info = source.get("info") if isinstance(source, dict) else None
        mcp = info.get("mcp") if isinstance(info, dict) else None
        servers = mcp.get("servers") if isinstance(mcp, dict) else None
        for name in MESH_SERVER_NAMES:
            entry = servers.get(name) if isinstance(servers, dict) else None
            if isinstance(entry, dict) and entry.get("disabled") is True:
                disabled.add(name)
    return disabled


def opencode_config_v2(plugin=OPENCODE_PLUGIN_V2, reach=None, disabled=()):
    """The inline OpenCode 2 configuration that adds the Mesh servers and the Mesh event plugin.

    Same rules as opencode_config, in the v2 shape: ``mcp.servers`` and ``plugins`` (a list of
    ``{"package": <folder>}``, concatenated with the user's).  The inline document has the highest
    precedence, so a project's opencode.json cannot point the bridge, which inherits the session token,
    at another command.  ``disabled`` names the servers the user turned off, or all of them when the
    configuration could not be read (see opencode_user_disabled_servers): those are not injected."""
    config = {}
    if servers := _opencode_servers(reach, disabled):
        config["mcp"] = {"servers": servers}
    if (Path(plugin) / "index.ts").is_file():
        config["plugins"] = [{"package": str(plugin)}]
    return json.dumps(config, separators=(",", ":"))


# Gemini CLI has no per-invocation configuration flag, and its system settings file must be owned by
# root.  Its settings are read from $GEMINI_CLI_HOME/.gemini/settings.json: Mesh points that variable at
# a private directory (under the mesh configuration directory) whose .gemini holds the user's own
# settings plus the board server and the state hooks, and links the user's other entries (credentials,
# GEMINI.md, extensions, policies, commands...) so that nothing of ~/.gemini is read from a copy.  A linked
# entry is the user's own file: what Gemini writes through it (an "Allow always" in
# policies/auto-saved.toml, an extension, a command, GEMINI.md through /memory) lands in ~/.gemini.
# The trusted folders are not linked: GEMINI_CLI_TRUSTED_FOLDERS_PATH (read by Gemini's Storage) names the
# user's real file, so a decision or a revocation made in any Gemini applies at once, whatever way Gemini
# rewrites the file (it replaces it atomically, which would turn a link into an ordinary copy).  The
# conversations (tmp), the checkpoint store (history) and the project and state files stay private to the
# overlay.  A restriction the user set (mcp.excluded, mcp.allowed, hooksConfig.enabled, tools.exclude...)
# is copied as it is and stays in force.  The server receives the session token through a
# ``$MESH_SESSION_TOKEN`` reference (Gemini drops token-like names from an MCP server's environment unless
# it is listed), never as a value.  The overlay's settings.json is rewritten at every launch, so a setting
# changed inside a Mesh-started Gemini is lost at the next one.
GEMINI_HOME_ENV = "GEMINI_CLI_HOME"
GEMINI_TRUST_ENV = "GEMINI_CLI_TRUSTED_FOLDERS_PATH"
GEMINI_SETTINGS_MAX_BYTES = 1024 * 1024
_GEMINI_PRIVATE = {"settings.json", "tmp", "history", "projects.json", "state.json"}
_GEMINI_REDIRECTED = {"trustedFolders.json"}
_GEMINI_HOOK_EVENTS = hook_events("gemini", "state")
# Gemini runs a hook through a shell and denies the prompt or the tool when the command fails with output:
# a hook must never become a dependency of the agent (see bin/mesh-event), so the command always succeeds
# silently, whatever happens to mesh-event (moved, python3 not on Gemini's PATH, a sandbox...).
_GEMINI_HOOK_TAIL = " >/dev/null 2>&1 || true"
_GEMINI_HOOK_SUFFIXES = ("/mesh-event gemini", "/mesh-event' gemini")


def _gemini_hook_command():
    return f"{shlex.quote(str(runtime_bin() / 'mesh-event'))} gemini{_GEMINI_HOOK_TAIL}"


def _is_mesh_gemini_hook(hook):
    command = hook.get("command") if isinstance(hook, dict) else None
    if not isinstance(command, str):
        return False
    return command.removesuffix(_GEMINI_HOOK_TAIL).endswith(_GEMINI_HOOK_SUFFIXES)


def gemini_trusted_folders(environ=os.environ):
    """The user's real trusted-folders file, which every Mesh-started Gemini reads and writes."""
    named = environ.get(GEMINI_TRUST_ENV)
    if named:
        return Path(named)
    return Path(environ.get(GEMINI_HOME_ENV) or Path.home()) / ".gemini" / "trustedFolders.json"


def _read_gemini_settings(settings_file):
    """The user's settings as a dict.  Absent: {}.  Anything else that cannot be read faithfully (a dangling
    link, a FIFO or a directory, too large, not strict JSON) is refused: launching without the user's
    restrictions would be worse than not launching."""
    # Opened without blocking, then judged on the descriptor itself: a FIFO put in place between a stat and an
    # open would otherwise block this thread until something writes to it.
    try:
        descriptor = os.open(settings_file, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        if settings_file.is_symlink():
            raise ValueError("settings.json is a link to nothing") from None
        return {}
    except OSError as exc:
        raise ValueError("settings.json could not be read") from exc
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("settings.json is not a regular file")
        if info.st_size > GEMINI_SETTINGS_MAX_BYTES:
            raise ValueError(f"settings.json is larger than {GEMINI_SETTINGS_MAX_BYTES} bytes")
        try:
            raw = source.read(GEMINI_SETTINGS_MAX_BYTES + 1)
        except OSError as exc:
            raise ValueError(f"settings.json could not be read as JSON ({exc})") from exc
    try:
        if len(raw) > GEMINI_SETTINGS_MAX_BYTES:
            raise ValueError(f"settings.json is larger than {GEMINI_SETTINGS_MAX_BYTES} bytes")
        user = json.loads(raw.decode("utf-8"), parse_constant=_refuse_constant)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"settings.json could not be read as JSON ({exc})") from exc
    if not isinstance(user, dict):
        raise ValueError("settings.json is not an object")
    return user


def _refuse_constant(name):
    raise ValueError(f"{name} is not JSON")


def gemini_settings(user, reach=None):
    """The user's settings (a dict) with the Mesh servers and the state hooks added.  A server's
    identity_env is written as ``$NAME`` references, which Gemini resolves from its own environment."""
    settings = json.loads(json.dumps(user))
    if mesh := mesh_servers("gemini", reach):
        servers = settings.setdefault("mcpServers", {})
        if not isinstance(servers, dict):
            raise ValueError("Gemini settings: mcpServers is not an object")
        for server in mesh:
            servers[server.name] = {"command": server.command, "args": server.args,
                                    "env": {**{name: f"${name}" for name in server.identity_env}, **server.env}}
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Gemini settings: hooks is not an object")
    for event in _GEMINI_HOOK_EVENTS:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise ValueError("Gemini settings: a hook event is not a list")
        kept = []
        for group in groups:      # a stale Mesh hook (another install) is replaced, the user's stay
            inner = group.get("hooks") if isinstance(group, dict) else None
            if isinstance(inner, list) and any(_is_mesh_gemini_hook(h) for h in inner):
                inner = [h for h in inner if not _is_mesh_gemini_hook(h)]
                if inner:
                    kept.append({**group, "hooks": inner})
            else:
                kept.append(group)
        kept.append({"hooks": [{"type": "command", "command": _gemini_hook_command(), "timeout": hook_timeout("gemini")}]})
        hooks[event] = kept
    return settings


def gemini_home(conf_dir, reach=None, environ=os.environ):
    """The private GEMINI_CLI_HOME of Mesh-started Gemini sessions (see above), created or refreshed."""
    user_home = Path(environ.get(GEMINI_HOME_ENV) or Path.home())
    user_dir = user_home / ".gemini"
    try:
        user = _read_gemini_settings(user_dir / "settings.json")
    except ValueError as exc:
        raise ValueError(f"the user's {exc}") from exc
    home = Path(conf_dir) / "gemini-home"
    target = home / ".gemini"
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    wanted = {}
    if user_dir.is_dir():
        skipped = _GEMINI_PRIVATE | _GEMINI_REDIRECTED
        wanted = {entry.name: entry for entry in user_dir.iterdir() if entry.name not in skipped}
    for entry in list(target.iterdir()):
        if entry.name in _GEMINI_REDIRECTED:
            _remove_stale(entry)        # a link or a copy of the user's file: the environment names it now
        elif entry.name in _GEMINI_PRIVATE:
            continue
        elif entry.is_symlink() and entry.name in wanted and Path(os.readlink(entry)) == wanted[entry.name]:
            wanted.pop(entry.name)
        elif entry.is_symlink():
            _remove_stale(entry)        # a link to something the user removed or moved
    for name, source in wanted.items():
        link = target / name
        if link.is_symlink():
            _remove_stale(link)
        if not link.exists():
            try:
                link.symlink_to(source)
            except FileExistsError:     # a concurrent launch made it
                pass
    payload = json.dumps(gemini_settings(user, reach), separators=(",", ":"))
    descriptor, temporary = tempfile.mkstemp(dir=target, prefix=".settings.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            out.write(payload)
        os.replace(temporary, target / "settings.json")
    except BaseException:
        _remove_stale(Path(temporary))
        raise
    return home


def _remove_stale(entry):
    try:
        entry.unlink()
    except FileNotFoundError:
        pass


def gemini_environment(home, environ=os.environ):
    """The environment assignments of a Mesh-started Gemini: its private home and the user's trust file."""
    return {GEMINI_HOME_ENV: str(home), GEMINI_TRUST_ENV: str(gemini_trusted_folders(environ))}
# Antigravity (agy) has no per-session configuration: no flag, no inline setting (`--settings` refuses a
# key it does not know) and no environment variable names another configuration directory. Its MCP
# servers and hooks come from files, the user's global ones, a project's ``.agents/`` or an installed
# plugin. Mesh therefore ships one plugin that the user installs once (scripts/agy-setup.sh, which runs
# `agy plugin install`) and removes with `agy plugin uninstall session-mesh`: the board bridge and the two
# state hooks. It holds no credential: the bridge and the hook read MESH_SESSION_TOKEN and MESH_PORT from
# the environment of the terminal. The hook does nothing without a token; the bridge exits with an
# error (code 78) instead, so an agy outside a mesh terminal starts a board server that fails. The
# plugin is global, so an agy started inside a terminal (agy -p run by another agent) inherits the
# token too: the server keeps only the events of the session's own agy (server.EventState.foreign).
AGY_PLUGIN_NAME = "session-mesh"
AGY_HOOKS = hook_events("agy", "state")


def agy_plugin_files(bridge=None, event=None):
    """``{file name: text}`` of the Mesh plugin for agy (see above)."""
    bridge = BOARD_MCP if bridge is None else bridge
    event = str(runtime_bin() / "mesh-event") if event is None else event
    files = {
        "plugin.json": {"name": AGY_PLUGIN_NAME, "displayName": "Session Mesh", "version": "1.0.0",
                        "description": "Board tools and state reports for terminals started by Session Mesh."},
        "hooks.json": {AGY_PLUGIN_NAME: {
            hook: [{"command": f"{shlex.quote(event)} agy {hook}", "timeout": hook_timeout("agy")}] for hook in AGY_HOOKS}},
    }
    if bridge and (servers := mesh_servers("agy", bridge=bridge)):
        files["mcp_config.json"] = {"mcpServers": {server.name: _stdio_entry(server) for server in servers}}
    return {name: json.dumps(value, indent=2) + "\n" for name, value in files.items()}


def write_agy_plugin(directory):
    """Write the plugin into a new or empty directory; refuses to write into anything else."""
    target = Path(directory)
    files = agy_plugin_files()
    if "mcp_config.json" not in files:
        # An installed plugin without the bridge would still load: agy would run the hooks and offer
        # no board tools, and nothing would say why. Install is refused instead.
        raise SystemExit(f"agentmcp: no executable {BOARD_MCP}: the plugin was not written (install the "
                         f"bridge, or set MESH_BIN_DIR to the directory that holds it)")
    target.mkdir(parents=True, exist_ok=True)
    if any(target.iterdir()):
        raise SystemExit(f"agentmcp: {target} is not empty")
    for name, text in files.items():
        (target / name).write_text(text)


# Mistral Vibe merges the VIBE_MCP_SERVERS environment variable (a JSON list of servers) over its
# user and project configuration, entry by entry *by name*: an entry of the same name replaces the
# whole configured one, so what the user set on the board (``disabled``, ``disabled_tools``) is read
# back and repeated in the injected entry (vibe_user_limits).  Vibe starts a stdio server with only
# the environment its entry lists, so unlike Claude and OpenCode the bridge does not inherit the
# session token: the entry carries it, but never in a file or an argument.  The command line holds
# the word ``"$MESH_SESSION_TOKEN"`` inside the script of an ``sh -c`` that execs Vibe: that inner shell expands
# it from its environment, so the value reaches only Vibe's environment (as MESH_SESSION_TOKEN already does)
# and no process argument (the shell of the pty would otherwise expand it into the argv of ``env``).
VIBE_MCP_ENV = "VIBE_MCP_SERVERS"
VIBE_HOOKS_DIRNAME = "mesh-vibe-hooks"
_VIBE_HOOK_EVENTS = tuple((entry["native"], entry["label"]) for entry in hook_entries("vibe", "state"))
_VIBE_MARK = "@@mesh-env:{}@@"
_VIBE_MARKS = re.compile(r"@@mesh-env:([A-Z_]+)@@")
_TOKEN_MARK = _VIBE_MARK.format("MESH_SESSION_TOKEN")
_VIBE_LIMITS_MAX = 256


def vibe_home(environ=os.environ):
    configured = environ.get("VIBE_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".vibe"


class VibeRefused(Exception):
    """A Vibe launch Mesh declines to build: the message says why and is shown to the user."""


_VIBE_CONFIG_MAX = 1 << 20


def _read_vibe_config(path):
    """The bytes of a Vibe configuration file, or None when there is none or it cannot be opened.

    The project file belongs to an untrusted folder, and the server reads it: opening a FIFO would
    block its event loop and a link to /dev/zero would fill its memory.  The file is opened without
    blocking (a link to a regular file is followed, as Vibe does for a dotfile repository), judged on
    the open descriptor (fstat: no stat-then-open race) and read at most _VIBE_CONFIG_MAX bytes."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC)
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ENOTDIR, errno.EACCES, errno.EPERM):
            return None         # none, or one Vibe cannot read either
        raise VibeRefused(f"{path} cannot be opened ({exc.strerror}): no Vibe session was started") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise VibeRefused(f"{path} is not a regular file: no Vibe session was started")
        data = b""
        while len(data) <= _VIBE_CONFIG_MAX:
            chunk = os.read(fd, _VIBE_CONFIG_MAX + 1 - len(data))
            if not chunk:
                return data
            data += chunk
        raise VibeRefused(f"{path} is larger than {_VIBE_CONFIG_MAX} bytes: no Vibe session was started")
    except MemoryError:
        raise VibeRefused(f"{path} could not be read: no Vibe session was started") from None
    finally:
        os.close(fd)


def _limits_in(path, name):
    """(disabled, disabled_tools) a Vibe configuration file sets on the server ``name``; nothing when there
    is no file or it is not valid TOML (Vibe reports that itself).  VibeRefused for a file Mesh must not read."""
    data = _read_vibe_config(path)
    if data is None:
        return False, []
    try:
        servers = tomllib.loads(data.decode("utf-8")).get("mcp_servers")
    except tomllib.TOMLDecodeError:
        return False, []
    except (ValueError, RecursionError, MemoryError) as exc:
        raise VibeRefused(f"{path} cannot be read ({type(exc).__name__}): no Vibe session was started") from None
    disabled, tools = False, []
    for server in servers if isinstance(servers, list) else []:
        if isinstance(server, dict) and server.get("name") == name:
            disabled = disabled or server.get("disabled") is True
            names = server.get("disabled_tools")
            tools += [tool for tool in names if isinstance(tool, str)] if isinstance(names, list) else []
    return disabled, tools


def vibe_user_limits(cwd, environ=os.environ, name=SERVER_NAME):
    """What the user's Vibe configuration (user and project) restricts on the Mesh server ``name``: the
    injected entry replaces theirs by name, so these are repeated in it and a stricter choice stays in force."""
    disabled, tools = False, set()
    for path in (vibe_home(environ) / "config.toml", Path(cwd) / ".vibe" / "config.toml"):
        off, names = _limits_in(path, name)
        disabled, tools = disabled or off, tools | set(names)
    if len(tools) > _VIBE_LIMITS_MAX:       # cutting the list would silently re-enable the tools cut
        raise VibeRefused(f"the configuration disables {len(tools)} tools of {name} "
                          f"(at most {_VIBE_LIMITS_MAX} are repeated): no Vibe session was started")
    return {"disabled": disabled, "disabled_tools": sorted(tools)}


def _with_limits(entry, limits):
    if limits and limits.get("disabled"):
        entry["disabled"] = True
    if limits and limits.get("disabled_tools"):
        entry["disabled_tools"] = list(limits["disabled_tools"])
    return entry


def vibe_mcp_value(reach, limits=None):
    """The VIBE_MCP_SERVERS value as the two texts around the session token, or None without a bridge.
    ``reach`` (MESH_PORT, MESH_CONF_DIR) is set in the entry itself: a project configuration merges
    below the environment, so it cannot point the bridge, which sends the token, elsewhere.  ``limits``
    maps a server's name to what vibe_user_limits found.  Every other identity_env variable (the tracker's
    MESH_SESSION and WL_HOME) stays a mark in the second text, which vibe_shell_words turns into an
    expansion; an unset WL_HOME expands to an empty value, which the tracker treats as unset."""
    servers = mesh_servers("vibe", reach)
    if not servers:
        return None
    entries = [_with_limits({"name": server.name, "transport": "stdio", "command": server.command,
                             "args": server.args,
                             "env": {**server.env, **{name: _VIBE_MARK.format(name) for name in server.identity_env}}},
                            (limits or {}).get(server.name)) for server in servers]
    before, after = json.dumps(entries, separators=(",", ":")).split(_TOKEN_MARK)
    return before, after


def vibe_shell_words(text):
    """``text`` as one shell word of the launch script: quoted, with each mark an expansion ``"$NAME"``
    by the inner shell, so no value is written on the line.  A value holding a double quote or a
    backslash (a WL_HOME so named) would break the JSON, and Vibe would then refuse its configuration."""
    parts = _VIBE_MARKS.split(text)
    return "".join(shlex.quote(part) if index % 2 == 0 else f'"${part}"' for index, part in enumerate(parts))


_VIBE_LAUNCH_ID = re.compile(r"[A-Za-z0-9_-]{8,80}")
VIBE_HOOKS_GRACE = 300          # seconds before a directory no session claims is swept


def _private_dir(path):
    """Create ``path`` (if need be) as a directory of the current user, mode 0700 whatever the umask."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise OSError(errno.ENOTDIR, "not a directory of the current user", str(path))
    os.chmod(path, 0o700)


def remove_vibe_hooks_dir(path):
    """Remove a hooks directory (read-only by construction) and what it holds, without recursion (a tree
    a thousand levels deep must not end the caller with RecursionError) and without following a link: a link
    inside is unlinked, never entered, and a directory is made writable with a chmod that refuses to follow a
    link.  Without a concurrent writer that is all there is to it; a writer of the same user that swaps an
    entry for a link between the check and the call can only make one of them fail (an OSError, left for the
    next sweep)."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(path)
        return
    directories, pending = [], [str(path)]
    while pending:
        current = pending.pop()
        directories.append(current)
        os.chmod(current, 0o700, follow_symlinks=False)
        with os.scandir(current) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)
                else:
                    os.unlink(entry.path)
    for current in reversed(directories):
        os.rmdir(current)


def vibe_hooks_dir(conf_dir, launch_id, event_command=None):
    """The directory handed to Vibe with ``--add-dir`` for one launch: Vibe reads ``.vibe/hooks.toml`` of
    every directory it is given, so the Mesh hooks (state reports, see bin/mesh-event) need no change to
    the user's own hooks file or project.  The file holds paths only, never a credential.  None when the
    hook program is not installed.

    ``--add-dir`` makes the directory a project root *and* a workspace root of the agent (an AGENTS.md
    there reaches the model's prompt, ``.vibe/tools|plugins|agents`` and ``.agents/skills`` are loaded, and
    the accept-edits agent writes there without asking).  So the directory is private to this launch
    (``mesh-vibe-hooks/<launch_id>``, built anew), holds nothing but ``.vibe/hooks.toml``, and is read-only
    (files 0400, directories 0500): what a session under prompt injection cannot write, it cannot leave
    for the sessions that follow.  remove_vibe_hooks_dir and purge_vibe_hooks delete it."""
    if not _VIBE_LAUNCH_ID.fullmatch(launch_id):
        raise ValueError("launch id")
    command = event_command or runtime_bin() / "mesh-event"
    if not os.access(command, os.X_OK):
        return None
    lines = []
    for point, name in _VIBE_HOOK_EVENTS:
        lines += ["[[hooks]]", f'name = "session-mesh-{name}"', f'type = "{point}"',
                  f"command = {json.dumps(shlex.quote(str(command)) + ' vibe')}", f"timeout = {hook_timeout('vibe')}", ""]
    for point, argv in project_context_hooks("vibe"):       # read-only; its JSON output reaches the model
        lines += ["[[hooks]]", 'name = "session-mesh-project-context"', f'type = "{point}"',
                  f"command = {json.dumps(shlex.join(argv))}", f"timeout = {hook_timeout('vibe')}", ""]
    root = Path(conf_dir) / VIBE_HOOKS_DIRNAME
    directory = root / launch_id
    try:
        Path(conf_dir).mkdir(mode=0o700, parents=True, exist_ok=True)
        _private_dir(root)
        remove_vibe_hooks_dir(directory)
        os.mkdir(directory, 0o700)
        os.mkdir(directory / ".vibe", 0o700)
        fd = os.open(directory / ".vibe" / "hooks.toml", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, "w") as handle:
            handle.write("\n".join(lines))
        os.chmod(directory / ".vibe", 0o500)
        os.chmod(directory, 0o500)
    except OSError:
        remove_vibe_hooks_dir(directory)
        raise
    return str(directory)


def purge_vibe_hooks(conf_dir, keep=(), grace=0):
    """Delete what is under ``mesh-vibe-hooks`` and that no live session names in ``keep`` (a launch id)
    and that is older than ``grace`` seconds; the number removed."""
    root = Path(conf_dir) / VIBE_HOOKS_DIRNAME
    try:
        names = os.listdir(root)
    except (FileNotFoundError, NotADirectoryError):
        return 0
    removed = 0
    for name in names:
        path = root / name
        try:
            if name in keep or time.time() - os.lstat(path).st_mtime < grace:
                continue
            remove_vibe_hooks_dir(path)
            removed += 1
        except Exception:       # one entry that cannot be removed must not stop the others
            continue
    return removed


def _codex_config(servers=None):
    """The ``-c`` items of ``servers``, by default those of an installation with the board.
    Codex's ``-c`` accepts a TOML key/value override.  Keep this an additive
    override: existing user/project MCP configuration remains in effect."""
    items = []
    for server in _with_board("codex") if servers is None else servers:
        key = f"mcp_servers.{server.name}"
        items += [f"{key}.command={json.dumps(server.command)}",
                  f"{key}.args={json.dumps(server.args, separators=(',', ':'))}",
                  f"{key}.env_vars={json.dumps(server.env_names, separators=(',', ':'))}",
                  *([f"{key}.env={_toml_inline(server.env)}"] if server.env else [])]
    return items


# A recorded command may come from a snapshot written by another installation,
# under another name: its board server, executable and environment names differ.
# Such an entry is recognised by its structure, never by a list of names: a
# server named ``<prefix>-board`` that starts an executable named
# ``<prefix>-board-mcp`` in one of the two ways installations write it: that
# executable's absolute path with no argument, or ``opam`` with exactly the
# arguments ``exec --switch=<absolute directory> -- <prefix>-board-mcp`` (Codex:
# and, when it lists inherited environment names, one of them
# ``*_SESSION_TOKEN``; no other key than ``command``, ``args`` and ``env_vars``;
# Claude: no other key than ``command`` and ``args``).
# The current server name is always recognised, whatever its configuration.
#
# Limit: a user's own server that has exactly this shape (for instance
# ``my-board`` running ``/usr/local/bin/my-board-mcp`` with no argument) is
# indistinguishable from a recorded board and is dropped from a restored or
# resumed command.  Servers with another name pattern, a relative command, a
# command named otherwise, or other arguments are kept.
_BOARD_SUFFIX = "-board"
_SWITCH_ARG = "--switch="
_CODEX_BOARD_KEYS = {"command", "args", "env_vars"}
# What a user's snapshot may keep under a Mesh server's name (MESH_SERVER_NAMES).  Codex merges the
# overrides of one server key by key with Mesh's injected block, which sets none of
# these keys, so a kept value must itself be the restrictive one: a tool list (it
# only narrows what the board offers), ``enabled`` only when false, and the approval
# mode (``default_tools_approval_mode`` and ``tools.<name>.approval_mode``) only when
# it may require an approval: "prompt" or "writes".  The modes Codex 0.169 accepts are
# auto (the default), prompt, writes and approve.  "writes" is kept because its name
# suggests it prompts for write tools, and stripping a mode that prompts would fall back
# to the looser default; "approve" auto-approves and "auto" is the default, so neither
# is kept (nothing is lost by stripping them).
# Every other key (env, cwd, url, transport, bearer_token_env_var,
# startup_timeout_sec...) could redirect or alter the board and is stripped.
_RESTRICTIVE_APPROVAL_MODES = ("prompt", "writes")
_TOOL_APPROVAL_KEY = "approval_mode"


def _is_string_list(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


_USER_BOARD_LIMITS = {
    "disabled_tools": _is_string_list,
    "enabled_tools": _is_string_list,
    "enabled": lambda value: value is False,
    "default_tools_approval_mode": lambda value: value in _RESTRICTIVE_APPROVAL_MODES,
}


def _starts_board_executable(name, command, args):
    """``command args`` runs ``<name>-mcp`` as an installation writes it."""
    executable = f"{name}-mcp"
    if isinstance(command, str) and os.path.isabs(command):
        return os.path.basename(command) == executable and args == []
    if command != "opam" or not (isinstance(args, list) and len(args) == 4):
        return False
    switch = args[1]
    return (args[0] == "exec" and isinstance(switch, str) and switch.startswith(_SWITCH_ARG)
            and os.path.isabs(switch[len(_SWITCH_ARG):]) and args[2:] == ["--", executable])


def _is_board_server(name, server, codex=False):
    if name in MESH_SERVER_NAMES:
        # Always Mesh's; for Codex only the user's _USER_BOARD_LIMITS on it survive.
        return True
    if not (isinstance(server, dict) and isinstance(name, str)):
        return False
    if not (len(name) > len(_BOARD_SUFFIX) and name.endswith(_BOARD_SUFFIX)
            and _starts_board_executable(name, server.get("command"), server.get("args", []))):
        return False
    if not codex:
        return set(server) <= {"command", "args"}
    if not set(server) <= _CODEX_BOARD_KEYS:
        return False
    env_vars = server.get("env_vars")
    return env_vars is None or (isinstance(env_vars, list) and any(
        isinstance(env, str) and env.endswith("_SESSION_TOKEN") for env in env_vars))


def _strict_dotted_key(key):
    """The parts of a TOML dotted key (bare or quoted parts), or None when it is not one."""
    try:
        node = tomllib.loads(f"{key.strip()} = 0")
    except tomllib.TOMLDecodeError:
        return None
    path = []
    while isinstance(node, dict) and len(node) == 1:
        part, node = next(iter(node.items()))
        path.append(part)
    return path


def _dotted_key(key):
    """The parts of a TOML dotted key, or its plain dot-split when it is not one."""
    path = _strict_dotted_key(key)
    return [part.strip() for part in key.split(".")] if path is None else path


def _toml_value(raw):
    """A Codex override value: TOML when it parses, else the raw string, as Codex reads it."""
    try:
        return tomllib.loads(f"value = {raw}")["value"]
    except tomllib.TOMLDecodeError:
        return raw.strip()


def _is_cut_inside_quotes(key):
    """A key that is no TOML key and holds a quote: the first ``=`` fell inside a quoted part."""
    return _strict_dotted_key(key) is None and ('"' in key or "'" in key)


def _codex_server_override(value):
    """``(name, key, value)`` for ``mcp_servers.<name>[.<key>...]=value``, else None.
    ``key`` is the list of the key's parts after the name (their quoting is already
    resolved: a tool named ``a.b`` is one part).  A whole-table override has key None;
    the whole root ``mcp_servers={...}`` has name None (and a table value).

    The value starts at the first ``=``, quoted or not, exactly as Codex 0.169 splits a
    ``-c`` item: ``-c 'mcp_servers.x.tools."a=b".approval_mode="prompt"'`` is read as the key
    ``mcp_servers.x.tools."a`` and fails to load ("invalid type: string ... expected struct
    McpServerToolConfig").  Such an item could not have started a session; when its key is
    cut inside a quoted part it is no override here and is kept verbatim, never dropped (the table
    form ``tools={"a=b"={...}}`` is what Codex accepts)."""
    key, sep, raw = value.partition("=")
    path = _dotted_key(key) if sep and not _is_cut_inside_quotes(key) else []
    if not path or path[0] != "mcp_servers":
        return None
    if len(path) == 1:
        root = _toml_value(raw)
        return (None, None, root) if isinstance(root, dict) else None
    key = None if len(path) == 2 else path[2:]
    return path[1], key, _toml_value(raw)


class _CodexToken(NamedTuple):
    """argv words; for a ``-c``/``--config`` item, its flag (``head``), whether
    the value is a separate word, and the server override it carries, if any."""
    words: list
    override: tuple = None
    head: str = ""
    separate: bool = False


# The forms in which Codex's CLI (clap) attaches a value to its config flag:
# ``--config=v``, ``-c=v`` and ``-cv``.
_ATTACHED_CONFIG = ("--config=", "-c=", "-c")


def _codex_token(arg):
    head = next((head for head in _ATTACHED_CONFIG if arg.startswith(head) and len(arg) > len(head)), None)
    if head is None:
        return _CodexToken([arg])
    return _CodexToken([arg], _codex_server_override(arg[len(head):]), head)


def _codex_tokens(argv):
    """argv as _CodexToken items."""
    tokens, i = [], 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-c", "--config") and i + 1 < len(argv):
            tokens.append(_CodexToken(argv[i:i + 2], _codex_server_override(argv[i + 1]), arg, True))
            i += 2
            continue
        tokens.append(_codex_token(arg))
        i += 1
    return tokens


def codex_config_items(argv):
    """argv as ``(words, value)`` pairs: ``value`` is the configuration value of
    a ``-c``/``--config`` item in any form Codex accepts, None for other words."""
    items = []
    for token in _codex_tokens(argv):
        if not token.head:
            items.append((token.words, None))
            continue
        value = token.words[1] if token.separate else token.words[0][len(token.head):]
        items.append((token.words, value))
    return items


def _codex_servers(overrides):
    """Each server's configuration as the overrides compose it (the last value wins).
    The keys of one server are often separate overrides: decide on the whole."""
    servers = {}
    for name, key, value in overrides:
        tables = value.items() if name is None else [(name, value)]
        for server_name, table in tables:
            server = servers.setdefault(server_name, {})
            if key is not None:
                server[key[0] if len(key) == 1 else tuple(key)] = table
            elif isinstance(table, dict):
                server.update(table)
    return servers


_BARE_TOML_KEY = re.compile(r"[A-Za-z0-9_-]+")


def _toml_key(part):
    """One key part as TOML writes it: bare when it can be, else quoted (dots, spaces,
    quotes, non-ASCII characters and the empty key need quoting)."""
    return part if _BARE_TOML_KEY.fullmatch(part) else _toml_inline(part)


def _toml_inline(value):
    """``value`` (as tomllib returns it) written as one inline TOML value."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")
    if isinstance(value, list):
        return "[" + ",".join(map(_toml_inline, value)) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{_toml_key(key)}={_toml_inline(item)}"
            for key, item in value.items()) + "}"
    return value.isoformat()


def _tool_approvals(tools):
    """Of a ``tools`` table, only each tool's restrictive ``approval_mode``; None when
    none remains."""
    if not isinstance(tools, dict):
        return None
    kept = {name: {_TOOL_APPROVAL_KEY: tool[_TOOL_APPROVAL_KEY]} for name, tool in tools.items()
            if isinstance(tool, dict) and tool.get(_TOOL_APPROVAL_KEY) in _RESTRICTIVE_APPROVAL_MODES}
    return kept or None


def _user_board_limits(table):
    """The part of a current-board table that may stay: the _USER_BOARD_LIMITS whose
    value is restrictive and the tools' restrictive approval modes.  None when nothing
    remains."""
    if not isinstance(table, dict):
        return None
    kept = {key: value for key, value in table.items()
            if key in _USER_BOARD_LIMITS and _USER_BOARD_LIMITS[key](value)}
    approvals = _tool_approvals(table.get("tools"))
    if approvals is not None:
        kept["tools"] = approvals
    return kept or None


def _nested_key(path, value):
    """``{a: {b: value}}`` for the key parts ``[a, b]``."""
    for part in reversed(path):
        value = {part: value}
    return value

def _write_override(token, key, value):
    text = f"{key}={_toml_inline(value)}"
    return [token.head, text] if token.separate else [token.head + text]


def _current_board_words(token):
    """The words of an override of a Mesh server that may stay: a
    user's limit (see _USER_BOARD_LIMITS), nothing else."""
    name, key, value = token.override
    if key is not None:
        nested = _nested_key(key, value)
        kept = _user_board_limits(nested)
        if kept is None:
            return []
        return token.words if kept == nested else _write_override(token, f"mcp_servers.{name}", kept)
    kept = _user_board_limits(value)
    if kept is None:
        return []
    return token.words if kept == value else _write_override(token, f"mcp_servers.{name}", kept)


def _codex_token_without_board(token, board):
    """A token's words without the board servers it configures: none when it
    configures only board servers, a rewritten override when it mixes them or
    carries a user's limit on a Mesh server."""
    if token.override is None:
        return token.words
    name, _, value = token.override
    if name in MESH_SERVER_NAMES:
        return _current_board_words(token)
    if name is not None:
        return [] if name in board else token.words
    kept = {server: _user_board_limits(table) if server in MESH_SERVER_NAMES else table
            for server, table in value.items() if server not in board or server in MESH_SERVER_NAMES}
    kept = {server: table for server, table in kept.items() if table is not None}
    if kept == value:
        return token.words
    return _write_override(token, "mcp_servers", kept) if kept else []


def _claude_without_board(value):
    """One --mcp-config value without its board servers: the value itself when it
    names none (a path, malformed JSON, other servers only), None when only board
    servers remain to drop."""
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    servers = parsed.get("mcpServers") if isinstance(parsed, dict) else None
    if not isinstance(servers, dict):
        return value
    kept = {name: server for name, server in servers.items() if not _is_board_server(name, server)}
    if len(kept) == len(servers):
        return value
    if not kept and set(parsed) == {"mcpServers"}:
        return None
    return json.dumps({**parsed, "mcpServers": kept}, separators=(",", ":"), ensure_ascii=False)


def _strip_claude_board(argv):
    """Claude's --mcp-config takes several values: keep the flag when any
    non-board value remains (or it had none, which is not ours to fix)."""
    kept, i = [], 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mcp-config":
            end = i + 1
            while end < len(argv) and not argv[end].startswith("-"):
                end += 1
            values = [v for v in map(_claude_without_board, argv[i + 1:end]) if v is not None]
            if values or end == i + 1:
                kept.extend([arg, *values])
            i = end
            continue
        if arg.startswith("--mcp-config="):
            value = _claude_without_board(arg.split("=", 1)[1])
            if value is not None:
                kept.append(f"--mcp-config={value}")
            i += 1
            continue
        kept.append(arg)
        i += 1
    return kept


def _strip_codex_board(argv):
    tokens = _codex_tokens(argv)
    servers = _codex_servers(token.override for token in tokens if token.override)
    board = {name for name, server in servers.items() if _is_board_server(name, server, codex=True)}
    return [word for token in tokens for word in _codex_token_without_board(token, board)]


def strip_board(kind, argv):
    """argv without any board MCP configuration, whichever deployment wrote it.

    A recorded command may come from a snapshot written by another installation
    (another server name, executable or environment allow-list).  Only board
    entries (see _is_board_server) are removed: other MCP servers and options stay.
    """
    if kind == "claude":
        return _strip_claude_board(list(argv))
    if kind == "codex":
        return _strip_codex_board(list(argv))
    return list(argv)


# Codex configuration keys whose loss restricts nothing: Mesh sets
# tui.raw_output_mode again on every Codex command it starts, and the model is
# not a limit on what the agent may do (the --model option is not one either).
RAW_OUTPUT_KEY = ["tui", "raw_output_mode"]
_FREE_CODEX_KEYS = (RAW_OUTPUT_KEY, ["model"])


def _has_control_character(value):
    """A ``-c`` value with a newline or other control character can smuggle a second
    setting into the one Mesh thinks it reads: it is never free."""
    return value is not None and any(ch < " " or ch == "\x7f" for ch in value)


def without_codex_config(argv, keys):
    """Codex argv without the ``-c``/``--config`` items, in any form, that set one of keys.
    The key ends at the first ``=``, as Codex reads it (see _codex_server_override)."""
    return [word for words, value in codex_config_items(list(argv))
            if value is None or "=" not in value or _dotted_key(value.partition("=")[0]) not in keys
            for word in words]


def without_free_codex_config(argv):
    """Codex argv without the configuration items that restrict nothing: board
    servers (see strip_board), which Mesh injects again, and _FREE_CODEX_KEYS.
    Every other configuration item is kept, as is any item whose value holds a
    control character.  Everything under a board's name is free except the
    user's _USER_BOARD_LIMITS on a Mesh server, which restrict and are kept."""
    plain, unreadable = [], []
    for words, value in codex_config_items(list(argv)):
        (unreadable if _has_control_character(value) else plain).extend(words)
    return [*without_codex_config(_strip_codex_board(plain), _FREE_CODEX_KEYS), *unreadable]


def inject(kind, argv):
    """Return an interactive agent argv with the Mesh servers (mesh_servers) added.

    This only changes Mesh-launched Claude/Codex/Pi invocations. Claude does not
    receive ``--strict-mcp-config``: that would silently hide its other MCP
    servers.  The bridge inherits ``MESH_SESSION_TOKEN`` from the pty, rather
    than accepting any credential or board identity as an argument.  Codex
    requires an explicit allow-list of inherited stdio environment names; it
    receives the values from the pty, never from this configuration.

    Any board configuration already in argv (from this or another
    installation, see strip_board) is replaced by exactly the current one.
    Without an installed bridge (board_available), Claude and Codex keep their
    argv without any Mesh server entry.
    """
    if kind == "claude":
        kept = strip_board(kind, argv)
        config = _claude_config(mesh_servers(kind))
        return [*kept, "--mcp-config", config] if config else kept
    if kind == "codex":
        kept = strip_board(kind, argv)
        return [*kept, *(word for item in _codex_config(mesh_servers(kind)) for word in ("-c", item))]
    if kind in ("opencode", "gemini", "agy", "vibe"):
        # The configuration travels in the environment (opencode_config, gemini_home, vibe_mcp_value), not in argv;
        # agy has none per session: its plugin holds it (agy_plugin_files).
        return list(argv)
    if kind == "copilot":
        # Mesh's options are added at launch (server._copilot_command), after the saved ones.
        return list(argv)
    if kind == "pi":
        # Pi's built-in extension reads the private PI_CODING_AGENT_DIR/mcp.json.
        # Explicit loading also works when an installation disables extensions.
        if "--no-mcp" in argv:
            raise ValueError("Pi MCP disabled by the command")
        return list(argv) if any(argv[i:i + 2] == ["-e", "builtin:mcp"]
                                 for i in range(len(argv) - 1)) else [*argv, "-e", "builtin:mcp"]
    raise ValueError("Unknown MCP agent")


# GitHub Copilot CLI takes per-session MCP servers (--additional-mcp-config, which augments the user's
# configuration for this run only) and a per-session plugin directory (--plugin-dir) whose hooks report
# the state to the mesh. Neither writes to ~/.copilot, and neither carries a credential: the stdio
# server and the hooks inherit MESH_SESSION_TOKEN from the pty. A user's own settings still apply:
# ``disabledMcpServers`` / --disable-mcp-server turn the board off, --deny-tool and the other
# permission options are kept, and a user's hook configuration runs beside ours.
COPILOT_PLUGIN = Path(__file__).resolve().parent / "copilot-mesh-plugin"
COPILOT_EVENT_ENV = "MESH_EVENT_BIN"


def copilot_args(plugin=COPILOT_PLUGIN, reach=None):
    """The arguments that add the board server and the Mesh state plugin to one Copilot CLI run.

    ``reach`` (MESH_PORT and MESH_CONF_DIR, never a credential) goes in the server's own ``env``
    block, which wins over the process environment: a project's .mcp.json cannot point the bridge,
    which sends the session token, at another local port."""
    args = []
    if servers := mesh_servers("copilot", reach):      # without the bridge an entry would only fail at every launch
        entries = {server.name: {"type": "local", **_stdio_entry(server)} for server in servers}
        args += ["--additional-mcp-config", json.dumps({"mcpServers": entries}, separators=(",", ":"))]
    if (Path(plugin) / "hooks" / "hooks.json").is_file():
        args += ["--plugin-dir", str(plugin)]
    return args


def _is_copilot_board_config(value):
    """``value`` is exactly what copilot_args writes (of this or another installation): a JSON object
    whose only servers are Mesh's (reserved names, see MESH_SERVER_NAMES). A user's configuration, which
    may hold other servers, is not."""
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return False
    return (isinstance(parsed, dict) and set(parsed) == {"mcpServers"} and isinstance(parsed["mcpServers"], dict)
            and parsed["mcpServers"] and set(parsed["mcpServers"]) <= set(MESH_SERVER_NAMES))


def _is_mesh_copilot_plugin(directory):
    """``directory`` is a copy of Mesh's Copilot plugin (this or another installation): its last component is
    the plugin's name and its hooks file runs Mesh's event helper (``MESH_EVENT_BIN``).  A user's own plugin
    that merely has the same name is not Mesh's and is kept."""
    if os.path.basename(directory.rstrip("/")) != COPILOT_PLUGIN.name:
        return False
    try:
        with open(os.path.join(directory, "hooks", "hooks.json"), "rb") as source:
            text = source.read(65536)
    except OSError:
        return False
    return COPILOT_EVENT_ENV.encode() in text


def without_copilot_mesh(argv):
    """argv without the options copilot_args adds, so that a rebuilt command carries the current ones
    only. Options that only look alike (another plugin directory, a configuration with other
    servers) are kept."""
    kept, i = [], 0
    while i < len(argv):
        word = argv[i]
        name, equals, attached = word.partition("=")
        value = attached if equals else (argv[i + 1] if i + 1 < len(argv) else None)
        own = ((name == "--plugin-dir" and value is not None and _is_mesh_copilot_plugin(value))
               or (name == "--additional-mcp-config" and value is not None and _is_copilot_board_config(value)))
        if own:
            i += 1 if equals else 2
        else:
            kept.append(word)
            i += 1
    return kept


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "agy-plugin":
        write_agy_plugin(sys.argv[2])
    else:
        raise SystemExit("usage: agentmcp.py agy-plugin <new directory>")
