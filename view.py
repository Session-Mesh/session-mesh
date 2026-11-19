# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Document panel: signed /view capabilities, the view policy, the Markdown page.

Documents open in a side panel, served under ``/view/<capability>/<absolute path>``.
A sandboxed document has an opaque origin and carries no cookie, so the
capability must travel in the URL, and in every relative URL derived from it:

    v2.<mode>.<exp>.<mac>
    mac = HMAC(VIEW_KEY, "view2\\0<mode>\\0<exp>\\0<scope>")[:32 hex]

- mode ``f``: ``scope`` is the exact file; nothing else is reachable.
- mode ``d``: ``scope`` is the document's directory (the anchor); relative
  subresources up to VIEW_MAX_DEPTH subdirectories below it are reachable,
  never through a component starting with ``.``.
- ``exp``: Unix seconds; the URL stops working after VIEW_TTL.

``d`` is only issued for a type that loads relative subresources (HTML, SVG,
rendered Markdown), for an anchor that is not a view root itself and has no
dot component; the mesh's config dir and the credential stores of
``DENY_UNDER_HOME`` (``~/.ssh``, ``~/.gnupg``, cloud, agent and registry logins)
are never signed or served. All checks run on resolved paths, so a symlink cannot lead
out of a scope, and the file is opened once, without following a symlink, and
served from that descriptor only if it is still the checked path.
"""

import asyncio
import errno
import fcntl
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

import codeview
import fsutil

STATIC = Path(__file__).resolve().parent / "static"
# A sandboxed frame has an opaque origin and cannot authenticate a separate
# static request. Keep this server-owned helper inline in framed HTML only;
# CSP already permits the document's own inline scripts and is not relaxed.
FRAME_HISTORY_BRIDGE = b"<script>" + (STATIC / "mesh-frame-history.js").read_bytes() + b"</script>"

_GETCONF = "/usr/bin/getconf"
# Where macOS puts every user's temporary directory (/var/folders is a link to it).
DARWIN_TEMP_PARENT = Path("/private/var/folders")


def _darwin_user_temp_dir():
    """The system's answer for this user's temporary directory, or None. $TMPDIR is
    not read: a launchd job may not have it, and it can name any directory."""
    try:
        done = subprocess.run([_GETCONF, "DARWIN_USER_TEMP_DIR"], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        return None
    named = done.stdout.strip()
    return named if named.startswith("/") else None


def _private_tmpdir(platform, roots, ask=None, parent=DARWIN_TEMP_PARENT):
    """macOS's per-user temporary directory (/var/folders/.../T), resolved, or None:
    on macOS only, as reported by ``ask`` (default: getconf), when it resolves below
    ``parent``, is a directory owned by this user that no one else can write to, and
    is neither inside nor around one of ``roots``."""
    if platform != "darwin":
        return None
    named = (ask or _darwin_user_temp_dir)()
    if not named:
        return None
    try:
        path = Path(named).resolve(strict=True)
        found = os.stat(path)
    except (OSError, RuntimeError):
        return None
    if parent not in path.parents:
        return None
    if not stat.S_ISDIR(found.st_mode) or found.st_uid != os.getuid() or found.st_mode & 0o022:
        return None
    for root in roots:
        root = root.resolve()
        if path == root or root in path.parents or path in root.parents:
            return None
    return path


# The user's private temporary directory is a root like home, not a shared one like /tmp.
VIEW_PRIVATE_TMP = _private_tmpdir(sys.platform, (Path.home(), Path("/tmp")))
VIEW_ROOTS = (Path.home(), Path("/tmp"), *([VIEW_PRIVATE_TMP] if VIEW_PRIVATE_TMP else []))
VIEW_TTL = 12 * 3600
VIEW_MAX_DEPTH = 2
VIEW_EXPIRED = "Link expired: reopen the document from the mesh"
CAP_RE = re.compile(r"v2\.([fd])\.([1-9]\d{0,11})\.([0-9a-f]{32})")

# The framed-HTML bridge must be parsed before an ordinary document link can
# become interactive.  Keep a leading doctype and the document's explicit
# html/head elements ahead of it: putting a script before those tags makes an
# HTML parser create implicit elements and silently discard their attributes.
# This is deliberately a bounded, start-of-document recognition aid, not an
# HTML parser for untrusted documents.  Its byte scanner is linear even for a
# malformed tag without a closing ``>``: it runs on the request event loop.
_FRAME_SPACE = b" \t\r\n\f"
_FRAME_TAG_BOUNDARY = _FRAME_SPACE + b">/"
_FRAME_UTF8_BOM = b"\xef\xbb\xbf"
# The bridge is UTF-8 source.  Do not put it ahead of, or mix it into,
# documents whose BOM selects a multi-byte encoding: a framed document that
# cannot offer Previous is preferable to one whose browser decoding is broken.
_FRAME_MULTIBYTE_BOMS = (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff", b"\xff\xfe", b"\xfe\xff")

# macOS browser, mail, messages, contacts, calendar, notes and password-manager data, and the
# chat apps' local stores: refused by name, like the Linux browser profiles (DENY_NOT_WALKED).
# The App Store build of an app keeps its data in its container, the downloaded one under
# Application Support: both are listed.
_MACOS_BY_NAME = (
    "Library/Cookies", "Library/HTTPStorages", "Library/Safari",
    "Library/Containers/com.apple.Safari", "Library/Application Support/Firefox",
    "Library/Application Support/Google/Chrome", "Library/Application Support/Google/Chrome Beta",
    "Library/Application Support/Google/Chrome Canary", "Library/Application Support/Chromium",
    "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Vivaldi", "Library/Application Support/librewolf",
    "Library/Application Support/Arc", "Library/Application Support/com.operasoftware.Opera",
    "Library/Mail", "Library/Containers/com.apple.mail", "Library/Thunderbird",
    "Library/Messages", "Library/Application Support/AddressBook", "Library/Calendars",
    "Library/Group Containers/group.com.apple.calendar",
    "Library/Group Containers/group.com.apple.notes", "Library/Accounts",
    "Library/Group Containers/2BUA8C4S2C.com.1password",
    "Library/Containers/com.agilebits.onepassword7", "Library/Group Containers/2BUA8C4S2C.com.agilebits",
    "Library/Application Support/Bitwarden", "Library/Containers/com.bitwarden.desktop",
    "Library/Application Support/Signal", "Library/Application Support/Slack",
    "Library/Containers/com.tinyspeck.slackmacgap",
)
VIEW_KEY = b""
VIEW_DENY = ()
# Credential stores beside the mesh's own config dir; files as well as dirs.
# Whole directories only where they hold little else: every entry but
# DENY_NOT_WALKED is walked at each check (_deny_inodes). SECURITY.md lists the same names (checked by
# tests/test_view_deny_identity.py). A safety net for well-known places, not
# an inventory of every secret under the home directory.
DENY_UNDER_HOME = (
    # keys and password stores
    ".ssh", ".gnupg", ".password-store", ".local/share/keyrings", ".config/op",
    # cloud and cluster logins
    ".aws", ".kube", ".docker", ".azure", ".oci", ".config/gcloud", ".boto", ".s3cfg",
    ".config/rclone", ".terraform.d/credentials.tfrc.json", ".vault-token",
    # coding agents' logins
    ".claude/.credentials.json", ".claude.json", ".codex/auth.json", ".gemini/oauth_creds.json",
    ".pi/agent/auth.json",
    # forges and package registries
    ".config/gh", ".config/glab-cli", ".config/hub", ".netrc", ".git-credentials",
    ".config/git/credentials", ".npmrc", ".yarnrc.yml", ".pypirc", ".cargo/credentials.toml",
    ".cargo/credentials", ".gem/credentials",
    # databases
    ".pgpass", ".my.cnf", ".mylogin.cnf",
    # shell and REPL histories (a command line can carry a password or a token)
    ".bash_history", ".zsh_history", ".local/share/fish/fish_history", ".python_history",
    ".node_repl_history", ".psql_history", ".mysql_history", ".sqlite_history", ".lesshst",
    # more registry and secret-tool logins
    ".config/containers/auth.json", ".composer/auth.json", ".config/composer/auth.json",
    # sops age keys
    ".config/sops/age",
    # browser profiles (cookies, saved logins); see DENY_NOT_WALKED
    ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
    ".config/microsoft-edge", ".config/vivaldi", ".librewolf",
    ".var/app/org.mozilla.firefox", ".var/app/com.google.Chrome", ".var/app/org.chromium.Chromium",
    ".var/app/com.brave.Browser", "snap/firefox", "snap/chromium",
    # macOS (a missing entry costs one stat per check, so the list is the same everywhere):
    # the login keychains (small, walked), then the data refused by name
    "Library/Keychains",
    *_MACOS_BY_NAME,
)
# Entries refused by path only (as asked for, and resolved), not walked for inodes: a browser
# profile holds tens of thousands of files, and walking them at each check would cost every
# request. A hard link into one of them is not recognised.
DENY_NOT_WALKED = frozenset((
    ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
    ".config/microsoft-edge", ".config/vivaldi", ".librewolf",
    ".var/app/org.mozilla.firefox", ".var/app/com.google.Chrome", ".var/app/org.chromium.Chromium",
    ".var/app/com.brave.Browser", "snap/firefox", "snap/chromium",
    *_MACOS_BY_NAME,
))
VIEW_DENY_NOT_WALKED = frozenset()


def configure(token, conf_dir):
    """Bind the signing key and the deny-list to the mesh's token and config dir."""
    global VIEW_KEY, VIEW_DENY, VIEW_DENY_NOT_WALKED
    VIEW_KEY = hmac.new(token.encode(), b"session-mesh/view/v2", hashlib.sha256).digest()
    home = Path.home()
    VIEW_DENY = (Path(conf_dir), *(home / name for name in DENY_UNDER_HOME))
    VIEW_DENY_NOT_WALKED = frozenset(home / name for name in DENY_NOT_WALKED)
    _load_file_scope(Path(conf_dir) / FILE_SCOPE_STORE_NAME)
    _deny_inodes.cache = None


