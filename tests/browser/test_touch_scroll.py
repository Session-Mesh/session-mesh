# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Touch scrolling in an emulated phone browser. A swipe on the text moves the
scrollback to the pixel, like the native scroll at the right edge; a program that
tracks the mouse gets wheel events instead; a tap still opens the input line."""

import pytest

import server
from test_sidebar_menu import PHONE, api
from test_view_compat import goto
from conftest import ui

pytestmark = [pytest.mark.usefixtures("pty"), pytest.mark.ci_local_only]

VIEWPORT = "document.querySelector('.pane.active .xterm-viewport')"
SCROLLTOP = f"{VIEWPORT}.scrollTop"
FLOOD = "exec bash --norc\rclear; seq 1 300\r"
TRACK = "exec bash --norc\rclear; printf '\\033[?1000h'; seq 1 300; read\r"
ALTERNATE = "exec bash --norc\rclear; seq 1 300; printf '\\033[?1049h\\033[?1000h'; seq 1 300; read\r"
LOOP_LINES = 300
# a program that keeps printing: one numbered line every 20 ms, after a screenful of history
PRINTING = f"exec bash --norc\rclear; seq 1 300; for i in $(seq 1 {LOOP_LINES}); do echo L$i; sleep 0.02; done; read\r"


@pytest.fixture
async def phone(browser, mesh, home_dir, plain_transport_shell):
    contexts = []

    async def open_mesh(command, name="tch", ready="active.term.buffer.active.length > active.term.rows + 100"):
        await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
        context = await browser.new_context(**PHONE)
        contexts.append(context)
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        # The sidebar is drawn on the frame after a listing is applied: wait for the drawn row.
        await tab.wait_for_function(f"document.querySelector('#list .item[data-id=\"{name}\"]') !== null", timeout=10000)
        await tab.evaluate(f"document.querySelector('#list .item[data-id=\"{name}\"]').click()")
        await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
        await tab.evaluate("(c) => active.send(c)", command)
        await tab.wait_for_function(ready, timeout=10000)
        await tab.wait_for_timeout(300)
        tab.cdp = await context.new_cdp_session(tab)
        return tab

    yield open_mesh
    for context in contexts:
        await context.close()


async def touch(tab, kind, x, y):
    points = [] if kind == "touchEnd" else [{"x": x, "y": y}]
    await tab.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})


async def swipe(tab, x, y0, y1, steps=12, pause=16):
    """Finger moves from y0 to y1; returns the viewport's scrollTop after each step."""
    seen = []
    await touch(tab, "touchStart", x, y0)
    for i in range(1, steps + 1):
        await touch(tab, "touchMove", x, y0 + (y1 - y0) * i / steps)
        await tab.wait_for_timeout(pause)
        seen.append(await tab.evaluate(SCROLLTOP))
    await touch(tab, "touchEnd", x, y1)
    return seen


async def terminal_touch_path(tab, travel):
    """Keep gestures in the terminal when the responsive header grows."""
    rect = await tab.evaluate("""() => {
      const r = document.querySelector('.pane.active .xterm-screen').getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    }""")
    x = (rect["left"] + rect["right"]) / 2
    y0 = rect["top"] + 24
    y1 = min(rect["bottom"] - 24, y0 + travel)
    assert y1 - y0 >= 40, rect
    return x, y0, y1


TEXT_POINT = """(() => {
  const term = active.term, screen = document.querySelector('.pane.active .xterm-screen');
  const box = screen.getBoundingClientRect(), buffer = term.buffer.active;
  for (let visual = 0; visual < term.rows; visual++) {
    const row = buffer.viewportY + visual, line = buffer.getLine(row);
    for (let col = 0; col < term.cols; col++) {
      if (line?.getCell(col)?.getChars()?.trim()) {
        return [box.left + (col + .5) * box.width / term.cols,
                box.top + (visual + .5) * box.height / term.rows];
      }
    }
  }
  return null;
})()"""

INTERIOR_TEXT_POINT = """(() => {
  const term = active.term, screen = document.querySelector('.pane.active .xterm-screen');
  const box = screen.getBoundingClientRect(), buffer = term.buffer.active;
  for (let visual = 0; visual < term.rows; visual++) {
    const row = buffer.viewportY + visual, line = buffer.getLine(row);
    for (let col = 2; col < term.cols - 1; col++) {
      if (line?.getCell(col)?.getChars()?.trim()) {
        return [box.left + (col + .5) * box.width / term.cols,
                box.top + (visual + .5) * box.height / term.rows];
      }
    }
  }
  return null;
})()"""


async def long_press(tab, x, y):
    await touch(tab, "touchStart", x, y)
    await tab.wait_for_timeout(650)  # exceeds LONG_PRESS_MS with CI scheduling slack


