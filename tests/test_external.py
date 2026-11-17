# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The system-browser endpoint accepts only a constrained URL and argv."""

import external


async def test_external_open_uses_xdg_open_without_a_shell(client, auth_bearer, monkeypatch):
    seen = {}

    async def spawned(*argv, **kwargs):
        seen["argv"] = argv
        seen["kwargs"] = kwargs
        return object()

    monkeypatch.setattr(external, "opener_argv", lambda url: ["xdg-open", url])
    monkeypatch.setattr(external.asyncio, "create_subprocess_exec", spawned)
    response = await client.post("/api/external-open", json={"url": "https://example.test/a?b=1"}, headers=auth_bearer)
    assert response.status == 200 and await response.json() == {"ok": True}
    assert seen["argv"] == ("xdg-open", "https://example.test/a?b=1")
    assert seen["kwargs"]["stderr"] is external.asyncio.subprocess.DEVNULL


async def test_external_open_rejects_non_web_urls(client, auth_bearer):
    for url in ("file:///etc/passwd", "javascript:alert(1)", "//example.test", "https:///no-host", "https://x.test/\ncmd"):
        response = await client.post("/api/external-open", json={"url": url}, headers=auth_bearer)
        assert response.status == 400, url


async def test_external_open_requires_auth_and_same_origin(client, auth_bearer):
    assert (await client.post("/api/external-open", json={"url": "https://example.test"})).status == 401
    response = await client.post("/api/external-open", json={"url": "https://example.test"},
                                 headers={**auth_bearer, "Origin": "https://evil.example"})
    assert response.status == 403


def test_opener_falls_back_to_gio(monkeypatch):
    monkeypatch.setattr(external.shutil, "which", lambda program: "/usr/bin/gio" if program == "gio" else None)
    assert external.opener_argv("https://example.test") == ["gio", "open", "https://example.test"]
