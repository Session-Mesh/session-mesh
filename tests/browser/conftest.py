# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Browser harness: the mesh on an ephemeral port, a request "sink" playing the
exfiltration target on another port, and headless Chromium via Playwright.

Every test here carries the ``browser`` marker. Without Playwright they are
skipped, unless MESH_REQUIRE_BROWSER=1, which turns the absence into a failure.
"""

import asyncio
import importlib.util
import json
import os
import re
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

import board
import conversation_names
import management
import opens
import organize
import respawn
import server

DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
HAVE_PLAYWRIGHT = importlib.util.find_spec("playwright") is not None
QUIET_WAIT = 1.0   # seconds a blocked request is given to show up at the sink

# The interface page's CSP (server.INDEX_CSP) refuses eval, and Playwright evaluates a
# string predicate of wait_for_function("panes.length === 1") with eval in the page. A
# predicate given as a function is compiled through the DevTools protocol instead, which the
# policy does not govern: every plain expression is turned into "() => (expression)". The
# policy itself stays in force (never bypass_csp: it would also lift the /view documents'
# policies the exfiltration tests rely on).
# A parameter list holds no parenthesis: "(() => ...)()" is an expression, not a function.
_FUNCTION_SOURCE = re.compile(r"^\s*(async\s+)?(function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")


def _function_predicate(expression):
    return expression if _FUNCTION_SOURCE.match(expression) else f"() => ({expression}\n)"


if HAVE_PLAYWRIGHT:
    from playwright.async_api import Frame as _Frame, Page as _Page

    for _cls in (_Page, _Frame):
        def _wrap(original):
            async def wait_for_function(self, expression, *args, **kwargs):
                return await original(self, _function_predicate(expression), *args, **kwargs)
            return wait_for_function
        _cls.wait_for_function = _wrap(_cls.wait_for_function)

# The interface language the suite runs in (MESH_UI_LANG=en|fr): every browser
# context gets the matching navigator.languages, and ui() gives the text a test
# expects from the catalogs (static/i18n/), English filling any gap.
UI_LANG = os.environ.get("MESH_UI_LANG", "en")
UI_LOCALE = {"en": "en-US", "fr": "fr-FR"}.get(UI_LANG, UI_LANG)
_I18N = Path(__file__).resolve().parents[2] / "static" / "i18n"
_CATALOG = {**json.loads((_I18N / "en.json").read_text()), **json.loads((_I18N / f"{UI_LANG}.json").read_text())}


def ui(key, **params):
    """The interface text of `key` in the suite's language, placeholders filled."""
    value = _CATALOG[key]
    if isinstance(value, dict):
        n = params.get("n")
        value = value.get("one") if n == 1 or (UI_LANG == "fr" and n == 0) else value["other"]
    return re.sub(r"\{(\w+)\}", lambda m: str(params.get(m.group(1), m.group(0))), value)


# Browser contexts still open, so that the mesh fixture can stop their routes before its
# server stops (see stop_routes).
_OPEN_CONTEXTS = set()


def _track(context):
    _OPEN_CONTEXTS.add(context)
    context.on("close", lambda closed: _OPEN_CONTEXTS.discard(closed))
    return context


def localized(instance):
    """Make every context of this browser use the suite's language unless a test sets one."""
    new_context, new_page = instance.new_context, instance.new_page

    async def localized_context(**options):
        return _track(await new_context(**{"locale": UI_LOCALE, **options}))

    async def localized_page(**options):
        tab = await new_page(**{"locale": UI_LOCALE, **options})
        _track(tab.context)
        return tab

    instance.new_context, instance.new_page = localized_context, localized_page
    return instance


async def stop_routes():
    """Stop every test route before the mesh server stops.

    A page fixture requested before ``mesh`` is torn down after it, and the page keeps
    polling until then: a route handler forwarding a request (route.fetch) could reach the
    stopped server and fail the context's close. Handlers still running are left to finish
    with their errors ignored; nothing new is intercepted.
    """
    for context in list(_OPEN_CONTEXTS):
        for tab in context.pages:
            await tab.unroute_all(behavior="ignoreErrors")
        await context.unroute_all(behavior="ignoreErrors")


def pytest_collection_modifyitems(config, items):
    here = Path(__file__).parent
    for item in items:
        if here in Path(item.fspath).parents:
            item.add_marker(pytest.mark.browser)
            if not HAVE_PLAYWRIGHT and os.environ.get("MESH_REQUIRE_BROWSER") != "1":
                item.add_marker(pytest.mark.skip(reason="playwright not installed "
                                                        "(pip install -r requirements-browser.txt)"))


class Sink:
    """Records every request it receives; a document must never reach it."""

    def __init__(self):
        self.hits = []
        self.server = None

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server.port}"

    async def handle(self, request):
        self.hits.append(f"{request.method} {request.path_qs}")
        return web.Response(text="sink", headers={"Access-Control-Allow-Origin": "*"})

    async def assert_untouched(self, wait=QUIET_WAIT):
        await asyncio.sleep(wait)
        assert self.hits == [], f"the document reached the sink: {self.hits}"


class Mesh:
    def __init__(self, test_server):
        self.server = test_server

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server.port}"

    async def describe(self, target):
        headers = {"Authorization": f"Bearer {server.TOKEN}"}
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.origin}/api/view", json={"target": str(target)},
                                    headers=headers) as resp:
                assert resp.status == 200, await resp.text()
                return await resp.json()

    async def url(self, target):
        return self.origin + (await self.describe(target))["url"]


@pytest.fixture
async def sink():
    recorder = Sink()
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", recorder.handle)
    recorder.server = TestServer(app, host="127.0.0.1")
    await recorder.server.start_server()
    yield recorder
    await recorder.server.close()


def _reset_mesh_state():
    """Give each browser test a new persisted Mesh, not just a new tab.

    Browser tests share the process-wide test HOME. A prior pty shutdown can
    therefore leave a restore snapshot (or a board/open hint) that changes the
    next page's layout before its own setup starts. Clear those fixtures at
    setup time, after the prior page and test server are already gone.
    """
    for path in (board.FILE, conversation_names.FILE, management.FILE, organize.FILE, respawn.FILE):
        path.unlink(missing_ok=True)
    management.reset_for_tests()
    opens.OPENS.clear()
    opens._BOARD_OPEN_IDENTITIES.clear()
    opens._BOARD_REFRESH_IDENTITIES.clear()
    server.SIGNALS.clear()


@pytest.fixture
async def mesh():
    _reset_mesh_state()
    test_server = TestServer(server.make_app(), host="127.0.0.1")
    await test_server.start_server()
    yield Mesh(test_server)
    await stop_routes()
    await test_server.close()


@pytest.fixture
async def browser():
    from playwright.async_api import async_playwright

    executable = os.environ.get("MESH_CHROMIUM") or (
        DEFAULT_CHROMIUM if Path(DEFAULT_CHROMIUM).exists() else None)
    async with async_playwright() as playwright:
        instance = localized(await playwright.chromium.launch(executable_path=executable, headless=True,
                                                              args=["--mute-audio"]))
        yield instance
        await instance.close()


@pytest.fixture
async def page(browser):
    context = await browser.new_context()
    tab = await context.new_page()
    tab.dialogs = []
    tab.on("dialog", lambda dialog: (tab.dialogs.append(dialog.message),
                                     asyncio.ensure_future(dialog.dismiss())))
    yield tab
    await context.close()
