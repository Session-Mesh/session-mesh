# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Browser coverage for the browser-local tab-group workspace."""

import pytest

import json

import server
import portfolio
from conftest import ui
from test_sidebar_menu import api
from test_view_compat import goto


pytestmark = pytest.mark.usefixtures("pty")
DOCUMENT = json.dumps(ui("paneActions.identity.kind.document"))
BOARD = json.dumps(ui("paneActions.identity.kind.board"))
UNKNOWN_SESSION = ui("paneActions.identity.session", session=ui("paneActions.identity.sessionUnknown"))


async def test_terminal_info_copies_mesh_name_and_envelope_opens_the_mailbox(workspace):
    tab = workspace
    # The envelope belongs to application-launched agent sessions, so this shell is shown as one.
    await tab.evaluate("() => { find(active.id).known_agent = 'codex'; active.header(); }")
    identity = await tab.evaluate("() => { const s = find(active.id); return {id:s.name, created:s.created, agent:'codex'} }")
    async def mailbox(route):
        peer = {"id": "other-session", "created": 2, "agent": "claude"}
        message = {"id": "a" * 32, "conversation_id": "b" * 32, "source": peer, "target": identity,
                   "kind": "message", "text": "<b>hello</b>", "created": 3, "seq": 1}
        await route.fulfill(json={"identity": identity, "received": [message], "sent": [], "truncated": False,
            "requests": [], "always": [{"id": "c" * 32, "source": peer, "target": identity, "created": 4}]})
    await tab.route("**/api/agent-mail/messages**", mailbox)
    await tab.evaluate("() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => { window.copiedMeshName = text; }}})")
    pane = tab.locator(".pane").filter(has=tab.locator(".p-name", has_text="workspace"))
    await pane.get_by_label(ui("pane.identity"), exact=True).click()
    body = pane.locator(".p-provenance-body")
    assert ui("pane.meshSessionName", name=identity["id"]) in await body.inner_text()
    await body.get_by_role("button", name=ui("pane.copySessionNameLabel")).click()
    assert await tab.evaluate("window.copiedMeshName") == identity["id"]
    assert ui("mailbox.title") not in await body.inner_text(), "the mailbox is no longer a second display in Info"
    await pane.get_by_role("button", name=ui("pane.mailboxAria")).click()
    dialog = tab.locator("#dlg-mailbox")
    await dialog.locator(".mailbox-message").wait_for()
    assert await dialog.locator(".mailbox-text").text_content() == "<b>hello</b>"
    assert ui("mailbox.policyIn", peer="other-session", agent="claude") in await dialog.inner_text()


async def test_contextual_phone_reload_restores_terminal_not_snapshot(workspace, monkeypatch):
    tab = workspace
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await tab.set_viewport_size({"width": 390, "height": 900})
    await tab.evaluate("() => refresh()")
    async def diff(route):
        await route.fulfill(json={"state": "observed", "files": ["secret-content.txt"], "unified": "+snapshot-only"})
    await tab.route("**/api/portfolio/diff/**", diff)
    await tab.evaluate("() => openContextualDiff(data.portfolio.mesh_sessions.directories[0].cwd)")
    await tab.wait_for_function("document.querySelector('.contextual-diff-panel')?.innerText.includes('snapshot-only')")
    saved = await tab.evaluate("localStorage.getItem('mesh.workspace.v1')")
    assert '"id":"workspace"' in saved
    assert "context-diff:" not in saved and "snapshot-only" not in saved
    await tab.reload(wait_until="domcontentloaded")
    await tab.wait_for_function("active?.conn?.name === 'workspace'")
    assert await tab.locator(".contextual-diff-panel").count() == 0
    assert await tab.evaluate("data.mesh.some(s => s.name === 'workspace')")


