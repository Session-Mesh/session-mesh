# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Durable, incarnation-scoped requests for owner-approved session actions.

The database contains intent, never authority. A session capability may create
and inspect its own requests, while an authenticated browser must first acquire
one short lease before it can decide. Persisting the execution boundary makes
an interrupted result explicit instead of silently replaying an action.
"""

import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import threading
import time


MAX_ACTIVE_REQUESTS = 128
MAX_ACTIVE_PER_SOURCE = 16
MAX_TERMINAL_REQUESTS = 256
TTL = 15 * 60
CLAIM_TTL = 45
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
TAB_NONCE_RE = re.compile(r"[0-9a-f]{32}")
# An account alias id (server.ACCOUNT_ID_RE) or "default", the default account.
ACCOUNT_RE = re.compile(r"[a-z0-9-]{1,32}")
# The agents whose conversation Mesh can carry to another account (mesh-platform accounts carry).
SWITCHABLE_AGENTS = frozenset(("claude", "codex"))
# Presets an agent may never request: a session without approvals or sandbox
# would let one agent obtain an unconfined sibling. The owner still can.
OWNER_ONLY_PRESETS = frozenset(("codex-yolo",))
ACTIVE_STATES = ("pending", "claimed", "approved", "executing")
TERMINAL_STATES = ("rejected", "completed", "failed", "execution_unknown")
_UMASK_LOCK = threading.Lock()


def _private_file(path):
    """Reject surprising custody instead of silently adopting shared state."""
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Request storage is not a regular file: {path}")
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"Request storage is not private: {path}")


def _prepare_private_database(path):
    parent = Path(path).parent
    try:
        parent.mkdir(mode=0o700, parents=True)
    except FileExistsError:
        pass
    info = os.lstat(parent)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ValueError(f"Invalid configuration directory: {parent}")
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"Configuration directory is not private: {parent}")
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        _private_file(path)
    else:
        os.close(fd)
    # SQLite may open these during connect/journal negotiation. Validate them
    # before giving SQLite the path, not only after the connection exists.
    for suffix in ("-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if candidate.exists() or candidate.is_symlink():
            _private_file(candidate)


def _set_aside(path, exc):
    """Rename a damaged database (and its WAL/SHM companions, which keep the names SQLite
    pairs with it) as the other state files do, so the service starts instead of looping."""
    aside = f"{path}.corrupt-{time.time_ns()}"   # nanoseconds: never overwrites an earlier copy
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if candidate.exists():
            candidate.replace(f"{aside}{suffix}")
    print(f"sessionrequests: {path} is not a usable database ({exc}); moved to {aside}, "
          "starting with no pending session requests", file=sys.stderr, flush=True)
    _prune_set_aside(path)


KEEP_SET_ASIDE = 3


def _prune_set_aside(path):
    """Keep the KEEP_SET_ASIDE most recent damaged copies: a database damaged at every start
    must not fill the configuration directory."""
    path = Path(path)
    pattern = re.compile(re.escape(path.name) + r"\.corrupt-(\d+)(?:-wal|-shm)?")
    copies = {}
    for entry in path.parent.iterdir():
        found = pattern.fullmatch(entry.name)
        if found:
            copies.setdefault(int(found.group(1)), []).append(entry)
    for stamp in sorted(copies)[:-KEEP_SET_ASIDE]:
        for entry in copies[stamp]:
            entry.unlink(missing_ok=True)


class Requests:
    def __init__(self, path, *, clock=time.time):
        self._clock = clock
        self._lock = threading.RLock()
        self._path = str(path)
        try:
            self._open(path)
        except sqlite3.DatabaseError as exc:
            # OperationalError (locked, I/O, permissions) is not damage: never discard for it.
            if self._path == ":memory:" or isinstance(exc, sqlite3.OperationalError):
                raise
            _set_aside(path, exc)
            self._open(path)

    def _open(self, path):
        try:
            self._connect(path)
        except BaseException:
            if getattr(self, "_db", None) is not None:
                self._db.close()
                self._db = None
            raise

    def _connect(self, path):
        self._db = None
        if self._path != ":memory:":
            _prepare_private_database(path)
        # umask is process-global. Serialize the short initialization window so
        # SQLite's WAL/SHM files cannot inherit the service's usual 022 mask.
        with _UMASK_LOCK:
            old_mask = os.umask(0o077)
            try:
                self._db = sqlite3.connect(self._path, timeout=5, isolation_level=None,
                                           check_same_thread=False)
                self._db.row_factory = sqlite3.Row
                self._db.execute("PRAGMA foreign_keys = ON")
                if self._path != ":memory:":
                    self._db.execute("PRAGMA journal_mode = WAL")
                    self._db.execute("PRAGMA synchronous = FULL")
                    check = self._db.execute("PRAGMA quick_check").fetchone()
                    if not check or check[0] != "ok":
                        raise sqlite3.DatabaseError(f"quick_check: {check[0] if check else 'no result'}")
                self._db.execute("""
                    CREATE TABLE IF NOT EXISTS session_requests (
                        id TEXT PRIMARY KEY,
                        action TEXT NOT NULL,
                        source_json TEXT NOT NULL,
                        preset TEXT,
                        requested_name TEXT,
                        model TEXT,
                        state TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        result_json TEXT,
                        claim_tab_nonce TEXT,
                        claim_nonce TEXT,
                        claim_expires_at REAL,
                        decision INTEGER,
                        decided_claim_nonce TEXT,
                        terminal_at REAL
                    )
                """)
                # A database written before account switching: the two columns are added, empty.
                columns = {row[1] for row in self._db.execute("PRAGMA table_info(session_requests)")}
                for column in ("account", "from_account"):
                    if column not in columns:
                        self._db.execute(f"ALTER TABLE session_requests ADD COLUMN {column} TEXT")
            finally:
                os.umask(old_mask)
        if self._path != ":memory:":
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(f"{path}{suffix}")
                if candidate.exists() or candidate.is_symlink():
                    _private_file(candidate)
        # Crossing a process lifetime makes an in-flight result unknowable.
        # It must never become an automatic second invocation.
        with self._transaction():
            self._db.execute(
                "UPDATE session_requests SET state = 'execution_unknown', "
                "result_json = ?, terminal_at = ? WHERE state = 'executing'",
                (self._encode({"error": "Execution result unknown after restart"}),
                 self._clock()))
            self._prune_locked(self._clock())

    class _Transaction:
        def __init__(self, owner):
            self.owner = owner

        def __enter__(self):
            self.owner._lock.acquire()
            self.owner._db.execute("BEGIN IMMEDIATE")

        def __exit__(self, kind, _value, _traceback):
            try:
                self.owner._db.execute("ROLLBACK" if kind else "COMMIT")
            finally:
                self.owner._lock.release()

    def _transaction(self):
        return self._Transaction(self)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"))

    @staticmethod
    def _decode(value):
        return None if value is None else json.loads(value)

    def close(self):
        with self._lock:
            self._db.close()

    def _prune_locked(self, now):
        # A stale browser lease is not a decision. Return the intent to the
        # queue without retaining either nonce.
        self._db.execute(
            "UPDATE session_requests SET state = 'pending', claim_tab_nonce = NULL, "
            "claim_nonce = NULL, claim_expires_at = NULL "
            "WHERE state = 'claimed' AND claim_expires_at <= ?", (now,))
        # Approved but never started is known not to have executed. Expire it
        # visibly rather than allowing an arbitrarily late launch.
        self._db.execute(
            "UPDATE session_requests SET state = 'failed', result_json = ?, terminal_at = ? "
            "WHERE state = 'approved' AND created_at + ? <= ?",
            (self._encode({"error": "Authorization expired before execution"}), now, TTL, now))
        self._db.execute(
            "DELETE FROM session_requests WHERE "
            "(state IN ('pending', 'claimed') AND created_at + ? <= ?) OR "
            "(state IN ('rejected', 'completed', 'failed', 'execution_unknown') "
            " AND terminal_at + ? <= ?)", (TTL, now, TTL, now))
        # Terminal history has its own bounded budget and can never crowd out
        # a fresh active request. Oldest results are the first to be evicted.
        terminal_slots = ",".join("?" for _ in TERMINAL_STATES)
        self._db.execute(
            f"DELETE FROM session_requests WHERE id IN ("
            f"SELECT id FROM session_requests WHERE state IN ({terminal_slots}) "
            "ORDER BY terminal_at DESC, id DESC LIMIT -1 OFFSET ?)",
            (*TERMINAL_STATES, MAX_TERMINAL_REQUESTS))

    @staticmethod
    def _optional_model(value):
        if value is None:
            return None
        if not isinstance(value, str) or not MODEL_RE.fullmatch(value):
            raise ValueError("Invalid model")
        return value

    @classmethod
    def _row(cls, row):
        if row is None:
            return None
        return {
            "id": row["id"], "action": row["action"],
            "source": cls._decode(row["source_json"]), "preset": row["preset"],
            "name": row["requested_name"], "model": row["model"],
            "account": row["account"], "from_account": row["from_account"],
            "state": row["state"], "created_at": row["created_at"],
            "result": cls._decode(row["result_json"]),
            # Scheduling hint only. It grants no authority and is safe for the
            # owner inventory/status projection.
            "lease_expires_at": row["claim_expires_at"],
        }

    @staticmethod
    def public(item):
        return {key: item[key] for key in
                ("id", "action", "source", "preset", "name", "model", "account", "from_account", "state",
                 "created_at", "result", "lease_expires_at")}

    @staticmethod
    def _switch(source, body, current_account, resumable):
        """(account, from_account) of a switch_account request: the target named by an id or "default", the
        current one given by the server (never the body), for a Claude or Codex agent that can resume."""
        if set(body) != {"action", "account"}:
            raise ValueError("Invalid request fields")
        account = body["account"]
        if not isinstance(account, str) or not ACCOUNT_RE.fullmatch(account):
            raise ValueError("Invalid account")
        if source["agent"] not in SWITCHABLE_AGENTS or source["agent"] not in resumable:
            raise ValueError("Account switching applies to Claude and Codex only")
        if not isinstance(current_account, str) or not ACCOUNT_RE.fullmatch(current_account):
            raise ValueError("Invalid account")
        if account == current_account:
            raise ValueError("This session already runs under this account")
        return account, current_account

    def create(self, source, body, *, enabled_agents, resumable, current_account=None):
        if not isinstance(body, dict) or set(body) - {"action", "preset", "name", "model", "account"}:
            raise ValueError("Invalid request fields")
        action = body.get("action")
        if action not in ("create", "restart", "switch_account"):
            raise ValueError("Invalid session action")
        account = from_account = None
        if action == "switch_account":
            account, from_account = self._switch(source, body, current_account, resumable)
        elif "account" in body:
            raise ValueError("Only an account switch names an account")
        model = self._optional_model(body.get("model"))
        if action == "switch_account":
            preset, name = source["agent"], None
        elif action == "create":
            preset = body.get("preset")
            if not isinstance(preset, str):   # a list or an object is not hashable either
                raise ValueError("Unknown or disabled agent preset")
            if preset in OWNER_ONLY_PRESETS:
                raise ValueError(
                    f"An agent cannot request a {preset} session: it runs without "
                    "approvals or sandbox, so only the owner can start one")
            if preset not in enabled_agents:
                raise ValueError("Unknown or disabled agent preset")
            name = body.get("name")
            if name is not None and (not isinstance(name, str) or not NAME_RE.fullmatch(name)):
                raise ValueError("Invalid session name")
        else:
            if body.get("preset") is not None or body.get("name") is not None:
                raise ValueError("A resume can only target the current session")
            preset, name = source["agent"], None
            if preset not in resumable:
                raise ValueError("This agent does not support resume")
        now, request_id = self._clock(), secrets.token_urlsafe(18)
        with self._transaction():
            self._prune_locked(now)
            active_slots = ",".join("?" for _ in ACTIVE_STATES)
            count = self._db.execute(
                f"SELECT count(*) FROM session_requests WHERE state IN ({active_slots})",
                ACTIVE_STATES).fetchone()[0]
            source_json = self._encode(dict(source))
            source_count = self._db.execute(
                f"SELECT count(*) FROM session_requests WHERE state IN ({active_slots}) "
                "AND source_json = ?", (*ACTIVE_STATES, source_json)).fetchone()[0]
            if count >= MAX_ACTIVE_REQUESTS:
                raise ValueError("Too many active session requests")
            if source_count >= MAX_ACTIVE_PER_SOURCE:
                raise ValueError("Too many active requests for this session")
            self._db.execute(
                "INSERT INTO session_requests "
                "(id, action, source_json, preset, requested_name, model, account, from_account, state, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
                (request_id, action, source_json, preset, name, model, account, from_account, now))
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        return self._row(row)

    def own(self, request_id, source):
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        item = self._row(row)
        return item if item is not None and item["source"] == source else None

    def pending(self):
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            rows = self._db.execute(
                "SELECT * FROM session_requests WHERE state IN ('pending', 'claimed') "
                "ORDER BY created_at, id").fetchall()
        return [self._row(row) for row in rows]

    def status(self, request_id):
        """Owner-only projection used to explain a lost claim or decision race."""
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        return self._row(row)

    def claim(self, request_id, tab_nonce, claim_nonce=None):
        if not isinstance(tab_nonce, str) or not TAB_NONCE_RE.fullmatch(tab_nonce):
            raise ValueError("Invalid tab identity")
        if claim_nonce is not None and not isinstance(claim_nonce, str):
            raise ValueError("Invalid lease")
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
            if row is None or row["state"] not in ("pending", "claimed"):
                return None
            if row["state"] == "claimed":
                # A tab nonce is routing metadata, not authority. Only the
                # unguessable secret returned to the winning page can renew.
                if (claim_nonce is None or row["claim_tab_nonce"] != tab_nonce
                        # bytes: a non-ASCII str would raise TypeError instead of mismatching
                        or not secrets.compare_digest(row["claim_nonce"].encode(),
                                                      claim_nonce.encode("utf-8", "surrogatepass"))):
                    return None
                expires_at = row["claim_expires_at"]
            else:
                if claim_nonce is not None:
                    return None
                claim_nonce = secrets.token_urlsafe(24)
                expires_at = min(now + CLAIM_TTL, row["created_at"] + TTL)
                changed = self._db.execute(
                    "UPDATE session_requests SET state = 'claimed', claim_tab_nonce = ?, "
                    "claim_nonce = ?, claim_expires_at = ? WHERE id = ? AND state = 'pending'",
                    (tab_nonce, claim_nonce, expires_at, request_id)).rowcount
                if changed != 1:
                    return None
                row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                       (request_id,)).fetchone()
        return {"request": self._row(row), "tab_nonce": tab_nonce,
                "claim_nonce": claim_nonce, "lease_expires_at": expires_at}

    def decide(self, request_id, approve, claim_nonce):
        if type(approve) is not bool or not isinstance(claim_nonce, str):
            return None
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
            if row is None:
                return None
            if (row["decided_claim_nonce"] == claim_nonce
                    and row["decision"] == int(approve)):
                return self._row(row)
            if (row["state"] != "claimed" or row["claim_nonce"] != claim_nonce
                    or row["claim_expires_at"] <= now):
                return None
            state = "approved" if approve else "rejected"
            terminal_at = None if approve else now
            self._db.execute(
                "UPDATE session_requests SET state = ?, decision = ?, "
                "decided_claim_nonce = ?, terminal_at = ? WHERE id = ?",
                (state, int(approve), claim_nonce, terminal_at, request_id))
            if not approve:
                self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        return self._row(row)

    def approved(self):
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            rows = self._db.execute(
                "SELECT * FROM session_requests WHERE state = 'approved' "
                "ORDER BY created_at, id").fetchall()
        return [self._row(row) for row in rows]

    def begin_execution(self, request_id):
        now = self._clock()
        with self._transaction():
            self._prune_locked(now)
            changed = self._db.execute(
                "UPDATE session_requests SET state = 'executing' "
                "WHERE id = ? AND state = 'approved'", (request_id,)).rowcount
            if changed != 1:
                return None
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        return self._row(row)

    def finish(self, request_id, *, result=None, error=None, detail=None):
        """``detail``: fields recorded beside a failure's error (an undone account switch: rolled_back, id)."""
        now = self._clock()
        state = "completed" if error is None else "failed"
        value = result if error is None else {**(detail or {}), "error": error}
        with self._transaction():
            changed = self._db.execute(
                "UPDATE session_requests SET state = ?, result_json = ?, terminal_at = ? "
                "WHERE id = ? AND state = 'executing'",
                (state, self._encode(value), now, request_id)).rowcount
            if changed != 1:
                return None
            self._prune_locked(now)
            row = self._db.execute("SELECT * FROM session_requests WHERE id = ?",
                                   (request_id,)).fetchone()
        return self._row(row)
