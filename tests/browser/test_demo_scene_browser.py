# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A real browser opens a pinned static scene and offers later revisions."""

import asyncio
import json
from types import SimpleNamespace

import aiohttp
import pytest

import demo_scene
import ptyhost
import server
from conftest import ui
from test_view_compat import goto


pytestmark = pytest.mark.usefixtures("pty")


def scene(version, text):
    return {"format": "mesh-scene-v0", "version": version, "title": "Démo statique", "theme": "dark",
            "nodes": [{"type": "card", "children": [{"type": "heading", "text": text}]},
                      {"type": "status", "label": "Canal prêt à vérifier", "state": "warning"},
                      {"type": "disclosure", "summary": "Voir les critères",
                       "children": [{"type": "text", "text": "Critère accepté"}]}]}


def interactive_scene(version, suffix=""):
    return {"format": "mesh-scene-v1", "version": version, "title": "Démo interactive",
            "theme": "dark", "initial": "start", "states": [
                {"id": "start", "view": {"format": "mesh-view-v1", "nodes": [
                    {"type": "heading", "text": f"Départ{suffix}"},
                    {"type": "text", "text": '<img src="https://invalid.example/leak">'}]},
                 "choices": [{"label": "Continuer", "target": "done"}]},
                {"id": "done", "view": {"format": "mesh-view-v1", "nodes": [
                    {"type": "heading", "text": f"Arrivée{suffix}"}]},
                 "choices": [{"label": "Recommencer", "target": "start"}]},
            ]}


def gear_scene(version=1):
    return {"format": "mesh-scene-v2", "version": version, "title": "Engrenages",
            "theme": "dark", "initial": "start", "states": [{"id": "start",
                "view": {"format": "mesh-view-v2", "nodes": [{"type": "row", "children": [
                    {"type": "gear", "angle": 90}, {"type": "gear", "angle": 270},
                    {"type": "text", "text": '<img src="/sink">'}]}]}, "choices": []}]}


async def test_v2_host_renderer_is_bounded_on_desktop_and_phone(browser):
    markup = demo_scene.render(demo_scene.validate(gear_scene()))
    for viewport in ({"width": 1100, "height": 800}, {"width": 390, "height": 800}):
        context = await browser.new_context(viewport=viewport, reduced_motion="reduce")
        page = await context.new_page()
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        await page.set_content(markup, wait_until="load")
        assert await page.locator(".gear").count() == 2
        assert await page.locator("img, script[src], iframe").count() == 0
        assert await page.locator(".state-view").text_content() == '⚙⚙<img src="/sink">'
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert not any("/sink" in request for request in requests)
        assert await page.locator(".gear").first.evaluate(
            "node => getComputedStyle(node).animationName") == "none"
        await context.close()


def shell_token(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read().decode()
    return dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)["MESH_SESSION_TOKEN"]