@pytest.mark.ci_browser_smoke
async def test_a_long_press_on_terminal_text_selects_it(phone):
    tab = await phone(FLOOD)
    x, y = await tab.evaluate(TEXT_POINT)
    await long_press(tab, x, y)
    assert await tab.evaluate("active.term.hasSelection()")
    assert await tab.evaluate("active.term.getSelection().length") > 0
    await touch(tab, "touchEnd", x, y)


async def test_phone_copy_button_copies_the_custom_terminal_selection(phone):
    tab = await phone(FLOOD)
    x, y = await tab.evaluate(TEXT_POINT)
    await long_press(tab, x, y)
    await touch(tab, "touchEnd", x, y)
    await tab.evaluate("""() => {
      window.__copied = null;
      // Mobile Chromium may clear xterm's canvas selection while synthesising
      // its compatibility click after touchend; exercise that fallback exactly.
      active.term.clearSelection();
      if (!active.mobileSelection) throw new Error('long-press text was not retained');
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
        writeText: async text => { window.__copied = text; },
      }});
      document.querySelector('#keys button[data-k="copy"]').click();
    }""")
    assert await tab.evaluate("window.__copied?.length") > 0
    assert not await tab.evaluate("active.mobileSelection")


async def test_phone_copy_button_explains_a_clipboard_refusal(phone):
    tab = await phone(FLOOD)
    x, y = await tab.evaluate(TEXT_POINT)
    await long_press(tab, x, y)
    await touch(tab, "touchEnd", x, y)
    await tab.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
        writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); },
      }});
      document.querySelector('#keys button[data-k="copy"]').click();
    }""")
    await tab.wait_for_function("(text) => document.querySelector('#flash').textContent === text", arg=ui("clipboard.copyDenied"))


async def test_phone_paste_button_is_an_explicit_clipboard_action(phone):
    tab = await phone(FLOOD)
    assert await tab.evaluate("""() => {
      window.__pasted = false;
      active.pasteClipboard = async () => { window.__pasted = true; };
      document.querySelector('#keys button[data-k="paste"]').click();
      return window.__pasted;
    }""")


async def test_a_swipe_on_the_text_scrolls_to_the_pixel(phone):
    tab = await phone(FLOOD)
    row = await tab.evaluate("document.querySelector('.pane.active .xterm-screen').clientHeight / active.term.rows")
    before = await tab.evaluate(SCROLLTOP)
    assert before > 0
    seen = await swipe(tab, 200, 300, 300 + 7 * 13 + 3)   # finger down: towards older output
    moved = before - seen[-1]
    assert moved > 60, (before, seen)                        # it follows the finger (plus a little glide)
    assert any(abs(v / row - round(v / row)) > 0.1 for v in seen), (row, seen)   # not only whole rows
    # xterm followed the viewport: the buffer is not at the bottom any more
    assert await tab.evaluate("active.term.buffer.active.viewportY < active.term.buffer.active.baseY")


@pytest.mark.ci_browser_smoke
async def test_a_swipe_starting_on_a_rendered_glyph_scrolls_to_the_pixel(phone):
    """A physical phone starts on a glyph, not an empty part of the canvas."""
    tab = await phone(FLOOD)
    x, y = await tab.evaluate(INTERIOR_TEXT_POINT)
    before = await tab.evaluate(SCROLLTOP)
    seen = await swipe(tab, x, y, y + 7 * 13 + 3)
    moved = before - seen[-1]
    assert moved > 60, (before, (x, y), seen)
    assert await tab.evaluate("active.term.buffer.active.viewportY < active.term.buffer.active.baseY")


@pytest.mark.ci_browser_smoke
async def test_vertical_swipe_from_left_edge_reaches_the_terminal(phone):
    """The drawer's edge gesture must not consume a vertical text scroll."""
    tab = await phone(FLOOD)
    before = await tab.evaluate(SCROLLTOP)
    await swipe(tab, 24, 260, 440, steps=1, pause=0)
    await tab.wait_for_timeout(100)
    assert await tab.evaluate(SCROLLTOP) < before - 60


async def test_a_swipe_up_returns_towards_the_end(phone):
    tab = await phone(FLOOD)
    x, y0, y1 = await terminal_touch_path(tab, 300)
    await swipe(tab, x, y0, y1)
    await tab.wait_for_timeout(1500)   # the glide ends
    mid = await tab.evaluate(SCROLLTOP)
    await swipe(tab, x, y1, y0)
    await tab.wait_for_timeout(1500)
    assert await tab.evaluate(SCROLLTOP) > mid


WHEEL_COUNTER = """window.__wheel = 0;
    document.querySelector('.pane.active .xterm-screen').addEventListener('wheel', () => window.__wheel++, true)"""
