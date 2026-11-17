# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""When Claude will deliver Mesh's wake line without asking (claudepolicy)."""

import json
import os

import pytest

import claudepolicy

KEY = "crossSessionInbound"


class World:
    """A throwaway managed directory, user config directory and project folder."""

    def __init__(self, root, monkeypatch):
        self.managed = root / "managed"
        self.config = root / "config"
        self.project = root / "project"
        for folder in (self.managed, self.config, self.project / ".claude"):
            folder.mkdir(parents=True)
        monkeypatch.setattr(claudepolicy, "managed_directory", lambda: self.managed)
        self.env = {"HOME": str(root / "home"), "CLAUDE_CONFIG_DIR": str(self.config)}

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value if isinstance(value, str) else json.dumps(value))

    def user(self, value):
        self.write(self.config / "settings.json", value)

    def project_file(self, value, name="settings.json"):
        self.write(self.project / ".claude" / name, value)

    def managed_file(self, value, name="managed-settings.json"):
        self.write(self.managed / name, value)

    def delivers(self, *flags, settings=None):
        argv = ["claude", *flags]
        if settings is not None:
            argv += ["--settings", settings if isinstance(settings, str) else json.dumps(settings)]
        return claudepolicy.delivers_automatically(argv, str(self.project), self.env)


@pytest.fixture
def world(tmp_path, monkeypatch):
    return World(tmp_path, monkeypatch)


# ----------------------------------------------------------- the effective value


def test_no_value_anywhere_delivers_in_a_session_that_does_not_bypass(world):
    assert world.delivers() is True
    assert world.delivers("--permission-mode", "plan") is True


@pytest.mark.parametrize("flags", [["--dangerously-skip-permissions"],
                                   ["--permission-mode", "bypassPermissions"],
                                   ["--permission-mode=bypassPermissions"],
                                   ["--allow-dangerously-skip-permissions"]])
def test_no_value_in_a_bypass_session_means_no_socket(world, flags):
    assert world.delivers(*flags) is False


def test_a_bypass_set_in_settings_means_no_socket(world):
    bypass = {"permissions": {"defaultMode": "bypassPermissions"}}
    assert world.delivers(settings=bypass) is False
    world.user(bypass)
    assert world.delivers() is False


def test_an_explicit_accept_delivers_even_in_a_bypass_session(world):
    assert world.delivers("--dangerously-skip-permissions", settings={KEY: "accept"}) is True
    world.user({KEY: "accept"})
    assert world.delivers("--dangerously-skip-permissions") is True


@pytest.mark.parametrize("choice", ["refuse", "hold", "ACCEPT", "yes", 1, None, ["accept"]])
def test_every_other_value_means_no_socket_at_every_level(world, choice):
    assert world.delivers(settings={KEY: choice}) is False
    world.user({KEY: choice})
    assert world.delivers() is False
    world.user({})
    world.managed_file({KEY: choice})
    assert world.delivers() is False


def test_the_order_is_policy_then_command_then_user(world):
    world.user({KEY: "refuse"})
    assert world.delivers(settings={KEY: "accept"}) is True        # the command beats the user
    world.user({KEY: "accept"})
    assert world.delivers(settings={KEY: "refuse"}) is False       # and the other way round
    world.managed_file({KEY: "accept"})
    assert world.delivers() is True
    world.managed_file({KEY: "refuse"})
    assert world.delivers(settings={KEY: "accept"}) is False       # the policy beats the command


def test_a_managed_drop_in_overrides_the_base_file_in_sorted_order(world):
    world.managed_file({KEY: "refuse"})
    world.managed_file({KEY: "accept"}, "managed-settings.d/10-a.json")
    assert world.delivers() is True
    world.managed_file({KEY: "hold"}, "managed-settings.d/20-b.json")
    assert world.delivers() is False
    world.managed_file("{broken", "managed-settings.d/30-c.json")
    assert world.delivers(settings={KEY: "accept"}) is False


def test_an_invalid_value_is_a_hold_even_below_a_valid_one(world):
    world.user({KEY: "maybe"})
    assert world.delivers(settings={KEY: "accept"}) is False


