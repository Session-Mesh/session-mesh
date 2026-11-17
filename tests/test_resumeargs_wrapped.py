# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Resuming an agent that was launched through a wrapper."""

import shlex

import pytest

import agentmcp
import launchplan
import resumeargs
import server
from resumeargs import CLAUDE_INLINE, claude_args, codex_args, entry_args, resume_argv

SID = "S"
CLI = "/home/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"
CODEX_JS = "/usr/lib/node_modules/@openai/codex/bin/codex.js"
NATIVE = "/home/u/.local/share/claude/versions/2.1.283"
BARE_CLAUDE = ["claude", "--resume", SID, *CLAUDE_INLINE]
BARE_CODEX = ["codex", "resume", SID, *codex_args()]


def kept_claude(*options):
    return ["claude", "--resume", SID, *claude_args(options)]


@pytest.mark.parametrize("argv,expected", [
    # direct binary, by path or by name
    (["claude", "--model", "opus"], kept_claude("--model", "opus")),
    (["/usr/local/bin/claude", "--model", "opus"], kept_claude("--model", "opus")),
    # node running claude's JS
    (["node", CLI, "--model", "opus", "--allow-dangerously-skip-permissions"],
     kept_claude("--model", "opus", "--allow-dangerously-skip-permissions")),
    (["/usr/bin/node", CLI, "--settings", '{"tui":"x"}'], kept_claude("--settings", '{"tui":"x"}')),
    (["nodejs", CLI, "fix the tests"], kept_claude()),
    # claude's native binary under its version number
    ([NATIVE, "--model", "opus"], kept_claude("--model", "opus")),
    # npx / bunx
    (["npx", "@anthropic-ai/claude-code", "--model", "opus"], kept_claude("--model", "opus")),
    (["npx", "-y", "@anthropic-ai/claude-code@latest", "--model", "opus"], kept_claude("--model", "opus")),
    (["bunx", "--yes", "@anthropic-ai/claude-code@1.2.3", "--dangerously-skip-permissions"],
     kept_claude("--dangerously-skip-permissions")),
    # an old session id, -r and --continue are dropped through the wrapper as well
    (["node", CLI, "--resume", "OLD", "--model", "opus"], kept_claude("--model", "opus")),
    (["node", CLI, "-r", "--model", "opus"], kept_claude("--model", "opus")),
    (["node", CLI, "--continue", "--model", "opus"], kept_claude("--model", "opus")),
    (["npx", "@anthropic-ai/claude-code", "-c"], kept_claude()),
    # a restrictive option is still kept; an unknown option still stops the reading
    (["node", CLI, "--disallowedTools", "Bash", "--frobnicate", "x", "--model", "opus"],
     kept_claude("--disallowedTools", "Bash")),
])
def test_recognised_claude_shapes_keep_their_options(argv, expected):
    assert resume_argv("claude", argv, SID) == expected


@pytest.mark.parametrize("argv", [
    # a shell wrapper: its arguments may be its own, whatever they look like
    ["/bin/sh", "/home/u/bin/claude-work", "--model", "opus"],
    ["bash", "/home/u/bin/claude", "--model", "opus"],
    ["/bin/sh", "-c", "claude --model opus"],
    # node running something else, or a claude-looking script outside the package
    ["node", "/usr/bin/claude", "--model", "opus"],
    ["node", "/tmp/evil/cli.js", "--model", "opus"],
    ["node", "/tmp/claude-code/cli.js", "--model", "opus"],
    ["node", "/opt/@anthropic-ai/claude-code/other.js", "--model", "opus"],
    ["node", "@anthropic-ai/claude-code/cli.js", "--model", "opus"],       # relative path
    ["node", "--inspect", CLI, "--model", "opus"],                         # node options: not read
    ["node", CODEX_JS, "--model", "opus"],                                 # the other agent's entry
    # npx of something else or with options we do not know
    ["npx", "some-other-package", "--model", "opus"],
    ["npx", "-p", "foo", "@anthropic-ai/claude-code", "--model", "opus"],
    ["npx", "@anthropic-ai/claude-code-evil", "--model", "opus"],
    ["npx", "@anthropic-ai/claude-code@1;rm", "--model", "opus"],
    ["npx", "claude", "--model", "opus"],
    # a number-named binary outside claude's versions directory, or a relative one
    ["/tmp/2.1.283", "--model", "opus"],
    ["claude/versions/2.1.283", "--model", "opus"],
    ["/home/u/.local/share/claude/versions/latest", "--model", "opus"],
    ["env", "FOO=1", "claude", "--model", "opus"],
    ["sudo", "claude", "--model", "opus"],
    [],
    [""],
])
def test_unrecognised_shapes_fall_back_to_the_bare_resume(argv):
    assert entry_args("claude", argv) is None
    assert resume_argv("claude", argv, SID) == BARE_CLAUDE


