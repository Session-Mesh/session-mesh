# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Snapshot of the mesh sessions, so they can be recreated after a ptyhost restart.

Restarting ptyhost ends every mesh session. The server therefore keeps, in
~/.config/session-mesh/sessions-snapshot.json (0600, written atomically), what
is needed to start each one again: name, working directory, and for a claude
or codex session the conversation id and argv (the command line is rebuilt by
resumeargs, never replayed). The file has two lists:

    {"version": 1,
     "host": None | str, # identity of the ptyhost that listed "live" (pid and start time)
     "live": [entry],    # the mesh sessions as last seen
     "lost": [entry]}    # sessions that disappeared together with their ptyhost

A session that ends (exit, kill) is dropped. A session that disappears because
its ptyhost was restarted moves to "lost", and stays offered until restored,
ignored, or 14 days old. A restart is told by the host's identity changing,
never by the number of survivors: typing `exit` in the only session must not
offer it back. When an identity is unknown (the server could not read it, or
an older snapshot has none), the former rule applies: no previously seen
session left means a restart. Nothing is written while ptyhost does not answer.

The file is only written by the server, but every read validates it: what
comes out of load() has the types, name and conversation id the restore path
relies on. The working directory is checked again when an entry is offered
or restored, since it may have gone since.

    entry = {"name", "cwd", "created", "agent": None | {"type", "session_id", "argv"},
             "cmd": None | "<foreground command, shown only>", "lost_at": None | float,
             "org": {"label": None | str, "folder": None | str, "rank": None | int}}

