# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Relative document paths printed by agents (view.resolve_relative), and the view roots."""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from aiohttp import web

import view


@pytest.fixture
def repo(home_dir):
    root = home_dir / "proj"
    (root / ".git").mkdir(parents=True)
    (root / "briefs").mkdir()
    (root / "briefs" / "plan.md").write_text("# plan")
    (root / "sub" / "docs").mkdir(parents=True)
    (root / "sub" / "docs" / "spec.md").write_text("# spec")
    (root / "sub" / "src").mkdir()
    return root


def test_relative_to_the_working_directory(repo):
    assert view.resolve_relative("briefs/plan.md", [repo]) == repo / "briefs" / "plan.md"


def test_relative_to_the_git_root_from_a_subdirectory(repo):
    assert view.resolve_relative("briefs/plan.md", [repo / "sub" / "src"]) == repo / "briefs" / "plan.md"


def test_relative_to_a_sub_project(repo):
    assert view.resolve_relative("docs/spec.md", [repo]) == repo / "sub" / "docs" / "spec.md"


def test_the_working_directory_wins(repo):
    (repo / "sub" / "briefs").mkdir()
    (repo / "sub" / "briefs" / "plan.md").write_text("other")
    assert view.resolve_relative("briefs/plan.md", [repo / "sub"]) == repo / "sub" / "briefs" / "plan.md"


def test_does_not_climb_above_the_git_root(repo):
    (repo.parent / "outside.md").write_text("x")
    with pytest.raises(web.HTTPNotFound):
        view.resolve_relative("outside.md", [repo])


def test_missing_reports_the_working_directory(repo):
    with pytest.raises(web.HTTPNotFound) as e:
        view.resolve_relative("nope.md", [repo])
    assert str(repo / "nope.md") in e.value.text


def test_the_agents_current_directory_comes_first(repo, home_dir):
    other = home_dir / "other"
    (other / "briefs").mkdir(parents=True)
    (other / "briefs" / "plan.md").write_text("other")
    # the agent started in repo, then cd'd to other: its current dir wins
    assert view.resolve_relative("briefs/plan.md", [other, repo]) == other / "briefs" / "plan.md"


def test_a_bare_name_is_found_once_in_the_repository(repo):
    (repo / ".claude" / "rules").mkdir(parents=True)
    (repo / ".claude" / "rules" / "escalation.md").write_text("# rules")
    assert view.resolve_relative("escalation.md", [repo / "sub"]) == repo / ".claude" / "rules" / "escalation.md"


def test_an_ambiguous_bare_name_is_not_guessed(repo):
    for d in ("a", "b"):
        (repo / d).mkdir()
        (repo / d / "notes.md").write_text(d)
    with pytest.raises(web.HTTPNotFound):
        view.resolve_relative("notes.md", [repo / "sub" / "src"])


def test_a_name_in_several_sub_projects_is_not_guessed(home_dir):
    for d in ("a", "b"):
        (home_dir / d).mkdir()
        (home_dir / d / "CLAUDE.md").write_text(d)
    with pytest.raises(web.HTTPNotFound):
        view.resolve_relative("CLAUDE.md", [home_dir])


def test_the_walk_does_not_climb_into_tmp(tmp_path_factory):
    # an agent scratch dir under /tmp, not in a repo: /tmp itself is never tried
    import tempfile
    from pathlib import Path
    top = Path(tempfile.mkdtemp(prefix="walk-", dir="/tmp"))
    try:
        (top / "proj" / "sub").mkdir(parents=True)
        planted = Path("/tmp") / f"planted-{top.name}.md"
        planted.write_text("x")
        try:
            with pytest.raises(web.HTTPException):
                view.resolve_relative(planted.name, [top / "proj" / "sub"])
        finally:
            planted.unlink()
    finally:
        import shutil
        shutil.rmtree(top)


def test_environment_dot_directories_are_not_searched(repo):
    (repo / ".venv" / "lib").mkdir(parents=True)
    (repo / ".venv" / "lib" / "guide.md").write_text("vendored")
    (repo / "docs").mkdir()
    (repo / "docs" / "guide.md").write_text("ours")
    assert view.resolve_relative("guide.md", [repo / "sub"]) == repo / "docs" / "guide.md"


def test_deep_working_directory_in_a_repo(repo):
    deep = repo.joinpath(*["lvl"] * 12)
    deep.mkdir(parents=True)
    assert view.resolve_relative("briefs/plan.md", [deep]) == repo / "briefs" / "plan.md"


# ---------------------------------------------------------------- macOS private temporary directory

@pytest.fixture
def private_tmp():
    """A 0700 directory outside the test home standing for macOS's $TMPDIR."""
    path = Path(tempfile.mkdtemp(prefix="private-T-", dir=os.environ["SMESH_TEST_ROOT"])).resolve()
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
def private_root(private_tmp, monkeypatch):
    """The view roots as macOS sets them, without /tmp: a document there is only reachable
    through the private root."""
    monkeypatch.setattr(view, "VIEW_PRIVATE_TMP", private_tmp)
    monkeypatch.setattr(view, "VIEW_ROOTS", (Path.home(), private_tmp))
    return private_tmp


