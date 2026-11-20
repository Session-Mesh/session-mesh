# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Browser seam: actual Mesh template/app/controller on an isolated test server."""

import asyncio
import json

import pytest

import ptyhost
import server
from test_sidebar_menu import api
from test_view_compat import goto
from conftest import ui


pytestmark = pytest.mark.usefixtures("pty")


class _EchoAttach:
    """In-memory attach stream: the browser and Web relay remain production code."""

    def __init__(self, capabilities):
        self.capabilities = capabilities
        self.attachments = []

    async def attach_info(self, _name, _rows, _cols, *, created=None, size=None):
        if created is not None:
            listed = await ptyhost.request({"op": "list"})
            assert any(row["name"] == _name and row["created"] == created for row in listed)
        reader = asyncio.StreamReader()
        # Every native attach starts with a replay D frame, even when it is empty.
        reader.feed_data(ptyhost.frame(b"D", b""))
        record = []
        self.attachments.append(record)

        class Writer:
            def write(_self, framed):
                kind = framed[:1]
                size = int.from_bytes(framed[1:5], "big")
                payload = framed[5:5 + size]
                assert len(framed) == 5 + size
                record.append((kind, payload))
                if kind == b"D":
                    reader.feed_data(ptyhost.frame(b"D", payload))

            async def drain(_self):
                return None

            def close(_self):
                reader.feed_eof()

        reply = {"ok": True}
        if self.capabilities is not None:
            reply["pty_capabilities"] = self.capabilities
        return reader, Writer(), reply


def _terminal_text_script(marker):
    return """marker => {
      const buffer=active?.term?.buffer?.active;
      if(!buffer)return false;
      let text='';
      for(let i=0;i<buffer.length;i++)text+=buffer.getLine(i)?.translateToString(true) || '';
      return text.includes(marker);
    }""", marker


async def _type_terminal(tab, phone, text):
    if phone:
        line = tab.locator("#line-text")
        await line.fill(text)
        await line.press("Enter")
        await tab.wait_for_function("linePending === null")
    else:
        terminal = tab.locator(".pane.active .xterm-helper-textarea")
        # xterm deliberately keeps its native textarea off-screen; focus that
        # real keyboard sink instead of bypassing xterm with Pane.send().
        await terminal.evaluate("element => element.focus()")
        await tab.keyboard.type(text)
        await tab.keyboard.press("Enter")


@pytest.mark.parametrize("phone", [False, True], ids=["desktop-xterm", "phone-line-text"])
async def test_old_attach_keeps_input_across_reconnect_and_reload(
        browser, mesh, home_dir, monkeypatch, phone):
    """A {ok:true} owner sees only D, while real Chromium gets its echoed bytes."""
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "old-input"})
    fake = _EchoAttach(capabilities=None)
    monkeypatch.setattr(ptyhost, "attach_info", fake.attach_info)
    context = await browser.new_context(viewport={"width": 390 if phone else 1280, "height": 800},
                                        has_touch=phone, is_mobile=phone)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        errors = []
        tab.on("pageerror", lambda error: errors.append(str(error)))
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'old-input')")
        if phone:
            await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.locator('#list .item[data-id="old-input"]').click()
        await tab.wait_for_function("active?.id === 'old-input' && active.conn?.ws?.readyState === WebSocket.OPEN")

        for round_, marker in enumerate(("oldone", "oldtwo", "oldthree")):
            if round_ == 1:
                previous = len(fake.attachments)
                await tab.evaluate("active.conn.ws.close()")
                for _ in range(100):
                    if len(fake.attachments) > previous:
                        break
                    await asyncio.sleep(0.05)
                assert len(fake.attachments) > previous
                await tab.wait_for_function("active?.conn?.ws?.readyState === WebSocket.OPEN")
            elif round_ == 2:
                await tab.reload(wait_until="domcontentloaded")
                await tab.wait_for_function(
                    "active?.id === 'old-input' && active.conn?.ws?.readyState === WebSocket.OPEN")
            await _type_terminal(tab, phone, marker)
            script, argument = _terminal_text_script(marker)
            await tab.wait_for_function(script, arg=argument)

        wire = [(kind, payload) for attachment in fake.attachments for kind, payload in attachment
                if kind in (b"H", b"D")]
        assert all(kind == b"D" for kind, _payload in wire), wire
        joined = b"".join(payload for _kind, payload in wire)
        for marker in (b"oldone", b"oldtwo", b"oldthree"):
            assert marker in joined
        assert not errors, errors
    finally:
        await context.close()