def test_a_project_can_only_tighten(world):
    world.project_file({KEY: "accept"})
    assert world.delivers("--dangerously-skip-permissions") is False   # accept there is ignored
    assert world.delivers() is True
    for name in ("settings.json", "settings.local.json"):
        for choice in ("refuse", "hold", "bogus"):
            world.project_file({KEY: choice}, name)
            assert world.delivers(settings={KEY: "accept"}) is False, (name, choice)
            world.project_file({}, name)
    world.project_file({KEY: "refuse"})
    world.user({KEY: "accept"})
    assert world.delivers() is False


def test_setting_sources_excludes_the_sources_claude_will_not_read(world):
    world.user({KEY: "refuse"})
    assert world.delivers("--setting-sources", "project") is True
    world.project_file({KEY: "refuse"})
    world.user({KEY: "accept"})
    assert world.delivers("--setting-sources", "user") is True      # the refusing project is not read
    assert world.delivers("--setting-sources=local") is True        # no settings.local.json
    world.user({KEY: "refuse"})
    assert world.delivers("--setting-sources", "user") is False
    assert world.delivers("--setting-sources", "project") is False
    assert world.delivers("--setting-sources", "bogus") is False


def test_the_command_settings_may_be_a_file_relative_to_the_project(world):
    world.write(world.project / "extra.json", {KEY: "accept"})
    world.user({KEY: "refuse"})
    assert world.delivers("--settings", "extra.json") is True
    assert world.delivers("--settings", "missing.json") is False


def test_two_settings_values_or_a_dangling_option_mean_no_socket(world):
    assert world.delivers("--settings", "{}", settings="{}") is False
    assert claudepolicy.delivers_automatically(["claude", "--settings"], str(world.project), world.env) is False


def test_claude_config_dir_of_the_session_environment_is_followed(world, tmp_path):
    other = tmp_path / "other-config"
    other.mkdir()
    (other / "settings.json").write_text(json.dumps({KEY: "refuse"}))
    assert world.delivers() is True
    env = {**world.env, "CLAUDE_CONFIG_DIR": str(other)}
    assert claudepolicy.delivers_automatically(["claude"], str(world.project), env) is False
    home = tmp_path / "h"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({KEY: "hold"}))
    assert claudepolicy.delivers_automatically(["claude"], str(world.project), {"HOME": str(home)}) is False


# ------------------------------------------------------------- failing closed


def test_an_unreadable_or_malformed_file_means_no_socket(world):
    for bad in ("{not json", "[]", '"accept"', "\xff"):
        world.user(bad)
        assert world.delivers() is False, bad
    world.user({})
    assert world.delivers() is True
    world.user("x" * (claudepolicy.SETTINGS_BYTES + 1))
    assert world.delivers() is False
    for name in ("settings.json", "settings.local.json"):
        world.project_file("{", name)
        assert world.delivers() is False
        world.project_file({}, name)


def test_a_file_that_cannot_be_opened_means_no_socket(world):
    world.user({KEY: "accept"})
    (world.config / "settings.json").chmod(0)
    try:
        if os.access(world.config / "settings.json", os.R_OK):
            pytest.skip("permissions are not enforced for this user")
        assert world.delivers() is False
    finally:
        (world.config / "settings.json").chmod(0o600)


def test_a_fifo_cannot_block_the_launch(world):
    os.mkfifo(world.config / "settings.json")
    assert world.delivers() is False       # returns at once: nothing writes to the FIFO
    (world.config / "settings.json").unlink()
    os.mkfifo(world.project / ".claude" / "settings.local.json")
    assert world.delivers() is False
    os.mkfifo(world.managed / "managed-settings.json")
    assert world.delivers(settings={KEY: "accept"}) is False


def test_a_directory_or_a_device_is_not_a_settings_file(world):
    (world.config / "settings.json").mkdir()
    assert world.delivers() is False
    (world.config / "settings.json").rmdir()
    os.symlink("/dev/zero", world.config / "settings.json")
    assert world.delivers() is False


def test_a_symlink_to_a_regular_file_is_read_like_claude_does(world, tmp_path):
    real = tmp_path / "dotfiles-settings.json"
    real.write_text(json.dumps({KEY: "refuse"}))
    os.symlink(real, world.config / "settings.json")
    assert world.delivers() is False
    real.write_text(json.dumps({KEY: "accept"}))
    assert world.delivers("--dangerously-skip-permissions") is True