def tmpdir_of(path, roots=None, platform="darwin", parent=None):
    """_private_tmpdir as getconf would answer ``path``, with the test root standing for
    /private/var/folders."""
    parent = parent or Path(os.environ["SMESH_TEST_ROOT"])
    return view._private_tmpdir(platform, roots or (Path.home(),), lambda: path, parent)


def test_private_tmpdir_is_a_root_on_macos_only(private_tmp):
    assert tmpdir_of(str(private_tmp) + "/") == private_tmp
    assert tmpdir_of(str(private_tmp), platform="linux") is None
    assert tmpdir_of(None) is None
    assert tmpdir_of("") is None
    assert tmpdir_of(str(private_tmp / "missing")) is None


def test_tmpdir_environment_variable_is_ignored(private_tmp, tmp_path, monkeypatch):
    # the default ask path runs getconf (faked here); TMPDIR names another valid directory
    elsewhere = private_tmp / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    fake = tmp_path / "getconf"
    fake.write_text(f"#!/bin/sh\necho {private_tmp}\n")
    fake.chmod(0o755)
    monkeypatch.setattr(view, "_GETCONF", str(fake))
    monkeypatch.setenv("TMPDIR", str(elsewhere))
    parent = Path(os.environ["SMESH_TEST_ROOT"])
    assert view._private_tmpdir("darwin", (Path.home(),), parent=parent) == private_tmp


def test_private_tmpdir_outside_the_system_folder_is_refused(private_tmp):
    # a user-owned directory no one else can write to, but not below the system folder
    assert tmpdir_of(str(private_tmp), parent=Path("/nonexistent-system-folder")) is None
    assert tmpdir_of(str(private_tmp), parent=private_tmp) is None


def test_private_tmpdir_owned_by_another_user_is_refused(private_tmp, monkeypatch):
    uid = os.getuid()
    monkeypatch.setattr(view.os, "getuid", lambda: uid + 1)
    assert tmpdir_of(str(private_tmp)) is None


@pytest.mark.parametrize("mode", [0o720, 0o702, 0o1777])
def test_private_tmpdir_writable_by_others_is_refused(private_tmp, mode):
    private_tmp.chmod(mode)
    assert tmpdir_of(str(private_tmp)) is None


def test_private_tmpdir_that_is_a_file_or_overlaps_a_root_is_refused(private_tmp, home_dir):
    afile = private_tmp / "file"
    afile.write_text("x")
    assert tmpdir_of(str(afile)) is None
    home_dir.chmod(0o700)
    # inside home, around home, or home itself: never a second, overlapping root
    assert tmpdir_of(str(home_dir)) is None
    assert tmpdir_of(str(private_tmp), (private_tmp / "h",)) is None
    assert tmpdir_of(str(private_tmp), (private_tmp,)) is None


@pytest.mark.parametrize("tool", ["/nonexistent/getconf", "/usr/bin/false", "/bin/echo"])
def test_a_failed_or_relative_getconf_answer_adds_no_root(monkeypatch, tool):
    # missing tool, failure status, and an answer that is not an absolute path
    monkeypatch.setattr(view, "_GETCONF", tool)
    assert view._darwin_user_temp_dir() is None


@pytest.mark.skipif(sys.platform != "darwin", reason="getconf DARWIN_USER_TEMP_DIR is macOS's")
def test_the_real_macos_temp_dir_is_accepted():
    real = view._darwin_user_temp_dir()
    assert real and Path(real).resolve().is_relative_to(view.DARWIN_TEMP_PARENT)
    assert view._private_tmpdir("darwin", (Path("/tmp"),)) == Path(real).resolve()


async def test_a_document_in_the_private_tmpdir_is_served(client, signed_url, private_root):
    doc = private_root / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>private</p>")
    resp = await client.get(await signed_url(doc))
    assert (resp.status, await resp.read()) == (200, b"<p>private</p>")


async def test_without_the_private_root_the_document_is_refused(client, auth_bearer, private_tmp,
                                                                monkeypatch):
    monkeypatch.setattr(view, "VIEW_ROOTS", (Path.home(),))
    doc = private_tmp / "page.html"
    doc.write_text("x")
    resp = await client.post("/api/view", json={"target": str(doc)}, headers=auth_bearer)
    assert resp.status == 403


def test_the_private_tmpdir_is_searched_like_home_not_like_tmp(private_root):
    (private_root / "proj" / "sub").mkdir(parents=True)
    (private_root / "notes.md").write_text("# notes")
    assert not view._shared_root(private_root)
    assert view.resolve_relative("notes.md", [private_root / "proj" / "sub"]) == private_root / "notes.md"
    # nor is a .git there a repository of the walk: the walk stops at the root, as at home
    (private_root / ".git").mkdir()
    assert view._git_root(private_root / "proj" / "sub") is None
