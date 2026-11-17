# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A resumed Claude command and Claude's messaging socket (claudewake).

The mesh gives a session a socket at launch (claudewake.launch_command) and
never writes ``crossSessionInbound``.  A resume therefore drops the recorded
socket option, whatever its value, and leaves the user's setting alone; the
launch then decides again, for the new incarnation."""

import json

import pytest

from resumeargs import claude_args, resume_argv

SID = "S"
MESH_SOCKET = "/run/user/1000/session-mesh/claude-wake/0123456789abcdef0123.sock"


def settings_of(argv):
    return json.loads(argv[argv.index("--settings") + 1])


@pytest.mark.parametrize("socket_words", [["--messaging-socket-path", MESH_SOCKET],
                                          [f"--messaging-socket-path={MESH_SOCKET}"],
                                          ["--messaging-socket-path", "/elsewhere/s.sock"]])
@pytest.mark.parametrize("restriction", [["--permission-mode", "plan"], ["--disallowedTools", "Bash"],
                                         ["--settings", '{"model":"x"}']])
def test_a_resume_drops_the_socket_option_and_keeps_the_restriction(socket_words, restriction):
    argv = resume_argv("claude", ["claude", *socket_words, *restriction], SID)
    assert not any(word.startswith("--messaging-socket-path") for word in argv)
    assert restriction[0] in argv


@pytest.mark.parametrize("value", ["accept", "hold", "refuse"])
def test_a_resume_keeps_the_users_crosssessioninbound_unchanged(value):
    saved = ["claude", "--messaging-socket-path", MESH_SOCKET,
             "--settings", json.dumps({"crossSessionInbound": value})]
    assert settings_of(resume_argv("claude", saved, SID))["crossSessionInbound"] == value


def test_the_mesh_never_adds_crosssessioninbound():
    assert "crossSessionInbound" not in settings_of(resume_argv("claude", ["claude"], SID))
    assert "crossSessionInbound" not in settings_of(claude_args())
