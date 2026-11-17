# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Candidate and ancestor identity uncertainty must not authorize a view."""

import errno
from pathlib import Path

from aiohttp import web
import pytest

import view


@pytest.fixture
def identity_scope(home_dir, monkeypatch):
    protected = home_dir / "protected"
    protected.mkdir()
    public_dir = home_dir / "public"
    public_dir.mkdir()
    doc = public_dir / "doc.txt"
    doc.write_text("public")
    monkeypatch.setattr(view, "VIEW_DENY", (protected,))
    return protected, public_dir, doc


def fail_stat(monkeypatch, target, error_number, active=lambda: True):
    real_stat = view.os.stat

    def uncertain_stat(path, *args, **kwargs):
        if active() and Path(path) == target:
            raise OSError(error_number, "synthetic identity uncertainty")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(view.os, "stat", uncertain_stat)


@pytest.mark.parametrize("boundary", ["candidate", "ancestor"])
@pytest.mark.parametrize("error_number", [errno.EACCES, errno.EIO, errno.ELOOP])
def test_identity_uncertainty_is_a_typed_refusal(identity_scope, monkeypatch, boundary, error_number):
    protected, public_dir, doc = identity_scope
    key = protected / "key"
    key.write_text("synthetic protected")
    doc.unlink()
    doc.hardlink_to(key)
    target = doc if boundary == "candidate" else public_dir
    # For the ancestor control use an allowed candidate: the protected inode
    # must not return True early, before the uncertain ancestor is inspected.
    if boundary == "ancestor":
        doc.unlink()
        doc.write_text("public")
    fail_stat(monkeypatch, target, error_number)
    with pytest.raises(web.HTTPForbidden):
        view._denied(doc)


@pytest.mark.parametrize("boundary", ["candidate", "ancestor"])
@pytest.mark.parametrize("error_number", [errno.ENOENT, errno.ENOTDIR])
def test_absent_identity_remains_normal(identity_scope, monkeypatch, boundary, error_number):
    _, public_dir, doc = identity_scope
    fail_stat(monkeypatch, doc if boundary == "candidate" else public_dir, error_number)
    assert not view._denied(doc)


@pytest.mark.parametrize("boundary", ["candidate", "ancestor"])
@pytest.mark.parametrize("error_number", [errno.EACCES, errno.EIO])
async def test_view_route_refuses_uncertain_identity(client, signed_url, identity_scope, monkeypatch, boundary, error_number):
    protected, public_dir, doc = identity_scope
    url = await signed_url(doc)
    key = protected / "key"
    key.write_text("synthetic protected")
    if boundary == "candidate":
        doc.unlink()
        doc.hardlink_to(key)
    # Inject at identity authorization only: path resolution and checked-open
    # must remain operational, so the old permissive branch genuinely serves
    # content instead of a preceding exists()/is_file() check masking the bug.
    checking = False
    real_denied = view._denied

    def at_identity_check(path, *args):
        nonlocal checking
        checking = True
        try:
            return real_denied(path, *args)
        finally:
            checking = False

    monkeypatch.setattr(view, "_denied", at_identity_check)
    fail_stat(monkeypatch, doc if boundary == "candidate" else public_dir,
              error_number, lambda: checking)
    response = await client.get(url)
    assert response.status == 403
    assert "synthetic protected" not in await response.text()