def _now():
    return time.time()


# ---------------------------------------------------------------- policy (single source of truth)

MD_EXT = {".md", ".markdown"}
# unified diffs and patches, rendered by the diff viewer (static/diff.html, static/diff-view.ts)
DIFF_EXT = {".diff", ".patch"}
# types whose page loads relative subresources: the only ones given a directory scope
DIR_SCOPE_EXT = {".html", ".htm", ".svg"} | MD_EXT
# The only types served without a sandbox, so that the browser's own viewer can
# render them (a sandboxed frame cannot host the PDF viewer). The Content-Type
# and this decision are both taken by content_type(), from the same suffix.
INERT_TYPES = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
               ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
_INERT_TYPE_SET = frozenset(INERT_TYPES.values())
mimetypes.init()
VIEWLIB = {"marked.min.js", "mermaid.min.js", "highlight.min.js", "purify.min.js",
           "hljs-github-dark.min.css", "hljs-github.min.css"}
# The renderers built from the repository's own sources (static/*.ts), next to the vendored ones.
VIEWLIB_OWN = {"diff-view.js"}

# Frame flags for local documents; the response's CSP sandbox uses the same
# string. No allow-forms / allow-modals: no phishing forms or dialogs over the mesh.
# No allow-popups: a document cannot open a window (carrying its own URL); the
# Markdown renderer asks the mesh to open external links instead (static/app.js).
SANDBOX_DOC = "allow-scripts allow-downloads"

# No fetch/XHR/beacon/websocket, no remote image, style, font or script, no form
# post. CSP cannot stop the frame navigating itself, nor WebRTC (a known CSP limit). 'self' is the
# server's origin even inside the opaque-origin sandbox (browser test C6).
_NO_DATA_OUT = ("default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                "font-src 'self' data:; connect-src 'none'; form-action 'none'; worker-src 'none'; "
                "object-src 'none'; base-uri 'none'")
