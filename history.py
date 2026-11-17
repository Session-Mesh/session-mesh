# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""History of past agent sessions, read from their transcripts.

claude: ~/.claude/projects/<dir>/<session>.jsonl; codex: ~/.codex/sessions/…/rollout-*.jsonl
(titles from codex's state database); pi: ~/.pi/agent/sessions/*/*.jsonl; gemini:
<GEMINI_CLI_HOME|~>/.gemini/tmp/*/chats/session-*.jsonl (and Mesh's private overlay home);
copilot: <COPILOT_HOME|~/.copilot>/session-state/*/events.jsonl; agy:
~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl; vibe:
<VIBE_HOME|~/.vibe>/logs/session/unified/*/{meta.json,generations,chunks}; opencode: the read-only
SQLite store (see "OpenCode" below). The append-only transcripts are parsed once and then only
from where the last pass stopped; the others are parsed whole when they change. The parse state
is kept in ~/.cache/session-mesh/history.json across restarts.

The claude parsing follows claude-session-manager by Ritwik Gopi (MIT)."""

import glob
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
from contextlib import closing
import time
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import meshpaths
import fsutil

HOME = Path.home()
CLAUDE = HOME / ".claude"
CODEX = HOME / ".codex"
CACHE_FILE = meshpaths.CACHE_DIR / "history.json"
CACHE_VERSION = 5   # 5: incremental cursors (entry["inc"], agy fingerprint) for opencode, vibe and agy
SUMMARY_MAX = 20000

SAVE_EVERY = 60      # seconds between two writes of the cache while transcripts keep growing

_lock = threading.Lock()        # guards _files; held briefly, never across a parse
_scan = threading.Lock()        # one re-scan at a time
_stop = threading.Event()
_files = {}          # path -> {"mtime", "size", "offset", "s": parse state, "inc": cursor of vibe and opencode, "epoch"}
_loaded = False
_dirty = False       # the index changed since the cache was written
_saved = 0.0
# bumped whenever the index changes, so clients can skip a refetch; starts from the clock
# so that a generation seen before a restart never matches a different index
gen = time.time_ns() // 1000
_floor = gen         # a client that saw a generation from before this process gets everything
_gone = []           # (gen, "agent:id") of the entries removed since _floor
# _keys: (agent, id) -> the paths that hold that conversation (under _lock). Two live paths may hold one
# (agy has two roots, a claude project folder may be copied), while the database row is keyed (agent, id).
_keys = {}


def _ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def _text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content
                        if isinstance(b, str) or (isinstance(b, dict) and b.get("type") in ("text", "input_text"))).strip()
    return ""


def _clip(s, n):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _new_state(agent):
    return {"agent": agent, "id": None, "cwd": "", "branch": "", "version": "", "title": "",
            "name": "", "recap": "", "summary": "", "first": "", "last_user": "", "last_assistant": "",
            "started": None, "updated": None, "n_user": 0, "n_assistant": 0, "models": [],
            "tin": 0, "tout": 0, "tcr": 0, "tcw": 0, "web": 0, "sub": False, "source": "", "_ids": []}


# ---------------------------------------------------------------- claude

_RECAP_LEAD = ("This session is being continued from a previous conversation that ran out of context.",
               "The summary below covers the earlier portion of the conversation.")
_AUTO = ("<local-command", "<command-", "<bash-input>", "<bash-stdout>", "<bash-stderr>",
         "<system-reminder>", "<task-notification>", "Base directory for this skill:", "Caveat:")


def _claude_line(s, d):
    t = d.get("type")
    ts = _ts(d.get("timestamp"))
    if ts:
        s["started"] = s["started"] or ts
        s["updated"] = ts
    if d.get("isSidechain"):
        return
    if t == "user":
        text = _text(d.get("message", {}).get("content"))
        if not s["cwd"] and d.get("cwd"):
            s.update(cwd=d["cwd"], branch=d.get("gitBranch") or "", version=d.get("version") or "")
        if d.get("isCompactSummary"):
            for lead in _RECAP_LEAD:
                text = text[len(lead):].lstrip() if text.startswith(lead) else text
            s["summary"] = text[:SUMMARY_MAX]
            return
        if d.get("isMeta") or not text or text.startswith(_AUTO) or d.get("toolUseResult") is not None:
            return
        s["n_user"] += 1
        s["first"] = s["first"] or _clip(text, 240)
        s["last_user"] = _clip(text, 400)
        if d.get("gitBranch"):
            s["branch"] = d["gitBranch"]
    elif t == "assistant":
        m = d.get("message") or {}
        # One line per content block, all repeating the message's usage: count each message once.
        mid = m.get("id")
        text = _text(m.get("content"))
        if text:
            s["last_assistant"] = _clip(text, 400)
        u = m.get("usage") or {}
        use = [u.get("input_tokens") or 0, u.get("output_tokens") or 0,
               u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0]
        prev = next((x for x in s["_ids"] if x[0] == mid), None) if mid else None
        if prev:   # same message again: its latest usage replaces the earlier one
            for k, old, new in zip(("tin", "tout", "tcr", "tcw"), prev[1], use):
                s[k] += new - old
            prev[1] = use
            return
        s["_ids"] = (s["_ids"] + [[mid, use]])[-8:]
        s["n_assistant"] += 1
        for k, n in zip(("tin", "tout", "tcr", "tcw"), use):
            s[k] += n
        stu = u.get("server_tool_use") or {}
        s["web"] += (stu.get("web_search_requests") or 0) + (stu.get("web_fetch_requests") or 0)
        model = m.get("model")
        if model and not model.startswith("<") and model not in s["models"]:
            s["models"].append(model)
    elif t == "system" and d.get("subtype") == "away_summary":
        c = d.get("content")
        if isinstance(c, str) and c.strip():
            s["recap"] = re.sub(r"\s*\(disable recaps in /config\)\s*$", "", " ".join(c.split()))
    elif t == "ai-title" and d.get("aiTitle"):
        s["title"] = d["aiTitle"].strip()
    elif t == "custom-title" and d.get("customTitle"):
        s["name"] = d["customTitle"].strip()
    elif t == "summary" and d.get("summary") and not s["title"]:
        s["title"] = d["summary"].strip()


# ---------------------------------------------------------------- codex

def _codex_message(s, role, text, source):
    """Pair event/response representations while keeping repeated prompts."""
    if role not in ("user", "assistant") or not isinstance(text, str) or not text.strip():
        return
    text = text.strip()
    fingerprint = hashlib.sha256(text.encode()).hexdigest()
    pending = s.setdefault("_codex_messages", [])
    match = next((i for i, item in enumerate(pending)
                  if item[0] != source and item[1:] == [role, fingerprint]), None)
    if match is not None:
        pending.pop(match)
        return
    s["_codex_messages"] = (pending + [[source, role, fingerprint]])[-8:]
    if role == "user":
        s["n_user"] += 1
        s["first"] = s["first"] or _clip(text, 240)
        s["last_user"] = _clip(text, 400)
    else:
        s["n_assistant"] += 1
        s["last_assistant"] = _clip(text, 400)


def _codex_text(content):
    if not isinstance(content, list):
        return content if isinstance(content, str) else ""
    return " ".join(block["text"] for block in content
                    if isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text")
                    and isinstance(block.get("text"), str))


def _codex_line(s, d):
    t, p = d.get("type"), d.get("payload") or {}
    ts = _ts(d.get("timestamp"))
    if ts:
        s["started"] = s["started"] or ts
        s["updated"] = ts
    if t == "session_meta" and not s["id"] and isinstance(p.get("id"), str) and p["id"]:
        s.update(id=p.get("id"), cwd=p.get("cwd") or "", version=p.get("cli_version") or "",
                 branch=(p.get("git") or {}).get("branch") or "", sub=isinstance(p.get("source"), dict),
                 source=p.get("source") if isinstance(p.get("source"), str) else "")
    elif t == "turn_context":
        model = p.get("model")
        if model and model not in s["models"]:
            s["models"].append(model)
        s["cwd"] = p.get("cwd") or s["cwd"]
    elif t == "compacted" and p.get("message"):
        s["summary"] = str(p["message"])[:SUMMARY_MAX]
    elif t == "event_msg":
        k = p.get("type")
        if k == "user_message":
            _codex_message(s, "user", p.get("message"), "event")
        elif k == "agent_message":
            _codex_message(s, "assistant", p.get("message"), "event")
        elif k == "token_count" and p.get("info"):
            u = p["info"].get("total_token_usage") or {}
            cached = u.get("cached_input_tokens") or 0
            s.update(tin=(u.get("input_tokens") or 0) - cached, tcr=cached,
                     tout=u.get("output_tokens") or 0)
    elif t == "response_item":
        if p.get("type") == "message":
            _codex_message(s, p.get("role"), _codex_text(p.get("content")), "response")
        elif p.get("type") == "web_search_call":
            s["web"] += 1


# Pi uses the same append-only transcript index as the other providers.
def _pi_line(s, d):
    if d.get("type") == "session":
        if d.get("version") == 3 and isinstance(d.get("cwd"), str) and re.fullmatch(
                r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", str(d.get("id", ""))):
            s.update(id=d["id"], cwd=d["cwd"], version="3", started=_ts(d.get("timestamp")))
        return
    if not s["id"]:
        return
    ts = _ts(d.get("timestamp"))
    if ts:
        s["updated"] = ts
    if d.get("type") == "session_info":
        s["name"] = _clip(str(d.get("name") or ""), 160)
    if d.get("type") != "message":
        return
    m = d.get("message") or {}
    text = _text(m.get("content"))
    if m.get("role") == "user" and text:
        s["n_user"] += 1
        s["first"] = s["first"] or _clip(text, 240)
        s["last_user"] = _clip(text, 400)
    elif m.get("role") == "assistant":
        s["n_assistant"] += 1
        if text:
            s["last_assistant"] = _clip(text, 400)
        if m.get("model") and m["model"] not in s["models"]:
            s["models"].append(m["model"])


def _pi_root():
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or HOME / ".pi" / "agent") / "sessions"

# ---------------------------------------------------------------- the other agents
#
# Formats learnt from each client's own code or documentation (never from a user's data):
# gemini 0.68 chatRecordingService (append-only JSONL: a metadata line, then message records that
# are appended again when they change, `$set` / `$rewindTo` records); copilot events.jsonl
# ({id, type, data, timestamp}); agy transcript.jsonl (one step per line, read from a byte cursor that a
# fingerprint of the bytes before it keeps honest); vibe unified store (meta.json + chunked checkpoint:
# the digests of the chunks already read are remembered); opencode SQLite (below: a row cursor).

AGENTS = ("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe")
DELETABLE = ("claude", "codex", "pi", "gemini")   # one transcript file: the others keep a store or a directory
_FINGERPRINTED = ("agy",)                        # rewritten in place now and then: the bytes before the cursor are checked
_ID = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{7,63}")
_BAD_LINE = (ValueError, AttributeError, TypeError, KeyError, IndexError, RecursionError)   # a line of a shape the reader does not expect


def _parts(content):
    """The text of a message whose content is a string or a list of {text} parts."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(p if isinstance(p, str) else str(p.get("text") or "") for p in content
                        if isinstance(p, str) or isinstance(p, dict)).strip()
    return ""


def _stamp(s, ts):
    if ts:
        s["started"] = s["started"] or ts
        s["updated"] = ts


def _count(s, mid, use=(0, 0, 0, 0)):
    """Count message mid once; tokens added to it later (it is written again) replace the earlier ones.
    True the first time the message is seen."""
    prev = next((x for x in s["_ids"] if x[0] == mid), None) if mid else None
    if prev:
        for key, old, new in zip(("tin", "tout", "tcr", "tcw"), prev[1], use):
            s[key] += new - old
        prev[1] = list(use)
        return False
    s["_ids"] = (s["_ids"] + [[mid, list(use)]])[-64:]
    for key, n in zip(("tin", "tout", "tcr", "tcw"), use):
        s[key] += n
    return True


def _say(s, role, text):
    text = text.strip() if isinstance(text, str) else ""
    if role == "user" and text:
        s["n_user"] += 1
        s["first"] = s["first"] or _clip(text, 240)
        s["last_user"] = _clip(text, 400)
    elif role == "assistant":
        s["n_assistant"] += 1
        if text:
            s["last_assistant"] = _clip(text, 400)


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _gemini_line(s, d):
    update = d.get("$set")
    if isinstance(update, dict):
        if isinstance(update.get("summary"), str):
            s["title"] = _clip(update["summary"], 160)
        _stamp(s, _ts(update.get("lastUpdated")))
        return
    if "$rewindTo" in d:
        return
    if "messages" not in d and "type" not in d:   # the metadata line, first in the file
        if not s["id"] and _ID.fullmatch(str(d.get("sessionId", ""))):
            dirs = d.get("directories")
            s.update(id=d["sessionId"], started=_ts(d.get("startTime")), updated=_ts(d.get("lastUpdated")),
                     cwd=dirs[0] if isinstance(dirs, list) and dirs and isinstance(dirs[0], str) else "",
                     sub=d.get("kind") == "subagent")
        return
    _stamp(s, _ts(d.get("timestamp")))
    kind, tokens = d.get("type"), d.get("tokens") or {}
    cached = _int(tokens.get("cached"))
    use = (_int(tokens.get("input")) - cached, _int(tokens.get("output")) + _int(tokens.get("thoughts")), cached, 0)
    first = _count(s, d.get("id"), use if kind == "gemini" else (0, 0, 0, 0))
    if kind == "gemini" and d.get("model") and d["model"] not in s["models"]:
        s["models"].append(d["model"])
    if first and kind in ("user", "gemini"):
        _say(s, "user" if kind == "user" else "assistant", _parts(d.get("content")))


def _copilot_line(s, d):
    kind, data = d.get("type"), d.get("data") or {}
    _stamp(s, _ts(d.get("timestamp")))
    if kind == "session.start" and not s["id"] and _ID.fullmatch(str(data.get("sessionId", ""))):
        ctx = data.get("context") or {}
        s.update(id=data["sessionId"], cwd=ctx.get("cwd") if isinstance(ctx.get("cwd"), str) else "",
                 version=str(data.get("copilotVersion") or ""), started=_ts(data.get("startTime")) or s["started"])
    elif kind == "session.model_change":
        model = data.get("newModel")
        if isinstance(model, str) and model not in s["models"]:
            s["models"].append(model)
    elif kind in ("user.message", "assistant.message") and _count(s, d.get("id")):
        _say(s, kind.split(".")[0], data.get("content"))
        s["tout"] += _int(data.get("outputTokens"))


def _agy_line(s, d):
    _stamp(s, _ts(d.get("created_at")))
    text = d.get("content")
    if d.get("type") == "USER_INPUT" and isinstance(text, str):
        _say(s, "user", text)
    elif d.get("type") == "PLANNER_RESPONSE" and isinstance(text, str) and text.strip():
        _say(s, "assistant", text)


_SHA = re.compile(r"[0-9a-f]{64}")


def _read_json(path, limit=16 << 20):
    """A JSON file of at most `limit` bytes, None when absent, too big or not JSON."""
    try:
        if os.stat(path).st_size > limit:
            return None
        return json.loads(Path(path).read_bytes())
    except (OSError, ValueError, RecursionError):
        return None


def _vibe_manifest(session_dir):
    """The chunk digests, in order, of the newest generation's manifest (it names the checkpoint's
    chunks: chunks/<sha256>.json, each a JSON array of {"message": {"role", "content"}} entries);
    None when there is no readable manifest, so that the caller keeps what it has."""
    gens = sorted((d.name for d in (session_dir / "generations").glob("[0-9]" * 16)), reverse=True)
    manifest = _read_json(session_dir / "generations" / gens[0] / "manifest.json") if gens else None
    checkpoint = manifest.get("checkpoint") if isinstance(manifest, dict) else None
    chunks = checkpoint.get("chunks") if isinstance(checkpoint, dict) else None
    if not isinstance(chunks, list):
        return None
    return [d for d in chunks if isinstance(d, str) and _SHA.fullmatch(d)]


def _vibe_chunk(session_dir, digest):
    """[(role, text)] of one chunk file, None when it cannot be read (absent, being written)."""
    items = _read_json(session_dir / "chunks" / f"{digest}.json")
    if not isinstance(items, list):
        return None
    out = []
    for item in items:
        message = item.get("message") if isinstance(item, dict) else None
        if isinstance(message, dict) and message.get("role") in ("user", "assistant"):
            out.append((message["role"], _parts(message.get("content"))))
    return out


def _vibe_plan(session_dir, indexed):
    """(replace, [(digest, [(role, text)])]) of what to read given the digests already indexed, in
    order: the chunks the manifest adds, or all of them (replace) when it dropped one that was indexed
    (a rewrite or rewind). None when no manifest can be read. An unreadable chunk is left out, so it
    is tried again with the next generation."""
    manifest = _vibe_manifest(session_dir)
    if manifest is None:
        return None
    replace = not set(indexed) <= set(manifest)
    seen = set() if replace else set(indexed)
    got = []
    for digest in manifest:
        if digest in seen:
            continue
        seen.add(digest)
        texts = _vibe_chunk(session_dir, digest)
        if texts is not None:
            got.append((digest, texts))
    return replace, got


def _vibe_read(meta_path, entry):
    """meta.json (Vibe's SessionMetadata, rewritten on every save), then the chunks of the transcript store
    that the entry has not read yet (entry["inc"]["hashes"] lists those it has)."""
    meta = _read_json(meta_path, 1 << 20)
    if not isinstance(meta, dict) or not _ID.fullmatch(str(meta.get("session_id", ""))):
        return
    plan = _vibe_plan(Path(meta_path).parent, entry["inc"]["hashes"])
    if plan and plan[0]:
        entry["s"], entry["inc"] = _new_state("vibe"), {"hashes": []}
    s = entry["s"]
    env, config = (v if isinstance(v, dict) else {} for v in (meta.get("environment"), meta.get("config")))
    where = env.get("working_directory") or meta.get("origin_directory")
    model = config.get("model_name")
    s.update(id=meta["session_id"], cwd=where if isinstance(where, str) else "", sub=bool(meta.get("parent_session_id")),
             title=_clip(str(meta.get("title") or ""), 160), started=_ts(meta.get("start_time")),
             updated=_ts(meta.get("end_time")) or os.stat(meta_path).st_mtime,
             models=[model] if isinstance(model, str) else [])
    for digest, texts in plan[1] if plan else ():
        for role, text in texts:
            _say(s, role, text)
        entry["inc"]["hashes"].append(digest)


def _gemini_roots():
    """Gemini's conversation stores: the user's own and Mesh's private GEMINI_CLI_HOME overlay (agentmcp.gemini_home)."""
    own = Path(os.environ.get("GEMINI_CLI_HOME") or HOME) / ".gemini" / "tmp"
    mesh = meshpaths.CONF_DIR / "gemini-home" / ".gemini" / "tmp"
    return [own] if own == mesh else [own, mesh]


def _copilot_root():
    return Path(os.environ.get("COPILOT_HOME") or HOME / ".copilot") / "session-state"


def _agy_roots():
    return [HOME / ".gemini" / "antigravity-cli", HOME / ".gemini" / "antigravity"]   # the sources differ on the name


def _vibe_root():
    return Path(os.environ.get("VIBE_HOME") or HOME / ".vibe") / "logs" / "session" / "unified"


def _finish(path, agent, s):
    """What a file's own name or neighbours say, after its lines."""
    p = Path(path)
    if agent == "claude":
        s["id"] = p.stem
    elif agent == "agy" and _ID.fullmatch(p.parents[2].name):
        s["id"] = p.parents[2].name       # brain/<id>/.system_generated/logs/transcript.jsonl
    elif agent == "copilot":
        s["id"] = s["id"] or (p.parent.name if _ID.fullmatch(p.parent.name) else None)
        s["title"] = _workspace_title(p.with_name("workspace.yaml")) or s["title"]
    elif agent == "gemini" and not s["cwd"]:
        try:     # the project's folder is named by a marker beside its chats
            root = (p.parents[1] / ".project_root").read_text(encoding="utf-8").strip()
            s["cwd"] = root if root.startswith("/") else ""
        except (OSError, ValueError):   # unreadable, or not UTF-8
            pass


def _workspace_title(path):
    """The `name:` (newer) or `summary:` (older) line of Copilot's workspace.yaml; block scalars are skipped."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        return ""
    for key in ("name", "summary"):
        for line in lines:
            if line.startswith(key + ":"):
                value = line.split(":", 1)[1].strip().strip("\"'")
                if value and value[0] not in "|>":
                    return _clip(value, 160)
    return ""


# ---------------------------------------------------------------- OpenCode
#
# OpenCode keeps its conversations in SQLite ($XDG_DATA_HOME/opencode/opencode.db, or OPENCODE_DB):
# 1.x in session / message / part, 2.x in session_v2 / session_message (a migrated database holds both).
# It is opened read-only and only those tables are read: the file also holds provider credentials.
# Each conversation is an index entry keyed "opencode:<id>", refreshed when its time_updated moves.

_OC_PLACEHOLDER = re.compile(r"^(New session|Child session) - ")
_OC_SETTLE = 20   # seconds without a write after which a conversation's newest message counts as complete
_OC_BASE = {"n_user": 0, "n_assistant": 0, "tin": 0, "tout": 0, "tcr": 0, "tcw": 0, "models": [],
            "first": "", "last_user": "", "last_assistant": ""}


def _oc_path():
    base = Path(os.environ.get("XDG_DATA_HOME") or HOME / ".local" / "share") / "opencode"
    named = os.environ.get("OPENCODE_DB")
    if named and named != ":memory:":
        return Path(named) if os.path.isabs(named) else base / named
    return base / "opencode.db"


def _oc_open():
    path = _oc_path()
    try:
        return sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=1) if path.is_file() else None
    except sqlite3.Error:
        return None


def _oc_has(con, table):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def _oc_kind(con, table, sid):
    """"v2" when the conversation has session_message rows (2.x), else "v1" (message / part)."""
    if table == "session_v2" and _oc_has(con, "session_message"):
        if con.execute("SELECT 1 FROM session_message WHERE session_id=? LIMIT 1", (sid,)).fetchone():
            return "v2"
    return "v1"


def _oc_json(raw):
    try:
        found = json.loads(raw)
    except (TypeError, ValueError, RecursionError):
        return {}
    return found if isinstance(found, dict) else {}


def _oc_content(con, kind, mid, typ, data):
    """(role, [text], usage, model) of one message row; the parts of a 1.x message are read here."""
    if kind == "v2":
        items = data.get("content") if typ == "assistant" else [data]
        return typ, [c.get("text") for c in items if isinstance(c, dict) and c.get("type", "text") == "text"] \
            if isinstance(items, list) else [], (0, 0, 0, 0), None
    parts = (_oc_json(r[0]) for r in con.execute("SELECT data FROM part WHERE message_id=? ORDER BY time_created, id", (mid,)))
    tokens = data.get("tokens") if isinstance(data.get("tokens"), dict) else {}
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    usage = (_int(tokens.get("input")), _int(tokens.get("output")) + _int(tokens.get("reasoning")),
             _int(cache.get("read")), _int(cache.get("write")))
    nested = data.get("model")
    model = data.get("modelID") or (nested.get("modelID") if isinstance(nested, dict) else None)
    return data.get("role"), [p.get("text") for p in parts if p.get("type") == "text"], usage, model


def _oc_iter(con, kind, sid, after, upto=None):
    """(rowid, id, role, [text], usage, model) of the messages whose rowid is in (after, upto], oldest
    first. These are the only rows read: everything at or before the cursor is not touched."""
    table = "session_message" if kind == "v2" else "message"
    if not _oc_has(con, table):
        return
    sql = f"SELECT rowid, id, {'type' if kind == 'v2' else 'NULL'}, data FROM {table} WHERE session_id=? AND rowid>?"
    args = (sid, after) + (() if upto is None else (upto,))
    for rowid, mid, typ, raw in con.execute(sql + ("" if upto is None else " AND rowid<=?") + " ORDER BY rowid", args):
        yield (rowid, mid, *_oc_content(con, kind, mid, typ, _oc_json(raw)))


def _oc_fold(acc, rows):
    """acc (counts, tokens, models, first / last texts) with rows added; acc itself is not changed."""
    acc = {**acc, "models": list(acc["models"])}
    for _, _, role, texts, use, model in rows:
        texts = [t for t in texts if isinstance(t, str) and t.strip()]
        if role == "user":
            acc["n_user"] += 1
            if texts:
                acc["first"] = acc["first"] or _clip(texts[0], 240)
                acc["last_user"] = _clip(texts[-1], 400)
        elif role == "assistant":
            acc["n_assistant"] += 1
            acc["last_assistant"] = _clip(texts[-1], 400) if texts else acc["last_assistant"]
            for key, n in zip(("tin", "tout", "tcr", "tcw"), use):
                acc[key] += n
            if isinstance(model, str) and model and model not in acc["models"]:
                acc["models"].append(model)
    return acc


def _oc_valid(con, kind, sid, inc):
    """True when the cursor of inc still stands: same kind of rows, its row has the id it had, and the
    conversation holds as many rows up to it as before (a deleted or rewound conversation fails this)."""
    if not inc or inc.get("kind") != kind:
        return False
    if inc["cur"] == 0:
        return True
    table = "session_message" if kind == "v2" else "message"
    if not _oc_has(con, table):
        return False
    row = con.execute(f"SELECT id FROM {table} WHERE session_id=? AND rowid=?", (sid, inc["cur"])).fetchone()
    held = con.execute(f"SELECT count(*) FROM {table} WHERE session_id=? AND rowid<=?", (sid, inc["cur"])).fetchone()[0]
    return bool(row) and row[0] == inc["cid"] and held == inc["n"]


def _oc_advance(con, kind, sid, inc, idle):
    """(inc, view). inc is the cursor: the rowid and id of the last settled message, how many settled
    messages there are, the figures they add up to (base) and an epoch that counts the full re-reads.
    New messages are read from the cursor on; the newest one stays unsettled (it may still be written:
    re-read next time) unless the conversation has been idle. view = base plus those that are not settled."""
    if not _oc_valid(con, kind, sid, inc):
        inc = {"kind": kind, "cur": 0, "cid": "", "n": 0, "base": _OC_BASE, "epoch": inc["epoch"] + 1 if inc else 0}
    rows = list(_oc_iter(con, kind, sid, inc["cur"]))
    settled = rows if idle else rows[:-1]
    base = _oc_fold(inc["base"], settled)
    if settled:
        inc = {**inc, "cur": settled[-1][0], "cid": settled[-1][1], "n": inc["n"] + len(settled), "base": base}
    return {**inc, "open": len(settled) < len(rows)}, _oc_fold(base, rows[len(settled):])


def _oc_state(con, table, row, inc):
    """(parse state, cursor) of a conversation; inc is its previous cursor (None for a first read)."""
    sid, cwd, title, version, created, updated, _key = row
    s = _new_state("opencode")
    s.update(id=sid, cwd=cwd or "", version=version or "", started=created / 1000 if created else None,
             updated=updated / 1000 if updated else None,
             title="" if _OC_PLACEHOLDER.match(title or "") else _clip(title or "", 160))
    idle = time.time() - (updated or 0) / 1000 > _OC_SETTLE
    inc, view = _oc_advance(con, _oc_kind(con, table, sid), sid, inc, idle)
    s.update(view)
    return s, inc


def _oc_rows(con):
    """{id: (table, row)} of the root conversations; session_v2 (2.x) wins over session (1.x)."""
    found = {}
    for table in ("session_v2", "session"):
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if not {"id", "directory", "time_updated"} <= cols:
            continue
        pick = ", ".join(c if c in cols else f"NULL AS {c}" for c in ("id", "directory", "title", "version", "time_created", "time_updated"))
        for row in con.execute(f"SELECT {pick} FROM {table}" + (" WHERE parent_id IS NULL" if "parent_id" in cols else "")):
            if isinstance(row[0], str) and _OC_ID.fullmatch(row[0]):
                found.setdefault(row[0], (table, _oc_typed(row)))
    return found


def _oc_typed(row):
    """The row with the types the readers rely on: text columns are strings, time columns are numbers (a
    column of another type, which SQLite allows anywhere, becomes empty / None instead of failing the scan).
    The seventh item is the change key: the number itself, or the repr of a value that is not one, so that a
    conversation whose date is text still shows a change when that text changes."""
    sid, cwd, title, version, created, updated = row
    def text(v):
        return v if isinstance(v, str) else ""

    def num(v):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) < 1e17 else None

    key = num(updated)
    return sid, text(cwd), text(title), text(version), num(created), num(updated), repr(updated) if key is None else key


_OC_ID = re.compile(r"ses_[0-9A-Za-z]{8,60}")


def _oc_sync(seen):
    """Bring the OpenCode entries up to date; True when one changed. A store that is absent holds nothing
    (its conversations are dropped); one that is there but unreadable (locked) keeps what is indexed."""
    con = _oc_open()
    with _lock:
        known = {k: e for k, e in _files.items() if k.startswith("opencode:")}
    changed = False
    try:
        rows = _oc_rows(con) if con else ({} if not _oc_path().is_file() else None)   # a store that is gone empties its conversations
    except sqlite3.Error:
        rows = None
    if rows is None:
        seen.update(known)
        if con:
            con.close()
        return False
    try:
        for sid, (table, row) in rows.items():
            key = f"opencode:{sid}"
            seen.add(key)
            old = known.get(key)
            changed = _oc_one(con, table, row, key, old) or changed
    except sqlite3.Error:
        seen.update(known)
    finally:
        if con:
            con.close()
    return changed


def _oc_one(con, table, row, key, old):
    """Bring one OpenCode conversation up to date; True when it changed. A conversation that makes the read
    raise is skipped like a broken file (logged once per version, kept as it was, counted as skipped)."""
    if old and old["mtime"] == row[6] and not old["inc"]["open"]:
        return False
    if key in _broken and _broken[key] == row[6]:
        return False
    try:
        s, inc = _oc_state(con, table, row, old["inc"] if old else None)
    except sqlite3.Error:
        raise
    except Exception as e:   # one conversation of an unexpected shape must not stop the scan of the others
        _broken[key] = row[6]
        print(f"history: opencode conversation skipped ({type(e).__name__}): {key}", flush=True)
        return False
    _broken.pop(key, None)
    if old and old["mtime"] == row[6] and old["s"] == s and old["inc"] == inc:
        return False   # an unsettled message was read again and had not changed
    with _lock:
        _put(key, {"mtime": row[6], "size": 0, "offset": 0, "s": s, "inc": inc})
    return True


def search_db(q, cancel=None):
    """The ids ("opencode:<id>") of the conversations whose messages or title contain q (literal,
    case-insensitive), searched in the read-only store: the transcripts' ripgrep cannot see inside SQLite.
    cancel (a threading.Event): a superseded search stops, at once if it has not started, and answers
    what it has found so far."""
    cancelled = cancel.is_set if cancel is not None else (lambda: False)
    con = None if cancelled() or not q else _oc_open()
    if con is None:
        return []
    deadline = time.monotonic() + 20
    con.set_progress_handler(lambda: int(cancelled() or time.monotonic() > deadline), 100000)
    ids = set()
    try:
        for table, col in (("part", "session_id"), ("session_message", "session_id"), ("session", "id"), ("session_v2", "id")):
            if cancelled():
                break
            try:
                text = "data" if col == "session_id" else "title"
                ids.update(r[0] for r in con.execute(f"SELECT DISTINCT {col} FROM {table} WHERE instr(lower({text}), lower(?)) > 0", (q,)))
            except sqlite3.Error:
                continue
    finally:
        con.close()
    with _lock:
        return [f"opencode:{i}" for i in sorted(ids) if f"opencode:{i}" in _files]


# ---------------------------------------------------------------- index

_FEEDS = {"claude": _claude_line, "codex": _codex_line, "pi": _pi_line, "gemini": _gemini_line,
          "copilot": _copilot_line, "agy": _agy_line}


def _sources():
    out = [(p, "claude") for p in glob.glob(f"{CLAUDE}/projects/*/*.jsonl")]
    out += [(p, "codex") for p in glob.glob(f"{CODEX}/sessions/*/*/*/rollout-*.jsonl")]
    out += [(str(p), "pi") for p in _pi_root().glob("*/*.jsonl")]
    out += [(str(p), "gemini") for root in _gemini_roots() for p in root.glob("*/chats/session-*.jsonl")]
    out += [(str(p), "copilot") for p in _copilot_root().glob("*/events.jsonl")]
    out += [(str(p), "agy") for base in _agy_roots() for p in base.glob("brain/*/.system_generated/logs/transcript.jsonl")]
    out += [(str(p), "vibe") for p in _vibe_root().glob("*/meta.json")]
    return out


def _stat(path, agent):
    """(mtime_ns, size) that changes when the conversation does, None when it is gone."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    mtime, size = st.st_mtime_ns, st.st_size
    if agent == "vibe":   # the metadata and the transcript store (new generations, new chunks) move apart
        for name in ("generations", "chunks"):
            try:
                mtime = max(mtime, os.stat(Path(path).with_name(name)).st_mtime_ns)
            except OSError:
                pass
    return mtime, size


_EPOCH_MIN = 1 << 61   # a lineage token has this bit set; the counters of older caches and databases are below it


def _new_epoch():
    """An identifier of one lineage of a source: the stretch of its life read from one start. It is drawn at
    random, not counted, so that it cannot repeat after the cache is lost: a database row that holds the token
    of an entry holds what that entry read, and no other token can match it."""
    return _EPOCH_MIN | secrets.randbits(60)


def _fresh(agent, old):
    """An empty entry in a new lineage: the database, which holds the epoch of the lineage it stores,
    sees that what it holds for the source is stale."""
    return {"offset": 0, "s": _new_state(agent), "inc": {"hashes": []}, "epoch": _new_epoch()}


def _fingerprint(fh, offset):
    """A digest of the (at most 256) bytes that end at the cursor."""
    fh.seek(max(0, offset - 256))
    return hashlib.sha1(fh.read(min(offset, 256))).hexdigest()


def _rewritten(path, agent, entry, size):
    """True when the transcript is shorter than the cursor, or (agy, whose file is rewritten now and
    then) was replaced, or no longer holds the bytes that ended the part already read."""
    if size < entry["offset"]:
        return True
    if agent not in _FINGERPRINTED:
        return False
    try:
        with open(path, "rb") as fh:
            return os.fstat(fh.fileno()).st_ino != entry.get("ino") or _fingerprint(fh, entry["offset"]) != entry.get("fp")
    except OSError:
        return False


def _feed(path, agent, entry):
    """Feed the complete lines after the entry's cursor to the agent's reader, and move the cursor."""
    s, offset = entry["s"], entry["offset"]
    with open(path, "rb") as fh:
        fh.seek(offset)
        for raw in fh:
            if not raw.endswith(b"\n"):
                break   # a line still being written: pick it up next time
            offset += len(raw)
            try:
                _FEEDS[agent](s, json.loads(raw))
            except _BAD_LINE:
                pass
        entry["offset"] = offset
        if agent in _FINGERPRINTED:
            entry.update(ino=os.fstat(fh.fileno()).st_ino, fp=_fingerprint(fh, offset))


def _parse(path, agent, entry):
    """Bring a file's entry up to date, reading only what was appended since last time: lines after
    the byte cursor, and for vibe the chunks whose digests the entry has not read yet."""
    sig = _stat(path, agent)
    if sig is None:
        return None
    if entry and (entry["mtime"], entry["size"]) == sig:
        return entry
    if not entry or _rewritten(path, agent, entry, sig[1]):
        entry = _fresh(agent, entry)
    else:
        entry = deepcopy(entry)   # the published one may be read meanwhile
    if agent == "vibe":
        _vibe_read(path, entry)
    else:
        _feed(path, agent, entry)
    _finish(path, agent, entry["s"])
    entry.update(mtime=sig[0], size=sig[1])
    return entry


def _load_cache():
    global _loaded, _floor
    _loaded = True
    try:
        raw = json.loads(CACHE_FILE.read_text())
        if raw.get("v") != CACHE_VERSION:
            return
        for entry in raw["files"].values():
            if not isinstance(entry.get("epoch"), int) or entry["epoch"] < _EPOCH_MIN:
                entry["epoch"] = _new_epoch()   # a counter of an older cache: no database row can match it, so it is re-verified
        keyed = [(_key(entry), path) for path, entry in raw["files"].items()]
        with _lock:
            _files.update(raw["files"])
            for key, path in keyed:
                _keys.setdefault(key, set()).add(path)
            # a client may already hold the empty index: its generation must get everything
            _floor = _bump()
    except (OSError, ValueError, KeyError, AttributeError, TypeError):
        pass


def _save_cache():
    """Write the cache (it holds prompts and replies: private to the user)."""
    global _dirty, _saved
    with _lock:
        text = json.dumps({"v": CACHE_VERSION, "files": _files})
        _dirty, _saved = False, time.monotonic()
    try:
        CACHE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fsutil.atomic_write(CACHE_FILE, text)
    except OSError as e:
        print(f"history: cache not saved: {e}", flush=True)


def flush():
    """Stop a running scan and write what is pending (at shutdown)."""
    _stop.set()
    with _scan:
        if _dirty:
            _save_cache()
        _stop.clear()
    _hdb.close()


_titles = {"key": None, "map": {}, "gen": 0}


def _mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def _codex_titles():
    dbs = sorted(glob.glob(f"{CODEX}/state_*.sqlite"))
    # in WAL mode a title change only touches the -wal file until a checkpoint
    key = [(db, _mtime(db), _mtime(f"{db}-wal")) for db in dbs]
    if key == _titles["key"]:
        return _titles["map"]
    out = {}
    for db in dbs:
        try:
            with closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)) as con:
                rows = con.execute("select id, title from threads where title != ''").fetchall()
        except sqlite3.Error:
            continue
        # codex titles a thread with its first prompt when it has no better name: keep a line
        out.update((str(i), _clip(str(t), 160)) for i, t in rows if t)
    if out != _titles["map"]:
        with _lock:
            _titles["gen"] = _bump()
    _titles.update(key=key, map=out)
    return out


_agy = {"key": None, "map": {}}


def _agy_cwds():
    """{conversation id: workspace folder} from agy's cache/last_conversations.json (workspace -> its latest
    conversation): agy's transcripts do not name their folder, so only a workspace's latest one has one."""
    files = [b / "cache" / "last_conversations.json" for b in _agy_roots()]
    key = [(str(f), _mtime(f)) for f in files]
    if key == _agy["key"]:
        return _agy["map"]
    out = {}
    for f in files:
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(raw, dict):
            out.update((v, k) for k, v in raw.items() if isinstance(v, str) and isinstance(k, str) and k.startswith("/"))
    if out != _agy["map"]:
        with _lock:
            _titles["gen"] = _bump()
    _agy.update(key=key, map=out)
    return out


def _bump():
    global gen, _dirty
    gen, _dirty = gen + 1, True
    _hdb._db["ready"] = False   # the database mirrors the index again only once it is synced
    return gen


def _key(entry):
    return entry["s"]["agent"], entry["s"]["id"]


def _unkey(path, entry):
    paths = _keys.get(_key(entry), set())
    paths.discard(path)
    if not paths:
        _keys.pop(_key(entry), None)


def _put(path, entry):
    """Publish a file's new entry (under _lock)."""
    if path in _files:
        _unkey(path, _files[path])
    entry["g"] = _bump()
    _files[path] = entry
    _keys.setdefault(_key(entry), set()).add(path)