@pytest.mark.parametrize("argv,expected", [
    (["node", CODEX_JS, "--yolo", "-m", "gpt"], ["codex", "resume", SID, "--yolo", "-m", "gpt", *codex_args()]),
    (["node", CODEX_JS, "resume", "OLD", "--yolo"], ["codex", "resume", SID, "--yolo", *codex_args()]),
    (["npx", "-y", "@openai/codex@latest", "--yolo"], ["codex", "resume", SID, "--yolo", *codex_args()]),
    (["codex", "resume", "OLD", "--yolo"], ["codex", "resume", SID, "--yolo", *codex_args()]),
    # a non-interactive subcommand through the wrapper is not resumed with its options
    (["node", CODEX_JS, "review", "do it"], BARE_CODEX),
    (["npx", "@openai/codex", "--yolo", "review"], BARE_CODEX),
    # unknown wrappers
    (["/bin/sh", "/home/u/bin/codex-yolo", "--yolo"], BARE_CODEX),
    (["node", CLI, "--yolo"], BARE_CODEX),                                  # claude's entry for codex
    (["npx", "@anthropic-ai/claude-code", "--yolo"], BARE_CODEX),
])
def test_codex_shapes(argv, expected):
    assert resume_argv("codex", argv, SID) == expected


# ---------------------------------------------------------------- hostile argv

HOSTILE = 'x"; touch /tmp/pwned; $(id) `id` \'q\'\nline2 && rm -rf ~'


@pytest.mark.parametrize("prefix", [["node", CLI], ["npx", "-y", "@anthropic-ai/claude-code"], ["claude"]])
def test_hostile_values_stay_one_word_each(prefix):
    argv = [*prefix, "--append-system-prompt", HOSTILE, "--add-dir", "a b;c", "--model", "o|p"]
    out = resume_argv("claude", argv, SID)
    assert out == kept_claude("--append-system-prompt", HOSTILE, "--add-dir", "a b;c", "--model", "o|p")
    assert shlex.split(shlex.join(out)) == out


def test_a_fake_resume_inside_a_value_is_neither_dropped_nor_a_second_resume():
    argv = ["node", CLI, "--append-system-prompt", "--resume EVIL", "--model", "--resume"]
    out = resume_argv("claude", argv, SID)
    assert out == kept_claude("--append-system-prompt", "--resume EVIL", "--model", "--resume")
    assert out.count("--resume") == 2 and out[1:3] == ["--resume", SID]   # ours first; the user's is a value
    assert shlex.split(shlex.join(out))[1:3] == ["--resume", SID]


def test_a_hostile_entry_path_is_never_carried_into_the_command():
    script = "/tmp/$(touch pwned)/@anthropic-ai/claude-code/cli.js"
    out = resume_argv("claude", ["node", script, "--model", "opus"], SID)
    assert out == kept_claude("--model", "opus")
    assert all("pwned" not in word for word in out)
    # the interpreter's own path is only read for its basename, never carried
    out = resume_argv("claude", ["/tmp/$(id)/node", CLI, "--model", "opus"], SID)
    assert out == kept_claude("--model", "opus") and not any("$(id)" in word for word in out)
    assert resume_argv("claude", ["/tmp/$(id)/sh", CLI, "--model", "opus"], SID) == BARE_CLAUDE


def test_a_prompt_after_a_wrapped_entry_is_not_replayed():
    out = resume_argv("claude", ["node", CLI, "--model", "opus", "ship it; rm -rf /"], SID)
    assert "ship it; rm -rf /" not in out


def test_newline_in_a_prompt_and_in_a_dropped_value():
    out = resume_argv("claude", ["node", CLI, "--session-id", "a\nb", "--model", "opus", "p\nq"], SID)
    assert out == kept_claude("--model", "opus")


