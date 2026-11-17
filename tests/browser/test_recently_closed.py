# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""History finds closed Mesh conversations by original and renamed labels."""
import pytest

import server
from conftest import ui
from test_view_compat import goto

SID = "01900000-0000-0000-0000-000000000123"


@pytest.fixture(autouse=True)
def isolated_external_inventory(monkeypatch):
    # Never inspect real owner sessions to decide a synthetic closure's state.
    monkeypatch.setattr(server.discover, "external_sessions", lambda *args, **kwargs: [])


@pytest.mark.parametrize("width", [390, 1200])
@pytest.mark.parametrize("agent", ["codex", "claude"])
async def test_recent_mesh_conversation_names_and_resume(page, mesh, width, agent):
    await page.set_viewport_size({"width": width, "height": 850})
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    transcript = {"agent": agent, "id": SID, "name": "Transcript title", "cwd": "/tmp",
                  "n_user": 2, "n_assistant": 1, "updated": 100, "started": 90,
                  "tin": 0, "tout": 0, "tcr": 0, "tcw": 0}
    binding = {"name": "continuous-audit-codex", "label": "Security now",
               "aliases": ["continuous-audit-codex", "Previous security", "Security now"],
               "agent": agent, "sid": SID, "created": 1, "seen": 101, "closed_at": 101}
    async def history_reply(route):
        await route.fulfill(json={"gen": 1, "full": True, "sessions": [transcript], "gone": [],
                                  "indexing": False, "mesh_names": [binding]})
    await page.route("**/api/history", history_reply)
    await page.route("**/api/history?gen=*", history_reply)
    await page.route(f"**/api/history/{agent}/{SID}", lambda route: route.fulfill(json={
        **transcript, "mesh_name": binding["name"], "mesh_label": binding["label"],
        "mesh_aliases": binding["aliases"]}))
    await page.route("**/api/history/search?*", lambda route: route.fulfill(json=[]))
    async def sessions_reply(route):
        response = await route.fetch()
        body = await response.json()
        other = "claude" if agent == "codex" else "codex"
        body["external"] = [{"id": "collision-other-agent", "name": "collision-other-agent",
          "kind": "external", "host": "SSH", "pid": 424242, "cwd": "/tmp", "cmd": other,
          "tty": "/dev/pts/9", "agent": {"type": other, "session_id": SID,
                                       "status": "idle", "updated": 100}}]
        await route.fulfill(response=response, json=body)
    await page.route("**/api/sessions", sessions_reply)
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("typeof data.now === 'number'")
    await page.evaluate("setTab('hist'); document.body.classList.add('drawer')")
    await page.locator("#hlist").get_by_text(ui("history.recentlyClosed")).wait_for()
    assert await page.evaluate("sid => data.external[0].agent.session_id === sid", SID)
    for query in ["continuous-audit-codex", "Previous security", "Security now"]:
        await page.locator("#filter").fill(query)
        assert await page.locator("#hlist .hitem").count() == 2
        assert await page.locator("#hlist .hitem").first.locator(".name").inner_text() == "Security now"
    await page.locator("#hlist .hitem").first.click()
    await page.locator(".card.hist h2").get_by_text("Security now", exact=True).wait_for()
    requests = []
    async def resume(route):
        requests.append(route.request.post_data_json)
        await route.fulfill(status=503, body="fixture: launch unavailable")
    await page.route("**/api/history/resume", resume)
    async with page.expect_response(lambda response: response.url.endswith("/api/history/resume"), timeout=5000):
        await page.locator('[data-hact="resume"]').click()
    assert requests == [{"agent": agent, "id": SID}]


async def test_unknown_closed_session_is_visible_but_not_resumable(page, mesh):
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    binding = {"name": "closed-shell", "label": "Shell work", "aliases": ["closed-shell"],
               "agent": None, "sid": None, "created": 1, "seen": 101, "closed_at": 101}
    await page.route("**/api/history*", lambda route: route.fulfill(json={"gen": 1, "full": True,
        "sessions": [], "gone": [], "indexing": False, "mesh_names": [binding]}))
    await goto(page, mesh.origin + "/")
    await page.evaluate("setTab('hist'); document.body.classList.add('drawer')")
    item = page.locator("#hlist .hitem")
    await item.wait_for()
    assert await item.is_disabled()
    assert ui("history.recent.unidentified").split(" · ")[0] in await item.inner_text()


async def test_active_session_search_includes_previous_mesh_labels(page, mesh, pty):
    await pty.new("alias-shell")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data.mesh.some(s => s.id === 'alias-shell')")
    for label in ["First label", "Latest label"]:
        await page.evaluate("""async label => {
          const r = await fetch('/api/organize', {method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({op:'rename', id:'alias-shell', label})});
          if (!r.ok) throw new Error(await r.text());
        }""", label)
    await page.reload()
    await page.wait_for_function("data.mesh.some(s => s.label === 'Latest label')")
    await page.evaluate("setTab('live'); document.body.classList.add('drawer')")
    for query in ["alias-shell", "First label", "Latest label"]:
        await page.locator("#filter").fill(query)
        assert await page.locator('#list .item[data-id="alias-shell"]').count() > 0