"org" is the session's label, folder and rank as organize.view showed them while it lived. organize
forgets a session as soon as ptyhost no longer lists it, so a restart wipes mesh.json's sessions at
once; the snapshot is where the owner's arrangement survives until restore (or "Ignorer", which drops
it with the entry). Each field is validated on read; a bad one is dropped, the session is still offered.
"""

import json
import math
import os
import re
import threading
import time

import meshpaths
import fsutil
import organize

FILE = meshpaths.CONF_DIR / "sessions-snapshot.json"
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
SID_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{7,63}")   # never an option: it ends up in argv
NONCE_RE = re.compile(r"[0-9a-f]{32}")                    # sessiontoken.new_nonce()
HOST_RE = re.compile(r"[0-9]{1,10}:[0-9]{1,20}")         # ptyhost.host_identity(): pid:start ticks
AGENT_TYPES = ("claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe")
SHELL_KIND = "shell"        # the agent_kind of an offer with no agent
SHELLS = {"sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "csh", "tcsh"}
MAX_ENTRIES = 200
MAX_ARGV, MAX_ARG_LEN = 200, 4096
KEEP_SECONDS = 14 * 86400
_lock = threading.Lock()


# ---------------------------------------------------------------- entries

def _number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:       # an integer too large for a float
        return False


def _valid_agent(raw):
    if raw is None:
        return True
    return (isinstance(raw, dict) and raw.get("type") in AGENT_TYPES
            and (raw.get("session_id") is None
                 or (isinstance(raw["session_id"], str) and SID_RE.fullmatch(raw["session_id"])))
            and isinstance(raw.get("argv"), list) and len(raw["argv"]) <= MAX_ARGV
            and all(isinstance(a, str) and len(a) <= MAX_ARG_LEN for a in raw["argv"]))


def valid_org(raw):
    """label, folder and rank of raw, each kept only if well formed (organize.clean for the texts)."""
    raw = raw if isinstance(raw, dict) else {}
    text = {key: (organize.clean(raw[key]) or None) if isinstance(raw.get(key), str) else None
            for key in ("label", "folder")}
    rank = raw.get("rank")
    ok = isinstance(rank, int) and not isinstance(rank, bool) and rank >= 0
    return {**text, "rank": rank if ok else None}


def valid_entry(raw):
    """The normalised entry, or None when raw is not a well-formed one (structure only:
    whether the directory still exists is asked by usable())."""
    if not isinstance(raw, dict):
        return None
    name, cwd, cmd, lost_at = raw.get("name"), raw.get("cwd"), raw.get("cmd"), raw.get("lost_at")
    ok = (isinstance(name, str) and NAME_RE.fullmatch(name)
          and isinstance(cwd, str) and os.path.isabs(cwd) and "\0" not in cwd
          and _number(raw.get("created")) and _valid_agent(raw.get("agent"))
          and (cmd is None or isinstance(cmd, str)) and (lost_at is None or _number(lost_at)))
    if not ok:
        return None
    agent = raw["agent"]
    agent = None if agent is None else _normalised_agent(agent)
    entry = {"name": name, "cwd": cwd, "created": raw["created"], "agent": agent,
             "cmd": organize.clean(cmd) or None if cmd is not None else None, "lost_at": lost_at,
             "org": valid_org(raw.get("org"))}
    marker = _valid_marker(raw.get("restoring"))   # set by begin_restoring only; absent otherwise
    if marker:
        entry["restoring"] = marker
    return entry


def _valid_marker(raw):
    """The restoring marker {"nonce", optional "created"}, or None when raw is not one."""
    if not (isinstance(raw, dict) and isinstance(raw.get("nonce"), str) and NONCE_RE.fullmatch(raw["nonce"])):
        return None
    marker = {"nonce": raw["nonce"]}
    if _number(raw.get("created")):
        marker["created"] = raw["created"]
    return marker


IDENTITY_SOURCES = ("hooks", "argv")


def _normalised_agent(agent):
    """The stored form of an agent: ``identity_source`` ("hooks" or "argv", where the conversation id came
    from) is kept only when it is one of those two."""
    kept = {"type": agent["type"], "session_id": agent.get("session_id"), "argv": list(agent["argv"])}
    if agent.get("identity_source") in IDENTITY_SOURCES:
        kept["identity_source"] = agent["identity_source"]
    if _number(agent.get("started")) and agent["started"] > 0:
        kept["started"] = agent["started"]      # when the agent process started: see _keep_hooked_conversation
    return kept


def _identity_source(agent):
    """Where the conversation of a described agent was read: "hooks" (reported by the agent), "argv" (named
    in its launch arguments) or None (anything else, or no conversation)."""
    source = agent.get("identity_source") or ""
    if source.endswith(("_hook", "_hooks")):
        return "hooks"
    return "argv" if source.startswith("argv") else None


GUESSED_SOURCES = ("history_cwd",)


def _stored_session_id(agent):
    """The conversation to restore: what the agent reported or was launched with. One the history index
    guessed from the folder (``history_cwd``) is never stored: it may be another session's, and a stored
    id would later be kept over a listing that cannot tell (see _keep_hooked_conversation)."""
    return None if agent.get("identity_source") in GUESSED_SOURCES else agent.get("session_id")


def usable(entry):
    return os.path.isdir(entry["cwd"])


def _running(cmd):
    """The foreground command worth showing, None for a bare shell prompt."""
    first = (cmd or "").split(" ", 1)[0]
    if os.path.basename(first.lstrip("-")) in SHELLS:
        return None
    return organize.clean(cmd) or None


def entry_of(session):
    """The snapshot entry of one mesh session as server.list_sessions describes it, or None."""
    agent = session.get("agent")
    kept = None if not agent else {"type": agent.get("type"), "session_id": _stored_session_id(agent),
                                   "argv": agent.get("argv") or [], "identity_source": _identity_source(agent),
                                   "started": agent.get("started")}
    return valid_entry({"name": session.get("name"), "cwd": session.get("cwd"), "created": session.get("created"),
                        "agent": kept, "cmd": None if agent else _running(session.get("cmd")), "lost_at": None,
                        "org": {key: session.get(key) for key in ("label", "folder", "rank")}})


def public(entries):
    """What the page is told about restorable entries: never the argv."""
    return [{"name": e["name"], "cwd": e["cwd"], "created": e["created"],
             "agent": e["agent"]["type"] if e["agent"] else None,
             "resumable": bool(e["agent"] and e["agent"]["session_id"]), "running": e["cmd"]}
            for e in entries if usable(e)]


def provisional():
    """What the snapshot knows of each live session, by (name, created), before a listing describes
    it: the agent's type and conversation, or the command it ran. Never the argv."""
    with _lock:
        live = _load()["live"]
    return {_key(e): {"agent": e["agent"] and {"type": e["agent"]["type"], "session_id": e["agent"]["session_id"]},
                      "cmd": e["cmd"]} for e in live}


