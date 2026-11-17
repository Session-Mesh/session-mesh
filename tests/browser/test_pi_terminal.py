# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Real offline Pi rendering through Mesh, without provider calls."""
import json
import shlex
import shutil
import pytest
from conftest import ui
from test_touch_scroll import phone, swipe, terminal_touch_path, BUFFER_LINES

pytestmark = [pytest.mark.usefixtures("pty"), pytest.mark.ci_local_only]

@pytest.mark.parametrize("mode", ["fullscreen", "regular"])
@pytest.mark.parametrize("gesture", ["touch", "wheel"])
async def test_real_pi_history_scroll(phone, home_dir, mode, gesture, monkeypatch):
    pi = shutil.which("pi")
    if not pi:
        pytest.skip("Pi CLI unavailable")
    config = home_dir / "config"
    folder = config / "sessions" / "--test--"
    folder.mkdir(parents=True)
    transcript = folder / "pi.jsonl"
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(config))
    entries = [{"type":"session", "version":3, "id":"123e4567-e89b-12d3-a456-426614174000", "timestamp":"2026-11-10T00:00:00.000Z", "cwd":str(home_dir)}]
    parent = None
    for i in range(80):
        entry_id = f"{i:08x}"
        entries.append({"type":"message", "id":entry_id, "parentId":parent, "timestamp":"2026-11-10T00:00:01.000Z", "message":{"role":"user", "content":f"PI-HISTORY-{i:03d} " + "history line " * 8, "timestamp":1794268801000}})
        parent = entry_id
    transcript.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    argv = [pi, "--session", str(transcript), "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-extensions", "--tui-mode", mode]
    command = "exec env PI_CODING_AGENT_DIR=" + shlex.quote(str(home_dir / "config")) + " " + shlex.join(argv) + "\r"
    tab = await phone(command, ready="active.term.buffer.active.type === 'alternate'" if mode == "fullscreen" else "active.term.buffer.active.length > active.term.rows + 100")
    await tab.wait_for_function("""() => { const b = active.term.buffer.active;
      for (let i = 0; i < b.length; i++)
        if (b.getLine(i)?.translateToString(true).includes('PI-HISTORY-079')) return true;
      return false;
    }""", timeout=20000)
    if gesture == "wheel":
        await tab.set_viewport_size({"width": 1200, "height": 800})
        await tab.wait_for_timeout(300)
    # A returning browser receives a replay and a resize-driven redraw.
    await tab.reload()
    await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_timeout(1000)
    before = await tab.evaluate(BUFFER_LINES)
    x, top, bottom = await terminal_touch_path(tab, 200)
    if gesture == "touch":
        await swipe(tab, x, top, bottom)
    else:
        await tab.mouse.move(x, (top + bottom) / 2)
        await tab.mouse.wheel(0, -240)
    await tab.wait_for_timeout(1000)
    after = await tab.evaluate(BUFFER_LINES)
    if mode == "fullscreen":
        assert before != after, (before, after)
    else:
        assert await tab.evaluate("active.term.modes.mouseTrackingMode") == "none"
        assert await tab.evaluate("active.term.buffer.active.viewportY < active.term.buffer.active.baseY")


# A stand-in for the Pi fullscreen renderer, run as a process named `pi` (which is how the server
# recognises the agent). Black box: it enables the modes Pi enables at startup, prints a screen of
# history, then writes 3 MB, more than the host's 2 MiB replay window, so that the window no longer
# holds the mode-setting bytes. It logs every byte it receives and every window-size signal.
# bash, not sh: dash (Ubuntu's /bin/sh) gives a background job /dev/null as its standard input
# before `<&0` is applied, so `cat` would read nothing and the scroll would never reach the log.
FAKE_PI = r"""#!/bin/bash
trap 'echo winch >> "$FAKE_PI_DIR/winch"' WINCH
stty -icanon -echo min 1
printf '\033[?1049h\033[?1000h\033[?1002h\033[?1003h\033[?1006h'
i=0
while [ "$i" -lt 80 ]; do printf 'PI-REPLAY-%03d history line history line history line\r\n' "$i"; i=$((i + 1)); done
head -c 3000000 /dev/zero | tr '\0' 'x' | fold -w 100
printf '\r\nFLOOD-END\r\n'
: > "$FAKE_PI_DIR/flooded"
cat <&0 >> "$FAKE_PI_DIR/input" &
wait
while :; do wait; done
"""