async def test_agent_opens_pinned_scene_and_human_accepts_update(page, mesh, home_dir, sink, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-scene-ui"
    async with aiohttp.ClientSession() as http:
        response = await http.post(f"{mesh.origin}/api/new", headers={"Authorization": f"Bearer {server.TOKEN}"},
                                   json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert response.status == 200, await response.text()
    pid = next(row["pid"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(pid)}"}
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"active?.id === {json.dumps(name)}")
    await page.wait_for_function(f"panes.length === 1 && panes[0].id === {json.dumps(name)}")
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    async with aiohttp.ClientSession() as http:
        created = await http.put(f"{mesh.origin}/api/demo-scene/@self", headers=auth,
                                 json=scene(0, f'<img src="{sink.origin}/leak">'))
        assert created.status == 200, await created.text()
        opened = await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)
        assert opened.status == 200, await opened.text()
    await page.evaluate("refresh()")
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps('demo:' + name)})")
    # On desktop, a demo is a companion to the agent, not a replacement for it.
    agent_pane = page.locator(".pane:has(.term:not([hidden]))")
    demo_pane = page.locator(".pane:has(iframe.web:not([hidden]))")
    agent_box = await agent_pane.bounding_box()
    demo_box = await demo_pane.bounding_box()
    assert agent_box is not None and demo_box is not None
    assert agent_box["width"] >= 240 and demo_box["width"] >= 240
    assert agent_box["x"] + agent_box["width"] <= demo_box["x"]
    assert await page.evaluate("active?.id") == name
    frame = page.frame_locator("iframe.web:not([hidden])")
    await frame.locator("h1").wait_for()
    assert await frame.locator("img, script, iframe").count() == 0
    assert await frame.locator("h2").text_content() == f'<img src="{sink.origin}/leak">'
    status = frame.locator(".status.status-warning[role=status]")
    assert await status.text_content() == "Canal prêt à vérifier"
    assert not await frame.locator("details p").is_visible()
    # The opaque frame's document can be ready before its compositor surface, and a click
    # sent then never reaches the summary: the frame keeps its first load, its document
    # never gets the focus and the disclosure stays closed. A target screenshot waits for
    # that surface without sending any input (as post_on_click does in
    # test_session_documents.py).
    await frame.locator("details summary").screenshot()
    await frame.locator("details summary").click()
    await frame.locator("details p").wait_for(state="visible")
    assert await frame.locator("details p").text_content() == "Critère accepté"
    assert await page.locator("iframe.web:not([hidden])").get_attribute("sandbox") == ""
    assert await frame.locator("body").evaluate("() => self.origin") == "null"
    assert await frame.locator("body").evaluate("() => { try { return document.cookie; } catch { return 'blocked'; } }") in ("", "blocked")
    assert await frame.locator("body").evaluate("() => { try { return !!parent.document.body; } catch { return 'blocked'; } }") == "blocked"
    async with aiohttp.ClientSession() as http:
        updated = await http.put(f"{mesh.origin}/api/demo-scene/@self", headers=auth,
                                 json=scene(1, "Nouvelle révision"))
        assert updated.status == 200, await updated.text()
    await page.evaluate("refresh()")
    offer = page.locator(".pane:has(iframe.web:not([hidden])) .demo-offer")
    await offer.wait_for(state="visible")
    assert await frame.locator("h2").text_content() == f'<img src="{sink.origin}/leak">'
    await offer.locator("button").click()
    await frame.locator("h2").filter(has_text="Nouvelle révision").wait_for()
    assert await page.evaluate(f"demos.get({json.dumps('demo:' + name)}).version") == 2
    assert not any(url.startswith(sink.origin) for url in requests)
    await sink.assert_untouched(wait=0.1)
    offered = await page.evaluate("""async () => {
      const id = "demo:demo-scene-ui";
      const oldFetch = window.fetch;
      const pending = [];
      window.fetch = (url, ...args) => String(url).includes("/api/demo-scene/demo-scene-ui?")
        ? new Promise((resolve) => pending.push(resolve)) : oldFetch(url, ...args);
      try {
        const first = checkDemoSceneUpdates();
        const second = checkDemoSceneUpdates();
        while (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
        const headers = {get: (name) => name === "X-Mesh-Frame-Sandbox" ? "" : null};
        pending[1]({ok: true, headers, json: async () => ({format: "mesh-scene-v0", version: 4})});
        await second;
        pending[0]({ok: true, headers, json: async () => ({format: "mesh-scene-v0", version: 3})});
        await first;
        return demos.get(id).offeredVersion;
      } finally { window.fetch = oldFetch; }
    }""")
    assert offered == 4


