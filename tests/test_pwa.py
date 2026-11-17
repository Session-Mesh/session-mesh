# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The mesh as an installable app: manifest, icons and service worker (server.py)."""

import json

import pytest
import yarl


async def test_manifest_is_public_and_points_at_existing_icons(client):
    resp = await client.get("/manifest.webmanifest")
    assert resp.status == 200 and resp.content_type == "application/manifest+json"
    manifest = json.loads(await resp.text())
    assert manifest["start_url"] == "/" and manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        r = await client.get(icon["src"])
        assert r.status == 200 and r.content_type == "image/png", icon["src"]


async def test_service_worker_is_served_from_the_root(client):
    resp = await client.get("/sw.js")
    assert resp.status == 200 and resp.content_type == "text/javascript"
    assert resp.headers["Cache-Control"] == "no-cache"


@pytest.mark.parametrize("path", ["/static/app.js", "/static/icons/../app.js", "/static/icons/%2e%2e/app.js",
                                  "/static/icons/..%2fapp.js", "/static/icons/icon-192.png%2f..%2f..%2fapp.js",
                                  "/api/sessions"])
async def test_only_the_icons_are_public_under_static(client, path):
    # sent as written (yarl would otherwise resolve the dot segments client-side)
    resp = await client.get(yarl.URL(path, encoded=True), allow_redirects=False)
    assert resp.status in (302, 401), path


async def test_index_links_the_manifest(client, auth_cookie):
    html = await (await client.get("/", headers=auth_cookie)).text()
    assert 'rel="manifest" href="/manifest.webmanifest"' in html


def test_public_icons_are_exactly_the_manifest_ones():
    import server
    from pathlib import Path
    manifest = json.loads((Path(server.STATIC) / "manifest.webmanifest").read_text())
    icons = {yarl.URL(i["src"]).path for i in manifest["icons"]}
    assert icons == {p for p in server.PUBLIC if p.startswith("/static/icons/")}
