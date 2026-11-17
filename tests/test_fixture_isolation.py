# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Unsafe import-order checks run only in children with disposable outer paths."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


REPO = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize("preimport", ["ptyhost", "meshpaths", "server", "history", "view", "discover",
                                      "late_socket", "symlink_socket"])
def test_preimported_paths_are_refused_before_startup(tmp_path, preimport):
    # These paths precede *every* child import, including pytest and the stale
    # application module. Even the unfixed harness cannot reach the real mesh.
    outer = tmp_path / "outer"
    home, runtime = outer / "home", outer / "run"
    home.mkdir(parents=True)
    runtime.mkdir(mode=0o700)
    sock = runtime / "session-mesh" / "ptyhost.sock"
    sock.parent.mkdir()
    sock.write_bytes(b"socket sentinel")
    marker = outer / "startup"
    env = {**os.environ, "HOME": str(home), "XDG_RUNTIME_DIR": str(runtime),
           "XDG_CONFIG_HOME": str(home / ".config"), "XDG_CACHE_HOME": str(home / ".cache"),
           "XDG_DATA_HOME": str(home / ".local/share"),
           "MESH_CONF_DIR": str(home / ".config/session-mesh"),
           "MESH_CACHE_DIR": str(home / ".cache/session-mesh"),
           "SMESH_ISOLATION_PROBE": "1", "SMESH_PREIMPORT": preimport,
           "SMESH_STARTUP_MARKER": str(marker), "SMESH_SENTINEL_SOCKET": str(sock),
           "PYTHONPATH": str(REPO)}
    code = """
import importlib, os
from pathlib import Path
import pytest
mode = os.environ['SMESH_PREIMPORT']
if mode not in ('late_socket', 'symlink_socket'):
    importlib.import_module(mode)

class StartupSpy:
    def pytest_sessionstart(self, session):
        import ptyhost, ptyhost_proc, server
        if mode == 'late_socket':
            ptyhost.SOCK = Path(os.environ['SMESH_SENTINEL_SOCKET'])
        elif mode == 'symlink_socket':
            ptyhost.SOCK.parent.symlink_to(Path(os.environ['SMESH_SENTINEL_SOCKET']).parent)
        def refuse_host(*args, **kwargs):
            Path(os.environ['SMESH_STARTUP_MARKER']).write_text('host started')
            # Reproduce the dangerous first operation, on the disposable sentinel.
            ptyhost.SOCK.unlink(missing_ok=True)
            raise RuntimeError('startup spy: no host is ever started')
        def refuse_app():
            Path(os.environ['SMESH_STARTUP_MARKER']).write_text('make_app called')
            raise RuntimeError('startup spy: no web service is ever started')
        ptyhost_proc.Daemon.__init__ = refuse_host
        server.make_app = refuse_app

raise SystemExit(pytest.main(['tests/test_fixture_isolation.py', '-q',
                             '-k', 'child_isolation_probe'], plugins=[StartupSpy()]))
"""
    result = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env,
                            capture_output=True, text=True, timeout=20)
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "unsafe test isolation" in output, output
    expected_module = "ptyhost" if preimport in ("late_socket", "symlink_socket") else preimport
    assert expected_module + "." in output, output
    assert not marker.exists(), output
    assert sock.read_bytes() == b"socket sentinel"


@pytest.mark.skipif(not os.environ.get("SMESH_ISOLATION_PROBE"), reason="child probe only")
async def test_child_isolation_probe(pty):
    pytest.fail("unsafe cached paths reached the test body")


def test_normal_imports_bind_disposable_paths():
    import meshpaths
    import discover
    import history
    import ptyhost
    import server

    root = Path(os.environ["SMESH_TEST_ROOT"]).resolve()
    assert ptyhost.SOCK.resolve().is_relative_to(root / "run")
    for path in (meshpaths.CONF_DIR, meshpaths.CACHE_DIR, server.TOKEN_FILE,
                 server.GENERATION_FILE, server.UPLOAD_DIR, discover.HOME,
                 history.HOME, history.CLAUDE, history.CODEX):
        assert Path(path).resolve().is_relative_to(root / "home")


def test_teardown_removes_the_host_its_sessions_and_its_runtime_only(tmp_path):
    """The ``pty``/``daemon`` fixture teardown, seen from outside the child pytest run that used it.

    The child starts the native host, opens a session, then retargets ``ptyhost.SOCK`` at an user's
    sentinel file. After the child exits: the host and the session's shell are gone, the fixture's
    private runtime directory is removed, and the sentinel is untouched (teardown works on the
    fixture's own socket, not on the global).
    """
    home, runtime = tmp_path / "home", tmp_path / "run"
    home.mkdir()
    runtime.mkdir(mode=0o700)
    sentinel = runtime / "owner-socket-sentinel"
    sentinel.write_bytes(b"owner sentinel")
    report = tmp_path / "started.json"
    env = {**os.environ, "HOME": str(home), "XDG_RUNTIME_DIR": str(runtime),
           "XDG_CONFIG_HOME": str(home / ".config"), "XDG_CACHE_HOME": str(home / ".cache"),
           "XDG_DATA_HOME": str(home / ".local/share"),
           "MESH_CONF_DIR": str(home / ".config/session-mesh"),
           "MESH_CACHE_DIR": str(home / ".cache/session-mesh"),
           "SMESH_TEARDOWN_PROBE": str(sentinel), "SMESH_TEARDOWN_REPORT": str(report),
           "PYTHONPATH": str(REPO)}
    code = """
import pytest

raise SystemExit(pytest.main(['tests/test_fixture_isolation.py', '-q',
                             '-k', 'child_teardown_probe']))
"""
    result = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    started = json.loads(report.read_text())
    assert not Path(f"/proc/{started['host']}").exists(), "fixture teardown left the host running"
    assert not Path(f"/proc/{started['session']}").exists(), "fixture teardown left the session's shell running"
    assert not Path(started["runtime"]).exists(), "fixture teardown left its runtime directory"
    assert sentinel.exists(), "fixture teardown unlinked the retargeted owner socket"
    assert sentinel.read_bytes() == b"owner sentinel"


@pytest.mark.skipif(not os.environ.get("SMESH_TEARDOWN_PROBE"), reason="child probe only")
async def test_child_teardown_probe(pty):
    import ptyhost

    await pty.new("teardown-probe")
    [session] = await pty.request({"op": "list"})
    Path(os.environ["SMESH_TEARDOWN_REPORT"]).write_text(json.dumps(
        {"host": pty.pid, "session": session["pid"], "runtime": str(pty.runtime)}))
    # The fixture's teardown works on its own socket, not on this global.
    ptyhost.SOCK = Path(os.environ["SMESH_TEARDOWN_PROBE"])
