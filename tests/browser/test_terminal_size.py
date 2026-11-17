# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The terminal's size policy in a real browser: the redraw control forces a real
size change (the program sees SIGWINCH twice, the shrunk size then the real one),
and the page the owner is using takes the size (focus, visibility, a new socket)
without an automatic refit repeating a size it already sent."""

import pytest

import server
from test_sidebar_menu import api, entry
from test_view_compat import goto
from conftest import ui

pytestmark = pytest.mark.usefixtures("pty")

# a program that prints the pty size on every SIGWINCH, in the foreground; it prints WATCHING once its
# handler is set (the typed command reads WATCH"+"ING, so only the output matches). Python, not a bash
# trap: under load, bash 5.3's WINCH trap now and then missed one or both signals of a pair (CI, and
# 1 local run in 12); the Python handler missed none in 24
# one line: a multi-line command makes some shells echo continuation prompts ("> ") before the output
WATCH = ("exec python3 -c 'import os, signal, time; "
         "signal.signal(signal.SIGWINCH, lambda *_: print(\"W:%d %d\" % os.get_terminal_size()[::-1], flush=True)); "
         "print(\"WATCH\"+\"ING\", flush=True); [time.sleep(1) for _ in iter(int, 1)]'")
RECORD_SENDS = """(() => {
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string") window.__sent.push(JSON.parse(data));
    return send.call(this, data);
  };
})();"""


# the automatic redraw's pair (shrunk size, then the real one) has gone out; the size alone is sent twice
# on open (the socket, then the focus), so a count of messages is not enough
AUTO_PAIR_SENT = """(() => { const r = window.__sent.filter((m) => m.t === "r"), rows = active.term.rows;
  const i = r.findIndex((m) => m.rows === rows - 1); return i >= 0 && r.slice(i + 1).some((m) => m.rows === rows); })()"""


@pytest.fixture
async def terminal(browser, mesh, home_dir, plain_transport_shell):
    """A page with one shell session open in its pane; every resize message it sends is in window.__sent."""
    contexts = []

    async def open_mesh(name="sz", viewport=None, settled=True):
        await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
        context = await browser.new_context(viewport=viewport or {"width": 1000, "height": 600})
        contexts.append(context)
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        await context.add_init_script(RECORD_SENDS)
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.length >= 1", timeout=10000)
        await tab.click(f'#list .item[data-id="{name}"]')
        await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
        if settled:   # let the automatic redraw after the attach finish, so a test starts from a quiet wire
            await tab.wait_for_function(AUTO_PAIR_SENT, timeout=10000)
        return tab

    yield open_mesh
    for context in contexts:
        await context.close()


async def screen(tab):
    return await tab.evaluate("""(() => { const b = active.term.buffer.active; const out = [];
        for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join("\\n"); })()""")


async def watch_winch(tab):
    """Run the SIGWINCH printer in the session and wait until its trap is set."""
    await tab.evaluate("(c) => active.send(c + '\\r')", WATCH)
    for _ in range(200):
        if "WATCHING" in (await screen(tab)).splitlines():
            return
        await tab.wait_for_timeout(50)
    raise AssertionError("the SIGWINCH printer did not start: " + await screen(tab))


async def winches(tab, count, seconds=4):
    """The SIGWINCH lines the program printed, once there are `count` of them (or time is up)."""
    for _ in range(int(seconds / 0.05)):
        lines = [line for line in (await screen(tab)).splitlines() if line.startswith("W:")]
        if len(lines) >= count:
            break
        await tab.wait_for_timeout(50)
    return lines


async def size(tab):
    return await tab.evaluate("[active.term.rows, active.term.cols]")


async def redraw_from_pane_menu(tab):
    await tab.click('.pane.active [data-act="more"]')
    await tab.get_by_role("menuitem", name=ui("paneActions.action.redraw")).click()


async def test_opening_pane_menu_does_not_resize_the_running_terminal(terminal):
    tab = await terminal()
    await watch_winch(tab)
    original_size = await size(tab)
    await tab.evaluate("window.__sent.length = 0")
    await tab.click('.pane.active [data-act="more"]')
    assert await tab.get_by_role("menuitem", name=ui("paneActions.action.redraw")).is_visible()
    await tab.wait_for_timeout(150)  # allow any ResizeObserver notification to reach the PTY
    assert await size(tab) == original_size
    assert await tab.evaluate("window.__sent.filter((m) => m.t === 'r')") == []
    assert await winches(tab, 0, seconds=0.2) == []
    await tab.get_by_role("menuitem", name=ui("paneActions.action.file")).press("Escape")
    await tab.wait_for_timeout(150)
    assert await size(tab) == original_size
    assert await tab.evaluate("document.activeElement === active.el.querySelector('[data-act=more]')")
    assert await tab.evaluate("window.__sent.filter((m) => m.t === 'r')") == []
    # The header was built in a detached template document: this also proves
    # the outside listener belongs to the adopted, live document.
    await tab.click('.pane.active [data-act="more"]')
    await tab.mouse.click(2, 2)
    assert await tab.evaluate("active.el.querySelector('[role=menu]').hidden")
    assert await tab.evaluate("document.activeElement !== active.el.querySelector('[role=menu] button')")
    assert await tab.evaluate("window.__sent.filter((m) => m.t === 'r')") == []
    await tab.click('.pane.active [data-act="more"]')
    await tab.get_by_role("menuitem", name=ui("paneActions.action.file")).click()
    assert await tab.evaluate("active.el.querySelector('[role=menu]').hidden")
    assert await tab.evaluate("!active.el.querySelector('[role=menu]').contains(document.activeElement)")
    assert await tab.evaluate("window.__sent.filter((m) => m.t === 'r')") == []


async def test_the_redraw_button_gives_the_program_two_real_size_changes(terminal):
    tab = await terminal()
    await watch_winch(tab)
    rows, cols = await size(tab)
    assert await winches(tab, 0) == []
    await redraw_from_pane_menu(tab)
    got = await winches(tab, 2)
    sent = await tab.evaluate("window.__sent.filter((m) => m.t === 'r')")
    assert got == [f"W:{rows - 1} {cols}", f"W:{rows} {cols}"], (sent, await screen(tab))   # what went out, what came back
    assert await size(tab) == [rows, cols]   # the browser's own terminal never moved


async def test_the_sidebar_menu_redraws_the_session(terminal):
    tab = await terminal()
    await watch_winch(tab)
    rows, cols = await size(tab)
    await tab.click('#list .item[data-id="sz"]', button="right")
    await tab.click(entry(ui("menu.redraw")))
    assert await winches(tab, 2) == [f"W:{rows - 1} {cols}", f"W:{rows} {cols}"]


async def test_terminal_mode_recovery_is_explicit_local_and_preserves_the_screen(terminal):
    """A broken TUI may leave mouse/focus reports enabled.

    Recovery is a context-menu action that changes xterm locally.  It must not
    send bytes to the shell or erase the terminal contents: a legitimate live
    TUI keeps its modes until the person asks for recovery.
    """
    tab = await terminal()
    await tab.evaluate("""() => new Promise((resolve) => {
        active.term.write("MODE-RECOVERY-MARKER\\x1b[?1003h\\x1b[?1004h", resolve);
    })""")
    await tab.wait_for_function("active.term.modes.mouseTrackingMode === 'any' && active.term.modes.sendFocusMode")
    # X10 (DECSET ?9) is older but still supported by xterm.  It replaces the
    # any-event protocol above, so the recovery must clear it explicitly too.
    await tab.evaluate("""() => new Promise((resolve) => {
        active.term.write("\\x1b[?9h", resolve);
    })""")
    await tab.wait_for_function("active.term.modes.mouseTrackingMode === 'x10' && active.term.modes.sendFocusMode")
    # Opening a real context menu deliberately moves browser focus away from
    # xterm, so a *still enabled* focus-reporting mode emits its normal focus-
    # out report.  Start the wire assertion after that user gesture: the
    # recovery action itself must add no terminal input.
    await tab.click('#list .item[data-id="sz"]', button="right")
    await tab.evaluate("""(() => {
        window.__terminalRecoveryInput = [];
        active.sendRaw = (bytes) => window.__terminalRecoveryInput.push([...bytes]);
    })()""")
    assert "MODE-RECOVERY-MARKER" in await screen(tab)

    await tab.click(entry(ui("menu.resetModes")))
    await tab.wait_for_function("active.term.modes.mouseTrackingMode === 'none' && !active.term.modes.sendFocusMode")

    assert await tab.evaluate("window.__terminalRecoveryInput") == []
    assert "MODE-RECOVERY-MARKER" in await screen(tab)
    assert ui("terminal.modesReset").lower() in (await tab.locator("#flash").text_content()).lower()


async def test_redraw_goes_through_the_ordinary_resize_message(terminal):
    tab = await terminal()
    rows, cols = await size(tab)
    await tab.evaluate("window.__sent.length = 0")
    await redraw_from_pane_menu(tab)
    await tab.wait_for_function("window.__sent.length >= 2")
    assert await tab.evaluate("window.__sent") == [{"t": "r", "rows": rows - 1, "cols": cols},
                                                   {"t": "r", "rows": rows, "cols": cols}]


async def test_the_redraw_button_is_only_for_a_mesh_terminal(terminal):
    tab = await terminal()
    assert await tab.evaluate("paneMenuActions(active).some((action) => action.id === 'redraw')")
    absent = await tab.evaluate("""(() => { const p = new Pane(); p.id = "none"; p.header();
        return !paneMenuActions(p).some((action) => action.id === 'redraw'); })()""")
    assert absent


async def test_codex_raw_scrollback_enable_is_explicit_and_never_sent_to_a_shell(terminal):
    """`/raw on` explicitly enables Codex's raw-output mode.

    A normal Mesh terminal must not receive it: this is an agent-specific
    recovery action for an already-open Codex session, not a terminal escape
    sequence the browser may emit on its own.
    """
    tab = await terminal()
    raw_available = "paneMenuActions(active).some((action) => action.id === 'raw')"
    assert not await tab.evaluate(raw_available)

    await tab.evaluate("""(() => {
        const session = data.mesh.find((s) => s.id === "sz");
        // Launch provenance survives after Codex exits, when this is again a
        // shell.  It must not authorize an agent-only command.
        session.known_agent = "codex";
        session.agent = null;
        active.header();
        window.__rawScrollCommand = [];
        active.send = (value) => window.__rawScrollCommand.push(value);
    })()""")
    assert not await tab.evaluate(raw_available)
    await tab.evaluate("active.enableCodexRawScrollback()")
    assert await tab.evaluate("window.__rawScrollCommand") == []

    await tab.evaluate("""(() => {
        data.mesh.find((s) => s.id === "sz").agent = {type: "codex", foreground: false};
        active.header();
    })()""")
    assert not await tab.evaluate(raw_available)
    await tab.evaluate("active.enableCodexRawScrollback()")
    assert await tab.evaluate("window.__rawScrollCommand") == []

    await tab.evaluate("""(() => {
        data.mesh.find((s) => s.id === "sz").agent.foreground = true;
        active.header();
    })()""")
    assert await tab.evaluate(raw_available)
    await tab.locator('.pane.active [data-act="more"]').click()
    await tab.get_by_role("menuitem", name=ui("paneActions.action.raw")).click()
    assert await tab.evaluate("window.__rawScrollCommand") == ["/raw on\r"]
    assert ui("terminal.codexRawRequested").lower() in (await tab.locator("#flash").text_content()).lower()


async def test_a_new_socket_sends_the_size(terminal):
    tab = await terminal()
    rows, cols = await size(tab)
    assert {"t": "r", "rows": rows, "cols": cols} in await tab.evaluate("window.__sent")
    await tab.evaluate("window.__sent.length = 0; active.conn.ws.close()")   # the pane reconnects by itself
    await tab.wait_for_function("window.__sent.some((message) => message.t === 'r')", timeout=10000)
    sent_sizes = await tab.evaluate("window.__sent.filter((message) => message.t === 'r')")
    assert sent_sizes[0] == {"t": "r", "rows": rows, "cols": cols}


async def test_focusing_the_terminal_sends_the_size_again(terminal):
    tab = await terminal()
    rows, cols = await size(tab)
    await tab.evaluate("document.activeElement.blur(); window.__sent.length = 0")
    await tab.evaluate("active.term.focus()")
    await tab.wait_for_function("window.__sent.length >= 1")
    assert (await tab.evaluate("window.__sent"))[-1] == {"t": "r", "rows": rows, "cols": cols}


async def test_the_page_becoming_visible_sends_the_size(terminal):
    tab = await terminal()
    rows, cols = await size(tab)
    await tab.evaluate("""window.__sent.length = 0;
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));""")
    assert await tab.evaluate("window.__sent") == []   # going hidden says nothing
    await tab.evaluate("""Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));""")
    assert await tab.evaluate("window.__sent") == [{"t": "r", "rows": rows, "cols": cols}]


async def test_an_automatic_refit_does_not_repeat_a_size_already_sent(terminal):
    tab = await terminal()
    await tab.wait_for_timeout(300)
    await tab.evaluate("window.__sent.length = 0")
    await tab.evaluate("for (let i = 0; i < 5; i++) active.refit()")
    assert await tab.evaluate("window.__sent") == []
    await tab.set_viewport_size({"width": 700, "height": 420})   # a real change is still sent
    await tab.wait_for_function("window.__sent.length >= 1")
    await tab.wait_for_timeout(300)
    sent = await tab.evaluate("window.__sent")
    rows, cols = await size(tab)
    assert sent[-1] == {"t": "r", "rows": rows, "cols": cols}
    assert all(a != b for a, b in zip(sent, sent[1:]))   # never the same size twice in a row


# ---- the automatic redraw after an attach

def pair(rows, cols):
    """What one redraw sends: the shrunk size, then the real one."""
    return [{"t": "r", "rows": rows - 1, "cols": cols}, {"t": "r", "rows": rows, "cols": cols}]


async def test_attaching_redraws_once_with_the_two_size_pair(terminal):
    tab = await terminal(settled=False)
    await tab.wait_for_function("window.__sent.filter((message) => message.t === 'r').length >= 3", timeout=10000)
    await tab.wait_for_timeout(600)   # a second pair would have started by now
    # Read the pane size only now: while the replay is parsed, the terminal holds the replay geometry.
    rows, cols = await size(tab)
    assert await tab.evaluate("window.__sent.filter((message) => message.t === 'r')") == [
        {"t": "r", "rows": rows, "cols": cols}, *pair(rows, cols)]


async def test_a_reconnect_redraws_once_per_attach(terminal):
    tab = await terminal()
    rows, cols = await size(tab)
    await tab.evaluate("window.__sent.length = 0; active.conn.ws.close()")   # the pane reconnects by itself
    await tab.wait_for_function("window.__sent.filter((message) => message.t === 'r').length >= 3", timeout=10000)
    await tab.wait_for_timeout(600)
    assert await tab.evaluate("window.__sent.filter((message) => message.t === 'r')") == [
        {"t": "r", "rows": rows, "cols": cols}, *pair(rows, cols)]


async def test_a_socket_closed_before_the_replay_settles_does_not_redraw(terminal):
    tab = await terminal(settled=False)
    await tab.evaluate("active.detach()")
    await tab.evaluate("window.__sent.length = 0")
    await tab.wait_for_timeout(600)
    assert await tab.evaluate("window.__sent") == []


async def test_the_program_sees_the_automatic_redraw_as_two_real_size_changes(terminal):
    tab = await terminal()
    await watch_winch(tab)
    rows, cols = await size(tab)
    await tab.reload()
    await tab.wait_for_function("data?.mesh?.length >= 1", timeout=10000)
    await tab.click('#list .item[data-id="sz"]')
    assert await winches(tab, 2) == [f"W:{rows - 1} {cols}", f"W:{rows} {cols}"]
    await tab.wait_for_timeout(600)
    assert len(await winches(tab, 3, seconds=0.1)) == 2   # once, not in a loop


async def test_the_redraw_button_still_works_after_the_automatic_one(terminal):
    tab = await terminal()
    await tab.evaluate("window.__sent.length = 0")
    rows, cols = await size(tab)
    await redraw_from_pane_menu(tab)
    await tab.wait_for_function("window.__sent.length >= 2")
    await tab.wait_for_timeout(400)
    assert await tab.evaluate("window.__sent") == pair(rows, cols)


# Every binary frame the page sends (keyboard input and terminal replies), as latin-1 text.
RECORD_INPUT = """(() => {
  window.__input = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data !== "string") {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      window.__input.push(String.fromCharCode(...bytes));
    }
    return send.call(this, data);
  };
})();"""


async def test_the_replayed_output_gets_no_terminal_replies(browser, mesh, home_dir, plain_transport_shell):
    """A device-attributes (ESC [ c) or cursor-position (ESC [ 6 n) query in the replayed output was
    answered again at every (re)connection: `1;2c` or `;1R` fragments landed at the prompt."""
    import ptyhost
    from helpers import read_until
    await api(mesh, "/api/new", {"preset": "custom", "cwd": str(home_dir), "name": "queries",
                                 "command": "printf '\\033[c\\033[6n'; printf 'QUE''RIED\\n'"})
    reader, writer = await ptyhost.attach("queries", 24, 80)   # nobody answers while the queries run
    try:
        await read_until(reader, b"QUERIED", timeout=15)
    finally:
        writer.close()
    context = await browser.new_context(viewport={"width": 1000, "height": 600})
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        await context.add_init_script(RECORD_INPUT)
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.length >= 1", timeout=10000)
        await tab.click('#list .item[data-id="queries"]')
        for _ in range(2):   # the first attach, then a reconnection
            await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
            await tab.wait_for_function("""(() => { const b = active.term.buffer.active;
                for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === "QUERIED") return true;
                return false; })()""", timeout=10000)
            await tab.wait_for_timeout(500)
            sent = await tab.evaluate("window.__input")
            assert not [s for s in sent if "\x1b[" in s], sent
            await tab.evaluate("active.conn.ws.close()")
            await tab.wait_for_function("active?.conn?.ws?.readyState !== 1", timeout=10000)
        # live input still reaches the program
        await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
        await tab.wait_for_timeout(500)
        await tab.evaluate("active.send('printf \\'LI\\'\\'VE\\\\n\\'\\r')")
        await tab.wait_for_function("""(() => { const b = active.term.buffer.active;
            for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === "LIVE") return true;
            return false; })()""", timeout=10000)
    finally:
        await context.close()


# the left session's queries, written before the switch, reach xterm's parser only afterwards
LEFT_QUERIES = "\\x1b[>c\\x1b[6n\\x1b[6n"
LEFT_OUTPUT_LATE = {
    # an asynchronous handler holds xterm's parser before them until the next socket is open
    "parser": f"""(() => {{
      active.term.parser.registerOscHandler(7777, () => new Promise((resume) => {{ window.__resume = resume; }}));
      active.term.write('\\x1b]7777;hold\\x07{LEFT_QUERIES}');
      document.querySelector('#list .item[data-id="next"]').click();
    }})()""",
    # output held for a finger on the terminal, flushed by the hold timer once the next attach
    # has drained xterm but before its socket opens, and parsed late (a busy xterm): the same
    # asynchronous handler holds the parser
    "touch-hold": f"""(async () => {{
      const pane = active;
      pane.term.parser.registerOscHandler(7777, () => new Promise((resume) => {{ window.__resume = resume; }}));
      pane.holdOutput();
      pane.output(new TextEncoder().encode('\\x1b]7777;hold\\x07{LEFT_QUERIES}'));
      document.querySelector('#list .item[data-id="next"]').click();
      await new Promise((ready) => {{ const check = () => pane.conn?.name === "next" && pane.conn.draining === false
        ? ready() : setTimeout(check, 0); check(); }});
      if (pane.conn.terminal?.isOpen()) throw new Error("the socket opened before the flush");
      pane.releaseOutput();
      window.__resume ??= () => {{}};   // nothing held when the queue was dropped
    }})()""",
}


@pytest.mark.parametrize("late", sorted(LEFT_OUTPUT_LATE))
async def test_the_left_sessions_replies_do_not_reach_the_next_session(browser, mesh, home_dir,
                                                                      plain_transport_shell, late):
    """xterm's reset() keeps its write queue, and the pane's touch-hold queue kept the left
    session's output too: it could be parsed once the next session's socket was open, and
    xterm's replies to its queries went to that session (`0;276;0c1R1R...` at its prompt).
    The replay is held back here, as on a slow link."""
    import asyncio
    import re
    for name in ("left", "next"):
        await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
    context = await browser.new_context(viewport={"width": 1000, "height": 600})
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        release = asyncio.Event()

        async def slow_replay(ws):
            upstream = ws.connect_to_server()

            def forward(message):
                async def deliver():
                    await release.wait()
                    ws.send(message)
                asyncio.ensure_future(deliver())
            upstream.on_message(forward)
        await context.route_web_socket(re.compile(r"/ws/next\?"), slow_replay)
        tab = await context.new_page()
        sent = []
        tab.on("websocket", lambda ws: ws.on(
            "framesent", lambda payload: sent.append((ws.url.split("/ws/")[1].split("?")[0], payload))))
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.length >= 2", timeout=10000)
        await tab.click('#list .item[data-id="left"]')
        await tab.wait_for_function("active?.id === 'left' && active.conn?.ws?.readyState === 1"
                                    " && active.conn.replaying === false", timeout=10000)
        await tab.evaluate(LEFT_OUTPUT_LATE[late])
        await tab.wait_for_function("active?.id === 'next' && active.conn?.ws?.readyState === 1"
                                    " && typeof window.__resume === 'function'", timeout=10000)
        await tab.evaluate("window.__resume(true)")
        await tab.wait_for_timeout(300)
        release.set()
        await tab.wait_for_function("active.conn.replaying === false", timeout=10000)
        await tab.wait_for_timeout(500)
        replies = [payload for name, payload in sent
                   if name == "next" and not isinstance(payload, str) and b"\x1b[" in payload]
        assert replies == [], replies
        # live input still reaches the next session
        await tab.evaluate("active.send('printf \\'LI\\'\\'VE\\\\n\\'\\r')")
        await tab.wait_for_function("""(() => { const b = active.term.buffer.active;
            for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === "LIVE") return true;
            return false; })()""", timeout=10000)
    finally:
        await context.close()