async def test_current_attach_orders_advisory_lease_around_input(browser, mesh, home_dir, monkeypatch):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "leased-input"})
    fake = _EchoAttach(capabilities=["human_input_lease_v1"])
    monkeypatch.setattr(ptyhost, "attach_info", fake.attach_info)
    context = await browser.new_context(viewport={"width": 1280, "height": 800})
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'leased-input')")
        await tab.locator('#list .item[data-id="leased-input"]').click()
        await tab.wait_for_function("active?.conn?.ws?.readyState === WebSocket.OPEN")
        await _type_terminal(tab, False, "ordered")
        script, argument = _terminal_text_script("ordered")
        await tab.wait_for_function(script, arg=argument)
        relevant = [(kind, json.loads(payload) if kind == b"H" else payload)
                    for kind, payload in fake.attachments[-1] if kind in (b"H", b"D")]
        acquired = next(index for index, (kind, payload) in enumerate(relevant)
                        if kind == b"H" and payload["dirty"] is True)
        assert relevant[-1][0] == b"H" and relevant[-1][1]["dirty"] is False, relevant
        enclosed = relevant[acquired + 1:-1]
        assert b"ordered" in b"".join(payload for kind, payload in enclosed if kind == b"D")
        assert enclosed and all(kind == b"D" for kind, _payload in enclosed), relevant
    finally:
        await context.close()


async def test_pane_stop_sends_the_captured_incarnation(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "stop-bound"})
    context = await browser.new_context()
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        sent = []
        tab.on("request", lambda request: sent.append(json.loads(request.post_data))
               if "/api/kill/stop-bound" in request.url else None)
        tab.on("dialog", lambda dialog: asyncio.create_task(dialog.accept()))
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((s) => s.name === 'stop-bound')")
        created = await tab.evaluate("data.mesh.find((s) => s.name === 'stop-bound').created")
        await tab.locator('#list .item[data-id="stop-bound"]').click()
        await tab.locator('.pane.active [data-act="more"]').click()
        await tab.get_by_role("menuitem", name=ui("paneActions.action.stop")).click()
        await tab.wait_for_function("!data.mesh.some((s) => s.name === 'stop-bound')")
        assert sent == [{"created": created}]
    finally:
        await context.close()


