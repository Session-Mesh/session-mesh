# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""An HTML document's code subresources get the file, not the viewer (R9)."""


async def test_subresources_get_their_own_type(client, home_dir, signed_url):
    (home_dir / "rep").mkdir()
    page = home_dir / "rep" / "index.html"
    page.write_text('<link rel=stylesheet href="style.css"><script src="app.js"></script>')
    (home_dir / "rep" / "style.css").write_text("body{color:red}")
    (home_dir / "rep" / "app.js").write_text("console.log(1)")
    base = (await signed_url(page)).rsplit("/", 1)[0]
    css = await client.get(base + "/style.css", headers={"Sec-Fetch-Dest": "style"})
    js = await client.get(base + "/app.js", headers={"Sec-Fetch-Dest": "script"})
    assert css.content_type == "text/css" and await css.text() == "body{color:red}"
    assert js.content_type in ("text/javascript", "application/javascript")
    nav = await client.get(base + "/app.js", headers={"Sec-Fetch-Dest": "iframe"})
    assert nav.content_type == "text/html"      # opened in the panel: the code viewer
