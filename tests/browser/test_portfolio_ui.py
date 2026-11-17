# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Owner UI: observed directories are informative, not controls."""

import asyncio

import pytest

import portfolio
import server
from conftest import ui
from test_view_compat import goto


pytestmark = pytest.mark.usefixtures("pty")
DIFF_TEXT = "text => document.querySelector('.contextual-diff-panel')?.innerText.includes(text)"


@pytest.mark.parametrize("width", [390, 1360])
async def test_portfolio_received_provenance_is_safe_keyboard_readonly(page, mesh, pty, monkeypatch, tmp_path, width):
    hostile = "/public/" + "long-directory-" * 16 + "<script>.txt"
    async def observed(*_):
        return {"state": "observed", "worktrees": [{"path": hostile, "head": None,
            "branch": "<img onerror=window.portfolioPwned=1>", "detached": False, "bare": False}]}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("provenance-session")
    await page.set_viewport_size({"width": width, "height": 900})
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.state === 'observed'")
    if width == 390:
        await page.locator("#btn-menu").click()
        await page.wait_for_function("document.querySelector('#side').getBoundingClientRect().left >= 0")
    details = page.locator(".portfolio-provenance")
    await details.wait_for(timeout=3000)
    summary = details.locator("summary")
    await summary.focus()
    await page.keyboard.press("Enter")
    await page.evaluate("renderList()")
    assert await details.evaluate("e => e.open")
    assert await summary.evaluate("e => document.activeElement === e")
    assert hostile in await details.inner_text()
    assert "<img onerror=window.portfolioPwned=1>" in await details.inner_text()
    assert ui("portfolio.fact.head", head=ui("paneActions.provenance.unknownHead")) in await details.inner_text()
    assert ui("portfolio.observationOnly") in await details.inner_text()
    assert await details.locator("img, script, a, input, textarea").count() == 0
    assert await page.evaluate("window.portfolioPwned === undefined")
    assert await summary.evaluate("e => e.getBoundingClientRect().height") >= 44
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await details.locator(".portfolio-facts").scroll_into_view_if_needed()
    await page.screenshot(path=str(tmp_path / f"portfolio-provenance-{width}.png"))
    await page.keyboard.press("Escape")
    assert not await details.evaluate("e => e.open")
    assert await summary.evaluate("e => document.activeElement === e")
    assert await page.evaluate("data.mesh.some(s => s.name === 'provenance-session')")


async def test_portfolio_malformed_and_partial_states_never_become_positive_counts(page, mesh, pty):
    await pty.new("portfolio-states")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.state === 'observed'")
    result = await page.evaluate("""malformedLabel => {
      const state = (value) => { const node = document.createElement('div'); node.innerHTML = worktreeNote(value); return node.innerText; };
      const malformedSessions = portfolioHtml({mesh_sessions:{state:'observed',directories:[null]}});
      return {absent:state(undefined), empty:state({state:'observed',directories:[]}),
        unavailable:state({state:'unavailable'}), malformed:state({state:'observed',directories:{}}),
        malformedFacts:state({state:'observed',directories:[{cwd:'/bad',state:'observed',worktrees:[{}]}]}),
        sessions:malformedSessions.includes(malformedLabel)};
    }""", ui("portfolio.meshMalformed").split(" · ")[0])
    assert result == {"absent": ui("worktrees.notCollected"), "empty": ui("worktrees.observed", n=0),
                      "unavailable": ui("worktrees.unavailable"), "malformed": ui("worktrees.malformed"),
                      "malformedFacts": ui("worktrees.observed", n=0) + ui("worktrees.undetermined", n=1),
                      "sessions": True}


@pytest.mark.parametrize("failure", ["503", "invalid", "network"])
async def test_failed_listing_does_not_reuse_a_cached_diff_selector(page, mesh, pty, monkeypatch, failure):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("review-refresh")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.directories?.length === 1")
    calls = 0
    async def diff(route):
        nonlocal calls
        calls += 1
        await route.fulfill(json={"state": "clean"})
    await page.route("**/api/portfolio/diff/**", diff)
    await page.locator("[data-portfolio-diff]").click()
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.clean"))
    async def failed_listing(route):
        if failure == "network":
            await route.abort()
        elif failure == "invalid":
            await route.fulfill(json={"mesh": [], "external": [], "portfolio": {"mesh_sessions": {"state": "observed", "directories": {}}}})
        else:
            await route.fulfill(status=503, body="")
    await page.route("**/api/sessions", failed_listing)
    await page.locator(".contextual-diff-refresh").click()
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.unavailable"), timeout=3000)
    assert calls == 1