@pytest.mark.parametrize("phone", [False, True], ids=["desktop", "emulated-phone"])
async def test_pane_action_target_and_reload_disposition_in_real_app(browser, mesh, home_dir, phone):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "pane-action-a"})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "pane-action-b"})
    options = {"viewport": {"width": 390 if phone else 1440, "height": 800},
               "has_touch": phone, "is_mobile": phone}
    context = await browser.new_context(**options)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        errors = []
        tab.on("pageerror", lambda error: errors.append(str(error)))
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'pane-action-a')")
        if phone:
            await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.locator('#list .item[data-id="pane-action-a"]').click()
        await tab.wait_for_function("active?.id === 'pane-action-a'")
        if phone:
            assert await tab.locator("#line-text").is_visible()
        # A plain shell has no mailbox button; an application-launched agent session does.
        assert await tab.get_by_role("button", name=ui("pane.mailboxAria")).count() == 0
        await tab.evaluate("""() => {
          data.mesh.find((session) => session.id === 'pane-action-a').known_agent = 'codex';
          active.header();
        }""")
        assert await tab.get_by_role("button", name=ui("pane.mailboxAria")).is_visible()
        assert await tab.get_by_role("button", name=ui("pane.boardOpen")).is_visible()
        assert await tab.get_by_role("button", name=ui("pane.more"), exact=True).is_visible()

        # Test the real menu/controller and active-sensitive identity, then
        # the independently captured composer whose target survives selection.
        await tab.get_by_role("button", name=ui("pane.more"), exact=True).click()
        assert await tab.evaluate("paneMenuHolds.size === 1")
        menu_box = await tab.get_by_role("menu", name=ui("pane.menu")).bounding_box()
        assert menu_box is not None
        assert menu_box["width"] >= 280, "Menu must not shrink to the icon toolbar width"
        assert await tab.get_by_role("menu", name=ui("pane.menu")).evaluate(
            "element => element.scrollWidth <= element.clientWidth")
        assert menu_box["x"] >= 0 and menu_box["x"] + menu_box["width"] <= (390 if phone else 1440)
        assert menu_box["y"] >= 0 and menu_box["y"] + menu_box["height"] <= 800
        await tab.evaluate("addPane('pane-action-b')")
        await tab.wait_for_function("active?.id === 'pane-action-b'")
        assert await tab.evaluate("paneMenuHolds.size === 0")
        await tab.evaluate("setActive(panes.find((pane) => pane.id === 'pane-action-a'))")
        # The long-message dialog opens from the More menu (a phone also has the bottom input).
        await tab.locator('.pane.active [data-act="more"]').click()
        await tab.get_by_role("menuitem", name=ui("paneActions.action.compose")).click()
        assert await tab.locator("#dlg-compose").is_visible()
        await tab.locator("#compose-text").fill("message pour A")
        await tab.evaluate("""() => {
          window.__paneActionSent=[];
          paneInput.deliver=(binding,text,enter,settle)=>{
            __paneActionSent.push({id:binding.target.id,text,enter});
            settle({kind:'paste',frames:1,wireBytes:text.length,reason:null});
            return {cancel(){}};
          };
          setActive(panes.find((pane) => pane.id === 'pane-action-b'));
        }""")
        await tab.get_by_role("button", name=ui("compose.insert"), exact=True).click()
        await tab.wait_for_function("!document.querySelector('#dlg-compose').open")
        assert await tab.evaluate("__paneActionSent") == [
            {"id": "pane-action-a", "text": "message pour A", "enter": False}]

        # The update summary is the production DOM, not a copied model. A
        # retained result forbids automatic reload and requires a manual warning.
        await tab.evaluate("""() => {
          lineRecovery={target:{displayName:'A'},text:'non envoyé',
            result:{kind:'uncertain',frames:1,wireBytes:4,reason:'send'}};
          renderLineStatus();checkClientVersion('new-test-version');
        }""")
        assert await tab.locator("#reload-status").is_visible()
        assert await tab.evaluate("safeToReload() === false")
        assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")
        prompt = []

        async def decline(dialog):
            prompt.append(dialog.message)
            await dialog.dismiss()

        tab.once("dialog", lambda dialog: asyncio.create_task(decline(dialog)))
        await tab.locator("#update-bar").click()
        assert prompt and ui("reload.confirmManual", n=1).split(". ")[0] in prompt[0]
        assert await tab.evaluate("lineRecovery !== null")
        assert not errors, errors
    finally:
        await context.close()


async def test_emulated_phone_media_permission_cancel_reopen_keeps_new_owner(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "media-a"})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "media-b"})
    context = await browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        errors = []
        tab.on("pageerror", lambda error: errors.append(str(error)))
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'media-a')")
        await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.locator('#list .item[data-id="media-a"]').click()
        await tab.wait_for_function("active?.id === 'media-a' && active.conn?.ws?.readyState === WebSocket.OPEN")
        await tab.evaluate("""() => {
          window.__mediaRequests=[];
          Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
            getUserMedia(constraints){return new Promise(resolve=>__mediaRequests.push({constraints,resolve}));}
          }});
          window.__oldStream={stopped:0,getTracks(){return [{stop(){__oldStream.stopped++}}]}};
        }""")

        async def start_microphone():
            await tab.locator('.pane.active [data-act="more"]').click()
            await tab.get_by_role("menuitem", name=ui("paneActions.action.file")).click()
            await tab.get_by_role("menuitem", name=ui("attach.mic")).click()
            state = await tab.evaluate("""() => ({dialog:adlg.open,owner:capActive?.destination?.target?.id,
              mainHidden:$('#cap-main').hidden,captureHidden:$('#attach-capture').hidden,
              status:$('#cap-status').textContent,active:active?.id,connected:!!active?.conn})""")
            assert not state["mainHidden"], state
            await tab.locator("#cap-main").click()

        await start_microphone()
        assert await tab.evaluate("__mediaRequests.length === 1 && capActive.destination.target.id === 'media-a'")
        assert await tab.evaluate("reloadHolds().some((hold)=>hold.kind==='media')")
        await tab.locator("#cap-cancel").click()
        assert await tab.evaluate("capActive === null && !adlg.open")
        await tab.evaluate("active.show('media-b')")
        await tab.wait_for_function("active?.id === 'media-b' && active.conn?.ws?.readyState === WebSocket.OPEN")
        await start_microphone()
        await tab.evaluate("__mediaRequests[0].resolve(__oldStream)")
        await tab.wait_for_function("__oldStream.stopped === 1")
        assert await tab.evaluate("capActive.destination.target.id === 'media-b' && __mediaRequests.length === 2")
        await tab.locator("#cap-cancel").click()
        assert not errors, errors
    finally:
        await context.close()