def management_lost(now=None):
    """The sealed restart-recovery facts which the management inventory may show.

    Unlike ``public()``, this deliberately does not expose the recovery action,
    CWD, command, conversation id or argv.  It is an evidence projection, not
    an alternate restore API.
    """
    now = time.time() if now is None else now
    with _lock:
        entries = _load()["lost"]
    out = []
    for entry in entries:
        lost_at = entry["lost_at"]
        if not _number(lost_at) or not 0 <= now - lost_at < KEEP_SECONDS:
            continue
        agent = entry["agent"]
        out.append({"name": entry["name"], "created": entry["created"],
                    "agent_type": agent["type"] if agent else "unknown", "lost_at": lost_at})
    # Normally _advance() has already capped ``lost`` before it is written.
    # Preserve that source's newest-created eviction rule for a syntactically
    # valid but hand-corrupted snapshot, then order the bounded display by the
    # recovery observation.  This path is read-only while ptyhost is down.
    bounded = sorted(out, key=lambda entry: (-entry["created"], entry["name"], -entry["lost_at"]))[:MAX_ENTRIES]
    return sorted(bounded, key=lambda entry: (-entry["lost_at"], entry["name"], entry["created"]))


# ---------------------------------------------------------------- file

def _entries(raw):
    found = [valid_entry(e) for e in raw] if isinstance(raw, list) else []
    return [e for e in found if e]


def _valid_host(raw):
    return raw if isinstance(raw, str) and HOST_RE.fullmatch(raw) else None


def _load():
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    return {"host": _valid_host(raw.get("host")),
            "live": _entries(raw.get("live")), "lost": _entries(raw.get("lost"))}


def _save(state, *, required=False):
    try:
        fsutil.atomic_write(FILE, json.dumps({"version": 1, **state}, indent=1), sync_dir=required)
    except OSError as exc:       # a read-only config dir must not break the session list
        print(f"respawn: snapshot not written: {exc!r}", flush=True)
        if required:
            raise
        return False
    return True


def _store(old, new, *, required=False):
    """Whether the file now holds ``new``: False only when a needed write failed."""
    return new == old or _save(new, required=required)


def _key(entry):
    return (entry["name"], entry["created"])


def _restarted(state, host, gone, kept_before):
    """Whether the sessions that are gone went with their ptyhost (see the module docstring)."""
    if host is not None and state["host"] is not None:
        return host != state["host"]
    return bool(gone) and not kept_before


def _advance(state, seen, live, now, host=None):
    """The state after the mesh was seen: ``seen`` is the (name, created) of every session ptyhost
    lists, ``live`` the entries that could be built from them, ``host`` the identity of the ptyhost
    that listed them or None (see the module docstring). A listed session whose entry cannot be
    built right now (its directory unreadable for a moment) keeps its previous entry, so that it
    is not mistaken for a lost one."""
    tracked = {_key(e) for e in live}
    kept_before = [e for e in state["live"] if _key(e) in seen]
    gone = [e for e in state["live"] if _key(e) not in seen]
    lost = {e["name"]: e for e in state["lost"]
            if e["lost_at"] is None or now - e["lost_at"] < KEEP_SECONDS}
    if _restarted(state, host, gone, kept_before):
        for entry in gone:
            lost[entry["name"]] = {**entry, "lost_at": now}
    carried = [e for e in kept_before if _key(e) not in tracked]
    kept = sorted(lost.values(), key=lambda e: -e["created"])[:MAX_ENTRIES]
    return {"host": host if host is not None else state["host"],
            "live": sorted(live + carried, key=lambda e: e["name"]), "lost": kept}