async def test_panel_identity_does_not_infer_document_session_or_rights(workspace, home_dir, mesh, tmp_path):
    tab = workspace
    document = home_dir / "identity.md"
    document.write_text("# Identity\n", encoding="utf-8")
    await tab.evaluate("path => openWeb(path)", str(document))
    await tab.wait_for_function(f"panes.some(p => p.panelIdentity?.kind === {DOCUMENT})")
    pane = tab.locator(".pane").filter(has=tab.locator(".p-name", has_text="identity.md"))
    disclosure = pane.get_by_label(ui("pane.identity"), exact=True)
    await disclosure.click()
    body = pane.locator(".p-provenance-body")
    await tab.wait_for_function(f"panes.some(p => p.panelIdentity?.kind === {DOCUMENT} && p.panelIdentity.state === "
                                f"{json.dumps(ui('paneActions.identity.state.frameLoaded'))})")
    assert UNKNOWN_SESSION in await body.inner_text()
    assert ui("paneActions.identity.rightsHidden") in await body.inner_text()
    assert ui("paneActions.identity.origin", origin=ui("paneActions.identity.originLocal")) in await body.inner_text()
    await tab.keyboard.press("Escape")
    assert await disclosure.evaluate("el => document.activeElement === el")
    assert not await pane.locator(".p-provenance").evaluate("el => el.open")
    await tab.set_viewport_size({"width": 390, "height": 800})
    await disclosure.click()
    assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert await tab.locator(".bar").evaluate("el => el.getBoundingClientRect().height") == 56
    await tab.screenshot(path=str(tmp_path / "identity-phone.png"))
    # A second real inventory session must not become document provenance.
    await tab.set_viewport_size({"width": 1360, "height": 900})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "identity-other"})
    await tab.wait_for_function("data.mesh.some(s => s.name === 'identity-other')")
    await tab.evaluate("() => openBoard(data.mesh.find(s => s.name === 'identity-other').id)")
    await tab.wait_for_function(f"panes.some(p => p.panelIdentity?.kind === {BOARD})")
    result = await tab.evaluate("""board => {
      board = panes.find(p => p.panelIdentity?.kind === board);
      // Adversarial display fixture only; API session names are stricter.
      find(find(board.id).session).name = '<script>other</script>';
      setActive(panes.find(p => p.id === 'workspace'));
      board.header();
      const linked = board.panelIdentity.session;
      const safe = !board.el.querySelector('.p-provenance-body script');
      data.mesh = data.mesh.filter(s => s.id !== find(board.id).session);
      board.header();
      return {linked,safe,state:board.panelIdentity.state,session:board.panelIdentity.session};
    }""", ui("paneActions.identity.kind.board"))
    assert result == {"linked": ui("paneActions.identity.session", session="<script>other</script>"), "safe": True,
                      "state": ui("paneActions.identity.state.unavailable"), "session": UNKNOWN_SESSION}
    await tab.screenshot(path=str(tmp_path / "identity-desktop.png"))
    await tab.evaluate("path => openWeb(path)", str(document))
    await tab.wait_for_function(f"panes.some(p => p.panelIdentity?.kind === {DOCUMENT})")
    await tab.reload(wait_until="domcontentloaded")
    await tab.wait_for_function(f"panes.some(p => p.panelIdentity?.kind === {DOCUMENT})")
    assert await tab.evaluate(f"panes.find(p => p.panelIdentity?.kind === {DOCUMENT}).panelIdentity.session") == UNKNOWN_SESSION


async def test_direct_phone_panels_preserve_document_terminal_and_focus(workspace, home_dir, tmp_path):
    tab = workspace
    document = home_dir / "panels.md"
    document.write_text("# Panel document\n", encoding="utf-8")
    await tab.set_viewport_size({"width": 390, "height": 800})
    requests = []
    tab.on("request", lambda request: requests.append(request.url))
    button = tab.get_by_role("button", name=ui("mobile.panelsAria"), exact=True)
    assert await button.is_visible()
    box = await button.bounding_box()
    assert box["width"] >= 44 and box["height"] >= 44
    # Existing mobile document opening reuses the foreground pane; create the
    # adjacent document at desktop width before exercising the phone selector.
    await tab.set_viewport_size({"width": 1000, "height": 700})
    await tab.evaluate("(path) => openWeb(path)", str(document))
    await tab.wait_for_function("panes.some(p => p.id.startsWith('web:'))")
    await tab.set_viewport_size({"width": 390, "height": 800})
    await button.click()
    await tab.get_by_role("button", name=f"{ui('pane.kind.terminal')} · workspace", exact=True).click()
    await tab.wait_for_function("active?.id === 'workspace'")
    await button.click()
    await tab.keyboard.press("Escape")
    assert await button.get_attribute("aria-expanded") == "false"
    assert await button.evaluate("el => document.activeElement === el")
    await button.click()
    await tab.get_by_role("button", name=f"{ui('pane.kind.document')} · panels.md", exact=True).click()
    await button.click()
    await tab.get_by_role("button", name=ui("mobilePanels.closeLabel", name="panels.md"), exact=True).click()
    await tab.keyboard.press("Escape")
    await tab.wait_for_function("active?.id === 'workspace'")
    assert not any("/api/kill" in url or "/api/stop" in url for url in requests)
    await tab.reload(wait_until="domcontentloaded")
    await tab.wait_for_function("active?.id === 'workspace'")
    assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert await tab.locator(".bar").evaluate("el => el.getBoundingClientRect().height") == 56
    await tab.screenshot(path=str(tmp_path / "phone.png"))
    await tab.set_viewport_size({"width": 1360, "height": 900})
    assert not await button.is_visible()
    await tab.screenshot(path=str(tmp_path / "desktop.png"))


@pytest.fixture
async def workspace(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "workspace"})
    context = await browser.new_context(viewport={"width": 1000, "height": 700})
    await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    tab = await context.new_page()
    await goto(tab, mesh.origin + "/")
    await tab.click('#list .item[data-id="workspace"]')
    await tab.wait_for_function("active?.conn?.ws?.readyState === 1")
    yield tab
    await context.close()