async def test_contextual_network_failure_never_claims_response_received(page, mesh, pty, monkeypatch):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("network-diff")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.directories?.length === 1")
    await page.route("**/api/portfolio/diff/**", lambda route: route.abort())
    await page.locator("[data-portfolio-diff]").click()
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.unavailable"))
    assert await page.evaluate("[...portfolioDiffs.values()][0].receivedAt") is None
    await page.locator(".contextual-diff-provenance summary").click()
    assert ui("diff.notReceived") in await page.inner_text(".contextual-diff-panel")


async def test_contextual_diff_is_available_only_for_an_observed_directory_and_is_escaped_read_only(page, mesh, pty, monkeypatch):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("portfolio-ui")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.state === 'observed'")
    await page.wait_for_function("document.querySelector('.portfolio')")
    text = await page.inner_text(".portfolio")
    assert ui("portfolio.title").upper() in text.upper()
    assert ui("worktrees.observed", n=0) in text
    assert ui("portfolio.historyNotCollected") in text
    assert "portfolio-ui" not in text  # directory inventory, never an alternate session control
    button = page.locator("[data-portfolio-diff]")
    assert await button.count() == 1

    async def diff(route):
        await route.fulfill(json={"state": "observed", "files": ["<img>"],
                                  "unified": "<script>window.pwned=1</script>"})
    await page.route("**/api/portfolio/diff/**", diff)
    await button.click()
    panel = page.locator(".contextual-diff-panel")
    await panel.wait_for(timeout=3000)
    assert "<script>window.pwned=1</script>" in await panel.inner_text()
    assert await panel.locator("script, img, textarea, form").count() == 0
    assert await page.locator(".portfolio .portfolio-diff").count() == 0



async def test_contextual_clean_state_is_not_presented_as_an_unavailable_diff(page, mesh, pty, monkeypatch):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("portfolio-clean")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])

    release = asyncio.Event()
    async def clean(route):
        await release.wait()
        await route.fulfill(json={"state": "clean"})
    await page.route("**/api/portfolio/diff/**", clean)
    await goto(page, mesh.origin + "/")
    button = page.locator("[data-portfolio-diff]")
    await button.click()
    # Polling rotates opaque selectors.  The in-flight result belongs to this
    # displayed CWD, rather than being discarded by that harmless rotation.
    await page.evaluate("data.portfolio.mesh_sessions.directories[0].diff_selector = 'rotated'; renderList()")
    release.set()
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.clean"))
    assert ui("diff.state.clean") in await page.inner_text(".contextual-diff-panel")


@pytest.mark.parametrize("width", [390, 1360])
async def test_contextual_panel_keeps_issuer_and_safe_colors_without_storage(page, mesh, pty, monkeypatch, home_dir, tmp_path, width):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    first, second = home_dir / "first", home_dir / "second"
    first.mkdir()
    second.mkdir()
    for name, cwd in [("diff-first", first), ("diff-second", second)]:
        assert await pty.request({"op": "new", "name": name, "cwd": str(cwd), "command": None}) == {"ok": True, "name": name}
    await page.set_viewport_size({"width": width, "height": 900})
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    writes = []
    page.on("request", lambda request: writes.append(request.url) if request.method != "GET" else None)
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.directories?.length === 2")
    await page.evaluate("() => { panes[0].show(data.mesh.find(s => s.name === 'diff-first').id); addPane(data.mesh.find(s => s.name === 'diff-second').id); setActive(panes[0]); }")
    async def diff(route):
        await route.fulfill(json={"state": "observed", "files": ["<img>.txt"], "unified": "--- a/<img>.txt\n+++ b/<img>.txt\n@@ -1 +1 @@\n-removed\n+<script>window.pwned=1</script>\n context"})
    await page.route("**/api/portfolio/diff/**", diff)
    # The genuine issuer listing, not the active terminal, selects the target.
    await page.evaluate("cwd => openContextualDiff(cwd)", str(first))
    panel = page.locator(".contextual-diff-panel")
    await panel.locator(".added").wait_for()
    assert "diff-first" in await panel.inner_text()
    assert str(first) not in await panel.inner_text()
    summary = panel.locator(".contextual-diff-provenance summary")
    assert await summary.evaluate("e => e.getBoundingClientRect().height") >= 44
    await summary.focus()
    await page.keyboard.press("Enter")
    assert str(first) in await panel.inner_text()
    assert ui("diff.incarnation", created="").strip() in await panel.inner_text()
    await page.keyboard.press("Escape")
    assert not await panel.locator("details").evaluate("e => e.open")
    assert await summary.evaluate("e => document.activeElement === e")
    assert ui("diff.gitTimeUnknown") in await panel.inner_text()
    assert await panel.locator(".file-header").count() == 2
    assert await panel.locator(".deleted").count() == 1
    assert await panel.locator("script, img").count() == 0
    assert await page.evaluate("window.pwned === undefined")
    await page.evaluate("() => { const p = panes.find(p => !isContextualDiffPane(p.id)); p.show(data.mesh.find(s => s.name === 'diff-second').id); setActive(p); }")
    assert "diff-first" in await panel.inner_text()
    await page.evaluate("() => setActive(panes.find(p => isContextualDiffPane(p.id)))")
    # Close the drawer with its actual transition completion, not a sleep.
    await page.evaluate("() => { document.body.classList.remove('sidebar-open'); if (typeof closeSidebar === 'function') closeSidebar(); }")
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert await panel.locator(".contextual-diff-refresh").evaluate("e => e.getBoundingClientRect().height") >= 44
    await page.screenshot(path=str(tmp_path / f"contextual-{width}.png"))
    state = await page.evaluate("JSON.stringify({workspace:store.get('workspace.v1'),layout:store.get('layout'),hash:location.hash})")
    assert "context-diff:" not in state and "<script>" not in state and "diff_selector" not in state
    assert not any("/api/kill/" in url or "/api/input" in url or "/api/command" in url for url in writes)
    await page.reload(wait_until="domcontentloaded")
    await page.wait_for_function("data?.mesh?.length === 2")
    assert await page.locator(".contextual-diff-panel").count() == 0