def update(mesh, listed, now=None, host=None):
    """The restorable entries after ``record``; see there."""
    return record(mesh, listed, now, host)[0]


def record(mesh, listed, now=None, host=None, seen=None):
    """Record the mesh sessions (the dicts of list_sessions); return (the restorable entries,
    whether the snapshot file holds the recorded state: False when ptyhost did not answer or the
    write failed). ``host`` is the identity of the ptyhost that listed them
    (ptyhost.host_identity), None when unknown. ``seen``: the (name, created) of every session
    the host listed, when ``mesh`` describes only some of them (the others keep their entry).
    Does nothing while ptyhost did not answer (``listed`` false)."""
    if not listed:
        return [], False
    now = time.time() if now is None else now
    seen = {(s.get("name"), s.get("created")) for s in mesh} if seen is None else seen
    live = [e for e in map(entry_of, mesh) if e]
    with _lock:
        old = _load()
        _keep_hooked_conversation(old, live)
        new = _advance(old, seen, live, now, _valid_host(host))
        durable = _store(old, new)
        return public(new["lost"]), durable


# The agents whose hooks (or plugin) report the conversation they are in: a listing that has not heard a
# hook yet (a web server just restarted) names the one discovery read or none, and must not take the
# snapshot back from the reported one.  Copilot and OpenCode replace the discovered conversation with
# the reported one; Gemini, Antigravity and Vibe only fill in a missing one.
HOOKED_TYPES = ("copilot", "opencode", "gemini", "agy", "vibe")


def _keep_hooked_conversation(old, live):
    """A conversation known from the agent's hooks is not always applied by every caller of list_sessions
    (a listing made before the web server has heard a hook does not): a listing without it must
    not erase the one the snapshot already holds for the same incarnation, or a restart could not resume
    the session.  A restored Copilot is launched with ``--resume=<A>``, so its argv always names a
    conversation: the hooked one (B, after a /new or /resume) is kept over an argv one for the same
    incarnation; the same holds for the conversation OpenCode's plugin reported over the one discovery
    read (``--session``, or the lone conversation written since the start).

    The incarnation is the terminal, not the agent process: quit the agent and start it again in the same
    terminal (``opencode --session C``, or plain ``opencode``) and the snapshot's conversation is the
    first process's.  It is kept over a listed one only for the same process (same start time), and, when
    a start time is unknown, only where the listing read no conversation."""
    before = {(e["name"], e["created"]): e["agent"] for e in old["live"]}
    for entry in live:
        agent, previous = entry["agent"], before.get((entry["name"], entry["created"]))
        if not (agent and agent["type"] in HOOKED_TYPES and previous and previous["type"] == agent["type"]):
            continue
        # A snapshot written before start times were stored has none: for that one listing the old rule holds
        # (the snapshot's conversation is kept) and the listed start time is stored for the next ones.
        same = True if _stored_before_start_times(previous, agent) else _same_process(previous, agent)
        if same is False or not previous["session_id"]:
            continue
        hooked_over_other = previous.get("identity_source") == "hooks" and agent.get("identity_source") != "hooks"
        # Without both start times the process is not known to be the same: only a listing that read no
        # conversation at all gives way to the snapshot's one, never one that read a conversation itself.
        if agent["session_id"] is None or (same and hooked_over_other):
            agent["session_id"] = previous["session_id"]
            agent["identity_source"] = previous.get("identity_source")


# The start time is read from the boot time and the process ticks, in seconds: two reads of one process
# agree to well within this (the server uses the same slack for the hook reports it drops).
_SAME_PROCESS_SLACK = 2.0


def _known_start(agent):
    return _number(agent.get("started")) and agent["started"] > 0


