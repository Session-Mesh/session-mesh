# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The sidebar in a real browser: dragging near an edge scrolls the list, and a
session has a context menu (right click, long press, menu key)."""

import asyncio
import json

import aiohttp
import pytest

import server
from conftest import ui
from test_view_compat import goto

pytestmark = [pytest.mark.usefixtures("pty"), pytest.mark.ci_local_only]
MASTER = {"Authorization": f"Bearer {server.TOKEN}"}
PHONE = {"viewport": {"width": 390, "height": 800}, "has_touch": True, "is_mobile": True}


class Scripted:
    """A browser tab whose confirm()/prompt() answers are decided by the test."""

    def __init__(self, tab):
        self.tab, self.dialogs, self.accept, self.reply = tab, [], True, None
        tab.on("dialog", lambda dialog: asyncio.ensure_future(self._answer(dialog)))

    async def _answer(self, dialog):
        self.dialogs.append((dialog.type, dialog.message))
        await (dialog.accept(self.reply) if self.accept else dialog.dismiss())


async def api(mesh, path, body):
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{mesh.origin}{path}", json=body, headers=MASTER) as resp:
            assert resp.status == 200, await resp.text()


@pytest.fixture
async def desk(browser, mesh, home_dir):
    """make(names, ...) -> (tab, scripted dialogs): a mesh showing these new sessions."""
    opened = []

    async def make(names, viewport=None, **context_options):
        for name in names:
            await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": name})
        context = await browser.new_context(viewport=viewport or {"width": 1000, "height": 520}, **context_options)
        opened.append(context)
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function(f"data?.mesh?.length >= {len(names)}", timeout=10000)
        return tab, Scripted(tab)

    yield make
    for context in opened:
        await context.close()


def item(name):
    return f'#list .item[data-id="{name}"]'


def loose(name):
    """The row in the mesh list itself (a session that needs me is also shown, undraggable, up top)."""
    return f'#list .loose .item[data-id="{name}"]'


def folder_head(name):
    return f'#list [data-folder-head="{name}"]'


def folder_rename(name):
    return f'#list [data-folder-rename="{name}"]'


async def session_of(tab, name):
    return await tab.evaluate("(n) => data.mesh.find((s) => s.name === n)", name)


async def visible_order(tab):
    return await tab.evaluate("[...document.querySelectorAll('#list .loose .item')].map((e) => e.dataset.id)")


MENU = ".ctx-menu"


def entry(label):
    return f'{MENU} [role=menuitem]:has-text("{label}")'


async def menu_labels(tab):
    return await tab.eval_on_selector_all(f"{MENU} [role=menuitem]", "(e) => e.map((x) => x.textContent.trim())")


# ------------------------------------------------------------ drag autoscroll

async def until(tab, expression, seconds=8):
    """Poll in the page (Playwright's own waiting does not return while a drag is held)."""
    for _ in range(int(seconds / 0.05)):
        if await tab.evaluate(expression):
            return
        await tab.wait_for_timeout(50)
    raise AssertionError(f"still false after {seconds}s: {expression}")


async def start_drag(tab, name):
    row = await tab.query_selector(loose(name))
    await row.scroll_into_view_if_needed()
    box = await row.bounding_box()
    await tab.mouse.move(box["x"] + 30, box["y"] + 15)
    await tab.mouse.down()
    await tab.mouse.move(box["x"] + 40, box["y"] + 60, steps=4)
    return box


async def test_dragging_near_the_bottom_edge_scrolls_the_list_and_the_drop_lands_there(desk):
    tab, _ = await desk([f"drag-bottom-{i:02d}" for i in range(10)])
    await tab.fill("#filter", "drag-bottom-")
    assert len(await visible_order(tab)) == 10
    assert await tab.evaluate("$('#list').scrollHeight > $('#list').clientHeight + 100")
    order = await visible_order(tab)
    first, last = order[0], order[-1]
    assert first != last
    assert await tab.evaluate("$('#list').scrollTop") == 0
    box = await start_drag(tab, first)
    start = await tab.evaluate("$('#list').scrollTop")
    await tab.mouse.move(box["x"] + 40, await tab.evaluate("innerHeight") - 8, steps=4)   # bottom edge
    await until(tab, f"$('#list').scrollTop > {start + 60}")
    await until(tab, f"""(() => {{ const r = $('#list').getBoundingClientRect(), t = $('{loose(last)}').getBoundingClientRect();
                         return t.top > r.top + 20 && t.bottom < r.bottom - 20; }})()""")   # the last row is in view
    await tab.mouse.move(box["x"] + 40, box["y"] + 100)                    # off the edge: it stops
    target = await (await tab.query_selector(loose(last))).bounding_box()
    await tab.mouse.move(target["x"] + 40, target["y"] + 8, steps=3)
    focused_id = await tab.evaluate("document.activeElement?.closest('#list .item')?.dataset.id || null")
    await tab.mouse.up()
    await tab.wait_for_function(f"data.mesh.map((s) => s.id).indexOf('{first}') === data.mesh.length - 2")
    assert (await visible_order(tab))[-2:] == [first, last]
    assert await visible_order(tab) == await tab.evaluate("data.mesh.map(s => s.id)")
    if focused_id:
        assert await tab.evaluate("document.activeElement?.closest('#list .item')?.dataset.id") == focused_id


async def test_dragging_near_the_top_edge_scrolls_back_up(desk):
    tab, _ = await desk([f"drag-top-{i:02d}" for i in range(10)])
    await tab.fill("#filter", "drag-top-")
    assert len(await visible_order(tab)) == 10
    last = (await visible_order(tab))[-1]
    await tab.evaluate(f"$('{loose(last)}').scrollIntoView({{ block: 'center' }})")
    start = await tab.evaluate("$('#list').scrollTop")
    assert start > 200
    box = await start_drag(tab, last)
    top = await tab.evaluate("$('#list').getBoundingClientRect().top")
    await tab.mouse.move(box["x"] + 40, top - 12, steps=4)                 # over the filter, past the list
    await until(tab, f"$('#list').scrollTop < {start - 200}")
    await tab.mouse.up()


async def test_the_list_stops_scrolling_after_the_drop(desk):
    tab, _ = await desk([f"drag-stop-{i:02d}" for i in range(10)])
    await tab.fill("#filter", "drag-stop-")
    assert len(await visible_order(tab)) == 10
    box = await start_drag(tab, (await visible_order(tab))[0])
    start = await tab.evaluate("$('#list').scrollTop")
    await tab.mouse.move(box["x"] + 40, await tab.evaluate("innerHeight") - 8, steps=4)
    await until(tab, f"$('#list').scrollTop > {start + 20}")
    await tab.mouse.up()
    await tab.wait_for_timeout(200)
    rest = await tab.evaluate("$('#list').scrollTop")
    await tab.wait_for_timeout(400)
    assert await tab.evaluate("$('#list').scrollTop") == rest


# ------------------------------------------------------------ the menu

async def right_click(tab, name):
    await tab.click(item(name), button="right")
    await tab.wait_for_selector(MENU)


@pytest.mark.ci_browser_smoke
async def test_the_menu_of_a_mesh_session_lists_its_actions(desk):
    tab, _ = await desk(["ma"])
    await right_click(tab, "ma")
    assert await menu_labels(tab) == [ui("menu.rename"), ui("menu.moveTo"), ui("menu.openInColumn"),
                                      ui("menu.redraw"), ui("menu.resetModes"),
                                      ui("menu.closeSession")]


@pytest.mark.ci_browser_smoke
@pytest.mark.parametrize("key", ["Enter", "Escape"])
async def test_rename_from_the_menu(desk, key):
    tab, _ = await desk(["mb"])
    await right_click(tab, "mb")
    await tab.click(entry(ui("menu.rename")))
    await tab.wait_for_selector("#list input.rename")
    await tab.fill("#list input.rename", "Joli nom")
    await tab.press("#list input.rename", key)
    if key == "Enter":
        await tab.wait_for_function("data.mesh.some((s) => s.name === 'mb' && s.label === 'Joli nom')")
    await tab.wait_for_function("!document.querySelector('#list input.rename')", timeout=1500)
    assert not await tab.evaluate("document.activeElement?.matches('input.rename')")
    await tab.evaluate("refresh()")
    row = await session_of(tab, "mb")
    assert row.get("label") == ("Joli nom" if key == "Enter" else None)
    assert await tab.inner_text(f'{item(row["id"])} .name') == ("Joli nom" if key == "Enter" else "mb")
    assert not await tab.query_selector(MENU)


async def test_move_to_an_existing_folder(desk, mesh):
    tab, _ = await desk(["mc", "md"])
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Projets"})
    await tab.evaluate("refresh()")
    await tab.wait_for_function("data.folders?.includes('Projets')")
    await right_click(tab, "mc")
    await tab.click(entry(ui("menu.moveTo")))
    await tab.click(entry("Projets"))
    await tab.wait_for_function("data.mesh.some((s) => s.name === 'mc' && s.folder === 'Projets')")
    assert not (await session_of(tab, "md"))["folder"]
    assert not await tab.query_selector(MENU)


async def test_move_out_of_its_folder(desk, mesh):
    tab, _ = await desk(["me"])
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Vrac"})
    await api(mesh, "/api/organize", {"op": "move", "id": "me", "folder": "Vrac", "before": None})
    await tab.evaluate("refresh()")
    await tab.wait_for_function("data.mesh[0].folder === 'Vrac'")
    await right_click(tab, "me")
    await tab.click(entry(ui("menu.moveTo")))
    await tab.click(entry(ui("folders.none")))
    await tab.wait_for_function("!data.mesh[0].folder")


async def test_move_to_a_new_folder_creates_it_first(desk):
    tab, scripted = await desk(["mf"])
    scripted.reply = "Neuf"
    await right_click(tab, "mf")
    await tab.click(entry(ui("menu.moveTo")))
    await tab.click(entry(ui("folders.newEntry")))
    await tab.wait_for_function("data.folders.includes('Neuf') && data.mesh[0].folder === 'Neuf'")
    assert scripted.dialogs[0][0] == "prompt"


async def test_a_cancelled_new_folder_changes_nothing(desk):
    tab, scripted = await desk(["mg"])
    scripted.accept = False
    folders = await tab.evaluate("data.folders || []")
    await right_click(tab, "mg")
    await tab.click(entry(ui("menu.moveTo")))
    await tab.click(entry(ui("folders.newEntry")))
    assert await tab.evaluate("data.folders || []") == folders
    assert not (await session_of(tab, "mg"))["folder"]


# ------------------------------------------------------------ folder rename

async def test_folder_rename_action_keeps_the_fold_across_a_page_refresh(desk, mesh):
    tab, _ = await desk(["fr"])
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Avant"})
    await api(mesh, "/api/organize", {"op": "move", "id": "fr", "folder": "Avant", "before": None})
    await tab.evaluate("refresh()")
    await tab.wait_for_selector(folder_head("Avant"))

    await tab.click(folder_head("Avant"))
    assert await tab.evaluate("folded.has('dir:Avant')")
    await tab.click(folder_rename("Avant"))
    await tab.wait_for_selector("#list input.rename")
    assert not await tab.query_selector(f"{folder_head('Avant')} input.rename")
    assert await tab.query_selector("#list .folder-toolbar > input.folder-rename-input")
    await tab.fill("#list input.rename", "Après   plié")
    await tab.press("#list input.rename", "Enter")
    await tab.wait_for_function("data.folders?.includes('Après plié')")
    assert await tab.evaluate("folded.has('dir:Après plié') && !folded.has('dir:Avant')")

    await tab.reload()
    await tab.wait_for_selector(folder_head("Après plié"))
    assert await tab.evaluate("folded.has('dir:Après plié')")
    assert "folded" in await tab.get_attribute(folder_head("Après plié"), "class")


async def test_folder_rename_action_can_be_cancelled_without_changing_the_folder(desk, mesh):
    tab, _ = await desk(["fc"])
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Avant"})
    await tab.evaluate("refresh()")
    await tab.wait_for_selector(folder_rename("Avant"))

    await tab.focus(folder_rename("Avant"))
    await tab.keyboard.press("Enter")
    await tab.fill("#list input.rename", "Après")
    await tab.press("#list input.rename", "Escape")

    assert await tab.evaluate("data.folders") == ["Avant"]
    assert await tab.query_selector(folder_head("Avant"))
    assert not await tab.query_selector(folder_head("Après"))


@pytest.mark.ci_browser_smoke
async def test_folder_rename_action_refuses_a_duplicate_without_losing_the_original(desk, mesh):
    tab, _ = await desk(["fd"])
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Avant"})
    await api(mesh, "/api/organize", {"op": "folder-add", "name": "Existe"})
    await tab.evaluate("refresh()")
    await tab.wait_for_selector(folder_rename("Avant"))

    await tab.click(folder_rename("Avant"))
    await tab.fill("#list input.rename", "Existe")
    await tab.press("#list input.rename", "Enter")
    await tab.wait_for_function("!$('#flash').hidden")

    assert await tab.evaluate("data.folders") == ["Avant", "Existe"]
    assert await tab.query_selector(folder_head("Avant"))
    assert await tab.query_selector(folder_head("Existe"))


@pytest.mark.ci_browser_smoke
async def test_kill_asks_first_and_obeys_the_answer(desk):
    tab, scripted = await desk(["mh", "mi"])
    created = await tab.evaluate("data.mesh.find((s) => s.name === 'mh').created")
    sent = []
    tab.on("request", lambda request: sent.append(json.loads(request.post_data))
           if "/api/kill/mh" in request.url else None)
    scripted.accept = False
    await right_click(tab, "mh")
    await tab.click(entry(ui("menu.closeSession")))
    assert scripted.dialogs == [("confirm", ui("stop.confirmSession", name="mh"))]
    assert await session_of(tab, "mh")
    scripted.accept = True
    await right_click(tab, "mh")
    await tab.click(entry(ui("menu.closeSession")))
    await tab.wait_for_function("!data.mesh.some((s) => s.name === 'mh')", timeout=10000)
    assert sent == [{"created": created}]
    assert await session_of(tab, "mi")


@pytest.mark.parametrize("replacement", [False, True], ids=["stale-inventory", "same-name-replacement"])
@pytest.mark.ci_browser_smoke
async def test_sidebar_stop_clears_only_the_stopped_pane_identity(desk, replacement):
    tab, _ = await desk(["identity-stop"])
    await tab.locator(item("identity-stop")).click()
    await tab.wait_for_function("active?.id === 'identity-stop'")
    snapshot = await tab.evaluate("structuredClone(data)")
    original_created = next(s["created"] for s in snapshot["mesh"] if s["name"] == "identity-stop")
    if replacement:
        next_session = next(s for s in snapshot["mesh"] if s["name"] == "identity-stop")
        next_session["created"] = original_created + 1
    else:
        snapshot["mesh"] = [s for s in snapshot["mesh"] if s["name"] != "identity-stop"]
        snapshot["management"] = {"state": "unavailable"}  # inventory retains the old identity
    accepted = False

    async def fake_kill(route):
        nonlocal accepted
        accepted = True
        await route.fulfill(status=200, json={"ok": True})

    async def fake_inventory(route):
        if accepted:
            await route.fulfill(status=200, json=snapshot)
        else:
            await route.continue_()

    await tab.route("**/api/kill/identity-stop", fake_kill)
    await tab.route("**/api/sessions*", fake_inventory)
    await tab.evaluate("closeSession('identity-stop')")
    assert accepted
    state = await tab.evaluate("""() => ({
      paneId: active.id, inventory: paneTargets.identity('identity-stop')?.created ?? null,
      current: find('identity-stop')?.created ?? null,
    })""")
    if replacement:
        assert state == {"paneId": "identity-stop", "inventory": original_created + 1,
                         "current": original_created + 1}
    else:
        assert state == {"paneId": None, "inventory": original_created, "current": None}


async def test_open_in_a_new_column(desk):
    tab, _ = await desk(["mj"])
    before = await tab.evaluate("panes.length")
    await right_click(tab, "mj")
    await tab.click(entry(ui("menu.openInColumn")))
    await tab.wait_for_function(f"panes.length === {before + 1} && panes.at(-1).id === 'mj'")


async def test_a_late_sidebar_scroll_does_not_detach_the_menu_action(desk):
    tab, _ = await desk([f"ms{i}" for i in range(12)])
    await right_click(tab, "ms11")
    # Browsers may emit this after focus moved into the fixed menu.  It must
    # not turn the following click into an outside click on a detached button.
    await tab.evaluate("$('#list').scrollBy(0, 1)")
    await tab.click(entry(ui("menu.openInColumn")))
    assert await tab.evaluate("panes.at(-1).id") == "ms11"


async def test_escape_closes_the_menu_and_gives_the_focus_back(desk):
    tab, _ = await desk(["mk"])
    await right_click(tab, "mk")
    await tab.keyboard.press("Escape")
    assert not await tab.query_selector(MENU)
    assert await tab.evaluate("document.activeElement?.dataset?.id") == "mk"


async def test_an_outside_click_closes_the_menu_and_does_not_open_anything(desk):
    tab, _ = await desk(["ml"])
    before = await tab.evaluate("JSON.stringify(panes.map((p) => p.id))")
    await right_click(tab, "ml")
    await tab.mouse.click(700, 200)
    assert not await tab.query_selector(MENU)
    assert await tab.evaluate("JSON.stringify(panes.map((p) => p.id))") == before


@pytest.mark.ci_browser_smoke
async def test_the_keyboard_opens_and_drives_the_menu(desk):
    tab, _ = await desk(["mm"])
    await tab.focus(item("mm"))
    await tab.keyboard.press("Shift+F10")
    await tab.wait_for_selector(MENU)
    assert await tab.evaluate("document.activeElement.textContent.trim()") == ui("menu.rename")
    await tab.keyboard.press("ArrowDown")
    assert (await tab.evaluate("document.activeElement.textContent")).startswith(ui("menu.moveTo"))
    await tab.keyboard.press("ArrowUp")
    await tab.keyboard.press("ArrowUp")                      # wraps to the last entry
    assert (await tab.evaluate("document.activeElement.textContent")).startswith(ui("menu.closeSession"))
    await tab.keyboard.press("ArrowDown")
    await tab.keyboard.press("Enter")                        # Rename
    await tab.wait_for_selector("#list input.rename")
    assert not await tab.query_selector(MENU)


async def test_the_menu_key_opens_it_too(desk):
    tab, _ = await desk(["mn"])
    await tab.focus(item("mn"))
    await tab.keyboard.press("ContextMenu")
    await tab.wait_for_selector(MENU)


async def test_the_menu_stays_inside_the_viewport(desk):
    tab, _ = await desk(["mo"], viewport={"width": 700, "height": 300})
    await tab.dispatch_event(item("mo"), "contextmenu",
                             {"clientX": 695, "clientY": 295, "bubbles": True, "cancelable": True})
    await tab.wait_for_selector(MENU)
    rect = await tab.eval_on_selector(MENU, "(e) => { const r = e.getBoundingClientRect();"
                                            " return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]; }")
    left, top, right, bottom, width, height = rect
    assert left >= 0 and top >= 0 and right <= width and bottom <= height, rect


async def test_an_external_session_only_offers_to_open_it(desk):
    tab, _ = await desk(["mp"])
    fake = {"id": "x1", "kind": "external", "host": "SSH", "cwd": "/tmp", "tty": "/dev/pts/9",
            "cmd": "claude", "pid": 4242, "name": "x1"}

    async def with_external(route):
        # in every /api/sessions reply, not just once in `data`: the page's own refresh would
        # otherwise replace it before the right click (a race seen on slower CI runners)
        reply = await route.fetch()
        body = await reply.json()
        body["external"] = [fake]
        await route.fulfill(response=reply, json=body)

    await tab.route("**/api/sessions*", with_external)
    await tab.evaluate("refresh()")
    await tab.wait_for_selector(item("x1"))
    # the list closes the menu when it scrolls (by design): on a short viewport the item sits below
    # the fold, and the click's own scroll-into-view would close the menu it just opened
    await tab.locator(item("x1")).scroll_into_view_if_needed()
    await tab.wait_for_timeout(300)
    await tab.click(item("x1"), button="right")
    await tab.wait_for_selector(f"{MENU} [role=menuitem]")
    assert await menu_labels(tab) == [ui("common.open"), ui("menu.openInColumn")]


# ------------------------------------------------------------ touch

@pytest.mark.ci_browser_smoke
async def test_a_long_press_opens_the_menu_on_a_phone(desk):
    tab, _ = await desk(["mq"], **PHONE)
    await tab.click("#btn-menu")
    await tab.wait_for_selector(item("mq"), state="visible")
    await tab.wait_for_timeout(600)                          # the drawer slides in
    row = tab.locator(item("mq"))
    await row.scroll_into_view_if_needed()
    box = await row.bounding_box()
    point = {"x": box["x"] + 60, "y": box["y"] + 20, "id": 1}
    cdp = await tab.context.new_cdp_session(tab)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point]})
    await tab.wait_for_timeout(200)
    assert not await tab.query_selector(MENU)                # not yet: a tap is not a long press
    await tab.wait_for_selector(MENU, timeout=3000)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert await tab.query_selector(MENU)                    # lifting the finger does not dismiss it
    assert await tab.evaluate("panes.every((p) => p.id !== 'mq')")   # and did not open the session


async def test_a_quick_tap_still_opens_the_session(desk):
    tab, _ = await desk(["mr"], **PHONE)
    await tab.click("#btn-menu")
    await tab.wait_for_selector(item("mr"), state="visible")
    await tab.wait_for_timeout(600)
    await tab.tap(item("mr"))
    await tab.wait_for_function("panes.some((p) => p.id === 'mr')")
    assert not await tab.query_selector(MENU)