def _drop(path):
    """Unpublish a file's entry (under _lock); True if it was there."""
    e = _files.pop(path, None)
    if e:
        _unkey(path, e)
        _gone.append((_bump(), f"{e['s']['agent']}:{e['s']['id']}"))
    return bool(e)


def holders(key):
    """The live paths that hold the conversation (agent, id), sorted."""
    with _lock:
        return sorted(_keys.get(key, ()))


def _size(path, sid, agent):
    n = os.path.getsize(path) if os.path.exists(path) else 0
    if agent == "vibe":   # the folder holds meta.json (the path) itself: counted once
        n = sum(f.stat().st_size for f in Path(path).parent.rglob("*") if f.is_file())
    if agent == "claude":
        sub = Path(path).parent / sid
        if sub.is_dir():
            n += sum(f.stat().st_size for f in sub.rglob("*") if f.is_file())
    return n


def _codex_titles_safe():
    """The codex titles, or the last good ones when reading them raises (a listing never fails for a title)."""
    return _step("codex titles", _codex_titles, _titles["map"])


def _agy_cwds_safe():
    return _step("agy folders", _agy_cwds, _agy["map"])


_broken = {}   # path -> (mtime_ns, size) of a file whose parse raised: not read again until it changes


def _parse_isolated(path, agent, old):
    """_parse and the size of the result, for one file: one that makes the parse raise (a shape no reader
    expected) is skipped, logged once per version of the file (its path and the error's type, never its
    content), and keeps the entry it had, so it is neither dropped nor read again until it changes."""
    sig = _stat(path, agent)
    if sig is not None and _broken.get(path) == sig:
        return old
    try:
        entry = _parse(path, agent, old)
        if entry is not None and entry is not old:
            entry["s"]["bytes"] = _size(path, entry["s"]["id"], agent)
    except Exception as e:   # one malformed file must not stop the scan of the others
        _broken[path] = sig
        print(f"history: {agent} file skipped ({type(e).__name__}): {path}", flush=True)
        return old
    _broken.pop(path, None)
    return entry


