# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""OPENS carries no signed URL; unreadable names are refused cleanly (R16)."""

import os

import opens
import view


async def test_opens_entries_carry_no_url(client, auth_bearer, home_dir):
    doc = home_dir / "o.md"
    doc.write_text("# o")
    resp = await client.post("/api/open", json={"target": str(doc)}, headers=auth_bearer)
    assert resp.status == 200
    assert "url" not in opens.OPENS[-1]


def test_a_non_utf8_name_is_404(home_dir):
    name = os.fsdecode(b"bad-\xff.md")
    path = home_dir / name
    path.write_text("x")
    import pytest
    from aiohttp import web
    with pytest.raises(web.HTTPNotFound):
        view.describe_target(str(path))
