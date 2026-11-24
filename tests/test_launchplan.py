# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Known agent launch vectors are code-owned and never shell fragments."""

import pytest
import agentcap
import agentmcp
import launchplan
import resumeargs


@pytest.mark.parametrize("token", ["-anever", "-a=never", "-sdanger-full-access",
                                    "-s=danger-full-access", "-capproval_policy=" + "never"])
def test_attached_forbidden_codex_options_are_refused(token):
    assert launchplan.refusal("codex", [token])


def test_safe_codex_approval_option_is_accepted():
    assert launchplan.refusal("codex", ["--ask-for-approval", "on-request"]) is None


@pytest.mark.parametrize("options", [["hello", "--yolo"], ["hello", "-a", "never"],
                                      ["hello", "--config", "sandbox_mode=danger-full-access"]])
def test_refuses_bypass_options_after_a_positional_word(options):
    assert launchplan.refusal("codex", options)


def test_allows_safe_options_after_a_positional_word():
    assert launchplan.refusal("codex", ["hello", "--ask-for-approval", "on-request"]) is None

def test_catalogue_vectors_preserve_existing_fresh_agent_behavior():
    assert launchplan.build("claude").command() == agentmcp.inject(
        "claude", ["claude", *resumeargs.claude_args()])
    assert launchplan.build("codex").command() == agentmcp.inject(
        "codex", ["codex", *resumeargs.codex_args()])
    assert launchplan.build("codex-yolo").command() == agentmcp.inject(
        "codex", ["codex", "--yolo", *resumeargs.codex_args()])
    assert launchplan.agent_type("codex-yolo") == launchplan.agent_type("codex") == "codex"
    assert launchplan.build("pi").command() == ["pi", "-e", "builtin:mcp"]
    assert launchplan.build("opencode").command() == ["opencode"]
    assert launchplan.build("gemini").command() == ["gemini"]
    for kind in ("copilot",):
        assert launchplan.build(kind).command() == [kind]


@pytest.mark.parametrize("kind", ["codex", "codex-yolo"])
def test_fresh_codex_uses_rich_output_in_the_normal_terminal_buffer(kind):
    argv = launchplan.build(kind).command()
    assert "--no-alt-screen" in argv
    assert "tui.raw_output_mode=false" in argv
    assert "tui.raw_output_mode=true" not in argv


def test_catalogue_is_exact_and_has_no_shell_or_fallback_command():
    catalogue = launchplan.catalogue()
    assert set(catalogue) == {*agentcap.MATRIX, "codex-yolo"}
    assert all(plan[0] == launchplan.agent_type(kind) and "/bin/sh" not in plan and "sh" not in plan
               for kind, plan in catalogue.items())
    with pytest.raises(launchplan.InvalidLaunchPlan, match="unknown Mesh agent"):
        launchplan.build("unknown")


@pytest.mark.parametrize("kind,argv", [
    ("claude", ("codex",)),
    ("codex", ("codex", "")),
    ("pi", ("pi", "unsafe\0argument")),
    ("pi", ["pi"]),
    ([], ("pi",)),
])
def test_plan_refuses_a_missing_or_mismatched_executable_and_invalid_argv(kind, argv):
    with pytest.raises(launchplan.InvalidLaunchPlan):
        launchplan.LaunchPlan(kind, argv)