async def test_unfinished_input_lease_stays_with_its_session_incarnation(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "lease-a"})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "lease-b"})
    context = await browser.new_context()
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'lease-a')")
        await tab.locator('#list .item[data-id="lease-a"]').click()
        await tab.wait_for_function("active?.id === 'lease-a' && active.conn?.ws?.readyState === WebSocket.OPEN")
        assert await tab.evaluate("active.send('partial'); active.inputLease.dirty")
        await tab.evaluate("active.show('lease-b')")
        await tab.wait_for_function("active?.id === 'lease-b' && active.conn?.ws?.readyState === WebSocket.OPEN")
        state = await tab.evaluate("""() => ({
          currentDirty: active.inputLease.dirty,
          retained: [...active.inputLeases.values()].map(lease => lease.dirty),
          leases: active.inputLeases.size,
        })""")
        assert state == {"currentDirty": False, "retained": [True, False], "leases": 2}
        assert await tab.evaluate("active.send('safe'); active.send('\\r'); !active.inputLease.dirty")
        assert await tab.evaluate("[...active.inputLeases.values()].map(lease => lease.dirty)") == [True, False]
    finally:
        await context.close()


async def test_compact_phone_zoomed_menu_is_scrollable_without_resizing_pty(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "zoomed-menu-a"})
    context = await browser.new_context(viewport={"width": 390, "height": 667}, has_touch=True, is_mobile=True)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.wait_for_function("data?.mesh?.some((session) => session.id === 'zoomed-menu-a')")
        await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.locator('#list .item[data-id="zoomed-menu-a"]').click()
        await tab.wait_for_function("active?.conn?.ws?.readyState === WebSocket.OPEN")
        await tab.evaluate("document.body.style.fontSize = '26px'")
        await tab.wait_for_function("active.conn.autoRedraw === null && active.conn.initialFollow === null")
        await tab.wait_for_timeout(150)
        await tab.evaluate("""() => {
          window.__menuSizes=[];
          const ws=active.conn.ws, send=ws.send.bind(ws);
          ws.send=(value)=>{try{const message=JSON.parse(value);if(message.t==='r')__menuSizes.push(message)}catch{};send(value)};
          window.__rowsBeforeMenu=active.term.rows;
        }""")
        await tab.locator('.pane.active [data-act="more"]').click()
        menu = tab.get_by_role("menu", name=ui("pane.menu"))
        menu_box = await menu.bounding_box()
        assert menu_box is not None and menu_box["y"] >= 0 and menu_box["y"] + menu_box["height"] <= 667
        for item in await menu.get_by_role("menuitem").all():
            await item.scroll_into_view_if_needed()
            row = await item.bounding_box()
            assert row is not None and 0 <= row["y"] and row["y"] + row["height"] <= 667, row
        await tab.wait_for_timeout(150)
        sizing = await tab.evaluate("({before:__rowsBeforeMenu,after:active.term.rows,sent:__menuSizes})")
        assert sizing == {"before": sizing["before"], "after": sizing["before"], "sent": []}, sizing
        await tab.keyboard.press("Escape")
        await tab.wait_for_timeout(150)
        sizing = await tab.evaluate("({before:__rowsBeforeMenu,after:active.term.rows,sent:__menuSizes})")
        assert sizing == {"before": sizing["before"], "after": sizing["before"], "sent": []}, sizing
    finally:
        await context.close()