# ------------------------------------------- bare fallbacks never drop a restriction

@pytest.mark.parametrize("kind,argv,restriction", [
    ("claude", ["/usr/bin/env", "claude", "--permission-mode", "plan"], "--permission-mode"),
    ("claude", ["/bin/sh", "/home/u/bin/claude-work", "--disallowedTools=Bash"], "--disallowedTools"),
    ("codex", ["/usr/bin/env", "codex", "--sandbox", "read-only"], "--sandbox"),
    ("codex", ["/bin/sh", "/home/u/bin/codex-safe", "-sread-only"], "-s"),
    ("codex", ["/bin/sh", "/home/u/bin/codex-safe", "--ask-for-approval=untrusted"], "--ask-for-approval"),
    ("codex", ["codex", "--sandbox", "read-only", "review"], "--sandbox"),
    ("codex", ["node", CODEX_JS, "review", "-a", "untrusted"], "-a"),
])
def test_a_bare_fallback_refuses_when_an_unread_word_is_restrictive(kind, argv, restriction):
    with pytest.raises(resumeargs.WeakerResume, match=f"names {restriction}: resume refused"):
        resume_argv(kind, argv, SID)


@pytest.mark.parametrize("argv", [
    ["codex", "exec", "--sandbox", "read-only"],
    ["codex", "--sandbox", "read-only", "exec", "p"],
    ["codex", "exec", "do it"],
    ["codex", "-m", "o3", "e", "x"],
    ["node", CODEX_JS, "exec", "do it"],
    ["npx", "@openai/codex", "exec", "do it"],
])
def test_a_codex_exec_session_is_never_resumed(argv):
    with pytest.raises(resumeargs.WeakerResume, match="codex exec, which is not interactive"):
        resume_argv("codex", argv, SID)


def test_a_shell_command_string_is_read_as_the_command_it_carries():
    # the shell's own -c is no longer mistaken for Codex's restrictive --config
    agent = {"type": "codex", "session_id": SID, "argv": ["/bin/sh", "-c", "codex --yolo"]}
    assert server._resume_argv(agent)[:3] == ["codex", "resume", SID]
    assert "-c" not in server._resume_argv(agent)[:4]


@pytest.mark.parametrize("kind,argv,restriction", [
    ("claude", ["/bin/sh", "-c", "claude --permission-mode plan"], "--permission-mode"),
    ("codex", ["bash", "-lc", "codex --sandbox read-only"], "--sandbox"),
    ("codex", ["/bin/zsh", "-ic", "codex -a untrusted"], "-a"),
    ("claude", ["sh", "-c", "claude --model x --disallowedTools=Bash"], "--disallowedTools"),
])
def test_a_shell_command_string_is_scanned_for_restrictions(kind, argv, restriction):
    with pytest.raises(resumeargs.WeakerResume, match=f"names {restriction}: resume refused"):
        resume_argv(kind, argv, SID)


@pytest.mark.parametrize("kind,argv", [
    ("claude", ["sh", "-c", "claude --model x"]),
    ("codex", ["/bin/sh", "-c", 'codex "use -s"']),
    ("claude", ["bash", "-c", "claude 'fix --permission-mode plan'"]),
])
def test_a_shell_command_string_without_a_restriction_still_resumes(kind, argv):
    assert resume_argv(kind, argv, SID) == (BARE_CLAUDE if kind == "claude" else BARE_CODEX)


@pytest.mark.parametrize("kind", ["claude", "codex"])
def test_a_shell_command_string_with_broken_quoting_is_refused(kind):
    with pytest.raises(resumeargs.WeakerResume, match="cannot parse"):
        resume_argv(kind, ["sh", "-c", f'{kind} "unterminated --model x'], SID)


@pytest.mark.parametrize("kind,argv", [
    ("claude", ["/bin/sh", "/home/u/bin/claude-work", "--model", "opus", "fix it"]),
    ("codex", ["/bin/sh", "/home/u/bin/codex-yolo", "--yolo", "-m", "o3"]),
    ("codex", ["codex", "--yolo", "review"]),
])
def test_a_bare_fallback_without_a_restriction_still_resumes(kind, argv):
    assert resume_argv(kind, argv, SID) == (BARE_CLAUDE if kind == "claude" else BARE_CODEX)


# --------------------------------------------------- options that bound the agent