CSP_ACTIVE = (f"sandbox {SANDBOX_DOC}; {_NO_DATA_OUT}; script-src 'self' 'unsafe-inline'; "
              "media-src 'self' data: blob:; frame-src 'self'; manifest-src 'none'")
VIEW_HEADERS = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache",
                "Referrer-Policy": "no-referrer",
                # the same URL answers a viewer page or the raw file depending on it
                "Vary": "Sec-Fetch-Dest"}


def content_type(path):
    """The Content-Type a document is served with: an exact lookup of its last
    suffix. Never ``mimetypes.guess_type(name)``: that reads its argument as a
    URL, so ``ab:evil.html?.png`` (suffix ``.png``) would be typed text/html."""
    ext = Path(path).suffix.lower()
    return INERT_TYPES.get(ext) or mimetypes.types_map.get(ext) or "application/octet-stream"


def is_inert(served_type):
    """Served without a sandbox: exactly the listed types, judged on the type emitted."""
    return served_type.partition(";")[0].strip().lower() in _INERT_TYPE_SET


def frame_sandbox(served_type):
    """The panel frame's sandbox for a document served as ``served_type``;
    None for the inert types only."""
    return None if is_inert(served_type) else SANDBOX_DOC


def active_csp():
    return CSP_ACTIVE


def markdown_csp(nonce):
    """Rendered Markdown: only the renderer's own scripts run, by nonce."""
    return f"sandbox {SANDBOX_DOC}; {_NO_DATA_OUT}; script-src 'nonce-{nonce}'; frame-src 'none'"


# ---------------------------------------------------------------- paths

def _roots():
    return [root.resolve() for root in VIEW_ROOTS]


def _under(path, base):
    return path == base or base in path.parents


def _root_of(path):
    """The deepest view root containing ``path``, or None."""
    found = [root for root in _roots() if _under(path, root)]
    return max(found, key=lambda root: len(root.parts)) if found else None


def _lexically_denied(path):
    """``path`` as written (absolute, ``..`` folded, symlinks NOT followed) is
    under a protected entry: ~/.ssh/id_ed25519 is refused even when it is a
    symlink to a file elsewhere."""
    lexical = Path(os.path.abspath(path))
    return any(_under(lexical, Path(os.path.abspath(deny))) for deny in VIEW_DENY)


def _identity_uncertain(error):
    """Only absent identities are normal; inability to verify must fail closed."""
    if error.errno not in (errno.ENOENT, errno.ENOTDIR):
        raise web.HTTPForbidden(text="Protected folder unavailable") from error


_UNREADABLE_ENTRIES = set()     # protected entries already reported unreadable


def _entry_unreadable(deny, error):
    """An entry refused by name only (DENY_NOT_WALKED) that the system forbids the
    server to read (macOS privacy protection answers EPERM without Full Disk Access)
    stays refused by name; it does not refuse every other document. A walked entry
    must be read whole, or a hard link to one of its files would go unrecognised:
    any failure there, like any other failure to verify (EACCES from ordinary file
    permissions included), fails closed."""
    if error.errno != errno.EPERM or deny not in VIEW_DENY_NOT_WALKED:
        _identity_uncertain(error)
        return
    if deny not in _UNREADABLE_ENTRIES:
        _UNREADABLE_ENTRIES.add(deny)
        print(f"session-mesh: {deny} is unreadable ({error}): /view refuses it by name only",
              flush=True)


def _deny_inodes():
    """(st_dev, st_ino) of every file under the protected entries, symlinks
    followed, read freshly for this check. Inode numbers can be reused and keys
    rotated: a persistent hit or miss is not an authorization decision."""
    found = set()
    for deny in VIEW_DENY:
        _entry_inodes(deny, found)
    return found


def _entry_inodes(deny, found):
    """Add to ``found`` the protected entry ``deny`` and, unless refused by name only, its files."""
    def remember(path):
        try:
            st = os.stat(path)
            found.add((st.st_dev, st.st_ino))
        except OSError as error:
            _entry_unreadable(deny, error)

    if deny not in VIEW_DENY_NOT_WALKED:
        for dirpath, dirnames, filenames in os.walk(
                deny, onerror=lambda error: _entry_unreadable(deny, error)):
            for name in filenames + dirnames:
                remember(os.path.join(dirpath, name))
    remember(deny)


# Compatibility with existing private test fixtures; never read for decisions.
_deny_inodes.cache = None


def _denied(path, inodes=None):
    """``inodes``: the protected identities to compare with, read freshly when not given."""
    if _lexically_denied(path) or any(_under(path, deny.resolve()) for deny in VIEW_DENY):
        return True
    # the file, or any directory it is reached through, is a protected entry
    # (~/.ssh/keys -> elsewhere/keys: the walk records the link's target directory)
    inodes = _deny_inodes() if inodes is None else inodes
    for candidate in [path, *Path(path).parents]:
        try:
            st = os.stat(candidate)
        except OSError as error:
            _identity_uncertain(error)
            continue
        if (st.st_dev, st.st_ino) in inodes:
            return True
    return False


def _dir_scope_allowed(anchor):
    """May ``anchor`` carry a directory scope: not a root, no dot component below its root."""
    root = _root_of(anchor)
    if root is None or anchor == root:
        return False
    return not any(part.startswith(".") for part in anchor.relative_to(root).parts)


def _resolve_under_root(path):
    path = path.resolve()
    if _root_of(path) is None:
        raise web.HTTPForbidden(text="Outside the allowed folders")
    return path


def resolve_doc(target, base=None):
    """Resolved, existing path for a document under an allowed root.

    A directory stands for its ``index.html``, which is resolved again: a
    symlinked index passes the same checks as any other path."""
    try:
        path = Path(os.path.expanduser(target))
        if not path.is_absolute():
            path = Path(base or Path.home()) / path
        if _lexically_denied(path):
            raise web.HTTPForbidden(text="Document refused: protected folder")
        path = _resolve_under_root(path)
        if path.is_dir():
            path = _resolve_under_root(path / "index.html")
        if not path.is_file():
            raise web.HTTPNotFound(text=f"Not found: {path}")
    except (ValueError, OSError):    # a NUL byte, a name too long, a symlink loop
        raise web.HTTPNotFound(text="Not found")
    return path


