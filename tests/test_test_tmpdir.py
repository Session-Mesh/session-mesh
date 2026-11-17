# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Full-suite scratch allocation honors an explicit short canonical parent."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


def invoke(value):
    env = dict(os.environ)
    if value is None:
        env.pop("TMPDIR", None)
    else:
        env["TMPDIR"] = str(value)
    return subprocess.run(
        ["bash", "-ec", 'source "$1"; mesh_prepare_test_tmpdir; printf "%s\\n" "$TMPDIR"',
         "scratch", str(ROOT / "scripts/test-tmpdir.sh")],
        env=env, capture_output=True, text=True, timeout=5,
    )


@pytest.fixture
def parent():
    with tempfile.TemporaryDirectory(prefix="dt-", dir="/tmp") as path:
        yield Path(path)


@pytest.mark.parametrize("custom", [False, True, "maximum"])
def test_short_parent_private_directory_and_real_socket_headroom(parent, custom):
    if custom == "maximum":
        parent = parent / ("x" * (27 - len(str(parent))))
        parent.mkdir()
        assert len(os.fsencode(parent)) == 28
    result = invoke(parent if custom else None)
    assert result.returncode == 0, result.stderr
    created = Path(result.stdout.strip())
    try:
        assert created.parent == (parent if custom else Path("/tmp"))
        assert created.stat().st_mode & 0o777 == 0o700
        # Longest relevant nested PTY fixture path, with real bind proof.
        runtime = created / "smesh-12345678" / "home" / "t42-12345678" / "session-mesh"
        runtime.mkdir(parents=True)
        target = runtime / "ptyhost.sock"
        with socket.socket(socket.AF_UNIX) as channel:
            channel.bind(str(target))
        target.unlink()
        for path in [runtime, runtime.parent, runtime.parent.parent,
                     runtime.parent.parent.parent]:
            path.rmdir()
    finally:
        created.rmdir()


@pytest.mark.parametrize("kind", ["empty", "relative", "missing", "file", "symlink", "alias", "long", "unicode-bytes"])
def test_invalid_parent_fails_before_allocation(parent, kind):
    file = parent / "file"
    file.touch()
    link = parent / "link"
    link.symlink_to(parent)
    long = parent / ("x" * 40)
    long.mkdir()
    unicode = parent / ("é" * 12)
    unicode.mkdir()
    values = {"empty": "", "relative": "relative", "missing": parent / "missing",
              "file": file, "symlink": link, "alias": f"{parent}/../{parent.name}",
              "long": long, "unicode-bytes": unicode}
    before = sorted(parent.iterdir())
    result = invoke(values[kind])
    assert result.returncode != 0
    assert "test scratch" in result.stderr
    assert sorted(parent.iterdir()) == before


def test_full_entry_prepares_scratch_before_npm():
    source = (ROOT / "scripts/test-local.sh").read_text()
    assert source.index("mesh_prepare_test_tmpdir") < source.index("npm ci")
    assert 'mktemp -d /tmp/smt.' not in source


@pytest.mark.parametrize("parent_bytes", [28, 29, 32])
def test_pinned_dune_interop_socket_boundary(parent, parent_bytes):
    parent = parent / ("x" * (parent_bytes - 1 - len(os.fsencode(parent))))
    parent.mkdir()
    assert len(os.fsencode(parent)) == parent_bytes
    before = sorted(parent.iterdir())
    result = invoke(parent)
    if parent_bytes > 28:
        assert result.returncode != 0, "unsafe Dune interop parent was accepted"
        assert "test scratch" in result.stderr
        assert sorted(parent.iterdir()) == before
        # Counterfactual full/Dune/interop nesting: the actual bind refuses it.
        created = parent / "sm.123456"
        created.mkdir()
    else:
        assert result.returncode == 0, result.stderr
        created = Path(result.stdout.strip())
    # Pinned Dune 3.24.2 dtemp.ml/Temp.try_paths: build_%06x_dune;
    # Python _interop_main: pd-home- + eight random characters, then runtime.
    runtime = created / "build_123456_dune" / "pd-home-12345678" / "runtime" / "session-mesh"
    runtime.mkdir(parents=True)
    target = runtime / "ptyhost.sock"
    try:
        assert len(os.fsencode(target)) == parent_bytes + 79
        with socket.socket(socket.AF_UNIX) as channel:
            if parent_bytes == 28:
                channel.bind(str(target))
                target.unlink()
            else:
                with pytest.raises(OSError, match="AF_UNIX path too long"):
                    channel.bind(str(target))
    finally:
        for path in [runtime, runtime.parent, runtime.parent.parent,
                     runtime.parent.parent.parent, runtime.parent.parent.parent.parent]:
            path.rmdir()
