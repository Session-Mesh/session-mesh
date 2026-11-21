# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""How the owner organises mesh sessions: display names, folders, order.

ptyhost names a session once, at creation, and is not restarted lightly
(that would end every session), so a rename is a label shown instead of the
generated name. Labels, folder membership and order are kept server-side in
~/.config/session-mesh/mesh.json so every device shows the same list. Each
entry is bound to the session's creation time: a later session that reuses
a name does not inherit a stale label or folder; a session that continues
another incarnation (its agent restarted in the same terminal, or a
replacement session) takes that entry over (carry). Folding a folder is a
per-browser preference and lives in the page, not here.

    {"folders": ["projects", "notes"],          # folder order
     "sessions": {"<ptyhost name>": {"created": 1790..., "label": "...",
                                     "folder": "projects"}},
     "order": ["<ptyhost name>", ...]}       # session order, all folders
"""

import contextlib
import fcntl
import json
import re
import threading
import time

import meshpaths
import fsutil
import conversation_names

FILE = meshpaths.CONF_DIR / "mesh.json"
MAX_LEN = 60
CARRY_GRACE = 30    # seconds: how old a listing of unknown read time may be (_forget_dead)
_lock = threading.Lock()


def clean(text):
    """Collapse whitespace, drop control characters, cap the length."""
    text = re.sub(r"[\t\n\r]", " ", str(text or ""))   # whitespace controls separate words
    # C0/C1 controls (U+009B is a CSI for terminals: mesh-attach -l prints labels) and
    # bidi overrides/isolates, which reorder what a terminal or the page shows
    text = re.sub(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", text)
    return " ".join(text.split())[:MAX_LEN]


_EMPTY = {"folders": list, "sessions": dict, "order": list}


@contextlib.contextmanager
def _locked():
    """Serialise load-modify-save across threads and processes (the server,
    mesh-rename, mesh-attach -l all touch mesh.json)."""
    with _lock:
        try:
            FILE.parent.mkdir(parents=True, exist_ok=True)
            lockfile = open(FILE.with_name(FILE.name + ".lock"), "a")
        except OSError:          # read-only config dir: reading still works, thread lock only
            yield
            return
        with lockfile:
            fcntl.flock(lockfile, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lockfile, fcntl.LOCK_UN)


def _load():
    try:
        data = json.loads(FILE.read_text())
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError):
        data = None
    if data is not None and (not isinstance(data, dict) or any(
            key in data and not isinstance(data[key], kind) for key, kind in _EMPTY.items())):
        data = None
    if data is None:
        # unreadable or not the expected shape: set it aside, never overwrite it silently
        try:
            FILE.replace(FILE.with_name(f"{FILE.name}.corrupt-{int(time.time())}"))
        except OSError:
            pass
        data = {}
    for key, kind in _EMPTY.items():
        data.setdefault(key, kind())
    # names stored before the current cleaning rules would never match a request
    # (every op cleans its input): clean them on the way in
    data["folders"] = list(dict.fromkeys(clean(f) for f in data["folders"] if isinstance(f, str) and clean(f)))
    for entry in data["sessions"].values():
        if isinstance(entry, dict):
            for key in ("label", "folder"):
                if isinstance(entry.get(key), str):
                    entry[key] = clean(entry[key]) or None
    return data


def _save(data):
    fsutil.atomic_write(FILE, json.dumps(data, ensure_ascii=False, indent=1))


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _later(created, than):
    """Whether ``created`` is a later incarnation than ``than`` (both creation times)."""
    return _number(created) and _number(than) and created > than


def _kept(entry, listed, read_at):
    """Whether ``entry`` stays for ``listed``, the incarnation of its name in a listing of the host read at
    ``read_at`` (None: not listed). It does for that incarnation, and for an entry the listing cannot judge: bound
    to a later incarnation of the name, or bound (carry) after the host was read, maybe to a replacement session
    the listing does not show yet. A listed later incarnation proves the entry's session gone."""
    created = entry.get("created")
    if listed is not None and (created == listed or _later(created, listed)):
        return True
    if listed is not None and _later(listed, created):
        return False
    return _number(entry.get("bound_at")) and entry["bound_at"] > read_at


