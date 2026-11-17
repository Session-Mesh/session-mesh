# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The locally bundled Excalidraw board remains an adjacent private Mesh pane."""

import asyncio
import json

import aiohttp
import pytest

import server
import board
import opens
import ptyhost
from test_view_compat import goto
from conftest import ui


pytestmark = pytest.mark.usefixtures("pty")


async def start(mesh, home_dir, name="board-ui"):
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{mesh.origin}/api/new", headers={"Authorization": f"Bearer {server.TOKEN}"},
                             json={"preset": "shell", "cwd": str(home_dir), "name": name}) as response:
            assert response.status == 200, await response.text()
    return name


async def open_mesh(page, mesh, name, viewport=None):
    if viewport:
        await page.set_viewport_size(viewport)
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"panes.length === 1 && panes[0].id === {json.dumps(name)}")


async def open_board(page, name):
    await page.locator('[data-act="board"]').click()
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps('board:' + name)})")
    return page.frame_locator("iframe.web:not([hidden])")


async def draw_rectangle(page, frame):
    """A real drawing, through Excalidraw's toolbar and pointer events.

    The `r` shortcut does not select the tool in headless Chromium, so a test that
    only pressed it drew nothing and passed on whatever the page happened to save.
    """
    await frame.locator("[data-testid='toolbar-rectangle']").check(force=True)
    box = await frame.locator("canvas").last.bounding_box()
    assert box is not None
    await page.mouse.move(box["x"] + 180, box["y"] + 180)
    await page.mouse.down()
    await page.mouse.move(box["x"] + 260, box["y"] + 260, steps=8)
    await page.mouse.up()


async def board_document(mesh, name):
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{mesh.origin}/api/board/{name}", headers={"Authorization": f"Bearer {server.TOKEN}"}) as response:
            return await response.json()


async def wait_for_board(mesh, name, ready, seconds=5):
    """Poll the stored document from Python: a page-side poll of an async predicate is never awaited."""
    document = None
    for _ in range(int(seconds * 10)):
        document = await board_document(mesh, name)
        if ready(document):
            return document
        await asyncio.sleep(0.1)
    raise AssertionError(f"board never reached the expected state, last seen: {document}")


def shell_token(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read().decode()
    return dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)["MESH_SESSION_TOKEN"]


async def request_board_open(mesh, name):
    pid = next(session["pid"] for session in await ptyhost.request({"op": "list"})
               if session["name"] == name)
    headers = {"Authorization": f"MeshSession {shell_token(pid)}"}
    async with aiohttp.ClientSession() as http:
        response = await http.post(f"{mesh.origin}/api/board/@self/open", headers=headers)
        assert response.status == 200, await response.text()
        assert await response.json() == {"ok": True}


async def request_board_refresh(mesh, name):
    pid = next(session["pid"] for session in await ptyhost.request({"op": "list"})
               if session["name"] == name)
    headers = {"Authorization": f"MeshSession {shell_token(pid)}"}
    async with aiohttp.ClientSession() as http:
        response = await http.post(f"{mesh.origin}/api/board/@self/refresh", headers=headers)
        assert response.status == 200, await response.text()
        assert await response.json() == {"ok": True}


async def wait_gone(name):
    for _ in range(100):
        listed = await server.host({"op": "list"})
        if not any(session["name"] == name for session in listed):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"{name} was not reaped")


async def test_board_is_next_to_its_terminal_and_uses_only_local_assets(page, mesh, home_dir):
    name = await start(mesh, home_dir)
    await open_mesh(page, mesh, name)
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    assert await page.evaluate("panes.map((pane) => pane.id)") == [name, f"board:{name}"]
    assert await frame.locator(".board-status").text_content() == ui("board.saved")
    bad = [url for url in requests if not (url.startswith(mesh.origin) or url.startswith("data:") or url.startswith("blob:"))]
    assert not bad, bad