def skipped_count():
    """How many conversations are skipped as unreadable (their parse raised) and not read again until they change."""
    return len(_broken)


_failed_steps = set()   # labels of the non-file steps whose last run raised (a handful, bounded by the code)
_failed_files = 0       # how many file steps raised in the last scan: a count, never one label per path


def _stepped_failed(label):
    """Whether the last run of the step `label` raised."""
    return label in _failed_steps


def scan_degraded():
    """Whether the last scan left a non-file step (sources, opencode, database, drop, save...) failed: the index
    served may then be stale in a way no single file explains. A file that failed is counted, not flagged."""
    return bool(_failed_steps)


def failed_file_count():
    """How many file steps raised in the last scan."""
    return _failed_files


def _step(label, fn, default=None):
    """Run one step of the scan. A step that raises is logged (its type, never its content) and the scan goes on
    with `default`: finish, the drop of vanished files and the cache write always run. A file step is only counted
    (and logged for the first failure of a scan), so that the bookkeeping does not grow with the number of files."""
    global _failed_files
    is_file = label.startswith("file ")
    try:
        result = fn()
    except Exception as e:
        if is_file:
            _failed_files += 1
            if _failed_files == 1:
                print(f"history: scan step file failed ({type(e).__name__}), further ones in this scan are counted", flush=True)
        else:
            if label not in _failed_steps:   # once, until the step works again
                print(f"history: scan step {label} failed ({type(e).__name__})", flush=True)
            _failed_steps.add(label)
        return default
    if not is_file:
        _failed_steps.discard(label)
    return result