async def test_tabs_are_local_typed_and_preserve_the_live_terminal_instance(workspace):
    tab = workspace
    assert await tab.locator(".workspace-tab").count() == 1
    assert await tab.evaluate("active.term.__workspace_probe = 'kept'; active.group.tabs.length") == 1

    await tab.get_by_role("button", name=ui("pane.addTab")).click()
    assert await tab.locator(".workspace-tab").count() == 2
    saved = await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v1'))")
    assert saved["columns"][0]["tabs"][0]["kind"] == "terminal"

    await tab.locator(".workspace-tab").nth(0).click()
    await tab.wait_for_function("active?.id === 'workspace'")
    assert await tab.evaluate("active.term.__workspace_probe") == "kept"
    assert await tab.evaluate("active.conn?.ws?.readyState") == 1
    assert await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v1')).columns[0].active") == 0

    await tab.reload(wait_until="domcontentloaded")
    await tab.wait_for_function("document.querySelectorAll('.workspace-tab').length === 2")
    assert await tab.evaluate("workspaceGroups[0].selected === workspaceGroups[0].tabs[0]")


async def test_workspace_v1_migrates_to_inert_v2_slot_without_relaunching(workspace):
    tab = workspace
    requests = []
    tab.on("request", lambda request: requests.append(request.url))
    await tab.evaluate("""() => {
      localStorage.removeItem('mesh.workspace.v2');
      localStorage.setItem('mesh.workspace.v1', JSON.stringify({
        active: 'workspace', columns: [{ grow: 1, active: 1, tabs: [
          { id: 'gone-session', kind: 'terminal' }, { id: 'workspace', kind: 'terminal' },
        ] }],
      }));
    }""")
    await tab.reload(wait_until="domcontentloaded")
    await tab.wait_for_function("workspaceGroups[0]?.tabs.length === 2 && active?.id === 'workspace'")
    saved = await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v2'))")
    assert saved["version"] == 2
    assert saved["active"] == {"column": 0, "tab": 1}
    assert saved["columns"][0]["tabs"][0] == {"type": "terminal", "target": "gone-session"}
    await tab.locator(".workspace-tab").nth(0).click()
    assert ui("pane.unavailable.gone") in await tab.locator(".empty:visible").inner_text()
    assert not any("/api/new" in url or "/api/restore" in url for url in requests)
    await tab.set_viewport_size({"width": 390, "height": 800})
    assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")



async def test_columns_can_be_reordered_without_an_api_or_terminal_action(workspace):
    tab = workspace
    await tab.locator("#btn-split").click()
    await tab.wait_for_function("document.querySelectorAll('.workspace-group').length === 2")
    before = await tab.evaluate("workspaceGroups.map((g) => g.id)")
    await tab.locator(".workspace-group").nth(0).get_by_role("button", name=ui("pane.moveRight")).click()
    assert await tab.evaluate("workspaceGroups.map((g) => g.id)") == [before[1], before[0]]
    assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")


async def test_tabs_have_standard_keyboard_semantics(workspace):
    tab = workspace
    await tab.get_by_role("button", name=ui("pane.addTab")).click()
    first, second = tab.locator(".workspace-tab").nth(0), tab.locator(".workspace-tab").nth(1)
    await first.focus()
    await tab.keyboard.press("ArrowRight")
    assert await second.get_attribute("aria-selected") == "true"
    assert await tab.evaluate("document.activeElement === document.querySelectorAll('.workspace-tab')[1]")
    await tab.keyboard.press("Home")
    assert await first.get_attribute("aria-selected") == "true"


async def test_phone_panels_can_switch_and_close_without_killing_a_session(browser, mesh, home_dir):
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "mobile-a"})
    await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "mobile-b"})
    context = await browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
    try:
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        await goto(tab, mesh.origin + "/")
        await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.click('#list .item[data-id="mobile-a"]')
        await tab.wait_for_function("active?.id === 'mobile-a'")
        await tab.evaluate("addPane('mobile-b')")
        await tab.wait_for_function("workspaceGroups.length === 2")
        await tab.get_by_role("button", name=ui("bar.sessions"), exact=True).click()
        await tab.click('#list .item[data-id="mobile-a"]')
        await tab.wait_for_function("active?.id === 'mobile-a'")
        assert await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v1')).active") == "mobile-a"
        assert await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v1')).columns.length") == 2
        await tab.reload(wait_until="domcontentloaded")
        await tab.wait_for_function("active?.id === 'mobile-a' && workspaceGroups.length === 2")
        await tab.get_by_role("button", name=ui("mobile.panelsAria")).click()
        await tab.get_by_role("button", name=f"{ui('pane.kind.terminal')} · mobile-a").click()
        await tab.wait_for_function("active?.id === 'mobile-a'")
        assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await tab.get_by_role("button", name=ui("mobile.panelsAria")).click()
        await tab.get_by_role("button", name=ui("mobilePanels.closeLabel", name="mobile-a")).click()
        await tab.wait_for_function("active?.id === 'mobile-b'")
        assert await tab.evaluate("!panes.some((p) => p.id === 'mobile-a')")
        assert await tab.evaluate("data.mesh.some((s) => s.id === 'mobile-a')")
        assert await tab.evaluate("JSON.parse(localStorage.getItem('mesh.workspace.v1')).active") == "mobile-b"
    finally:
        await context.close()
