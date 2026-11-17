# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Protected files are refused by the path asked for and by identity (R2)."""

import errno
import os
import shutil

import pytest
from aiohttp import web
from test_view_review import descriptor_platform, swap_after_authorize  # noqa: F401 (fixture)
from yarl import URL

import view


@pytest.fixture
def key_elsewhere(home_dir):
    """~/.ssh/id_test is a symlink to a key stored in a normal directory."""
    store = home_dir / "Sync" / "keys"
    store.mkdir(parents=True)
    key = store / "id_test"
    key.write_text("PRIVATEKEY")
    ssh = view.Path.home() / ".ssh"
    ssh.mkdir(exist_ok=True)
    link = ssh / "id_test"
    link.unlink(missing_ok=True)
    link.symlink_to(key)
    view._deny_inodes.cache = None
    yield key, link
    link.unlink(missing_ok=True)
    view._deny_inodes.cache = None


def test_symlink_in_ssh_is_refused(key_elsewhere):
    _, link = key_elsewhere
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(link))


def test_its_real_target_is_refused_too(key_elsewhere):
    key, _ = key_elsewhere
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(key))


def test_a_hard_link_is_refused(key_elsewhere, home_dir):
    key, _ = key_elsewhere
    hard = home_dir / "innocent.txt"
    os.link(key, hard)
    view._deny_inodes.cache = None
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(hard))


async def test_a_directory_capability_does_not_serve_it(client, key_elsewhere, signed_url, home_dir):
    key, _ = key_elsewhere
    page = key.parent.parent / "notes.html"
    page.write_text("<p>x</p>")
    url = await signed_url(page)
    base = url.rsplit("/", 1)[0]
    resp = await client.get(base + "/keys/id_test")
    assert resp.status in (403, 404)
    assert b"PRIVATEKEY" not in await resp.read()


CREDENTIAL_FILES = (
    ".aws/credentials", ".netrc",
    # agent and cloud logins, package registry tokens
    ".claude/.credentials.json", ".claude.json", ".codex/auth.json", ".gemini/oauth_creds.json",
    ".pi/agent/auth.json", ".config/gcloud/credentials.db",
    ".config/gcloud/legacy_credentials/me/adc.json", ".azure/msal_token_cache.json", ".npmrc",
    ".yarnrc.yml", ".pypirc", ".cargo/credentials.toml", ".cargo/credentials", ".gem/credentials",
    ".config/git/credentials", ".config/glab-cli/config.yml", ".config/hub", ".config/rclone/rclone.conf",
    ".terraform.d/credentials.tfrc.json", ".vault-token", ".my.cnf", ".mylogin.cnf", ".boto", ".s3cfg",
    ".oci/config", ".password-store/site.gpg", ".local/share/keyrings/login.keyring", ".config/op/config",
)


@pytest.mark.parametrize("rel", CREDENTIAL_FILES)
def test_other_credential_stores_are_protected(home_dir, rel):
    path = view.Path.home() / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("secret")
    view._deny_inodes.cache = None
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(path))


async def test_a_credential_file_gets_no_link_and_is_not_served(client, auth_bearer, home_dir):
    path = view.Path.home() / ".claude" / ".credentials.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"secret": true}')
    resp = await client.post("/api/view", json={"target": str(path)}, headers=auth_bearer)
    assert resp.status == 403, await resp.text()
    # a neighbour that is not a credential is still a document
    notes = path.parent / "notes.md"
    notes.write_text("# notes")
    resp = await client.post("/api/view", json={"target": str(notes)}, headers=auth_bearer)
    assert resp.status == 200


def test_security_md_lists_exactly_what_the_code_excludes():
    text = " ".join((view.Path(__file__).resolve().parent.parent / "SECURITY.md").read_text().split())
    for name in view.DENY_UNDER_HOME:
        assert f"`~/{name}`" in text, name


def test_a_symlinked_directory_inside_ssh_is_refused(home_dir):
    store = home_dir / "vault" / "keys"
    store.mkdir(parents=True)
    (store / "id").write_text("PRIVATEKEY")
    link = view.Path.home() / ".ssh" / "keys"
    link.parent.mkdir(exist_ok=True)
    link.unlink(missing_ok=True)
    link.symlink_to(store, target_is_directory=True)
    view._deny_inodes.cache = None
    try:
        with pytest.raises(web.HTTPForbidden):
            view.describe_target(str(store / "id"))
    finally:
        link.unlink()
        view._deny_inodes.cache = None