async def test_v1_state_is_client_local_bounded_and_resets_on_revision(
        browser, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-v1-local-state"
    async with aiohttp.ClientSession() as http:
        response = await http.post(f"{mesh.origin}/api/new",
            headers={"Authorization": f"Bearer {server.TOKEN}"},
            json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert response.status == 200
    session = next(row for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(session['pid'])}"}
    async with aiohttp.ClientSession() as http:
        created = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                  json=interactive_scene(0))
        assert created.status == 200
        demo_id = (await created.json())["id"]

    desktop = await browser.new_context(viewport={"width": 1100, "height": 800})
    mobile = await browser.new_context(viewport={"width": 390, "height": 800})
    pages = [await desktop.new_page(), await mobile.new_page()]
    try:
        for client in pages:
            await client.context.add_cookies([{"name": server.COOKIE,
                "value": server.cookie_value(), "url": mesh.origin}])
            await goto(client, f"{mesh.origin}/#{name}")
            # The hash shows a provisional row at once; the first listing gives it its identity.
            await client.evaluate("localMesh.then(() => undefined)")
            await client.wait_for_function(
                f"data.mesh.some((session) => session.id === {json.dumps(name)})")
        for client in pages:
            await client.evaluate("([name, demoId]) => openDemoScene(name, true, demoId)",
                                  [name, demo_id])
            await client.wait_for_function(
                f"panes.some((pane) => pane.id === {json.dumps('demo:' + name)})")
            frame = client.frame_locator("iframe.web:not([hidden])")
            await frame.get_by_role("heading", name="Départ").wait_for()
            assert await client.locator("iframe.web:not([hidden])").get_attribute(
                "sandbox") == demo_scene.frame_sandbox(interactive_scene(0))
            assert await frame.locator("body").evaluate("() => self.origin") == "null"
            assert await frame.locator("body").evaluate(
                "() => { try { return !!parent.document.body; } catch { return 'blocked'; } }") == "blocked"
            assert await frame.locator("main").evaluate("node => node.scrollWidth <= node.clientWidth")
            button = frame.get_by_role("button", name="Continuer")
            box = await button.bounding_box()
            assert box is not None and box["height"] >= 44

        requests = []
        pages[0].on("request", lambda request: requests.append(request.url))
        await pages[0].evaluate(
            "() => { window.__meshSceneMessages = []; "
            "addEventListener('message', event => window.__meshSceneMessages.push(event.data)); }")
        before = len(requests)
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "button", name="Continuer").click()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Arrivée").wait_for()
        await asyncio.sleep(0.1)
        assert len(requests) == before
        assert await pages[0].evaluate("() => window.__meshSceneMessages") == []
        assert await pages[1].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Départ").is_visible()
        assert await pages[0].frame_locator("iframe.web:not([hidden])").locator("img, iframe").count() == 0
        assert "<img" in await pages[1].frame_locator("iframe.web:not([hidden])").locator("p").text_content()

        async with aiohttp.ClientSession() as http:
            updated = await http.put(
                f"{mesh.origin}/api/demo-scene/@self/selected?demo_id={demo_id}",
                headers=auth, json=interactive_scene(1, " v2"))
            assert updated.status == 200
        await pages[0].evaluate("checkDemoSceneUpdates()")
        offer = pages[0].locator(".pane:has(iframe.web:not([hidden])) .demo-offer")
        await offer.wait_for(state="visible")
        await offer.get_by_role("button").click()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Départ v2").wait_for()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "button", name="Continuer").click()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Arrivée v2").wait_for()
        pane = pages[0].locator(".pane:has(iframe.web:not([hidden]))")
        await pane.locator(".demo-history").click()
        dialog = pages[0].locator("#dlg-demo-history")
        old = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=1))
        await old.get_by_role("button", name=ui("common.show")).click()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Départ", exact=True).wait_for()
        await pane.locator(".demo-history").click()
        old = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=1))
        await old.get_by_role("button", name=ui("demoCatalog.history.restore")).click()
        await dialog.get_by_role("button", name=ui("demo.restoreConfirm")).click()
        await pages[0].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Départ", exact=True).wait_for()
        async with aiohttp.ClientSession() as http:
            summary = await http.get(
                f"{mesh.origin}/api/demo-scene/@self/selected/revisions?demo_id={demo_id}", headers=auth)
            assert await summary.json() == {"demo_id": demo_id, "format": "mesh-scene-v1",
                                            "current": 3, "versions": [1, 2, 3]}
        assert await pages[1].frame_locator("iframe.web:not([hidden])").get_by_role(
            "heading", name="Départ", exact=True).is_visible()
    finally:
        await desktop.close()
        await mobile.close()