# ---------------------------------------------------------------- capabilities

def _mac(mode, exp, scope):
    if not VIEW_KEY:   # fail closed: an empty key would make every capability forgeable
        raise RuntimeError("view.configure() was not called")
    message = "\0".join(("view2", mode, str(exp), str(scope))).encode()
    return hmac.new(VIEW_KEY, message, hashlib.sha256).hexdigest()[:32]


# Active documents (HTML/SVG run their own script) that a session token asked to
# open: they only ever get a file capability. A process holding just its session
# token could otherwise write a page whose script exfiltrates its own directory
# capability (a known CSP limit) and read the files next to it.
# path -> expiry. Markdown is included: its own script never runs, but a link
# in it to an .html in the same directory would load that page under the
# Markdown file's directory capability. Entries last as long as a capability
# (the user's own later opens of that file are file-scoped meanwhile).
#
# A marker is never lost open. The table is kept in the config dir, so it
# outlives a restart. When a marker has to go before its time (the table is
# full) or may be missing (the stored table is unreadable), every document is
# file-scoped until the lost markers would have ended (_FILE_SCOPE_ALL): the
# cost is relative images and stylesheets not loading meanwhile, never a
# directory capability for a document a session opened.
FILE_SCOPE_ONLY = {}
FILE_SCOPE_MAX = 2000
FILE_SCOPE_STORE_NAME = "session-opened-documents.json"
SESSION_FILE_SCOPE_EXT = {".html", ".htm", ".svg", ".md", ".markdown"}
_FILE_SCOPE_ALL = {"until": 0.0}
_file_scope_store = None


def _file_scope_all_until():
    return _FILE_SCOPE_ALL["until"]


def _finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _stored_file_scope(store):
    """(markers, all_until) as stored; ValueError for anything but a table this code wrote.

    A dangling symbolic link is not "nothing was ever marked": the table it pointed to is lost."""
    if store.is_symlink() and not store.exists():
        raise ValueError("a dangling symbolic link")
    stored = json.loads(store.read_bytes())
    # `true == 1` in Python: a boolean version is not this code's table
    version = stored.get("version") if isinstance(stored, dict) else None
    if isinstance(version, bool) or version != 1:
        raise ValueError("unknown format")
    paths, all_until = stored.get("paths"), stored.get("all_until")
    numbers = [all_until, *(paths.values() if isinstance(paths, dict) else [None])]
    # json.loads reads NaN and Infinity, and integers too large for a float:
    # an until that never ends or never compares is corrupt
    if not all(_finite_number(n) for n in numbers):
        raise ValueError("unknown format")
    return {Path(name): until for name, until in paths.items()}, all_until


def _load_file_scope(store):
    """Start from the stored table; an unreadable one file-scopes everything for a capability's life."""
    global _file_scope_store
    _file_scope_store = store
    FILE_SCOPE_ONLY.clear()
    _FILE_SCOPE_ALL["until"] = 0.0
    try:
        markers, all_until = _stored_file_scope(store)
    except FileNotFoundError:           # nothing was ever marked
        return
    except (OSError, ValueError) as error:
        print(f"session-mesh: {store} is unreadable ({error}): documents get no directory access "
              f"for {VIEW_TTL // 3600} h", flush=True)
        _FILE_SCOPE_ALL["until"] = _now() + VIEW_TTL
        try:
            _save_file_scope()          # so that the next start does not begin the delay again
        except OSError:
            pass
        return
    FILE_SCOPE_ONLY.update(markers)
    _FILE_SCOPE_ALL["until"] = all_until


def _save_file_scope():
    if _file_scope_store is None:       # view.configure() was not called: nothing persists
        return
    # json escapes everything outside ASCII, a file name that is not UTF-8 included
    stored = {"version": 1, "all_until": _FILE_SCOPE_ALL["until"],
              "paths": {str(path): until for path, until in FILE_SCOPE_ONLY.items()}}
    fsutil.atomic_write(_file_scope_store, json.dumps(stored))


def file_scope_only(path):
    """Session-opened: until its capability would have expired, sign file mode only.

    The marker is stored before this returns; when it cannot be, 503: the
    document is not opened rather than opened with a marker a restart loses."""
    now, path = _now(), Path(path)
    for stale in [p for p, until in FILE_SCOPE_ONLY.items() if until <= now]:
        del FILE_SCOPE_ONLY[stale]
    while path not in FILE_SCOPE_ONLY and len(FILE_SCOPE_ONLY) >= FILE_SCOPE_MAX:
        oldest = min(FILE_SCOPE_ONLY, key=FILE_SCOPE_ONLY.get)
        _FILE_SCOPE_ALL["until"] = max(_FILE_SCOPE_ALL["until"], FILE_SCOPE_ONLY.pop(oldest))
    FILE_SCOPE_ONLY[path] = now + VIEW_TTL
    try:
        _save_file_scope()
    except OSError as error:
        raise web.HTTPServiceUnavailable(
            text="Document not opened: its access scope could not be recorded") from error


def _file_scope_forced(path):
    now = _now()
    until = FILE_SCOPE_ONLY.get(path)
    return _FILE_SCOPE_ALL["until"] > now or (until is not None and until > now)


def _issue_scope(path):
    """(mode, scope) for a document, or 403 for a protected one."""
    if _denied(path):
        raise web.HTTPForbidden(text="Document refused: protected folder")
    if (path.suffix.lower() not in DIR_SCOPE_EXT or path.name.startswith(".") or _file_scope_forced(path)
            or not _dir_scope_allowed(path.parent)):
        return "f", path
    return "d", path.parent


def view_url(path):
    """The served URL; the path is percent-encoded once, and aiohttp decodes it once."""
    mode, scope = _issue_scope(path)
    exp = int(_now()) + VIEW_TTL
    try:
        encoded = quote(str(path))
    except UnicodeEncodeError:          # a file name that is not valid UTF-8
        raise web.HTTPNotFound(text="Unreadable file name")
    return f"/view/v2.{mode}.{exp}.{_mac(mode, exp, scope)}{encoded}"


