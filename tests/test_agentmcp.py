# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The local board MCP is injected only into Mesh-created agent commands."""

import json
import os
import shlex
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

import agentmcp
import launchplan
import resumeargs
import server


def config_from(argv, kind):
    flag = "--mcp-config" if kind == "claude" else "-c"
    return argv[argv.index(flag) + 1]


def test_deployment_can_select_its_canonical_ocaml_switch(tmp_path):
    """A local switch named by its absolute directory, as opam var resolves it."""
    switch = tmp_path / "canonical-switch"
    result = subprocess.run([sys.executable, "-c", """
import json
import agentmcp
print(json.dumps({"switch": agentmcp.SWITCH_BIN, "binary": agentmcp.BOARD_MCP}))
"""], cwd=Path(__file__).resolve().parent.parent,
                            env={**os.environ, "MESH_OPAM_SWITCH": str(switch)},
                            capture_output=True, text=True, check=True)
    observed = json.loads(result.stdout)
    assert observed == {
        "switch": str(switch.resolve() / "_opam" / "bin"),
        "binary": str(switch.resolve() / "_opam" / "bin" / "mesh-board-mcp"),
    }


def test_switch_bin_resolves_named_local_and_prefix_switches(tmp_path):
    prefix = tmp_path / "opam-root" / "named"
    (prefix / "bin").mkdir(parents=True)
    local = tmp_path / "project"
    (local / "_opam" / "bin").mkdir(parents=True)
    (local / "bin").mkdir()
    switch = agentmcp.switch_bin
    assert switch({"MESH_OPAM_SWITCH": str(prefix)}) == prefix.resolve() / "bin"
    assert switch({"MESH_OPAM_SWITCH": str(local)}) == local.resolve() / "_opam" / "bin"
    assert switch({"MESH_OPAM_SWITCH": "named", "OPAMROOT": str(tmp_path / "opam-root")}) == prefix / "bin"


def test_a_configured_switch_without_the_bridge_is_reported_once(tmp_path):
    result = subprocess.run([sys.executable, "-c", """
import agentmcp, launchplan
for _ in range(3):
    launchplan.build("claude"), launchplan.build("codex")
print(agentmcp.board_available())
"""], cwd=Path(__file__).resolve().parent.parent,
                            env={**os.environ, "MESH_OPAM_SWITCH": str(tmp_path)},
                            capture_output=True, text=True, check=True)
    assert result.stdout.strip() == "False"
    assert result.stderr.count("agentmcp: MESH_OPAM_SWITCH=") == 1
    assert "mesh-board-mcp" in result.stderr


def test_injected_configs_are_additive_and_carry_no_session_secret(monkeypatch):
    capability = "a" * 64
    monkeypatch.setenv("MESH_RUNNER_DEMO_CAP", capability)
    claude = agentmcp.inject("claude", ["claude"])
    codex = agentmcp.inject("codex", ["codex"])
    assert json.loads(config_from(claude, "claude")) == {
        "mcpServers": {"mesh-board": {"command": agentmcp.BOARD_MCP, "args": agentmcp.BOARD_MCP_ARGS}}}
    codex = [codex[index + 1] for index, word in enumerate(codex) if word == "-c"]
    assert codex == [
        f'mcp_servers.mesh-board.command={json.dumps(agentmcp.BOARD_MCP)}',
        f'mcp_servers.mesh-board.args={json.dumps(agentmcp.BOARD_MCP_ARGS, separators=(",", ":"))}',
        f'mcp_servers.mesh-board.env_vars={json.dumps(agentmcp.CODEX_ENV_VARS, separators=(",", ":"))}',
    ]
    for argv in (claude, agentmcp.inject("codex", ["codex"])):
        rendered = " ".join(argv)
        assert "MESH_SESSION=" not in rendered
        assert "MeshSession " not in rendered
        assert "ms1." not in rendered
    assert "MESH_SESSION_TOKEN" in " ".join(codex)
    assert agentmcp.CODEX_ENV_VARS == [
        "MESH_SESSION_TOKEN", "MESH_PORT", "MESH_RUNNER_DEMO_CAP"]
    assert "MESH_RUNNER_DEMO_CAP=" not in " ".join(codex)
    assert capability not in " ".join(codex)
    assert capability not in " ".join(claude)
    assert agentmcp.BOARD_MCP == str(agentmcp.board_executable())
    assert agentmcp.BOARD_MCP_ARGS == []
    assert "--strict-mcp-config" not in claude