# macOS: one file each in the login keychains and the browser, mail and password-manager data
MACOS_PROTECTED_FILES = (
    "Library/Keychains/login.keychain-db",
    "Library/Keychains/00000000-0000-0000-0000-000000000000/keychain-2.db",
    "Library/Cookies/Cookies.binarycookies",
    "Library/Safari/History.db",
    "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    "Library/Mail/V10/Mailboxes/INBOX.mbox/Messages/1.emlx",
    "Library/Messages/chat.db",
    "Library/Application Support/Firefox/Profiles/abc.default-release/logins.json",
    "Library/Application Support/Google/Chrome/Default/Login Data",
    "Library/Application Support/Chromium/Default/Cookies",
    "Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data",
    "Library/Application Support/Microsoft Edge/Default/Login Data",
    "Library/Application Support/Vivaldi/Default/Login Data",
    "Library/Application Support/librewolf/Profiles/abc.default/key4.db",
    "Library/Thunderbird/Profiles/abc.default/logins.json",
    "Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/1password.sqlite",
    "Library/HTTPStorages/com.example.app/httpstorages.sqlite",
    "Library/Containers/com.apple.mail/Data/Library/Mail Downloads/invoice.pdf",
    "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
    "Library/Application Support/AddressBook/AddressBook-v22.abcddb",
    "Library/Calendars/Calendar Cache",
    "Library/Accounts/Accounts4.sqlite",
    "Library/Containers/com.agilebits.onepassword7/Data/Library/Application Support/1Password/Data/B5.sqlite",
    "Library/Group Containers/2BUA8C4S2C.com.agilebits/Library/Application Support/1Password/Data/B5.sqlite",
    "Library/Application Support/Bitwarden/data.json",
    "Library/Containers/com.bitwarden.desktop/Data/Library/Application Support/Bitwarden/data.json",
    "Library/Application Support/Arc/User Data/Default/Login Data",
    "Library/Application Support/com.operasoftware.Opera/Login Data",
    "Library/Application Support/Signal/config.json",
    "Library/Application Support/Slack/Cookies",
    "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Cookies",
    "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
    "Library/Application Support/Google/Chrome Beta/Default/Login Data",
    "Library/Application Support/Google/Chrome Canary/Default/Login Data",
)


def test_every_macos_entry_has_a_file_above():
    for name in view.DENY_UNDER_HOME:
        if name.startswith("Library/"):
            assert any(rel.startswith(name + "/") for rel in MACOS_PROTECTED_FILES), name


@pytest.mark.parametrize("rel", MACOS_PROTECTED_FILES)
def test_macos_credential_and_browser_stores_are_protected(home_dir, rel):
    path = view.Path.home() / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("secret")
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(path))


def test_a_hard_link_to_a_keychain_is_refused(home_dir):
    keychain = view.Path.home() / "Library" / "Keychains" / "login.keychain-db"
    keychain.parent.mkdir(parents=True, exist_ok=True)
    keychain.write_text("KEYCHAIN")
    hard = home_dir / "copy.txt"
    os.link(keychain, hard)
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(hard))


def test_macos_browser_trees_are_refused_by_name_and_the_keychains_walked():
    macos = {name for name in view.DENY_UNDER_HOME if name.startswith("Library/")}
    assert view.DENY_NOT_WALKED <= set(view.DENY_UNDER_HOME)
    assert macos - view.DENY_NOT_WALKED == {"Library/Keychains"}


# ---------------------------------------------------------------- a name-only entry renamed into place