@pytest.mark.parametrize("kind,restriction", [
    ("claude", ["--agent", "reviewer"]), ("claude", ["--agents", '{"r":{}}']),
    ("claude", ["--plugin-dir", "/p"]), ("claude", ["--plugin-url=https://x/p.zip"]),
    ("codex", ["-C", "/work"]), ("codex", ["--cd", "/work"]), ("codex", ["-C/work"]),
])
def test_agent_plugin_and_directory_options_are_restrictive(kind, restriction):
    with pytest.raises(resumeargs.WeakerResume, match="refused"):
        resume_argv(kind, [kind, "--frobnicate", *restriction], SID)
    assert resume_argv(kind, [kind, *restriction], SID)[3:3 + len(restriction)] == restriction


@pytest.mark.parametrize("kind,options,kept", [
    ("claude", ["--permission-prompt-tool", "mcp__x__ask"], []),
    ("codex", ["--remote", "ws://h:1"], ["--remote", "ws://h:1"]),
    ("codex", ["--remote-auth-token-env", "TOKEN"], ["--remote-auth-token-env", "TOKEN"]),
    ("codex", ["--worktree"], []),
    ("codex", ["--dangerously-bypass-hook-trust"], ["--dangerously-bypass-hook-trust"]),
])
def test_newly_listed_options_no_longer_refuse_a_restricted_resume(kind, options, kept):
    restriction = ["--permission-mode", "plan"] if kind == "claude" else ["--sandbox", "read-only"]
    out = resume_argv(kind, [kind, *options, *restriction, "prompt"], SID)
    assert out[3:3 + len(kept) + 2] == [*kept, *restriction]
    assert "prompt" not in out


@pytest.mark.parametrize("preset", sorted(p for p in launchplan.catalogue()
                                          if launchplan.agent_type(p) in ("claude", "codex")))
@pytest.mark.parametrize("board", [False, True])
def test_every_mesh_preset_resumes_without_refusal(preset, board, monkeypatch):
    monkeypatch.setattr(agentmcp, "board_available", lambda *_: board)
    kind = launchplan.agent_type(preset)
    argv = launchplan.build(preset).command()
    assert ("--mcp-config" in argv or any(word.startswith("mcp_servers.") for word in argv)) == board
    head = ["claude", "--resume", SID] if kind == "claude" else ["codex", "resume", SID]
    assert resume_argv(kind, argv, SID)[:3] == head
    assert resumeargs.build_resume_profile(kind, argv, "01a10c5c-e967-7102-810c-42ce6de14855")["kind"] == kind


@pytest.mark.parametrize("argv", [
    ["bash", "--login", "-c", "claude --permission-mode plan"],
    ["bash", "-o", "pipefail", "-c", "claude --permission-mode plan"],
    ["bash", "-c", "-e", "claude --permission-mode plan"],
    ["env", "bash", "-c", "claude --permission-mode plan"],
    ["timeout", "1h", "sh", "-c", "claude --permission-mode plan"],
])
def test_a_shell_string_behind_an_unread_launcher_shape_is_scanned(argv):
    with pytest.raises(resumeargs.WeakerResume, match="names --permission-mode: resume refused"):
        resume_argv("claude", argv, SID)


def test_a_broken_shell_string_behind_an_unread_launcher_shape_is_refused():
    with pytest.raises(resumeargs.WeakerResume, match="cannot parse"):
        resume_argv("claude", ["env", "bash", "-c", "claude 'unterminated"], SID)


@pytest.mark.parametrize("argv", [
    ["env", "bash", "-c", "claude --model opus"],
    ["timeout", "1h", "claude", "fix the --sandbox flag handling"],
])
def test_an_unread_launcher_without_a_restriction_still_resumes(argv):
    assert resume_argv("claude", argv, SID) == BARE_CLAUDE


@pytest.mark.parametrize("subcommand", ["doctor", "agents", "plugin", "app-server", "remote-control",
                                        "update", "features", "archive"])
def test_current_codex_subcommands_take_the_subcommand_path(subcommand):
    assert resume_argv("codex", ["codex", subcommand], SID) == BARE_CODEX
    with pytest.raises(resumeargs.WeakerResume, match="names --sandbox"):
        resume_argv("codex", ["codex", subcommand, "--sandbox", "read-only"], SID)