def test_an_unreadable_directory_of_drop_ins_means_no_socket(world):
    world.write(world.managed / "managed-settings.d", "a file, not a directory")
    assert world.delivers() is False


def test_a_missing_or_relative_folder_means_no_socket(world):
    assert claudepolicy.delivers_automatically(["claude"], "relative/dir", world.env) is False
    assert claudepolicy.delivers_automatically(["claude"], None, world.env) is False
    assert claudepolicy.delivers_automatically(["claude"], str(world.project), {"CLAUDE_CONFIG_DIR": "rel"}) is False


def test_the_managed_directory_follows_the_platform(monkeypatch):
    monkeypatch.setattr(claudepolicy.sys, "platform", "darwin")
    assert str(claudepolicy.managed_directory()) == "/Library/Application Support/ClaudeCode"
    monkeypatch.setattr(claudepolicy.sys, "platform", "linux")
    assert str(claudepolicy.managed_directory()) == "/etc/claude-code"


# ------------------------------------- the repository root's settings.local.json


class Repo:
    """A repository, built by hand, with a sub-folder and a linked worktree."""

    def __init__(self, world, root):
        self.world = world
        self.main = root / "main"
        (self.main / ".git").mkdir(parents=True)
        (self.main / "sub" / "deeper").mkdir(parents=True)
        self.linked = root / "linked"
        pointer = self.main / ".git" / "worktrees" / "linked"
        pointer.mkdir(parents=True)
        self.linked.mkdir()
        (self.linked / ".git").write_text(f"gitdir: {pointer}\n")
        (pointer / "commondir").write_text("../..\n")
        (pointer / "gitdir").write_text(f"{self.linked}/.git\n")
        (self.linked / "sub").mkdir()
        (self.main / ".claude").mkdir()

    def local(self, value, folder=None, name="settings.local.json"):
        self.world.write((folder or self.main) / ".claude" / name, value)

    def delivers(self, cwd, *flags):
        return claudepolicy.delivers_automatically(["claude", *flags], str(cwd), self.world.env)


@pytest.fixture
def repo(world, tmp_path):
    return Repo(world, tmp_path / "repos")


@pytest.mark.parametrize("settings", [{KEY: "hold"}, {KEY: "refuse"}, {KEY: "bogus"},
                                      {"permissions": {"defaultMode": "bypassPermissions"}}])
@pytest.mark.parametrize("where", ["main", "sub", "deeper", "linked", "linked/sub"])
def test_a_restriction_in_the_root_settings_local_json_reaches_every_folder_of_the_repository(
        repo, settings, where):
    cwd = {"main": repo.main, "sub": repo.main / "sub", "deeper": repo.main / "sub" / "deeper",
           "linked": repo.linked, "linked/sub": repo.linked / "sub"}[where]
    assert repo.delivers(cwd) is True
    repo.local(settings)
    assert repo.delivers(cwd) is False


def test_an_accept_in_a_project_file_never_loosens_anything(repo):
    repo.local({KEY: "accept"})
    assert repo.delivers(repo.main / "sub") is True               # ignored: Claude's default applies
    assert repo.delivers(repo.main / "sub", "--dangerously-skip-permissions") is False


def test_only_the_cwd_settings_json_is_read_the_roots_is_not(repo):
    repo.local({KEY: "refuse"}, name="settings.json")
    assert repo.delivers(repo.main / "sub") is True
    assert repo.delivers(repo.main) is False                      # here it is the cwd's own
    repo.local({KEY: "refuse"}, repo.main / "sub", name="settings.json")
    assert repo.delivers(repo.main / "sub") is False


def test_the_older_copy_in_the_cwd_is_read_as_well(repo):
    repo.local({KEY: "hold"}, repo.main / "sub")
    assert repo.delivers(repo.main / "sub" / "deeper") is True    # only the cwd's own copy counts
    assert repo.delivers(repo.main / "sub") is False
    repo.local({KEY: "hold"}, repo.linked / "sub")
    assert repo.delivers(repo.linked / "sub") is False


def test_a_root_the_user_does_not_own_is_not_read_the_cwd_copy_still_is(repo, monkeypatch):
    repo.local({KEY: "hold"})
    monkeypatch.setattr(claudepolicy, "_euid", lambda: os.geteuid() + 1)
    assert repo.delivers(repo.main / "sub") is True               # Claude keeps the store at the cwd
    repo.local({KEY: "hold"}, repo.main / "sub")
    assert repo.delivers(repo.main / "sub") is False


