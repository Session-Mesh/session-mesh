# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Current protected identities: no stale refusal or rotated-key cache miss."""
import errno
import os
from pathlib import Path

from aiohttp import web
import pytest

import view


@pytest.fixture
def store(home_dir, monkeypatch):
    protected = home_dir / "protected"
    protected.mkdir()
    monkeypatch.setattr(view, "VIEW_DENY", (protected,))
    monkeypatch.setattr(view._deny_inodes, "cache", None)
    return home_dir, protected


def test_reused_identity_does_not_inherit_a_deleted_protected_entry(store, monkeypatch):
    home, protected = store
    key = protected / "key"
    key.write_text("synthetic")
    previous = key.stat()
    assert (previous.st_dev, previous.st_ino) in view._deny_inodes()
    key.unlink()
    public = home / "public.md"
    public.write_text("public")
    real_stat = os.stat

    def reused_stat(path, *args, **kwargs):
        # Deterministic inode reuse independent of the test filesystem allocator.
        if Path(path) == public:
            return previous
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(view.os, "stat", reused_stat)
    assert not view._denied(public)


def test_rotated_protected_key_is_denied_through_a_new_public_hardlink(store):
    home, protected = store
    key = protected / "key"
    key.write_text("old")
    previous = key.stat().st_ino
    view._deny_inodes()
    replacement = home / "replacement"
    replacement.write_text("new")
    assert replacement.stat().st_ino != previous
    replacement.replace(key)
    alias = home / "alias.md"
    alias.hardlink_to(key)
    assert view._denied(alias)


def test_new_protected_entry_is_denied_before_any_ttl(store):
    home, protected = store
    view._deny_inodes()
    key = protected / "new-key"
    key.write_text("synthetic")
    alias = home / "alias.md"
    alias.hardlink_to(key)
    assert view._denied(alias)


def test_active_aliases_and_protected_directory_ancestors_stay_denied(store):
    home, protected = store
    key = protected / "key"
    key.write_text("synthetic")
    hardlink = home / "hardlink.md"
    hardlink.hardlink_to(key)
    symlink = home / "symlink.md"
    symlink.symlink_to(key)
    directory = home / "linked-directory"
    directory.mkdir()
    doc = directory / "doc.md"
    doc.write_text("synthetic")
    (protected / "linked").symlink_to(directory, target_is_directory=True)
    assert all(view._denied(path) for path in (key, hardlink, symlink, doc))
    public = home / "public.md"
    public.write_text("public")
    assert not view._denied(public)


def test_absent_entries_are_normal_and_protected_files_remain_denied(store, monkeypatch):
    home, _ = store
    key = home / "protected-file"
    key.write_text("synthetic")
    alias = home / "alias.md"
    alias.hardlink_to(key)
    monkeypatch.setattr(view, "VIEW_DENY", (home / "absent", key))
    assert view._denied(alias)
    public = home / "public.md"
    public.write_text("public")
    assert not view._denied(public)


def test_unreadable_protected_tree_fails_closed(store, monkeypatch):
    home, _ = store
    public = home / "public.md"
    public.write_text("public")

    def unreadable_walk(path, **kwargs):
        error = PermissionError(errno.EACCES, "synthetic refusal")
        if callback := kwargs.get("onerror"):
            callback(error)
        return iter(())

    monkeypatch.setattr(view.os, "walk", unreadable_walk)
    with pytest.raises(web.HTTPForbidden):
        view._denied(public)


def test_unreadable_protected_member_fails_closed(store, monkeypatch):
    home, protected = store
    key = protected / "key"
    key.write_text("synthetic")
    public = home / "public.md"
    public.write_text("public")
    real_stat = os.stat

    def unreadable_stat(path, *args, **kwargs):
        if Path(path) == key:
            raise PermissionError(errno.EACCES, "synthetic refusal")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(view.os, "stat", unreadable_stat)
    with pytest.raises(web.HTTPForbidden):
        view._denied(public)
