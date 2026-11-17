# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Test harness for session-mesh.

server.py and ptyhost.py (the client) bind paths at import time (the token file under ~,
the ptyhost socket under $XDG_RUNTIME_DIR, the /view roots, the upload dir).
The environment is therefore redirected to a throwaway root *here, at conftest
import*, before any test module imports them. Nothing in this suite may touch
the real home directory or the real ptyhost socket.
"""

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

# resolved: macOS gives /var/folders/..., a symlink to /private/var/..., and the
# view tests compare served paths, which are always resolved, with this home
TEST_ROOT = Path(tempfile.mkdtemp(prefix="smesh-")).resolve()
TEST_HOME = TEST_ROOT / "home"
TEST_RUNTIME = TEST_ROOT / "run"
TEST_HOME.mkdir()
TEST_RUNTIME.mkdir(mode=0o700)
# Playwright finds its browsers under ~/.cache/ms-playwright unless told otherwise: pin the real
# location before HOME moves, or the browser tests look for them in the throwaway home
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / ".cache" / "ms-playwright"))
# Likewise opam: agentmcp resolves a switch named by MESH_OPAM_SWITCH under OPAMROOT, by default
# ~/.opam, and would look for mesh-board-mcp in the throwaway home
os.environ.setdefault("OPAMROOT", str(Path.home() / ".opam"))
os.environ["HOME"] = str(TEST_HOME)
os.environ["XDG_RUNTIME_DIR"] = str(TEST_RUNTIME)
# MESH_RUNTIME_DIR takes precedence over XDG_RUNTIME_DIR: an inherited one would name a real socket
os.environ.pop("MESH_RUNTIME_DIR", None)
os.environ["XDG_CONFIG_HOME"] = str(TEST_HOME / ".config")
os.environ["XDG_CACHE_HOME"] = str(TEST_HOME / ".cache")
os.environ["XDG_DATA_HOME"] = str(TEST_HOME / ".local" / "share")
os.environ["MESH_CONF_DIR"] = str(TEST_HOME / ".config" / "session-mesh")
os.environ["MESH_CACHE_DIR"] = str(TEST_HOME / ".cache" / "session-mesh")
# Transport/restore conformance uses a real interactive shell without machine
# login profiles. Tests specifically exercising another shell retain their
# explicit SHELL overrides. Ignore the hosts' appended login argument.
TEST_SHELL = TEST_ROOT / "plain-bash"
TEST_SHELL.write_text("#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n")
TEST_SHELL.chmod(0o700)
os.environ["SHELL"] = "/bin/sh"
os.environ["SMESH_TEST_ROOT"] = str(TEST_ROOT)

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import pytest  # noqa: E402


@pytest.fixture
def short_root():
    """A private root a Unix socket path fits under (at most 103 bytes), whatever TMPDIR is."""
    root = Path(tempfile.mkdtemp(prefix="cw", dir="/tmp" if os.path.isdir("/tmp") else None))
    yield root
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def claude_socket_wake_unsupported(monkeypatch):
    """The Claude installed on the test machine must not change launch commands:
    tests of the messaging-socket wake opt in by replacing claudewake.supported."""
    import claudewake
    monkeypatch.setattr(claudewake, "supported", lambda env: False)


@pytest.fixture
def plain_transport_shell(monkeypatch):
    # Explicit opt-in only; env/login/backend tests retain their defaults.
    monkeypatch.setenv("SHELL", str(TEST_SHELL))


def _require_disposable_path(label, path, root):
    """Check the bound path, including symlinks, rather than its current environment."""
    try:
        safe = Path(path).is_absolute() and Path(path).resolve().is_relative_to(root.resolve())
    except (OSError, RuntimeError, TypeError, ValueError):
        safe = False
    if not safe:
        raise pytest.UsageError(
            f"unsafe test isolation: {label} is outside the disposable test root; "
            "start pytest in a fresh process before importing Mesh modules")


def _check_bound_paths():
    # Run before importing server: a cached meshpaths can otherwise cause its
    # import-time token creation/chmod to touch the owner's configuration.
    paths = {
        "ptyhost": {"SOCK": TEST_RUNTIME},
        "meshpaths": {"CONF_DIR": TEST_HOME, "CACHE_DIR": TEST_HOME},
        "server": {"CONF_DIR": TEST_HOME, "TOKEN_FILE": TEST_HOME,
                   "GENERATION_FILE": TEST_HOME, "PENDING_FILE": TEST_HOME,
                   "UPLOAD_DIR": TEST_HOME, "SESSION_REQUESTS_FILE": TEST_HOME},
        "board": {"FILE": TEST_HOME},
        "demo_scene": {"FILE": TEST_HOME},
        "conversation_names": {"FILE": TEST_HOME},
        "management": {"FILE": TEST_HOME},
        "organize": {"FILE": TEST_HOME},
        "respawn": {"FILE": TEST_HOME},
        "discover": {"HOME": TEST_HOME},
        "history": {"HOME": TEST_HOME, "CLAUDE": TEST_HOME,
                    "CODEX": TEST_HOME, "CACHE_FILE": TEST_HOME},
        "localmesh": {"TOKEN_FILE": TEST_HOME},
        "webpush": {"CONF_DIR": TEST_HOME, "KEY_FILE": TEST_HOME, "SUBS_FILE": TEST_HOME},
    }
    errors = []
    for name, attributes in paths.items():
        module = sys.modules.get(name)
        if module is not None:
            for attribute, root in attributes.items():
                try:
                    _require_disposable_path(f"{name}.{attribute}", getattr(module, attribute, None), root)
                except pytest.UsageError as error:
                    errors.append(str(error))
    module = sys.modules.get("view")
    if module is not None:
        # /tmp is an intentional public view root; only the bound home must move.
        roots = getattr(module, "VIEW_ROOTS", ())
        try:
            _require_disposable_path("view.VIEW_ROOTS[0]", roots[0] if roots else None, TEST_HOME)
        except pytest.UsageError as error:
            errors.append(str(error))
    if errors:
        raise pytest.UsageError("\n".join(errors))


try:
    _check_bound_paths()
except pytest.UsageError:
    shutil.rmtree(TEST_ROOT, ignore_errors=True)
    raise

import agentmcp  # noqa: E402

# The suite describes launch commands as they are with the board bridge installed, whether or
# not this run built it (the CI pytest job has no OCaml); set before server builds its presets.
# test_agentmcp checks the real installed/absent decision in a fresh interpreter.
agentmcp.board_available = lambda: True

import ptyhost  # noqa: E402
import server  # noqa: E402
from ptyhost_proc import daemon  # noqa: E402,F401  (fixture, used by ``pty``)

_check_bound_paths()


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(TEST_ROOT, ignore_errors=True)


# ---------------------------------------------------------------- web server

@pytest.fixture
async def client(aiohttp_client, tmp_path):
    return await aiohttp_client(server.make_app(
        session_request_path=tmp_path / "session-requests.sqlite3"))


@pytest.fixture
def auth_cookie():
    return {"Cookie": f"{server.COOKIE}={server.cookie_value()}"}


@pytest.fixture
def auth_bearer():
    return {"Authorization": f"Bearer {server.TOKEN}"}


@pytest.fixture
def signed_url(client, auth_bearer):
    """A /view URL for ``doc``, obtained only the way clients get one: POST /api/view."""
    async def sign(doc):
        resp = await client.post("/api/view", json={"target": str(doc)}, headers=auth_bearer)
        assert resp.status == 200, await resp.text()
        url = (await resp.json())["url"]
        assert url.startswith("/view/") and unquote(url).endswith(str(doc)), url
        return url
    return sign


@pytest.fixture
def home_dir():
    """A fresh directory under the (test) home, inside the /view roots."""
    path = Path(tempfile.mkdtemp(prefix="t-", dir=TEST_HOME))
    yield path
    shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------- ptyhost

@pytest.fixture
def _pty_isolation():
    """Refuse a socket path that is not under the disposable runtime (checked at use, not only at import)."""
    _require_disposable_path("ptyhost.SOCK", ptyhost.SOCK, TEST_RUNTIME)


@pytest.fixture
async def pty(_pty_isolation, daemon):
    """The native ptyhost (``MESH_PTYHOST_CMD``, else ``mesh-ptyhost`` on PATH) as a subprocess on
    a private socket, which ``ptyhost.SOCK`` is pointed at; its sessions are killed afterwards and
    nothing may be left behind (see ``ptyhost_proc.Daemon``)."""
    yield daemon
