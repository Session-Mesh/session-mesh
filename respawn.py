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
             "org": {"label": None | str, "folder": None | str, "rank": None | int},
             "account": "<alias id>" (only for a session started with an operator's account alias)}

"org" is the session's label, folder and rank as organize.view showed them while it lived. organize
forgets a session as soon as ptyhost no longer lists it, so a restart wipes mesh.json's sessions at
once; the snapshot is where the owner's arrangement survives until restore (or "Ignorer", which drops
it with the entry). Each field is validated on read; a bad one is dropped, the session is still offered.
"""

import contextlib
import fcntl
import json
import math
import os
import re
import stat
import threading
import time

import meshpaths
import fsutil
import organize

FILE = meshpaths.CONF_DIR / "sessions-snapshot.json"
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
SID_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{7,63}")   # never an option: it ends up in argv
NONCE_RE = re.compile(r"[0-9a-f]{32}")                    # sessiontoken.new_nonce()
ACCOUNT_RE = re.compile(r"[a-z0-9-]{1,32}")               # an operator's alias id (server.ACCOUNT_ID_RE)
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
    account = raw.get("account")    # the operator's alias the agent ran with (server.account_environment)
    if isinstance(account, str) and ACCOUNT_RE.fullmatch(account):
        entry["account"] = account
        revision = raw.get("account_context_revision")
        if isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{64}", revision):
            entry["account_context_revision"] = revision
    default_revision = raw.get("default_context_revision")
    if default_revision is not None:
        if account is not None or not isinstance(default_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", default_revision):
            return None
        entry["default_context_revision"] = default_revision
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
                        "org": {key: session.get(key) for key in ("label", "folder", "rank")},
                         "account": session.get("account"),
                         "account_context_revision": session.get("account_context_revision"),
                         "default_context_revision": session.get("default_context_revision")})


def public(entries, registry=None):
    """What the page is told about restorable entries: never the argv. ``resumable`` is what a restore
    does: the identity ``registry``'s conversation first (read when None), else the snapshot's."""
    registry = identities() if registry is None else registry
    resolved = [resolved_identity(e, registry)[0] for e in entries if usable(e)]
    return [{"name": e["name"], "cwd": e["cwd"], "created": e["created"],
             "agent": e["agent"]["type"] if e["agent"] else None,
             "resumable": bool(e["agent"] and e["agent"]["session_id"]), "running": e["cmd"]}
            for e in resolved]


def provisional():
    """What the snapshot knows of each live session, by (name, created), before a listing describes
    it: the agent's type and conversation, or the command it ran. Never the argv."""
    with _lock:
        live = _load()["live"]
    return {_key(e): {"agent": e["agent"] and {"type": e["agent"]["type"], "session_id": e["agent"]["session_id"]},
                      "cmd": e["cmd"]} for e in live}


def restorable():
    """The restorable entries of the snapshot as it is (what ``record`` returns), without writing it."""
    with _lock:
        return public(_load()["lost"])


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


def update(mesh, listed, now=None, host=None, nonces=None):
    """The restorable entries after ``record``; see there."""
    return record(mesh, listed, now, host, nonces)[0]


def record(mesh, listed, now=None, host=None, nonces=None, seen=None, order=None):
    """Record the mesh sessions (the dicts of list_sessions); return (the restorable entries,
    whether the snapshot file holds the recorded state: False when ptyhost did not answer or the
    write failed). ``host`` is the identity of the ptyhost that listed them
    (ptyhost.host_identity), None when unknown. ``seen``: the (name, created) of every session
    the host listed, when ``mesh`` describes only some of them (the others keep their entry).
    ``nonces``: {(name, created): nonce} of the listed sessions, which binds the identity registry's
    entries written before their session was listed. ``order``: time.monotonic() when the host was read
    (by default, now). Does nothing while ptyhost did not answer (``listed`` false)."""
    if not listed:
        return [], False
    order = time.monotonic() if order is None else order
    now = time.time() if now is None else now
    read_at = now - (time.monotonic() - order)      # the wall clock of the read: entries written later
    seen = {(s.get("name"), s.get("created")) for s in mesh} if seen is None else seen
    live = [e for e in map(entry_of, mesh) if e]
    with _lock:
        old = _load()
        _keep_hooked_conversation(old, live)
        new = _advance(old, seen, live, now, _valid_host(host))
        durable = _store(old, new)
    registry = _record_identities(mesh, nonces or {}, old, new, now, seen, order, read_at)
    return public(new["lost"], registry), durable


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