@pytest.mark.parametrize("gesture", ["touch", "wheel"])
async def test_pi_fullscreen_scroll_recovers_trimmed_modes_without_pty_input(phone, home_dir, gesture):
    """Black box: the replay window of the host drops the modes, the client recovers them locally.

    Only what a program in the session can observe is used: the bytes it reads and its window-size
    signals. Recovery must send the program nothing (no input, no resize); only the scroll that follows
    it, now in mouse-tracking mode, reaches the program as a mouse report.
    """
    folder = home_dir / "fake-pi"
    folder.mkdir()
    fake = folder / "pi"
    fake.write_text(FAKE_PI)
    fake.chmod(0o755)
    received, winches, flooded = folder / "input", folder / "winch", folder / "flooded"
    tab = await phone("exec env FAKE_PI_DIR=" + shlex.quote(str(folder)) + " " + shlex.quote(str(fake)) + "\r",
                      ready="active.term.buffer.active.type === 'alternate'")
    await tab.wait_for_function("data.mesh.some(s => s.id === active.id && s.agent?.type === 'pi' && s.agent?.foreground === true)",
                                timeout=10000)
    for _ in range(300):
        if flooded.exists():
            break
        await tab.wait_for_timeout(100)
    assert flooded.exists(), "the stand-in never finished writing its output"
    if gesture == "wheel":
        await tab.set_viewport_size({"width": 1200, "height": 800})
        await tab.wait_for_timeout(300)
    # A returning browser gets the replay window, which no longer holds the startup modes.
    await tab.reload()
    await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
    await tab.wait_for_timeout(1200)
    assert await tab.evaluate("active.term.buffer.active.type") == "normal"
    assert await tab.evaluate("active.term.modes.mouseTrackingMode") == "none"
    winches_before = winches.read_text() if winches.exists() else ""
    before = await tab.evaluate(BUFFER_LINES)
    x, top, bottom = await terminal_touch_path(tab, 180)

    async def scroll():
        if gesture == "touch":
            await swipe(tab, x, top, bottom)
        else:
            await tab.mouse.move(x, (top + bottom) / 2)
            await tab.mouse.wheel(0, -240)
        await tab.wait_for_timeout(700)

    await scroll()
    # Without the modes the wheel scrolls the local history: the program received nothing.
    assert not received.exists() or received.read_bytes() == b""
    await tab.evaluate("active.stopGlide(); active.releaseOutput()")
    await tab.evaluate("""label => {
      const s = find(active.id), c = active.conn, created = s.created;
      const action = menuEntries(s.id).find(e => e.label === label);
      if (!Number.isFinite(created)) throw new Error('real fixture lacks incarnation');
      delete s.created; delete c.created;
      action.run();
      s.created = c.created = created;
      // Keep the action's captured old object while replacing inventory identity.
      data.mesh = data.mesh.map(e => e.id === s.id ? {...e, created: created + 1} : e);
      action.run();
      find(s.id).created = created;
    }""", ui("menu.restorePiScroll"))
    assert await tab.evaluate("active.term.modes.mouseTrackingMode") == "none"
    if gesture == "touch":
        await tab.locator("#btn-mobile-actions").tap()
        await tab.locator("#mobile-pi-scroll").tap()
    else:
        await tab.locator('#list .item[data-id="tch"]').first.click(button="right")
        await tab.get_by_role("menuitem", name=ui("menu.restorePiScroll"), exact=True).click()
    await tab.wait_for_function("active.term.modes.mouseTrackingMode !== 'none'")
    await tab.wait_for_timeout(500)
    assert not received.exists() or received.read_bytes() == b"", "the recovery wrote to the program"
    assert (winches.read_text() if winches.exists() else "") == winches_before, "the recovery resized the program"
    assert await tab.evaluate("active.term.buffer.active.type") == "normal"
    assert await tab.evaluate(BUFFER_LINES) == before
    await scroll()
    assert received.exists() and b"\x1b[<" in received.read_bytes(), "the scroll in mouse mode did not reach the program"
