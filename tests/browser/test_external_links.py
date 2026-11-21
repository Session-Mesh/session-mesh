# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""External terminal URLs leave the Mesh rather than occupying a web pane."""

import server
from conftest import ui
from test_view_compat import goto


async def open_mesh(page, mesh):
    await page.context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
    await goto(page, mesh.origin)
    # The load event precedes the boot: startMesh first awaits the translation catalogs, then
    # lays out and restores the panes. A menu built before that carries untranslated labels,
    # and the rest of the boot can still close it. The started mesh resolves at the boot's end.
    await page.evaluate("localMesh.then(() => undefined)")


async def test_http_url_uses_a_new_browser_tab_not_a_mesh_pane(page, mesh):
    await open_mesh(page, mesh)
    opened = await page.evaluate("""() => {
      const seen = [];
      window.open = (...args) => { seen.push(args); return null; };
      openExternalTab('https://example.test/a');
      return seen;
    }""")
    assert opened == [["https://example.test/a", "_blank", "noopener,noreferrer"]]
    assert await page.evaluate("panes.every((pane) => !pane.id?.startsWith('web:'))")


async def test_context_action_posts_only_the_clicked_http_url(page, mesh):
    await open_mesh(page, mesh)
    posted = []

    async def intercepted(route):
        posted.append(route.request.post_data_json)
        await route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

    await page.route("**/api/external-open", intercepted)
    await page.evaluate("openExternalLinkMenu('https://example.test/from-terminal', 8, 8)")
    # The click only starts the request: wait for its answer, which the route gives once it has recorded it.
    async with page.expect_response("**/api/external-open"):
        await page.get_by_role("menuitem", name=ui("link.openExternal")).click()
    assert posted == [{"url": "https://example.test/from-terminal"}]
