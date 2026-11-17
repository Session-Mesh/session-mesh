# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Local CLI helpers (localmesh.py)."""

import os

import localmesh
import sessiontoken


def test_session_env_mints_a_valid_session_token(monkeypatch, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("master-test-token\n")
    monkeypatch.setattr(localmesh, "TOKEN_FILE", token_file)
    env, meta = localmesh.session_env("box")
    assert env["MESH_SESSION"] == "box"
    sessiontoken.configure("master-test-token")
    assert sessiontoken.signed(env["MESH_SESSION_TOKEN"]) == ("box", meta["nonce"])


def test_current_session_prefers_ancestry(monkeypatch):
    sessions = [{"pid": os.getppid(), "name": "real"}, {"pid": 1, "name": "init"}]
    monkeypatch.setenv("MESH_SESSION", "stale")
    assert localmesh.current_session(sessions) == "real"


def test_inherited_name_only_counts_when_live(monkeypatch):
    monkeypatch.setenv("MESH_SESSION", "gone")
    assert localmesh.current_session([{"pid": 999999, "name": "other"}]) is None
    monkeypatch.setenv("MESH_SESSION", "other")
    assert localmesh.current_session([{"pid": 999999, "name": "other"}]) == "other"


def test_ancestry_crosses_a_process_whose_name_is_not_utf8(tmp_path, monkeypatch):
    import subprocess
    monkeypatch.delenv("MESH_SESSION", raising=False)
    name = os.fsencode(tmp_path) + b"/x\xff"
    os.symlink("/bin/sleep", name)
    child = subprocess.Popen([name, "30"])
    try:
        assert localmesh.current_session([{"pid": os.getpid(), "name": "me"}], pid=child.pid) == "me"
    finally:
        child.kill()
        child.wait()