def _refresh_file(path, agent, seen):
    """One source file: parse, publish, sync to the database; True when its entry changed."""
    seen.add(path)
    with _lock:
        old = _files.get(path)
    entry = _parse_isolated(path, agent, old)
    if entry is None or entry is old:
        return False
    with _lock:
        if not os.path.exists(path):
            return False   # deleted while it was being parsed
        _put(path, entry)
    _hdb.sync_one_safe(path, entry)
    return True


def _drop_vanished(seen):
    changed = False
    with _lock:
        for gone in set(_files) - seen:
            changed = _drop(gone) or changed
    return changed


def refresh():
    """Re-scan the transcripts; returns True when anything changed. The index stays
    readable during a scan: each file's new entry replaces the old one when ready (a
    first scan can take minutes). Every step is isolated: one file, source or database step
    that fails is skipped and the rest of the scan (and its finish) still runs."""
    global _failed_files
    with _scan:
        _failed_files = 0
        if not _loaded:
            _step("cache", _load_cache)
        changed = False
        seen = set()
        sources = _step("sources", _sources)
        for path, agent in sources or []:
            if _stop.is_set():
                return changed
            changed = _step(f"file {path}", lambda: _refresh_file(path, agent, seen), False) or changed
            seen.add(path)
        changed = _step("opencode", lambda: _oc_sync(seen), False) or changed
        if _stepped_failed("opencode"):
            seen.update(k for k in list(_files) if k.startswith("opencode:"))   # unread, not gone
        for path in set(_broken) - seen:
            del _broken[path]
        if sources is not None:   # a listing that failed says nothing about what is gone
            changed = _step("drop", lambda: _drop_vanished(seen), False) or changed
        _step("codex titles", _codex_titles)
        _step("agy folders", _agy_cwds)
        if not _stop.is_set():
            _step("database", _hdb.finish)
        if _dirty and time.monotonic() - _saved >= SAVE_EVERY:
            _step("cache save", _save_cache)
        return changed


