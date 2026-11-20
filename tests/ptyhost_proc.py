# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The native ptyhost run as a *subprocess* on a private socket (black-box tests).

A frozen host cannot hang the pytest process, and the tests only talk to it through
its socket and /proc. Import the fixture by name:

    from ptyhost_proc import daemon  # noqa: F401  (pytest fixture)

Which ptyhost runs: the executable at the absolute path in ``MESH_PTYHOST_CMD``
when set (one path, no arguments), else ``mesh-ptyhost`` from ``PATH``; when neither
exists the tests fail, they are not skipped. The contract with that executable:

- it is run with the repository root as working directory, **without a shell**:
  it is the ptyhost process itself (the harness signals that pid and reads
  ``/proc/<pid>/fd``);
- it must listen on ``$XDG_RUNTIME_DIR/session-mesh/ptyhost.sock`` (the harness
  sets ``XDG_RUNTIME_DIR`` to a private directory and ``HOME`` is already a
  throwaway home) and create the missing directories;
- stdout is discarded, stderr is captured (``Daemon.stderr()``).

Teardown kills every session's whole Unix session (shells are the daemon's
direct children, each the leader of its own session), then the daemon
(SIGTERM, SIGKILL after 2 s), and removes the runtime directory.
"""

import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
for import_path in (REPO, REPO / "tests"):
    if str(import_path) not in sys.path:
        sys.path.insert(0, str(import_path))

import pytest

import discover
import ptyhost
from helpers import kill_session_tree, read_until, session_members

# Canary: set in the daemon's own environment, must never reach a session's shell
# (tests/test_ptyhost_env.py). Not a secret, any value would do.
PARENT_ONLY_CANARY = "MESH_PARENT_ONLY"


def ptyhost_command():
    """The argv that starts the ptyhost under test: ``[MESH_PTYHOST_CMD]``, else ``mesh-ptyhost`` from PATH.

    ``MESH_PTYHOST_CMD`` is one absolute path, no arguments (CONTRIBUTING.md, "Which PTY host the
    tests run"): it is never split or unquoted, so a path with spaces works.
    """
    configured = os.environ.get("MESH_PTYHOST_CMD", "")
    if configured:
        executable = Path(configured)
        if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeError(
                f"MESH_PTYHOST_CMD must be the absolute path of the mesh-ptyhost executable, "
                f"and nothing else (no arguments, no quoting); got {configured!r}")
        return [configured]
    found = shutil.which("mesh-ptyhost")
    if found:
        return [found]
    raise RuntimeError(
        "no native PTY host to test: set MESH_PTYHOST_CMD to the absolute path of the mesh-ptyhost "
        "executable (built with scripts/bootstrap.sh: ocaml/_build/default/bin/mesh_ptyhost_main.exe), "
        "or put mesh-ptyhost on PATH")


async def bounded(coro, timeout=5.0):
    """Await ``coro`` with a deadline, so no test can hang on a frozen daemon."""
    return await asyncio.wait_for(coro, timeout)


async def wait_until(predicate, timeout=5.0, interval=0.05):
    """Poll ``predicate`` (sync or async) until it is truthy; fail at the deadline."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = predicate()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        if loop.time() > deadline:
            raise AssertionError(f"condition not met within {timeout}s")
        await asyncio.sleep(interval)


class Daemon:
    """Handle on one ptyhost subprocess and the sessions it spawned."""

    def __init__(self, runtime, home=None, parent_env=None):
        self.runtime = runtime
        self.sock = runtime / "session-mesh" / "ptyhost.sock"
        self.stderr_path = runtime / "ptyhost.stderr"
        self.writers = []
        self.session_pids = set()
        env = {**(os.environ if parent_env is None else parent_env), "XDG_RUNTIME_DIR": str(runtime),
               PARENT_ONLY_CANARY: "leak"}
        if parent_env is None:
            # It takes precedence over XDG_RUNTIME_DIR; this caller's would name a real socket.
            env.pop("MESH_RUNTIME_DIR", None)
        if home is not None:
            env["HOME"] = str(home)
        with open(self.stderr_path, "wb") as err:
            self.proc = subprocess.Popen(ptyhost_command(), cwd=REPO,
                                         env=env,
                                         stdout=subprocess.DEVNULL, stderr=err,
                                         start_new_session=True)

    @property
    def pid(self):
        return self.proc.pid

    async def wait_for_socket(self, timeout=10.0):
        # The socket file appears at bind(), before listen(): a connection in
        # between is refused. Ready means a connection is accepted. The probe
        # sends no request and reads until the host closes its end, so that
        # connection holds no host descriptor once this returns (fd counts).
        async def ready():
            assert self.proc.poll() is None, f"ptyhost exited with {self.proc.returncode}"
            try:
                reader, writer = await asyncio.open_unix_connection(str(self.sock))
            except (FileNotFoundError, ConnectionRefusedError):
                return False
            try:
                writer.write_eof()
                await bounded(reader.read(), timeout)
            finally:
                writer.close()
            return True
        await wait_until(ready, timeout)

    def stderr(self):
        return self.stderr_path.read_text(errors="replace")

    def fd_count(self):
        return len(os.listdir(f"/proc/{self.pid}/fd"))

    def alive(self):
        return self.proc.poll() is None

    async def request(self, req, timeout=5.0):
        reply = await bounded(ptyhost.request(req), timeout)
        if req.get("op") == "new" and isinstance(reply, dict) and reply.get("ok"):
            await self.remember_session_pids(timeout)
        return reply

    async def remember_session_pids(self, timeout=5.0):
        """Record every listed shell pid, so teardown can kill its whole Unix session."""
        for info in await bounded(ptyhost.request({"op": "list"}), timeout):
            self.session_pids.add(info["pid"])

    async def names(self):
        return [s["name"] for s in await self.request({"op": "list"})]

    async def new(self, name, command=None, cwd=None):
        reply = await self.request({"op": "new", "name": name, "cwd": cwd or str(Path.home()),
                                    "command": command})
        assert reply == {"ok": True, "name": name}
        return reply

    async def attach(self, name, rows=24, cols=80):
        reader, writer = await bounded(ptyhost.attach(name, rows, cols))
        self.writers.append(writer)
        return reader, writer

    async def raw_idle_session(self, name):
        """A session whose program is in raw mode and never reads stdin; returns (reader, writer)."""
        await self.new(name)
        reader, writer = await self.attach(name)
        writer.write(ptyhost.frame(b"D", b"stty raw -echo; printf 'RE''ADY\\n'; sleep 600\r"))
        await read_until(reader, b"READY", timeout=15)
        return reader, writer

    def teardown(self):
        for writer in self.writers:
            writer.close()
        children = {pid for pid, stat in discover.snapshot().items() if stat[2] == self.pid}
        sids = self.session_pids | children
        if self.alive():
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        leftovers = {sid: kill_session_tree(sid) for sid in sids}
        shutil.rmtree(self.runtime, ignore_errors=True)
        return {sid: pids for sid, pids in leftovers.items() if pids or session_members(sid)}


@pytest.fixture
async def daemon(monkeypatch, request):
    if "plain_transport_shell" in request.fixturenames:
        request.getfixturevalue("plain_transport_shell")
    runtime = Path(tempfile.mkdtemp(prefix="pd-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime)
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        yield handle
    finally:
        leftovers = handle.teardown()
    assert not leftovers, f"processes left behind: {leftovers}"


def proc_state(pid):
    """The /proc state letter of ``pid``, or None once it no longer exists."""
    stat = discover.read_stat(pid)
    return stat[1] if stat else None


def _interop_main():
    """Keep an isolated daemon alive for a non-Python conformance client.

    The client receives one JSON line containing the private socket and home,
    then closes stdin to request teardown.  This is deliberately a tiny
    adapter around :class:`Daemon`, so MESH_PTYHOST_CMD and its cleanup rules
    remain exactly those used by the pytest fixture.
    """
    # The client owns our stdin writer. Parent/group death must close that
    # lifetime pipe, not kill this cleanup owner before its finally runs.
    os.setsid()
    cleanup_ready = False
    interrupted = False

    class InteropStopped(BaseException):
        pass

    def stop(_signum, _frame):
        nonlocal interrupted
        interrupted = True
        if cleanup_ready:
            raise InteropStopped()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    home = Path(tempfile.mkdtemp(prefix="pd-home-"))
    runtime = home / "runtime"
    runtime.mkdir(mode=0o700)
    handle = Daemon(runtime, home=home)
    # As the daemon fixture does: outside Linux, teardown's discover.snapshot() asks the host on
    # ptyhost.SOCK, which must be this daemon and never the user's own host on the default socket.
    ptyhost.SOCK = handle.sock
    try:
        cleanup_ready = True
        if interrupted:
            raise InteropStopped()
        asyncio.run(handle.wait_for_socket())
        print(json.dumps({"socket": str(handle.sock), "home": str(home)}), flush=True)
        sys.stdin.buffer.read()
    except InteropStopped:
        pass
    finally:
        # A second stop cannot interrupt the bounded owned teardown.
        cleanup_ready = False
        leftovers = handle.teardown()
        shutil.rmtree(home, ignore_errors=True)
    if leftovers:
        raise SystemExit(f"processes left behind: {leftovers}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--interop"]:
        _interop_main()
    else:
        raise SystemExit("usage: ptyhost_proc.py --interop")
