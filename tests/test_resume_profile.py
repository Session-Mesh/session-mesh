# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Runner-local immutable resume inputs, never a client command interface."""

import hashlib
import json

import pytest

from resumeargs import WeakerResume, build_resume_profile, build_resume_snapshot, resume_argv

SID = "01a10c5c-e967-7102-810c-42ce6de14855"


@pytest.mark.parametrize("kind", ["claude", "codex"])
def test_profile_reuses_resume_builder_without_prompt_or_executable(kind):
    profile = build_resume_profile(kind, [kind, "ORIGINAL_PROMPT_NOT_REPLAYED"], SID)
    args = profile["arguments"]
    assert args[:2] == (["--resume", SID] if kind == "claude" else ["resume", SID])
    assert "ORIGINAL_PROMPT_NOT_REPLAYED" not in args
    assert kind not in args
    assert set(profile) == {"version", "kind", "conversationId", "arguments", "fingerprint"}
    canonical = {key: value for key, value in profile.items() if key != "fingerprint"}
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    assert profile["fingerprint"] == hashlib.sha256(encoded).hexdigest()


def test_profile_retains_restrictive_known_options():
    profile = build_resume_profile("claude", ["claude", "--permission-mode", "plan"], SID)
    assert profile["arguments"][:4] == ["--resume", SID, "--permission-mode", "plan"]
    assert "evil" not in profile["arguments"]


def test_codex_profile_normalizes_legacy_raw_output_to_rich_rendering():
    profile = build_resume_profile("codex", ["codex", "--sandbox", "read-only",
                                           "-c", "tui.raw_output_mode=true"], SID)
    assert profile["arguments"] == ["resume", SID, "--sandbox", "read-only",
                                      "--no-alt-screen", "-c", "tui.raw_output_mode=false"]


@pytest.mark.parametrize("argv", [
    ["claude", "--unknown", "value", "--permission-mode", "plan"],
    ["/unrecognized/wrapper", "--permission-mode", "plan"],
    ["claude", "--permission-mode", "plan", "--unknown", "evil"],
])
def test_remote_profile_refuses_ambiguous_options_or_wrapper(argv):
    with pytest.raises(ValueError):
        build_resume_profile("claude", argv, SID)


def test_local_resume_keeps_historical_unknown_option_and_wrapper_fallback():
    args = resume_argv("claude", ["claude", "--permission-mode", "plan", "--unknown", "value"], SID)
    assert args[:5] == ["claude", "--resume", SID, "--permission-mode", "plan"]
    assert resume_argv("claude", ["/unrecognized/wrapper", "--model", "opus"], SID)[:3] == ["claude", "--resume", SID]
    # a restriction behind the wrapper is never dropped by the bare resume
    with pytest.raises(WeakerResume, match="--permission-mode"):
        resume_argv("claude", ["/unrecognized/wrapper", "--permission-mode", "plan"], SID)


@pytest.mark.parametrize("kind,argv", [
    ("codex", ["codex", "--unknown", "value", "--sandbox", "read-only"]),
    ("codex", ["codex", "exec", "--sandbox", "read-only"]),
    ("claude", ["claude", "--permission-mode"]),
    ("claude", ["claude", "--permission-mode", "--verbose"]),
    ("claude", ["claude", "--verbose=unexpected"]),
])
def test_remote_profile_refuses_incomplete_or_noninteractive_shapes(kind, argv):
    with pytest.raises(ValueError):
        build_resume_profile(kind, argv, SID)


def test_remote_profile_accepts_known_node_entry_and_preserves_restriction():
    profile = build_resume_profile("claude", ["node", "/approved/@anthropic-ai/claude-code/cli.js", "--permission-mode", "plan"], SID)
    assert profile["arguments"][:4] == ["--resume", SID, "--permission-mode", "plan"]


@pytest.mark.parametrize("sid", ["", "--resume", "../other", SID.upper(), SID + "\n", "0" * 32, "00000000-0000-0000-0000-000000000000", 3, None])
def test_noncanonical_or_nil_conversation_ids_refuse(sid):
    with pytest.raises(ValueError):
        build_resume_profile("codex", ["codex"], sid)


@pytest.mark.parametrize("kind,argv", [("shell", ["shell"]), ("codex", "codex"), ("claude", ["claude", "x\0y"]), ("codex", ["codex", 3])])
def test_closed_kind_and_bounded_saved_arguments(kind, argv):
    with pytest.raises(ValueError):
        build_resume_profile(kind, argv, SID)


def saved():
    return {"source": "canonical-metadata-from-inventory", "receipt": "a" * 64 + ":0000000000000001",
            "cwd": "/owned/private/project", "kind": "codex", "conversationId": SID,
            "savedArgv": ["/approved/codex", "ORIGINAL_PROMPT_NOT_REPLAYED"]}


def test_snapshot_exec_configuration_is_separate_from_saved_argv():
    launchers = {"codex": {"executable": {"path": "/approved/codex", "sha256": "a" * 64},
                           "entrypoint": [], "environment": ["HOME=/owned/home"]}}
    snapshot = build_resume_snapshot(launchers, [saved()])
    assert snapshot["launchers"] == launchers
    assert "/untrusted/launcher" not in snapshot["presets"][0]["profile"]["arguments"]
    assert "ORIGINAL_PROMPT_NOT_REPLAYED" not in snapshot["presets"][0]["profile"]["arguments"]
    launchers["codex"]["executable"]["path"] = "/changed"
    assert snapshot["launchers"]["codex"]["executable"]["path"] == "/approved/codex"


@pytest.mark.parametrize("changes", [{"executable": "/bin/sh"}, {"argv": ["/bin/sh"]},
                                     {"kind": "claude"}, {"receipt": "../receipt"}])
def test_snapshot_rejects_descriptor_exec_and_unknown_fields(changes):
    with pytest.raises(ValueError):
        build_resume_snapshot({"codex": {}}, [{**saved(), **changes}])


def test_snapshot_rejects_duplicate_old_receipts():
    with pytest.raises(ValueError):
        build_resume_snapshot({"codex": {}}, [saved(), saved()])