_PUBLIC = ("agent", "id", "cwd", "branch", "version", "title", "name", "recap", "first",
           "last_user", "last_assistant", "started", "updated", "n_user", "n_assistant", "models",
           "tin", "tout", "tcr", "tcw", "web", "bytes", "source")


def _decorate(d, path, titles, cwds):
    """What is not in the parse state: codex's titles, agy's folders, and whether Mesh can resume or delete it."""
    agent, sid = d["agent"], d["id"]
    if agent == "codex" and titles.get(sid):
        d["title"] = titles[sid]
    if agent == "agy":
        d["cwd"] = cwds.get(sid) or d["cwd"] or ""
    # An agent resumes a conversation from the folder it belongs to. Gemini also reads only its own store, and
    # Mesh-started ones run in a private home: a conversation of the user's own ~/.gemini is not resumable here.
    d["resumable"] = bool(d["cwd"]) or agent not in ("gemini", "agy")
    if agent == "gemini":
        d["resumable"] &= Path(path).is_relative_to(meshpaths.CONF_DIR / "gemini-home")
    d["deletable"] = agent in DELETABLE


def listing(since=None):
    """The sessions to show, newest first, as (items, gone, full): with since (a
    generation the client has), only the entries changed after it and the ids of
    those removed; everything (full) when since predates this process or the titles."""
    titles, cwds = _codex_titles_safe(), _agy_cwds_safe()
    # a generation from the future: a page kept across a restart where the clock stepped back
    full = since is None or since < _floor or since < _titles["gen"] or since > gen
    from_db = _hdb.listing(None if full else since)
    if from_db:
        sessions, gone, db_full = from_db
        out = [dict(_from_db(item, titles, cwds), has_summary=item.get("has_summary")) for item in sessions]
        out.sort(key=lambda d: -(d["updated"] or 0))
        full = full or db_full
        return out, [] if full else gone, full
    out = []
    with _lock:
        for path, e in _files.items():
            s = e["s"]
            if not full and e.get("g", 0) <= since:
                continue
            if s["sub"] or not s["id"] or not (s["n_user"] or s["summary"] or (s["agent"] == "vibe" and s["title"])):
                continue   # codex sub-agents, empty or aborted sessions
            d = {k: s.get(k) for k in _PUBLIC}
            d["has_summary"] = bool(s["summary"])
            _decorate(d, path, titles, cwds)
            out.append(d)
        gone = [] if full else [k for g, k in _gone if g > since]
    out.sort(key=lambda d: -(d["updated"] or 0))
    return out, gone, full


