# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A session token end to end: minted by /api/new, read from the shell's real environment,
honoured by the middleware against a real ptyhost, dead with its session."""

import asyncio

import pytest

import opens
import ptyhost
import server
from session_helpers import clean_opens  # noqa: F401


def shell_environment(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read().decode()
    return dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)


async def create(client, headers, home_dir, name):
    resp = await client.post("/api/new", json={"preset": "shell", "cwd": str(home_dir), "name": name},
                             headers=headers)
    assert resp.status == 200, await resp.text()
    pid = next(s["pid"] for s in await ptyhost.request({"op": "list"}) if s["name"] == name)
    return shell_environment(pid)


async def vanish(client, headers, name):
    created = next(s["created"] for s in await ptyhost.request({"op": "list"}) if s["name"] == name)
    assert (await client.post(f"/api/kill/{name}", json={"created": created}, headers=headers)).status == 200
    for _ in range(100):
        data = await (await client.get("/api/sessions", headers=headers)).json()
        if name not in [s["name"] for s in data["mesh"]]:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"{name} did not vanish")


def session_headers(env):
    return {"Authorization": "MeshSession " + env["MESH_SESSION_TOKEN"]}


@pytest.fixture
def doc(home_dir):
    path = home_dir / "e2e.md"
    path.write_text("# e2e\n")
    return path


async def test_the_shell_holds_a_working_token_and_never_the_master_token(
        client, auth_cookie, pty, home_dir, doc):
    env = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-a")
    assert env["MESH_SESSION"] == "e2e-a"
    assert server.TOKEN not in "".join(env.values())
    assert server.cookie_value() not in "".join(env.values())
    resp = await client.post("/api/open", json={"target": str(doc)}, headers=session_headers(env))
    assert resp.status == 200
    assert opens.OPENS[-1]["session"] == "e2e-a"


async def test_the_token_and_its_nonce_are_not_published_by_the_mesh(
        client, auth_cookie, pty, home_dir, doc):
    env = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-b")
    await client.post("/api/open", json={"target": str(doc)}, headers=session_headers(env))
    listing = await (await client.get("/api/sessions", headers=auth_cookie)).text()
    token = env["MESH_SESSION_TOKEN"]
    nonce = token.split(".")[2]
    assert token not in listing and nonce not in listing and token.split(".")[3] not in listing
    assert '"meta"' not in listing


async def test_two_sessions_two_tokens_each_bound_to_its_own_session(
        client, auth_cookie, pty, home_dir, doc):
    first = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-c")
    second = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-d")
    assert first["MESH_SESSION_TOKEN"] != second["MESH_SESSION_TOKEN"]
    await client.post("/api/open", json={"target": str(doc)}, headers=session_headers(first))
    await client.post("/api/open", json={"target": str(doc), "session": "e2e-c"},
                      headers=session_headers(second))
    assert [o["session"] for o in opens.OPENS] == ["e2e-c", "e2e-d"]


async def test_a_token_dies_with_its_session_and_a_reused_name_starts_afresh(
        client, auth_cookie, pty, home_dir, doc):
    old = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-e")
    await vanish(client, auth_cookie, "e2e-e")
    resp = await client.post("/api/open", json={"target": str(doc)}, headers=session_headers(old))
    assert resp.status == 401
    new = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-e")
    assert new["MESH_SESSION"] == "e2e-e"
    assert (await client.post("/api/open", json={"target": str(doc)},
                              headers=session_headers(old))).status == 401
    assert (await client.post("/api/open", json={"target": str(doc)},
                              headers=session_headers(new))).status == 200


async def test_a_token_of_one_session_cannot_be_renamed_into_another(
        client, auth_cookie, pty, home_dir, doc):
    one = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-f")
    two = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-g")
    _, _, nonce_one, mac_one = one["MESH_SESSION_TOKEN"].split(".")
    for forged in (f"ms1.e2e-g.{nonce_one}.{mac_one}",
                   f"ms1.e2e-f.{two['MESH_SESSION_TOKEN'].split('.')[2]}.{mac_one}"):
        resp = await client.post("/api/open", json={"target": str(doc)},
                                 headers={"Authorization": f"MeshSession {forged}"})
        assert resp.status == 401


async def test_a_session_token_cannot_kill_or_list_or_attach(client, auth_cookie, pty, home_dir):
    env = await create(client, home_dir=home_dir, headers=auth_cookie, name="e2e-h")
    headers = session_headers(env)
    assert (await client.post("/api/kill/e2e-h", headers=headers)).status == 401
    assert (await client.get("/api/sessions", headers=headers)).status == 401
    assert (await client.get("/ws/e2e-h", headers=headers)).status == 401
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert [s["name"] for s in data["mesh"]] == ["e2e-h"]
