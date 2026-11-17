# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The "↓" button floating over the terminal: shown only while the normal buffer is
scrolled away from its end, it jumps back to the bottom, and it never covers the
phone's input line, key bar or the terminal's scrollbar strip."""

import asyncio
from urllib.parse import urlsplit

import pytest

import server
from test_sidebar_menu import PHONE, api
from test_touch_scroll import ALTERNATE, FLOOD, PRINTING, swipe, touch
from test_view_compat import goto

pytestmark = [pytest.mark.usefixtures("pty"), pytest.mark.ci_local_only]

BUTTON = ".pane.active .to-bottom"
DESKTOP = {"viewport": {"width": 1000, "height": 600}}
READY = "active.term.buffer.active.length > active.term.rows + 100"
AT_BOTTOM = "active.term.buffer.active.viewportY === active.term.buffer.active.baseY"
SHOWN = f"document.querySelector('{BUTTON}').classList.contains('on')"
INITIALIZED_AT_BOTTOM = (
    "active?.conn?.autoRedraw === null && active?.conn?.initialFollow === null && "
    f"{AT_BOTTOM}"
)
INVENTORY_READY = "typeof data !== 'undefined' && data?.mesh?.length >= 1"


async def wait_for_inventory(tab, origin, evidence):
    from playwright.async_api import Error

    try:
        await tab.wait_for_function(INVENTORY_READY, timeout=10000)
    except Error:
        location = urlsplit(tab.url)
        expected = urlsplit(origin)
        route = "other"
        if (location.scheme, location.netloc) == (expected.scheme, expected.netloc):
            route = location.path if location.path in ("/", "/login", "/id/login") else "other"
        binding = "unknown"
        try:
            present = await asyncio.wait_for(tab.evaluate("typeof data !== 'undefined'"), timeout=1)
            binding = "present" if present is True else "absent" if present is False else "unknown"
        except (Error, asyncio.TimeoutError):
            pass
        # Never print console messages, exception text, URL queries or response bodies.
        raise AssertionError(
            f"mesh inventory unavailable: route={route} app_status={evidence['app_status']} "
            f"app_failed={evidence['app_failed']} page_error={evidence['page_error']} binding={binding}"
        ) from None


@pytest.mark.ci_browser_smoke
async def test_inventory_wait_accepts_delayed_binding_without_reference_error(page):
    # Synthetic delayed binding, not evidence that normal page.goto(load) races.
    await page.set_content("<script>setTimeout(() => { window.data = {mesh: [{}]}; }, 100)</script>")
    await page.wait_for_function(INVENTORY_READY, timeout=10000)
    assert await page.evaluate("data.mesh.length") == 1


@pytest.mark.ci_browser_smoke
async def test_inventory_failure_reports_only_fixed_readiness_categories():
    from playwright.async_api import Error

    class FailedTab:
        url = "https://mesh.example/login?SENTINEL-PRIVATE"

        async def wait_for_function(self, predicate, *, timeout):
            assert predicate == INVENTORY_READY
            assert timeout == 10000
            raise Error("SENTINEL-PRIVATE error and stack")

        async def evaluate(self, expression):
            assert expression == "typeof data !== 'undefined'"
            return False

    evidence = {"app_status": 404, "app_failed": True, "page_error": True}
    with pytest.raises(AssertionError) as error:
        await wait_for_inventory(FailedTab(), "https://mesh.example", evidence)
    assert str(error.value) == (
        "mesh inventory unavailable: route=/login app_status=404 "
        "app_failed=True page_error=True binding=absent"
    )
    assert "SENTINEL" not in str(error.value)


@pytest.fixture
async def mesh_page(browser, mesh, home_dir, plain_transport_shell):
    contexts = []

    async def open_mesh(command, options, name="stb", ready=READY):
        await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
        context = await browser.new_context(**options)
        contexts.append(context)
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        evidence = {"app_status": "unknown", "app_failed": False, "page_error": False}

        def app_response(response):
            if urlsplit(response.url).path == "/static/app.js":
                evidence["app_status"] = response.status

        def app_failed(request):
            if urlsplit(request.url).path == "/static/app.js":
                evidence["app_failed"] = True

        tab.on("response", app_response)
        tab.on("requestfailed", app_failed)
        tab.on("pageerror", lambda _: evidence.update(page_error=True))
        await goto(tab, mesh.origin + "/")
        await wait_for_inventory(tab, mesh.origin, evidence)
        if options.get("is_mobile"):
            await tab.evaluate(f"document.querySelector('#list .item[data-id=\"{name}\"]').click()")
        else:
            await tab.click(f'#list .item[data-id="{name}"]')
        await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
        await tab.evaluate("(c) => active.send(c)", command)
        await tab.wait_for_function(ready, timeout=10000)
        await tab.wait_for_timeout(300)
        tab.cdp = await context.new_cdp_session(tab)
        return tab

    yield open_mesh
    for context in contexts:
        await context.close()


async def box(tab, selector):
    return await tab.evaluate(
        f"(() => {{ const r = document.querySelector('{selector}').getBoundingClientRect();"
        " return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; })()")


async def scroll_state(tab):
    return await tab.evaluate("""() => {
      const buffer = active.term.buffer.active;
      return {
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        scrollTop: document.querySelector('.pane.active .xterm-viewport')?.scrollTop,
        holdTimer: active.holdTimer,
      };
    }""")


async def screen_down_bounds(tab):
    """Resolve a real terminal touch path after responsive header layout."""
    screen = await box(tab, ".pane.active .xterm-screen")
    x = (screen["left"] + screen["right"]) / 2
    y0 = screen["top"] + 24
    y1 = min(screen["bottom"] - 24, y0 + 300)
    assert y1 - y0 >= 100, screen
    return x, y0, y1


async def swipe_screen_down(tab, *, steps=12, pause=16):
    x, y0, y1 = await screen_down_bounds(tab)
    await swipe(tab, x, y0, y1, steps=steps, pause=pause)


def overlaps(a, b):
    return a["left"] < b["right"] and b["left"] < a["right"] and a["top"] < b["bottom"] and b["top"] < a["bottom"]


@pytest.mark.ci_browser_smoke
async def test_hidden_at_the_bottom(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    assert await tab.evaluate(AT_BOTTOM)
    assert not await tab.evaluate(SHOWN)
    assert await tab.evaluate(f"getComputedStyle(document.querySelector('{BUTTON}')).visibility") == "hidden"


@pytest.mark.ci_browser_smoke
async def test_reopening_a_session_anchors_its_replayed_output_at_the_bottom(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    # The common PWA path is a reload/restored workspace.  Its terminal must
    # attach to the existing pty replay at the latest visible output, not retain
    # an arbitrary browser scroll position from the prior page.
    await tab.reload()
    await tab.wait_for_function("data?.mesh?.some((s) => s.id === 'stb')", timeout=10000)
    await tab.wait_for_function("active?.conn?.name === 'stb' && active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_function(READY, timeout=10000)
    await tab.wait_for_timeout(400)  # replay and its automatic redraw have settled
    assert await tab.evaluate(AT_BOTTOM)
    assert not await tab.evaluate(SHOWN)


async def test_an_attach_explicitly_follows_the_end_after_its_replay_is_quiet(mesh_page):
    tab = await mesh_page(FLOOD, PHONE)
    # xterm normally follows a write, but reconnect/replay and a fit race can
    # leave its viewport on a retained intermediate row.  The Mesh owns that
    # initial navigation decision, so assert the explicit final anchor rather
    # than relying on xterm's incidental write behaviour.
    await tab.evaluate("""() => {
      const follow = active.term.scrollToBottom.bind(active.term);
      window.initialFollowCalls = 0;
      active.term.scrollToBottom = () => { window.initialFollowCalls++; return follow(); };
      active.detach();
      active.show('stb');
    }""")
    await tab.wait_for_function("active?.conn?.name === 'stb' && active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_function(READY, timeout=10000)
    await tab.wait_for_function("window.initialFollowCalls > 0", timeout=3000)
    assert await tab.evaluate(AT_BOTTOM)
    assert not await tab.evaluate(SHOWN)


async def test_a_phone_tap_does_not_cancel_a_fresh_attachment_anchor(mesh_page):
    """Focusing the phone input is not a request to read terminal history."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.evaluate("""() => {
      const follow = active.term.scrollToBottom.bind(active.term);
      window.initialFollowCalls = 0;
      active.term.scrollToBottom = () => { window.initialFollowCalls++; return follow(); };
      active.detach();
      active.show('stb');
    }""")
    await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_function("active?.conn?.initialFollow != null", timeout=3000)
    screen = await box(tab, ".pane.active .xterm-screen")
    x, y = (screen["left"] + screen["right"]) / 2, (screen["top"] + screen["bottom"]) / 2
    await touch(tab, "touchStart", x, y)
    await touch(tab, "touchEnd", x, y)
    await tab.wait_for_function("window.initialFollowCalls > 0", timeout=3000)
    assert await tab.evaluate(AT_BOTTOM)


async def test_a_phone_touch_jitter_does_not_cancel_a_fresh_attachment_anchor(mesh_page):
    """Sub-slop touch settling is still a tap, not a history gesture."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.evaluate("""() => {
      const follow = active.term.scrollToBottom.bind(active.term);
      window.initialFollowCalls = 0;
      active.term.scrollToBottom = () => { window.initialFollowCalls++; return follow(); };
      active.detach();
      active.show('stb');
    }""")
    await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_function("active?.conn?.initialFollow != null", timeout=3000)
    screen = await box(tab, ".pane.active .xterm-screen")
    x, y = (screen["left"] + screen["right"]) / 2, (screen["top"] + screen["bottom"]) / 2
    await touch(tab, "touchStart", x, y)
    await touch(tab, "touchMove", x, y + 2)  # below TOUCH_SLOP_PX
    await touch(tab, "touchEnd", x, y + 2)
    await tab.wait_for_function("window.initialFollowCalls > 0", timeout=3000)
    assert await tab.evaluate(AT_BOTTOM)


@pytest.mark.ci_browser_smoke
@pytest.mark.parametrize("options", [DESKTOP, PHONE])
async def test_new_output_recovers_from_an_attachment_viewport_drift_when_no_one_scrolled_history(mesh_page, options):
    """An attach/layout race is not a user's request to read older output.

    xterm deliberately keeps a viewport that it believes the user scrolled.
    Mesh must instead retain the user's *intent*: a freshly attached terminal
    follows later output even if the terminal was left a few rows behind by a
    replay or fit race.
    """
    tab = await mesh_page(FLOOD, options)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await tab.evaluate("active.term.scrollLines(-40)")  # model the xterm race, not a user gesture
    assert not await tab.evaluate(AT_BOTTOM)
    await tab.evaluate("""() => active.conn.ws.onmessage({
      data: new TextEncoder().encode('late-replay-byte\\r\\n').buffer,
    })""")
    await tab.wait_for_function(AT_BOTTOM, timeout=3000)
    assert not await tab.evaluate(SHOWN)


@pytest.mark.parametrize("options", [DESKTOP, PHONE])
async def test_a_programmatic_live_follow_clears_the_bottom_indicator_in_the_same_task(mesh_page, options):
    """A logical return to the end cannot leave a stale actionable arrow.

    ``scrollToBottom`` changes xterm's logical position synchronously, while
    the existing indicator refresh is deferred to rAF.  A packet can be
    parsed and observed before that frame; the visible control must already
    agree with the newly live viewport in that gap.
    """
    tab = await mesh_page(FLOOD, options)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await tab.evaluate("active.term.scrollLines(-40)")
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate("""() => {
      const follow = active.followLiveOutput.bind(active);
      active.followLiveOutput = (...args) => {
        const followed = follow(...args);
        // The microtask runs after the complete onWriteParsed subscriber, but
        // before the pending animation frame that used to repair the button.
        queueMicrotask(() => {
          const b = active.term.buffer.active;
          window.sameTaskFollowState = {
            atBottom: b.viewportY === b.baseY,
            shown: document.querySelector('.pane.active .to-bottom').classList.contains('on'),
            viewportY: b.viewportY,
            baseY: b.baseY,
          };
          active.followLiveOutput = follow;
        });
        return followed;
      };
      active.conn.ws.onmessage({
        data: new TextEncoder().encode('same-task-follow\\r\\n').buffer,
      });
    }""")
    await tab.wait_for_function("window.sameTaskFollowState != null", timeout=3000)
    state = await tab.evaluate("window.sameTaskFollowState")
    assert state["atBottom"], state
    assert not state["shown"], state


async def test_phone_fit_reset_replay_and_queued_refit_keep_a_finite_viewport(mesh_page):
    """Narrow the attach failure to xterm's fit/reset/write boundary.

    This deliberately uses no WebSocket replay or Mesh initial-follow timer:
    xterm must retain a valid scroll offset through the same mobile layout
    sequence before any product-level anchor can be meaningful.
    """
    tab = await mesh_page(FLOOD, PHONE)
    state = await tab.evaluate("""async () => {
      const pane = active, term = pane.term;
      pane.detach();
      pane.termEl.hidden = false;
      pane.fit.fit();
      term.reset();
      const replay = Array.from({length: 360}, (_, n) => `replay-${n} ${'x'.repeat(70)}\\r\\n`).join('');
      await new Promise((done) => term.write(replay, done));
      await new Promise((done) => requestAnimationFrame(() => { pane.refit(); done(); }));
      await new Promise(requestAnimationFrame);
      term.scrollToBottom();
      const b = term.buffer.active;
      return { viewportY: b.viewportY, baseY: b.baseY, length: b.length, rows: term.rows };
    }""")
    assert state["length"] > state["rows"]
    assert isinstance(state["viewportY"], int), state
    assert state["viewportY"] == state["baseY"], state


@pytest.mark.ci_browser_smoke
async def test_a_detached_socket_cannot_append_its_stale_replay(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.evaluate("""() => {
      const stale = active.conn.ws;
      active.detach();
      active.show('stb');
      window.deliverStaleTerminalBytes = () => stale.onmessage({
        data: new TextEncoder().encode('STALE-TERMINAL-REPLAY\\r\\n').buffer,
      });
    }""")
    await tab.wait_for_function("active?.conn?.name === 'stb' && active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.evaluate("deliverStaleTerminalBytes()")
    await tab.wait_for_timeout(100)
    assert not await tab.evaluate("""() => {
      const b = active.term.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\\n').includes('STALE-TERMINAL-REPLAY');
    }""")


@pytest.mark.ci_browser_smoke
async def test_a_close_that_yields_to_refresh_cannot_retry_a_replaced_socket(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    # A close handler awaits refresh().  Detaching in that gap used to let the
    # old handler mark the replacement socket disconnected and schedule its
    # retry.  The synchronous detach runs while refresh's promise is pending.
    await tab.evaluate("""() => {
      const stale = active.conn.ws, old = active.conn;
      const done = stale.onclose();
      active.detach();
      active.show('stb');
      window.staleClose = { old, done };
    }""")
    await tab.wait_for_function("active?.conn?.name === 'stb' && active.conn !== window.staleClose.old", timeout=10000)
    state = await tab.evaluate("""async () => {
      const held = window.staleClose;
      const before = { closed: held.old.closed, same: active.conn === held.old, wsSame: held.old.ws === active.conn?.ws };
      await held.done;
      return { before, retry: held.old.retry, current: active.conn?.name };
    }""")
    assert state == {"before": {"closed": True, "same": False, "wsSame": False}, "retry": 0, "current": "stb"}


async def test_desktop_wheel_up_shows_it_and_a_click_returns_to_the_bottom(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -600)
    await tab.wait_for_function(SHOWN, timeout=3000)
    assert not await tab.evaluate(AT_BOTTOM)
    await tab.click(BUTTON)
    await tab.wait_for_function(f"{AT_BOTTOM} && !({SHOWN})", timeout=3000)


@pytest.mark.ci_browser_smoke
async def test_phone_swipe_shows_it_and_a_tap_returns_to_the_bottom(mesh_page):
    tab = await mesh_page(FLOOD, PHONE)
    assert not await tab.evaluate(SHOWN)
    await swipe_screen_down(tab)
    await tab.wait_for_function(SHOWN, timeout=3000)
    assert await tab.evaluate(f"document.querySelector('{BUTTON}').offsetWidth") >= 40   # a touch target
    centre = await box(tab, BUTTON)
    x, y = (centre["left"] + centre["right"]) / 2, (centre["top"] + centre["bottom"]) / 2
    await touch(tab, "touchStart", x, y)
    await touch(tab, "touchEnd", x, y)
    await tab.wait_for_function(f"{AT_BOTTOM} && !({SHOWN})", timeout=3000)


async def test_a_phone_tap_keeps_the_bottom_through_a_late_stale_viewport_scroll(mesh_page):
    """A browser scroll queued before the jump must not undo that explicit jump.

    Xterm updates its buffer position synchronously, while its native viewport
    can still dispatch an older ``scrollTop`` on the next frame.  This models
    that pending event after the real physical touch on the Mesh button.
    """
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await swipe_screen_down(tab)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate("""() => {
      const term = active.term, viewport = document.querySelector('.pane.active .xterm-viewport');
      const staleScrollTop = viewport.scrollTop, scrollToBottom = term.scrollToBottom.bind(term);
      window.lateViewportInjected = false;
      window.lateViewportScrolls = 0;
      viewport.addEventListener('scroll', () => {
        if (window.lateViewportInjected) window.lateViewportScrolls++;
      });
      let injectOnce = true;
      term.scrollToBottom = (...args) => {
        const result = scrollToBottom(...args);
        if (injectOnce) {
          injectOnce = false;
          requestAnimationFrame(() => {
            window.lateViewportInjected = true;
            viewport.scrollTop = staleScrollTop;
          });
        }
        return result;
      };
    }""")
    centre = await box(tab, BUTTON)
    x, y = (centre["left"] + centre["right"]) / 2, (centre["top"] + centre["bottom"]) / 2
    await touch(tab, "touchStart", x, y)
    await touch(tab, "touchEnd", x, y)
    await tab.wait_for_function("window.lateViewportScrolls > 0", timeout=3000)
    await tab.evaluate("new Promise(done => requestAnimationFrame(done))")
    state = await scroll_state(tab)
    assert state["viewportY"] == state["baseY"], state
    assert not await tab.evaluate(SHOWN), state


async def test_a_later_history_gesture_cancels_a_pending_bottom_sync(mesh_page):
    """The stale-scroll guard cannot override a newer choice to read history."""
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -900)
    await tab.wait_for_function(SHOWN, timeout=3000)
    state = await tab.evaluate(f"""() => {{
      const pane = active, term = pane.term, viewport = document.querySelector('.pane.active .xterm-viewport');
      const staleScrollTop = viewport.scrollTop;
      document.querySelector('{BUTTON}').click();
      const pendingBeforeGesture = pane.conn.bottomSync;
      pane.termEl.dispatchEvent(new WheelEvent('wheel', {{deltaY: -900, bubbles: true, cancelable: true}}));
      term.scrollLines(-40);  // model the viewport movement the wheel owns
      const afterGesture = {{follow: pane.conn.followOutput, pending: pane.conn.bottomSync}};
      window.historyGestureStaleScroll = 0;
      viewport.addEventListener('scroll', () => {{ window.historyGestureStaleScroll++; }}, {{once: true}});
      viewport.scrollTop = staleScrollTop;
      return {{pendingBeforeGesture, afterGesture}};
    }}""")
    assert state == {"pendingBeforeGesture": True, "afterGesture": {"follow": False, "pending": False}}
    await tab.wait_for_function("window.historyGestureStaleScroll > 0", timeout=3000)
    await tab.evaluate("new Promise(done => requestAnimationFrame(done))")
    assert not await tab.evaluate(AT_BOTTOM)
    assert await tab.evaluate(SHOWN)


async def test_a_tap_stops_a_glide_and_the_view_stays_at_the_bottom(mesh_page):
    tab = await mesh_page(FLOOD, PHONE)
    # Attach replay can still arm its redraw/final-follow cycle after the
    # transcript has reached READY.  Start the gesture only after that cycle
    # has finished, so a later automatic anchor cannot mask or cause a glide.
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await swipe_screen_down(tab, steps=6, pause=8)   # a quick flick: it glides after the release
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate(f"document.querySelector('{BUTTON}').click()")
    await tab.wait_for_function(f"{AT_BOTTOM} && !({SHOWN})", timeout=3000)
    await tab.wait_for_timeout(1500)                    # a glide that survived would have scrolled up again
    state = await scroll_state(tab)
    assert state["viewportY"] == state["baseY"], state
    assert not await tab.evaluate(SHOWN), state


async def test_to_bottom_ignores_a_late_terminal_touch_tail(mesh_page):
    """A delayed move/end from the cancelled gesture must not restart its glide."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    x, y0, y1 = await screen_down_bounds(tab)
    await touch(tab, "touchStart", x, y0)
    for step in range(1, 7):
        await touch(tab, "touchMove", x, y0 + (y1 - y0) * step / 6)
        await tab.wait_for_timeout(8)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate(f"document.querySelector('{BUTTON}').click()")
    # CDP can deliver a terminal input tail after the page-side click task.
    # It belongs to the cancelled gesture, not to a new swipe.
    await touch(tab, "touchMove", x, y1 + 10)
    await touch(tab, "touchEnd", x, y1 + 10)
    await tab.wait_for_timeout(100)
    state = await scroll_state(tab)
    await tab.evaluate("active.stopGlide(); active.releaseOutput()")
    assert state["viewportY"] == state["baseY"], state
    assert not await tab.evaluate(SHOWN), state