def _mesh_gemini(path):
    """Whether a Gemini transcript is in the private home Mesh gives the agents it starts."""
    return Path(path).is_relative_to(meshpaths.CONF_DIR / "gemini-home")


def newest_for(agent, cwd, since, exclude=()):
    """The id of the one conversation of `agent` in folder `cwd` that was *started* at or after `since`
    (the agent's own start), else None: two candidates, or none, and nothing is guessed. A conversation
    only updated since then is another session's, resumed. `exclude`: the ids other live sessions hold.
    Gemini's are looked for in Mesh's own home only: the user's ~/.gemini holds conversations of agents
    that Mesh did not start."""
    cwds = _agy_cwds() if agent == "agy" else {}
    with _lock:
        found = {s["id"] for path, s in ((p, e["s"]) for p, e in _files.items())
                 if s["agent"] == agent and s["id"] and not s["sub"] and s["id"] not in exclude
                 and isinstance(s["started"], (int, float)) and s["started"] >= since
                 and (cwds.get(s["id"]) if agent == "agy" else s["cwd"]) == cwd
                 and (agent != "gemini" or _mesh_gemini(path))}
    return next(iter(found)) if len(found) == 1 else None


def _from_db(item, titles, cwds):
    """A database record in the shape of the in-memory one (codex titles, agy folders and the
    resume/delete flags stay the live ones)."""
    d = {k: item.get(k) for k in _PUBLIC}
    path = item.get("path") or (find(d["agent"], d["id"])[0] if d["agent"] == "gemini" else "")   # only gemini's flag reads it
    _decorate(d, path or "", titles, cwds)
    return d


