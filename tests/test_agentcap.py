# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import pytest

import agentcap
import server


def test_static_capability_matrix_is_complete_and_matches_launch_catalogue():
    assert set(agentcap.MATRIX) == server.AGENT_TYPES
    assert {name: {feature.value: state.value for feature, state in row.items()}
            for name, row in agentcap.MATRIX.items()} == {
        name: {
            "board_mcp": "supported" if name in ("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe") else "unavailable",
            "history": "supported" if name in ("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe") else "unavailable",
            "resume": "supported" if name in ("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe") else "unavailable",
            "structured_output": "unknown",
        }
        for name in ("claude", "codex", "opencode", "agy", "copilot", "gemini", "pi", "vibe")
    }
    assert all(set(row) == set(agentcap.Feature) for row in agentcap.MATRIX.values())


def test_resume_allowlist_is_derived_from_capabilities():
    assert server.RESUMABLE_AGENT_PRESETS == frozenset(
        name for name in agentcap.MATRIX
        if agentcap.status(name, agentcap.Feature.RESUME) is agentcap.Status.SUPPORTED
    )


def test_unknown_agent_feature_and_status_fail_closed():
    for agent, feature in (("other", agentcap.Feature.RESUME), ("claude", "other"),
                           ("claude", agentcap.Feature.STRUCTURED_OUTPUT)):
        with pytest.raises(agentcap.UnsupportedCapability):
            agentcap.require_supported(agent, feature)