async def test_it_releases_held_output(mesh_page):
    tab = await mesh_page(PRINTING, PHONE)
    x, y0, y1 = await screen_down_bounds(tab)
    await touch(tab, "touchStart", x, y0)
    # several moves, well past one row: the swipe gain depends on the measured speed, so a single
    # short move may scroll less than a row on a slow runner and never show the button
    for step in range(1, 6):
        await touch(tab, "touchMove", x, y0 + (y1 - y0) * step / 5)  # output held from first move
        await tab.wait_for_timeout(16)
    await tab.wait_for_function(SHOWN, timeout=3000)
    assert await tab.evaluate("!!active.holdTimer")
    await tab.evaluate(f"document.querySelector('{BUTTON}').click()")
    assert await tab.evaluate("!active.holdTimer && active.queuedOutput.length === 0")
    await touch(tab, "touchEnd", x, y1)


async def test_it_shows_when_output_arrives_while_scrolled_up(mesh_page):
    tab = await mesh_page(PRINTING, DESKTOP)
    # A real history gesture, unlike an attach/layout drift, opts out of live
    # following until the reader deliberately returns to the end.
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -900)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.wait_for_timeout(500)                      # lines keep arriving: still shown
    assert await tab.evaluate(SHOWN)


@pytest.mark.ci_browser_smoke
async def test_returning_to_the_bottom_reenables_following_after_reading_history(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -900)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.mouse.wheel(0, 100000)
    await tab.wait_for_function(f"{AT_BOTTOM} && !({SHOWN})", timeout=3000)
    # A later xterm viewport race must not erase the user's deliberate return
    # to the live end. The following packet is ordinary terminal output.
    await tab.evaluate("active.term.scrollLines(-40)")
    await tab.evaluate("""() => active.conn.ws.onmessage({
      data: new TextEncoder().encode('after-manual-bottom\\r\\n').buffer,
    })""")
    await tab.wait_for_function(AT_BOTTOM, timeout=3000)
    assert not await tab.evaluate(SHOWN)