def test_other_supported_agent_presets_are_plain_interactive_launches_only():
    """No global/project configuration, MCP bridge, or permissive flag is inferred."""
    assert server.AGENT_PRESETS["pi"] == ["pi", "-e", "builtin:mcp"]
    assert "pi" in server.RESUMABLE_AGENT_PRESETS
    # OpenCode: bare argv, its board server and event plugin travel in OPENCODE_CONFIG_CONTENT.
    assert server.AGENT_PRESETS["opencode"] == ["opencode"]
    assert "opencode" in server.RESUMABLE_AGENT_PRESETS
    # Gemini: bare argv, its settings overlay travels in GEMINI_CLI_HOME.
    assert server.AGENT_PRESETS["gemini"] == ["gemini"]
    assert "gemini" in server.RESUMABLE_AGENT_PRESETS
    # Copilot CLI: bare argv, its board server and state plugin are options added at launch (server._copilot_command).
    assert server.AGENT_PRESETS["copilot"] == ["copilot"]
    assert "copilot" in server.RESUMABLE_AGENT_PRESETS


def test_known_agent_identity_is_exposed_separately_from_discovered_resume_agent(monkeypatch):
    monkeypatch.setattr(server.discover, "snapshot", lambda: {})
    monkeypatch.setattr(server.discover, "describe", lambda *_: {"cwd": "/tmp", "cmd": "pi", "agent": None})
    monkeypatch.setattr(server.organize, "view", lambda *_args, **_kwargs: {
        "sessions": {"pi": {"rank": None}}, "folders": []})
    listed = server.list_sessions([{
        "name": "pi", "pid": 1, "created": 1.0, "attached": 0, "activity": 0,
        "meta": {"known_agent": "pi"},
    }])
    [session] = listed["mesh"]
    assert session["known_agent"] == "pi"
    assert session["agent"] is None


def test_new_presets_and_every_resume_shape_add_the_bridge_without_changing_resume_rules():
    for kind in ("claude", "codex"):
        fresh = shlex.split(server.PRESETS[kind])
        resumed = server._resume_argv({"type": kind, "session_id": "S", "argv": [kind, "--model", "x"]})
        assert config_from(fresh, kind) == config_from(resumed, kind)
        assert resumed[:3] == (['claude', '--resume', 'S'] if kind == 'claude' else ['codex', 'resume', 'S'])
        assert resumed == agentmcp.inject(kind, resumeargs.resume_argv(kind, [kind, "--model", "x"], "S"))


def test_only_mesh_built_claude_commands_carry_the_event_hook_configuration():
    fresh = shlex.split(server.PRESETS["claude"])
    resumed = server._resume_argv({"type": "claude", "session_id": "S", "argv": ["claude", "--model", "x"]})
    for argv in (fresh, resumed):
        settings = json.loads(argv[argv.index("--settings") + 1])
        assert settings["tui"] == "default"
        assert settings["hooks"]["Stop"][0]["hooks"][0]["command"] == f"{resumeargs.MESH_EVENT} claude"

    # A non-Mesh argv is never modified merely by importing the command
    # builder, and Codex's notifier is deliberately not installed until its
    # interaction with an existing user notifier is demonstrated.
    outside = ["claude", "--model", "x"]
    assert outside == ["claude", "--model", "x"]
    assert "mesh-event" not in server.PRESETS["codex"]