def _stored_before_start_times(previous, agent):
    """Whether the snapshot's agent has no start time while the listed one has (a snapshot written by an
    older version, read for the first time after an update)."""
    return not _known_start(previous) and _known_start(agent)


def _same_process(previous, agent):
    """Whether the snapshot's agent and the listed one are the same process (their start times agree),
    False when they are two (the agent was quit and started again in the terminal: the conversation the
    snapshot holds belongs to the first), None when a start time is unknown."""
    before, now = previous.get("started"), agent.get("started")
    if not (_number(before) and before > 0 and _number(now) and now > 0):
        return None
    return abs(before - now) <= _SAME_PROCESS_SLACK


def lost_entry(name):
    """The full entry offered under ``name``, still valid and with its directory, else None."""
    with _lock:
        return next((e for e in _load()["lost"] if e["name"] == name and usable(e)), None)


MAIL_RETENTION_SECONDS = 24 * 3600


def mail_offers(now=None):
    """The agent incarnations ({id, created, agent}) a restore could still bring back, whose mail
    must not be pruned yet; None when the snapshot cannot be read (the caller then keeps all).

    Read synchronously from the snapshot file, without waiting for update(): right after a host
    loss the file still lists the vanished sessions as live. A live entry never expires here:
    the first update() after the loss turns it into a lost one with a fresh lost_at (or drops
    it when the session was only closed), and the retention is counted from that moment. A lost
    entry counts for MAIL_RETENTION_SECONDS after lost_at. Whether the directory still exists is
    not asked: when in doubt, keep."""
    now = time.time() if now is None else now
    with _lock:
        try:
            text = FILE.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            return None
    try:
        raw = json.loads(text)
    except ValueError:
        return None
    if not isinstance(raw, dict) or not all(isinstance(raw.get(key, []), list) for key in ("live", "lost")):
        return None
    return [{"id": entry["name"], "created": entry["created"], "agent": entry["agent"]["type"]}
            for entry in _entries(raw.get("live")) + _entries(raw.get("lost"))
            if entry["agent"]
            and (entry["lost_at"] is None or now - entry["lost_at"] <= MAIL_RETENTION_SECONDS)]


def mail_retention_ended(entry, now=None):
    """Whether the mail of this lost entry is older than MAIL_RETENTION_SECONDS (the offer itself
    lives KEEP_SECONDS): a restoration then brings the session back without its mail."""
    now = time.time() if now is None else now
    return _number(entry["lost_at"]) and now - entry["lost_at"] > MAIL_RETENTION_SECONDS


def by_rank(names):
    """``names`` sorted by their saved rank (never ranked last), so that restoring them in this
    order rebuilds the owner's order."""
    with _lock:
        ranks = {e["name"]: e["org"]["rank"] for e in _load()["lost"]}
    return sorted(names, key=lambda n: (ranks.get(n) is None, ranks.get(n) or 0))


def drop_lost(names, *, required=False):
    """Stop offering these sessions (restored, or ignored by the owner). ``required``: raise
    OSError when the snapshot cannot be written, and LookupError when no offer carries one of the
    names (the exact restore must not report a success the file does not show)."""
    names = set(names)
    with _lock:
        old = _load()
        if required and not names <= {e["name"] for e in old["lost"]}:
            raise LookupError("no such offer")
        _store(old, {**old, "lost": [e for e in old["lost"] if e["name"] not in names]}, required=required)


EXPECTED_KEYS = ("name", "created", "agent_kind", "resume_id", "cwd")
MAX_CWD = 4096