def find(agent, sid):
    """(path, parse state) of a conversation: its first path when several hold it."""
    with _lock:
        paths = _keys.get((agent, sid))
        path = min(paths) if paths else None
        return (path, _files[path]["s"]) if path else (None, None)


def db_stats():
    """The database adapter's state: ready, live, how many transcripts are synced, how many were refused."""
    return _hdb.stats()


def db_search(q, limit=200):
    """The ids of the conversations the database finds for q, best first, or None (see history_db.search)."""
    return _hdb.search(q, limit)


def detail(agent, sid):
    from_db = _hdb.detail(agent, sid)
    if from_db:
        d = _from_db(from_db, _codex_titles_safe(), _agy_cwds_safe())
        d.update(summary=from_db.get("summary") or "", path=from_db.get("path"))
        return d
    path, s = find(agent, sid)
    if not s:
        return None
    d = {k: s.get(k) for k in _PUBLIC}
    _decorate(d, path, _codex_titles_safe(), _agy_cwds_safe())
    d.update(summary=s["summary"], path=path)
    return d


QUIET = 120   # seconds without a write before a transcript may be deleted


class Unsupported(Exception):
    """Mesh does not delete this agent's conversations (a database row, a directory with other files)."""


class Busy(Exception):
    """The transcript is still being written: an agent may be running it."""