async def test_phone_session_menu_returns_to_its_demo(browser, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-phone-return"
    async with aiohttp.ClientSession() as http:
        created = await http.post(f"{mesh.origin}/api/new", headers={"Authorization": f"Bearer {server.TOKEN}"},
                                  json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created.status == 200, await created.text()
    pid = next(row["pid"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(pid)}"}
    context = await browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, f"{mesh.origin}/#{name}")
        await tab.wait_for_function(f"active?.id === {json.dumps(name)}")
        async with aiohttp.ClientSession() as http:
            saved = await http.put(f"{mesh.origin}/api/demo-scene/@self", headers=auth,
                                   json=scene(0, "Démo à retrouver"))
            assert saved.status == 200, await saved.text()
            opened = await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)
            assert opened.status == 200, await opened.text()
        await tab.evaluate("refresh()")
        await tab.wait_for_function(f"active?.id === {json.dumps('demo:' + name)}")
        await tab.locator('.pane.active [data-act="back"]').click()
        await tab.wait_for_function(f"active?.id === {json.dumps(name)}")
        await tab.locator('.pane.active [data-act="more"]').click()
        await tab.get_by_role("menuitem", name=ui("paneActions.action.demo")).click()
        await tab.wait_for_function(f"active?.id === {json.dumps('demo:' + name)}")
        assert await tab.frame_locator("iframe.web:not([hidden])").locator("h2").text_content() == "Démo à retrouver"
    finally:
        await context.close()


async def test_phone_switches_between_independent_named_demos(browser, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    generated_ids = iter((f"012345{'a' * 26}", f"012345{'b' * 26}"))
    monkeypatch.setattr(demo_scene.uuid, "uuid4", lambda: SimpleNamespace(hex=next(generated_ids)))
    name = "demo-phone-catalog"
    async with aiohttp.ClientSession() as http:
        created = await http.post(f"{mesh.origin}/api/new", headers={"Authorization": f"Bearer {server.TOKEN}"},
                                  json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created.status == 200, await created.text()
    pid = next(row["pid"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(pid)}"}
    context = await browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, f"{mesh.origin}/#{name}")
        await tab.wait_for_function(f"active?.id === {json.dumps(name)}")
        async with aiohttp.ClientSession() as http:
            first = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                    json=scene(0, "Première démo"))
            second = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                     json=scene(0, "Seconde démo"))
            assert first.status == second.status == 200
            first_id = (await first.json())["id"]
            second_id = (await second.json())["id"]
            opened = await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)
            assert opened.status == 200, await opened.text()
        await tab.evaluate("refresh()")
        await tab.wait_for_function(f"active?.id === {json.dumps('demo:' + name)}")
        frame = tab.frame_locator("iframe.web:not([hidden])")
        await frame.locator("h2").filter(has_text="Première démo").wait_for()
        switch = tab.locator(".pane.active .demo-switch select")
        assert await switch.is_visible()
        bounds = await switch.bounding_box()
        assert bounds is not None and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 390
        await switch.select_option(second_id)
        await frame.locator("h2").filter(has_text="Seconde démo").wait_for()
        selected_after_stale_open = await tab.evaluate("""async ({sessionId, firstId, secondId}) => {
          const originalFetch = window.fetch;
          let release;
          let intercepted;
          const waiting = new Promise((resolve) => { intercepted = resolve; });
          window.fetch = (url, ...args) => {
            if (String(url).includes(`/api/demo-scene/${sessionId}/selected?`)
                && String(url).includes(`demo_id=${firstId}`)) {
              return new Promise((resolve) => {
                release = () => resolve(originalFetch(url, ...args));
                intercepted();
              });
            }
            return originalFetch(url, ...args);
          };
          try {
            const olderOpen = openDemoScene(sessionId, true, firstId);
            await waiting;
            const pane = panes.find((entry) => entry.id === `demo:${sessionId}`);
            await selectDemoScene(pane, secondId);
            release();
            await olderOpen;
            return demos.get(`demo:${sessionId}`).demoId;
          } finally {
            window.fetch = originalFetch;
          }
        }""", {"sessionId": name, "firstId": first_id, "secondId": second_id})
        assert selected_after_stale_open == second_id
        await switch.select_option(first_id)
        await frame.locator("h2").filter(has_text="Première démo").wait_for()
        tools = tab.locator(".pane.active .demo-tools")
        history_button = tools.locator(".demo-history")
        assert await tools.evaluate("node => node.scrollWidth <= node.clientWidth")
        history_bounds = await history_button.bounding_box()
        assert history_bounds is not None and history_bounds["height"] >= 44
        await history_button.click()
        history_dialog = tab.locator("#dlg-demo-history")
        await history_dialog.wait_for(state="visible")
        assert await history_dialog.evaluate("node => node.scrollWidth <= node.clientWidth")
        for index in range(await history_dialog.locator("button").count()):
            control = history_dialog.locator("button").nth(index)
            if await control.is_visible():
                control_bounds = await control.bounding_box()
                assert control_bounds is not None and control_bounds["height"] >= 44
        await tab.keyboard.press("Escape")
        async with aiohttp.ClientSession() as http:
            targeted = await http.post(f"{mesh.origin}/api/demo-scene/@self/open-named", headers=auth,
                                       json={"demo_id": second_id})
            assert targeted.status == 200, await targeted.text()
        await tab.evaluate("refresh()")
        await frame.locator("h2").filter(has_text="Seconde démo").wait_for()
        await tab.locator('.pane.active [data-act="back"]').click()
        await tab.wait_for_function(f"active?.id === {json.dumps(name)}")
        await tab.locator('.pane.active [data-act="more"]').click()
        await tab.get_by_role("menuitem", name=ui("paneActions.action.demo")).click()
        chooser = tab.locator("#dlg-demo-chooser")
        await chooser.wait_for(state="visible")
        choices = chooser.locator("[data-demo-id]")
        assert await choices.count() == 2
        assert await chooser.locator(f'[data-demo-id="{second_id}"]').get_attribute("aria-current") == "true"
        first_choice = chooser.locator(f'[data-demo-id="{first_id}"]')
        second_choice = chooser.locator(f'[data-demo-id="{second_id}"]')
        assert await first_choice.text_content() == f"Démo statique · {first_id[:7]}"
        assert (await second_choice.text_content()).startswith(f"Démo statique · {second_id[:7]}")
        assert ui("demoCatalog.chooser.currentMarker") in await second_choice.text_content()
        assert await first_choice.text_content() != await second_choice.text_content()
        controls = chooser.locator("[data-demo-id], .demo-chooser-cancel")
        for index in range(await controls.count()):
            bounds = await controls.nth(index).bounding_box()
            assert bounds is not None
            assert bounds["height"] >= 44
            assert bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 390
        assert await chooser.evaluate("node => node.scrollWidth <= node.clientWidth")
        await first_choice.click()
        await tab.wait_for_function(f"active?.id === {json.dumps('demo:' + name)}")
        assert await switch.input_value() == first_id
        assert await frame.locator("h2").text_content() == "Première démo"
    finally:
        await context.close()


