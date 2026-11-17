# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Rebuilding an agent's command line for a resume (resumeargs.py)."""

import json
import tomllib

import pytest

import agentmcp
import resumeargs
import server
from resumeargs import CLAUDE_INLINE, CODEX_INLINE, claude_args, codex_args, build_resume_profile, resume_argv

SID = "S"
CODEX_MESH_ARGS = [CODEX_INLINE, "-c", "tui.raw_output_mode=false"]


@pytest.mark.parametrize("argv,expected", [
    # the original prompt is never sent again
    (["claude", "fix the login bug and push"], ["claude", "--resume", SID]),
    (["claude", "--dangerously-skip-permissions", "delete the branches"],
     ["claude", "--resume", SID, "--dangerously-skip-permissions"]),
    # options that shape the session are kept, with their values
    (["claude", "--model", "opus", "--permission-mode", "acceptEdits"],
     ["claude", "--resume", SID, "--model", "opus", "--permission-mode", "acceptEdits"]),
    (["claude", "--model=opus"], ["claude", "--resume", SID, "--model=opus"]),
    # session pickers are dropped, including their optional values
    (["claude", "--teleport", "session_x", "--model", "opus"], ["claude", "--resume", SID, "--model", "opus"]),
    (["claude", "--resume", "--model", "opus"], ["claude", "--resume", SID, "--model", "opus"]),
    (["claude", "-r", "--dangerously-skip-permissions"], ["claude", "--resume", SID, "--dangerously-skip-permissions"]),
    (["claude", "--resume=OLD", "-c"], ["claude", "--resume", SID]),
    (["claude", "--from-pr", "12"], ["claude", "--resume", SID]),
    # -p (print mode) is not an interactive session: dropped with its prompt
    (["claude", "-p", "x"], ["claude", "--resume", SID]),
    # unknown option: reading stops there, options recognised before it are kept
    (["claude", "--frobnicate", "x", "--model", "opus"], ["claude", "--resume", SID]),
    (["claude", "--permission-mode", "plan", "--frobnicate", "x"], ["claude", "--resume", SID, "--permission-mode", "plan"]),
    # variadic options keep all their values (a dropped --disallowedTools value widens permissions)
    (["claude", "--disallowedTools", "Bash", "Edit", "--model", "opus"],
     ["claude", "--resume", SID, "--disallowedTools", "Bash", "Edit", "--model", "opus"]),
    (["claude", "--add-dir", "/a", "/b"], ["claude", "--resume", SID, "--add-dir", "/a", "/b"]),
    (["claude", "--effort", "high", "-n", "work"], ["claude", "--resume", SID, "--effort", "high", "-n", "work"]),
    # not started as `claude …` (e.g. node cli.js)
    (["node", "/usr/bin/claude", "hi"], ["claude", "--resume", SID]),
    # codex
    (["codex", "--yolo", "refactor X"], ["codex", "resume", SID, "--yolo", *CODEX_MESH_ARGS]),
    (["codex", "resume", "OLD", "--yolo"], ["codex", "resume", SID, "--yolo", *CODEX_MESH_ARGS]),
    (["codex", "resume", "--yolo"], ["codex", "resume", SID, "--yolo", *CODEX_MESH_ARGS]),
    (["codex", "resume", "--last", "-m", "o3"], ["codex", "resume", SID, "-m", "o3", *CODEX_MESH_ARGS]),
    (["codex", "-m", "o3", "--no-alt-screen"], ["codex", "resume", SID, "-m", "o3", *CODEX_MESH_ARGS]),
    (["codex", "fork", "abc"], ["codex", "resume", SID, *CODEX_MESH_ARGS]),
    (["codex", "-m", "o3", "review", "x"], ["codex", "resume", SID, *CODEX_MESH_ARGS]),
    (["codex", "--yolo", "review"], ["codex", "resume", SID, *CODEX_MESH_ARGS]),
])
def test_resume_argv(argv, expected):
    kind = "codex" if expected[0] == "codex" else "claude"
    if kind == "claude":   # always inline in the mesh (see CLAUDE_INLINE)
        expected = expected + CLAUDE_INLINE
    assert resume_argv(kind, argv, SID) == expected