def _parse_capability(cap):
    match = CAP_RE.fullmatch(cap)
    if not match:
        raise web.HTTPForbidden()
    mode, exp, mac = match[1], int(match[2]), match[3]
    if exp <= _now():
        raise web.HTTPForbidden(text=VIEW_EXPIRED)
    return mode, exp, mac


def _in_dir_scope(path, anchor):
    rel = path.relative_to(anchor)
    return (_dir_scope_allowed(anchor) and len(rel.parts) - 1 <= VIEW_MAX_DEPTH
            and not any(part.startswith(".") for part in rel.parts))


def _mac_ok(path, mode, exp, mac):
    """The capability covers ``path`` (no filesystem access for the path itself)."""
    if mode == "f":
        return hmac.compare_digest(mac, _mac("f", exp, path))
    return any(hmac.compare_digest(mac, _mac("d", exp, anchor)) and _in_dir_scope(path, anchor)
               for anchor in list(path.parents)[: VIEW_MAX_DEPTH + 1])


def _authorize(path, mode, exp, mac):
    """403 unless the capability covers ``path`` and it is not protected. Returns
    the protected identities read for this check, for _open_checked."""
    protected = _deny_inodes()
    if _denied(path, protected) or not _mac_ok(path, mode, exp, mac):
        raise web.HTTPForbidden()
    return protected


# ---------------------------------------------------------------- routes

SEARCH_SKIP = {"node_modules", "_build", "_opam", "target", "vendor", "__pycache__", "dist", "build",
               "venv", "env", "site-packages",
               # heavy dot-directories (caches, environments); .claude, .github… stay searchable
               ".git", ".venv", ".tox", ".nox", ".cache", ".mypy_cache", ".pytest_cache", ".ruff_cache",
               ".direnv", ".npm", ".cargo", ".rustup", ".local", ".opam", ".gradle", ".idea", ".next"}
SEARCH_LIMIT = 20000   # directory entries walked per root, so a click stays fast
MAX_ANCESTORS = 32     # safety bound; the walk normally stops at a git root, home or the view root


def _private_root(path):
    """Home, or the private temporary directory on macOS: roots only the user writes to."""
    return path == Path.home().resolve() or (VIEW_PRIVATE_TMP is not None and path == VIEW_PRIVATE_TMP)


def _shared_root(path):
    """A view root other users can write to (/tmp): never a place to look for
    a document, so a relative name cannot open something planted there."""
    return any(path == root and not _private_root(root) for root in _roots())


def _roots_around(base):
    """A base, then its ancestors up to the git root, home, or the base's view
    root (compared resolved, so a symlinked home still stops the walk): where a
    path printed by an agent is usually rooted. A shared root (/tmp) itself is
    never one of them."""
    start = Path(base)
    yield start
    if (start / ".git").exists():
        return
    stop = _root_of(start.resolve()) if start.exists() else _root_of(start)
    for parent in list(start.parents)[:MAX_ANCESTORS]:
        resolved = parent.resolve() if parent.exists() else parent
        if _shared_root(resolved):
            return
        yield parent
        if resolved == stop or resolved == Path.home().resolve() or (parent / ".git").exists():
            return


def _in_one_subproject(target, base):
    """target under exactly one direct subdirectory of base (an agent in a
    monorepo naming paths from a sub-project); several matches are not guessed."""
    try:
        subs = [p for p in Path(base).iterdir() if p.is_dir() and not p.name.startswith(".")]
    except OSError:
        return None
    hits = []
    for sub in subs:
        try:
            hits.append(resolve_doc(target, sub))
        except (web.HTTPNotFound, web.HTTPForbidden):
            continue
        if len(hits) > 1:
            return None
    return hits[0] if hits else None


def _git_root(path):
    """The enclosing repository: owned by the user, below its view root (a
    `.git` planted in /tmp is not a repository of the user's)."""
    for p in [path, *list(path.parents)[:MAX_ANCESTORS]]:
        resolved = p.resolve() if p.exists() else p
        if _shared_root(resolved) or _private_root(resolved):
            return None
        git = p / ".git"
        try:
            if git.exists() and git.stat().st_uid == os.getuid() and p.stat().st_uid == os.getuid():
                return p
        except OSError:
            return None
    return None


def _find_unique(root, target):
    """The single file under root whose path ends with target (for a bare
    name like "escalation.md" printed out of context), or None."""
    want, hits, seen = Path(target).parts, [], 0
    for dirpath, dirnames, filenames in os.walk(root):
        # build trees, environments and caches hold no documents
        dirnames[:] = [d for d in dirnames if d not in SEARCH_SKIP]
        seen += len(dirnames) + len(filenames)
        if want[-1] in filenames:
            cand = Path(dirpath) / want[-1]
            if cand.parts[-len(want):] == want:
                hits.append(cand)
        if len(hits) > 1:
            return None
        if seen > SEARCH_LIMIT:
            break          # a hit found so far is kept: only a second one would be ambiguous
    return hits[0] if hits else None


MAX_PATH_LEN = 4096
MAX_BASES = 4
MAX_DEPTH = 64         # components in a base: deeper is not a real working directory


def _clean_path_arg(value):
    """A client-supplied path: a NUL-free string of bounded length, or None."""
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_LEN or "\0" in value:
        return None
    return value


def clean_bases(base, bases):
    """The directories a relative path may be tried from, as sent by a client
    (the page or mesh-open): strings only, bounded, absolute, under a view
    root, deduplicated, at most MAX_BASES. Anything else is dropped, so a
    crafted base cannot make the lookup walk far or outside the roots."""
    out = []
    for value in [*(bases if isinstance(bases, list) else []), base]:
        value = _clean_path_arg(value)
        if value is None:
            continue
        path = Path(os.path.expanduser(value))
        if not path.is_absolute():              # would resolve against the server's own cwd
            continue
        path = Path(os.path.abspath(path))
        if len(path.parts) > MAX_DEPTH or str(path) in out:
            continue
        # under a view root as written or once resolved (a symlinked home)
        if _root_of(path) is None and _root_of(path.resolve()) is None:
            continue
        out.append(str(path))
    return out[:MAX_BASES]