def delete(agent, sid):
    """Remove a session's transcript and what claude keeps beside it. A transcript
    written to in the last QUIET seconds is refused, whether or not its agent was
    seen running: deleting under a live agent loses the conversation."""
    path, s = find(agent, sid)
    if not s:
        raise LookupError(sid)
    if agent not in DELETABLE:
        raise Unsupported(agent)
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z-]*", sid):
        raise LookupError(sid)
    try:
        if time.time() - os.stat(path).st_mtime < QUIET:
            raise Busy(sid)
        os.unlink(path)
    except FileNotFoundError:
        raise LookupError(sid) from None
    finally:
        if not os.path.exists(path):
            with _lock:
                _drop(path)
            _hdb.reconcile(wait=_hdb.DB_DELETE_WAIT)   # a scan holding the helper reconciles it at its end
    if agent == "claude":
        for extra in (Path(path).parent / sid, CLAUDE / "file-history" / sid, CLAUDE / "session-env" / sid):
            shutil.rmtree(extra, ignore_errors=True)


def _search_roots():
    return [str(d) for d in (CLAUDE / "projects", CODEX / "sessions", _pi_root(), *_gemini_roots(), _copilot_root(),
                             *(b / "brain" for b in _agy_roots()), _vibe_root()) if d.is_dir()]


def search_argv(q):
    """Command listing the transcripts that mention q (case-insensitive, literal), or None.
    ripgrep when installed (multi-threaded: ~1.5 s instead of ~100 s for grep over 20 GB of
    transcripts), else grep -r. Directories are searched, not the indexed files: their
    number has no bound and would overflow the command line. OpenCode's SQLite store is
    searched apart (search_db)."""
    roots = _search_roots()
    if not roots or not q or "\n" in q or "\r" in q:   # -e splits a pattern on newlines
        return None
    if shutil.which("rg"):
        return ["rg", "-l", "-i", "-F", "--no-messages", "--no-ignore", "--hidden", "-g", "*.jsonl",
                "-g", "**/chunks/*.json", "-e", q, "--", *roots]
    return ["grep", "-r", "-l", "-i", "-F", "-s", "--include=*.jsonl",
            "--include=*.json", "-e", q, "--", *roots]


_SIBLING = {"transcript_full.jsonl": "transcript.jsonl"}   # a hit in one file, indexed by the other


def search_ids(paths):
    """The history ids ("agent:id") of the indexed transcripts among paths."""
    with _lock:
        found = []
        for p in paths:
            sibling = _SIBLING.get(Path(p).name)
            if Path(p).parent.name == "chunks":   # Vibe's transcript chunks: the session's meta.json is indexed
                sibling = "../meta.json"
            e = _files.get(p) or (sibling and _files.get(os.path.normpath(Path(p).parent / sibling)))
            if e and (key := f"{e['s']['agent']}:{e['s']['id']}") not in found:
                found.append(key)
        return found



# The mesh-history adapter (history_db.py) reads this module back, so it is imported once everything above exists.
import history_db as _hdb  # noqa: E402
