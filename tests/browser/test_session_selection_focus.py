# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""An explicit session choice is ready for immediate terminal input.

Attaching a terminal is deliberately asynchronous: xterm is hidden for its
first fit, then its socket opens.  Focus therefore belongs to the user action
which selected a session, not to the generic attach/restore path.
"""

import pytest

import server
from test_sidebar_menu import PHONE, api
from test_view_compat import goto
from conftest import ui


pytestmark = pytest.mark.usefixtures("pty")

DESKTOP = {"viewport": {"width": 1000, "height": 600}}


async def open_mesh(browser, mesh, home_dir, name, options):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
    context = await browser.new_context(**options)
    await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    tab = await context.new_page()
    await goto(tab, mesh.origin + "/")
    await tab.wait_for_function(f"data?.mesh?.some((s) => s.id === {name!r})", timeout=10000)
    return context, tab


async def wait_for_terminal(tab, name):
    await tab.wait_for_function(
        f"active?.id === {name!r} && active?.conn?.ws?.readyState === WebSocket.OPEN", timeout=10000)


async def test_sidebar_selection_focuses_the_desktop_terminal(browser, mesh, home_dir):
    context, tab = await open_mesh(browser, mesh, home_dir, "focus-desktop", DESKTOP)
    try:
        await tab.click('#list .item[data-id="focus-desktop"]')
        await wait_for_terminal(tab, "focus-desktop")
        await tab.wait_for_function("document.activeElement === active.term.textarea", timeout=3000)
    finally:
        await context.close()


async def test_sidebar_selection_focuses_the_phone_input_line(browser, mesh, home_dir):
    context, tab = await open_mesh(browser, mesh, home_dir, "focus-phone", PHONE)
    try:
        await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.click('#list .item[data-id="focus-phone"]')
        await wait_for_terminal(tab, "focus-phone")
        await tab.wait_for_function(
            "!$('#line').hidden && document.activeElement === $('#line-text')", timeout=3000)
    finally:
        await context.close()


async def test_programmatic_terminal_show_does_not_take_desktop_focus(browser, mesh, home_dir):
    context, tab = await open_mesh(browser, mesh, home_dir, "focus-programmatic", DESKTOP)
    try:
        await tab.focus("#btn-new")
        await tab.evaluate("active.show('focus-programmatic')")
        await wait_for_terminal(tab, "focus-programmatic")
        # Let both the initial xterm fit and the socket open settle: neither is
        # an explicit request to type in that terminal.
        await tab.wait_for_timeout(200)
        assert await tab.evaluate("document.activeElement === $('#btn-new')")
    finally:
        await context.close()


async def test_restoring_a_terminal_does_not_take_desktop_focus(browser, mesh, home_dir):
    context, tab = await open_mesh(browser, mesh, home_dir, "focus-restore", DESKTOP)
    try:
        # Select once so this terminal is part of the persisted workspace, then
        # reload.  Restore is not another user selection.
        await tab.click('#list .item[data-id="focus-restore"]')
        await wait_for_terminal(tab, "focus-restore")
        await tab.evaluate("document.activeElement?.blur()")
        await tab.reload(wait_until="domcontentloaded")
        await wait_for_terminal(tab, "focus-restore")
        await tab.wait_for_timeout(200)
        assert not await tab.evaluate("document.activeElement === active.term.textarea")
        assert not await tab.evaluate("document.activeElement === $('#line-text')")
    finally:
        await context.close()