def test_mesh_codex_arguments_default_to_rich_rendering_without_touching_global_config():
    assert codex_args() == CODEX_MESH_ARGS
    # A Mesh-resumed Mesh session carries its own setting only once.
    assert codex_args(CODEX_MESH_ARGS) == CODEX_MESH_ARGS
    # A Mesh resume owns this presentation setting; it never relies on the
    # ordering semantics of repeated Codex -c values.
    assert codex_args(["-c", "tui.raw_output_mode=false"]) == CODEX_MESH_ARGS
    assert codex_args(["--config=tui.raw_output_mode = true", "-c", "model_reasoning_effort=high"]) == [
        "-c", "model_reasoning_effort=high", *CODEX_MESH_ARGS]


@pytest.mark.parametrize("entry", [["codex"], ["node", "/approved/@openai/codex/bin/codex.js"]])
@pytest.mark.parametrize("setting", [
    ["-c", "tui.raw_output_mode=true"],
    ["--config", " tui.raw_output_mode = true "],
    ["-c=tui.raw_output_mode=true"],
    ["-ctui.raw_output_mode=true"],          # clap's attached short form
    ["--config=tui.raw_output_mode=true"],
    ["-c", "tui.raw_output_mode=false", "--config=tui.raw_output_mode=true"],
])
def test_resume_normalizes_legacy_raw_output_without_losing_other_options(entry, setting):
    original = [*entry, "resume", "OLD", "--sandbox", "read-only", *setting,
                "--no-alt-screen", "-m", "gpt", "-c", "model_reasoning_effort=high"]
    assert resume_argv("codex", original, SID) == [
        "codex", "resume", SID, "--sandbox", "read-only", "--no-alt-screen", "-m", "gpt",
        "-c", "model_reasoning_effort=high", "-c", "tui.raw_output_mode=false"]


def test_claude_keeps_its_own_settings_instead_of_the_inline_ones():
    # A missing/unreadable user file is preserved byte-for-byte.  The Mesh must
    # never drop settings merely to install an observability hook.
    assert resume_argv("claude", ["claude", "--settings", "/x.json"], SID) == ["claude", "--resume", SID, "--settings", "/x.json"]


def settings_of(argv):
    index = argv.index("--settings")
    return json.loads(argv[index + 1])


def assert_mesh_hooks(settings):
    assert settings["tui"] == "default"
    assert set(settings["hooks"]) == {"UserPromptSubmit", "PreToolUse", "PermissionRequest",
                                       "PostToolUse", "Stop", "StopFailure"}
    for event, entries in settings["hooks"].items():
        assert entries == [{"hooks": [{"type": "command",
                                        "command": f"{resumeargs.MESH_EVENT} claude",
                                        "timeout": 5}]}], event


def test_a_mesh_built_claude_command_has_absolute_per_invocation_hooks():
    argv = ["claude", *claude_args()]
    settings = settings_of(argv)
    assert_mesh_hooks(settings)
    assert "~/.claude" not in repr(argv)
    assert settings["hooks"]["Stop"][0]["hooks"][0]["command"].startswith("/")


def test_a_resume_has_the_same_mesh_hooks():
    argv = resume_argv("claude", ["claude", "--model", "opus"], SID)
    assert argv[:4] == ["claude", "--resume", SID, "--model"]
    assert_mesh_hooks(settings_of(argv))


def test_inline_user_settings_are_preserved_and_their_hooks_precede_meshes():
    user_hook = {"hooks": [{"type": "command", "command": "/usr/local/bin/user-hook"}]}
    supplied = json.dumps({"tui": "fullscreen", "model": "kept", "hooks": {"Stop": [user_hook]}})
    settings = settings_of(resume_argv("claude", ["claude", "--settings", supplied], SID))
    assert settings["tui"] == "fullscreen"
    assert settings["model"] == "kept"
    assert settings["hooks"]["Stop"][0] == user_hook
    assert settings["hooks"]["Stop"][1]["hooks"][0]["command"] == f"{resumeargs.MESH_EVENT} claude"
    assert set(settings["hooks"]) == {"UserPromptSubmit", "PreToolUse", "PermissionRequest",
                                       "PostToolUse", "Stop", "StopFailure"}


