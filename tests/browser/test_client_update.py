# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A page left open across a deploy notices the newer client (CV-1..CV-3): a bar offers the reload,
the page reloads by itself only when that loses nothing, and "Recharger" reloads on demand.
(The server side: tests/test_client_version.py.)"""

import asyncio
import json

import pytest

import server
from conftest import ui
from test_view_compat import goto

pytestmark = pytest.mark.usefixtures("pty")
BAR = "#update-bar"
REFRESH = "refresh()"


async def open_mesh(browser, mesh, viewport=None):
    context = await browser.new_context(viewport=viewport or {"width": 1000, "height": 520})
    await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    tab = await context.new_page()
    await goto(tab, mesh.origin + "/")
    await tab.wait_for_function("typeof data !== 'undefined' && data.client_version")
    await tab.evaluate("window.__marker = true")   # gone after a reload
    return context, tab


async def announce(tab, version):
    """Every /api/sessions reply now carries this client_version (a deploy happened)."""
    async def reply(route):
        response = await route.fetch()
        body = await response.json()
        body["client_version"] = version
        await route.fulfill(response=response, body=json.dumps(body))
    await tab.route("**/api/sessions", reply)


async def reloaded(tab, action, timeout=4000):
    try:
        async with tab.expect_navigation(timeout=timeout):
            await action()
    except Exception:
        return False
    await tab.wait_for_load_state()
    return True


async def _close_after_routes(tab, context):
    """Finish page routes before context teardown.

    ``behavior="wait"`` keeps a route handler's exception observable instead
    of turning an in-flight reply into an intermittent context-close race.
    """
    try:
        await tab.unroute_all(behavior="wait")
    finally:
        await context.close()


@pytest.fixture
async def stale(browser, mesh):
    context, tab = await open_mesh(browser, mesh)
    assert await tab.evaluate("loadedVersion") == await tab.evaluate("data.client_version")
    try:
        yield tab
    finally:
        await _close_after_routes(tab, context)


async def test_close_after_routes_waits_for_an_active_route_handler(browser, mesh):
    context, tab = await open_mesh(browser, mesh)
    handler_started = asyncio.Event()
    handler_finished = asyncio.Event()
    release_handler = asyncio.Event()
    unroute_started = asyncio.Event()
    close_task = None

    async def delayed_reply(route):
        handler_started.set()
        await release_handler.wait()
        response = await route.fetch()
        await route.fulfill(response=response)
        handler_finished.set()

    class RoutedPage:
        async def unroute_all(self, *, behavior):
            assert behavior == "wait"
            unroute_started.set()
            await tab.unroute_all(behavior=behavior)

    class ClosingContext:
        closed = False

        async def close(self):
            self.closed = True
            try:
                assert handler_finished.is_set()
                # A fulfilled route can still have an in-flight page evaluation.
                # Settle it before the fake context closes the real page.
                await asyncio.wait_for(refresh, timeout=5)
            finally:
                await context.close()

    closing_context = ClosingContext()
    try:
        await tab.route("**/api/sessions", delayed_reply)
        refresh = asyncio.create_task(tab.evaluate(REFRESH))
        await asyncio.wait_for(handler_started.wait(), timeout=5)
        close_task = asyncio.create_task(_close_after_routes(RoutedPage(), closing_context))
        await asyncio.wait_for(unroute_started.wait(), timeout=5)
        await asyncio.sleep(0)
        assert not closing_context.closed
        release_handler.set()
        await asyncio.wait_for(close_task, timeout=5)
        await asyncio.wait_for(refresh, timeout=5)
        assert handler_finished.is_set()
    finally:
        release_handler.set()
        if close_task is None:
            await context.close()
        else:
            await close_task


async def test_close_after_routes_preserves_a_route_handler_error():
    calls = []

    class RouteFailure(Exception):
        pass

    class Tab:
        async def unroute_all(self, *, behavior):
            calls.append(("unroute_all", behavior))
            raise RouteFailure("route handler failed")

    class Context:
        async def close(self):
            calls.append(("close",))

    with pytest.raises(RouteFailure, match="route handler failed"):
        await _close_after_routes(Tab(), Context())
    assert calls == [("unroute_all", "wait"), ("close",)]


async def test_no_bar_while_the_version_is_unchanged(stale):
    await stale.evaluate(REFRESH)
    assert await stale.locator(BAR).is_hidden()


async def test_a_changed_version_shows_the_bar_and_does_not_reload_a_busy_page(stale):
    # The idle clock starts when the script loads, so a slow start alone can outlast
    # reloadIdleMs. Age the clock past the delay, then give the real input that makes the
    # page busy.
    await stale.evaluate("lastActivity = performance.now() - 2 * reloadIdleMs")
    await stale.mouse.move(40, 40)
    assert await stale.evaluate("performance.now() - lastActivity < reloadIdleMs")
    await announce(stale, "newer")
    await stale.evaluate(REFRESH)
    await stale.locator(BAR).wait_for(state="visible")
    assert (await stale.locator(BAR).inner_text()).strip() == ui("bar.update")
    await asyncio.sleep(0.5)
    assert await stale.evaluate("window.__marker") is True   # recent input: not idle yet


async def test_an_idle_page_reloads_by_itself_once_per_version(stale):
    await announce(stale, "newer")
    await stale.evaluate("reloadIdleMs = 200")
    await asyncio.sleep(0.4)
    assert await reloaded(stale, lambda: stale.evaluate(REFRESH))
    assert await stale.evaluate("window.__marker") is None
    # the version still differs (the test serves one no file has): no second automatic reload
    await stale.wait_for_function("typeof data !== 'undefined' && data.client_version")
    await stale.evaluate("reloadIdleMs = 0")
    assert not await reloaded(stale, lambda: stale.evaluate(REFRESH), timeout=1500)
    await stale.locator(BAR).wait_for(state="visible")


@pytest.mark.parametrize("blocker", [
    "line.value = 'half a messa'",
    "ctext.value = 'a long draft'",
    "document.querySelector('#dlg-new').showModal()",
])
async def test_typed_text_or_an_open_dialog_blocks_the_reload(stale, blocker):
    await announce(stale, "newer")
    await stale.evaluate("reloadIdleMs = 0")
    await stale.evaluate(blocker)
    assert not await reloaded(stale, lambda: stale.evaluate(REFRESH), timeout=1500)
    assert await stale.evaluate("window.__marker") is True
    await stale.locator(BAR).wait_for(state="visible")


async def test_a_focused_field_with_text_blocks_the_reload_until_it_is_empty(stale):
    await announce(stale, "newer")
    await stale.evaluate("reloadIdleMs = 0")
    await stale.fill("#filter", "abc")
    assert not await reloaded(stale, lambda: stale.evaluate(REFRESH), timeout=1500)
    await stale.fill("#filter", "")
    assert await reloaded(stale, lambda: stale.evaluate(REFRESH))


async def test_recharger_reloads_the_page(stale):
    assert await reloaded(stale, lambda: stale.click("#btn-reload"))
    assert await stale.evaluate("window.__marker") is None


async def test_the_bar_reloads_the_page(stale):
    await announce(stale, "newer")
    await stale.evaluate(REFRESH)
    assert await reloaded(stale, lambda: stale.click(BAR))


async def test_recharger_is_reachable_on_a_phone(browser, mesh):
    context, tab = await open_mesh(browser, mesh, {"width": 390, "height": 800})
    try:
        await tab.click("#btn-menu")
        assert await reloaded(tab, lambda: tab.click("#btn-reload"))
    finally:
        await context.close()