@pytest.mark.usefixtures("descriptor_platform")
@pytest.mark.parametrize("entry", [".mozilla", "Library/Safari"])
async def test_a_name_only_directory_renamed_into_place_after_the_checks_is_not_served(
        client, signed_url, home_dir, monkeypatch, entry):
    protected = view.Path.home() / entry
    (protected / "profile").mkdir(parents=True)
    (protected / "profile" / "logins.json").write_text("SAVED-LOGINS")
    doc = home_dir / "sub" / "profile" / "logins.json"
    doc.parent.mkdir(parents=True)
    doc.write_text("harmless")
    url = await signed_url(doc)

    def swap():
        shutil.rmtree(home_dir / "sub")
        os.rename(protected, home_dir / "sub")   # the entry's name no longer exists

    swap_after_authorize(monkeypatch, swap)
    try:
        resp = await client.get(URL(url, encoded=True))
        body = await resp.read()
    finally:
        shutil.rmtree(home_dir / "sub", ignore_errors=True)
        shutil.rmtree(protected, ignore_errors=True)
    assert resp.status == 404
    assert b"SAVED-LOGINS" not in body


# ---------------------------------------------------------------- a protected entry the system forbids

def _refuse(monkeypatch, name, entry, code=errno.EPERM):
    """``os.<name>`` of ``entry`` fails as macOS privacy protection makes it fail."""
    real = getattr(os, name)

    def guarded(path, *args, **kwargs):
        if str(path) == str(entry):
            raise PermissionError(code, os.strerror(code), str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(os, name, guarded)


@pytest.mark.parametrize("entry, failing", [
    ("Library/Mail", ("stat",)),
    ("Library/Safari", ("stat", "scandir")),
])
async def test_a_name_only_entry_the_system_forbids_refuses_only_what_is_under_it(
        client, auth_bearer, signed_url, home_dir, monkeypatch, entry, failing):
    protected = view.Path.home() / entry
    (protected / "inner").mkdir(parents=True, exist_ok=True)
    secret = protected / "inner" / "secret.txt"
    secret.write_text("SECRET")
    doc = home_dir / "notes.txt"
    doc.write_text("notes")
    for name in failing:
        _refuse(monkeypatch, name, protected)
    url = await signed_url(doc)
    resp = await client.get(URL(url, encoded=True))
    assert resp.status == 200 and b"notes" in await resp.read()
    resp = await client.post("/api/view", json={"target": str(secret)}, headers=auth_bearer)
    assert resp.status == 403


def test_an_entry_unreadable_by_its_permissions_still_fails_closed(home_dir, monkeypatch):
    doc = home_dir / "notes.txt"
    doc.write_text("notes")
    _refuse(monkeypatch, "stat", view.Path.home() / "Library/Mail", errno.EACCES)
    with pytest.raises(web.HTTPForbidden):
        view.describe_target(str(doc))


@pytest.mark.parametrize("entry, failing", [
    (".ssh", ("scandir",)),
    ("Library/Keychains", ("scandir",)),
    ("Library/Keychains", ("stat", "scandir")),
])
async def test_a_walked_entry_the_system_forbids_refuses_every_document(
        client, auth_bearer, signed_url, home_dir, monkeypatch, entry, failing):
    """Only entries refused by name only may be unreadable: a walked one that
    cannot be walked would no longer recognise a hard link to its files."""
    protected = view.Path.home() / entry
    protected.mkdir(parents=True, exist_ok=True)
    doc = home_dir / "notes.txt"
    doc.write_text("notes")
    url = await signed_url(doc)
    for name in failing:
        _refuse(monkeypatch, name, protected)
    resp = await client.get(URL(url, encoded=True))
    assert resp.status == 403 and b"notes" not in await resp.read()
    resp = await client.post("/api/view", json={"target": str(doc)}, headers=auth_bearer)
    assert resp.status == 403


async def test_a_hard_link_to_a_key_is_refused_when_ssh_cannot_be_walked(
        client, auth_bearer, home_dir, monkeypatch):
    ssh = view.Path.home() / ".ssh"
    ssh.mkdir(exist_ok=True)
    key = ssh / "id_unwalkable"
    key.write_text("PRIVATE-KEY")
    link = home_dir / "innocent.txt"
    os.link(key, link)
    _refuse(monkeypatch, "scandir", ssh)
    try:
        resp = await client.post("/api/view", json={"target": str(link)}, headers=auth_bearer)
    finally:
        key.unlink()
    assert resp.status == 403


def test_an_unreadable_name_only_entry_is_logged_once(home_dir, monkeypatch, capsys):
    monkeypatch.setattr(view, "_UNREADABLE_ENTRIES", set())
    doc = home_dir / "notes.txt"
    doc.write_text("notes")
    mail = view.Path.home() / "Library/Mail"
    _refuse(monkeypatch, "stat", mail)
    view.describe_target(str(doc))
    view.describe_target(str(doc))
    assert capsys.readouterr().out.count(f"{mail} is unreadable") == 1


# ---------------------------------------------------------------- the ancestor check against renames

def _name_only_profile(home_dir, entry=".mozilla"):
    """A name-only entry holding a profile, and a harmless document at the same
    relative place under ``home_dir/sub``."""
    protected = view.Path.home() / entry
    (protected / "profile").mkdir(parents=True)
    (protected / "profile" / "logins.json").write_text("SAVED-LOGINS")
    doc = home_dir / "sub" / "profile" / "logins.json"
    doc.parent.mkdir(parents=True)
    doc.write_text("harmless")
    return protected, doc


async def _fetch_then_clean(client, url, home_dir, protected):
    try:
        resp = await client.get(URL(url, encoded=True))
        return resp.status, await resp.read()
    finally:
        if (home_dir / "sub").is_symlink():
            (home_dir / "sub").unlink()
        shutil.rmtree(home_dir / "sub", ignore_errors=True)
        shutil.rmtree(protected, ignore_errors=True)


def test_reached_through_follows_a_symlinked_directory(home_dir):
    """A directory reached through a symbolic link is known by its target's identity."""
    target = home_dir / "target"
    (target / "profile").mkdir(parents=True)
    (home_dir / "sub").symlink_to(target, target_is_directory=True)
    st = os.stat(target)
    assert view._reached_through(home_dir / "sub" / "profile" / "f", {(st.st_dev, st.st_ino)})


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_symlink_to_a_name_only_entry_replaced_by_it_before_the_name_check_is_not_served(
        client, signed_url, home_dir, monkeypatch):
    """The file is opened through a symbolic link to the entry; the link is replaced
    by the entry itself after the ancestor check, so the name check matches."""
    protected, doc = _name_only_profile(home_dir)
    url = await signed_url(doc)
    sub = home_dir / "sub"

    def swap():
        shutil.rmtree(sub)
        os.symlink(protected, sub)

    reached = view._reached_through

    def reached_then_rename(path, identities):
        result = reached(path, identities)
        os.unlink(sub)
        os.rename(protected, sub)
        return result

    swap_after_authorize(monkeypatch, swap)
    monkeypatch.setattr(view, "_reached_through", reached_then_rename)
    status, body = await _fetch_then_clean(client, url, home_dir, protected)
    assert status == 404 and b"SAVED-LOGINS" not in body


@pytest.mark.usefixtures("descriptor_platform")
async def test_the_name_check_runs_after_the_ancestor_check(client, signed_url, home_dir, monkeypatch):
    """An entry moved into place before the open and back to its own name before
    the ancestor check leaves the descriptor named after the entry: only a name
    check made after the ancestor check sees it."""
    protected, doc = _name_only_profile(home_dir)
    url = await signed_url(doc)
    sub = home_dir / "sub"

    def swap():
        shutil.rmtree(sub)
        os.rename(protected, sub)

    reached = view._reached_through

    def moved_back_first(path, identities):
        os.rename(sub, protected)
        (sub / "profile").mkdir(parents=True)
        return reached(path, identities)

    swap_after_authorize(monkeypatch, swap)
    monkeypatch.setattr(view, "_reached_through", moved_back_first)
    status, body = await _fetch_then_clean(client, url, home_dir, protected)
    assert status == 404 and b"SAVED-LOGINS" not in body


@pytest.mark.xfail(strict=True, reason="known limit: directories inside a name-only entry have "
                   "no recorded identity (SECURITY.md)")
@pytest.mark.usefixtures("descriptor_platform")
async def test_a_directory_inside_a_name_only_entry_renamed_into_place_is_not_detected(
        client, signed_url, home_dir, monkeypatch):
    protected, doc = _name_only_profile(home_dir)
    url = await signed_url(doc)

    def swap():
        shutil.rmtree(home_dir / "sub" / "profile")
        os.rename(protected / "profile", home_dir / "sub" / "profile")

    swap_after_authorize(monkeypatch, swap)
    status, body = await _fetch_then_clean(client, url, home_dir, protected)
    assert status == 404 and b"SAVED-LOGINS" not in body
