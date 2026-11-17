# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A failed History detail is retried by an explicit same-item sidebar click."""
import asyncio

import pytest

import server
from conftest import ui
from test_view_compat import goto

SID = "01900000-0000-0000-0000-000000000456"
KEY = f"h:codex:{SID}"
TRANSCRIPT = {"agent": "codex", "id": SID, "name": "Retry conversation", "cwd": "/tmp",
              "n_user": 2, "n_assistant": 1, "updated": 100, "started": 90,
              "tin": 0, "tout": 0, "tcr": 0, "tcw": 0}


async def prepare_history(page, mesh, monkeypatch):
    monkeypatch.setattr(server.discover, "external_sessions", lambda *a, **kw: [])
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                   "url": mesh.origin}])
    async def sessions(route):
        response = await route.fetch()
        body = await response.json()
        body["external"] = []
        body["mesh"] = []
        await route.fulfill(response=response, json=body)
    await page.route("**/api/sessions", sessions)
    async def history(route):
        await route.fulfill(json={"gen": 1, "full": True, "sessions": [TRANSCRIPT],
                                  "gone": [], "indexing": False})
    await page.route("**/api/history", history)
    await page.route("**/api/history?*", history)
    await goto(page, mesh.origin + "/")
    # Navigation's load event precedes the asynchronous initial inventory and
    # pane restoration. A sidebar row alone is not proof that it can open.
    await page.wait_for_function("!!active && panes.length > 0")
    await page.evaluate("setTab('hist'); document.body.classList.add('drawer')")
    item = page.locator(f'#hlist .item[data-id="{KEY}"]').first
    await item.wait_for()
    return item


@pytest.mark.parametrize("status", [404, 503])
async def test_failed_detail_retries_same_sidebar_item(page, mesh, monkeypatch, status):
    calls = []
    async def detail(route):
        calls.append(route.request.url)
        if len(calls) == 1:
            await route.fulfill(status=status, body=f"fixture detail failure {status}")
        else:
            await route.fulfill(json={**TRANSCRIPT, "recap": "Recovered full detail"})
    await page.route(f"**/api/history/codex/{SID}", detail)
    item = await prepare_history(page, mesh, monkeypatch)
    await item.click()
    await page.locator(".card.hist").get_by_text(f"fixture detail failure {status}").wait_for()
    # Inventory refresh is not an implicit network retry.
    await page.evaluate("refresh()")
    assert len(calls) == 1
    await page.evaluate("document.body.classList.add('drawer')")
    await item.click()
    await page.locator(".card.hist .recap").get_by_text("Recovered full detail").wait_for(timeout=1500)
    assert len(calls) == 2
    # Once loaded, the same explicit click retains successful detail cache.
    await page.evaluate("document.body.classList.add('drawer')")
    await item.click()
    assert len(calls) == 2


async def test_pending_detail_repeated_sidebar_click_does_not_duplicate(page, mesh, monkeypatch):
    calls = []
    release = asyncio.Event()
    async def detail(route):
        calls.append(route.request.url)
        await release.wait()
        await route.fulfill(json={**TRANSCRIPT, "recap": "Single pending detail"})
    await page.route(f"**/api/history/codex/{SID}", detail)
    item = await prepare_history(page, mesh, monkeypatch)
    await item.click()
    await page.locator(".card.hist").get_by_text(ui("hist.loading")).wait_for()
    for _ in range(3):
        await page.evaluate("document.body.classList.add('drawer')")
        await item.click()
    assert len(calls) == 1
    release.set()
    await page.locator(".card.hist .recap").get_by_text("Single pending detail").wait_for()
    assert len(calls) == 1
