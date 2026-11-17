# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The phone-only navigation keeps session selection primary and labels global actions."""

import pytest

import server
from conftest import ui
from test_sidebar_menu import api
from test_view_compat import goto


pytestmark = pytest.mark.usefixtures("pty")
PHONE = {"viewport": {"width": 390, "height": 800}, "has_touch": True, "is_mobile": True}


@pytest.fixture
async def phone(browser, mesh):
    context = await browser.new_context(**PHONE)
    await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    tab = await context.new_page()
    await goto(tab, mesh.origin + "/")
    await tab.wait_for_function("typeof data !== 'undefined'")
    yield tab
    await context.close()


async def test_phone_chrome_has_large_labelled_primary_actions_and_no_horizontal_overflow(phone):
    assert await phone.get_by_role("button", name=ui("bar.sessions"), exact=True).count() == 1
    assert await phone.get_by_role("button", name=ui("mobile.actions"), exact=True).count() == 1
    assert await phone.locator("#btn-menu").evaluate("e => e.getBoundingClientRect().height") >= 44
    assert await phone.locator("#btn-mobile-actions").evaluate("e => e.getBoundingClientRect().height") >= 44
    assert await phone.evaluate("document.documentElement.scrollWidth <= innerWidth")


async def test_sessions_button_reports_and_toggles_the_existing_drawer(phone):
    sessions = phone.get_by_role("button", name=ui("bar.sessions"), exact=True)
    assert await sessions.get_attribute("aria-controls") == "side"
    assert await sessions.get_attribute("aria-expanded") == "false"
    await sessions.click()
    await phone.wait_for_function("document.body.classList.contains('drawer')")
    assert await sessions.get_attribute("aria-expanded") == "true"
    await phone.wait_for_function(
        "getComputedStyle(document.querySelector('#side')).transform === 'none'"
    )
    box = await sessions.bounding_box()
    assert box is not None
    hit = await phone.evaluate(
        "([x, y]) => document.elementFromPoint(x, y)?.id",
        [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2],
    )
    assert hit == "btn-menu"
    await sessions.click()
    await phone.wait_for_function("!document.body.classList.contains('drawer')")
    assert await sessions.get_attribute("aria-expanded") == "false"


async def test_actions_sheet_closes_on_escape_outside_tap_and_restores_focus(phone):
    actions = phone.get_by_role("button", name=ui("mobile.actions"), exact=True)
    await actions.click()
    sheet = phone.locator("#mobile-actions-sheet")
    await sheet.wait_for(state="visible")
    assert await actions.get_attribute("aria-expanded") == "true"
    await phone.keyboard.press("Escape")
    await sheet.wait_for(state="hidden")
    assert await actions.get_attribute("aria-expanded") == "false"
    assert await phone.evaluate("document.activeElement === $('#btn-mobile-actions')")

    await actions.click()
    box = await sheet.bounding_box()
    await phone.mouse.click(box["x"] + 4, box["y"] + 4)
    await sheet.wait_for(state="hidden")
    assert await phone.evaluate("document.activeElement === $('#btn-mobile-actions')")


async def test_sheet_actions_delegate_to_existing_font_page_and_explorer_controls(phone):
    await phone.get_by_role("button", name=ui("mobile.actions"), exact=True).click()
    before = await phone.evaluate("fontSize")
    await phone.get_by_role("button", name=ui("mobile.fontUp")).click()
    assert await phone.evaluate("fontSize") == before + 1

    await phone.get_by_role("button", name=ui("mobile.actions"), exact=True).click()
    await phone.get_by_role("button", name=ui("mobile.web")).click()
    await phone.locator("#dlg-web").wait_for(state="visible")
    await phone.locator("#dlg-web").press("Escape")

    await phone.get_by_role("button", name=ui("mobile.actions"), exact=True).click()
    await phone.get_by_role("button", name=ui("mobile.explore")).click()
    await phone.wait_for_function("document.body.classList.contains('exploring')")