# every write to the terminal, with its time and size
SPY_WRITES = """window.__writes = []; const w = active.term.write.bind(active.term);
    active.term.write = (d, cb) => { window.__writes.push([performance.now(), d?.length]); return w(d, cb); }; 0"""
BUFFER_LINES = """(() => { const b = active.term.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out; })()"""


async def test_a_fullscreen_program_tracking_the_mouse_gets_wheel_events(phone):
    tab = await phone(ALTERNATE, ready="active.term.buffer.active.type === 'alternate'")
    await tab.wait_for_function("active.term.buffer.active.type === 'alternate' && active.term.modes.mouseTrackingMode !== 'none'", timeout=10000)
    await tab.evaluate(WHEEL_COUNTER)
    before = await tab.evaluate(SCROLLTOP)
    await swipe(tab, 200, 500, 200)
    await tab.wait_for_function("window.__wheel >= 2", timeout=3000)
    assert await tab.evaluate(SCROLLTOP) == before   # the viewport is not scrolled: no scrollback there


@pytest.mark.ci_browser_smoke
async def test_fast_fullscreen_swipe_keeps_more_than_the_first_fifteen_notches(phone):
    """A quick drag must not silently discard most of the requested history.

    This exercises the alternate buffer used by full-screen agent clients. The
    finger stays down until the queue drains, so momentum cannot mask a lost
    move. It is a browser regression, not a physical Android acceptance test.
    """
    tab = await phone(ALTERNATE, ready="active.term.buffer.active.type === 'alternate'")
    await tab.wait_for_function("active.term.modes.mouseTrackingMode !== 'none'", timeout=10000)
    await tab.evaluate(WHEEL_COUNTER)
    x, top, bottom = await terminal_touch_path(tab, 360)
    await touch(tab, "touchStart", x, bottom)
    await touch(tab, "touchMove", x, top)
    await tab.wait_for_function("window.__wheel >= 25", timeout=3000)
    count = await tab.evaluate("window.__wheel")
    await touch(tab, "touchEnd", x, top)
    assert count >= 25, count


@pytest.mark.ci_browser_smoke
async def test_new_touch_cancels_queued_fullscreen_wheel_events(phone):
    tab = await phone(ALTERNATE, ready="active.term.buffer.active.type === 'alternate'")
    await tab.wait_for_function("active.term.modes.mouseTrackingMode !== 'none'", timeout=10000)
    await tab.evaluate(WHEEL_COUNTER)
    x, top, bottom = await terminal_touch_path(tab, 360)
    await touch(tab, "touchStart", x, bottom)
    await touch(tab, "touchMove", x, top)
    await tab.wait_for_function("window.__wheel >= 4", timeout=3000)
    await touch(tab, "touchEnd", x, top)
    await touch(tab, "touchStart", x, top)
    stopped = await tab.evaluate("window.__wheel")
    await tab.wait_for_timeout(250)
    assert await tab.evaluate("window.__wheel") == stopped
    await touch(tab, "touchEnd", x, top)


async def test_the_normal_buffer_scrolls_per_pixel_even_when_the_program_tracks_the_mouse(phone):
    tab = await phone(TRACK)
    await tab.wait_for_function("active.term.modes.mouseTrackingMode !== 'none'", timeout=10000)
    assert await tab.evaluate("active.term.buffer.active.type") == "normal"
    await tab.evaluate(WHEEL_COUNTER)
    before = await tab.evaluate(SCROLLTOP)
    seen = await swipe(tab, 200, 300, 300 + 7 * 13 + 3)
    assert before - seen[-1] > 60, (before, seen)
    assert await tab.evaluate("window.__wheel") == 0   # no wheel notch went to the program


async def test_a_swipe_while_the_program_prints_follows_the_finger(phone):
    tab = await phone(PRINTING)
    x, y0, y1 = await terminal_touch_path(tab, 160)
    seen = await swipe(tab, x, y0, y1, steps=20, pause=30)   # finger down: towards older output
    series = seen[2:]   # the first samples still see output written just before the finger moved
    print("scrollTop series:", seen)
    steps = [a - b for a, b in zip(series, series[1:])]   # positive: moved up, as the finger does
    assert all(d >= -1 for d in steps), series            # never snaps back
    assert sum(1 for d in steps if d > 0) >= 14, series   # keeps moving at (nearly) every step
    assert 100 < series[0] - series[-1] < 250, series     # about the finger's travel (140 px here)