def test_mesh_built_codex_commands_request_rich_rendering_per_invocation():
    assert "--yolo" not in shlex.split(server.PRESETS["codex"])
    fresh = shlex.split(server.PRESETS["codex-yolo"])
    assert fresh[:2] == ["codex", "--yolo"]
    assert codex_output_option() == "tui.raw_output_mode=false"
    assert codex_output_option() in [
        fresh[index + 1] for index, word in enumerate(fresh[:-1]) if word == "-c"]
    assert output_mode_options(fresh) == [codex_output_option()]


def test_injection_keeps_existing_agent_mcp_configuration_and_shell_quoting():
    original = ["claude", "--mcp-config", '{"mcpServers":{"existing":{"command":"x"}}}']
    argv = server._resume_argv({"type": "claude", "session_id": "S", "argv": original})
    assert argv.count("--mcp-config") == 2
    assert shlex.split(shlex.join(argv)) == argv


@pytest.mark.parametrize("kind", ["claude", "codex"])
def test_repeated_resume_keeps_one_mesh_bridge_and_user_configuration(kind):
    original = shlex.split(server.PRESETS[kind])
    if kind == "claude":
        original += ["--mcp-config", '{"mcpServers":{"user":{"command":"safe"}}}']
    else:
        original += ["--config", 'mcp_servers.user.command="safe"']
    first = server._resume_argv({"type": kind, "session_id": "S", "argv": original})
    second = server._resume_argv({"type": kind, "session_id": "S", "argv": first})
    assert second == first
    if kind == "claude":
        assert second.count(agentmcp._claude_config()) == 1
        assert '{"mcpServers":{"user":{"command":"safe"}}}' in second
        settings = json.loads(second[second.index("--settings") + 1])
        assert len(settings["hooks"]["Stop"]) == 1
    else:
        assert all(second.count(value) == 1 for value in agentmcp._codex_config())
        assert 'mcp_servers.user.command="safe"' in second


def test_claude_multi_value_mcp_flag_preserves_non_mesh_values():
    original = ["claude", "--mcp-config", agentmcp._claude_config(), "user.json", "--model", "opus"]
    result = agentmcp.inject("claude", original)
    assert result[:5] == ["claude", "--mcp-config", "user.json", "--model", "opus"]
    assert result.count(agentmcp._claude_config()) == 1


def test_a_recorded_board_override_is_replaced_by_the_current_bridge(monkeypatch):
    """Codex applies the last value of a repeated key: a recorded board override
    would only half-apply, so every board key is replaced by the current block."""
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    user = 'mcp_servers.mesh-board.args=["exec","--switch=/opt/user-switch","--","mesh-board-mcp"]'
    inherited_env = f'mcp_servers.mesh-board.env_vars={json.dumps(agentmcp.CODEX_ENV_VARS, separators=(",", ":"))}'
    argv = agentmcp.inject("codex", ["codex", "-c", user, "-c", inherited_env])
    assert user not in argv
    assert argv == ["codex", *codex_board()]


# Another installation's board, as its snapshots record it, under neutral names:
# the structure is what restore recognises, never the name.
LEGACY_BIN = "/old/deploy/legacy"
LEGACY_BOARD_MCP = f"{LEGACY_BIN}/_opam/bin/legacy-board-mcp"
LEGACY_CODEX_BOARD = [
    f'mcp_servers.legacy-board.command="{LEGACY_BOARD_MCP}"',
    "mcp_servers.legacy-board.args=[]",
    'mcp_servers.legacy-board.env_vars=["LEGACY_SESSION_TOKEN","LEGACY_PORT","LEGACY_RUNNER_DEMO_CAP"]',
]
LEGACY_CLAUDE_BOARD = json.dumps({"mcpServers": {"legacy-board": {
    "command": LEGACY_BOARD_MCP, "args": []}}}, separators=(",", ":"))
LEGACY_EVENT_HOOK = {"hooks": [{"type": "command", "command": f"{LEGACY_BIN}/bin/legacy-event claude", "timeout": 5}]}
LEGACY_WORDS = ("legacy-board", "legacy-event", "LEGACY_", LEGACY_BIN)


