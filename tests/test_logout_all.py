# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The cookie is bound to a generation on disk; raising it logs every browser out at once."""

import asyncio
import os
import stat
import sys
from http.cookies import SimpleCookie
from pathlib import Path

import pytest
from aiohttp.test_utils import TestServer

import cookiegen
import server
from session_helpers import add_session, listing  # noqa: F401

MESH_LOGOUT_ALL = Path(__file__).resolve().parent.parent / "bin" / "mesh-logout-all"


@pytest.fixture(autouse=True)
def generation_zero():
    """Every test starts and ends at generation 0, the state the rest of the suite assumes."""
    server.GENERATION_FILE.write_text("0\n")
    yield
    server.GENERATION_FILE.write_text("0\n")


def cookie_header(value):
    return {"Cookie": f"{server.COOKIE}={value}"}


def issued_cookie(resp):
    jar = SimpleCookie()
    for header in resp.headers.getall("Set-Cookie", []):
        jar.load(header)
    return jar[server.COOKIE].value


async def logout_all(client, headers):
    return await client.post("/api/logout-all", headers=headers)


# ---------------------------------------------------------------- the value

def test_generation_zero_is_the_legacy_cookie_value():
    import hashlib
    import hmac
    legacy = hmac.new(server.TOKEN.encode(), b"session-mesh", hashlib.sha256).hexdigest()
    assert cookiegen.cookie_value(server.TOKEN, 0) == legacy == server.cookie_value()


def test_each_generation_has_its_own_value():
    values = {cookiegen.cookie_value(server.TOKEN, n) for n in range(5)}
    assert len(values) == 5


def test_the_generation_file_exists_at_zero_and_is_private():
    server.GENERATION_FILE.unlink()
    assert server.GENERATION.current() == 0
    assert stat.S_IMODE(server.GENERATION_FILE.stat().st_mode) == 0o600
    assert server.GENERATION_FILE.read_text() == "0\n"


def test_a_bump_keeps_the_mode_and_survives_a_restart():
    assert cookiegen.bump(server.GENERATION_FILE) == 1
    assert stat.S_IMODE(server.GENERATION_FILE.stat().st_mode) == 0o600
    restarted = cookiegen.Generation(server.GENERATION_FILE)      # a new process knows only the file
    assert restarted.current() == 1
    assert cookiegen.cookie_value(server.TOKEN, restarted.current()) == server.cookie_value()


@pytest.mark.parametrize("junk", ["", "abc\n", "-3\n", "1.5\n"])
def test_a_damaged_file_is_not_read_as_generation_zero(junk):
    server.GENERATION_FILE.write_text(junk)
    repaired = cookiegen.Generation(server.GENERATION_FILE).current()
    assert repaired > 1_000_000
    assert cookiegen.cookie_value(server.TOKEN, repaired) != cookiegen.cookie_value(server.TOKEN, 0)
    assert int(server.GENERATION_FILE.read_text()) == repaired


# ---------------------------------------------------------------- the route

async def test_an_old_cookie_is_refused_after_the_bump(client, auth_cookie):
    assert (await client.get("/api/sessions", headers=auth_cookie)).status == 200
    resp = await logout_all(client, auth_cookie)
    assert resp.status == 200
    assert (await resp.json()) == {"ok": True, "generation": 1}
    assert (await client.get("/api/sessions", headers=auth_cookie)).status == 401
    assert (await client.get("/", headers=auth_cookie, allow_redirects=False)).status == 302


async def test_the_logging_out_browser_has_its_cookie_cleared(client, auth_cookie):
    resp = await logout_all(client, auth_cookie)
    cleared = SimpleCookie()
    for header in resp.headers.getall("Set-Cookie", []):
        cleared.load(header)
    assert cleared[server.COOKIE].value == ""


async def test_a_new_login_after_the_bump_works(client, auth_cookie):
    await logout_all(client, auth_cookie)
    resp = await client.post("/login", data={"token": server.TOKEN}, allow_redirects=False)
    fresh = issued_cookie(resp)
    assert fresh != cookiegen.cookie_value(server.TOKEN, 0)
    assert (await client.get("/api/sessions", headers=cookie_header(fresh))).status == 200


