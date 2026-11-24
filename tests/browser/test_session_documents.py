# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A document opened by a mesh session in a real browser, and watched.

Real ptyhost sessions are created through /api/new; the "agent" is the test, which makes the
request mesh-open would make, with the token the session's shell really holds."""

import asyncio
import json
import os
import secrets

import aiohttp
import pytest

import docs
import ptyhost
import server
from conftest import ui
from session_helpers import clean_opens  # noqa: F401
from test_view_compat import goto, open_mesh

pytestmark = pytest.mark.ci_local_only


def shell_token(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read().decode()
    return dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)["MESH_SESSION_TOKEN"]


class Agents:
    """Creates mesh sessions and speaks for them."""

    def __init__(self, mesh, home_dir):
        self.mesh, self.home_dir, self.tokens = mesh, home_dir, {}

    async def start(self, name):
        master = {"Authorization": f"Bearer {server.TOKEN}"}
        async with aiohttp.ClientSession() as http:
            async with http.post(f"{self.mesh.origin}/api/new", headers=master, json={
                    "preset": "shell", "cwd": str(self.home_dir), "name": name}) as resp:
                assert resp.status == 200, await resp.text()
        pid = next(s["pid"] for s in await ptyhost.request({"op": "list"}) if s["name"] == name)
        self.tokens[name] = shell_token(pid)

    async def open(self, name, doc, **flags):
        """What `mesh-open [flags] doc` sends from session ``name``; None as name = master token."""
        auth = (f"MeshSession {self.tokens[name]}" if name else f"Bearer {server.TOKEN}")
        async with aiohttp.ClientSession() as http:
            async with http.post(f"{self.mesh.origin}/api/open", headers={"Authorization": auth},
                                 json={"target": str(doc), **flags}) as resp:
                assert resp.status == 200, await resp.text()


@pytest.fixture
async def agents(mesh, pty, home_dir):
    return Agents(mesh, home_dir)


async def show_layout(page, mesh, ids):
    """The mesh with exactly these panes ("" = an empty pane)."""
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(),
                                     "url": mesh.origin}])
    await goto(page, mesh.origin + "/#" + ",".join(ids))
    await wait_layout(page, ids)


async def layout_of(page):
    return await page.evaluate("panes.map((p) => p.id || '')")


async def wait_layout(page, ids):
    expected = json.dumps(ids, separators=(",", ":"))
    await page.wait_for_function(f"JSON.stringify(panes.map((p) => p.id || '')) === {json.dumps(expected)}",
                                 timeout=10000)


async def refresh(page):
    await page.evaluate("refresh()")


def page_doc(home_dir, name="d", text="v1"):
    return docs.write(home_dir, f"p4b/{name}.html", f"<!doctype html><p id='t'>{text}</p>")


def web_id(doc):
    return f"web:{doc}"


async def show_document(page, mesh, doc):
    """Open one document in the Mesh without needing a terminal session."""
    await open_mesh(page, mesh)
    await page.evaluate("(target) => openWeb(target)", str(doc))
    frame = page.frame_locator("iframe.web:not([hidden])")
    await frame.locator("body").wait_for()
    return frame


async def click_local_html_link(page, selector):
    """Dispatch the local-document click that the history bridge observes.

    Chromium can consume a first physical pointer sequence merely to focus a
    newly inserted opaque iframe, without delivering it to the child document.
    These tests exercise the bridge's document-click protocol, so keep that
    browser focus handoff outside their timing contract.

    The shown iframe's body can still be its initial about:blank document, so the link is
    awaited in that iframe rather than looked up once among the page's frames.
    """
    link = page.frame_locator("iframe.web:not([hidden])").locator(selector)
    await link.evaluate(
        """(link) => link.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}))""")


# ---------------------------------------------------------------- routing

@pytest.mark.ci_browser_smoke
async def test_the_document_goes_into_the_pane_right_of_its_session_when_full(
        page, mesh, agents, home_dir):
    for name in ("sa", "sb", "sc"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa", "sb", "sc"])
    await agents.open("sb", doc)
    await refresh(page)
    await wait_layout(page, ["sa", "sb", web_id(doc)])
    await agents.open("sa", doc)           # a document shown elsewhere is reloaded where it is
    await refresh(page)
    await page.wait_for_timeout(300)
    assert await layout_of(page) == ["sa", "sb", web_id(doc)]


async def test_the_document_takes_the_left_neighbour_at_the_right_edge(page, mesh, agents, home_dir):
    for name in ("sa", "sb", "sc"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa", "sb", "sc"])
    await agents.open("sc", doc)
    await refresh(page)
    await page.wait_for_function("panes.some((p) => p.id?.startsWith('web:'))")
    assert await layout_of(page) == ["sa", web_id(doc), "sc"]


async def test_room_adds_a_column_right_after_the_session(page, mesh, agents, home_dir):
    for name in ("sa", "sb"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa", "sb"])
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc), "sb"])


async def test_a_lone_session_gets_a_column_to_its_right(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])


async def test_a_neighbouring_web_pane_is_reused(page, mesh, agents, home_dir):
    for name in ("sa", "sb"):
        await agents.start(name)
    old, new = page_doc(home_dir, "old"), page_doc(home_dir, "new")
    await show_layout(page, mesh, ["sa", web_id(old), "sb"])
    await agents.open("sb", new)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(new), "sb"])
    await agents.open("sa", page_doc(home_dir, "third"))
    await refresh(page)
    await wait_layout(page, ["sa", web_id(home_dir / "p4b" / "third.html"), "sb"])