def resolve_relative(target, bases=()):
    """resolve_doc for a path printed by an agent. A relative path is tried
    from each base (the agent's current directory first, then where it was
    started) and the roots around it, then searched in the enclosing
    repositories if it names a single file there. Every candidate goes
    through resolve_doc and its checks; the first error is the one kept."""
    bases = [b for b in bases if b] or [str(Path.home())]
    if Path(os.path.expanduser(target)).is_absolute():
        return resolve_doc(target, bases[0])
    first_error = None
    for base in bases:
        for root in _roots_around(base):
            try:
                return resolve_doc(target, root)
            except (web.HTTPNotFound, web.HTTPForbidden) as e:
                first_error = first_error or e
        hit = _in_one_subproject(target, base)
        if hit:
            return hit
    for repo in dict.fromkeys(filter(None, (_git_root(Path(b)) for b in bases))):
        hit = _find_unique(repo, target)
        if hit:
            return resolve_doc(str(hit))
    raise first_error


def describe_target(target, base=None, bases=()):
    if not isinstance(target, str):
        raise web.HTTPBadRequest(text="Invalid target")
    if _clean_path_arg(target) is None:     # empty, too long, or with a NUL byte
        raise web.HTTPNotFound(text="Not found")
    # A panel shows local files only: a web page is never framed inside the mesh
    # (a session token could otherwise put any site, with its forms, in the
    # owner's panes). Terminal links to web pages open in the browser instead.
    if re.match(r"^https?://", target, re.IGNORECASE):
        raise web.HTTPBadRequest(text="A web page does not open in a panel; open it in a browser")
    path = resolve_relative(target, clean_bases(base, bases))
    ext = path.suffix.lower()
    # opens_links: the mesh honours "open this link" requests from this pane's
    # frame (rendered Markdown, whose own script is the renderer's only)
    served_type = content_type(path)
    return {"kind": "file", "target": str(path), "url": view_url(path), "ext": ext,
            # inert: the explicit statement the page needs before it frames a
            # document without a sandbox; an absent "sandbox" never means that
            "sandbox": frame_sandbox(served_type), "inert": is_inert(served_type),
            "opens_links": ext in MD_EXT,
            # opens_sessions: the mesh honours "show this conversation" requests
            # (goto-session) from this pane's frame: rendered Markdown, local HTML
            "opens_sessions": ext in MD_EXT or ext in {".html", ".htm"},
            # the page reports its scroll position and takes it back after a reload
            "keeps_scroll": ext in MD_EXT or codeview.language_for(path) is not None}


def stat_target(target):
    """The document's mtime in ns, as a string (a JS number cannot hold it), or None for
    anything the view policy would not serve: a URL, a missing file, a protected one."""
    if re.match(r"^https?://", target):
        return None
    try:
        path = resolve_doc(target)
        if _denied(path):
            return None
        return str(path.stat().st_mtime_ns)
    except (web.HTTPException, OSError):
        return None


async def api_view(request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object expected")
    # the lookup touches the filesystem (and may search a repository): off the event loop
    return web.json_response(await asyncio.to_thread(
        describe_target, body.get("target"), body.get("base"), body.get("bases") or []))


async def view(request):
    cap, _, rest = request.match_info["tail"].partition("/")
    mode, exp, mac = _parse_capability(cap)
    # The capability is checked first, on the path as written, before any
    # filesystem access: without a valid one, every request gets the same 403
    # (no existence oracle, no slow lookups on the event loop). Issued URLs
    # carry resolved paths, so a legitimate request resolves to itself.
    if "\0" in rest:
        raise web.HTTPForbidden()
    lexical = Path(os.path.normpath("/" + rest))
    if _lexically_denied(lexical) or not _mac_ok(lexical, mode, exp, mac):
        raise web.HTTPForbidden()
    try:
        path = await asyncio.to_thread(resolve_doc, str(lexical))
    except web.HTTPException:
        raise web.HTTPNotFound()
    # the deny walk stats files
    protected = await asyncio.to_thread(_authorize, path, mode, exp, mac)
    handle = await asyncio.to_thread(_open_checked, path, protected)
    try:
        return await _respond(request, path, handle)
    except BaseException:
        handle.close()
        raise


def _nofollow(name, flags):
    # O_NONBLOCK: a FIFO swapped in after the checks would otherwise block this
    # thread forever on open (S_ISREG then refuses it); no effect on regular files
    return os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK)


def _open_checked(path, protected=frozenset()):
    """Open ``path`` once, never through a symlink, and only if the descriptor
    still is the checked path (nothing swapped between the checks and the open)
    and is not a protected file.

    The opened file and the directories above it, up to the view root, are
    compared with ``protected``, the identities read by the checks, and with a
    fresh read: a hard link to a protected file, or a protected directory renamed
    into place after the checks, is refused even though the name still matches."""
    try:
        handle = open(path, "rb", opener=_nofollow)
    except OSError:
        raise web.HTTPNotFound()
    try:
        servable = _descriptor_servable(handle.fileno(), path, protected)
    except BaseException:
        handle.close()
        raise
    if not servable:
        handle.close()
        raise web.HTTPNotFound()
    return handle


def _descriptor_servable(fd, path, protected):
    """``fd`` is the regular file named ``path``, neither it nor a directory it is
    reached through protected, then or now.

    The name is compared last: a protected directory moved into place before the
    open and away again before the ancestor check leaves the descriptor named
    after its new place."""
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            return False
        known = protected | _deny_inodes()
        if (opened.st_dev, opened.st_ino) in known or _reached_through(path, known):
            return False
        return _descriptor_is(fd, path)
    except OSError:
        return False


