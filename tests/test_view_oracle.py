# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""No file-existence oracle on /view without a valid capability (R14)."""

import time


async def test_a_forged_capability_gets_the_same_answer_for_any_path(client, home_dir):
    (home_dir / "exists.txt").write_text("x")
    exp = int(time.time()) + 3600
    forged = f"/view/v2.f.{exp}.{'0' * 32}"
    statuses = set()
    for path in (home_dir / "exists.txt", home_dir / "missing.txt", "/etc/passwd", "/nonexistent/x"):
        resp = await client.get(f"{forged}{path}")
        statuses.add((resp.status, await resp.text()))
    assert len(statuses) == 1 and next(iter(statuses))[0] == 403
