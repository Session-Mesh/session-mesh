# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Bounded, non-executable demo scenes attached to a live session incarnation.

No supported format admits HTML, CSS or JavaScript. ``mesh-scene-v1`` adds a
bounded local state machine; v2 adds only the host-owned gear primitive.
"""

import base64
import contextlib
import fcntl
import hashlib
import html
import json
import math
import os
import stat
import threading
import unicodedata
import uuid
from pathlib import Path

import meshpaths
import fsutil

FILE = meshpaths.CONF_DIR / "demo-scenes.json"
MAX_BYTES = 64 * 1024
MAX_NODES = 100
MAX_DEPTH = 6
MAX_TEXT = 2000
HISTORY_LIMIT = 64
MAX_STORE_BYTES = 8 * 1024 * 1024
MAX_SCENES = 100
MAX_DEMOS_PER_SESSION = 8
MAX_CATALOGS = 100
MAX_SAFE_INTEGER = (1 << 53) - 1
MAX_STATES = 16
MAX_CHOICES = 32
MAX_ID = 32
_lock = threading.Lock()
_STATIC = Path(__file__).with_name("static")
_VIEW_JS = (_STATIC / "demo-view.js").read_text(encoding="utf-8")
_VIEW_CSS = (_STATIC / "demo-view.css").read_text(encoding="utf-8")
if "</script" in _VIEW_JS.lower() or "</style" in _VIEW_CSS.lower():
    raise RuntimeError("Demo rendering resource cannot be embedded")
_VIEW_JS_HASH = base64.b64encode(hashlib.sha256(_VIEW_JS.encode()).digest()).decode("ascii")
_VIEW_CSS_HASH = base64.b64encode(hashlib.sha256(_VIEW_CSS.encode()).digest()).decode("ascii")


class NotLive(Exception):
    pass


class Conflict(Exception):
    pass


class StorageError(Exception):
    pass


class CapacityError(Exception):
    pass


class DemoNotFound(Exception):
    pass


def _valid_demo_id(demo_id):
    return (isinstance(demo_id, str) and len(demo_id) == 32
            and all(ch in "0123456789abcdef" for ch in demo_id))


def _revision(value):
    if (not isinstance(value, int) or isinstance(value, bool)
            or not 1 <= value <= MAX_SAFE_INTEGER):
        raise ValueError("Invalid demo revision")
    return value


def _text(value, limit=MAX_TEXT):
    return isinstance(value, str) and len(value) <= limit and not any(ord(ch) < 32 and ch not in '\n\t' for ch in value)


def _runtime_text(value, limit=MAX_TEXT):
    if not isinstance(value, str):
        return False
    try:
        return (len(value.encode("utf-8")) <= limit
                and not any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp")
                            for ch in value))
    except UnicodeEncodeError:
        return False


def _node(raw, depth, count, *, interactive=False, view_version=1):
    count[0] += 1
    if count[0] > MAX_NODES or depth > MAX_DEPTH or not isinstance(raw, dict):
        raise ValueError("Invalid demo scene")
    kind = raw.get("type")
    if kind in ("heading", "text", "badge", "shape"):
        valid_text = _runtime_text if interactive and view_version == 2 else _text
        if set(raw) != {"type", "text"} or not valid_text(raw["text"]):
            raise ValueError("Invalid demo scene")
    elif kind == "divider":
        if set(raw) != {"type"}:
            raise ValueError("Invalid demo scene")
    elif kind == "gear" and interactive and view_version == 2:
        if (set(raw) != {"type", "angle"} or not isinstance(raw["angle"], int)
                or isinstance(raw["angle"], bool) or not 0 <= raw["angle"] <= 359):
            raise ValueError("Invalid demo scene")
    elif kind == "disclosure" and not interactive:
        if (set(raw) != {"type", "summary", "children"} or not _text(raw["summary"], 120)
                or not raw["summary"].strip() or not isinstance(raw["children"], list)
                or len(raw["children"]) > 30):
            raise ValueError("Invalid demo scene")
        for child in raw["children"]:
            _node(child, depth + 1, count, interactive=interactive, view_version=view_version)
    elif kind == "checklist" and not interactive:
        if (set(raw) != {"type", "items"} or not isinstance(raw["items"], list)
                or not 1 <= len(raw["items"]) <= 20
                or any(not _text(item, 120) or not item.strip() for item in raw["items"])):
            raise ValueError("Invalid demo scene")
    elif kind == "progress" and not interactive:
        if (set(raw) != {"type", "label", "value"}
                or not _text(raw["label"], 120) or not raw["label"].strip()
                or not isinstance(raw["value"], int) or isinstance(raw["value"], bool)
                or not 0 <= raw["value"] <= 100):
            raise ValueError("Invalid demo scene")
    elif kind == "metric" and not interactive:
        if (set(raw) != {"type", "label", "value"}
                or not _text(raw["label"], 120) or not raw["label"].strip()
                or not _text(raw["value"], 120) or not raw["value"].strip()):
            raise ValueError("Invalid demo scene")
    elif kind == "status" and not interactive:
        if (set(raw) != {"type", "label", "state"}
                or not _text(raw["label"], 120) or not raw["label"].strip()
                or raw["state"] not in ("info", "success", "warning", "danger")):
            raise ValueError("Invalid demo scene")
    elif kind in ("card", "row", "column"):
        if set(raw) != {"type", "children"} or not isinstance(raw["children"], list) or len(raw["children"]) > 30:
            raise ValueError("Invalid demo scene")
        for child in raw["children"]:
            _node(child, depth + 1, count, interactive=interactive, view_version=view_version)
    else:
        raise ValueError("Invalid demo scene")


def _short_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= MAX_ID
            and value[0].isascii() and value[0].isalpha()
            and all(ch.isascii() and (ch.isalnum() or ch in "_-") for ch in value))


def _validate_interactive(raw, scene_version):
    if set(raw) != {"format", "version", "title", "theme", "initial", "states"}:
        raise ValueError("Invalid demo scene")
    valid_text = _runtime_text if scene_version == 2 else _text
    if (not isinstance(raw["version"], int) or isinstance(raw["version"], bool)
            or raw["version"] < 0 or not valid_text(raw["title"], 120)
            or raw["theme"] not in ("dark", "light") or not _short_id(raw["initial"])
            or not isinstance(raw["states"], list) or not 1 <= len(raw["states"]) <= MAX_STATES):
        raise ValueError("Invalid demo scene")
    ids = []
    choices = 0
    count = [0]
    for state in raw["states"]:
        if (not isinstance(state, dict) or set(state) != {"id", "view", "choices"}
                or not _short_id(state["id"]) or not isinstance(state["view"], dict)
                or set(state["view"]) != {"format", "nodes"}
                or state["view"]["format"] != f"mesh-view-v{scene_version}"
                or not isinstance(state["view"]["nodes"], list)
                or len(state["view"]["nodes"]) > 30
                or not isinstance(state["choices"], list)):
            raise ValueError("Invalid demo scene")
        ids.append(state["id"])
        for node in state["view"]["nodes"]:
            _node(node, 0, count, interactive=True, view_version=scene_version)
        choices += len(state["choices"])
        for choice in state["choices"]:
            if (not isinstance(choice, dict) or set(choice) != {"label", "target"}
                    or not valid_text(choice["label"], 120) or not choice["label"].strip()
                    or not _short_id(choice["target"])):
                raise ValueError("Invalid demo scene")
    if len(set(ids)) != len(ids) or raw["initial"] not in ids or choices > MAX_CHOICES:
        raise ValueError("Invalid demo scene")
    if any(choice["target"] not in ids for state in raw["states"] for choice in state["choices"]):
        raise ValueError("Invalid demo scene")


def validate(raw):
    if not isinstance(raw, dict):
        raise ValueError("Invalid demo scene")
    if raw.get("format") in ("mesh-scene-v1", "mesh-scene-v2"):
        _validate_interactive(raw, 1 if raw["format"] == "mesh-scene-v1" else 2)
    elif set(raw) != {"format", "version", "title", "theme", "nodes"}:
        raise ValueError("Invalid demo scene")
    elif (raw["format"] != "mesh-scene-v0" or not isinstance(raw["version"], int)
            or isinstance(raw["version"], bool) or raw["version"] < 0
            or not _text(raw["title"], 120) or raw["theme"] not in ("dark", "light")
            or not isinstance(raw["nodes"], list) or len(raw["nodes"]) > 30):
        raise ValueError("Invalid demo scene")
    if raw.get("format") == "mesh-scene-v0":
        count = [0]
        for node in raw["nodes"]:
            _node(node, 0, count)
    try:
        encoded = json.dumps(raw, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid demo scene") from exc
    if len(encoded) > MAX_BYTES:
        raise ValueError("Demo scene too large")
    return json.loads(encoded)


def empty():
    return {"format": "mesh-scene-v0", "version": 0, "title": "Demo", "theme": "dark", "nodes": []}


def _live(sessions):
    return {row["name"]: row["created"] for row in sessions
            if isinstance(row, dict) and isinstance(row.get("name"), str)
            and isinstance(row.get("created"), (float, int))
            and not isinstance(row["created"], bool) and math.isfinite(row["created"])}


def _key(name, created):
    # This is a JSON map key, never a path. A reused human-readable name cannot
    # overwrite a previous incarnation's revisions.
    return json.dumps([name, float(created)], separators=(",", ":"), ensure_ascii=False)


def _private_stat(st, mode, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode
            or (not directory and st.st_nlink != 1)):
        raise StorageError("Demo storage is not private")


@contextlib.contextmanager
def _locked():
    with _lock:
        try:
            FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _private_stat(FILE.parent.lstat(), 0o700, directory=True)
            lock_path = FILE.with_name(FILE.name + ".lock")
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            with os.fdopen(fd, "r+") as lockfile:
                _private_stat(os.fstat(lockfile.fileno()), 0o600)
                fcntl.flock(lockfile, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lockfile, fcntl.LOCK_UN)
        except OSError as exc:
            raise StorageError("Demo storage unavailable") from exc


def _load():
    try:
        fd = os.open(FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, "rb") as source:
            st = os.fstat(source.fileno())
            _private_stat(st, 0o600)
            if st.st_size > MAX_STORE_BYTES:
                raise StorageError("Demo storage too large")
            content = source.read(MAX_STORE_BYTES + 1)
            if len(content) > MAX_STORE_BYTES:
                raise StorageError("Demo storage too large")
            raw = json.loads(content)
    except FileNotFoundError:
        return {"format": 1, "scenes": {}}
    except (OSError, ValueError) as exc:
        raise StorageError("Demo storage unreadable") from exc
    if not isinstance(raw, dict) or set(raw) != {"format", "scenes"} or raw["format"] != 1 or not isinstance(raw["scenes"], dict):
        raise StorageError("Invalid demo storage")
    if len(raw["scenes"]) > MAX_SCENES:
        raise StorageError("Invalid demo storage")
    for key, item in raw["scenes"].items():
        if (not isinstance(key, str) or not isinstance(item, dict) or set(item) != {"name", "created", "revisions"}
                or not isinstance(item["name"], str)
                or not isinstance(item["created"], (int, float)) or isinstance(item["created"], bool)
                or not math.isfinite(item["created"]) or _key(item["name"], item["created"]) != key
                or not isinstance(item["revisions"], list)
                or not 1 <= len(item["revisions"]) <= HISTORY_LIMIT):
            raise StorageError("Invalid demo storage")
        try:
            revisions = [validate(scene) for scene in item["revisions"]]
        except ValueError as exc:
            raise StorageError("Invalid demo storage") from exc
        if any(revisions[i]["version"] + 1 != revisions[i + 1]["version"] for i in range(len(revisions) - 1)):
            raise StorageError("Invalid demo storage")
    return raw


def _catalog_file():
    return FILE.with_name("demo-catalogs.json")


def _load_catalog():
    path = _catalog_file()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, "rb") as source:
            st = os.fstat(source.fileno())
            _private_stat(st, 0o600)
            if st.st_size > MAX_STORE_BYTES:
                raise StorageError("Demo catalog too large")
            content = source.read(MAX_STORE_BYTES + 1)
            if len(content) > MAX_STORE_BYTES:
                raise StorageError("Demo catalog too large")
            raw = json.loads(content)
    except FileNotFoundError:
        return {"format": 1, "catalogs": {}}
    except (OSError, ValueError) as exc:
        raise StorageError("Demo catalog unreadable") from exc
    if not isinstance(raw, dict) or set(raw) != {"format", "catalogs"} or raw["format"] != 1:
        raise StorageError("Invalid demo catalog")
    catalogs = raw["catalogs"]
    if not isinstance(catalogs, dict) or len(catalogs) > MAX_CATALOGS:
        raise StorageError("Invalid demo storage")
    for key, item in catalogs.items():
        if (not isinstance(key, str) or not isinstance(item, dict)
                or set(item) != {"name", "created", "demos"}
                or not isinstance(item["name"], str)
                or not isinstance(item["created"], (int, float)) or isinstance(item["created"], bool)
                or not math.isfinite(item["created"]) or _key(item["name"], item["created"]) != key
                or not isinstance(item["demos"], dict)
                or not 1 <= len(item["demos"]) <= MAX_DEMOS_PER_SESSION):
            raise StorageError("Invalid demo storage")
        for demo_id, revisions in item["demos"].items():
            if (not _valid_demo_id(demo_id) or not isinstance(revisions, list)
                    or not 1 <= len(revisions) <= HISTORY_LIMIT):
                raise StorageError("Invalid demo storage")
            try:
                validated = [validate(scene) for scene in revisions]
            except ValueError as exc:
                raise StorageError("Invalid demo storage") from exc
            if (validated[0]["version"] != 1
                    or any(validated[i]["version"] + 1 != validated[i + 1]["version"]
                           for i in range(len(validated) - 1))):
                raise StorageError("Invalid demo storage")
    return raw


def _save(state):
    try:
        encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_STORE_BYTES:
            raise CapacityError("Demo capacity reached")
        fsutil.atomic_write(FILE, encoded)
    except OSError as exc:
        raise StorageError("Could not save the demo") from exc


def _save_catalog(state):
    try:
        encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_STORE_BYTES:
            raise CapacityError("Demo capacity reached")
        fsutil.atomic_write(_catalog_file(), encoded)
    except OSError as exc:
        raise StorageError("Could not save the catalog") from exc


def get(name, sessions, version=None):
    if version is not None and (not isinstance(version, int) or isinstance(version, bool) or version < 0):
        raise ValueError("Invalid demo revision")
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        item = _load()["scenes"].get(_key(name, created))
        revisions = item["revisions"] if item and item["created"] == created else [empty()]
        if version is None:
            return revisions[-1]
        return next((scene for scene in revisions if scene["version"] == version), None)


def revisions(name, sessions):
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        item = _load()["scenes"].get(_key(name, created))
        stored = item["revisions"] if item else [empty()]
        return {"format": stored[-1]["format"], "current": stored[-1]["version"],
                "versions": [entry["version"] for entry in stored]}


def replace(name, scene, sessions):
    scene = validate(scene)
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        state = _load()
        key = _key(name, created)
        item = state["scenes"].get(key)
        revisions = item["revisions"] if item and item["created"] == created else [empty()]
        if scene["version"] != revisions[-1]["version"]:
            raise Conflict()
        catalog = _load_catalog()["catalogs"].get(key) if key not in state["scenes"] else None
        if (len(revisions) >= HISTORY_LIMIT
                or (key not in state["scenes"] and len(state["scenes"]) >= MAX_SCENES)
                or (key not in state["scenes"] and catalog is not None
                    and len(catalog["demos"]) >= MAX_DEMOS_PER_SESSION)):
            raise CapacityError("Demo capacity reached")
        saved = {**scene, "version": scene["version"] + 1}
        state["scenes"][key] = {"name": name, "created": created, "revisions": [*revisions, saved]}
        _save(state)
        return saved


def list_demos(name, sessions):
    """List independent named histories plus an existing legacy scene, if any."""
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        state = _load()
        key = _key(name, created)
        rows = []
        legacy = state["scenes"].get(key)
        if legacy is not None:
            current = legacy["revisions"][-1]
            rows.append({"id": "legacy", "title": current["title"], "version": current["version"]})
        catalog = _load_catalog()["catalogs"].get(key)
        if catalog is not None:
            for demo_id, revisions in catalog["demos"].items():
                current = revisions[-1]
                rows.append({"id": demo_id, "title": current["title"], "version": current["version"]})
        return rows


def create_demo(name, scene, sessions):
    scene = validate(scene)
    if scene["version"] != 0:
        raise Conflict("A new demo starts at revision zero")
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        state = _load_catalog()
        key = _key(name, created)
        catalog = state["catalogs"].get(key)
        demos = catalog["demos"] if catalog is not None else {}
        if (len(demos) + int(key in _load()["scenes"]) >= MAX_DEMOS_PER_SESSION
                or (catalog is None and len(state["catalogs"]) >= MAX_CATALOGS)):
            raise CapacityError("Demo capacity reached")
        demo_id = uuid.uuid4().hex
        while demo_id in demos:
            demo_id = uuid.uuid4().hex
        saved = {**scene, "version": 1}
        state["catalogs"][key] = {"name": name, "created": created,
                                  "demos": {**demos, demo_id: [saved]}}
        _save_catalog(state)
        return {"id": demo_id, "scene": saved}


def get_demo(name, demo_id, sessions, version=None):
    if demo_id == "legacy":
        return get(name, sessions, version)
    if not _valid_demo_id(demo_id):
        raise ValueError("Invalid demo ID")
    if version is not None and (not isinstance(version, int) or isinstance(version, bool) or version < 1):
        raise ValueError("Invalid demo revision")
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        catalog = _load_catalog()["catalogs"].get(_key(name, created))
        revisions = catalog["demos"].get(demo_id) if catalog is not None else None
        if revisions is None:
            raise DemoNotFound()
        if version is None:
            return revisions[-1]
        return next((scene for scene in revisions if scene["version"] == version), None)


def update_demo(name, demo_id, scene, sessions):
    if demo_id == "legacy":
        return replace(name, scene, sessions)
    if not _valid_demo_id(demo_id):
        raise ValueError("Invalid demo ID")
    scene = validate(scene)
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        state = _load_catalog()
        catalog = state["catalogs"].get(_key(name, created))
        revisions = catalog["demos"].get(demo_id) if catalog is not None else None
        if revisions is None:
            raise DemoNotFound()
        if scene["version"] != revisions[-1]["version"]:
            raise Conflict()
        if len(revisions) >= HISTORY_LIMIT:
            raise CapacityError("Demo capacity reached")
        saved = {**scene, "version": scene["version"] + 1}
        catalog["demos"][demo_id] = [*revisions, saved]
        _save_catalog(state)
        return saved


def demo_revisions(name, demo_id, sessions):
    """Return only bounded metadata for one exact named-demo history."""
    if not _valid_demo_id(demo_id):
        raise ValueError("Invalid demo ID")
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        catalog = _load_catalog()["catalogs"].get(_key(name, created))
        revisions = catalog["demos"].get(demo_id) if catalog is not None else None
        if revisions is None:
            raise DemoNotFound()
        return {"demo_id": demo_id, "format": revisions[-1]["format"],
                "current": revisions[-1]["version"],
                "versions": [entry["version"] for entry in revisions]}


def restore_demo(name, demo_id, version, expected_version, sessions):
    """CAS-append an old named-demo revision as the next immutable revision."""
    if not _valid_demo_id(demo_id):
        raise ValueError("Invalid demo ID")
    version = _revision(version)
    expected_version = _revision(expected_version)
    created = _live(sessions).get(name)
    if created is None:
        raise NotLive()
    with _locked():
        state = _load_catalog()
        catalog = state["catalogs"].get(_key(name, created))
        revisions = catalog["demos"].get(demo_id) if catalog is not None else None
        if revisions is None:
            raise DemoNotFound()
        if revisions[-1]["version"] != expected_version:
            raise Conflict()
        restored = next((entry for entry in revisions if entry["version"] == version), None)
        if restored is None:
            raise DemoNotFound()
        if len(revisions) >= HISTORY_LIMIT:
            raise CapacityError("Demo capacity reached")
        saved = {**restored, "version": expected_version + 1}
        catalog["demos"][demo_id] = [*revisions, saved]
        _save_catalog(state)
        return saved


def _catalog_digest(catalog):
    heads = {demo_id: revisions[-1]["version"] for demo_id, revisions in catalog["demos"].items()}
    return hashlib.sha256(json.dumps(heads, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def archives():
    """Metadata for explicit local maintenance; never scene content."""
    with _locked():
        state = _load()
        catalogs = _load_catalog()["catalogs"]
        rows = {}
        for key, item in state["scenes"].items():
            rows[key] = {"name": item["name"], "created": item["created"],
                         "current": item["revisions"][-1]["version"],
                         "revisions": len(item["revisions"])}
        for key, item in catalogs.items():
            row = rows.setdefault(key, {"name": item["name"], "created": item["created"],
                                        "current": 0, "revisions": 0})
            row["demos"] = len(item["demos"])
            row["catalog_digest"] = _catalog_digest(item)
        return sorted(rows.values(), key=lambda row: (row["name"], row["created"]))


def delete_archive(name, created, expected_current, sessions, expected_catalog=None):
    """Remove one exact inactive incarnation after operator confirmation/CAS."""
    if (not isinstance(name, str) or not isinstance(created, (int, float))
            or isinstance(created, bool) or not math.isfinite(created)
            or not isinstance(expected_current, int) or isinstance(expected_current, bool)
            or expected_current < 0 or (expected_catalog is not None
                and (not isinstance(expected_catalog, str) or len(expected_catalog) != 64
                     or any(ch not in "0123456789abcdef" for ch in expected_catalog)))):
        raise ValueError("Invalid demo identity")
    if _live(sessions).get(name) == created:
        raise Conflict("Session still active")
    with _locked():
        state = _load()
        key = _key(name, created)
        item = state["scenes"].get(key)
        catalog_state = _load_catalog()
        catalog = catalog_state["catalogs"].get(key)
        current = item["revisions"][-1]["version"] if item is not None else 0
        if (item is None and catalog is None) or current != expected_current:
            raise Conflict("Archive missing or revision changed")
        if (catalog is None and expected_catalog is not None) or (catalog is not None
                and _catalog_digest(catalog) != expected_catalog):
            raise Conflict("Catalog missing or changed")
        if catalog is not None:
            # The old Web must keep reading format-1 scenes during rollback.
            # Delete only this separately persisted catalog, then the legacy
            # archive can be removed by a second explicit CAS operation.
            del catalog_state["catalogs"][key]
            _save_catalog(catalog_state)
            return "catalog"
        else:
            del state["scenes"][key]
            _save(state)
            return "legacy"


_CSS = """*{box-sizing:border-box}body{margin:0;padding:24px;background:#11151c;color:#e7edf6;font:16px/1.45 system-ui}body.light{background:#f5f7fa;color:#17212e}main{max-width:1100px;margin:auto}h1{font-size:28px;margin:0 0 20px}h2{font-size:22px;margin:0 0 12px}.card{border:1px solid #74809266;border-radius:14px;padding:18px;margin:8px;background:#7894b414}.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1 1 180px}.column{display:grid;gap:12px}.badge{display:inline-block;background:#68d6a633;border:1px solid #68d6a6;border-radius:99px;padding:4px 10px}.shape{display:grid;place-items:center;min-height:90px;border:2px solid #68d6a6;border-radius:24px;padding:16px;text-align:center}.metric{border:1px solid #74809266;border-radius:10px;padding:12px;margin:8px 0;overflow-wrap:anywhere}.metric-label{font-size:13px;opacity:.75}.metric-value{font-size:28px;font-weight:700;line-height:1.2;margin-top:3px}.status{display:flex;align-items:center;gap:9px;border:1px solid #74809266;border-radius:10px;padding:10px 12px;margin:12px 0;overflow-wrap:anywhere}.status::before{content:\"\";width:10px;height:10px;border-radius:50%;background:#73a7e8;flex:none}.status-success::before{background:#68d6a6}.status-warning::before{background:#f0b95d}.status-danger::before{background:#e77f88}details{border:1px solid #74809266;border-radius:10px;padding:10px 14px;margin:12px 0}summary{cursor:pointer;font-weight:650;padding:4px 0;overflow-wrap:anywhere}details[open]>summary{margin-bottom:10px}.checklist{display:grid;gap:8px;border:1px solid #74809266;border-radius:10px;padding:12px;margin:12px 0}.checklist label{display:flex;gap:9px;align-items:flex-start;overflow-wrap:anywhere}.checklist input{margin-top:4px;accent-color:#68d6a6}.progress{margin:12px 0}.progress-label{display:flex;justify-content:space-between;gap:12px;overflow-wrap:anywhere}.progress-track{height:10px;border-radius:99px;background:#74809266;overflow:hidden;margin-top:5px}.progress-fill{height:100%;background:#68d6a6;border-radius:inherit}p{white-space:pre-wrap;overflow-wrap:anywhere}hr{border:0;border-top:1px solid #74809266;margin:16px 0}header{font-size:12px;opacity:.7;margin-bottom:16px}"""
_CSS_HASH = hashlib.sha256(_CSS.encode()).digest()
_STYLE_HASH = base64.b64encode(_CSS_HASH).decode("ascii")


def _render_node(node):
    kind = node["type"]
    if kind == "disclosure":
        summary = html.escape(node["summary"], quote=True)
        children = "".join(_render_node(child) for child in node["children"])
        return f"<details><summary>{summary}</summary>{children}</details>"
    if kind == "checklist":
        items = "".join(
            f'<label><input type="checkbox"><span>{html.escape(item, quote=True)}</span></label>'
            for item in node["items"])
        return f'<div class="checklist">{items}</div>'
    if kind == "progress":
        label = html.escape(node["label"], quote=True)
        value = node["value"]
        return (f'<div class="progress" role="progressbar" aria-label="{label}" '
                f'aria-valuemin="0" aria-valuemax="100" aria-valuenow="{value}">'
                f'<div class="progress-label"><span>{label}</span><span>{value}%</span></div>'
                f'<div class="progress-track"><div class="progress-fill" style="width:{value}%"></div></div></div>')
    if kind == "metric":
        label = html.escape(node["label"], quote=True)
        value = html.escape(node["value"], quote=True)
        return (f'<div class="metric"><div class="metric-label">{label}</div>'
                f'<div class="metric-value">{value}</div></div>')
    if kind == "status":
        label = html.escape(node["label"], quote=True)
        state = node["state"]
        return f'<div class="status status-{state}" role="status">{label}</div>'
    if kind in ("card", "row", "column"):
        children = "".join(_render_node(child) for child in node["children"])
        return f'<div class="{kind}">{children}</div>'
    if kind == "divider":
        return "<hr>"
    text = html.escape(node["text"], quote=True)
    if kind == "heading":
        return f"<h2>{text}</h2>"
    if kind == "text":
        return f"<p>{text}</p>"
    return f'<div class="{kind}">{text}</div>'


def render(scene):
    scene = validate(scene)
    if scene["format"] in ("mesh-scene-v1", "mesh-scene-v2"):
        payload = base64.b64encode(json.dumps(scene, ensure_ascii=False, allow_nan=False,
                                             separators=(",", ":")).encode()).decode("ascii")
        title = html.escape(scene["title"], quote=True)
        return ("<!doctype html><html lang=en><head><meta charset=utf-8>"
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                f"<title>{title}</title><style>{_VIEW_CSS}</style></head>"
                f'<body data-mesh-scene="{payload}"><main id=mesh-demo-root></main>'
                f'<script>{_VIEW_JS}</script></body></html>')
    title = html.escape(scene["title"], quote=True)
    theme = scene["theme"]
    nodes = "".join(_render_node(node) for node in scene["nodes"])
    return ("<!doctype html><html lang=en><head><meta charset=utf-8>"
            f"<title>{title}</title><style>{_CSS}</style></head>"
            f'<body class="{theme}"><main><header>Static demo · revision {scene["version"]}</header>'
            f"<h1>{title}</h1>{nodes}</main></body></html>")


def csp():
    return ("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; "
            f"style-src 'sha256-{_STYLE_HASH}'; sandbox; object-src 'none'; navigate-to 'none'")


def csp_for(scene):
    sandbox = frame_sandbox(scene)
    if sandbox:
        return ("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; "
                f"style-src 'sha256-{_VIEW_CSS_HASH}'; script-src 'sha256-{_VIEW_JS_HASH}'; "
                f"sandbox {sandbox}; "
                "connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; navigate-to 'none'")
    return csp()


def frame_sandbox(scene):
    """Return the iframe sandbox flags governed by the same format policy as CSP."""
    return "allow-scripts" if scene.get("format") in ("mesh-scene-v1", "mesh-scene-v2") else ""
