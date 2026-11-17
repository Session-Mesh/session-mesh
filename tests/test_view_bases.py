# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Client-supplied bases are validated and bounded (R3)."""

import time

import pytest
from aiohttp import web

import view


def test_a_huge_base_is_dropped_quickly(home_dir):
    base = "/tmp/" + "a/" * 2000          # 4 KB: was ~30 s of syscalls
    start = time.monotonic()
    with pytest.raises(web.HTTPException):
        view.describe_target("nope.md", base)
    assert time.monotonic() - start < 1


def test_a_deep_but_short_base_walks_a_bounded_number_of_ancestors(home_dir):
    deep = home_dir.joinpath(*["d"] * 40)
    deep.mkdir(parents=True)
    roots = list(view._roots_around(str(deep)))
    assert len(roots) <= view.MAX_ANCESTORS + 1


@pytest.mark.parametrize("base", [5, {"a": 1}, ["x"], "a\0b", "", None])
def test_odd_bases_are_ignored(home_dir, base):
    doc = home_dir / "x.md"
    doc.write_text("# x")
    assert view.describe_target(str(doc), base)["target"] == str(doc)


def test_bases_outside_the_roots_are_ignored():
    assert view.clean_bases("/etc", ["/usr/share", "/proc/1"]) == []


async def test_api_view_rejects_non_objects_and_bad_targets(client, auth_bearer):
    for body in ([1], "x", None):
        resp = await client.post("/api/view", json=body, headers=auth_bearer)
        assert resp.status == 400, body
    resp = await client.post("/api/view", json={"target": 5}, headers=auth_bearer)
    assert resp.status == 400


def test_relative_bases_are_ignored():
    assert view.clean_bases("dev/repo", ["./x"]) == []


async def test_non_list_bases_are_ignored(client, auth_bearer, home_dir):
    doc = home_dir / "y.md"
    doc.write_text("# y")
    for bases in (5, "abc", {"a": 1}):
        resp = await client.post("/api/view", json={"target": str(doc), "bases": bases}, headers=auth_bearer)
        assert resp.status == 200, bases


def test_a_symlinked_base_under_a_root_is_kept(home_dir, tmp_path):
    real = home_dir / "real"
    real.mkdir()
    link = home_dir / "link"
    link.symlink_to(real, target_is_directory=True)
    assert view.clean_bases(str(link), []) == [str(link)]