def _reached_through(path, identities):
    """Whether a directory between ``path`` and its view root is one of ``identities``.

    A directory refused by name only (DENY_NOT_WALKED) is known by its own
    identity, not its files': renamed into place after the checks, it is found here.
    Directories inside it have no recorded identity and are not.

    ``os.stat``, not ``os.lstat``: a symbolic link to a protected directory is known
    by its target. The recorded identities are targets too, so the link's own
    identity never matches and ``lstat`` would add nothing."""
    root = _root_of(path)
    for parent in path.parents:
        st = os.stat(parent)
        if (st.st_dev, st.st_ino) in identities:
            return True
        if parent == root:
            break
    return False


_PLATFORM = sys.platform
_MAXPATHLEN = 1024      # macOS sys/param.h: the buffer F_GETPATH fills


def _descriptor_is(fd, path):
    """Whether the open descriptor ``fd`` is the file now named ``path``.

    Linux: the descriptor's /proc link. macOS has no /proc: F_GETPATH gives the
    file's current name, which stays stale after an unlink, so the file found at
    ``path`` must also be this very file. Any other platform cannot tell: no."""
    if _PLATFORM == "linux":
        return os.readlink(f"/proc/self/fd/{fd}") == str(path)
    if _PLATFORM == "darwin":
        named = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(_MAXPATHLEN)).split(b"\0", 1)[0]
        if os.fsdecode(named) != str(path):
            return False
        here, there = os.fstat(fd), os.lstat(path)
        return (here.st_dev, here.st_ino) == (there.st_dev, there.st_ino)
    return False


def _descriptor_path(fd):
    """A name that reopens the open descriptor ``fd`` itself, never a path lookup.

    macOS's /dev/fd/N duplicates the descriptor (shared offset): aiohttp reads
    and sends at explicit offsets, so that is harmless."""
    return f"/proc/self/fd/{fd}" if _PLATFORM == "linux" else f"/dev/fd/{fd}"


class _DescriptorResponse(web.FileResponse):
    """Serves the checked, already open file, and nothing else.

    aiohttp reopens the descriptor (``_descriptor_path``): the same open file
    whatever happens to the path since. Its ``.gz``/``.br`` sibling negotiation
    is disabled."""

    def __init__(self, handle, content_type, headers):
        super().__init__(_descriptor_path(handle.fileno()),
                         headers={**headers, "Content-Type": content_type})
        self._handle = handle

    def _get_file_path_stat_encoding(self, accept_encoding):
        return super()._get_file_path_stat_encoding("")

    async def prepare(self, request):
        try:
            return await super().prepare(request)
        finally:
            self._handle.close()


# Rendered types whose source can be asked for instead (?source=1): shown in Monaco.
SOURCE_LANG = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html", ".svg": "xml"}


async def _respond(request, path, handle):
    headers = dict(VIEW_HEADERS)
    ext = path.suffix.lower()
    if "source" in request.query and ext in SOURCE_LANG and _is_navigation(request):
        return await _code_response(request, path, handle, headers, SOURCE_LANG[ext])
    if ext in MD_EXT and "raw" not in request.query and _size(handle) <= MD_MAX_BYTES:
        with handle:
            text = (await asyncio.to_thread(handle.read)).decode("utf-8", errors="replace")
        nonce = secrets.token_urlsafe(16)
        return web.Response(text=markdown_page(path, text, nonce), content_type="text/html",
                            headers={**headers, "Content-Security-Policy": markdown_csp(nonce)})
    if ext in MD_EXT:      # ?raw=1, or too large to render: the bytes, streamed
        return _DescriptorResponse(handle, "text/plain; charset=utf-8",
                                   {**headers, "Content-Security-Policy": active_csp()})
    if (ext in DIFF_EXT and "raw" not in request.query and _is_navigation(request)
            and _size(handle) <= DIFF_MAX_BYTES):
        with handle:
            text = (await asyncio.to_thread(handle.read)).decode("utf-8", errors="replace")
        nonce = secrets.token_urlsafe(16)
        # the same policy as rendered Markdown: only this page's own scripts run
        return web.Response(text=diff_page(path, text, nonce), content_type="text/html",
                            headers={**headers, "Content-Security-Policy": markdown_csp(nonce)})
    language = codeview.language_for(path)
    if language and _is_navigation(request):
        return await _code_response(request, path, handle, headers, language)
    served_type = content_type(path)
    if ext in {".html", ".htm"} and _is_frame_navigation(request):
        return await _history_html_response(request, handle, headers, served_type)
    if not is_inert(served_type):
        # everything gets an opaque origin, whatever it is typed as; only the
        # listed PDF and image types are left alone for the browser's viewer
        headers["Content-Security-Policy"] = active_csp()
    return _DescriptorResponse(handle, served_type, headers)


def _is_navigation(request):
    """The request loads a page (the panel's frame, a tab), not a subresource:
    an HTML report's style.css or app.js must get the file, not a viewer."""
    return request.headers.get("Sec-Fetch-Dest", "document") in ("document", "iframe", "frame")


def _is_frame_navigation(request):
    """Whether a local HTML page is loaded into the Mesh's document iframe.

    Top-level views retain their bytes exactly. In a frame we inject a small
    history bridge: the opaque-origin sandbox otherwise prevents the Mesh from
    offering a reliable Previous button after a user follows a local link.
    """
    return (request.method == "GET" and "Range" not in request.headers
            and request.headers.get("Sec-Fetch-Dest") in ("iframe", "frame"))


async def _history_html_response(request, handle, headers, content_type):
    """Stream a checked HTML descriptor with its bridge before its first content.

    The file descriptor has already passed the no-follow/identity checks. Do
    not reread it by path: a file replacement after authorization must never
    affect the response. This response intentionally applies only to framed
    HTML, not direct downloads or a document opened in its own tab.
    """
    response = web.StreamResponse(headers={**headers, "Content-Type": content_type,
                                            "Content-Security-Policy": active_csp()})
    try:
        # One ordinary stream chunk is enough to recognize the document start.
        # It lets the bridge install its click/message listeners before a link
        # or subresource in the caller's bytes can race it during parsing.
        first = await asyncio.to_thread(handle.read, 64 * 1024)
        offset = _history_bridge_offset(first)
        await response.prepare(request)
        if offset is None:
            await response.write(first)
        else:
            await response.write(first[:offset])
            await response.write(FRAME_HISTORY_BRIDGE)
            await response.write(first[offset:])
        while chunk := await asyncio.to_thread(handle.read, 64 * 1024):
            await response.write(chunk)
        await response.write_eof()
    finally:
        handle.close()
    return response