async def test_a_page_that_does_not_show_the_session_changes_nothing(page, mesh, agents, home_dir):
    for name in ("sa", "sb"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sb", doc)
    await refresh(page)
    not_shown = ui("open.docNotShown", session="sb").split("{name}")[1]
    await page.wait_for_function("(t) => document.querySelector('#flash').textContent.includes(t)", arg=not_shown)
    assert await layout_of(page) == ["sa"]
    assert "sb" in await page.locator("#flash").text_content()


@pytest.mark.ci_browser_smoke
async def test_a_request_without_a_session_keeps_the_old_placement(page, mesh, agents, home_dir):
    for name in ("sa", "sb"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa", "sb"])
    await agents.open(None, doc)
    await refresh(page)
    await wait_layout(page, ["sa", "sb", web_id(doc)])


@pytest.mark.ci_browser_smoke
async def test_a_body_supplied_session_does_not_route_a_master_request(page, mesh, agents, home_dir):
    for name in ("sa", "sb"):
        await agents.start(name)
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa", "sb"])
    await agents.open(None, doc, session="sa")
    await refresh(page)
    await wait_layout(page, ["sa", "sb", web_id(doc)])    # not next to sa


async def test_opening_the_same_document_again_reloads_it(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    loads = []
    page.on("request", lambda r: "/view/" in r.url and loads.append(r.url))
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await page.wait_for_function("document.querySelector('iframe.web:not([hidden])').src")
    await page.wait_for_timeout(500)
    first = len(loads)
    assert first >= 1
    await agents.open("sa", doc, reload=True)    # within the same second: the same signed URL
    await refresh(page)
    for _ in range(50):
        if len(loads) > first:
            break
        await page.wait_for_timeout(100)
    assert len(loads) > first


# ---------------------------------------------------------------- document history

async def test_markdown_navigation_has_a_visible_previous_mesh_view(page, mesh, home_dir):
    first = docs.write(home_dir, "p4b/history/first.md", "# first\n\n[next](second.md)\n")
    docs.write(home_dir, "p4b/history/second.md", "# second\n")
    frame = await show_document(page, mesh, first)
    await frame.locator("#doc", has_text="first").wait_for()

    await frame.locator("#doc a", has_text="next").click()
    await frame.locator("#doc", has_text="second").wait_for()

    back = page.locator('section.pane [data-act="back"]:not([hidden])')
    await back.wait_for()
    assert await back.get_attribute("aria-label") == ui("pane.back.to", name="first.md")
    await back.click()
    await frame.locator("#doc", has_text="first").wait_for()


@pytest.mark.ci_browser_smoke
async def test_nested_local_html_links_return_one_page_at_a_time(page, mesh, home_dir):
    first = docs.write(home_dir, "p4b/history/first.html", "<!doctype html><a id='second' href='second.html'>second</a>")
    docs.write(home_dir, "p4b/history/second.html", "<!doctype html><p id='second-page'>second</p><a id='third' href='third.html'>third</a>")
    docs.write(home_dir, "p4b/history/third.html", "<!doctype html><p id='third-page'>third</p>")
    frame = await show_document(page, mesh, first)
    # Do not wait after body: readiness/ACK must make this immediate click
    # durable even while the outer iframe's first load is still pending.
    await click_local_html_link(page, "#second")
    await frame.locator("#second-page").wait_for()

    back = page.locator('section.pane [data-act="back"]:not([hidden])')
    await back.wait_for()
    assert await back.get_attribute("aria-label") == ui("pane.back.previousTitle")
    await click_local_html_link(page, "#third")
    await frame.locator("#third-page").wait_for()

    await back.click()
    await frame.locator("#second-page").wait_for()
    await back.click()
    await frame.locator("#second").wait_for()
    assert await back.count() == 0


async def test_local_html_click_retries_ready_until_the_parent_acknowledges(page, mesh, home_dir):
    # Drop the bridge's initial and pageshow announcements. The old bridge
    # emitted exactly those two messages, so an immediate click stayed pending
    # forever. The retry is event-driven here: no sleep makes the test pass.
    first = docs.write(home_dir, "p4b/history/retry-ready/first.html", "<!doctype html><a id='second' href='second.html'>second</a>")
    docs.write(home_dir, "p4b/history/retry-ready/second.html", "<!doctype html><p id='second-page'>second</p>")
    await open_mesh(page, mesh)
    await page.evaluate("""() => {
      const prototype = Object.getPrototypeOf(panes[0]);
      const original = prototype.acceptFrameReady;
      let dropped = 0;
      const restore = () => {
        prototype.acceptFrameReady = original;
        delete window.__restoreFrameReadyTest;
      };
      window.__restoreFrameReadyTest = restore;
      prototype.acceptFrameReady = function(href) {
        if (dropped++ < 2) return;
        restore();
        return original.call(this, href);
      };
    }""")
    try:
        await page.evaluate("(target) => openWeb(target)", str(first))
        frame = page.frame_locator("iframe.web:not([hidden])")
        await frame.locator("body").wait_for()
        await click_local_html_link(page, "#second")
        await frame.locator("#second-page").wait_for()
    finally:
        await page.evaluate("window.__restoreFrameReadyTest?.()")


async def test_early_html_click_waits_for_the_initial_frame_load(page, mesh, home_dir):
    # Hold a same-origin image so the link is clickable before the iframe emits
    # its first load. A bridge click in that interval must still receive Previous.
    requested, release = asyncio.Event(), asyncio.Event()

    async def hold_asset(route):
        requested.set()
        await release.wait()
        await route.continue_()

    await page.route("**/slow.png*", hold_asset)
    first = docs.write(home_dir, "p4b/history/early/first.html",
                       "<!doctype html><a id='second' href='second.html'>second</a><img src='slow.png'>")
    docs.write(home_dir, "p4b/history/early/second.html", "<!doctype html><p id='second-page'>second</p>")
    docs.write(home_dir, "p4b/history/early/slow.png", docs.png())
    try:
        frame = await show_document(page, mesh, first)
        await requested.wait()
        assert await page.evaluate(
            "panes.find((pane) => pane.id?.startsWith('web:')).frameLoadSerial") == 0

        await click_local_html_link(page, "#second")
        release.set()
        await frame.locator("#second-page").wait_for()
    finally:
        release.set()
        await page.unroute("**/slow.png*", hold_asset)

    back = page.locator('section.pane [data-act="back"]:not([hidden])')
    await back.wait_for()
    await back.click()
    await frame.locator("#second").wait_for()


@pytest.mark.ci_browser_smoke
async def test_html_history_bridge_precedes_author_script(page, mesh, home_dir):
    # The framed response must install its own listeners before an author
    # script can replace `addEventListener`. Otherwise a link early in a
    # document can navigate natively before the Mesh has observed it, leaving
    # no reliable Previous action. This has no timing sleeps or retry loop:
    # the source itself makes a late bridge fail deterministically.
    first = docs.write(home_dir, "p4b/history/listener/first.html", """<!doctype html>
      <script>window.addEventListener = () => { throw new Error('bridge was late'); };</script>
      <a id='second' href='second.html'>second</a>""")
    docs.write(home_dir, "p4b/history/listener/second.html", "<!doctype html><p id='second-page'>second</p>")
    frame = await show_document(page, mesh, first)
    await click_local_html_link(page, "#second")
    await frame.locator("#second-page").wait_for()
    back = page.locator('section.pane [data-act="back"]:not([hidden])')
    await back.wait_for()
    await back.click()
    await frame.locator("#second").wait_for()


async def test_html_history_bridge_preserves_quoted_prologue_attributes(page, mesh, home_dir):
    # A `>` is valid inside an attribute value. The bridge must follow the
    # actual html/head start tags, rather than splitting either one at that
    # character. Checking the parsed values also proves Chromium received a
    # real bridge script rather than source text embedded in an attribute.
    first = docs.write(home_dir, "p4b/history/quoted-prologue/first.html", """<!-- provenance --><!doctype html>
      <html data-note="a>b"><head data-head='c>d'>
      <script>document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('#attributes').textContent =
          document.documentElement.dataset.note + '|' + document.head.dataset.head + '|' + document.compatMode;
      });</script></head><body>
      <p id="attributes"></p></body></html>""")
    frame = await show_document(page, mesh, first)
    await frame.locator("#attributes").wait_for()
    assert await frame.locator("#attributes").text_content() == "a>b|c>d|CSS1Compat"


async def test_utf16_html_document_remains_readable_without_history_bridge(page, mesh, home_dir):
    # The bridge is UTF-8 bytes. Its old placement before this BOM caused
    # Chromium to decode the entire document incorrectly. UTF-16 documents
    # deliberately lose the optional bridge rather than their contents.
    source = "<!doctype html><html><body><p id='encoded'>UTF-16 intact</p></body></html>"
    first = docs.write(home_dir, "p4b/history/utf16/first.html", b"\xff\xfe" + source.encode("utf-16-le"))
    frame = await show_document(page, mesh, first)
    assert await frame.locator("#encoded").text_content() == "UTF-16 intact"


@pytest.mark.ci_browser_smoke
async def test_external_html_navigation_never_enters_mesh_history(page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/history/local.html",
                     "<!doctype html><a id='external' href='https://example.invalid/leave'>leave</a>")
    frame = await show_document(page, mesh, doc)
    await frame.locator("#external").click()
    await page.wait_for_timeout(100)

    assert await page.locator('section.pane [data-act="back"]:not([hidden])').count() == 0


@pytest.mark.ci_browser_smoke
async def test_html_cannot_create_previous_without_an_observed_child_load(page, mesh, home_dir):
    # The raw document can send arbitrary postMessages, so the Mesh must still
    # require the child-frame load that follows its validated local-link intent.
    script = """<script>
      setTimeout(() => {
        const token = new URLSearchParams(location.search).get('dt');
        const target = new URL('second.html', location.href);
        target.searchParams.set('dt', token);
        parent.postMessage({smesh: 'frame-history-push', token, url: target.href, navigation: 'fake'}, '*');
        parent.postMessage({smesh: 'frame-history-ready', token, url: target.href}, '*');
      }, 100);
    </script><p id='ready'>ready</p>"""
    doc = docs.write(home_dir, "p4b/history/unloaded.html", script)
    frame = await show_document(page, mesh, doc)
    await frame.locator("#ready").wait_for()
    await page.wait_for_timeout(250)

    assert await page.locator('section.pane [data-act="back"]:not([hidden])').count() == 0


# ---------------------------------------------------------------- watch

def frame_text(page):
    return page.frame_locator("iframe.web:not([hidden])").locator("#t")


def rewrite(doc, text, ns):
    doc.write_text(f"<!doctype html><p id='t'>{text}</p>")
    os.utime(doc, ns=(ns, ns))


@pytest.mark.ci_browser_smoke
async def test_a_watched_document_reloads_when_the_file_changes(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc, watch=True)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await frame_text(page).wait_for()
    assert await frame_text(page).text_content() == "v1"
    rewrite(doc, "v2", 1_900_000_000_000_000_000)
    await refresh(page)
    await page.wait_for_function(
        "document.querySelector('iframe.web:not([hidden])').contentWindow !== null")
    await frame_text(page).filter(has_text="v2").wait_for()


async def test_an_unwatched_document_is_left_alone(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await frame_text(page).wait_for()
    rewrite(doc, "v2", 1_900_000_000_000_000_000)
    await refresh(page)
    await page.wait_for_timeout(800)
    assert await frame_text(page).text_content() == "v1"


@pytest.mark.parametrize("stat_latency", [0, 0.5])
async def test_polling_asks_for_the_mtime_not_for_a_new_url(page, mesh, agents, home_dir, stat_latency):
    if stat_latency:
        async def delayed_stat(route):
            # Deliberate network fixture: expose coalescing on a slow stat,
            # while the assertions below synchronize on completion, not time.
            await asyncio.sleep(stat_latency)
            await route.continue_()
        await page.route("**/api/stat", delayed_stat)
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc, watch=True)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await frame_text(page).wait_for()
    # refresh deliberately starts polling without awaiting network completion.
    # Finish its baseline before counting successive (not overlapping) polls.
    await page.wait_for_function("polling === false")
    calls = []
    page.on("request", lambda r: r.method == "POST" and calls.append(r.url.rsplit("/", 1)[-1]))
    for _ in range(3):
        await refresh(page)
        await page.wait_for_function("polling === false")
    assert calls.count("stat") == 3 and "view" not in calls


@pytest.mark.ci_browser_smoke
async def test_a_deleted_then_recreated_file_reloads_once_it_is_back(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc, watch=True)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await frame_text(page).wait_for()
    doc.unlink()
    await refresh(page)
    await page.wait_for_timeout(300)
    assert await layout_of(page) == ["sa", web_id(doc)]     # nothing torn down
    rewrite(doc, "v3", 1_900_000_000_000_000_000)
    await refresh(page)
    await frame_text(page).filter(has_text="v3").wait_for()


async def test_closing_a_watched_pane_stops_the_polling(page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = page_doc(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc, watch=True)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await page.evaluate("closePane(panes[1])")
    calls = []
    page.on("request", lambda r: calls.append(r.url.rsplit("/", 1)[-1]))
    await refresh(page)
    await page.wait_for_timeout(300)
    assert "stat" not in calls


# ---------------------------------------------------------------- scroll position of Markdown

LONG_MD = "# Long\n\n" + "\n\n".join(f"paragraph {n}" for n in range(200)) + "\n"
PANE_FRAME = "iframe.web:not([hidden])"


def long_markdown(home_dir):
    return docs.write(home_dir, "p4b/long.md", LONG_MD)


async def scroll_y(page):
    return await page.frame_locator(PANE_FRAME).locator("#doc").evaluate("() => window.scrollY")


async def test_a_watched_markdown_page_keeps_its_scroll_position_across_a_reload(
        page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = long_markdown(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc, watch=True)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    body = page.frame_locator(PANE_FRAME).locator("#doc")
    await body.filter(has_text="paragraph 199").wait_for()
    await body.evaluate("() => window.scrollTo(0, 900)")
    await page.wait_for_function("(id) => webs.get(id).scrollY >= 800", arg=web_id(doc))
    doc.write_text(LONG_MD + "\nappended after the reload\n")
    os.utime(doc, ns=(1_900_000_000_000_000_000,) * 2)
    await refresh(page)
    await body.filter(has_text="appended after the reload").wait_for()
    for _ in range(50):
        if await scroll_y(page) >= 800:
            break
        await page.wait_for_timeout(100)
    assert await scroll_y(page) >= 800


@pytest.mark.ci_browser_smoke
async def test_scroll_reports_from_anything_but_a_markdown_pane_are_ignored(
        page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = docs.write(home_dir, "p4b/spoof.html",
                     "<!doctype html><p id='t'>x</p><script>parent.postMessage("
                     "{smesh: 'scroll', y: 777}, '*')</script>")
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await page.frame_locator(PANE_FRAME).locator("#t").wait_for()
    await page.wait_for_timeout(300)
    assert await page.evaluate("(id) => webs.get(id).scrollY", web_id(doc)) is None


@pytest.mark.ci_browser_smoke
async def test_a_scroll_report_not_sent_by_the_pane_frame_is_ignored(
        page, mesh, agents, home_dir):
    await agents.start("sa")
    doc = long_markdown(home_dir)
    await show_layout(page, mesh, ["sa"])
    await agents.open("sa", doc)
    await refresh(page)
    await wait_layout(page, ["sa", web_id(doc)])
    await page.frame_locator(PANE_FRAME).locator("#doc").filter(has_text="paragraph 199").wait_for()
    await page.evaluate("window.postMessage({smesh: 'scroll', y: 5000}, '*')")
    await page.wait_for_timeout(300)
    assert await page.evaluate("(id) => webs.get(id).scrollY", web_id(doc)) is None


# ---------------------------------------------------------------- a document shows a conversation

SID = "01900000-0000-0000-0000-000000000789"
OTHER_SID = "01900000-0000-0000-0000-000000000790"
HID = f"h:claude:{SID}"
# a local page that posts window.MSGS (built in the frame, see post_on_click) on a click
# on #go, shows whether the mesh answered it with caps, and posts a valid request when
# its parent sends "post-now" (a message, not a gesture)
ASKING_PAGE = f"""<!doctype html><button id='go'>go</button><p id='caps'></p><script>
  window.clicks = 0;
  addEventListener('message', (e) => {{
    if (e.source !== parent) return;
    if (e.data?.smesh === 'caps') document.getElementById('caps').textContent = 'caps';
    if (e.data !== 'post-now') return;
    const t = new URLSearchParams(location.search).get('dt');
    parent.postMessage({{smesh: 'goto-session', agent: 'claude', id: '{SID}', token: t}}, '*');
    parent.postMessage({{smesh: 'hello', token: t}}, '*');
  }});
  document.getElementById('go').addEventListener('click', () => {{
    window.clicks++;
    for (const m of window.MSGS || []) parent.postMessage(m, '*');
  }});
</script>"""
# the mesh window's view of the next goto-session it receives: the activation and the
# frame's focus at that moment
RECORD_GOTO = """(selector) => {
  window.seenGoto = null;
  addEventListener("message", (e) => {
    if (e.data?.smesh === "goto-session" && window.seenGoto === null)
      window.seenGoto = {active: navigator.userActivation.isActive,
                         focused: document.activeElement === document.querySelector(selector)};
  });
}"""


async def view_frame(page, timeout=5.0):
    """The shown pane's frame once it holds its /view/ document. The page can report a
    re-created frame as loaded before Playwright's frame list carries its URL: wait for it."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        handle = await page.locator(PANE_FRAME).element_handle()
        frame = await handle.content_frame()
        if frame is not None and "/view/" in frame.url:
            return frame
        assert asyncio.get_running_loop().time() < deadline, f"no /view/ document in {PANE_FRAME}"
        await asyncio.sleep(0.05)


def transcript(sid):
    return {"agent": "claude", "id": sid, "name": f"Conversation {sid[-3:]}", "cwd": "/tmp",
            "n_user": 1, "n_assistant": 1, "updated": 100, "started": 90,
            "tin": 0, "tout": 0, "tcr": 0, "tcw": 0}


async def show_asking_document(page, mesh, doc, **opts):
    """The mesh showing ``doc``, with conversation cards served and every card fetch recorded."""
    fetched = []
    async def detail(route):
        fetched.append(route.request.url)
        await route.fulfill(json=transcript(route.request.url.rsplit("/", 1)[-1]))
    await page.route("**/api/history/claude/*", detail)
    if not opts.pop("keep_mesh", False):
        await open_mesh(page, mesh)
    await page.evaluate("([t, o]) => openWeb(t, undefined, o)", [str(doc), opts])
    await page.frame_locator(PANE_FRAME).locator("body").wait_for()
    pane = web_id(doc) + ("#source" if opts.get("source") else "")
    await page.wait_for_function("(id) => panes.some((p) => p.id === id && p.identityLoad === 'frame-loaded')",
                                 arg=pane)
    if doc.suffix == ".html" and not opts.get("source"):
        # settled: a page still loading (Playwright attaching to it) counts as a gesture,
        # and what the test set in it would be lost
        await page.wait_for_function("(id) => panes.some((p) => p.id === id && p.frameInitialReady)",
                                     arg=pane)
    return fetched


async def mesh_state(page):
    return await page.evaluate(
        "({ids: panes.map((p) => p.id || ''), active: panes.indexOf(active)})")


async def focus_frame(page):
    # The mesh honours a request only while the frame holds the focus. A click in it gives
    # it; focusing first states that precondition, so one click (no retry) is the gesture
    await page.locator(PANE_FRAME).focus()
    assert await page.evaluate("(s) => document.activeElement === document.querySelector(s)", PANE_FRAME)


async def click_session_link(page, text, expect=HID):
    await focus_frame(page)
    await page.frame_locator(PANE_FRAME).get_by_role("link", name=text).click()
    await page.wait_for_function("(id) => active?.id === id", arg=expect, timeout=5000)


async def post_on_click(page, messages):
    """One click on #go in the pane's frame (a real user gesture) so that it posts ``messages``,
    a JS expression over the frame's load token ``t``."""
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    frame = await view_frame(page)
    nonce = secrets.token_hex(16)
    await page.evaluate("""([selector, nonce]) => {
      const source = document.querySelector(selector)?.contentWindow;
      if (!source) throw new Error('document frame unavailable before click');
      const witness = {nonce, acknowledged: false, source};
      witness.listener = (event) => {
        if (event.source === source && event.data?.testClickAck === nonce) {
          witness.acknowledged = true;
          witness.clicks = event.data.clicks;
        }
      };
      window.testClickWitness = witness;
      addEventListener('message', witness.listener);
    }""", [PANE_FRAME, nonce])
    try:
        await frame.evaluate(f"""() => {{
          const t = new URLSearchParams(location.search).get('dt');
          window.MSGS = {messages};
          window.clicks = 0;
          document.testClickNonce = {json.dumps(nonce)};
          document.querySelector('#go').addEventListener('click', () => {{
            parent.postMessage({{testClickAck: document.testClickNonce, clicks: window.clicks}}, '*');
          }}, {{once: true}});
        }}""")
        await focus_frame(page)
        # Synchronize the opaque child's painted surface before physical input.
        await frame.locator("#go").screenshot()
        await frame.locator("#go").click()
        try:
            await page.wait_for_function("(nonce) => window.testClickWitness?.nonce === nonce && "
                                         "window.testClickWitness.acknowledged", arg=nonce, timeout=5000)
            assert await page.evaluate("window.testClickWitness.clicks") == 1
        except PlaywrightTimeoutError as exc:
            try:
                same = not frame.is_detached() and await frame.evaluate(
                    "(nonce) => document.testClickNonce === nonce", nonce)
            except Exception:  # execution context was destroyed during replacement
                same = False
            reason = "same document" if same else "document replaced or detached"
            raise AssertionError(f"click not acknowledged by the prepared document ({reason})") from exc
    finally:
        await page.evaluate("""(nonce) => {
          const witness = window.testClickWitness;
          if (witness?.nonce === nonce) {
            removeEventListener('message', witness.listener);
            delete window.testClickWitness;
          }
        }""", nonce)


async def assert_nothing_shown(page, before, fetched):
    await page.wait_for_timeout(500)
    assert await mesh_state(page) == before
    assert fetched == []
    assert HID not in await page.evaluate("panes.map((p) => p.id)")


@pytest.mark.ci_browser_smoke
async def test_a_markdown_session_link_shows_the_conversation_in_a_new_column_beside_the_document(
        page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/links.md", f"# Links\n\n[the conversation](#{HID})\n")
    fetched = await show_asking_document(page, mesh, doc)
    before = await page.evaluate("[panes.length, workspaceGroups.length]")
    await click_session_link(page, "the conversation")
    assert await page.evaluate("[panes.length, workspaceGroups.length]") == [before[0] + 1, before[1] + 1]
    # the document stays, in its own column, shown, and the conversation is in the column right of it
    assert await page.evaluate("""([doc, hid]) => {
      const d = panes.find((p) => p.id === doc), h = panes.find((p) => p.id === hid);
      const at = (p) => workspaceGroups.indexOf(p.group);
      return d.group !== h.group && at(h) === at(d) + 1 && d.group.selected === d && !d.el.closest("[hidden]")
        && d.el.getBoundingClientRect().width > 0;
    }""", [web_id(doc), HID])
    await page.locator(".card.hist").get_by_text(f"Conversation {SID[-3:]}").wait_for()
    assert len(fetched) == 1
    # the document is still readable once its frame has reloaded
    await page.frame_locator(PANE_FRAME).locator("#doc").get_by_role("link", name="the conversation").wait_for()


@pytest.mark.parametrize("hidden_sibling", [False, True], ids=["single-tab", "hidden-sibling-tab"])
@pytest.mark.ci_browser_smoke
async def test_at_the_column_cap_the_conversation_replaces_the_other_pane_not_the_document(
        page, mesh, home_dir, hidden_sibling):
    doc = docs.write(home_dir, "p4b/goto/cap.html", ASKING_PAGE)
    await show_asking_document(page, mesh, doc)
    await page.evaluate("while (workspaceGroups.length < MAX_PANES) addPane()")   # the cap
    # the first other pane was active more recently than the second
    await page.evaluate("""(id) => {
      const others = panes.filter((p) => p.id !== id);
      window.first = others[0]; window.second = others[1];
      setActive(window.second); setActive(window.first);
      const d = panes.find((p) => p.id === id); d.group.select(d); setActive(d); }""", web_id(doc))
    if hidden_sibling:
        # A more recently active hidden tab of the asking group must not win
        # over a different column: selecting it would hide the document.
        await page.evaluate("""(id) => {
          const d = panes.find((p) => p.id === id);
          window.sibling = addTab(d.group, null);
          setActive(window.sibling);
          d.group.select(d); setActive(d);
        }""", web_id(doc))
    assert await page.evaluate("[workspaceGroups.length, MAX_PANES]") == [3, 3]
    await page.wait_for_function("(id) => panes.some((p) => p.id === id && p.identityLoad === 'frame-loaded')",
                                 arg=web_id(doc))
    await page.wait_for_function("(id) => panes.some((p) => p.id === id && p.frameInitialReady)", arg=web_id(doc))
    if hidden_sibling:
        # Layout-only regression: dispatch one DOM click with explicit browser
        # activation and iframe focus. This is not physical-gesture evidence;
        # the existing security cases retain their physical-click helper.
        await focus_frame(page)
        await (await view_frame(page)).evaluate("""() => {
          if (!navigator.userActivation.isActive) throw new Error('browser activation required');
          const token = new URLSearchParams(location.search).get('dt');
          window.MSGS = [{smesh: 'goto-session', agent: 'claude', id: '%s', token}];
          document.querySelector('#go').click();
        }""" % SID)
    else:
        await post_on_click(page, f"[{{smesh: 'goto-session', {GOTO}, token: t}}]")
    await page.wait_for_function("(id) => active?.id === id", arg=HID, timeout=5000)
    assert await page.evaluate("[panes.length, workspaceGroups.length]") == [3 + int(hidden_sibling), 3]
    if hidden_sibling:
        assert await page.evaluate("window.sibling.id !== active.id && window.sibling.group.selected !== window.sibling")
    # the most recently active other pane (first) shows it; the document is still there, selected
    assert await page.evaluate("active === window.first") is True
    assert await page.evaluate("""(id) => { const d = panes.find((p) => p.id === id);
      return !!d && d.group.selected === d && window.second.id !== '%s'; }""" % HID, web_id(doc))
    await page.locator(".card.hist").get_by_text(f"Conversation {SID[-3:]}").wait_for()


@pytest.mark.ci_browser_smoke
async def test_in_a_one_pane_layout_with_another_pane_the_conversation_replaces_it(page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/narrow.html", ASKING_PAGE)
    await show_asking_document(page, mesh, doc)
    await page.evaluate("addPane()")
    await page.evaluate("""(id) => { window.other = active; const d = panes.find((p) => p.id === id);
      d.group.select(d); setActive(d); }""", web_id(doc))
    await page.set_viewport_size({"width": 600, "height": 800})
    assert await page.evaluate("narrow()") is True
    await page.wait_for_function("(id) => panes.some((p) => p.id === id && p.frameInitialReady)", arg=web_id(doc))
    before = await page.evaluate("[panes.length, workspaceGroups.length]")
    await post_on_click(page, f"[{{smesh: 'goto-session', {GOTO}, token: t}}]")
    await page.wait_for_function("(id) => active?.id === id", arg=HID, timeout=5000)
    assert await page.evaluate("[panes.length, workspaceGroups.length]") == before
    assert await page.evaluate("active === window.other") is True
    assert await page.evaluate("(id) => panes.some((p) => p.id === id)", web_id(doc))


@pytest.mark.ci_browser_smoke
async def test_in_a_one_pane_layout_with_no_other_pane_a_new_tab_of_the_document_column_is_used(
        page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/lone.html", ASKING_PAGE)
    await page.set_viewport_size({"width": 600, "height": 800})
    await show_asking_document(page, mesh, doc)
    assert await page.evaluate("[narrow(), panes.length]") == [True, 1]
    await post_on_click(page, f"[{{smesh: 'goto-session', {GOTO}, token: t}}]")
    await page.wait_for_function("(id) => active?.id === id", arg=HID, timeout=5000)
    assert await page.evaluate("[panes.length, workspaceGroups.length]") == [2, 1]
    assert await page.evaluate("(id) => panes.some((p) => p.id === id)", web_id(doc))


@pytest.mark.ci_browser_smoke
async def test_a_session_link_to_a_shown_conversation_focuses_its_pane(page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/again.md", f"[again](#{HID})\n")
    await show_asking_document(page, mesh, doc)
    await click_session_link(page, "again")
    count = await page.evaluate("panes.length")
    # back to the document's tab after the gap, the same link again: no new tab, the card's pane is active
    await page.evaluate("(id) => { const d = panes.find((p) => p.id === id); d.group.select(d); setActive(d); }",
                        web_id(doc))
    await page.wait_for_timeout(1100)   # past GOTO_GAP_MS
    await page.frame_locator(PANE_FRAME).locator("#doc").get_by_role("link", name="again").wait_for()
    await click_session_link(page, "again")
    assert await page.evaluate("panes.length") == count
    assert await page.evaluate("(id) => panes.filter((p) => p.id === id).length", HID) == 1


@pytest.mark.ci_browser_smoke
async def test_a_local_html_page_learns_it_may_ask_and_shows_a_conversation_on_a_click(
        page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/ask.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    before = await page.evaluate("panes.length")
    await post_on_click(page, "[{smesh: 'hello', token: t}]")
    await page.frame_locator(PANE_FRAME).locator("#caps").filter(has_text="caps").wait_for(timeout=5000)
    assert await page.evaluate("panes.length") == before   # hello only answers
    await post_on_click(page, f"[{{smesh: 'goto-session', agent: 'claude', id: '{SID}', token: t}}]")
    await page.wait_for_function("(id) => active?.id === id", arg=HID, timeout=5000)
    assert await page.evaluate("panes.length") == before + 1
    assert await page.evaluate("(id) => panes.some((p) => p.id === id)", web_id(doc))
    await page.locator(".card.hist").get_by_text(f"Conversation {SID[-3:]}").wait_for()
    assert len(fetched) == 1


GOTO = f"agent: 'claude', id: '{SID}'"


@pytest.mark.parametrize("messages", [
    pytest.param(f"[{{smesh: 'hello', token: 'x' + t}}, {{smesh: 'goto-session', {GOTO}, token: 'x' + t}}]",
                 id="wrong-token"),
    pytest.param(f"[{{smesh: 'hello'}}, {{smesh: 'goto-session', {GOTO}}}]", id="missing-token"),
    pytest.param(f"[{{smesh: 'hello', token: t, extra: 1}},"
                 f" {{smesh: 'goto-session', {GOTO}, token: t, extra: 1}}]", id="extra-key"),
    pytest.param(f"[{{smesh: 'goto-session', agent: 'gemini', id: '{SID}', token: t}}]", id="bad-agent"),
    pytest.param("[{smesh: 'goto-session', agent: 'claude', id: '../short', token: t}]", id="bad-id"),
])
@pytest.mark.ci_browser_smoke
async def test_a_malformed_session_request_is_ignored(page, mesh, home_dir, messages):
    doc = docs.write(home_dir, "p4b/goto/bad.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    before = await mesh_state(page)
    await post_on_click(page, messages)
    await assert_nothing_shown(page, before, fetched)
    assert await page.frame_locator(PANE_FRAME).locator("#caps").text_content() == ""


@pytest.mark.ci_browser_smoke
async def test_a_session_request_without_a_user_gesture_is_ignored(page, mesh, home_dir):
    # the same page answers hello (its token is good) but its unclicked request shows nothing
    doc = docs.write(home_dir, "p4b/goto/onload.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    before = await mesh_state(page)
    await page.evaluate(RECORD_GOTO, PANE_FRAME)
    # Playwright evaluates as a user gesture: spend that activation first (a popup consumes
    # it for the whole frame tree), then have the page post, from a message, not a click;
    # the page is asked again until its messages arrive
    await page.evaluate("""async (selector) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 60 && navigator.userActivation.isActive; i++) {
        window.open("about:blank")?.close();
        if (navigator.userActivation.isActive) await sleep(100);
      }
      for (let i = 0; i < 30 && window.seenGoto === null; i++) {
        document.querySelector(selector).contentWindow.postMessage("post-now", "*");
        await sleep(100);
      }
    }""", PANE_FRAME)
    assert (await page.evaluate("window.seenGoto"))["active"] is False
    await page.frame_locator(PANE_FRAME).locator("#caps").filter(has_text="caps").wait_for(
        state="attached", timeout=5000)
    await assert_nothing_shown(page, before, fetched)


@pytest.mark.ci_browser_smoke
async def test_a_gesture_elsewhere_in_the_mesh_does_not_let_a_document_ask(page, mesh, home_dir):
    # a person clicks the mesh outside the document (its own tab button): the activation is
    # mesh-wide, but the frame does not hold the focus, so its request is ignored
    doc = docs.write(home_dir, "p4b/goto/elsewhere.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    await page.evaluate(RECORD_GOTO, PANE_FRAME)
    await page.locator('[role="tab"]', has_text=ui("pane.tabLabel", kind=ui("pane.kind.document"), name="elsewhere.html")).click()
    before = await mesh_state(page)
    # the document posts at once, while that click's activation lasts
    await page.evaluate("""async (selector) => {
      for (let i = 0; i < 30 && window.seenGoto === null; i++) {
        document.querySelector(selector).contentWindow.postMessage("post-now", "*");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }""", PANE_FRAME)
    assert await page.evaluate("window.seenGoto") == {"active": True, "focused": False}
    await assert_nothing_shown(page, before, fetched)


@pytest.mark.parametrize("shown", [False, True], ids=["new-column", "already-shown"])
@pytest.mark.ci_browser_smoke
async def test_session_requests_within_one_second_are_throttled(page, mesh, home_dir, shown):
    # Two ids posted from one click. When the first opens a new column, the document loses the
    # focus; when it is already shown in another column, the document keeps the focus and
    # only the per-pane gap refuses the second.
    doc = docs.write(home_dir, "p4b/goto/twice.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    if shown:
        loads = await page.evaluate("(id) => panes.find((p) => p.id === id).frameLoadSerial", web_id(doc))
        await page.evaluate("(id) => addPane(id)", HID)
        await page.locator(".card.hist").get_by_text(f"Conversation {SID[-3:]}").wait_for()
        # The new column lays the columns out again, which re-inserts the document's frame:
        # it reloads. Clicking before that load ends clicks a page about to be replaced.
        await page.wait_for_function("([id, n]) => panes.find((p) => p.id === id).frameLoadSerial > n",
                                     arg=[web_id(doc), loads], timeout=5000)
        await page.evaluate("(id) => setActive(panes.find((p) => p.id === id))", web_id(doc))
        fetched.clear()
    before = await page.evaluate("panes.length")
    await post_on_click(page, f"[{{smesh: 'goto-session', {GOTO}, token: t}},"
                              f" {{smesh: 'goto-session', agent: 'claude', id: '{OTHER_SID}', token: t}}]")
    await page.wait_for_function("(id) => active?.id === id", arg=HID, timeout=5000)
    await page.wait_for_timeout(500)
    assert await page.evaluate("panes.length") == before + (0 if shown else 1)
    assert await page.evaluate("(id) => panes.filter((p) => p.id === id).length", HID) == 1
    assert not await page.evaluate("(id) => panes.some((p) => p.id === id)", f"h:claude:{OTHER_SID}")
    assert [url.rsplit("/", 1)[-1] for url in fetched] == ([] if shown else [SID])


@pytest.mark.ci_browser_smoke
async def test_a_conversation_running_in_the_mesh_is_shown_without_taking_the_keyboard(
        page, mesh, agents, home_dir, monkeypatch):
    # a mesh shell playing the claude conversation SID: its terminal is shown, not typed into
    await agents.start("sa")
    async def sessions(route):
        response = await route.fetch()
        body = await response.json()
        for s in body["mesh"]:
            if s.get("name") == "sa":
                s["agent"] = {**(s.get("agent") or {}), "type": "claude", "session_id": SID}
        await route.fulfill(response=response, json=body)
    await page.route("**/api/sessions", sessions)
    doc = docs.write(home_dir, "p4b/goto/live.md", f"[live](#{HID})\n")
    await show_layout(page, mesh, [""])
    await page.wait_for_function("(sid) => liveOf(sid, 'claude')?.id === 'sa'", arg=SID)
    fetched = await show_asking_document(page, mesh, doc, keep_mesh=True)
    await click_session_link(page, "live", expect="sa")
    # the terminal attaches and draws, yet the keyboard stays out of it
    await page.wait_for_function("active?.conn && !active.conn.initializing && !active.termEl.hidden",
                                 timeout=5000)
    await page.wait_for_timeout(500)
    assert not await page.evaluate("active.el.contains(document.activeElement)")
    assert fetched == []


@pytest.mark.parametrize("name, opts", [("plain.txt", {}), ("viewed.html", {"source": True})],
                         ids=["text", "html-source-view"])
@pytest.mark.ci_browser_smoke
async def test_a_pane_that_did_not_opt_in_cannot_ask(page, mesh, home_dir, name, opts):
    doc = docs.write(home_dir, f"p4b/goto/{name}", "<!doctype html><p>plain</p>\n")
    fetched = await show_asking_document(page, mesh, doc, **opts)
    before = await mesh_state(page)
    frame = await view_frame(page)
    await frame.evaluate("""() => {
      window.caps = false;
      addEventListener('message', (e) => { if (e.data?.smesh === 'caps') window.caps = true; });
    }""")
    await focus_frame(page)
    await frame.locator("body").click()   # a gesture in the focused frame, so only the missing opt-in refuses
    await frame.evaluate(f"""() => {{
      const t = new URLSearchParams(location.search).get('dt');
      parent.postMessage({{smesh: 'hello', token: t}}, '*');
      parent.postMessage({{smesh: 'goto-session', {GOTO}, token: t}}, '*');
    }}""")
    await assert_nothing_shown(page, before, fetched)
    assert await frame.evaluate("window.caps") is False


@pytest.mark.ci_browser_smoke
async def test_a_session_request_not_sent_by_the_pane_frame_is_ignored(page, mesh, home_dir):
    doc = docs.write(home_dir, "p4b/goto/framed.html", ASKING_PAGE)
    fetched = await show_asking_document(page, mesh, doc)
    before = await mesh_state(page)
    await post_on_click(page, "[]")   # a gesture in the focused frame, so only the sender refuses
    # the mesh window itself, with the frame's own token
    await page.evaluate(f"""() => {{
      window.caps = false;
      addEventListener('message', (e) => {{ if (e.data?.smesh === 'caps') window.caps = true; }});
      const t = document.querySelector('{PANE_FRAME}').dataset.token;
      window.postMessage({{smesh: 'hello', token: t}}, '*');
      window.postMessage({{smesh: 'goto-session', {GOTO}, token: t}}, '*');
    }}""")
    await assert_nothing_shown(page, before, fetched)
    assert await page.evaluate("window.caps") is False
    assert await page.frame_locator(PANE_FRAME).locator("#caps").text_content() == ""
