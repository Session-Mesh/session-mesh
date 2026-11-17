# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The optional `env` field of the ptyhost `new` request, and `meta` in `list` (protocol)."""

import asyncio
import os
from pathlib import Path

import pytest

from ptyhost_proc import PARENT_ONLY_CANARY, daemon  # noqa: F401  (daemon is a fixture)

pytestmark = [pytest.mark.ptyhost_t41]

TEST_HOME = Path(os.environ["HOME"])


def environ_of(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read()
    return dict(item.split(b"=", 1) for item in raw.split(b"\0") if b"=" in item)


async def new(daemon, name, **extra):
    return await daemon.request({"op": "new", "name": name, "cwd": str(TEST_HOME), "command": None,
                              **extra})


async def pid_of(daemon, name):
    return next(s["pid"] for s in await daemon.request({"op": "list"}) if s["name"] == name)


async def test_env_reaches_the_shell_next_to_the_clean_environment(daemon):
    reply = await new(daemon, "e1", env={"MESH_SESSION": "e1", "MESH_SESSION_TOKEN": "tok.en"})
    assert reply == {"ok": True, "name": "e1"}
    env = environ_of(await pid_of(daemon, "e1"))
    assert env[b"MESH_SESSION"] == b"e1"
    assert env[b"MESH_SESSION_TOKEN"] == b"tok.en"
    assert env[b"TERM"] == b"xterm-256color"


async def test_without_env_nothing_mesh_specific_is_set(daemon):
    await new(daemon, "e2")
    env = environ_of(await pid_of(daemon, "e2"))
    assert not [k for k in env if k.startswith(b"MESH_")]


async def test_a_daemon_secret_is_not_inherited_but_the_injected_env_is(daemon):
    # the harness starts every daemon with PARENT_ONLY_CANARY in its environment
    await new(daemon, "e3", env={"MESH_SESSION": "e3"})
    env = environ_of(await pid_of(daemon, "e3"))
    assert PARENT_ONLY_CANARY.encode() not in env and env[b"MESH_SESSION"] == b"e3"


@pytest.mark.parametrize("env", [
    {"PATH": "/evil"}, {"LD_PRELOAD": "/x.so"}, {"HOME": "/x"}, {"TERM": "dumb"}, {"SHELL": "/x"},
    {"mesh_session": "x"}, {"MESH_": "x"}, {"MESH_SESSION": 5}, {"MESH_SESSION": None},
    {"MESH_SESSION": "a\0b"}, {"MESH_A=B": "x"}, {"MESH_SESSION": ["x"]},
    "MESH_SESSION=x", ["MESH_SESSION"], 5, {1: "x"},
    {f"MESH_K{i}": "v" for i in range(33)},
    {"MESH_SESSION": "x" * 5000},
], ids=lambda e: repr(e)[:40])
async def test_an_invalid_env_is_refused_whole_and_creates_nothing(daemon, env):
    reply = await new(daemon, "bad", env=env)
    assert "error" in reply and "env" in reply["error"]
    assert await daemon.request({"op": "list"}) == []


async def test_a_refused_env_leaks_no_descriptor(daemon):  # noqa: F811
    before = daemon.fd_count()
    for _ in range(5):
        reply = await daemon.request({"op": "new", "name": "x", "cwd": str(TEST_HOME),
                                      "env": {"PATH": "/evil"}})
        assert "error" in reply
    # the daemon closes each request's socket after replying, asynchronously: give it a moment
    # before counting, so a socket still being closed is not mistaken for a leak
    for _ in range(40):
        if daemon.fd_count() == before:
            break
        await asyncio.sleep(0.05)
    assert daemon.fd_count() == before


async def test_meta_comes_back_in_list_including_the_nonce(daemon):
    await new(daemon, "m1", meta={"agent": "claude", "nonce": "abc"})
    info = next(s for s in await daemon.request({"op": "list"}) if s["name"] == "m1")
    assert info["meta"] == {"agent": "claude", "nonce": "abc"}