def parse_expected(raw):
    """The exact-restore precondition as a normalised dict, or ValueError naming the problem.
    Closed shape: exactly EXPECTED_KEYS, each of the right type and length."""
    if not isinstance(raw, dict) or set(raw) != set(EXPECTED_KEYS):
        raise ValueError(f"expected: an object with exactly {', '.join(EXPECTED_KEYS)}")
    name, created, kind, sid, cwd = (raw[k] for k in EXPECTED_KEYS)
    if not (isinstance(name, str) and NAME_RE.fullmatch(name)):
        raise ValueError("expected.name: a session name")
    if not _number(created):
        raise ValueError("expected.created: a finite number")
    if kind not in (*AGENT_TYPES, SHELL_KIND):
        raise ValueError("expected.agent_kind: one of " + ", ".join((*AGENT_TYPES, SHELL_KIND)))
    if sid is not None and not (isinstance(sid, str) and SID_RE.fullmatch(sid)):
        raise ValueError("expected.resume_id: null or a conversation id")
    if sid is not None and kind == SHELL_KIND:
        raise ValueError("expected.resume_id: a shell has none")
    if not (isinstance(cwd, str) and 0 < len(cwd) <= MAX_CWD and os.path.isabs(cwd) and "\0" not in cwd):
        raise ValueError("expected.cwd: an absolute path")
    return {"name": name, "created": created, "agent_kind": kind, "resume_id": sid, "cwd": cwd}


def offer_mismatch(entry, expected):
    """The fields of ``expected`` that differ from the offered ``entry`` (empty: the same offer)."""
    agent = entry["agent"]
    actual = {"name": entry["name"], "created": entry["created"],
              "agent_kind": agent["type"] if agent else SHELL_KIND,
              "resume_id": agent["session_id"] if agent else None, "cwd": entry["cwd"]}
    return [key for key in EXPECTED_KEYS if actual[key] != expected[key]]


def _set_marker(name, created, marker):
    """Set (or, with None, remove) the restoring marker of the offer (name, created). Raises
    LookupError when no such offer exists and OSError when the snapshot cannot be written."""
    with _lock:
        old = _load()
        if not any(_key(e) == (name, created) for e in old["lost"]):
            raise LookupError("no such offer")
        lost = []
        for e in old["lost"]:
            if _key(e) == (name, created):
                e = {k: v for k, v in e.items() if k != "restoring"}
                e.update({"restoring": marker} if marker else {})
            lost.append(e)
        _store(old, {**old, "lost": lost}, required=True)


def begin_restoring(name, created, nonce):
    """Durably record the intent to restore the offer (name, created) under session ``nonce``,
    BEFORE the session is created (the nonce goes into its host meta): whatever happens next, a
    retry finds the session by its nonce or learns that none can be trusted."""
    _set_marker(name, created, {"nonce": nonce})


def bind_restoring(name, created, nonce, session_created):
    """Add the born date of the session to the marker (the nonce stays the identity)."""
    _set_marker(name, created, {"nonce": nonce, "created": session_created})


def clear_restoring(name, created):
    """Withdraw the intent: no session was created for it."""
    _set_marker(name, created, None)


def rename_folder(old, new):
    """Carry an accepted folder rename into live and restart-recovery snapshots.

    ``organize.py`` owns the live mesh configuration.  Its server caller invokes
    this only after that rename has succeeded, so a session waiting to be
    restored does not point at a folder name that no longer exists.
    """
    old, new = organize.clean(old), organize.clean(new)
    if not old or not new or old == new:
        return
    with _lock:
        before = _load()

        def migrated(entries):
            return [{**entry, "org": {**entry["org"], "folder": new}}
                    if entry["org"]["folder"] == old else entry
                    for entry in entries]

        after = {**before, "live": migrated(before["live"]), "lost": migrated(before["lost"])}
        # A caller changing a folder is entitled to a definite result.  The
        # periodic snapshot path remains best-effort, but this migration must
        # let the API roll the mesh configuration back if its atomic write
        # cannot be completed.
        _store(before, after, required=True)


def forget_live(name, created=None):
    """A session closed on purpose through the mesh: it must never be offered afterwards."""
    with _lock:
        old = _load()
        _store(old, {**old, "live": [e for e in old["live"]
                                     if e["name"] != name or (created is not None and e["created"] != created)]})