def _forget_dead(data, live, read_at=None):
    """Drop entries of sessions that ended (or whose name was reused). ``read_at``: when the host was asked for
    ``live``; unknown, it is taken as CARRY_GRACE seconds ago (a listing is read within the host's timeout)."""
    read_at = time.time() - CARRY_GRACE if read_at is None else read_at
    data["sessions"] = {n: v for n, v in data["sessions"].items()
                        if isinstance(v, dict) and _kept(v, live.get(n), read_at)}
    # bound to the creation time like the rest: a reused name starts unranked
    data["order"] = [n for n in data["order"] if n in data["sessions"]]


def view(sessions, prune=True, read_at=None):
    """Organisation for the live ptyhost sessions: folders in order, and per
    session its label, folder and rank. With prune, entries of sessions that
    ended are forgotten and saved; only pass it for a listing that succeeded
    (an empty list from a failed request would wipe everything). ``read_at``:
    the wall-clock time just before the host was asked for that listing."""
    live = {s["name"]: s["created"] for s in sessions}
    with _locked():
        data = _load()
        if prune:
            before = json.dumps(data, sort_keys=True)
            _forget_dead(data, live, read_at)
            if json.dumps(data, sort_keys=True) != before:
                _save(data)
    rank = {n: i for i, n in enumerate(data["order"])}
    meta = {n: {"label": v.get("label"), "folder": v.get("folder"), "rank": rank.get(n)}
            for n, v in data["sessions"].items()}
    for n in live:
        meta.setdefault(n, {"label": None, "folder": None, "rank": rank.get(n)})
    return {"folders": data["folders"], "sessions": meta}


def _entry(data, name, created):
    """The entry of the session ``name`` listed as incarnation ``created``, made when it has none. An entry bound to
    a later incarnation (a restart's carry, after that list was read) is the same session's: it is the one changed."""
    e = data["sessions"].get(name)
    if isinstance(e, dict) and _later(e.get("created"), created):
        return e
    if not e or e.get("created") != created:
        e = data["sessions"][name] = {"created": created}
    return e


def _carried_rank(data, source, saved):
    """Where the session ``source`` (name, created) stood in the order: its place there while its entry is still
    bound to it (it then leaves the order), else the rank ``saved`` gives; None for an unranked one."""
    name, created = source
    entry = data["sessions"].get(name)
    if name in data["order"] and isinstance(entry, dict) and entry.get("created") == created:
        rank = data["order"].index(name)
        data["order"].remove(name)
        return rank
    rank = saved.get("rank")
    return rank if isinstance(rank, int) and not isinstance(rank, bool) and rank >= 0 else None


def arrangement(name, created):
    """The label, folder and rank of the session (name, created), None when it has no entry bound to it."""
    with _locked():
        data = _load()
    entry = data["sessions"].get(name)
    if not isinstance(entry, dict) or entry.get("created") != created:
        return None
    return {"label": entry.get("label"), "folder": entry.get("folder"),
            "rank": data["order"].index(name) if name in data["order"] else None}