def rebind_offer(expected, original, account, revision):
    """Bind exactly the unchanged legacy offer; never create or resume a session."""
    with _lock:
        old = _load()
        entry = next((e for e in old["lost"] if e["name"] == expected["name"] and usable(e)), None)
        if (entry != original or entry is None or offer_mismatch(entry, expected)
                or not entry.get("account") or entry.get("account_context_revision")
                or entry.get("restoring")):
            raise LookupError("offer changed")
        replacement = {**entry, "account": account, "account_context_revision": revision}
        _store(old, {**old, "lost": [replacement if e is entry else e for e in old["lost"]]}, required=True)


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


# ---------------------------------------------------------------- identity registry
#
# session-identities.json, next to the snapshot (0600, replaced atomically under a lock): the
# conversation of each session incarnation, written when it becomes known and never guessed.
#
#     {"version": 1, "generation": int, "entries": [identity]}
#     identity = {"session": {"name", "created": float | None, "nonce": str | None},
#                 "agent", "id": str | None, "source": "chosen" | "hook" | "observed",
#                 "evidence": "<kind>:<detail>", "agent_started": float | None,
#                 "observed_at": float, "generation": int, "state": "active" | "contested",
#                 "holds_open": bool}
#
# ``chosen``: Mesh named the conversation before the agent started; ``hook``: the agent's hook
# reported it; ``observed``: a listing saw it exactly (the rollout a Codex holds open, the pid file
# Claude writes). The snapshot is rebuilt from every listing; this file keeps what was known, and a
# server that does not know it leaves it alone. ocaml/identity (Mesh_identity) implements the same
# rules; both are checked against the vectors in ocaml/identity/test/vectors.

