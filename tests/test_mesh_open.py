# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""bin/mesh-open run as a real subprocess against a live test server."""

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from aiohttp.test_utils import TestServer

import opens
import server
import sessiontoken
from session_helpers import NONCE, add_session, clean_opens, listing  # noqa: F401

MESH_OPEN = Path(__file__).resolve().parent.parent / "bin" / "mesh-open"


@pytest.fixture
async def live():
    test_server = TestServer(server.make_app(), host="127.0.0.1")
    await test_server.start_server()
    yield test_server
    await test_server.close()


@pytest.fixture
def doc(home_dir):
    path = home_dir / "cli.md"
    path.write_text("# cli\n")
    return path


async def run(live, *args, home=None, cwd=None, **env):
    """(exit code, stdout, stderr) of mesh-open with exactly this environment. The test runtime
    directory keeps its session lookup off the user's real PTY host."""
    full = {"PATH": os.environ["PATH"], "HOME": str(home or os.environ["HOME"]),
            "XDG_RUNTIME_DIR": os.environ["XDG_RUNTIME_DIR"], "MESH_PORT": str(live.port), **env}
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(MESH_OPEN), *args, env=full, cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), 20)
    return proc.returncode, out.decode(), err.decode()


@pytest.fixture
def empty_home():
    path = Path(tempfile.mkdtemp(prefix="nohome-", dir=os.environ["SMESH_TEST_ROOT"]))
    yield path
    shutil.rmtree(path, ignore_errors=True)


async def test_without_a_session_it_uses_the_master_token_as_before(live, doc):
    code, out, err = await run(live, str(doc))
    assert (code, err) == (0, "")
    assert str(doc) in out
    assert opens.OPENS[-1]["session"] is None
    assert (opens.OPENS[-1]["reload"], opens.OPENS[-1]["watch"]) == (False, False)


async def test_reload_flag_reaches_the_server(live, doc):
    assert (await run(live, "--reload", str(doc)))[0] == 0
    assert (opens.OPENS[-1]["reload"], opens.OPENS[-1]["watch"]) == (True, False)


async def test_watch_flag_reaches_the_server(live, doc):
    assert (await run(live, str(doc), "--watch"))[0] == 0
    assert (opens.OPENS[-1]["reload"], opens.OPENS[-1]["watch"]) == (True, True)
    assert opens.OPENS[-1]["mtime"] == str(doc.stat().st_mtime_ns)


async def test_a_relative_path_is_resolved_where_it_is_run(live, doc):
    code, out, err = await run(live, doc.name, cwd=doc.parent)
    assert (code, err) == (0, "") and opens.OPENS[-1]["target"] == str(doc)


async def test_a_web_page_is_refused_before_any_request(live):
    code, out, err = await run(live, "--watch", "https://example.com/x")
    assert code == 2 and "web page" in err
    assert opens.OPENS == []


@pytest.mark.parametrize("args", [[], ["--bogus", "x"], ["a", "b"]])
async def test_bad_usage_is_exit_2(live, args):
    code, _, _ = await run(live, *args)
    assert code == 2 and opens.OPENS == []


async def test_help_prints_the_usage_and_exits_0(live):
    code, out, _ = await run(live, "--help")
    assert code == 0 and "--watch" in out and "--reload" in out


async def test_a_session_token_is_sent_as_meshsession_and_the_master_file_is_not_read(
        live, listing, doc, empty_home):
    headers = add_session(listing, "cli")
    token = headers["Authorization"].split(" ", 1)[1]
    assert not (empty_home / ".config").exists()
    code, out, err = await run(live, str(doc), home=empty_home, MESH_SESSION="cli",
                               MESH_SESSION_TOKEN=token)
    assert (code, err) == (0, "")
    assert opens.OPENS[-1]["session"] == "cli"
    assert token not in out + err
    assert not (empty_home / ".config").exists()


async def test_the_session_comes_from_the_token_not_from_mesh_session(live, listing, doc):
    headers = add_session(listing, "cli")
    add_session(listing, "other", "f" * 32)
    token = headers["Authorization"].split(" ", 1)[1]
    code, _, _ = await run(live, str(doc), MESH_SESSION="other", MESH_SESSION_TOKEN=token)
    assert code == 0 and opens.OPENS[-1]["session"] == "cli"


async def test_a_refused_session_token_fails_without_falling_back_to_the_master_token(
        live, listing, doc):
    token = sessiontoken.issue("gone", NONCE)           # no such session is listed
    code, out, err = await run(live, str(doc), MESH_SESSION="gone", MESH_SESSION_TOKEN=token)
    assert code != 0 and opens.OPENS == []
    assert "session" in err and token not in out + err


async def test_a_dead_server_is_a_clean_error(doc):
    code, _, err = await run(type("Dead", (), {"port": 1})(), str(doc))
    assert code != 0 and "is not responding" in err and "Traceback" not in err


async def test_a_missing_master_token_file_is_a_clean_error(live, doc, empty_home):
    code, _, err = await run(live, str(doc), home=empty_home)
    assert code != 0 and "Traceback" not in err and "token" in err


async def test_mesh_conf_dir_moves_the_master_token_lookup(live, doc, empty_home):
    conf = empty_home / "elsewhere"
    conf.mkdir()
    (conf / "token").write_text(server.TOKEN + "\n")
    code, out, err = await run(live, str(doc), home=empty_home, MESH_CONF_DIR=str(conf))
    assert (code, err) == (0, "")
    assert str(doc) in out
    assert not (empty_home / ".config").exists()