def carry(source, target, saved):
    """Give the session ``target`` (name, created) the label, folder and rank of ``source`` (name, created), which
    it continues: the new incarnation of a session whose agent restarted in the same terminal (same name, a new
    created), or the session that replaced it. They come from the entry of ``source`` while it is still bound to
    it, else from ``saved`` (arrangement() of ``source`` read before the restart: a listing may have pruned the
    entry since). An arrangement already bound to ``target`` is the owner's latest word and stays."""
    saved = saved if isinstance(saved, dict) else {}
    with _locked():
        data = _load()
        current = data["sessions"].get(target[0])
        if isinstance(current, dict) and current.get("created") == target[1]:
            return
        old = data["sessions"].get(source[0])
        old = old if isinstance(old, dict) and old.get("created") == source[1] else saved
        if not old:
            return
        label, folder = (clean(old[key]) if isinstance(old.get(key), str) else "" for key in ("label", "folder"))
        if target[0] != source[0] and target[0] in data["order"]:   # a stale place must not shift the source's
            data["order"].remove(target[0])
        rank = _carried_rank(data, source, saved)
        entry = data["sessions"][target[0]] = {"created": target[1], "bound_at": time.time(),
                                               "folder": folder if folder in data["folders"] else None}
        if label:
            entry["label"] = label
        if target[0] in data["order"]:
            data["order"].remove(target[0])
        if rank is not None:
            data["order"].insert(min(rank, len(data["order"])), target[0])
        _save(data)


def _place(order, name, before):
    if name in order:
        order.remove(name)
    order.insert(order.index(before) if before in order else len(order), name)


def apply(op, sessions):
    """Apply one change. `sessions` are the live ptyhost sessions. Raises
    ValueError with a user-facing message on a bad request."""
    if not isinstance(op, dict):
        raise ValueError("JSON object expected")
    for key in ("id", "label", "folder", "before", "name", "old", "new"):
        if op.get(key) is not None and not isinstance(op[key], str):
            raise ValueError(f"“{key}” must be a string")
    live = {s["name"]: s["created"] for s in sessions}
    kind = op.get("op")
    with _locked():
        data = _load()
        _forget_dead(data, live)
        folders = data["folders"]
        if kind in ("rename", "move"):
            name = str(op.get("id", ""))
            if name not in live:
                raise ValueError("Mesh session not found")
            e = _entry(data, name, live[name])
            if kind == "rename":
                label = clean(op.get("label"))
                previous_label = e.get("label")
                if label:
                    e["label"] = label
                else:
                    e.pop("label", None)
            else:
                folder = clean(op.get("folder")) or None
                if folder and folder not in folders:
                    raise ValueError(f"Unknown folder: {folder}")
                e["folder"] = folder
                shown = op.get("order")
                if isinstance(shown, list) and all(isinstance(n, str) for n in shown):
                    # the order the page displays (ranked, then newest): adopt it whole, so a
                    # drop next to a never-moved session lands where it was dropped
                    data["order"] = [n for n in dict.fromkeys(shown) if n in live]
                    for n in data["order"]:      # ranked entries are bound to their creation time
                        _entry(data, n, live[n])
                _place(data["order"], name, op.get("before"))
        elif kind == "folder-add":
            folder = clean(op.get("name"))
            if not folder:
                raise ValueError("Empty folder name")
            if folder not in folders:
                folders.append(folder)
        elif kind == "folder-rename":
            old, new = clean(op.get("old")), clean(op.get("new"))
            if old not in folders or not new:
                raise ValueError("Unknown folder or empty name")
            if new in folders and new != old:
                raise ValueError(f"The folder “{new}” already exists")
            folders[folders.index(old)] = new
            for e in data["sessions"].values():
                if e.get("folder") == old:
                    e["folder"] = new
        elif kind == "folder-remove":
            folder = clean(op.get("name"))
            if folder in folders:
                folders.remove(folder)
            for e in data["sessions"].values():  # its sessions go back to the top level
                if e.get("folder") == folder:
                    e["folder"] = None
        elif kind == "folder-move":
            folder, before = clean(op.get("name")), clean(op.get("before"))
            if folder not in folders:
                raise ValueError("Unknown folder")
            folders.remove(folder)
            folders.insert(folders.index(before) if before in folders else len(folders), folder)
        else:
            raise ValueError(f"Unknown operation: {kind}")
        _save(data)
        if kind == "rename":
            conversation_names.rename(name, live[name], previous_label, label)
    return view(sessions)