@pytest.mark.ci_browser_smoke
async def test_phone_reader_keeps_same_line_when_full_scrollback_trims(phone):
    tab = await phone("exec bash --norc\rclear; seq 1 30000; read\r")
    await tab.wait_for_function("active.term.buffer.active.length >= 20000", timeout=10000)
    await tab.wait_for_function("""() => {
      const b = active.term.buffer.active;
      return b.getLine(b.baseY + b.cursorY - 1)?.translateToString(true) === '30000';
    }""", timeout=10000)
    await swipe(tab, 200, 250, 550, steps=8, pause=8)
    await tab.evaluate("active.stopGlide(); active.releaseOutput()")
    await tab.wait_for_timeout(100)
    before = await tab.evaluate("""() => {
      const b = active.term.buffer.active;
      return b.getLine(b.viewportY)?.translateToString(true);
    }""")
    await tab.evaluate("""() => {
      for (let i = 0; i < 20; i++) active.output(new TextEncoder().encode(`new-${i}\\r\\n`));
    }""")
    await tab.wait_for_timeout(300)
    after = await tab.evaluate("""() => {
      const b = active.term.buffer.active;
      return b.getLine(b.viewportY)?.translateToString(true);
    }""")
    assert after == before, (before, after)


@pytest.mark.ci_browser_smoke
async def test_output_is_intact_and_in_order_after_a_swipe(phone):
    tab = await phone(PRINTING)
    await swipe(tab, 200, 200, 360, steps=20, pause=30)
    await tab.wait_for_function(f"{BUFFER_LINES}.includes('L{LOOP_LINES}')", timeout=20000)
    lines = [line for line in await tab.evaluate(BUFFER_LINES) if line.startswith("L") and line[1:].isdigit()]
    assert lines == [f"L{i}" for i in range(1, LOOP_LINES + 1)]


@pytest.mark.ci_browser_smoke
async def test_output_is_held_while_the_finger_scrolls_and_released_after(phone):
    tab = await phone(PRINTING)
    await tab.evaluate(SPY_WRITES)
    x, y0, y1 = await terminal_touch_path(tab, 40)
    await touch(tab, "touchStart", x, y0)
    await touch(tab, "touchMove", x, y1)
    await tab.wait_for_timeout(50)
    t0 = await tab.evaluate("performance.now()")
    await tab.wait_for_timeout(600)
    held = await tab.evaluate(f"window.__writes.filter(([t]) => t > {t0}).length")
    await touch(tab, "touchEnd", x, y1)
    await tab.wait_for_timeout(2500)   # the glide ends
    assert held == 0
    assert await tab.evaluate(f"window.__writes.filter(([t]) => t > {t0} + 600).length") > 0


async def test_a_long_hold_of_the_finger_does_not_hold_output_beyond_the_cap(phone):
    tab = await phone(PRINTING)
    await tab.evaluate(SPY_WRITES)
    x, y0, y1 = await terminal_touch_path(tab, 40)
    await touch(tab, "touchStart", x, y0)
    await touch(tab, "touchMove", x, y1)
    start = await tab.evaluate("performance.now()")
    await tab.wait_for_timeout(3500)   # the finger stays down, still
    stamps = [start] + [t for t, _ in await tab.evaluate("window.__writes") if t > start]
    await touch(tab, "touchEnd", x, y1)
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert len(stamps) >= 3, stamps
    assert max(gaps) > 700, gaps    # it was held...
    assert max(gaps) < 1400, gaps   # ...but not beyond the cap (1000 ms plus timer slack)


async def test_a_tap_does_not_hold_output(phone):
    tab = await phone(PRINTING)
    await tab.evaluate(SPY_WRITES)
    await touch(tab, "touchStart", 200, 300)
    await touch(tab, "touchEnd", 200, 300)
    t0 = await tab.evaluate("performance.now()")
    await tab.wait_for_timeout(400)
    # ~50 lines a second keep arriving, a few writes per 100 ms
    assert await tab.evaluate(f"window.__writes.filter(([t]) => t > {t0}).length") >= 5


@pytest.mark.ci_browser_smoke
async def test_a_tap_opens_the_input_line(phone):
    tab = await phone(FLOOD)
    assert await tab.evaluate("touch && !document.querySelector('#line').hidden")   # a phone: the input line is there
    # the socket's onopen focuses the terminal: tap only once it is open, or that focus
    # lands after ours (a race seen on slower CI runners)
    await tab.wait_for_function("active?.conn?.ws?.readyState === WebSocket.OPEN", timeout=10000)
    await tab.wait_for_timeout(200)
    await tab.evaluate("document.activeElement.blur()")
    await touch(tab, "touchStart", 200, 300)
    await touch(tab, "touchEnd", 200, 300)
    try:
        await tab.wait_for_function("document.activeElement?.id === 'line-text'", timeout=3000)
    except Exception:
        raise AssertionError(await tab.evaluate("({tag: document.activeElement?.tagName, cls: document.activeElement?.className, id: document.activeElement?.id})"))
