# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""MESH_CONF_DIR / MESH_CACHE_DIR: the one place the mesh's state directories are derived."""

import json
import os
import subprocess
import sys
from pathlib import Path

import server
import management

REPO = Path(__file__).resolve().parent.parent


def derive(env_extra, home):
    """The conf and cache dirs, and every module-level path built from them, as a fresh interpreter derives them."""
    code = (
        "import json, meshpaths, server, webpush, organize, respawn, management, localmesh, history\n"
        "print(json.dumps({'conf': str(meshpaths.CONF_DIR), 'cache': str(meshpaths.CACHE_DIR), 'paths': [str(p) for p in ["
        "server.CONF_DIR, server.TOKEN_FILE, server.PENDING_FILE, server.UPLOAD_DIR, webpush.CONF_DIR,"
        "webpush.KEY_FILE, webpush.SUBS_FILE, organize.FILE, respawn.FILE, management.FILE, localmesh.TOKEN_FILE,"
        "history.CACHE_FILE]]}))\n")
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "XDG_RUNTIME_DIR": str(home), **env_extra}
    out = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_unset_or_empty_keeps_the_default_locations(tmp_path):
    for extra in ({}, {"MESH_CONF_DIR": "", "MESH_CACHE_DIR": ""}):
        got = derive(extra, tmp_path)
        assert got["conf"] == str(tmp_path / ".config" / "session-mesh")
        assert got["cache"] == str(tmp_path / ".cache" / "session-mesh")
        assert all(p.startswith((got["conf"], got["cache"])) for p in got["paths"])


def test_every_module_follows_the_variables(tmp_path):
    conf, cache = tmp_path / "elsewhere" / "conf", tmp_path / "elsewhere" / "cache"
    got = derive({"MESH_CONF_DIR": str(conf), "MESH_CACHE_DIR": str(cache)}, tmp_path / "home")
    assert got["conf"] == str(conf) and got["cache"] == str(cache)
    for path in got["paths"]:
        assert path.startswith((str(conf), str(cache))), path
    names = {Path(p).name for p in got["paths"]}
    assert {"token", "pending.json", "uploads", "vapid.pem", "push.json", "mesh.json",
            "sessions-snapshot.json", "management-sessions.json", "history.json"} <= names


def test_a_relative_path_is_refused(tmp_path):
    out = subprocess.run([sys.executable, "-c", "import meshpaths"], cwd=REPO, capture_output=True, text=True,
                         env={"PATH": os.environ["PATH"], "HOME": str(tmp_path), "MESH_CONF_DIR": "rel/conf"})
    assert out.returncode != 0 and "MESH_CONF_DIR must be an absolute path" in out.stderr


def test_sessions_reach_the_mesh_that_launched_them(monkeypatch):
    expected = {"MESH_CONF_DIR": str(server.CONF_DIR), "MESH_PORT": str(server.PORT)}
    monkeypatch.delenv("MESH_CONF_DIR", raising=False)
    assert server._mesh_reach_env() == expected
    monkeypatch.setenv("MESH_CONF_DIR", str(server.CONF_DIR))
    assert server._mesh_reach_env() == expected


def test_push_can_be_turned_off(tmp_path):
    code = "import webpush; print(webpush.AVAILABLE)"
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path)}
    off = subprocess.run([sys.executable, "-c", code], cwd=REPO, env={**env, "MESH_PUSH": "0"},
                         capture_output=True, text=True)
    assert off.stdout.strip() == "False", off.stderr