async def test_server_valid_astral_title_keeps_catalog_and_selector_usable(page, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-unicode-catalog"
    async with aiohttp.ClientSession() as http:
        created = await http.post(f"{mesh.origin}/api/new", headers={"Authorization": f"Bearer {server.TOKEN}"},
                                  json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created.status == 200, await created.text()
    pid = next(row["pid"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(pid)}"}
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"active?.id === {json.dumps(name)}")

    astral_title = "🧪" * 61
    first_scene = scene(0, "Astral title scene")
    first_scene["title"] = astral_title
    async with aiohttp.ClientSession() as http:
        first = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                json=first_scene)
        second = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                 json=scene(0, "Plain title scene"))
        assert first.status == second.status == 200
        first_id = (await first.json())["id"]
        second_id = (await second.json())["id"]
        opened = await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)
        assert opened.status == 200, await opened.text()

    await page.evaluate("refresh()")
    demo_id = json.dumps("demo:" + name)
    await page.wait_for_function(f"panes.some((pane) => pane.id === {demo_id})")
    demo_pane = page.locator(".pane:has(iframe.web:not([hidden]))")
    switch = demo_pane.locator(".demo-switch select")
    assert await switch.is_visible()
    assert await switch.locator("option").count() == 2
    assert astral_title in (await switch.locator(f'option[value="{first_id}"]').text_content())
    await switch.select_option(second_id)
    frame = page.frame_locator("iframe.web:not([hidden])")
    await frame.locator("h2").filter(has_text="Plain title scene").wait_for()
    assert await switch.input_value() == second_id