def _history_bridge_offset(first):
    """A safe early insertion point for the Mesh-only framed-HTML bridge.

    HTML that has an explicit ``html`` or ``head`` start tag keeps it.  A
    doctype-only fragment receives the bridge immediately after its doctype,
    which preserves standards mode while making the listener precede its first
    document element.  Files without any recognized prologue receive it first;
    they already rely on the browser's implicit HTML structure.  UTF-16/32
    documents return ``None``: injecting UTF-8 source would corrupt their
    encoding, so they are streamed unchanged without history support.
    """
    if first.startswith(_FRAME_MULTIBYTE_BOMS):
        return None
    start = len(_FRAME_UTF8_BOM) if first.startswith(_FRAME_UTF8_BOM) else 0
    doctype_start = _frame_prefix_end(first, start)
    if doctype := _frame_named_tag_end(first, doctype_start, b"!doctype"):
        start = doctype
    prologue = _frame_prefix_end(first, start)
    if html := _frame_named_tag_end(first, prologue, b"html"):
        head_start = _frame_prefix_end(first, html)
        return _frame_named_tag_end(first, head_start, b"head") or html
    if head := _frame_named_tag_end(first, prologue, b"head"):
        return head
    return start


def _frame_prefix_end(first, start):
    """Skip leading ASCII whitespace and complete comments in one pass.

    An incomplete comment is deliberately left in place: falling back to the
    caller's insertion point is safer than treating document bytes as a tag.
    """
    position = start
    while True:
        while position < len(first) and first[position] in _FRAME_SPACE:
            position += 1
        if not first.startswith(b"<!--", position):
            return position
        comment_end = first.find(b"-->", position + 4)
        if comment_end < 0:
            return start
        position = comment_end + 3


def _frame_named_tag_end(first, start, name):
    """Return the end of a simple start/declaration tag, or ``None``.

    Only quotes and the closing ``>`` matter here.  The scanner is intentionally
    smaller than an HTML parser, but walks each byte at most once and never
    mistakes a ``>`` within a quoted attribute for the tag boundary.
    """
    name_end = start + 1 + len(name)
    if not first.startswith(b"<", start) or first[start + 1:name_end].lower() != name:
        return None
    if name_end == len(first) or first[name_end] not in _FRAME_TAG_BOUNDARY:
        return None
    quote = None
    position = name_end
    while position < len(first):
        char = first[position]
        if quote is not None:
            if char == quote:
                quote = None
        elif char in (ord("\""), ord("'")):
            quote = char
        elif char == ord(">"):
            return position + 1
        elif char == ord("<"):
            return None
        position += 1
    return None


MD_MAX_BYTES = 4 * 1024 * 1024    # larger Markdown is served as plain text
DIFF_MAX_BYTES = 4 * 1024 * 1024  # a larger diff goes to the code viewer, or as plain text


def _size(handle):
    return os.fstat(handle.fileno()).st_size


async def _code_response(request, path, handle, headers, language):
    """A source file: Monaco, read-only (codeview.py). ?raw=1, anything too
    large for the viewer, and content that is not text are streamed whole
    from the descriptor as plain text (never truncated, never downloaded)."""
    head, size = await asyncio.to_thread(lambda: (os.pread(handle.fileno(), 8192, 0), _size(handle)))
    if "raw" in request.query or size > codeview.MAX_BYTES or not codeview.is_text(head):
        return _DescriptorResponse(handle, "text/plain; charset=utf-8",
                                   {**headers, "Content-Security-Policy": active_csp()})
    with handle:
        data = await asyncio.to_thread(handle.read)
    nonce = secrets.token_urlsafe(16)
    page = codeview.code_page(path, data.decode("utf-8", errors="replace"), nonce, language)
    return web.Response(text=page, content_type="text/html",
                        headers={**headers, "Content-Security-Policy": codeview.code_csp(nonce, SANDBOX_DOC)})


def markdown_page(path, text, nonce):
    """Self-contained page that renders the markdown in the browser (marked,
    highlight.js, mermaid, DOMPurify). Relative images and links resolve next
    to the file. Placeholders are filled in one pass: a substituted value is
    never rescanned, so a file named "{{src}}.md" stays a title."""
    # "</" would close the script element; "<!--" would switch the HTML parser
    # to the double-escaped script state and run the block into the next tags
    src = json.dumps(text).replace("</", "<\\/").replace("<!--", "<\\u0021--")
    values = {"title": html_escape(path.name), "src": src, "nonce": nonce}
    return PLACEHOLDER_RE.sub(lambda match: values[match[1]], MD_TEMPLATE)


def diff_page(path, text, nonce):
    """Self-contained page that renders a unified diff in the browser
    (static/diff-view.ts). The diff is embedded as JSON, like markdown_page."""
    src = (json.dumps(text).replace("</", "<\\/").replace("<!--", "<\\u0021--"))
    values = {"title": html_escape(path.name), "src": src, "nonce": nonce}
    return PLACEHOLDER_RE.sub(lambda match: values[match[1]], DIFF_TEMPLATE)


def html_escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


MD_TEMPLATE = (STATIC / "markdown.html").read_text()
DIFF_TEMPLATE = (STATIC / "diff.html").read_text()
PLACEHOLDER_RE = re.compile(r"\{\{(title|src|nonce)\}\}")


async def viewlib(request):
    """The renderer's libraries, for sandboxed documents (which carry no cookie)."""
    name = request.match_info["name"]
    if name in VIEWLIB_OWN:
        return web.FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})
    if name not in VIEWLIB:
        raise web.HTTPNotFound()
    return web.FileResponse(STATIC / "vendor" / name, headers={"Cache-Control": "max-age=86400"})