def codex_output_option():
    """The Codex output-mode override Mesh adds, whatever this revision names it."""
    [option] = {getattr(resumeargs, name) for name in ("CODEX_RAW_SCROLLBACK", "CODEX_STANDARD_OUTPUT")
                if hasattr(resumeargs, name)}
    assert option.startswith("tui.raw_output_mode=")
    return option


def other_codex_output_option():
    key, value = codex_output_option().split("=")
    return f"{key}={'false' if value == 'true' else 'true'}"


def output_mode_options(argv):
    return [word for word in argv if word.startswith("tui.raw_output_mode=")]


def codex_board():
    return [word for value in agentmcp._codex_config() for word in ("-c", value)]


def restore(kind, argv):
    return server._resume_argv({"type": kind, "session_id": "S", "argv": argv})


@pytest.mark.parametrize("syntax", [["-c", ""], ["--config="]])
def test_a_codex_snapshot_from_another_installation_restores_with_the_current_bridge_once(monkeypatch, syntax):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    old = [word for value in LEGACY_CODEX_BOARD for word in (*syntax[:-1], syntax[-1] + value)]
    user = 'mcp_servers.user.command="safe"'
    snapshot = ["codex", "resume", "OLD", "--yolo", "-m", "gpt-x", "--no-alt-screen", *old,
                "-c", user, "-c", other_codex_output_option()]
    first = restore("codex", snapshot)
    assert first == ["codex", "resume", "S", "--yolo", "-m", "gpt-x", "--no-alt-screen",
                     "-c", user, "-c", codex_output_option(), *codex_board()]
    assert not any(old in " ".join(first) for old in LEGACY_WORDS)
    assert restore("codex", first) == first


def test_a_codex_board_written_as_one_table_is_recognised():
    table = f'mcp_servers.legacy-board={{command="{LEGACY_BOARD_MCP}",args=[]}}'
    assert agentmcp.strip_board("codex", ["codex", "-c", table, "--model", "x"]) == ["codex", "--model", "x"]


def test_a_codex_board_written_with_attached_values_is_recognised():
    """Codex reads ``-c<value>`` and ``-c=<value>`` like ``-c <value>``."""
    attached = [f"-c{LEGACY_CODEX_BOARD[0]}", f"-c={LEGACY_CODEX_BOARD[1]}", f"-c{LEGACY_CODEX_BOARD[2]}"]
    assert agentmcp.strip_board("codex", ["codex", *attached, "-m", "x"]) == ["codex", "-m", "x"]


# Older installations started their board through opam with an absolute switch,
# with no, two or three inherited environment names.
LEGACY_OPAM_ARGS = ["exec", f"--switch={LEGACY_BIN}", "--", "legacy-board-mcp"]
LEGACY_OPAM_ENVS = [None, ["LEGACY_SESSION_TOKEN", "LEGACY_PORT"],
                    ["LEGACY_SESSION_TOKEN", "LEGACY_PORT", "LEGACY_RUNNER_DEMO_CAP"]]


def compact(value):
    return json.dumps(value, separators=(",", ":"))


def codex_server(name, command, args, env_vars=None):
    keys = [f"command={json.dumps(command)}", f"args={compact(args)}"]
    keys += [f"env_vars={compact(env_vars)}"] if env_vars is not None else []
    return [word for key in keys for word in ("-c", f"mcp_servers.{name}.{key}")]


@pytest.mark.parametrize("env_vars", LEGACY_OPAM_ENVS)
def test_a_codex_opam_board_from_another_installation_is_replaced(monkeypatch, env_vars):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    user = ["-c", 'mcp_servers.user.command="safe"']
    restored = restore("codex", ["codex", *codex_server("legacy-board", "opam", LEGACY_OPAM_ARGS, env_vars), *user])
    assert restored == restore("codex", ["codex", *user]) and restored.count(codex_board()[1]) == 1
    assert not any(old in " ".join(restored) for old in LEGACY_WORDS)


