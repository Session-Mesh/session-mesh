# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The restore bar in a real browser: after a ptyhost restart the sidebar offers the lost
sessions ("Restaurer N sessions"); its checklist chooses which come back, Restaurer recreates
them, Ignorer dismisses the offer. (The API behind it: tests/test_restore_api.py.)"""

import json

import pytest

import respawn
import server
from respawn_helpers import mesh_item, snapshot_file  # noqa: F401
from conftest import ui
from test_view_compat import goto

pytestmark = pytest.mark.usefixtures("pty")
BAR = "#restore"
GO = "#restore-go"
OFFERED = "(b) => b.map((x) => x.dataset.name)"


@pytest.fixture
def lost(snapshot_file, home_dir):  # noqa: F811
    """Two sessions that a ptyhost restart has just ended: the snapshot saw them, then none."""
    items = [mesh_item("alpha", home_dir, created=1000.0), mesh_item("beta", home_dir, created=1001.0)]
    respawn.update(items, listed=True)
    respawn.update([], listed=True)
    return ["alpha", "beta"]


async def open_offer(page, mesh):
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.locator(GO).wait_for(timeout=10000)


async def test_the_bar_offers_every_lost_session_and_the_checklist_chooses(page, mesh, lost):
    await open_offer(page, mesh)
    offered = await page.locator(f"{BAR} input[data-name]").evaluate_all(OFFERED)
    assert sorted(offered) == lost
    assert await page.locator(f"{BAR} input[data-name]:checked").count() == 2
    assert await page.locator(GO).inner_text() == ui("restore.go", n=2)
    assert ui("restore.lost", n=2) in await page.locator(".restore-head").inner_text()

    await page.locator(f'{BAR} input[data-name="beta"]').uncheck()
    assert await page.locator(GO).inner_text() == ui("restore.go", n=1)
    await page.locator(f'{BAR} input[data-name="alpha"]').uncheck()
    assert await page.locator(GO).is_disabled()
    await page.locator(f'{BAR} input[data-name="alpha"]').check()
    assert await page.locator(GO).is_enabled()


async def test_restaurer_recreates_only_the_checked_sessions(page, mesh, lost):
    await open_offer(page, mesh)
    await page.locator(f'{BAR} input[data-name="beta"]').uncheck()
    await page.locator(GO).click()

    await page.wait_for_function("data.mesh.some((s) => s.name === 'alpha')", timeout=10000)
    await page.wait_for_function("document.querySelectorAll('#restore input[data-name]').length === 1"
                                 " && document.querySelector('#restore input[data-name=beta]')",
                                 timeout=10000)
    assert await page.evaluate("data.mesh.map((s) => s.name)") == ["alpha"]
    assert [e["name"] for e in respawn._load()["lost"]] == ["beta"]


async def test_ignorer_dismisses_the_offer_without_starting_anything(page, mesh, lost):
    await open_offer(page, mesh)
    await page.locator("#restore-ignore").click()

    await page.wait_for_function("document.getElementById('restore').hidden", timeout=10000)
    assert await page.evaluate("data.mesh.length") == 0
    assert respawn._load()["lost"] == []
    await page.reload()
    await page.wait_for_function("data && data.mesh")
    assert await page.locator(BAR).is_hidden()


async def test_a_bulk_restore_names_every_refused_session(page, mesh, lost):
    refusal = "the saved command is a shell string Mesh cannot parse: resume refused"
    results = {name: {"ok": False, "error": refusal} for name in lost}

    async def refuse(route):
        await route.fulfill(status=200, content_type="application/json", body=json.dumps({"results": results}))

    await page.route("**/api/restore", refuse)
    await open_offer(page, mesh)
    await page.locator(GO).click()
    error = ui("server.resumeRefusedShellString")
    expected = ui("restore.failed", n=2, failures="; ".join(ui("restore.failedItem", name=name, error=error)
                                                            for name in lost))
    await page.wait_for_function("(text) => document.querySelector('#flash').textContent === text", arg=expected)
    # long enough to read: still on screen after the 1.6 s of an ordinary message
    await page.wait_for_timeout(3000)
    assert await page.locator("#flash").is_visible()
    assert await page.locator("#flash").inner_text() == expected
    assert await page.locator("#flash").get_attribute("role") == "status"
    offered = await page.locator(f"{BAR} input[data-name]").evaluate_all(OFFERED)
    assert sorted(offered) == lost
