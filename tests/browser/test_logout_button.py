# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The sidebar footer's two logout buttons in a real browser. (The API: tests/test_logout_all.py.)"""

import pytest

import server
from conftest import ui
from test_view_compat import goto

pytestmark = pytest.mark.usefixtures("pty")


@pytest.fixture(autouse=True)
def generation_zero():
    server.GENERATION_FILE.write_text("0\n")
    yield
    server.GENERATION_FILE.write_text("0\n")


async def logged_in(page, mesh):
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.locator('[popovertarget="logout-pop"]').click()
    await page.locator("#btn-logout").wait_for(state="visible", timeout=10000)


async def cookie_names(page):
    return [c["name"] for c in await page.context.cookies()]


async def test_quitter_clears_this_browser_only(page, mesh):
    await logged_in(page, mesh)
    await page.locator("#btn-logout").click()
    await page.wait_for_url("**/login")
    assert server.COOKIE not in await cookie_names(page)
    assert server.GENERATION.current() == 0          # the other devices keep their login


async def test_all_devices_asks_first_and_cancelling_changes_nothing(page, mesh):
    await logged_in(page, mesh)          # the fixture's page dismisses dialogs and records them
    await page.locator("#btn-logout-all").click()
    await page.wait_for_timeout(300)
    assert len(page.dialogs) == 1 and page.dialogs[0] == ui("logout.allConfirm")
    assert server.GENERATION.current() == 0
    assert "/login" not in page.url


async def test_all_devices_confirmed_logs_everyone_out(page, mesh):
    await logged_in(page, mesh)
    await page.evaluate("window.confirm = () => true")   # the fixture's handler would dismiss a real dialog
    await page.locator("#btn-logout-all").click()
    await page.wait_for_url("**/login")
    assert server.GENERATION.current() == 1