async def test_board_is_active_on_phone_and_back_returns_to_terminal(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-phone")
    await open_mesh(page, mesh, name, {"width": 390, "height": 800})
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    assert await page.evaluate("active.id") == f"board:{name}"
    await page.locator('[data-act="back"]').click()
    await page.wait_for_function(f"active.id === {json.dumps(name)}")


async def test_agent_board_open_is_scoped_and_never_reloads_an_open_board(page, mesh, home_dir):
    shown = await start(mesh, home_dir, "board-agent-shown")
    hidden = await start(mesh, home_dir, "board-agent-hidden")
    await open_mesh(page, mesh, shown)
    assert await page.evaluate("active.id") == shown
    await request_board_open(mesh, shown)
    await page.evaluate("refresh()")
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps('board:' + shown)})")
    assert await page.evaluate("active.id") == shown
    frame = page.locator("iframe.web:not([hidden])")
    before = await frame.get_attribute("src")
    await request_board_open(mesh, shown)  # same 12-second server request: no new navigation
    await page.evaluate("refresh()")
    assert await frame.get_attribute("src") == before
    await request_board_open(mesh, hidden)
    await page.evaluate("refresh()")
    assert await page.evaluate(f"panes.some((pane) => pane.id === {json.dumps('board:' + hidden)})") is False
    # Only the closed server-authored union member can request a board.  Neither
    # an unknown action nor a board record with an extra field controls the PWA.
    before_panes = await page.evaluate("panes.map((pane) => pane.id)")
    opens.OPENS.extend([
        {"kind": "anything-else", "seq": 10 ** 30, "at": 0, "session": shown},
        {"kind": "board-open", "seq": 10 ** 30 + 1, "at": 0, "session": shown, "extra": True},
    ])
    await page.evaluate("refresh()")
    assert await page.evaluate("panes.map((pane) => pane.id)") == before_panes
    assert await frame.get_attribute("src") == before
    assert await page.evaluate("active.id") == shown


