# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Waking a Claude session on its own messaging socket instead of typing in its terminal.

The through-the-server cases are in test_claudewake_server.py, the choice of
when a session gets a socket in test_claudepolicy.py."""

import asyncio
import json
import os
import shlex
import socket
import time
from pathlib import Path

import pytest

import agentmcp
import claudewake
import server
from session_helpers import NONCE

REAL_SUPPORTED = claudewake.supported   # captured before the autouse fixture replaces it
OTHER = "fedcba9876543210fedcba9876543210"
KEY = "crossSessionInbound"


@pytest.fixture
def wake_dir(short_root):
    """A private directory a Unix socket path fits in (under 104 bytes), as a first launch leaves it."""
    directory = short_root / "session-mesh" / "claude-wake"
    directory.mkdir(parents=True, mode=0o700)
    directory.parent.chmod(0o700)
    claudewake.initialize_state(directory)
    return directory


class Listener:
    """A fake Claude messaging socket that records each line it receives."""

    def __init__(self, path):
        self.path = path
        self.lines = []
        self.server = None

    async def __aenter__(self):
        async def handle(reader, writer):
            while line := await reader.readline():
                self.lines.append(line)
            writer.close()
        self.server = await asyncio.start_unix_server(handle, path=str(self.path))
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()
        # A Claude that exits removes its socket (Node's net server does). asyncio only does it
        # from Python 3.13 (cleanup_socket): on the 3.12 of CI the file would outlive the listener.
        Path(self.path).unlink(missing_ok=True)

    async def settle(self, expected):
        for _ in range(100):
            if len(self.lines) >= expected:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)   # anything more would have arrived by now
        return self.lines


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def request(notification_id="a" * 32, count=2, name="beta", created=2.0):
    return {"op": "notify_if", "name": name, "created": created, "agent": "claude",
            "notification_id": notification_id, "count": count, "through_seq": 1}


def wake_of(poster, turn="done"):
    return {"path": poster.target(NONCE), "turn": turn}


# ------------------------------------------------------------------ wire line


def test_wake_line_is_one_ndjson_user_message_with_only_a_count():
    line = claudewake.wake_line(3)
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    assert json.loads(line) == {"type": "user", "message": {"role": "user", "content": (
        "Mesh: 3 new message(s) in your inbox; check agent_inbox "
        "and ask yes/no/always before reading.")}}


# ----------------------------------------------------------------- directories


def test_socket_path_is_per_incarnation_short_and_inside_the_directory(wake_dir):
    path = claudewake.socket_path(wake_dir, NONCE)
    assert path.parent == wake_dir and path.suffix == ".sock" and len(os.fsencode(path)) <= 103
    assert path != claudewake.socket_path(wake_dir, OTHER)
    assert path == claudewake.socket_path(wake_dir, NONCE)
    for bad in (None, "", "abc", NONCE + "0", NONCE.upper(), "../" + NONCE[3:]):
        assert claudewake.socket_path(wake_dir, bad) is None
    assert claudewake.socket_path("a/" + "b" * 120, NONCE) is None   # relative or too long


def test_directory_is_created_private_and_refused_when_shared_or_a_symlink(short_root):
    fresh = short_root / "run" / "claude-wake"
    assert claudewake.ensure_directory(fresh)
    assert oct(fresh.stat().st_mode & 0o777) == "0o700"
    assert claudewake.ensure_directory(fresh)
    shared = short_root / "shared"
    shared.mkdir(mode=0o755)
    shared.chmod(0o755)
    assert not claudewake.ensure_directory(shared)
    link = short_root / "link"
    link.symlink_to(fresh)
    assert not claudewake.ensure_directory(link)


def test_a_default_directory_that_fits_is_kept(short_root):
    preferred = short_root / "session-mesh" / "claude-wake"
    assert claudewake.wake_directory(preferred) == preferred


def test_a_default_directory_too_long_for_a_socket_gives_a_short_private_one(short_root):
    """macOS: $TMPDIR is /var/folders/xx/yyyyyyyy.../T/, and no socket fits under it."""
    long_default = short_root / ("x" * 60) / "session-mesh" / "claude-wake"
    assert claudewake.socket_path(long_default, NONCE) is None
    chosen = claudewake.wake_directory(long_default, short_root)
    assert chosen.parent == short_root and chosen.name.startswith(f"session-mesh-{os.getuid()}-")
    assert claudewake.socket_path(chosen, NONCE) is not None
    assert claudewake.ensure_directory(chosen)
    assert oct(chosen.stat().st_mode & 0o777) == "0o700"
    # One directory per mesh instance: two instances never clean each other's sockets.
    other = claudewake.wake_directory(short_root / ("y" * 60) / "session-mesh" / "claude-wake", short_root)
    assert other != chosen
    assert claudewake.wake_directory(long_default, short_root) == chosen


def test_the_short_directory_is_refused_when_open_to_others_or_a_symlink(short_root):
    chosen = claudewake.wake_directory(short_root / ("x" * 90) / "claude-wake", short_root)
    chosen.mkdir(mode=0o755)
    chosen.chmod(0o755)
    assert not claudewake.ensure_directory(chosen)
    chosen.rmdir()
    elsewhere = short_root / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    chosen.symlink_to(elsewhere)
    assert not claudewake.ensure_directory(chosen)


# ---------------------------------------------------------------- the version


@pytest.fixture
def fake_claude(short_root):
    """A claude on its own PATH: it logs how it was run and prints the version it was given."""
    bin_dir = short_root / "bin"
    bin_dir.mkdir()
    log = short_root / "runs.log"
    script = bin_dir / "claude"

    def install(version, body=""):
        script.write_text(f"#!/bin/sh\n{body}\necho {shlex.quote(version)}\n"
                          f'echo "$PWD $(readlink /proc/$$/fd/0)" >> {log}\n')
        script.chmod(0o755)
    install("2.1.325 (Claude Code)")
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(short_root)}
    return type("Fake", (), {"env": env, "install": staticmethod(install), "log": log,
                             "script": script})


@pytest.fixture
def real_version_check(monkeypatch):
    monkeypatch.setattr(claudewake, "_version_cache", {})
    return REAL_SUPPORTED


def test_capability_follows_the_installed_claude_version(fake_claude, real_version_check):
    assert real_version_check(fake_claude.env) is True
    for version, expected in (("2.1.224 (Claude Code)", False), ("something else", False),
                              ("2.2.0 (Claude Code)", True), ("3.0.0 (Claude Code)", True)):
        fake_claude.install(version)
        os.utime(fake_claude.script, ns=(1, time.time_ns()))
        assert real_version_check(fake_claude.env) is expected, version
    fake_claude.script.unlink()
    assert real_version_check(fake_claude.env) is False


@pytest.mark.skipif(not Path("/proc/self/fd/0").exists(), reason="reads /proc to see standard input")
def test_the_version_check_has_no_input_runs_from_a_neutral_folder_and_is_cached(
        fake_claude, real_version_check):
    assert real_version_check(fake_claude.env) and real_version_check(fake_claude.env)
    assert fake_claude.log.read_text().splitlines() == ["/ /dev/null"]   # once, in /, stdin closed


def test_an_executable_replaced_in_place_is_checked_again(fake_claude, real_version_check):
    assert real_version_check(fake_claude.env) is True
    fake_claude.install("2.1.1 (Claude Code)")   # same path and inode, other content
    stat = fake_claude.script.stat()
    later = stat.st_mtime_ns + 5_000_000_000
    os.utime(fake_claude.script, ns=(stat.st_atime_ns, later))
    assert real_version_check(fake_claude.env) is False
    fake_claude.install("2.1.325 (Claude Code)", "# " + "pad" * 10)    # another size, same mtime
    os.utime(fake_claude.script, ns=(stat.st_atime_ns, later))
    assert real_version_check(fake_claude.env) is True


def test_the_claude_checked_is_the_first_on_the_sessions_path(fake_claude, real_version_check, short_root):
    older = short_root / "older"
    older.mkdir()
    (older / "claude").write_text("#!/bin/sh\necho '2.1.1 (Claude Code)'\n")
    (older / "claude").chmod(0o755)
    assert real_version_check({**fake_claude.env, "PATH": f"{older}:{fake_claude.env['PATH']}"}) is False
    assert real_version_check(fake_claude.env) is True
    assert real_version_check({"PATH": str(short_root / "nowhere")}) is False


def test_a_claude_that_hangs_is_not_waited_for_and_not_cached(fake_claude, real_version_check, monkeypatch):
    monkeypatch.setattr(claudewake, "VERSION_SECONDS", 0.3)
    fake_claude.install("2.1.325 (Claude Code)", "sleep 5")
    started = time.monotonic()
    assert real_version_check(fake_claude.env) is False
    assert time.monotonic() - started < 3
    fake_claude.install("2.1.325 (Claude Code)")
    assert real_version_check(fake_claude.env) is True


def test_the_confirmation_window_has_a_documented_default_and_a_bounded_override(monkeypatch):
    assert claudewake.CONFIRM_SECONDS == 20.0
    for value, expected in (("", 20.0), ("x", 20.0), ("0", 20.0), ("9999", 20.0), ("2.5", 2.5)):
        monkeypatch.setenv("MESH_CLAUDE_WAKE_CONFIRM_SECONDS", value)
        assert claudewake._confirm_seconds() == expected


# ----------------------------------------------------------------- launching


@pytest.fixture
def capable(monkeypatch, short_root):
    """Claude supports the option, with no user, project or managed settings at all."""
    monkeypatch.setattr(claudewake, "supported", lambda env: True)
    monkeypatch.setattr(claudewake.agentmcp, "board_available", lambda: True)
    monkeypatch.setattr(claudewake.claudepolicy, "managed_directory", lambda: short_root / "no-managed")
    folder = short_root / "project"
    folder.mkdir()
    config = short_root / "claude-config"
    config.mkdir()
    return type("World", (), {"cwd": str(folder), "config": config,
                              "env": {"HOME": str(short_root), "CLAUDE_CONFIG_DIR": str(config)}})


def launch(world, wake_dir, command, nonce=NONCE):
    return claudewake.launch_command(command, nonce, wake_dir, world.cwd, world.env)


def test_launch_adds_only_the_socket_and_never_a_setting(capable, wake_dir):
    fresh = server.PRESETS["claude"]
    command = launch(capable, wake_dir, fresh)
    argv = shlex.split(command)
    assert argv[-2:] == ["--messaging-socket-path", str(claudewake.socket_path(wake_dir, NONCE))]
    assert shlex.split(fresh) == argv[:-2]         # the command is otherwise untouched
    assert KEY not in command


def test_launch_is_unchanged_without_the_capability_or_for_another_command(monkeypatch, capable, wake_dir):
    fresh = server.PRESETS["claude"]
    monkeypatch.setattr(claudewake, "supported", lambda env: False)
    assert launch(capable, wake_dir, fresh) == fresh
    monkeypatch.setattr(claudewake, "supported", lambda env: True)
    assert launch(capable, wake_dir, "bash -lc claude") == "bash -lc claude"
    assert launch(capable, wake_dir, fresh, "not-a-nonce") == fresh
    assert launch(capable, wake_dir, "claude 'unbalanced") == "claude 'unbalanced"


@pytest.mark.parametrize("choice", ["refuse", "hold"])
def test_a_stricter_choice_anywhere_keeps_the_typed_wake(capable, wake_dir, choice):
    fresh = server.PRESETS["claude"]
    (capable.config / "settings.json").write_text(json.dumps({KEY: choice}))
    assert launch(capable, wake_dir, fresh) == fresh
    (capable.config / "settings.json").write_text(json.dumps({KEY: "accept"}))
    assert "--messaging-socket-path" in launch(capable, wake_dir, fresh)
    (Path(capable.cwd) / ".claude").mkdir()
    (Path(capable.cwd) / ".claude" / "settings.local.json").write_text(json.dumps({KEY: choice}))
    assert launch(capable, wake_dir, fresh) == fresh


def test_a_bypass_session_gets_a_socket_only_with_an_explicit_accept(capable, wake_dir):
    fresh = server.PRESETS["claude"]
    for flags in ("--dangerously-skip-permissions", "--permission-mode bypassPermissions"):
        bypass = f"{fresh} {flags}"
        assert launch(capable, wake_dir, bypass) == bypass
    (capable.config / "settings.json").write_text(json.dumps({KEY: "accept"}))
    assert "--messaging-socket-path" in launch(capable, wake_dir, f"{fresh} --dangerously-skip-permissions")


def test_an_unreadable_setting_or_an_error_never_fails_the_launch(monkeypatch, capable, wake_dir):
    fresh = server.PRESETS["claude"]
    os.mkfifo(capable.config / "settings.json")
    assert launch(capable, wake_dir, fresh) == fresh         # and it returns: a FIFO cannot block
    (capable.config / "settings.json").unlink()
    (capable.config / "settings.json").write_text("{not json")
    assert launch(capable, wake_dir, fresh) == fresh
    (capable.config / "settings.json").unlink()
    if os.geteuid() != 0:
        capable.config.chmod(0)
        try:
            assert launch(capable, wake_dir, fresh) == fresh     # a folder it cannot read
        finally:
            capable.config.chmod(0o700)

    def explode(*_):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(claudewake.claudepolicy, "_evaluate", explode)
    assert launch(capable, wake_dir, fresh) == fresh


def test_launch_never_adds_a_second_socket_option(capable, wake_dir):
    once = launch(capable, wake_dir, server.PRESETS["claude"])
    assert launch(capable, wake_dir, once, OTHER) == once
    own = server.PRESETS["claude"] + " --messaging-socket-path=/elsewhere/s.sock"
    assert launch(capable, wake_dir, own) == own


def test_launch_refuses_a_shared_socket_directory(capable, wake_dir):
    wake_dir.chmod(0o755)
    fresh = server.PRESETS["claude"]
    assert launch(capable, wake_dir, fresh) == fresh


def test_without_the_board_bridge_the_session_gets_no_socket(monkeypatch, capable, wake_dir):
    """No agent_inbox tool: no wake could be confirmed, so the typed notice is kept."""
    fresh = server.PRESETS["claude"]
    assert "--messaging-socket-path" in launch(capable, wake_dir, fresh)
    monkeypatch.setattr(claudewake.agentmcp, "board_available", lambda: False)
    assert launch(capable, wake_dir, fresh) == fresh


def test_the_socket_needs_the_bridge_entry_in_the_command_not_only_the_installed_bridge(capable, wake_dir):
    """agent_inbox comes from the --mcp-config entry of the command: both forms count, other servers do not."""
    fresh = shlex.split(server.PRESETS["claude"])
    assert agentmcp.strip_board("claude", fresh) != fresh                 # the preset carries the entry
    bare = agentmcp.strip_board("claude", fresh)
    other = json.dumps({"mcpServers": {"elsewhere": {"command": "/bin/true"}}})
    entry = agentmcp._claude_config()
    cases = [([*bare], False),
             ([*bare, "--mcp-config", other], False),
             ([*bare, f"--mcp-config={other}"], False),
             ([*bare, "--mcp-config", other, entry], True),
             ([*bare, f"--mcp-config={entry}"], True),
             ([*fresh], True)]
    for argv, wanted in cases:
        launched = shlex.split(launch(capable, wake_dir, shlex.join(argv)))
        assert (launched[-2:-1] == ["--messaging-socket-path"]) == wanted, argv
        assert launched[:len(argv)] == argv                              # nothing else changed
    own = shlex.join([*bare, "--messaging-socket-path", "/elsewhere/s.sock"])
    assert launch(capable, wake_dir, own) == own                          # both options, no second socket


def test_launch_creates_the_state_file_once_and_never_replaces_it(capable, wake_dir):
    state = wake_dir / claudewake.STATE_FILE
    state.unlink()
    launch(capable, wake_dir, server.PRESETS["claude"])
    assert json.loads(state.read_text()) == {"version": 1, "lines": []}
    state.write_text('{"version":1,"lines":[]} ')
    launch(capable, wake_dir, server.PRESETS["claude"])
    assert state.read_text() == '{"version":1,"lines":[]} '


def bind(path, age=3600):
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(path))
    sock.close()
    stamp = time.time() - age
    os.utime(path, (stamp, stamp), follow_symlinks=False)
