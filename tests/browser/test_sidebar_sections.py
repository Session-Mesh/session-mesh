# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The status sections at the top of the sidebar: "Waiting for you", "Finished, unread" and
"Active" (copies of the sessions in that state), collapsible, hidden when empty."""

import asyncio

import pytest

import server
from conftest import ui
from test_view_compat import goto

pytestmark = pytest.mark.usefixtures("pty")
PHONE = {"viewport": {"width": 390, "height": 800}, "has_touch": True, "is_mobile": True}

HEADINGS = {st: ui(f"list.status.{st}.title") for st in ("wait", "unread", "busy")}


def fake(name, status, since=None):
    """An outside session whose agent is in `status`."""
    return {"id": name, "kind": "external", "host": "SSH", "cwd": f"/tmp/{name}", "tty": "/dev/pts/9",
            "cmd": "claude", "pid": 4000 + len(name), "name": name,
            "agent": {"type": "claude", "status": status, "name": name, "since": since,
                      "said": f"{name} says", "last": f"{name} last"}}


class FirstReplyGate:
    """Deterministically pause the initial session reply around fixture readiness."""

    def __init__(self):
        self.reply_started = asyncio.Event()
        self.reply_release = asyncio.Event()
        self.reply_finished = asyncio.Event()
        self.ready_started = asyncio.Event()
        self.ready_release = asyncio.Event()


class Sessions:
    """What the faked /api/sessions reports; changed by the test, applied to every reply."""

    def __init__(self, gate=None):
        self.specs = []
        self.gate = gate

    async def reply(self, route):
        # in every reply, not once in `data`: the page's own 4 s refresh would replace it (a race)
        if self.gate is not None:
            self.gate.reply_started.set()
            await self.gate.reply_release.wait()
        response = await route.fetch()
        body = await response.json()
        now = body["now"]
        body["external"] = []
        for name, status, offset, since in self.specs:
            session = fake(name, status, since and now - since)
            session["agent"]["updated"] = now + offset
            body["external"].append(session)
        await route.fulfill(response=response, json=body)
        if self.gate is not None:
            self.gate.reply_finished.set()


async def close_boards(contexts):
    """Release fixture gates and finish intercepted requests before closing their contexts."""
    for _, gate in contexts:
        if gate is not None:
            gate.ready_release.set()
            gate.reply_release.set()
    for context, _ in contexts:
        try:
            for tab in context.pages:
                await tab.unroute_all(behavior="wait")
            await context.unroute_all(behavior="wait")
        finally:
            await context.close()


@pytest.fixture
async def board(browser, mesh):
    """open(specs, **context) -> tab on a mesh that shows these fake sessions.
    A spec is (name, status, updated offset in s, wait-started seconds ago or None)."""
    contexts = []

    async def open_board(specs, gate=None, **options):
        context = await browser.new_context(**({"viewport": {"width": 1000, "height": 700}} | options))
        contexts.append((context, gate))
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        tab = await context.new_page()
        sessions = Sessions(gate)
        sessions.specs = specs
        await tab.route("**/api/sessions", sessions.reply)
        await goto(tab, mesh.origin + "/")
        if gate is not None:
            gate.ready_started.set()
            await gate.ready_release.wait()
        # ``external`` starts as an empty array, so it cannot by itself prove
        # that the initial asynchronous /api/sessions reply was applied when
        # this fixture has no fake outside sessions.  ``now`` comes only from
        # that reply; waiting for it prevents a late refresh replacing state
        # injected by a test below.
        await tab.wait_for_function(
            f"typeof data?.now === 'number' && data.external.length >= {len(specs)}", timeout=10000)
        tab.sessions = sessions
        return tab

    yield open_board
    await close_boards(contexts)


# the fixture sessions: two waiting (oldest wait first), two unread (newest first), two working
SPECS = [
    ("w-new", "waiting", 0, 30), ("w-old", "waiting", 0, 600),
    ("u-old", "idle", 20, None), ("u-new", "idle", 90, None),
    ("b-old", "busy", -50, None), ("b-new", "busy", -5, None),
]


async def test_pi_can_be_selected_in_new_session_dialog(board):
    tab = await board([])
    errors = []
    tab.on("pageerror", lambda error: errors.append(str(error)))
    await tab.locator("#btn-new").click()
    await tab.wait_for_timeout(100)
    assert not errors, errors
    pi = tab.locator('input[name="preset"][value="pi"]')
    await tab.locator('label:has(input[name="preset"][value="pi"])').click()
    assert await pi.is_checked()


async def headings(tab):
    return await tab.eval_on_selector_all("#list .status-head > span:nth-child(2)", "(e) => e.map((x) => x.textContent)")


async def ids(tab, st):
    return await tab.eval_on_selector_all(f"#list .{st}-section .item", "(e) => e.map((x) => x.dataset.id)")


async def test_each_state_has_its_titled_section_in_order(board):
    tab = await board(SPECS)
    assert await headings(tab) == [ui("list.status.wait.title"), ui("list.status.unread.title"), ui("list.status.busy.title")]
    assert await ids(tab, "wait") == ["w-old", "w-new"]        # oldest wait first
    assert await ids(tab, "unread") == ["u-new", "u-old"]      # newest first
    assert await ids(tab, "busy") == ["b-new", "b-old"]        # most recently active first
    counts = await tab.eval_on_selector_all("#list .status-head .count", "(e) => e.map((x) => x.textContent.trim())")
    assert counts == ["2", "2", "2"]
    assert ui("session.state.wait") in await tab.inner_text('#list .wait-section .item[data-id="w-old"] .meta')


async def test_each_heading_explains_itself(board):
    tab = await board(SPECS)
    for st in ("wait", "unread", "busy"):
        head = f"#list .status-head.{st}"
        text = await tab.get_attribute(head, "title")
        assert len(text) > 40
        assert await tab.get_attribute(f"{head} .help", "title") == text
    assert await tab.get_attribute("#list .status-head.wait", "title") == ui("list.status.wait.help")
    assert await tab.get_attribute("#list .status-head.unread", "title") == ui("list.status.unread.help")
    assert await tab.get_attribute("#list .status-head.busy", "title") == ui("list.status.busy.help")


@pytest.mark.parametrize("agent", ["codex", "pi"])
async def test_pinned_closed_conversation_survives_reload_and_opens_without_resuming(board, agent):
    tab = await board([])
    sid = "01a162e0-89bf-75d2-93db-abc74e04973f"
    calls = []
    detail = {"agent": agent, "id": sid, "cwd": "/tmp", "name": "cleanup", "updated": 0,
              "started": 0, "n_user": 0, "n_assistant": 0, "bytes": 0, "tin": 0,
              "tout": 0, "tcr": 0, "tcw": 0}

    async def history_detail(route):
        calls.append("detail")
        await route.fulfill(json=detail)

    async def resume(route):
        calls.append("resume")
        await route.fulfill(json={"id": "new"})

    await tab.route(f"**/api/history/{agent}/{sid}", history_detail)
    await tab.route("**/api/history/resume", resume)
    await tab.evaluate("({sid, agent}) => togglePin(agent, sid, 'Nettoyage disque')", {"sid": sid, "agent": agent})
    assert await tab.locator(".pinned-sessions .name").inner_text() == "Nettoyage disque"
    await tab.reload()
    await tab.wait_for_function("active !== null", timeout=3000)
    await tab.locator(".pinned-sessions .item").click()
    await tab.get_by_role("button", name=ui("history.card.resumeHere")).wait_for()
    assert calls == ["detail"]
    await tab.get_by_role("button", name=ui("pin.unpin"), exact=True).click()
    assert await tab.locator(".pinned-sessions").count() == 0
    await tab.get_by_role("button", name=ui("pin.pinHere")).click()
    assert await tab.locator(".pinned-sessions .name").inner_text() == "cleanup"
    assert calls == ["detail"]


@pytest.mark.parametrize("agent", ["codex", "pi"])
async def test_pin_active_mesh_conversation_from_context_menu(board, agent):
    tab = await board([])
    sid = "01a162e0-89bf-75d2-93db-abc74e04973f"
    await tab.evaluate("""({sid, agent}) => {
      data.mesh = [{id: 'mesh-clean', kind: 'mesh', name: 'Disque', cwd: '/tmp', cmd: agent,
        agent: {type: agent, session_id: sid, status: 'idle'}}];
      renderList();
    }""", {"sid": sid, "agent": agent})
    await tab.locator('#list .item[data-id="mesh-clean"]').click(button="right")
    await tab.get_by_role("menuitem", name=ui("pin.pinHere")).click()
    assert await tab.locator(".pinned-sessions .name").inner_text() == "Disque"
    assert await tab.locator(".pinned-sessions .item").get_attribute("data-id") == "mesh-clean"
    await tab.evaluate("data.mesh[0].label = 'Nouveau nom'; renderList(true)")
    assert await tab.locator(".pinned-sessions .name").inner_text() == "Nouveau nom"
    assert await tab.evaluate("pinnedSessions()[0].id") == sid
    await tab.get_by_role("button", name=ui("pins.unpinLabel", label="Nouveau nom")).click()
    assert await tab.evaluate("pinnedSessions().length") == 0


async def test_missing_transcript_can_still_be_unpinned(board):
    tab = await board([])
    sid = "01a162e0-89bf-75d2-93db-abc74e04973f"
    await tab.evaluate("sid => togglePin('codex', sid, 'Ancienne session')", sid)
    await tab.route(f"**/api/history/codex/{sid}", lambda route: route.fulfill(status=404, body="Session not found"))
    await tab.locator(".pinned-sessions .item").click()
    await tab.get_by_text(ui("server.sessionNotFound")).wait_for()
    await tab.get_by_role("button", name=ui("pins.unpinLabel", label="Ancienne session")).click()
    assert await tab.evaluate("pinnedSessions().length === 0")
    await tab.locator(".pinned-sessions").wait_for(state="detached", timeout=3000)


async def test_renaming_updates_saved_pin_without_changing_its_identity(board):
    tab = await board([])
    sid = "01a162e0-89bf-75d2-93db-abc74e04973f"
    await tab.evaluate("""sid => {
      data.mesh = [{id: 'mesh-clean', kind: 'mesh', name: 'Disque', cwd: '/tmp', cmd: 'codex',
        agent: {type: 'codex', session_id: sid, status: 'idle'}}];
      togglePin('codex', sid, 'Disque');
    }""", sid)
    await tab.route("**/api/organize", lambda route: route.fulfill(json={"sessions": {"mesh-clean": {"label": "Nettoyage"}}}))
    await tab.locator('#list .loose .item[data-id="mesh-clean"] .name').dblclick()
    await tab.locator('#list input.rename').fill("Nettoyage")
    await tab.locator('#list input.rename').press("Enter")
    await tab.wait_for_function("pinnedSessions()[0]?.label === 'Nettoyage'")
    assert await tab.evaluate("pinnedSessions()[0].id") == sid


async def test_pins_are_escaped_and_fit_on_mobile(board):
    tab = await board([], **PHONE)
    sid = "01a162e0-89bf-75d2-93db-abc74e04973f"
    label = "<img src=x onerror=alert(1)>" + " trèslong" * 20
    await tab.evaluate("([sid, label]) => togglePin('codex', sid, label)", [sid, label])
    await tab.locator("#btn-menu").click()
    assert await tab.locator(".pinned-sessions img").count() == 0
    assert await tab.locator(".pinned-sessions .name").inner_text() == label
    assert await tab.locator(".pin-row").evaluate("row => row.scrollWidth <= row.clientWidth")
    await tab.locator(".pin-remove").tap()
    await tab.locator(".pinned-sessions").wait_for(state="detached", timeout=3000)


async def test_storage_failure_is_reported_without_adding_pin(board):
    tab = await board([])
    await tab.evaluate("""() => {
      Storage.prototype.setItem = function() { throw new Error('quota'); };
      togglePin('codex', '01a162e0-89bf-75d2-93db-abc74e04973f', 'Disque');
    }""")
    assert await tab.locator("#flash").inner_text() == ui("pins.storageUnavailable")
    assert await tab.locator(".pinned-sessions").count() == 0


async def test_a_known_non_resumable_agent_has_its_own_launch_badge(board):
    # `external.length >= 0` is true before refresh runs.  Hold that refresh
    # and prove `board()` still waits for its response before injecting Pi.
    gate = FirstReplyGate()
    opening = asyncio.create_task(board([], gate=gate))
    await asyncio.wait_for(gate.reply_started.wait(), timeout=5)
    await asyncio.wait_for(gate.ready_started.wait(), timeout=5)
    gate.ready_release.set()
    try:
        await asyncio.wait_for(asyncio.shield(opening), timeout=1)
    except asyncio.TimeoutError:
        still_opening = True
    else:
        still_opening = False
    gate.reply_release.set()
    await asyncio.wait_for(gate.reply_finished.wait(), timeout=5)
    tab = await asyncio.wait_for(opening, timeout=5)
    assert still_opening
    await tab.evaluate("""() => {
      data.mesh = [{id: "pi", name: "pi", kind: "mesh", cwd: "/tmp/pi", cmd: "pi",
                    known_agent: "pi", agent: null, created: 1, activity: 1, attached: 0, rank: null}];
      renderList();
    }""")
    badge = '#list .item[data-id="pi"] .tag.known-agent'
    assert await tab.inner_text(badge) == "pi"
    assert await tab.get_attribute(badge, "title") == ui("list.knownAgentTitle")


async def test_the_question_mark_shows_the_text_on_a_phone_without_folding(board):
    tab = await board(SPECS, **PHONE)
    await tab.click("#btn-menu")
    await tab.wait_for_timeout(600)
    expected = await tab.get_attribute("#list .status-head.busy", "title")
    await tab.tap("#list .status-head.busy .help")
    await tab.wait_for_function("(t) => document.body.innerText.includes(t)", arg=expected)
    assert await ids(tab, "busy") == ["b-new", "b-old"]        # still open


async def test_an_empty_section_is_not_shown(board):
    tab = await board([("b1", "busy", -5, None), ("w1", "waiting", 0, 10)])
    assert await headings(tab) == [ui("list.status.wait.title"), ui("list.status.busy.title")]
    tab.sessions.specs = [("b1", "busy", -5, None)]
    await tab.evaluate("refresh()")
    await tab.wait_for_function("document.querySelectorAll('#list .status-head').length === 1")
    assert await headings(tab) == [ui("list.status.busy.title")]


async def test_collapsing_a_section_persists_across_a_reload(board):
    tab = await board(SPECS)
    await tab.click("#list .status-head.busy")
    assert await ids(tab, "busy") == []
    assert await tab.is_visible("#list .status-head.busy")             # the heading stays, with its count
    assert await ids(tab, "wait") == ["w-old", "w-new"]                # the others are untouched
    await tab.reload()
    await tab.wait_for_selector("#list .status-head.busy")
    assert await ids(tab, "busy") == []
    assert "st:busy" in await tab.evaluate("JSON.parse(localStorage.getItem('mesh.folded'))")
    await tab.click("#list .status-head.busy")
    assert await ids(tab, "busy") == ["b-new", "b-old"]


async def test_clicking_a_copy_opens_that_session(board):
    tab = await board(SPECS)
    await tab.click('#list .busy-section .item[data-id="b-old"]')
    await tab.wait_for_function("active?.id === 'b-old'")
    # the row in the outside group (not the copy) is the one the menu and focus code use
    assert await tab.evaluate("listItem('b-old').closest('.todo')") is None


async def test_a_copy_has_the_context_menu_and_cannot_be_dragged(board):
    tab = await board([("b-one", "busy", -5, None)])
    row = '#list .busy-section .item[data-id="b-one"]'
    assert await tab.get_attribute(row, "draggable") is None
    await tab.locator(row).scroll_into_view_if_needed()
    await tab.wait_for_timeout(300)
    await tab.click(row, button="right")
    await tab.wait_for_selector('.ctx-menu [role=menuitem]')
    labels = await tab.eval_on_selector_all(".ctx-menu [role=menuitem]", "(e) => e.map((x) => x.textContent.trim())")
    assert labels == [ui("common.open"), ui("menu.openInColumn")]


async def test_the_footer_counts_each_state(board):
    tab = await board(SPECS)
    assert await tab.inner_text("#foot") == " · ".join([ui("list.foot.sessions", n=6), ui("list.foot.active", n=2),
                                                         ui("list.foot.waiting", n=2), ui("list.foot.unread", n=2)])
    tab.sessions.specs = [("b1", "busy", -5, None)]
    await tab.evaluate("refresh()")
    await tab.wait_for_function("(t) => $('#foot').textContent === t",
                                arg=" · ".join([ui("list.foot.sessions", n=1), ui("list.foot.active", n=1)]))


async def test_the_filter_applies_to_the_sections(board):
    tab = await board(SPECS)
    await tab.fill("#filter", "b-new")
    assert await headings(tab) == [ui("list.status.busy.title")]
    assert await ids(tab, "busy") == ["b-new"]
    await tab.fill("#filter", "")
    assert await headings(tab) == [ui("list.status.wait.title"), ui("list.status.unread.title"), ui("list.status.busy.title")]


async def test_a_background_shell_is_its_own_quiet_state_outside_the_sections(board):
    # claude's "shell": the turn is over, a background shell it left still runs
    tab = await board([("s-seen", "shell", -50, None), ("s-new", "shell", 90, None)])
    assert await ids(tab, "unread") == ["s-new"]               # a reply not read here comes first
    assert await headings(tab) == [ui("list.status.unread.title")]      # nothing is asked of the owner
    seen = '#list .item[data-id="s-seen"]'
    assert "shell" in await tab.get_attribute(f"{seen} .dot", "class")
    assert ui("session.state.shell") in await tab.inner_text(f"{seen} .meta")


async def test_silent_mesh_agent_with_verified_cpu_stays_in_actives(board):
    tab = await board([])
    # codex's "idle" only means its rollout was not written lately (a long tool call): CPU decides,
    # and a sustained load (two consecutive 10 s windows at or above 5 % of a core) keeps it active.
    await tab.evaluate("""() => {
      data.mesh = [{id: 'quiet', name: 'quiet', kind: 'mesh', cwd: '/tmp', cmd: 'codex',
        created: 1, activity: 1, attached: 0, rank: null,
        agent: {type: 'codex', status: 'idle', updated: 1}}];
      data.external = [];
      const sample = (now, start) => ({sessions: [{name: 'quiet', created: 1, source: 'mesh',
        lifecycle: 'active', agent_type: 'codex', metrics: {cpu_percent: {
          state: 'derived', source: 'procfs-stat', value: 65, observed_at: now,
          window: {start, end: start + 10}, reason: null}}}]});
      data.management = sample(990, 0);
      activityRanking = MeshSessionActivity.update(null, data.mesh, data.management, 990);
      data.management = sample(1000, 10);
      activityRanking = MeshSessionActivity.update(activityRanking, data.mesh, data.management, 1000);
      renderList();
    }""")
    assert await ids(tab, "busy") == ["quiet"]
    assert ui("session.state.busy") in await tab.inner_text('#list .busy-section .item[data-id="quiet"]')
    await tab.evaluate("""() => {
      data.management.sessions[0].metrics.cpu_percent = {
        state: 'unknown', source: 'procfs-stat', value: null, observed_at: null,
        window: null, reason: 'association-changed'};
      activityRanking = MeshSessionActivity.update(activityRanking, data.mesh, data.management, 1010);
      renderList();
    }""")
    assert await ids(tab, "busy") == ["quiet"]  # prior confirmed work survives one missing sample


@pytest.mark.parametrize("phone", [False, True])
async def test_actives_do_not_move_under_a_list_interaction(board, phone):
    tab = await board([], **(PHONE if phone else {}))
    if phone:
        await tab.click("#btn-menu")
    await tab.evaluate("""() => {
      const row = (id, updated) => ({id, name: id, kind: 'mesh', cwd: '/tmp', cmd: 'codex',
        created: 1, activity: 1, attached: 0, rank: null,
        agent: {type: 'codex', status: 'busy', updated}});
      data.mesh = [row('first', 2), row('second', 1)];
      data.external = [];
      activityRanking = MeshSessionActivity.update(null, data.mesh, null, 1000);
      renderList();
    }""")
    assert await ids(tab, "busy") == ["first", "second"]
    await tab.focus('#list .busy-section .item[data-id="first"]')
    await tab.evaluate("""() => {
      data.mesh.push({id: 'third', name: 'third', kind: 'mesh', cwd: '/tmp', cmd: 'codex',
        created: 1, activity: 1, attached: 0, rank: null,
        agent: {type: 'codex', status: 'busy', updated: 100}});
      activityRanking = MeshSessionActivity.update(activityRanking, data.mesh, null, 1004);
      renderList();
    }""")
    assert await ids(tab, "busy") == ["first", "second"]
    await tab.focus("#filter")
    await tab.wait_for_function("document.querySelectorAll('#list .busy-section .item').length === 3")
    assert await ids(tab, "busy") == ["first", "second", "third"]
    notice = tab.locator("#active-order-status")
    assert await notice.get_attribute("role") == "status"
    assert await notice.get_attribute("aria-live") == "polite"
    assert await notice.get_attribute("hidden") is None
    await tab.wait_for_function("document.querySelector('#active-order-status').textContent.length > 0")
    assert await notice.inner_text() == ui("list.activeOrderUpdated")
    await tab.evaluate("""() => {
      document.querySelector('#list .busy-section .item[data-id="second"]')
        .dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
      data.mesh.push({id: 'fourth', name: 'fourth', kind: 'mesh', cwd: '/tmp', cmd: 'codex',
        created: 1, activity: 1, attached: 0, rank: null,
        agent: {type: 'codex', status: 'busy', updated: 200}});
      activityRanking = MeshSessionActivity.update(activityRanking, data.mesh, null, 1008);
      renderList();
    }""")
    assert await ids(tab, "busy") == ["first", "second", "third"]
    await tab.evaluate("document.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}))")
    await tab.wait_for_function("document.querySelectorAll('#list .busy-section .item').length === 4")
    assert await ids(tab, "busy") == ["first", "second", "third", "fourth"]