async def test_actions_sheet_exposes_the_explicit_codex_scrollback_recovery(phone, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "shell-scroll"})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "codex-scroll"})
    await phone.reload()
    await phone.wait_for_function("data?.mesh?.some((s) => s.id === 'codex-scroll')")
    await phone.evaluate("active.show('shell-scroll')")
    await phone.wait_for_function("active?.id === 'shell-scroll'")
    await phone.evaluate("""(() => {
        const shell = data.mesh.find((s) => s.id === "shell-scroll");
        shell.known_agent = "codex";
        shell.agent = null;
        active.header();
    })()""")
    assert await phone.locator("#mobile-raw-scrollback").is_hidden()

    await phone.evaluate("""(() => {
        addPane("codex-scroll");
        const codex = data.mesh.find((s) => s.id === "codex-scroll");
        codex.known_agent = "codex";
        codex.agent = {type: "codex", foreground: true};
        active.header();
        const shell = panes.find((pane) => pane.id === "shell-scroll");
        window.__rawScrollCommand = { shell: [], codex: [] };
        shell.send = (value) => window.__rawScrollCommand.shell.push(value);
        active.send = (value) => window.__rawScrollCommand.codex.push(value);
    })()""")
    await phone.wait_for_function("active?.id === 'codex-scroll' && panes.length === 2")
    await phone.get_by_role("button", name=ui("mobile.actions"), exact=True).click()
    enable = phone.get_by_role("button", name=ui("mobile.rawScrollback"))
    assert await enable.is_visible()
    await enable.click()
    assert await phone.evaluate("window.__rawScrollCommand") == {
        "shell": [], "codex": ["/raw on\r"]}


async def test_interrupt_key_is_kept_away_from_the_send_button(phone, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "safe-keys"})
    await phone.reload()
    await phone.wait_for_function("data?.mesh?.some((session) => session.id === 'safe-keys')")
    await phone.evaluate("active.show('safe-keys')")
    await phone.wait_for_function("active?.id === 'safe-keys' && !document.querySelector('#keys').hidden")
    await phone.evaluate("document.fonts.ready")
    assert await phone.evaluate("""() => {
      const selected = active;
      const keys = document.querySelector('#keys');
      keys.scrollLeft = keys.scrollWidth;
      setActive(null);
      setActive(selected);
      return keys.scrollLeft === 0;
    }""")
    placement = await phone.evaluate("""async () => {
      const keys = document.querySelector('#keys');
      const key = keys.querySelector('[data-k="cc"]');
      const segments = keys.querySelectorAll('.key-segment');
      const initial = key.getBoundingClientRect();
      const initialScrollLeft = keys.scrollLeft;
      keys.scrollLeft = key.offsetLeft - keys.offsetLeft;
      await new Promise(requestAnimationFrame);
      const interrupt = key.getBoundingClientRect();
      const send = document.querySelector('#line button[type="submit"], #line button').getBoundingClientRect();
      return {
        initiallyOffscreen: initial.left >= innerWidth,
        initialLeft: initial.left,
        initialScrollLeft,
        viewportWidth: innerWidth,
        twoSegments: segments.length === 2,
        interruptInSecondSegment: key.closest('.key-segment') === segments[1],
        visibleAfterSwipe: interrupt.left >= 0 && interrupt.right <= innerWidth,
        distance: Math.hypot(
          interrupt.x + interrupt.width / 2 - (send.x + send.width / 2),
          interrupt.y + interrupt.height / 2 - (send.y + send.height / 2),
        ),
      };
    }""")
    assert placement["twoSegments"]
    assert placement["interruptInSecondSegment"]
    assert placement["initiallyOffscreen"], placement
    assert placement["visibleAfterSwipe"]
    assert placement["distance"] >= 160


async def test_swiping_the_key_strip_does_not_send_the_touched_key(phone, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "safe-swipe"})
    await phone.reload()
    await phone.wait_for_function("data?.mesh?.some((session) => session.id === 'safe-swipe')")
    await phone.evaluate("active.show('safe-swipe')")
    await phone.wait_for_function("active?.id === 'safe-swipe' && !document.querySelector('#keys').hidden")
    await phone.evaluate("""() => {
      window.__swipeKeys = [];
      active.send = value => window.__swipeKeys.push(value);
    }""")
    keys = await phone.locator("#keys").bounding_box()
    assert keys is not None
    y = keys["y"] + keys["height"] / 2
    cdp = await phone.context.new_cdp_session(phone)
    try:
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": 330, "y": y}],
        })
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchMove", "touchPoints": [{"x": 80, "y": y}],
        })
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    finally:
        await cdp.detach()
    await phone.wait_for_function("document.querySelector('#keys').scrollLeft > 0")
    assert await phone.evaluate("window.__swipeKeys") == []

    await phone.locator('#keys [data-k="right"]').click()
    assert await phone.evaluate("window.__swipeKeys") == ["\u001b[C"]


async def test_desktop_retains_its_top_bar_and_hides_phone_actions(browser, mesh):
    context = await browser.new_context(viewport={"width": 1000, "height": 700})
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        assert await tab.get_by_role("button", name=ui("bar.web").split(" ", 1)[1]).is_visible()
        assert await tab.get_by_role("button", name=ui("bar.explore").split(" ", 1)[1]).is_visible()
        assert await tab.locator("#btn-mobile-actions").is_hidden()
    finally:
        await context.close()