IDENTITY_NAME = "session-identities.json"
IDENTITY_VERSION = 1
IDENTITY_MAX_ENTRIES, IDENTITY_MAX_BYTES = 2 * MAX_ENTRIES, 512 * 1024
IDENTITY_GRACE = 60.0       # an entry outlives an unlisted session this long: it may be written just before
IDENTITY_RANK = {"observed": 1, "hook": 2, "chosen": 3}
IDENTITY_STATES = ("active", "contested")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CONVERSATION_RE = {**dict.fromkeys(("claude", "codex", "pi", "gemini", "copilot", "vibe"), _UUID_RE),
                   "opencode": re.compile(r"ses_[0-9A-Za-z]{8,60}"),
                   "agy": re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{7,63}")}
EVIDENCE_RE = re.compile(r"[a-z]{1,16}:[A-Za-z0-9_.-]{1,48}")
OBSERVED_SOURCES = ("open_rollout", "pid_metadata")     # what discover reads exactly from the process
_FACT_KEYS = ("session", "agent", "id", "source", "evidence", "agent_started", "state", "holds_open")
_identity_lock = threading.Lock()
_LAST_LISTED = [None]   # (order, read_at, incarnations) of the newest host list recorded: what a hook compares with
_last_listed_lock = threading.Lock()
LISTED_FRESH = 25.0     # seconds (two snapshot rounds and some) after which a hook compares with no host list


def identity_file():
    """The registry's path, next to the snapshot (a test that moves one moves both)."""
    return FILE.with_name(IDENTITY_NAME)


def _valid_incarnation(raw):
    """{name, created, nonce} with created or nonce known (both when the listing gave both), or None."""
    if not isinstance(raw, dict):
        return None
    name, created, nonce = raw.get("name"), raw.get("created"), raw.get("nonce")
    ok = (isinstance(name, str) and NAME_RE.fullmatch(name)
          and (created is None or _number(created))
          and (nonce is None or (isinstance(nonce, str) and NONCE_RE.fullmatch(nonce)))
          and (created is not None or nonce is not None))
    return {"name": name, "created": created, "nonce": nonce} if ok else None


def _optional_time(value):
    return value is None or (_number(value) and value > 0)


def _valid_identity(raw):
    """An identity entry with every field checked, or None."""
    if not isinstance(raw, dict):
        return None
    session, agent, sid = _valid_incarnation(raw.get("session")), raw.get("agent"), raw.get("id")
    state, generation, evidence = raw.get("state"), raw.get("generation"), raw.get("evidence")
    ok = (session is not None and isinstance(agent, str) and agent in CONVERSATION_RE
          and isinstance(raw.get("source"), str) and raw["source"] in IDENTITY_RANK and state in IDENTITY_STATES
          and (sid is None if state == "contested" else isinstance(sid, str) and CONVERSATION_RE[agent].fullmatch(sid))
          and isinstance(evidence, str) and EVIDENCE_RE.fullmatch(evidence)
          and _optional_time(raw.get("agent_started")) and _number(raw.get("observed_at"))
          and isinstance(generation, int) and not isinstance(generation, bool) and generation >= 0
          and isinstance(raw.get("holds_open"), bool))
    if not ok:
        return None
    return {"session": session, "agent": agent, "id": sid, "source": raw["source"], "evidence": evidence,
            "agent_started": raw.get("agent_started"), "observed_at": raw["observed_at"],
            "generation": generation, "state": state, "holds_open": raw["holds_open"]}


def _valid_claim(raw):
    """A claim {session, agent, id, source, evidence, agent_started?, holds_open?}, checked as an entry."""
    if not isinstance(raw, dict):
        return None
    return _valid_identity({**raw, "observed_at": 0, "generation": 0, "state": "active",
                            "holds_open": raw.get("holds_open", False)})


def same_incarnation(a, b):
    """Whether two incarnations are one: same name, created and nonce equal wherever both know them,
    and at least one of the two known on both sides."""
    if a["name"] != b["name"]:
        return False
    shared = [key for key in ("created", "nonce") if a[key] is not None and b[key] is not None]
    return bool(shared) and all(a[key] == b[key] for key in shared)


def _bound(known, seen):
    """``known`` with the fields it lacks taken from ``seen`` (the same incarnation)."""
    return {key: seen[key] if known[key] is None else known[key] for key in ("name", "created", "nonce")}


def _strength(entry):
    """I4: chosen > hook > observed, then the one that holds the rollout open."""
    return IDENTITY_RANK[entry["source"]], entry["holds_open"]


def _started_after(claim, entry):
    """Whether the claim's agent process started after the entry was made: the agent was quit and
    started again in the terminal."""
    before = entry["agent_started"] if entry["agent_started"] is not None else entry["observed_at"]
    return claim["agent_started"] is not None and claim["agent_started"] > before + _SAME_PROCESS_SLACK


def _started_before(claim, entry):
    """Whether the claim's agent process started before the entry's: a late report of one that quit."""
    return (claim["agent_started"] is not None and entry["agent_started"] is not None
            and claim["agent_started"] < entry["agent_started"] - _SAME_PROCESS_SLACK)


def merge_identity(registry, raw_claim, now, listed=None):
    """The registry after one claim (pure; the same object when nothing changes). In order:
    1. an invalid claim changes nothing; two entries the claim shows to be one incarnation (one keyed by
       its birth date, one by its nonce) become one, the newest (by generation);
    2. on the incarnation's own entry, another agent counts only from a process started after that
       entry, and another id from a process started before the entry's agent is a late report: ignored;
       an observation never replaces a ``hook`` or ``chosen`` id of the same process (a listing is
       sampled before it is recorded: it may be older than the report), only one of a later process; a
       refused claim still binds the entry's missing created or nonce. "Started after the entry": more
       than _SAME_PROCESS_SLACK after the entry's agent_started when it has one, else after its
       observed_at (_started_after);
    3. the same id of the same agent refreshes the entry (the stronger source, holds_open once seen, the
       later start time);
    4. another id replaces the entry (/clear, /new, an agent started again): the newest fact wins; a
       claim with no start time leaves the entry with none, as it does not say which process sent it
       (the agent may have been started again since the known start), so the next observation is
       compared with the time the entry was written (S1);
    5. one id has one holder among incarnations (I4): the stronger (_strength) keeps it and the other
       is ``contested``, with no id; when equal, the current holder keeps it. A holder the PTY host does
       not list (a lost offer, a session that ended) loses to any claim of a listed incarnation, as it
       is no holder for a launch (claim_identity).
    ``listed``: the incarnations the PTY host lists (None when unknown), kept before the others when the
    cap drops entries."""
    claim = _valid_claim(raw_claim)
    if claim is None:
        return registry
    registry, mine = _joined(registry, claim["session"])
    if mine is not None and _refused(mine, claim):    # the claim still says which incarnation the entry is
        return _rebound(registry, mine, claim["session"])
    if (mine is not None and mine["state"] == "active" and mine["id"] == claim["id"]
            and mine["agent"] == claim["agent"]):
        return _refreshed(registry, mine, claim)
    return _placed(registry, mine, claim, now, listed)


def _joined(registry, session):
    """(registry, the incarnation's entry or None): when several entries are that incarnation, only the
    newest stays."""
    matches = [e for e in registry["entries"] if same_incarnation(e["session"], session)]
    if len(matches) <= 1:
        return registry, (matches[0] if matches else None)
    mine = max(matches, key=lambda e: e["generation"])
    return {**registry, "entries": [e for e in registry["entries"] if e is mine or all(e is not m for m in matches)]}, mine


def _rebound(registry, mine, session):
    bound = _bound(mine["session"], session)
    if bound == mine["session"]:
        return registry
    return {**registry, "entries": [{**e, "session": bound} if e is mine else e for e in registry["entries"]]}


def _refused(mine, claim):
    if mine["agent"] != claim["agent"]:
        return not _started_after(claim, mine)
    if mine["id"] == claim["id"]:
        return False
    if _started_before(claim, mine):
        return True
    return (claim["source"] == "observed" and mine["source"] != "observed" and mine["state"] == "active"
            and not _started_after(claim, mine))


def _later(known, seen):
    """The start time an entry keeps: ``seen`` when none is known, or when it is a later process."""
    return seen if known is None or (seen is not None and seen > known + _SAME_PROCESS_SLACK) else known


def _refreshed(registry, mine, claim):
    stronger = IDENTITY_RANK[claim["source"]] > IDENTITY_RANK[mine["source"]]
    updated = {**mine, "session": _bound(mine["session"], claim["session"]),
               "holds_open": mine["holds_open"] or claim["holds_open"],
               "agent_started": _later(mine["agent_started"], claim["agent_started"])}
    if stronger:
        updated.update(source=claim["source"], evidence=claim["evidence"])
    if updated == mine:
        return registry
    return {**registry, "entries": [updated if e is mine else e for e in registry["entries"]]}


def _placed(registry, mine, claim, now, listed=None):
    generation = registry["generation"] + 1
    candidate = {**claim, "session": _bound(mine["session"], claim["session"]) if mine else claim["session"],
                 "observed_at": now, "generation": generation, "state": "active"}
    holder = next((e for e in registry["entries"] if e is not mine and e["state"] == "active"
                   and e["agent"] == claim["agent"] and e["id"] == claim["id"]), None)
    if holder is not None and _strength(candidate) <= _strength(holder) and not _outlisted(candidate, holder, listed):
        candidate.update(state="contested", id=None)
        holder = None
    if mine is not None and holder is None and all(mine[key] == candidate[key] for key in _FACT_KEYS):
        return registry
    entries = [{**e, "state": "contested", "id": None, "generation": generation} if e is holder else e
               for e in registry["entries"] if e is not mine]
    return {"generation": generation, "entries": _bounded([*entries, candidate], listed)}


def _outlisted(candidate, holder, listed):
    """Whether the PTY host lists the candidate's incarnation and not the holder's (``listed`` known)."""
    return listed is not None and _among(candidate, listed) and not _among(holder, listed)


def _bounded(entries, listed=None):
    """At most IDENTITY_MAX_ENTRIES: the entries of incarnations the PTY host does not list (``listed``,
    when known) are dropped first, then the oldest observed (in file order when equal)."""
    excess = len(entries) - IDENTITY_MAX_ENTRIES
    if excess <= 0:
        return entries

    def order(i):
        live = listed is not None and any(same_incarnation(entries[i]["session"], k) for k in listed)
        return live, entries[i]["observed_at"], i
    dropped = set(sorted(range(len(entries)), key=order)[:excess])
    return [e for i, e in enumerate(entries) if i not in dropped]


def prune_identities(registry, keep, now):
    """The registry without the entries of incarnations that are neither in ``keep`` (the listed ones and
    the ones offered for restore) nor younger than IDENTITY_GRACE; a kept entry takes the created or nonce
    it lacks from the listing, and two entries that become one incarnation keep the newest (by generation)."""
    entries = []
    for entry in registry["entries"]:
        seen = next((k for k in keep if same_incarnation(entry["session"], k)), None)
        if seen is not None:
            entries.append({**entry, "session": _bound(entry["session"], seen)})
        elif now - entry["observed_at"] < IDENTITY_GRACE:
            entries.append(entry)
    entries = [e for e in entries if not any(
        o is not e and same_incarnation(o["session"], e["session"]) and o["generation"] > e["generation"]
        for o in entries)]
    entries = [e for i, e in enumerate(entries)
               if not any(same_incarnation(o["session"], e["session"]) for o in entries[:i])]
    return registry if entries == registry["entries"] else {**registry, "entries": entries}


def resolve_identity(registry, name, created, agent):
    """(state, id) for the incarnation (name, created) running ``agent``: state "none" (no entry),
    "active" or "contested" (id None)."""
    query = {"name": name, "created": created, "nonce": None}
    entry = next((e for e in registry["entries"]
                  if same_incarnation(e["session"], query) and e["agent"] == agent), None)
    return ("none", None) if entry is None else (entry["state"], entry["id"])


def _empty_identities():
    return {"generation": 0, "entries": []}


def _parse_identities(text):
    """(registry, writable): see _decoded_identities."""
    registry, writable, _ = _decoded_identities(text)
    return registry, writable


def _decoded_identities(text):
    """(registry, writable, corrupt): a newer version, whatever its shape, is read as empty and never
    replaced by this server; any other malformed content (nesting too deep included) reads as empty and
    is ``corrupt``; each entry is checked, and a repeated incarnation dropped."""
    try:
        raw = json.loads(text)
    except (ValueError, RecursionError, MemoryError):
        raw = None
    version = raw.get("version") if isinstance(raw, dict) else None
    if not isinstance(version, int) or isinstance(version, bool):
        return _empty_identities(), True, True
    if version != IDENTITY_VERSION:
        return _empty_identities(), version < IDENTITY_VERSION, False
    if not isinstance(raw.get("entries"), list):
        return _empty_identities(), True, True
    entries = []
    for entry in map(_valid_identity, raw["entries"][:IDENTITY_MAX_ENTRIES]):
        if entry and not any(same_incarnation(entry["session"], e["session"]) for e in entries):
            entries.append(entry)
    generation = raw.get("generation")
    if not (isinstance(generation, int) and not isinstance(generation, bool) and generation >= 0):
        generation = max((e["generation"] for e in entries), default=0)
    return {"generation": generation, "entries": entries}, True, False


def _read_identities():
    """(registry, writable, dropped), registry None when there is no file. Never follows a link; a file
    that cannot be opened, is not a private regular one, is too large or is corrupt reads as empty and is
    replaced by the next write: ``dropped`` says why, for the one line that write logs."""
    try:
        fd = os.open(identity_file(), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None, True, None
    except OSError:
        return _empty_identities(), True, "unreadable"
    try:    # a directory opens too: a failure from here reads as empty, as a file that cannot be opened
        info = os.fstat(fd)
        private, data = stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077, b""
        if private:
            with os.fdopen(fd, "rb", closefd=False) as handle:
                data = handle.read(IDENTITY_MAX_BYTES + 1)
    except OSError:
        return _empty_identities(), True, "unreadable"
    finally:
        os.close(fd)
    if not private or len(data) > IDENTITY_MAX_BYTES:
        return _empty_identities(), True, "not a private regular file, or too large"
    try:
        registry, writable, corrupt = _decoded_identities(data.decode("utf-8"))
    except UnicodeDecodeError:
        registry, writable, corrupt = _empty_identities(), True, True
    return registry, writable, "corrupt" if corrupt else None


@contextlib.contextmanager
def _identity_locked():
    """The registry's thread lock, then its file lock (``<file>.lock``, an fcntl lock as OCaml's lockf)."""
    with _identity_lock:
        path = identity_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(f"{path}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)


def _migrated_identities(state, now):
    """What a first run starts from: the snapshot's exact conversations as ``observed`` (evidence
    ``migrated:<hooks|pid_metadata>``): the ones a hook reported, and a Claude one stored with no source,
    which only its pid file gives (a history guess is never stored). Never a launch argument (stale after a
    /clear or /resume inside the agent) nor a Codex one stored with no source (it may be the lone Codex's
    pick of its folder): a restore of an incarnation the registry does not know still reads the snapshot."""
    registry = _empty_identities()
    for entry in state["live"] + state["lost"]:
        agent = entry["agent"]
        source = agent.get("identity_source") if agent else None
        exact = "hooks" if source == "hooks" else "pid_metadata" if source is None and agent and agent["type"] == "claude" else None
        if exact and agent["session_id"]:
            registry = merge_identity(registry, {
                "session": {"name": entry["name"], "created": entry["created"], "nonce": None},
                "agent": agent["type"], "id": agent["session_id"], "source": "observed",
                "evidence": f"migrated:{exact}", "agent_started": agent.get("started")}, now)
    return registry


def _snapshot_state():
    with _lock:
        return _load()


def identities():
    """The registry as it is on disk (read only; with no file yet, what the migration would start from)."""
    registry, _, _ = _read_identities()
    return registry if registry is not None else _migrated_identities(_snapshot_state(), time.time())


def update_identities(change, *, snapshot=None, required=False):
    """Apply ``change`` (registry -> registry, pure) under the locks; write the result when it differs, or
    when there was no file (migrated from ``snapshot``, the snapshot state, read when None), or when the
    file was dropped as unreadable (one line logged, no id). A file of a newer version is never replaced.
    Returns the registry the file now holds. ``required``: raise OSError when the result is not written."""
    with _identity_locked():
        registry, writable, dropped = _read_identities()
        missing = registry is None
        if missing:
            registry = _migrated_identities(snapshot if snapshot is not None else _snapshot_state(), time.time())
        changed = change(registry)
        if not writable:
            if required:
                raise OSError("identity registry of a newer version: not replaced")
            return registry
        if not (missing or dropped or changed is not registry):
            return registry
        text = json.dumps({"version": IDENTITY_VERSION, **changed}, indent=1)
        try:
            fsutil.atomic_write(identity_file(), text, sync_dir=required)
        except OSError as exc:
            print(f"respawn: identity registry not written: {exc!r}", flush=True)
            if required:
                raise
            return registry
        if dropped:
            print(f"respawn: identity registry dropped ({dropped}) and replaced", flush=True)
        return changed


def _listing_claims(mesh, nonces):
    """The conversations a listing observed exactly (OBSERVED_SOURCES), as claims."""
    claims = []
    for session in mesh:
        agent = session.get("agent") or {}
        source = agent.get("identity_source")
        if source in OBSERVED_SOURCES and agent.get("session_id"):
            key = (session.get("name"), session.get("created"))
            claims.append({"session": {"name": key[0], "created": key[1], "nonce": nonces.get(key)},
                           "agent": agent.get("type"), "id": agent["session_id"], "source": "observed",
                           "evidence": f"observed:{source}", "agent_started": agent.get("started"),
                           "holds_open": source == "open_rollout"})
    return claims


def _keep_listed(listed, order, read_at):
    """Keep a recorded host list for the hook claims that follow, unless a newer read is kept: listings
    run in worker threads and may finish out of order."""
    with _last_listed_lock:
        if _LAST_LISTED[0] is None or order >= _LAST_LISTED[0][0]:
            _LAST_LISTED[0] = (order, read_at, listed)


def _recent_listed():
    """(incarnations, read_at) of the newest host list recorded, or (None, None) when there is none or it
    is older than LISTED_FRESH (a silent host): a hook then compares with no list, and I4 holds."""
    with _last_listed_lock:
        kept = _LAST_LISTED[0]
    if kept is None or time.monotonic() - kept[0] > LISTED_FRESH:
        return None, None
    return kept[2], kept[1]


def _listed_since(registry, listed, read_at):
    """``listed`` and the incarnations whose entry was written after the host list was read (a session
    launched since): that list cannot show them, so they are never taken for unlisted."""
    if listed is None or read_at is None:
        return listed
    return listed + [e["session"] for e in registry["entries"] if e["observed_at"] > read_at]


def _record_identities(mesh, nonces, before, after, now, seen, order, read_at):
    """One listing into the registry: its exact observations, then the entries of incarnations neither
    listed by the PTY host (``seen``, which may name sessions ``mesh`` does not describe) nor offered
    dropped. The listed incarnations are kept for the hook claims that follow (claim_identity), with
    ``order`` (time.monotonic() of the read) and ``read_at`` (its wall clock). ``before``: the snapshot
    state the migration reads when there is no file. Returns the registry the file holds, None when it
    could not be updated."""
    listed = [k for k in (_valid_incarnation({"name": name, "created": created, "nonce": nonces.get((name, created))})
                          for name, created in seen) if k]
    _keep_listed(listed, order, read_at)
    keep = listed + [k for k in (_valid_incarnation({"name": e["name"], "created": e["created"], "nonce": None})
                                 for e in after["lost"]) if k]
    claims = _listing_claims(mesh, nonces)

    def change(registry):
        compared = _listed_since(registry, listed, read_at)
        for claim in claims:
            registry = merge_identity(registry, claim, now, compared)
        return prune_identities(registry, keep, now)

    try:
        return update_identities(change, snapshot=before)
    except OSError as exc:      # the lock file: a read-only config dir must not break the session list
        print(f"respawn: identity registry not updated: {exc!r}", flush=True)
        return None


def claim_identity(session, agent, sid, source, evidence, *, live=None, required=False, fill_only=False):
    """Record what the mesh (``chosen``) or a hook (``hook``) says of an incarnation's conversation; its
    state after that: "active", "contested", "held" (a launch refused, nothing written: see ``live``), or
    None when the claim is invalid or changed nothing.
    ``live``: a launch; the incarnations the PTY host lists. An active entry of another of them holding
    the id, whatever its source, refuses the launch: that session may run the conversation although no
    listing shows it (an idle Codex that closed its rollout). An entry holding the id whose session is not
    listed (a lost offer, a session that ended) is no holder. Without ``live`` (a hook), the newest host
    list recorded says which incarnations are listed (merge_identity), with the ones whose entry was
    written after it was read; one older than LISTED_FRESH says nothing. ``required``: raise OSError when the claim
    is not written (a launch then starts nothing). ``fill_only``: the claim never replaces an id the
    incarnation already has (the hooks of Gemini, Antigravity and Vibe only fill in a missing one)."""
    claim = {"session": session, "agent": agent, "id": sid, "source": source, "evidence": evidence}
    if _valid_claim(claim) is None:
        return None
    held = []
    listed, read_at = (live, None) if live is not None else _recent_listed()

    def change(registry):
        listed_now = _listed_since(registry, listed, read_at)
        others = [e for e in registry["entries"] if e["agent"] == agent and e["id"] == sid
                  and not same_incarnation(e["session"], session)]
        if live is not None and any(e["state"] == "active" and _among(e, live) for e in others):
            held.append(True)
            return registry
        if fill_only and any(e["id"] is not None for e in registry["entries"] if same_incarnation(e["session"], session)):
            return registry
        aside = [] if live is None else [e for e in others if not _among(e, live)]
        kept = {**registry, "entries": [e for e in registry["entries"] if all(e is not a for a in aside)]}
        merged = merge_identity(kept, claim, time.time(), listed_now)
        return registry if merged is kept else {**merged, "entries": _bounded([*aside, *merged["entries"]], listed_now)}

    after = update_identities(change, required=required)
    if held:
        return "held"
    mine = next((e for e in after["entries"] if same_incarnation(e["session"], session)), None)
    return mine["state"] if mine is not None and mine["id"] in (sid, None) else None


def _among(entry, incarnations):
    return any(same_incarnation(entry["session"], k) for k in incarnations)


def forget_identity(session):
    """Drop the entry of an incarnation that will never run (its launch was refused for good)."""
    update_identities(lambda registry: {**registry, "entries": [
        e for e in registry["entries"] if not same_incarnation(e["session"], session)]})


def restore_identity(entry):
    """resolved_identity against the registry on disk."""
    return resolved_identity(entry, identities())


def resolved_identity(entry, registry):
    """(the lost ``entry`` with the conversation to resume, why there is none or None). The registry's
    entry wins: a contested incarnation resumes nothing (I4, I6). Without one, the snapshot's id, as before
    the registry existed (a newer or unreadable registry reads as having none)."""
    agent = entry["agent"]
    if not agent:
        return entry, None
    state, sid = resolve_identity(registry, entry["name"], entry["created"], agent["type"])
    if state == "none":
        sid = agent["session_id"]
    reason = "contested" if state == "contested" else None if sid else "unknown"
    return {**entry, "agent": {**agent, "session_id": sid}}, reason