async def test_live_output_during_a_wheel_return_to_bottom_keeps_following(mesh_page):
    """The shared before-rAF race is covered for the desktop wheel path too."""
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -900)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate("active.term.scrollToLine(active.term.buffer.active.baseY - 1)")
    await tab.evaluate("""() => {
      const note = active.noteUserScroll.bind(active);
      active.noteUserScroll = towardEnd => {
        note(towardEnd);
        if (!towardEnd) return;
        active.term.scrollToBottom();
        active.noteUserScroll = note;
        active.output(new TextEncoder().encode('while-wheel-returning-to-bottom\\r\\n'));
      };
    }""")
    await tab.mouse.wheel(0, 100)
    await tab.wait_for_function("active.conn.followOutput && " + AT_BOTTOM, timeout=3000)
    assert not await tab.evaluate(SHOWN)


@pytest.mark.ci_browser_smoke
@pytest.mark.parametrize("displacement", [0, 30, -30])
async def test_touch_motion_preserves_explicit_direction(mesh_page, displacement):
    """A duplicate position is not a new choice to read terminal history."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    state = await tab.evaluate("""displacement => {
      const screen = document.querySelector('.pane.active .xterm-screen');
      const rect = screen.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const top = rect.top + rect.height * .2;
      const bottom = rect.top + rect.height * .8;
      const dispatch = (type, y) => {
        const point = new Touch({identifier: 1, target: screen, clientX: x, clientY: y});
        screen.dispatchEvent(new TouchEvent(type, {touches: [point], changedTouches: [point],
          bubbles: true, cancelable: true}));
      };
      dispatch('touchstart', bottom);
      dispatch('touchmove', top);
      const afterReturn = active.conn.followOutput;
      dispatch('touchmove', top - displacement);
      const afterZero = active.conn.followOutput;
      active.output(new TextEncoder().encode('after-zero-displacement\\r\\n'));
      const atPacket = active.conn.followOutput;
      active.stopGlide();
      active.releaseOutput();
      return {afterReturn, afterZero, atPacket};
    }""", displacement)
    follows = displacement >= 0
    assert state == {"afterReturn": True, "afterZero": follows, "atPacket": follows}, state


@pytest.mark.ci_browser_smoke
async def test_phone_scroll_starts_even_if_terminal_child_stops_touchstart(mesh_page):
    """A child handling text touches must not leave Mesh without a swipe start."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    state = await tab.evaluate("""() => {
      const screen = document.querySelector('.pane.active .xterm-screen');
      const viewport = document.querySelector('.pane.active .xterm-viewport');
      const rect = screen.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const bottom = rect.top + rect.height * .8;
      const top = rect.top + rect.height * .2;
      const stopStart = event => event.stopPropagation();
      screen.addEventListener('touchstart', stopStart);
      const dispatch = (type, y) => {
        const point = new Touch({identifier: 1, target: screen, clientX: x, clientY: y});
        screen.dispatchEvent(new TouchEvent(type, {touches: type === 'touchend' ? [] : [point],
          changedTouches: [point], bubbles: true, cancelable: true}));
      };
      const before = viewport.scrollTop;
      dispatch('touchstart', top);
      dispatch('touchmove', bottom);
      const after = viewport.scrollTop;
      dispatch('touchend', bottom);
      active.stopGlide(); active.releaseOutput();
      screen.removeEventListener('touchstart', stopStart);
      return {before, after};
    }""")
    assert state["after"] < state["before"] - 20, state


@pytest.mark.ci_browser_smoke
async def test_vertical_phone_swipe_from_left_edge_reaches_terminal(mesh_page):
    """The drawer-edge recognizer must let a vertical first move scroll."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    state = await tab.evaluate("""() => {
      const screen = document.querySelector('.pane.active .xterm-screen');
      const viewport = document.querySelector('.pane.active .xterm-viewport');
      const rect = screen.getBoundingClientRect();
      const x = Math.max(rect.left + 2, 20);
      const top = rect.top + rect.height * .2;
      const bottom = rect.top + rect.height * .8;
      const dispatch = (type, y) => {
        const point = new Touch({identifier: 2, target: screen, clientX: x, clientY: y});
        screen.dispatchEvent(new TouchEvent(type, {touches: type === 'touchend' ? [] : [point],
          changedTouches: [point], bubbles: true, cancelable: true}));
      };
      const before = viewport.scrollTop;
      dispatch('touchstart', top);
      dispatch('touchmove', bottom);
      const after = viewport.scrollTop;
      dispatch('touchend', bottom);
      active.stopGlide(); active.releaseOutput();
      return {x, before, after};
    }""")
    assert state["x"] < 40, state
    assert state["after"] < state["before"] - 20, state


@pytest.mark.ci_browser_smoke
@pytest.mark.parametrize("frame_delta", [0, -1, 16])
async def test_nonpositive_glide_frame_does_not_revoke_following(mesh_page, frame_delta):
    """A stale/zero animation timestamp must not manufacture a history gesture."""
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    state = await tab.evaluate("""delta => new Promise(resolve => {
      const screen = document.querySelector('.pane.active .xterm-screen');
      const rect = screen.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const top = rect.top + rect.height * .2;
      const bottom = rect.top + rect.height * .8;
      const dispatch = (type, y) => {
        const point = new Touch({identifier: 1, target: screen, clientX: x, clientY: y});
        screen.dispatchEvent(new TouchEvent(type, {touches: type === 'touchend' ? [] : [point],
          changedTouches: [point], bubbles: true, cancelable: true}));
      };
      const raf = window.requestAnimationFrame;
      const now = performance.now;
      window.requestAnimationFrame = callback => {
        if (callback.name !== 'tick') return raf(callback);
        window.requestAnimationFrame = raf;
        return raf(() => {
          callback(1000 + delta);
          const afterFrame = active.conn.followOutput;
          active.output(new TextEncoder().encode('after-nonpositive-frame\\r\\n'));
          const atPacket = active.conn.followOutput;
          active.stopGlide();
          active.releaseOutput();
          resolve({afterFrame, atPacket});
        });
      };
      dispatch('touchstart', bottom);
      dispatch('touchmove', top);
      performance.now = () => 1000;
      dispatch('touchend', top);
      performance.now = now;
    })""", frame_delta)
    assert state == {"afterFrame": True, "atPacket": True}, state


@pytest.mark.ci_browser_smoke
async def test_live_output_during_a_phone_manual_return_to_bottom_keeps_following(mesh_page):
    """The touch-release/write race cannot turn a manual return into history.

    The injected packet is delivered after Mesh handles the final downward
    touch movement but before its pending animation frame.  That is the live
    writer ordering which previously advanced ``baseY`` before Mesh recorded
    that the person had reached the former end.
    """
    tab = await mesh_page(FLOOD, PHONE)
    await tab.wait_for_function(INITIALIZED_AT_BOTTOM, timeout=10000)
    screen = await box(tab, ".pane.active .xterm-screen")
    x = (screen["left"] + screen["right"]) / 2
    top = screen["top"] + (screen["bottom"] - screen["top"]) * .2
    bottom = screen["top"] + (screen["bottom"] - screen["top"]) * .8
    await touch(tab, "touchStart", x, top)
    await touch(tab, "touchMove", x, bottom)             # read older output
    await tab.wait_for_timeout(80)
    await tab.evaluate("active.stopGlide(); active.releaseOutput()")
    await touch(tab, "touchEnd", x, bottom)
    await tab.wait_for_function("!active.conn.followOutput && !(" + AT_BOTTOM + ")", timeout=3000)
    # Put the reader one line above the end.  The following real upward finger
    # move reaches the native end.  Intercept immediately after Mesh begins
    # holding output: xterm has recorded the end but Mesh's rAF has not yet
    # committed the candidate.  A live packet in that exact gap must use the
    # ordinary pre-write commit, not turn the reader back into history.
    await tab.evaluate("active.term.scrollToLine(active.term.buffer.active.baseY - 1)")
    await tab.evaluate("new Promise(done => requestAnimationFrame(done))")
    await tab.evaluate("""() => {
      const hold = active.holdOutput.bind(active);
      const resume = active.resumeFollowing.bind(active);
      window.returnRace = { path: null, before: null, followAtPacket: null };
      const inject = (path, connection) => {
        if (window.returnRace.path) return;
        const b = active.term.buffer.active;
        window.returnRace.path = path;
        window.returnRace.before = { candidate: connection?.followCandidate, follow: active.conn?.followOutput,
                                    viewportY: b.viewportY, baseY: b.baseY };
        active.holdOutput = hold;
        active.resumeFollowing = resume;
        // Still in the real touchmove task, before noteUserScroll's rAF.
        active.output(new TextEncoder().encode('while-returning-to-bottom\\r\\n'));
        window.returnRace.followAtPacket = active.conn.followOutput;
        active.releaseOutput();
      };
      active.holdOutput = () => {
        hold();
        const b = active.term.buffer.active;
        // Some xterm/browser combinations have synchronised the native scroll
        // already; then output() must commit that candidate before writing.
        if (b.viewportY === b.baseY) inject('native-end', active.conn);
      };
      active.resumeFollowing = connection => {
        const b = active.term.buffer.active;
        const predictive = connection?.followCandidate && b.viewportY < b.baseY;
        resume(connection);
        // Other combinations reach the same point through Mesh's synchronous
        // touch projection.  Inject immediately after that re-enable.
        if (predictive) inject('projection', connection);
      };
    }""")
    await touch(tab, "touchStart", x, bottom)
    await touch(tab, "touchMove", x, top)                # manual return to the live end
    await touch(tab, "touchEnd", x, top)
    await tab.wait_for_timeout(500)
    state = await tab.evaluate("""() => {
      const b = active.term.buffer.active;
      return { follow: active.conn.followOutput, candidate: active.conn.followCandidate,
               viewportY: b.viewportY, baseY: b.baseY };
    }""")
    race = await tab.evaluate("window.returnRace")
    assert race["path"] in {"native-end", "projection"}, race
    assert race["before"]["candidate"] and not race["before"]["follow"], race
    if race["path"] == "native-end":
        assert race["before"]["viewportY"] == race["before"]["baseY"], race
    else:
        assert race["before"]["viewportY"] < race["before"]["baseY"], race
    assert race["followAtPacket"], race
    assert state["follow"] and state["viewportY"] == state["baseY"], state
    assert not await tab.evaluate(SHOWN)


async def test_hidden_in_the_alternate_buffer(mesh_page):
    tab = await mesh_page(ALTERNATE, DESKTOP, ready="active.term.buffer.active.type === 'alternate'")
    await tab.wait_for_timeout(300)
    assert not await tab.evaluate(SHOWN)


async def test_the_alternate_buffer_hides_it_after_it_was_shown(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -600)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.evaluate("active.term.write('\\x1b[?1049h')")
    await tab.wait_for_function(f"!({SHOWN})", timeout=3000)


async def test_on_a_phone_it_does_not_cover_the_input_line_the_key_bar_or_the_scrollbar(mesh_page):
    tab = await mesh_page(FLOOD, PHONE)
    await swipe_screen_down(tab)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.wait_for_timeout(300)                      # the fade ends
    button = await box(tab, BUTTON)
    assert await tab.evaluate("!document.querySelector('#line').hidden")
    assert not overlaps(button, await box(tab, "#line"))
    assert await tab.evaluate("!document.querySelector('#keys').hidden")
    assert not overlaps(button, await box(tab, "#keys"))
    viewport = await box(tab, ".pane.active .xterm-viewport")
    scrollbar_strip = {**viewport, "left": viewport["right"] - 12}
    assert not overlaps(button, scrollbar_strip)
    pane = await box(tab, ".pane.active .pane-body")
    assert pane["left"] <= button["left"] and button["right"] <= pane["right"]
    assert pane["top"] <= button["top"] and button["bottom"] <= pane["bottom"]


async def test_on_desktop_it_is_smaller_and_clear_of_the_scrollbar(mesh_page):
    tab = await mesh_page(FLOOD, DESKTOP)
    await tab.mouse.move(400, 300)
    await tab.mouse.wheel(0, -600)
    await tab.wait_for_function(SHOWN, timeout=3000)
    await tab.wait_for_timeout(300)
    button = await box(tab, BUTTON)
    assert button["right"] - button["left"] < 40
    viewport = await box(tab, ".pane.active .xterm-viewport")
    assert button["right"] <= viewport["right"] - 12