def test_a_user_settings_file_is_merged_inline(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text('{"answer":"kept","hooks":{"PreToolUse":[]}}')
    argv = resume_argv("claude", ["claude", "--settings", str(path)], SID)
    assert str(path) not in argv
    settings = settings_of(argv)
    assert settings["answer"] == "kept"
    assert_mesh_hooks(settings)


def test_an_oversized_settings_file_is_not_inlined_even_if_its_stat_would_race(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_bytes(b"{" + b" " * resumeargs._MAX_SETTINGS_BYTES)
    stat_called = False

    def racing_stat(_path):
        nonlocal stat_called
        stat_called = True
        raise AssertionError("settings parsing must not stat before reading")

    monkeypatch.setattr(type(path), "stat", racing_stat)
    argv = resume_argv("claude", ["claude", "--settings", str(path)], SID)
    assert argv == ["claude", "--resume", SID, "--settings", str(path)]
    assert not stat_called


@pytest.mark.parametrize("options", [
    ["--settings", "not-json"],
    ["--settings", '{"hooks":[]}'],
    ["--settings", '{"hooks":{"Stop":{}}}'],
    ["--settings", "{}", "--settings", "{}"],
])
def test_unmergeable_user_settings_are_not_changed_or_supplemented(options):
    argv = resume_argv("claude", ["claude", *options], SID)
    assert argv == ["claude", "--resume", SID, *options]


def test_equals_settings_form_is_merged_and_normalised_once():
    argv = resume_argv("claude", ["claude", '--settings={"tui":"fullscreen"}'], SID)
    assert argv.count("--settings") == 1
    assert not any(item.startswith("--settings=") for item in argv)
    assert settings_of(argv)["tui"] == "fullscreen"


def test_an_identical_user_hook_is_preserved_without_duplicate_execution():
    user_hook = {"hooks": [{"type": "command", "command": f"{resumeargs.MESH_EVENT} claude", "timeout": 5}]}
    supplied = json.dumps({"hooks": {"Stop": [user_hook]}})
    settings = settings_of(resume_argv("claude", ["claude", "--settings", supplied], SID))
    assert settings["hooks"]["Stop"] == [user_hook]


# No installation ever wrote startup_timeout_sec for its board: a server that
# sets it is the user's own.
@pytest.mark.parametrize("extra", ['env={X="1"}', 'cwd="/work"', "startup_timeout_sec=5"])
def test_a_user_codex_server_with_the_board_shape_and_other_keys_is_kept(extra):
    server = ["-c", 'mcp_servers.my-board.command="/x/my-board-mcp"', "-c", f"mcp_servers.my-board.{extra}"]
    assert agentmcp.strip_board("codex", ["codex", *server]) == ["codex", *server]


@pytest.mark.parametrize("env", ["", 'env_vars=["MESH_SESSION_TOKEN"]', 'env_vars=["OLD_SESSION_TOKEN","PATH"]'])
@pytest.mark.parametrize("shape", [
    ['command="/x/old-board-mcp"'],
    ['command="opam"', 'args=["exec","--switch=/s","--","old-board-mcp"]'],
])
def test_recorded_codex_board_shapes_are_still_stripped(shape, env):
    words = [w for v in [*shape, *([env] if env else [])] for w in ("-c", f"mcp_servers.old-board.{v}")]
    assert agentmcp.strip_board("codex", ["codex", *words]) == ["codex"]


@pytest.mark.parametrize("config", ['-cmodel="o3"', '-c=model="o3"'])
def test_codex_attached_short_value_options_keep_what_follows(config):
    saved = ["codex", config, "--sandbox", "read-only", "-a", "untrusted"]
    argv = resume_argv("codex", saved, SID)
    assert argv[:8] == ["codex", "resume", SID, config, "--sandbox", "read-only", "-a", "untrusted"]
    profile = build_resume_profile("codex", saved, "01a10c5c-e967-7102-810c-42ce6de14855")
    assert profile["arguments"][2:6] == [config, "--sandbox", "read-only", "-a"]  # strict path agrees


@pytest.mark.parametrize("attached,expected", [
    ('-mo3', ["-mo3"]), ("-sread-only", ["-sread-only"]), ("-auntrusted", ["-auntrusted"]),
    ("-Cdir", ["-Cdir"]), ("-pwork", ["-pwork"]), ("-iimg.png", []),
])
def test_codex_every_attached_short_value_option_is_read(attached, expected):
    assert resume_argv("codex", ["codex", attached, "--search"], SID)[3:3 + len(expected) + 1] == [*expected, "--search"]


def test_codex_unknown_option_before_a_restrictive_one_refuses_the_resume():
    saved = ["codex", "--model", "o3", "--frobnicate", "--sandbox", "read-only"]
    with pytest.raises(resumeargs.WeakerResume, match="--frobnicate.*--sandbox"):
        resume_argv("codex", saved, SID)
    with pytest.raises(ValueError, match="unknown saved option"):
        resumeargs._kept_options("codex", saved[1:], strict=True)
    # Nothing restrictive follows: the options read so far are kept, as before.
    assert resume_argv("codex", ["codex", "-m", "o3", "--frobnicate", "x", "--search"], SID)[3:6] == [
        "-m", "o3", CODEX_INLINE]


CONVERSATION = "01a10c5c-e967-7102-810c-42ce6de14855"
OLD_BOARD = ['mcp_servers.old-board.command="/x/old-board-mcp"', 'mcp_servers.old-board.env_vars=["OLD_SESSION_TOKEN"]']


def config_words(form, values):
    """values as -c items written in one form Codex accepts."""
    return [w for value in values for w in {"separate": ["-c", value], "long": ["--config", value],
                                             "long=": [f"--config={value}"], "short=": [f"-c={value}"],
                                             "attached": [f"-c{value}"]}[form]]


def test_a_codex_command_mesh_launched_resumes_despite_an_unknown_flag(monkeypatch):
    # The saved argv of a session Mesh started: an option Mesh does not know (a newer
    # Codex flag) precedes the -c items Mesh itself added; they restrict nothing.
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    saved = agentmcp.inject("codex", ["codex", "resume", CONVERSATION, "--future-flag", *codex_args()])
    assert resume_argv("codex", saved, SID)[:3] == ["codex", "resume", SID]


@pytest.mark.parametrize("form", ["separate", "long", "long=", "short=", "attached"])
@pytest.mark.parametrize("values", [
    ["tui.raw_output_mode=true"], ["tui.raw_output_mode=false"], OLD_BOARD, ['model="o3"'],
    [f'mcp_servers.{agentmcp.SERVER_NAME}.command="/elsewhere/x"'],
])
def test_codex_config_mesh_sets_again_or_that_restricts_nothing_does_not_refuse(form, values):
    saved = ["codex", "--future-flag", *config_words(form, values)]
    assert resume_argv("codex", saved, SID)[:3] == ["codex", "resume", SID]


@pytest.mark.parametrize("form", ["separate", "long", "long=", "short=", "attached"])
@pytest.mark.parametrize("values", [
    ['sandbox_mode="read-only"'], ['approval_policy="untrusted"'], ['model_provider="local"'],
    ['mcp_servers.tools.command="/x/tools"'], ["tui.raw_output_mode=false", 'sandbox_mode="read-only"'],
    [*OLD_BOARD, 'model="o3"', 'sandbox_workspace_write.network_access=false'],
    # another key under the board's name is the user's own limit on the board
    [f"mcp_servers.{agentmcp.SERVER_NAME}.disabled_tools=[\"x\"]"],
    [f"mcp_servers.{agentmcp.SERVER_NAME}.enabled_tools=[\"x\"]", *OLD_BOARD],
    [f"mcp_servers.{agentmcp.SERVER_NAME}={{command=\"/x\",disabled_tools=[\"x\"]}}"],
    [f"mcp_servers={{{agentmcp.SERVER_NAME}={{disabled_tools=[\"x\"]}}}}"],
    # a value holding a newline or another control character carries a second setting
    ['model="x"\nsandbox_mode="danger-full-access"'], ["model=x\nsandbox_mode=read-only"],
    ['model="x"\rsandbox_mode="read-only"'], ['tui.raw_output_mode=true\x00'], ['model="o3"\x7f'],
    [f'mcp_servers.{agentmcp.SERVER_NAME}.command="/x"\nsandbox_mode="read-only"'],
])
def test_any_other_codex_config_after_an_unknown_flag_still_refuses(form, values):
    saved = ["codex", "--future-flag", "--no-alt-screen", *config_words(form, values)]
    with pytest.raises(resumeargs.WeakerResume, match="--future-flag.*resume refused"):
        resume_argv("codex", saved, SID)


def test_the_configured_helper_directory_wins_over_the_neighbouring_bin(tmp_path, monkeypatch):
    app, bundle = tmp_path / "app", tmp_path / "bundle"
    for directory in (app / "bin", bundle):
        directory.mkdir(parents=True)
        (directory / "mesh-board-mcp").touch()
    monkeypatch.setattr(agentmcp, "__file__", str(app / "agentmcp.py"))
    environ = {"MESH_BIN_DIR": str(bundle)}
    assert agentmcp.runtime_bin(environ) == bundle.resolve()
    assert agentmcp.board_executable(environ) == bundle.resolve() / "mesh-board-mcp"
    assert agentmcp.runtime_bin({}) == app / "bin"      # the fallback the setting overrides


def resumed_hooks(hooks):
    return settings_of(resume_argv("claude", ["claude", "--settings", json.dumps({"hooks": hooks})], SID))["hooks"]


CURRENT_HOOK = {"type": "command", "command": f"{resumeargs.MESH_EVENT} claude", "timeout": 5}


@pytest.mark.parametrize("hook", [
    {"type": "command", "command": f"{resumeargs.MESH_EVENT} claude", "timeout": 30},
    {"type": "command", "command": f"{resumeargs.MESH_EVENT} claude"},
    {"type": "command", "command": f"{resumeargs.MESH_EVENT} claude", "timeout": 5, "statusMessage": "x"},
])
def test_the_current_helper_is_replaced_whatever_its_timeout_and_keys(hook):
    hooks = resumed_hooks({"Stop": [{"hooks": [hook]}]})
    assert hooks["Stop"] == [{"hooks": [CURRENT_HOOK]}]


@pytest.mark.parametrize("timeout", [{"timeout": 5}, {"timeout": 10}, {}])
def test_another_installation_hooked_on_every_event_is_replaced_whatever_its_timeout(timeout):
    recorded = {"hooks": [{"type": "command", "command": "/old/app/bin/old-event claude", **timeout}]}
    hooks = resumed_hooks({event: [recorded] for event in resumeargs._CLAUDE_HOOK_EVENTS})
    assert hooks == {event: [{"hooks": [CURRENT_HOOK]}] for event in resumeargs._CLAUDE_HOOK_EVENTS}


def test_a_user_event_hook_on_some_events_only_is_kept():
    user = {"hooks": [{"type": "command", "command": "/home/user/bin/notify-event claude", "timeout": 5}]}
    events = resumeargs._CLAUDE_HOOK_EVENTS[:-1]          # every event but one
    hooks = resumed_hooks({event: [user] for event in events})
    for event in events:
        assert hooks[event] == [user, {"hooks": [CURRENT_HOOK]}], event
    assert resumed_hooks({"Stop": [user]})["Stop"] == [user, {"hooks": [CURRENT_HOOK]}]


PLAN_WITHOUT_BASH = ["--permission-mode", "plan", "--disallowedTools", "Bash"]


@pytest.mark.parametrize("worktree", [["-w", "feat"], ["-wfeat"], ["--worktree", "feat"], ["--worktree=feat"], ["-w"]])
def test_a_claude_worktree_session_resumes_with_its_restrictions(worktree):
    argv = resume_argv("claude", ["claude", *worktree, *PLAN_WITHOUT_BASH], SID)
    assert argv[3:8] == ["--permission-mode", "plan", "--disallowedTools", "Bash", "--settings"]


@pytest.mark.parametrize("unknown", [["--frobnicate"], ["--frobnicate", "x"], ["--frobnicate=x"], ["-x"]])
@pytest.mark.parametrize("restriction", [["--permission-mode", "plan"], ["--disallowedTools", "Bash"],
                                         ["--tools=Read"], ["--strict-mcp-config"], ["--settings", "{}"]])
def test_a_claude_unknown_option_before_a_restriction_refuses_the_resume(unknown, restriction):
    with pytest.raises(resumeargs.WeakerResume, match="refused"):
        resume_argv("claude", ["claude", "--model", "opus", *unknown, *restriction], SID)


@pytest.mark.parametrize("attached,expected", [
    (["-nwork"], ["-nwork"]), (["-rOLD"], []), (["-dhooks"], ["-dhooks"]),
    (["-pc"], []), (["-cp", "--verbose"], ["--verbose"]),
])
def test_claude_attached_and_combined_short_options_are_read(attached, expected):
    saved = ["claude", *attached, "--permission-mode", "plan"]
    assert resume_argv("claude", saved, SID)[3:3 + len(expected) + 2] == [*expected, "--permission-mode", "plan"]


def test_a_refused_resume_is_reported_as_a_conflict():
    agent = {"type": "claude", "session_id": SID, "argv": ["claude", "--frobnicate", *PLAN_WITHOUT_BASH]}
    with pytest.raises(server.web.HTTPConflict) as refused:
        server._resume_argv(agent)
    assert "--permission-mode" in refused.value.text


def test_a_kept_option_left_without_its_value_does_not_discard_the_others():
    argv = resume_argv("claude", ["claude", "--permission-mode", "plan", "--model"], SID)
    assert argv[3:6] == ["--permission-mode", "plan", "--settings"]


def test_a_user_limit_on_the_board_survives_the_injection_and_is_not_duplicated(monkeypatch):
    """Codex merges the overrides of one server key by key: Mesh's command, args and
    env_vars are replaced by the injected ones, a ``disabled_tools`` of the user stays
    (once, however many times the command is restored)."""
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    limit = f'mcp_servers.{agentmcp.SERVER_NAME}.disabled_tools=["board_write"]'
    stale = f'mcp_servers.{agentmcp.SERVER_NAME}.command="/elsewhere/x"'
    assert agentmcp.strip_board("codex", ["codex", "-c", limit, "-c", stale]) == ["codex", "-c", limit]
    once = agentmcp.inject("codex", ["codex", "-c", limit, "-c", stale])
    assert once[:3] == ["codex", "-c", limit] and once.count(limit) == 1 and len(once) == 9
    assert agentmcp.inject("codex", once) == once


def test_a_whole_board_table_keeps_only_the_users_extra_keys():
    table = f'mcp_servers.{agentmcp.SERVER_NAME}={{command="/x",disabled_tools=["a"]}}'
    assert agentmcp.strip_board("codex", ["codex", "-c", table]) == [
        "codex", "-c", f'mcp_servers.{agentmcp.SERVER_NAME}={{disabled_tools=["a"]}}']
    root = f'mcp_servers={{{agentmcp.SERVER_NAME}={{command="/x",enabled_tools=["a"]}},t={{command="/t"}}}}'
    assert agentmcp.strip_board("codex", ["codex", "-c", root]) == [
        "codex", "-c", f'mcp_servers={{{agentmcp.SERVER_NAME}={{enabled_tools=["a"]}},t={{command="/t"}}}}']


BOARD = agentmcp.SERVER_NAME
# Keys a crafted snapshot could set to redirect or alter the current board.
BOARD_ESCAPES = ['env={X="1"}', 'cwd="/work"', 'url="http://evil"', 'transport="http"',
                 'bearer_token_env_var="TOK"', "startup_timeout_sec=5", 'command="/x"', 'args=["a"]',
                 'env_vars=["PATH"]', 'env.X="1"']


def board_override(form, text):
    """text (key=value, or {table}) written under the current board's name in one of three forms."""
    if form == "key":
        return f"mcp_servers.{BOARD}.{text}"
    table = "{" + text + "}"
    return f"mcp_servers.{BOARD}={table}" if form == "table" else f"mcp_servers={{{BOARD}={table}}}"


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("escape", BOARD_ESCAPES)
def test_a_snapshot_cannot_keep_a_key_that_alters_the_current_board(form, escape, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    words = ["codex", "-c", board_override(form, escape)]
    assert agentmcp.strip_board("codex", words) == ["codex"]
    injected = agentmcp.inject("codex", words)
    assert injected == agentmcp.inject("codex", ["codex"])


def test_a_url_override_of_the_current_board_is_not_returned_unchanged(monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    injected = agentmcp.inject("codex", ["codex", "-c", f'mcp_servers.{BOARD}.url="http://evil"'])
    assert not any("evil" in word or ".url" in word for word in injected)


# What a user may restrict on the board besides the tool lists (Codex 0.169 McpServerConfig keys).
BOARD_RESTRICTIONS = ['enabled=false', 'default_tools_approval_mode="prompt"',
                      'default_tools_approval_mode="writes"',
                      'tools.board_write.approval_mode="prompt"', 'tools.board_write.approval_mode="writes"']
# Not a restriction: stays stripped under the board's name.
BOARD_NON_RESTRICTIONS = ['tools.board_write.output_token_limit=5', 'tools.board_write.command="/x"',
                          'startup_timeout_sec=5',
                          # loosening values (approve auto-approves, auto is the default), which
                          # Mesh's block does not override
                          'enabled=true', 'default_tools_approval_mode="approve"',
                          'default_tools_approval_mode="auto"',
                          'tools.board_write.approval_mode="approve"', 'tools.board_write.approval_mode="auto"',
                          # wrong types
                          'enabled="false"', 'default_tools_approval_mode=true', 'disabled_tools="board_write"',
                          'disabled_tools=[1]', 'enabled_tools="board_read"', 'enabled_tools=["a",2]',
                          'tools.board_write.approval_mode=1',
                          'tools.board_write={approval_mode="approve"}']


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("limit", ['disabled_tools=["board_write"]', 'enabled_tools=["board_read"]', *BOARD_RESTRICTIONS])
def test_a_tool_limit_on_the_current_board_is_kept_once_and_the_rest_stripped(form, limit, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    words = ["codex", "-c", board_override(form, limit), "-c", board_override("key", 'url="http://evil"')]
    kept = agentmcp.strip_board("codex", words)
    assert kept == ["codex", "-c", board_override(form, limit)]
    once = agentmcp.inject("codex", words)
    assert once.count(board_override(form, limit)) == 1 and not any("evil" in word for word in once)
    assert agentmcp.inject("codex", once) == once


def test_a_table_mixing_limits_and_escapes_keeps_only_the_limits():
    table = f'mcp_servers.{BOARD}={{url="http://evil",disabled_tools=["a"],env={{X="1"}},enabled_tools=["b"]}}'
    assert agentmcp.strip_board("codex", ["codex", "-c", table]) == [
        "codex", "-c", f'mcp_servers.{BOARD}={{disabled_tools=["a"],enabled_tools=["b"]}}']


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("escape", ['url="http://evil"', 'env={X="1"}', 'cwd="/work"', *BOARD_NON_RESTRICTIONS])
def test_a_stripped_board_key_after_an_unknown_option_does_not_refuse(form, escape):
    free = ["codex", "--future-flag", "-c", board_override(form, escape)]
    assert resume_argv("codex", free, SID)[:3] == ["codex", "resume", SID]


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("limit", ['disabled_tools=["x"]', 'enabled_tools=["x"]', *BOARD_RESTRICTIONS])
def test_a_kept_board_limit_after_an_unknown_option_refuses(form, limit):
    limited = ["codex", "--future-flag", "-c", board_override(form, limit)]
    with pytest.raises(resumeargs.WeakerResume, match="--future-flag.*resume refused"):
        resume_argv("codex", limited, SID)


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("extra", BOARD_NON_RESTRICTIONS)
def test_a_tool_key_that_is_not_an_approval_mode_is_stripped_from_the_board(form, extra, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    assert agentmcp.strip_board("codex", ["codex", "-c", board_override(form, extra)]) == ["codex"]


@pytest.mark.parametrize("form", ["key", "table", "root"])
def test_a_tool_table_keeps_only_its_restrictive_approval_mode(form, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    mode = "prompt" if form != "table" else "writes"
    mixed = f'tools.board_write={{approval_mode="{mode}",command="/x"}}'
    kept = f'tools={{board_write={{approval_mode="{mode}"}}}}'
    once = agentmcp.strip_board("codex", ["codex", "-c", board_override(form, mixed)])
    assert once == ["codex", "-c", board_override("table" if form != "root" else "root", kept)]
    assert agentmcp.strip_board("codex", once) == once
    loosening = ["codex", "-c", board_override(form, 'tools.board_write={approval_mode="approve",command="/x"}')]
    assert agentmcp.strip_board("codex", loosening) == ["codex"]


@pytest.mark.parametrize("mode, kept", [("prompt", True), ("writes", True), ("approve", False), ("auto", False)])
def test_a_malformed_dotted_key_is_read_by_its_parts(mode, kept, monkeypatch):
    # "a b" is not a valid bare TOML key: _dotted_key falls back to splitting on dots.
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    assert agentmcp._dotted_key("tools.a b.approval_mode") == ["tools", "a b", "approval_mode"]
    words = ["codex", "-c", f'mcp_servers.{BOARD}.tools.a b.approval_mode="{mode}"']
    assert agentmcp.strip_board("codex", words) == (words if kept else ["codex"])


@pytest.mark.parametrize("name", ["old-board", "other-board"])
@pytest.mark.parametrize("form", ["key", "table", "root"])
def test_a_previous_installation_board_is_still_fully_stripped(name, form):
    command = f'command="/x/{name}-mcp"'
    value = {"key": f"mcp_servers.{name}.{command}", "table": f"mcp_servers.{name}={{{command}}}",
             "root": f"mcp_servers={{{name}={{{command}}}}}"}[form]
    env = f'mcp_servers.{name}.env_vars=["OLD_SESSION_TOKEN"]'
    assert agentmcp.strip_board("codex", ["codex", "-c", value, "-c", env]) == ["codex"]


QUOTED_TOOLS = ['a.b', 'a b', 'say "hi"', 'café', '', "it's", 'back\\slash']


def _tool_override(form, tool, mode):
    return board_override(form, f'tools.{agentmcp._toml_key(tool)}.approval_mode="{mode}"')


@pytest.mark.parametrize("form", ["key", "table", "root"])
@pytest.mark.parametrize("tool", QUOTED_TOOLS)
@pytest.mark.parametrize("mode", ["prompt", "writes"])
def test_a_quoted_tool_name_keeps_its_restrictive_mode(form, tool, mode, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    words = ["codex", "-c", _tool_override(form, tool, mode)]
    kept = agentmcp.strip_board("codex", words)
    assert kept == words
    assert agentmcp.strip_board("codex", kept) == kept
    assert agentmcp.inject("codex", words).count(kept[-1]) == 1
    with pytest.raises(resumeargs.WeakerResume, match="--future-flag.*resume refused"):
        resume_argv("codex", ["codex", "--future-flag", *words[1:]], SID)


@pytest.mark.parametrize("tool", QUOTED_TOOLS)
@pytest.mark.parametrize("mode", ["approve", "auto"])
def test_a_quoted_tool_name_is_stripped_for_a_loosening_mode(tool, mode, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    words = ["codex", "-c", _tool_override("key", tool, mode)]
    assert agentmcp.strip_board("codex", words) == ["codex"]


@pytest.mark.parametrize("tool", QUOTED_TOOLS)
def test_a_quoted_tool_name_is_rewritten_with_its_quoting(tool, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    mixed = f'tools.{agentmcp._toml_key(tool)}={{approval_mode="prompt",command="/x"}}'
    kept = agentmcp.strip_board("codex", ["codex", "-c", board_override("key", mixed)])
    written = f'tools={{{agentmcp._toml_key(tool)}={{approval_mode="prompt"}}}}'
    assert kept == ["codex", "-c", board_override("table", written)]
    assert agentmcp.strip_board("codex", kept) == kept


@pytest.mark.parametrize("tool", QUOTED_TOOLS)
def test_a_kept_quoted_tool_name_is_read_back_unchanged(tool):
    written = f'tools={{{agentmcp._toml_key(tool)}={{approval_mode="prompt"}}}}'
    assert tomllib.loads(f"x={{{written}}}")["x"]["tools"] == {tool: {"approval_mode": "prompt"}}


@pytest.mark.parametrize("tool", ["a=b", "=", "a=", "=b"])
@pytest.mark.parametrize("mode", ["prompt", "writes", "approve"])
def test_a_key_form_override_with_equals_in_a_tool_name_is_kept_as_codex_reads_it(tool, mode, monkeypatch):
    # Codex 0.169 splits a -c item at the first "=": this item fails to load there, so it
    # cannot have started a session.  It is kept verbatim (the resume then fails as well),
    # never dropped, whatever mode it carries.
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    for name in (BOARD, "other"):
        words = ["codex", "-c", f'mcp_servers.{name}.tools."{tool}".approval_mode="{mode}"']
        assert agentmcp.strip_board("codex", words) == words
        assert agentmcp.without_free_codex_config(words) == words


@pytest.mark.parametrize("tool", ["a=b", "="])
def test_a_table_form_override_with_equals_in_a_tool_name_keeps_its_restrictive_mode(tool, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda: True)
    for form in ("table", "root"):
        words = ["codex", "-c", _tool_override(form, tool, "prompt")]
        assert agentmcp.strip_board("codex", words) == words