def test_a_root_whose_dot_claude_belongs_to_someone_else_is_not_read_either(repo, monkeypatch):
    repo.local({KEY: "hold"})
    real = os.lstat

    def other_owner(path, *args, **kwargs):
        info = real(path, *args, **kwargs)
        if str(path).endswith("/main/.claude"):
            return os.stat_result((info.st_mode, info.st_ino, info.st_dev, info.st_nlink,
                                   info.st_uid + 1, *info[5:]))
        return info
    monkeypatch.setattr(claudepolicy.os, "lstat", other_owner)
    assert repo.delivers(repo.main / "sub") is True


def test_the_users_home_is_never_the_store(repo, world):
    world.env["HOME"] = str(repo.main)
    repo.local({KEY: "hold"})
    assert repo.delivers(repo.main / "sub") is True


def test_a_root_that_cannot_be_judged_means_no_socket(repo):
    assert repo.delivers(repo.linked) is True
    pointer = repo.main / ".git" / "worktrees" / "linked"
    (pointer / "gitdir").write_text("/somewhere/else/.git\n")      # does not lead back
    assert repo.delivers(repo.linked) is False
    (pointer / "gitdir").write_text(f"{repo.linked}/.git\n")
    (pointer / "commondir").write_text("../../elsewhere\n")        # not the repository's directory
    assert repo.delivers(repo.linked) is False
    (pointer / "commondir").write_text("../..\n")
    (repo.linked / ".git").write_text("gitdir: \n")                # an empty pointer
    assert repo.delivers(repo.linked) is False


def test_a_symlinked_or_special_repository_entry_means_no_socket(repo, tmp_path):
    (repo.main / "sub" / "deeper" / ".git").symlink_to(repo.main / ".git")
    assert repo.delivers(repo.main / "sub" / "deeper") is False
    os.mkfifo(repo.linked / "sub" / ".git")
    assert repo.delivers(repo.linked / "sub") is False


def test_a_submodule_pointer_without_commondir_is_its_own_root(repo):
    module = repo.main / "module"
    (module / "inside").mkdir(parents=True)
    (module / ".git").write_text(f"gitdir: {repo.main}/.git/modules/module\n")
    repo.local({KEY: "hold"})
    assert repo.delivers(module / "inside") is True               # Claude does not go up to main


def test_an_unreadable_root_settings_file_means_no_socket(repo):
    os.mkfifo(repo.main / ".claude" / "settings.local.json")
    assert repo.delivers(repo.main / "sub") is False


def test_a_folder_outside_any_repository_reads_only_itself(world):
    assert world.delivers() is True
    world.project_file({KEY: "hold"}, name="settings.local.json")
    assert world.delivers() is False


def test_a_cwd_reached_through_a_symlink_is_read_both_ways(repo, tmp_path):
    link = tmp_path / "link-to-sub"
    link.symlink_to(repo.main / "sub")
    repo.local({KEY: "refuse"})
    assert repo.delivers(link) is False


def test_a_cwd_with_dotdot_after_a_symlink_reads_the_physical_folder(world, tmp_path):
    """/base/x/lnk -> /base/y/z: the kernel resolves lnk/../proj to /base/y/proj, not /base/x/proj."""
    (tmp_path / "y" / "z").mkdir(parents=True)
    physical = tmp_path / "y" / "proj"
    (physical / ".claude").mkdir(parents=True)
    (physical / ".claude" / "settings.json").write_text(json.dumps({KEY: "hold"}))
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "lnk").symlink_to(tmp_path / "y" / "z")
    given = str(tmp_path / "x" / "lnk" / ".." / "proj")
    assert os.path.isdir(given)
    assert claudepolicy.delivers_automatically(["claude"], str(physical), world.env) is False
    assert claudepolicy.delivers_automatically(["claude"], given, world.env) is False


@pytest.mark.parametrize("option", [["--project-config-root", "/elsewhere"], ["--project-config-root=/elsewhere"]])
def test_a_moved_project_config_root_means_no_socket(world, option):
    assert world.delivers() is True
    assert world.delivers(*option) is False