async def test_the_master_bearer_token_works_before_and_after(client, auth_bearer):
    assert (await client.get("/api/sessions", headers=auth_bearer)).status == 200
    assert (await logout_all(client, auth_bearer)).status == 200
    assert (await client.get("/api/sessions", headers=auth_bearer)).status == 200


async def test_a_session_token_is_unaffected(client, auth_cookie, listing):
    headers = add_session(listing, "alpha")
    first = await client.post("/api/stat", headers=headers, json={"targets": []})
    await logout_all(client, auth_cookie)
    after = await client.post("/api/stat", headers=headers, json={"targets": []})
    assert (first.status, after.status) == (200, 200)


async def test_logout_all_refuses_a_session_token(client, listing):
    resp = await logout_all(client, add_session(listing, "alpha"))
    assert resp.status == 401
    assert server.GENERATION.current() == 0


async def test_logout_all_without_credentials_changes_nothing(client):
    assert (await logout_all(client, {})).status == 401
    assert (await client.post("/api/logout-all", headers=cookie_header("nope"))).status == 401
    assert server.GENERATION.current() == 0


async def test_logout_all_checks_the_origin(client, auth_cookie):
    resp = await logout_all(client, {**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403
    assert server.GENERATION.current() == 0
    origin = f"http://{client.server.host}:{client.server.port}"
    assert (await logout_all(client, {**auth_cookie, "Origin": origin})).status == 200


async def test_a_get_cannot_log_everyone_out(client, auth_cookie):
    resp = await client.get("/api/logout-all", headers=auth_cookie)
    assert resp.status in (404, 405)
    assert server.GENERATION.current() == 0


async def test_logout_all_closes_the_open_terminal_sockets(client, auth_cookie):
    class Socket:
        closed_with = None

        async def close(self, code, message):
            self.closed_with = code

    sock = Socket()
    client.app["sockets"].add(sock)
    await logout_all(client, auth_cookie)
    assert sock.closed_with is not None


# ---------------------------------------------------------------- one device

async def test_logout_clears_this_cookie_but_not_the_others(client, auth_cookie):
    resp = await client.post("/api/logout", headers=auth_cookie)
    assert resp.status == 200
    assert server.GENERATION.current() == 0
    assert (await client.get("/api/sessions", headers=auth_cookie)).status == 200   # another device


async def test_logout_needs_credentials_and_the_origin(client, auth_cookie):
    assert (await client.post("/api/logout")).status == 401
    resp = await client.post("/api/logout", headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403


# ---------------------------------------------------------------- the command

async def run_cli(port):
    env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "MESH_PORT": str(port)}
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(MESH_LOGOUT_ALL), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), 20)
    return proc.returncode, out.decode(), err.decode()


@pytest.fixture
async def live():
    test_server = TestServer(server.make_app(), host="127.0.0.1")
    await test_server.start_server()
    yield test_server
    await test_server.close()


async def test_the_command_with_the_server_up(live, auth_cookie):
    code, out, err = await run_cli(live.port)
    assert (code, err) == (0, "")
    assert "generation 1" in out
    assert server.GENERATION.current() == 1


async def test_the_command_with_the_server_down(auth_cookie):
    probe = TestServer(server.make_app(), host="127.0.0.1")
    await probe.start_server()
    port = probe.port
    await probe.close()                                  # nothing listens on this port any more
    code, out, err = await run_cli(port)
    assert (code, err) == (0, "")
    assert "is not responding" in out
    assert server.GENERATION.current() == 1
    assert server.cookie_value() != auth_cookie["Cookie"].split("=", 1)[1]


async def test_a_bump_made_on_disk_is_seen_by_the_running_server(client, auth_cookie):
    assert (await client.get("/api/sessions", headers=auth_cookie)).status == 200
    cookiegen.bump(server.GENERATION_FILE)
    assert (await client.get("/api/sessions", headers=auth_cookie)).status == 401