@pytest.mark.parametrize("change", ["closed", "created", "cwd", "missing"])
async def test_contextual_pending_reply_never_retargets_or_resurrects(page, mesh, pty, monkeypatch, change):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("pending-diff")
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await page.set_viewport_size({"width": 1360, "height": 900})
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.directories?.length === 1")
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed(route):
        entered.set()
        await release.wait()
        await route.fulfill(json={"state": "observed", "files": ["late.txt"], "unified": "+late private snapshot"})
    await page.route("**/api/portfolio/diff/**", delayed)
    await page.locator("[data-portfolio-diff]").click()
    await asyncio.wait_for(entered.wait(), 3)
    # Prevent polling from overwriting the explicit adversarial identity witness.
    await page.evaluate("""change => {
      const p = panes.find(p => isContextualDiffPane(p.id));
      const row = data.portfolio.mesh_sessions.directories[0];
      if (change === 'closed') closePane(p);
      else if (change === 'created') row.sessions[0].created += 1;
      else if (change === 'cwd') row.cwd += '/replacement';
      else data.portfolio.mesh_sessions.directories = [];
    }""", change)
    release.set()
    if change == "closed":
        await page.wait_for_function("portfolioDiffs.size === 0")
        assert await page.locator(".contextual-diff-panel").count() == 0
    else:
        await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.unavailable"))
        assert "late private snapshot" not in await page.inner_text(".contextual-diff-panel")


async def test_contextual_refresh_uses_fresh_selector_and_escape_returns_bound_terminal(page, mesh, pty, monkeypatch):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    await pty.new("refresh-diff")
    await page.set_viewport_size({"width": 390, "height": 900})
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin + "/")
    await page.wait_for_function("data?.portfolio?.mesh_sessions?.directories?.length === 1")
    await page.evaluate("() => { panes[0].show(data.mesh[0].id); setActive(panes[0]); }")
    urls = []
    async def response(route):
        urls.append(route.request.url)
        if len(urls) == 1:
            await route.fulfill(status=404, body="")
        else:
            await route.fulfill(json={"state": "over-limit"})
    await page.route("**/api/portfolio/diff/**", response)
    await page.evaluate("() => openContextualDiff(data.portfolio.mesh_sessions.directories[0].cwd)")
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.unavailable"))
    await page.locator(".contextual-diff-refresh").click()
    await page.wait_for_function(DIFF_TEXT, arg=ui("diff.state.overLimit"))
    assert len(urls) == 2 and urls[0] != urls[1]
    await page.locator(".contextual-diff-refresh").focus()
    await page.keyboard.press("Escape")
    await page.wait_for_function("active?.conn?.name === 'refresh-diff'")
    assert await page.evaluate("portfolioDiffs.size") == 0