async def test_named_demo_history_previews_and_restores_as_new_revision(page, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-history-ui"
    async with aiohttp.ClientSession() as http:
        created_response = await http.post(f"{mesh.origin}/api/new",
            headers={"Authorization": f"Bearer {server.TOKEN}"},
            json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created_response.status == 200
    listed = await ptyhost.request({"op": "list"})
    session = next(row for row in listed if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(session['pid'])}"}
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"active?.id === {json.dumps(name)}")
    async with aiohttp.ClientSession() as http:
        first = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                json=scene(0, "Première version"))
        demo_id = (await first.json())["id"]
        changed = await http.put(
            f"{mesh.origin}/api/demo-scene/@self/selected?demo_id={demo_id}", headers=auth,
            json=scene(1, "Deuxième version"))
        assert changed.status == 200
        assert (await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)).status == 200
    await page.evaluate("refresh()")
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps('demo:' + name)})")
    pane = page.locator(".pane:has(iframe.web:not([hidden]))")
    frame = page.frame_locator("iframe.web:not([hidden])")
    await frame.locator("h2").filter(has_text="Deuxième version").wait_for()
    history_button = pane.locator(".demo-history")
    assert await history_button.is_visible()
    await history_button.click()
    dialog = page.locator("#dlg-demo-history")
    await dialog.wait_for(state="visible")
    current = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=2))
    assert ui("demoCatalog.history.current") in (await current.text_content())
    assert ui("demoCatalog.history.shown") in (await current.text_content())
    for index in range(await dialog.locator("button").count()):
        button = dialog.locator("button").nth(index)
        if await button.is_visible():
            bounds = await button.bounding_box()
            assert bounds is not None and bounds["height"] >= 44
    assert await dialog.evaluate("node => node.scrollWidth <= node.clientWidth")
    await page.keyboard.press("Escape")
    await dialog.wait_for(state="hidden")
    assert await history_button.evaluate("node => document.activeElement === node")

    await history_button.click()
    old = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=1))
    await old.get_by_role("button", name=ui("common.show")).click()
    await frame.locator("h2").filter(has_text="Première version").wait_for()
    await history_button.click()
    old = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=1))
    current = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=2))
    assert ui("demoCatalog.history.shown") in (await old.text_content())
    assert ui("demoCatalog.history.current") in (await current.text_content())
    await old.get_by_role("button", name=ui("demoCatalog.history.restore")).click()
    assert ui("demoCatalog.history.restoreConfirm", version=1) in await dialog.locator(
        "[data-demo-history-confirmation-text]").text_content()
    await dialog.get_by_role("button", name=ui("demo.restoreConfirm")).click()
    await frame.locator("h2").filter(has_text="Première version").wait_for()
    async with aiohttp.ClientSession() as http:
        summary = await http.get(
            f"{mesh.origin}/api/demo-scene/@self/selected/revisions?demo_id={demo_id}", headers=auth)
        assert await summary.json() == {"demo_id": demo_id, "format": "mesh-scene-v0",
                                        "current": 3, "versions": [1, 2, 3]}
        immutable = await http.get(
            f"{mesh.origin}/api/demo-scene/@self/selected?demo_id={demo_id}", headers=auth)
        assert (await immutable.json())["version"] == 3
        assert demo_scene.get_demo(name, demo_id, await ptyhost.request({"op": "list"}), 2)["version"] == 2
    history_opened_after_selection_race = await page.evaluate("""async ({paneId, demoId}) => {
      const originalFetch = window.fetch;
      let release;
      let intercepted;
      const waiting = new Promise((resolve) => { intercepted = resolve; });
      window.fetch = (url, ...args) => {
        if (String(url).includes("/selected/revisions?")) {
          return new Promise((resolve) => {
            release = () => resolve(originalFetch(url, ...args));
            intercepted();
          });
        }
        return originalFetch(url, ...args);
      };
      try {
        const pane = panes.find((entry) => entry.id === paneId);
        const delayed = openDemoHistory(pane);
        await waiting;
        await selectDemoScene(pane, demoId);
        release();
        await delayed;
        return document.querySelector("#dlg-demo-history").open;
      } finally { window.fetch = originalFetch; }
    }""", {"paneId": "demo:" + name, "demoId": demo_id})
    assert history_opened_after_selection_race is False