async def test_board_update_badge_is_local_and_opens_only_after_a_human_click(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-badge")
    created = next(session["created"] for session in await server.host({"op": "list"}) if session["name"] == name)
    # This retained server hint predates this browser.  Its first listing must
    # establish a baseline, not make every existing board look newly changed.
    server.SIGNALS.publish(board.updated_envelope(name, 1, 1.0), created)
    await open_mesh(page, mesh, name, {"width": 390, "height": 800})
    assert await page.locator(f'.item[data-id="{name}"] .board-badge').count() == 0
    # This is a later server reference, so it becomes a local visual hint.
    server.SIGNALS.publish(board.updated_envelope(name, 2, 2.0), created)
    await page.evaluate("refresh()")
    assert await page.locator(f'.item[data-id="{name}"] .board-badge').count() == 1
    assert await page.locator('[data-act="board"].board-modified').count() == 1
    assert await page.evaluate("panes.some((pane) => pane.id === 'board:board-badge')") is False
    await page.locator('[data-act="board"]').click()
    await page.wait_for_function("active.id === 'board:board-badge'")
    assert await page.locator(f'.item[data-id="{name}"] .board-badge').count() == 0
    assert await page.locator('[data-act="board"].board-modified').count() == 0


async def test_reused_session_name_drops_its_old_board_badge(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-reused")
    await open_mesh(page, mesh, name)
    async with aiohttp.ClientSession() as http:
        response = await http.put(f"{mesh.origin}/api/board/{name}", headers={"Authorization": f"Bearer {server.TOKEN}"},
                                  json={"elements": [], "appState": {}, "files": {}, "version": 0})
        assert response.status == 200, await response.text()
    await page.evaluate("refresh()")
    assert await page.locator(f'.item[data-id="{name}"] .board-badge').count() == 1
    assert await server.host({"op": "kill", "name": name}) == {"ok": True}
    await wait_gone(name)
    assert await start(mesh, home_dir, name) == name
    await page.evaluate("refresh()")
    assert await page.locator(f'.item[data-id="{name}"] .board-badge').count() == 0


async def test_board_save_and_reload_uses_the_versioned_relative_api(page, mesh, home_dir):
    page.set_default_timeout(5000)
    name = await start(mesh, home_dir, "board-save")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await page.evaluate("setActive(panes.find((pane) => pane.id === 'board:board-save'))")
    await frame.locator(".excalidraw").wait_for()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    # Draw through Excalidraw itself: this exercises its onChange callback,
    # serialization and the debounced relative API write, rather than putting a
    # synthetic document directly through fetch.
    await draw_rectangle(page, frame)
    await wait_for_board(mesh, "board-save", lambda document: document["version"] == 1 and len(document["elements"]) == 1)
    await page.locator('.pane.active [data-act="more"]').click()
    await page.get_by_role("menuitem", name=ui("paneActions.action.reload")).click()
    frame = page.frame_locator("iframe.web:not([hidden])")
    await frame.locator(".excalidraw").wait_for()
    await wait_for_board(mesh, "board-save", lambda document: document["version"] == 1
                         and document["elements"][0]["type"] == "rectangle")
    # Reloading a non-empty board must not write it back as a new revision.
    await page.wait_for_timeout(1500)
    assert (await board_document(mesh, "board-save"))["version"] == 1


async def test_remote_board_replace_never_overwrites_an_open_stale_board(page, mesh, home_dir):
    """A stale browser scene stops locally and offers, but never forces, reload."""
    page.set_default_timeout(5000)
    name = await start(mesh, home_dir, "board-conflict")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    # This is the same CAS replacement an agent MCP call performs while the
    # browser iframe still has version zero.
    remote = {"elements": [{"id": "remote", "type": "rectangle"}], "appState": {}, "files": {}, "version": 0}
    async with aiohttp.ClientSession() as http:
        response = await http.put(f"{mesh.origin}/api/board/{name}",
                                  headers={"Authorization": f"Bearer {server.TOKEN}"}, json=remote)
        assert response.status == 200, await response.text()
    await draw_rectangle(page, frame)
    warning = frame.get_by_role("alert")
    await warning.get_by_text(ui("board.conflictMessage")).wait_for()
    assert await warning.get_by_role("button", name=ui("board.reloadRemote")).count() == 1
    # The attempted save was rejected by CAS: the remote document is intact.
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{mesh.origin}/api/board/{name}", headers={"Authorization": f"Bearer {server.TOKEN}"}) as response:
            saved = await response.json()
    assert saved == {**remote, "version": 1}
    # Reload is an explicit human choice; only then is the local canvas replaced.
    await warning.get_by_role("button", name=ui("board.reloadRemote")).click()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()


async def agent_put_board(mesh, name, document):
    """The write the board MCP bridge makes: the session's own token on the @self route."""
    pid = next(session["pid"] for session in await ptyhost.request({"op": "list"})
               if session["name"] == name)
    headers = {"Authorization": f"MeshSession {shell_token(pid)}"}
    async with aiohttp.ClientSession() as http:
        response = await http.put(f"{mesh.origin}/api/board/@self", headers=headers, json=document)
        assert response.status == 200, await response.text()
        return await response.json()


async def test_an_agent_write_refreshes_a_clean_open_board_without_a_click(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-agent-write")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    iframe = page.locator("iframe.web:not([hidden])")
    before = await iframe.get_attribute("src")
    remote = {"elements": [{"id": "remote", "type": "rectangle"}], "appState": {}, "files": {}, "version": 0}
    assert (await agent_put_board(mesh, name, remote))["version"] == 1
    await page.evaluate("refresh()")
    await frame.locator(".board-status").get_by_text(ui("board.updatedByAgent")).wait_for()
    assert await frame.get_by_role("alert").count() == 0
    assert await iframe.get_attribute("src") == before  # refreshed in place, never navigated
    await page.wait_for_timeout(1500)
    assert (await board_document(mesh, name))["version"] == 1  # nothing written back
    # The pane now holds the agent's scene and its version: a drawing saves on top of it
    # instead of conflicting, and the stored scene has both elements.
    await draw_rectangle(page, frame)
    document = await wait_for_board(mesh, name, lambda stored: stored["version"] == 2)
    assert len(document["elements"]) == 2
    assert await frame.get_by_role("alert").count() == 0


async def test_agent_refresh_offer_never_navigates_or_replaces_a_board_without_click(page, mesh, home_dir):
    """With a write of the person's own still in flight, a refresh stays an offer."""
    name = await start(mesh, home_dir, "board-refresh")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    held = []

    async def hold_writes(route):
        if route.request.method == "PUT":
            held.append(route)  # neither answered nor forwarded: the save stays in flight
        else:
            await route.continue_()

    await page.route(f"**/api/board/{name}", hold_writes)
    await draw_rectangle(page, frame)
    for _ in range(50):
        if held:
            break
        await page.wait_for_timeout(100)
    assert held, "the drawing never reached the save"
    iframe = page.locator("iframe.web:not([hidden])")
    before = await iframe.get_attribute("src")
    await request_board_refresh(mesh, name)
    await page.evaluate("refresh()")
    offer = frame.get_by_role("alert")
    await offer.get_by_text(ui("board.refreshOffer")).wait_for()
    assert await iframe.get_attribute("src") == before
    await offer.get_by_role("button", name=ui("board.keepDrawing")).click()
    assert await frame.get_by_role("alert").count() == 0
    for route in held:
        await route.abort()
    await page.unroute(f"**/api/board/{name}")


async def test_accepting_refresh_cancels_a_pending_local_debounce(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-refresh-debounce")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    remote = {"elements": [{"id": "remote", "type": "rectangle"}], "appState": {}, "files": {}, "version": 0}
    async with aiohttp.ClientSession() as http:
        response = await http.put(f"{mesh.origin}/api/board/{name}",
                                  headers={"Authorization": f"Bearer {server.TOKEN}"}, json=remote)
        assert response.status == 200, await response.text()
    # Schedule a stale owner write, but accept the agent's refresh offer before
    # its 550 ms debounce can fire.  The remote v1 must remain intact after it.
    await draw_rectangle(page, frame)
    await request_board_refresh(mesh, name)
    await page.evaluate("refresh()")
    offer = frame.get_by_role("alert")
    await offer.get_by_role("button", name=ui("board.reloadRemote")).click()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    await page.wait_for_timeout(700)
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{mesh.origin}/api/board/{name}", headers={"Authorization": f"Bearer {server.TOKEN}"}) as response:
            saved = await response.json()
    assert saved == {**remote, "version": 1}
    assert await frame.get_by_role("alert").count() == 0


async def board_version(mesh, name):
    return (await board_document(mesh, name))["version"]


async def test_an_idle_open_board_never_bumps_its_version(page, mesh, home_dir):
    """Every bump is a write an agent holding the previous version loses to with a 409."""
    name = await start(mesh, home_dir, "board-idle")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await frame.locator(".excalidraw").wait_for()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    await page.wait_for_timeout(3000)  # several 550 ms debounce periods
    assert await board_version(mesh, name) == 0


async def test_one_drawing_is_exactly_one_version(page, mesh, home_dir):
    name = await start(mesh, home_dir, "board-one-draw")
    await open_mesh(page, mesh, name)
    frame = await open_board(page, name)
    await page.evaluate(f"setActive(panes.find((pane) => pane.id === 'board:{name}'))")
    await frame.locator(".excalidraw").wait_for()
    await frame.locator(".board-status").get_by_text(ui("board.saved")).wait_for()
    await draw_rectangle(page, frame)
    await wait_for_board(mesh, name, lambda document: document["version"] >= 1)
    await page.wait_for_timeout(3000)  # several 550 ms debounce periods
    document = await board_document(mesh, name)
    assert document["version"] == 1 and [element["type"] for element in document["elements"]] == ["rectangle"]
