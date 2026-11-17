# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Request body limits (R6)."""


async def test_login_rejects_a_huge_body(client):
    resp = await client.post("/login", data=b"token=" + b"x" * (2 * 1024 * 1024),
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert resp.status == 413


async def test_json_routes_reject_a_huge_body(client, auth_bearer):
    resp = await client.post("/api/organize", data=b'{"op":"' + b"x" * (2 * 1024 * 1024) + b'"}',
                             headers={**auth_bearer, "Content-Type": "application/json"})
    assert resp.status == 413


async def test_upload_still_takes_a_large_file(client, auth_cookie, tmp_path, monkeypatch):
    import server
    monkeypatch.setattr(server, "UPLOAD_DIR", tmp_path / "up")
    resp = await client.post("/api/upload", params={"name": "big.bin"}, data=b"y" * (5 * 1024 * 1024), headers=auth_cookie)
    assert resp.status == 200