async def test_named_demo_stale_restore_is_not_retried(page, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-stale-history-ui"
    async with aiohttp.ClientSession() as http:
        created_response = await http.post(f"{mesh.origin}/api/new",
            headers={"Authorization": f"Bearer {server.TOKEN}"},
            json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created_response.status == 200
    session = next(row for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth = {"Authorization": f"MeshSession {shell_token(session['pid'])}"}
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"active?.id === {json.dumps(name)}")
    async with aiohttp.ClientSession() as http:
        first = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth,
                                json=scene(0, "Première version"))
        demo_id = (await first.json())["id"]
        await http.put(f"{mesh.origin}/api/demo-scene/@self/selected?demo_id={demo_id}",
                       headers=auth, json=scene(1, "Deuxième version"))
        await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth)
    await page.evaluate("refresh()")
    pane = page.locator(".pane:has(iframe.web:not([hidden]))")
    await pane.locator(".demo-history").click()
    dialog = page.locator("#dlg-demo-history")
    await dialog.wait_for(state="visible")
    async with aiohttp.ClientSession() as http:
        advanced = await http.put(f"{mesh.origin}/api/demo-scene/@self/selected?demo_id={demo_id}",
                                  headers=auth, json=scene(2, "Troisième version"))
        assert advanced.status == 200
    old = dialog.locator(".demo-history-row").filter(has_text=ui("demoCatalog.history.revision", version=1))
    await old.get_by_role("button", name=ui("demoCatalog.history.restore")).click()
    await dialog.get_by_role("button", name=ui("demo.restoreConfirm")).click()
    await page.locator("#flash").filter(has_text=ui("demo.historyChanged")).wait_for()
    async with aiohttp.ClientSession() as http:
        summary = await http.get(
            f"{mesh.origin}/api/demo-scene/@self/selected/revisions?demo_id={demo_id}", headers=auth)
        assert (await summary.json())["versions"] == [1, 2, 3]


async def test_reused_session_name_clears_old_demo_pane(page, mesh, home_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(demo_scene, "FILE", tmp_path / "conf" / "demo-scenes.json")
    name = "demo-reused-ui"
    auth_owner = {"Authorization": f"Bearer {server.TOKEN}"}
    async with aiohttp.ClientSession() as http:
        created = await http.post(f"{mesh.origin}/api/new", headers=auth_owner,
                                  json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert created.status == 200, await created.text()
    pid = next(row["pid"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    auth_agent = {"Authorization": f"MeshSession {shell_token(pid)}"}
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, f"{mesh.origin}/#{name}")
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps(name)})")
    async with aiohttp.ClientSession() as http:
        saved = await http.post(f"{mesh.origin}/api/demo-scene/@self/catalog", headers=auth_agent,
                                json=scene(0, "Ancienne"))
        assert saved.status == 200, await saved.text()
        opened = await http.post(f"{mesh.origin}/api/demo-scene/@self/open", headers=auth_agent)
        assert opened.status == 200, await opened.text()
    await page.evaluate("refresh()")
    await page.wait_for_function(f"panes.some((pane) => pane.id === {json.dumps('demo:' + name)})")
    await page.locator(".pane:has(iframe.web:not([hidden])) .demo-history").click()
    await page.locator("#dlg-demo-history").wait_for(state="visible")
    old_created = next(row["created"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    assert await server.host({"op": "kill", "name": name}) == {"ok": True}
    for _ in range(100):
        if not any(row["name"] == name for row in await ptyhost.request({"op": "list"})):
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("old demo session was not reaped")
    async with aiohttp.ClientSession() as http:
        replacement = await http.post(f"{mesh.origin}/api/new", headers=auth_owner,
                                      json={"preset": "shell", "cwd": str(home_dir), "name": name})
        assert replacement.status == 200, await replacement.text()
    new_created = next(row["created"] for row in await ptyhost.request({"op": "list"}) if row["name"] == name)
    assert new_created != old_created
    await page.evaluate("refresh()")
    assert not await page.evaluate(f"panes.some((pane) => pane.id === {json.dumps('demo:' + name)})")
    assert not await page.evaluate(f"demos.has({json.dumps('demo:' + name)})")
    assert not await page.locator("#dlg-demo-history").evaluate("node => node.open")