def test_a_claude_opam_board_from_another_installation_is_replaced(monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    board = compact({"mcpServers": {"legacy-board": {"command": "opam", "args": LEGACY_OPAM_ARGS}}})
    restored = restore("claude", ["claude", "--mcp-config", board, "user.json", f"--mcp-config={board}"])
    assert not any(old in " ".join(restored) for old in LEGACY_WORDS)
    assert restored.count(agentmcp._claude_config()) == 1
    assert restored[restored.index("user.json") - 1] == "--mcp-config"


OPAM_LOOKALIKE_ARGS = [
    [*LEGACY_OPAM_ARGS, "--verbose"],                                # another argument
    ["exec", "--switch=relative", "--", "legacy-board-mcp"],         # relative switch
    ["exec", f"--switch={LEGACY_BIN}", "--", "other-board-mcp"],     # another executable
    ["exec", "--", "legacy-board-mcp"],                              # no switch
    ["exec", f"--switch={LEGACY_BIN}", "legacy-board-mcp", "--"],    # reordered
    ["exec", f"--switch={LEGACY_BIN}", "--", f"{LEGACY_BIN}/legacy-board-mcp"],
]


@pytest.mark.parametrize("args", OPAM_LOOKALIKE_ARGS)
def test_a_user_opam_exec_server_with_other_arguments_is_kept(args):
    codex = ["codex", *codex_server("legacy-board", "opam", args, ["LEGACY_SESSION_TOKEN"])]
    assert agentmcp.strip_board("codex", codex) == codex
    claude = ["claude", "--mcp-config", compact({"mcpServers": {"legacy-board": {"command": "opam", "args": args}}})]
    assert agentmcp.strip_board("claude", claude) == claude


ROOT_USER_SERVERS = {"user": {"command": "safe", "args": ["a b", 'q"uote'], "env": {"X": "1"}},
                     "dotted.name": {"command": "/opt/tool", "startup_timeout_sec": 2.5, "enabled": True}}
CONFIG_FORMS = [["-c", ""], ["--config", ""], ["--config="], ["-c="], ["-c"]]  # "-c" alone: -c<value>


def root_override(form, servers):
    value = "mcp_servers=" + json.dumps(servers).replace('": ', '" = ')
    return [*form[:-1], form[-1] + value]


@pytest.mark.parametrize("form", CONFIG_FORMS)
@pytest.mark.parametrize("board", [
    {"legacy-board": {"command": "opam", "args": LEGACY_OPAM_ARGS}},
    {"legacy-board": {"command": LEGACY_BOARD_MCP, "args": []}},
    {agentmcp.SERVER_NAME: {"command": "anything"}},
])
def test_a_codex_root_mcp_servers_override_loses_only_its_board(form, board):
    mixed = agentmcp.strip_board("codex", ["codex", *root_override(form, {**board, **ROOT_USER_SERVERS}), "-m", "x"])
    assert mixed[:len(form)] == ["codex", *form[:-1]] and mixed[-2:] == ["-m", "x"]
    [rewritten] = mixed[len(form):-2]
    assert rewritten.startswith(form[-1] + "mcp_servers=")
    assert tomllib.loads(rewritten[len(form[-1]):])["mcp_servers"] == ROOT_USER_SERVERS
    only_board = ["codex", *root_override(form, board), "-m", "x"]
    assert agentmcp.strip_board("codex", only_board) == ["codex", "-m", "x"]
    untouched = ["codex", *root_override(form, ROOT_USER_SERVERS)]
    assert agentmcp.strip_board("codex", untouched) == untouched


USER_CODEX_SERVERS = {
    "my-board": ['command="/usr/local/bin/my-board"'],
    "board": ['command="/usr/local/bin/board-mcp"'],
    "github": ['command="/usr/local/bin/github-mcp"', 'env_vars=["GITHUB_TOKEN"]'],
    "tool-board": ['command="/usr/local/bin/other-board-mcp"'],
    "relative-board": ['command="bin/relative-board-mcp"'],
    "args-board": ['command="/opt/args-board-mcp"', 'args=["--verbose"]'],
    "env-board": ['command="/opt/env-board-mcp"', 'env_vars=["GITHUB_TOKEN"]'],
    "current-binary": [f"command={json.dumps(agentmcp.BOARD_MCP)}"],
}


def test_user_codex_servers_that_are_not_a_board_are_kept(monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    user = [word for name, keys in USER_CODEX_SERVERS.items()
            for key in keys for word in ("-c", f"mcp_servers.{name}.{key}")]
    assert agentmcp.strip_board("codex", ["codex", *user]) == ["codex", *user]
    assert restore("codex", ["codex", *user])[:len(user) + 3] == ["codex", "resume", "S", *user]


def test_a_user_server_with_the_board_shape_is_the_documented_limit():
    lookalike = ["-c", 'mcp_servers.my-board.command="/usr/local/bin/my-board-mcp"']
    assert agentmcp.strip_board("codex", ["codex", *lookalike]) == ["codex"]


def test_a_claude_snapshot_from_another_installation_restores_with_the_current_bridge_and_hooks(monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    user_hook = {"hooks": [{"type": "command", "command": "/usr/local/bin/user-hook"}]}
    old_hooks = {event: [LEGACY_EVENT_HOOK] for event in resumeargs._CLAUDE_HOOK_EVENTS}
    old_settings = json.dumps({"tui": "default", "hooks": {**old_hooks, "Stop": [user_hook, LEGACY_EVENT_HOOK]}})
    user = '{"mcpServers":{"user":{"command":"safe"}}}'
    snapshot = ["claude", "--dangerously-skip-permissions", "--model", "opus", "--settings", old_settings,
                "--mcp-config", LEGACY_CLAUDE_BOARD, user, f"--mcp-config={LEGACY_CLAUDE_BOARD}"]
    first = restore("claude", snapshot)
    assert not any(old in " ".join(first) for old in LEGACY_WORDS)
    assert first[:6] == ["claude", "--resume", "S", "--dangerously-skip-permissions", "--model", "opus"]
    assert first.count(agentmcp._claude_config()) == 1
    assert ["--mcp-config", user] == first[first.index(user) - 1:first.index(user) + 1]
    settings = json.loads(first[first.index("--settings") + 1])
    current = {"type": "command", "command": f"{resumeargs.MESH_EVENT} claude", "timeout": 5}
    assert settings["hooks"]["Stop"] == [user_hook, {"hooks": [current]}]
    assert settings["hooks"]["PreToolUse"] == [{"hooks": [current]}]
    assert restore("claude", first) == first


def test_a_mixed_claude_mcp_value_keeps_its_other_servers():
    mixed = json.dumps({"mcpServers": {"legacy-board": {"command": LEGACY_BOARD_MCP}, "user": {"command": "safe"}}})
    assert agentmcp.strip_board("claude", ["claude", "--mcp-config", mixed, "user.json"]) == [
        "claude", "--mcp-config", '{"mcpServers":{"user":{"command":"safe"}}}', "user.json"]


def test_user_claude_servers_that_are_not_a_board_are_kept():
    servers = {
        "my-board": {"command": "/usr/local/bin/my-board"},
        "board": {"command": "/usr/local/bin/board-mcp"},
        "github": {"command": "/usr/local/bin/github-mcp", "env": {"GITHUB_TOKEN": "x"}},
        "tool-board": {"command": "/usr/local/bin/other-board-mcp"},
        "relative-board": {"command": "relative-board-mcp"},
        "args-board": {"command": "/opt/args-board-mcp", "args": ["--verbose"]},
        "env-board": {"command": "/opt/env-board-mcp", "env": {"X": "1"}},
    }
    value = json.dumps({"mcpServers": servers})
    assert agentmcp.strip_board("claude", ["claude", "--mcp-config", value]) == ["claude", "--mcp-config", value]


@pytest.mark.parametrize("command", [
    "/usr/local/bin/notify claude",                 # another basename
    "/usr/local/bin/user-event claude --verbose",   # extra argument
    "/usr/local/bin/user-event codex",              # another argument
    "bin/user-event claude",                        # relative path
    "/usr/local/libexec/user-event claude",         # not in a bin/ directory
    "sh -c '/usr/local/bin/user-event claude'",     # wrapper
    "/usr/local/bin/-event claude",                 # no prefix
])
def test_user_hooks_that_are_not_an_event_hook_are_kept(command):
    hook = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
    settings = json.loads(resumeargs.claude_args(["--settings", json.dumps({"hooks": {"Stop": [hook]}})])[1])
    assert settings["hooks"]["Stop"][0] == hook
    assert len(settings["hooks"]["Stop"]) == 2


def test_a_user_hook_with_another_timeout_is_kept():
    hook = {"hooks": [{"type": "command", "command": "/usr/local/bin/user-event claude", "timeout": 30}]}
    settings = json.loads(resumeargs.claude_args(["--settings", json.dumps({"hooks": {"Stop": [hook]}})])[1])
    assert settings["hooks"]["Stop"][0] == hook


@pytest.mark.parametrize("kind", ["claude", "codex"])
def test_a_snapshot_restored_without_the_bridge_carries_no_board_block(monkeypatch, kind):
    monkeypatch.setattr(agentmcp, "board_available", lambda: False)
    if kind == "claude":
        snapshot = ["claude", "--mcp-config", LEGACY_CLAUDE_BOARD, agentmcp._claude_config()]
    else:
        snapshot = ["codex", *[w for v in LEGACY_CODEX_BOARD for w in ("-c", v)], *codex_board()]
    restored = restore(kind, snapshot)
    assert set(snapshot[1:]).difference({"-c", "--mcp-config"}).isdisjoint(restored)
    assert "--mcp-config" not in restored


@pytest.mark.parametrize("preset", ["codex", "codex-yolo"])
def test_fresh_and_restored_codex_carry_one_rich_output_override(preset):
    fresh = launchplan.build(preset).command()
    restored = restore("codex", [*fresh, "-c", other_codex_output_option()])
    for argv in (fresh, restored):
        assert output_mode_options(argv) == [codex_output_option()]
        assert "tui.raw_output_mode=true" not in argv


@pytest.mark.parametrize("kind", ["claude", "codex"])
async def test_adopting_an_external_agent_rebuilds_then_injects_its_mesh_bridge(monkeypatch, tmp_path, kind):
    captured = []

    async def stopped(agent, cwd, command, pi_runtime=None):
        assert pi_runtime is None
        captured.extend((agent, cwd, command))
        return "mesh-agent"

    monkeypatch.setattr(server, "_stop_and_relaunch", stopped)
    target = {"cwd": str(tmp_path), "agent": {"type": kind, "pid": 42, "session_id": "S", "argv": [kind, "--model", "x"]}}
    assert await server.resume_target(target) == "mesh-agent"
    assert shlex.split(captured[2]) == agentmcp.inject(kind, resumeargs.resume_argv(kind, [kind, "--model", "x"], "S"))


@pytest.mark.parametrize("installed", [None, "not-executable", "executable"])
def test_board_bridge_is_injected_only_when_its_executable_is_installed(tmp_path, installed):
    """Without the optional OCaml build, Claude and Codex were still told to start
    mesh-board-mcp: an MCP server that fails at every launch. Pi already refused."""
    switch = tmp_path / "switch"
    binary = switch / "_opam" / "bin" / "mesh-board-mcp"
    if installed:
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o700 if installed == "executable" else 0o600)
    result = subprocess.run([sys.executable, "-c", """
import json
import agentmcp, launchplan
print(json.dumps({kind: launchplan.build(kind).command() for kind in ("claude", "codex")}))
"""], cwd=Path(__file__).resolve().parent.parent,
                            env={**os.environ, "MESH_OPAM_SWITCH": str(switch)},
                            capture_output=True, text=True, check=True)
    for kind, argv in json.loads(result.stdout).items():
        rendered = " ".join(argv)
        assert ("mesh-board" in rendered) == (installed == "executable"), (kind, argv)
        assert argv[0] == kind


def test_binary_installation_uses_its_helpers_without_opam_even_with_spaces(tmp_path):
    directory = tmp_path / "Mesh installation" / "bin"
    directory.mkdir(parents=True)
    for name, output in (("mesh-board-mcp", "bridge-ok"), ("mesh-event", "event-ok"), ("pi", "1.3.0")):
        helper = directory / name
        helper.write_text(f"#!/bin/sh\nprintf '%s' '{output}'\n")
        helper.chmod(0o700)
    result = subprocess.run([sys.executable, "-c", """
import json, subprocess, sys
import agentmcp, launchplan, pimcp, resumeargs
assert agentmcp.board_available()
commands = {kind: launchplan.build(kind).command() for kind in ('claude', 'codex', 'pi')}
hook = resumeargs._mesh_hooks()['hooks']['Stop'][0]['hooks'][0]['command']
_, overlay = pimcp.prepare(sys.argv[1])
print(json.dumps({
    'binary': agentmcp.BOARD_MCP,
    'bridge_result': subprocess.check_output([agentmcp.BOARD_MCP], text=True),
    'hook_result': subprocess.check_output(['/bin/sh', '-c', hook], text=True),
    'commands': commands,
    'pi_config': json.loads((overlay / 'mcp.json').read_text()),
}))
""", str(tmp_path / "config")], cwd=Path(__file__).resolve().parent.parent, env={
        **os.environ, "MESH_BIN_DIR": str(directory), "PATH": str(directory) + ":/usr/bin:/bin",
        "HOME": str(tmp_path), "MESH_OPAM_SWITCH": str(tmp_path / "missing-opam"),
        "OPAM_SWITCH_PREFIX": str(tmp_path / "missing-prefix"),
        "PI_CODING_AGENT_DIR": str(tmp_path / "pi-agent"),
    }, capture_output=True, text=True, check=True)
    observed = json.loads(result.stdout)
    assert observed["binary"] == str(directory / "mesh-board-mcp")
    assert observed["bridge_result"] == "bridge-ok"
    assert observed["hook_result"] == "event-ok"
    claude = json.loads(config_from(observed["commands"]["claude"], "claude"))
    assert claude["mcpServers"]["mesh-board"]["command"] == observed["binary"]
    assert f'mcp_servers.mesh-board.command={json.dumps(observed["binary"])}' in observed["commands"]["codex"]
    assert observed["commands"]["pi"] == ["pi", "-e", "builtin:mcp"]
    assert observed["pi_config"]["mcpServers"]["mesh-board"]["command"] == observed["binary"]


def test_explicit_bundle_directory_never_falls_back_to_a_development_bridge(tmp_path):
    directory = tmp_path / "missing-bundle"
    assert agentmcp.board_executable({"MESH_BIN_DIR": str(directory)}) == directory / "mesh-board-mcp"
    with pytest.raises(ValueError, match="absolute"):
        agentmcp.runtime_bin({"MESH_BIN_DIR": "./bin"})


def test_adjacent_installed_bridge_precedes_development_switch(tmp_path, monkeypatch):
    app = tmp_path / "app"
    app.mkdir()
    directory = app / "bin"
    directory.mkdir()
    (directory / "mesh-board-mcp").touch()
    monkeypatch.setattr(agentmcp, "__file__", str(app / "agentmcp.py"))
    assert agentmcp.board_executable({"MESH_OPAM_SWITCH": "development"}) == directory / "mesh-board-mcp"


def test_bundle_event_hook_is_not_duplicated_when_helper_directory_has_another_name(tmp_path, monkeypatch):
    monkeypatch.setattr(resumeargs, "MESH_EVENT", str(tmp_path / "Mesh helpers" / "mesh-event"))
    first = resumeargs.claude_args()
    second = resumeargs.claude_args(first)
    assert first == second
