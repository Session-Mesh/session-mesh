# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The mesh-history database adapter of history.py.

The index is also kept in a SQLite database by the OCaml helper mesh-history (full-text search
and listing). The parsers in history.py stay the source of the records: this adapter feeds the
helper, and reads listings, details and searches from it once it mirrors the index. Without the
binary, or whenever the helper fails (timeout, locked or corrupt file), nothing changes: the
in-memory index, the JSON cache and ripgrep answer as before.

Protocol: tests/history-db-protocol.test.ts and ocaml/lib/mesh_history_protocol.mli."""

import json
import os
import re
import select
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

import history as _h

# ready: the database mirrors the index, so listings and details may be read from it; live: it has been
# fully synced once since the helper was started.
# gens / cursors / known / aux, per transcript path: the entry generation synced, (offset, next seq),
# (agent, id), and what the cursor stands for (the entry's epoch; for vibe the digests of the chunks stored).
# When the helper starts it reports gens, cursors, known and (line transcripts) the epoch back, not the aux of
# Vibe and OpenCode: such a conversation is then stored again in full once (replace), by design -- what aux
# stood for is unknown until it is.
# owner: (agent, id) -> the path the database row currently follows.
# refused: the (path, generation) pairs the helper refused, so that each is logged once.
# late: answers of reads abandoned at DB_READ_TIMEOUT that the helper has still to write; they are
# read and dropped before the next request is sent, so that they are not taken for its answer.
_db = {"proc": None, "buf": b"", "retry_at": 0.0, "ready": False, "live": False, "late": 0,
       "gens": {}, "cursors": {}, "known": {}, "aux": {}, "refused": set(), "owner": {}, "resync": False}
_db_lock = threading.RLock()   # one exchange with the helper at a time

DB_TIMEOUT = 30        # seconds to wait for one write (ingest, forget, cursors) to be taken and answered
DB_READ_TIMEOUT = 5    # seconds to wait for one read (list, detail, search) once it has the helper
DB_DELETE_WAIT = 2     # seconds a delete waits for the helper to reconcile (a busy scan does it at its end)
DB_READ_WAIT = 0.25    # seconds a read waits for a busy helper before the in-memory index answers instead
DB_RETRY = 30          # seconds before a failed helper is started again
DB_REFUSED_RETRY = 300   # ... and when it refused to open the database (a newer schema): that does not heal
_STATE_KEYS = ("gens", "cursors", "known", "aux")
DB_BATCH = 400         # chunks per ingest request
DB_PIECE = 4000        # characters per chunk
DB_STATE_SEQ = 1_000_000_000   # chunk numbers from here hold text taken from the parse state
_DB_CORE = ("agent", "id", "cwd", "title", "started", "updated")


def _db_command():
    """The mesh-history executable: MESH_HISTORY_CMD, else the bundle's or the opam switch's bin."""
    if os.environ.get("MESH_HISTORY_DB_DISABLE"):
        return None
    explicit = os.environ.get("MESH_HISTORY_CMD")
    if explicit:
        return explicit if os.access(explicit, os.X_OK) else None
    try:
        import agentmcp
        for directory in (agentmcp.runtime_bin(), agentmcp.switch_bin()):
            candidate = directory / "mesh-history"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    except (ImportError, ValueError, OSError):
        pass
    return None


def _db_fail(reason, quarantine=False, retry=DB_RETRY):
    """Stop using the helper for a while (under _db_lock); the index answers meanwhile."""
    proc = _db["proc"]
    if proc is not None:
        try:
            proc.kill()
            proc.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
    _db.update(proc=None, buf=b"", late=0, ready=False, live=False, retry_at=time.monotonic() + retry)
    for key in _STATE_KEYS + ("owner",):
        _db[key].clear()
    _db["refused"].clear()
    print(f"history: database helper stopped: {reason}", flush=True)
    if quarantine:   # a corrupt file is only a cache: set it aside, the next helper starts afresh
        base = _h.CACHE_FILE.with_name("history.sqlite")
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())   # UTC: local time repeats an hour when the clock goes back
        for suffix in ("", "-wal", "-shm"):
            try:
                os.replace(f"{base}{suffix}", f"{base}.corrupt-{stamp}{suffix}")
            except OSError:
                pass
        _purge_quarantined(base)


def _purge_quarantined(base):
    """Keep the newest quarantined database (its files: the stamp names the set) and remove the older ones:
    they hold private prompts and are of no use but for a look at the latest fault."""
    prefix = base.name + ".corrupt-"
    found = {}
    for file in base.parent.glob(prefix + "*"):
        found.setdefault(file.name[len(prefix):len(prefix) + 15], []).append(file)
    for stamp in sorted(found)[:-1]:
        for file in found[stamp]:
            try:
                file.unlink()
            except OSError:
                pass


def _clean(value):
    """The value with every lone UTF-16 surrogate in its strings replaced by U+FFFD (a pair stays a character)."""
    if isinstance(value, str):
        return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(value, dict):
        return {_clean(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    return value


def _encode(request):
    """The request as one line of UTF-8. A transcript may hold a lone surrogate (an emoji cut in two): it has no
    UTF-8 form, and JSON's escaped one makes the helper's parser refuse the whole request."""
    try:
        return json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n"
    except UnicodeEncodeError:
        return json.dumps(_clean(request), ensure_ascii=False).encode("utf-8") + b"\n"


def _write(proc, data, deadline):
    """Write to the helper's stdin (non-blocking) until the deadline: a helper that does not read is a failure."""
    fd = proc.stdin.fileno()
    view = memoryview(data)
    while view:
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([], [fd], [], left)[1]:
            raise TimeoutError("helper does not read")
        try:
            view = view[os.write(fd, view[:1 << 16]):]
        except BlockingIOError:
            continue


class _ReadTimeout(TimeoutError):
    """A read the helper did not answer in time: it is abandoned and the helper keeps running (a slow
    full-text query is not a fault of the helper; a write or a protocol error is)."""


def _db_take_line(proc, deadline):
    """The next line the helper wrote, None when the deadline passes first."""
    while b"\n" not in _db["buf"]:
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([proc.stdout], [], [], left)[0]:
            return None
        data = os.read(proc.stdout.fileno(), 1 << 20)
        if not data:
            raise EOFError("helper exited")
        _db["buf"] += data
    line, _, _db["buf"] = _db["buf"].partition(b"\n")
    return line


def _db_exchange(proc, request, timeout, read=False):
    deadline = time.monotonic() + timeout
    while _db["late"]:   # the answers of reads abandoned earlier come first, and are dropped
        if _db_take_line(proc, deadline) is None:
            raise _ReadTimeout("helper still busy") if read else TimeoutError("no answer")
        _db["late"] -= 1
    _write(proc, _encode(request), deadline)
    line = _db_take_line(proc, deadline)
    if line is None:
        if read:
            _db["late"] += 1
            raise _ReadTimeout("no answer")
        raise TimeoutError("no answer")
    return json.loads(line.decode("utf-8", "replace"))


def _db_spawn(command, timeout):
    """Start the helper and learn what it already holds (under _db_lock). The first request opens the
    database: an ok:false answer to it (a newer schema, a bad request) is a helper that cannot serve."""
    env = dict(os.environ, MESH_HISTORY_DB=str(_h.CACHE_FILE.with_name("history.sqlite")))
    try:
        proc = subprocess.Popen([command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, bufsize=0)
        os.set_blocking(proc.stdin.fileno(), False)
    except OSError as e:
        _db_fail(f"cannot start {command}: {e}")
        return None
    _db["proc"] = proc
    reply = _db_exchange_safe(proc, {"op": "cursors"}, timeout)
    if reply is None:
        return None
    if not reply.get("ok"):
        _db_fail(f"the helper cannot open the database: {reply.get('error')}", retry=DB_REFUSED_RETRY)
        return None
    for row in reply.get("cursors", []):
        path = row["path"]
        key = (row["agent"], row["id"])
        _db["known"][path], _db["owner"][key] = key, path
        _db["cursors"][path] = (row["offset"], row["next_seq"])
        _db["gens"][path] = row["gen"]
        if row["agent"] not in _WHOLE_TEXTS:
            _db["aux"][path] = row.get("epoch", 0)   # a line transcript: what the cursor stands for is stored with it
    return proc


def _db_exchange_safe(proc, request, timeout, read=False):
    """One exchange; None (and the helper stopped) when it fails, locked or corrupt files included. A read
    that is not answered in time gives None too, but leaves the helper running."""
    try:
        reply = _db_exchange(proc, request, timeout, read)
    except _ReadTimeout:
        return None
    except (OSError, EOFError, TimeoutError, ValueError) as e:
        _db_fail(repr(e))
        return None
    code = (reply.get("error") or {}).get("code")
    if code in ("corrupt", "busy", "db"):
        _db_fail(f"{code}: {reply['error'].get('message')}", quarantine=code == "corrupt")
        return None
    return reply


def _db_call(request, read=False, wait=None):
    """The helper's answer to a request, or None when it is unavailable. A bad_request answer
    comes back as is ({"ok": false, ...}): the caller decides. A read (read=True) gives up on a
    helper that is busy with a write for more than DB_READ_WAIT, and waits for an answer at most
    DB_READ_TIMEOUT: the caller then answers from the in-memory index, and the helper is left running
    (its late answer is dropped before the next request). A write has DB_TIMEOUT for the
    whole exchange, the write to the helper's stdin included; the helper that overruns it is killed. A
    write that passes wait (seconds) gives up on a helper busy with another exchange for longer than that."""
    if not _db_lock.acquire(timeout=DB_READ_WAIT if read else (-1 if wait is None else wait)):
        return None
    try:
        if time.monotonic() < _db["retry_at"]:
            return None
        timeout = DB_READ_TIMEOUT if read else DB_TIMEOUT
        proc = _db["proc"]
        if proc is None or proc.poll() is not None:
            command = _db_command()
            if not command:
                _db["retry_at"] = time.monotonic() + 300   # no binary: do not look again at every call
                return None
            proc = _db_spawn(command, timeout)
            if proc is None:
                return None
        return _db_exchange_safe(proc, request, timeout, read)
    finally:
        _db_lock.release()


def close():
    with _db_lock:
        proc, _db["proc"] = _db["proc"], None
        _db.update(ready=False, live=False, buf=b"", late=0, retry_at=0.0)
        for key in _STATE_KEYS + ("owner",):
            _db[key].clear()   # a helper started later reports what the database holds
        _db["refused"].clear()
        if proc is not None:
            try:
                proc.stdin.close()
                proc.wait(timeout=10)
            except (OSError, subprocess.SubprocessError):
                proc.kill()


# -- what is sent: records from the parse state, chunks from the transcript lines

def _claude_chunks(d):
    if d.get("type") == "user":
        text = _h._text(d.get("message", {}).get("content"))
        skip = d.get("isSidechain") or d.get("isCompactSummary") or d.get("isMeta") or d.get("toolUseResult") is not None
        return [] if skip or not text or text.startswith(_h._AUTO) else [("user", text)]
    if d.get("type") == "assistant" and not d.get("isSidechain"):
        text = _h._text((d.get("message") or {}).get("content"))
        return [("assistant", text)] if text else []
    return []


def _codex_chunks(d):
    p = d.get("payload") or {}
    if d.get("type") != "event_msg" or not isinstance(p.get("message"), str):
        return []   # the response_item copies of the same messages are not indexed twice
    role = {"user_message": "user", "agent_message": "assistant"}.get(p.get("type"))
    return [(role, p["message"])] if role and p["message"].strip() else []


def _pi_chunks(d):
    m = d.get("message") or {}
    text = _h._text(m.get("content")) if d.get("type") == "message" else ""
    return [(m["role"], text)] if text and m.get("role") in ("user", "assistant") else []


def _gemini_chunks(d):
    # a message record is appended again when it changes: the repeats index the same text again, harmlessly
    if d.get("type") not in ("user", "gemini") or "$set" in d:
        return []
    text = _h._parts(d.get("content"))
    return [("user" if d["type"] == "user" else "assistant", text)] if text else []


def _copilot_chunks(d):
    text = (d.get("data") or {}).get("content")
    role = {"user.message": "user", "assistant.message": "assistant"}.get(d.get("type"))
    return [(role, text)] if role and isinstance(text, str) and text.strip() else []


def _agy_chunks(d):
    text = d.get("content")
    role = {"USER_INPUT": "user", "PLANNER_RESPONSE": "assistant"}.get(d.get("type"))
    return [(role, text)] if role and isinstance(text, str) and text.strip() else []


# An agent without an extractor is indexed from its parse state only (title, prompts, summary).
# Append-only transcripts: one extractor per line, read from the stored cursor on.
_EXTRACTORS = {"claude": _claude_chunks, "codex": _codex_chunks, "pi": _pi_chunks,
               "gemini": _gemini_chunks, "copilot": _copilot_chunks, "agy": _agy_chunks}
# Sources that are not a file of lines: Vibe's text lives in a hash-addressed chunk store beside meta.json,
# OpenCode's in SQLite rows (opened read-only). Each has a planner (path, entry, aux) -> None when the
# source cannot be read now (the chunks already stored are kept), else
# (replace, [(role, text)], cursor offset, aux): only the text that is new since `aux` (what the database
# holds, None when unknown), or all of it with replace when the source was rewritten or `aux` is unknown.
_WHOLE_TEXTS = {}   # agent -> planner; filled below, once the readers exist


def _oc_plan(path, entry, aux):
    """OpenCode: the messages between the stored rowid and the entry's settled cursor."""
    inc = entry["inc"]
    stored = bool(aux) and aux["epoch"] == inc["epoch"] and aux["cur"] <= inc["cur"]
    con = _h._oc_open()
    if con is None:
        return None
    try:
        rows = _h._oc_iter(con, inc["kind"], path.split(":", 1)[1], aux["cur"] if stored else 0, inc["cur"])
        texts = [(role, t) for _, _, role, found, _, _ in rows if role in ("user", "assistant") for t in found if isinstance(t, str)]
    except sqlite3.Error:
        return None
    finally:
        con.close()
    return not stored, texts, inc["cur"], {"epoch": inc["epoch"], "cur": inc["cur"]}


def _vibe_db_plan(path, entry, aux):
    """Vibe: the chunks the entry has read that the database does not hold yet (all of them when it
    holds one the entry has dropped, or when it is not known what it holds)."""
    session_dir, hashes = Path(path).parent, entry["inc"]["hashes"]
    replace = aux is None or not set(aux["hashes"]) <= set(hashes)
    stored = [] if replace else list(aux["hashes"])
    texts = []
    for digest in hashes:
        chunk = None if digest in stored else _h._vibe_chunk(session_dir, digest)
        if chunk is not None:
            stored.append(digest)
            texts += chunk
    if replace and hashes and not stored:
        return None   # nothing could be read: do not replace what is stored with nothing
    return replace, texts, len(stored), {"hashes": stored, "partial": len(stored) < len(hashes)}


_WHOLE_TEXTS.update(vibe=_vibe_db_plan, opencode=_oc_plan)


def _pieces(text):
    text = text.strip()
    while len(text) > DB_PIECE:
        cut = max(text.rfind(" ", DB_PIECE // 2, DB_PIECE), text.rfind("\n", DB_PIECE // 2, DB_PIECE))
        cut = cut if cut > 0 else DB_PIECE
        yield text[:cut]
        text = text[cut:].lstrip()
    if text:
        yield text


def _db_eligible(s):
    return bool(s["id"]) and not s["sub"] and bool(s["n_user"] or s["summary"] or (s["agent"] == "vibe" and s["title"]))


def _db_record(path, s, gen_):
    return {"op": "ingest", "agent": s["agent"], "id": s["id"], "path": path, "cwd": s["cwd"],
            "title": s["title"], "started": s["started"], "updated": s["updated"],
            "tokens": s["tin"] + s["tout"], "summary": s["summary"], "gen": gen_,
            "meta": {k: s.get(k) for k in _h._PUBLIC if k not in _DB_CORE}}


def _db_state_chunks(s):
    """Text kept in the parse state that the transcripts do not hold: the custom name and the recap, each at
    its own place; one that is empty is sent empty, which removes what was stored (a cleared name)."""
    return [{"seq": DB_STATE_SEQ + i, "role": "state", "text": t[:DB_PIECE]} for i, t in enumerate((s["name"], s["recap"]))]


def _db_batches(path, agent, start, end, seq):
    """(chunks, offset after them, next seq, last) for the transcript's complete lines in [start, end),
    DB_BATCH chunks at a time; the last one may be empty and still carries the cursor."""
    extract = _EXTRACTORS[agent]
    batch, pos = [], start
    try:
        with open(path, "rb") as fh:
            fh.seek(start)
            for raw in fh:
                if pos + len(raw) > end or not raw.endswith(b"\n"):
                    break
                pos += len(raw)
                try:
                    found = extract(json.loads(raw))
                except _h._BAD_LINE:
                    continue
                for role, text in found:
                    for piece in _pieces(text):
                        batch.append({"seq": seq, "role": role, "text": piece})
                        seq += 1
                if len(batch) >= DB_BATCH:
                    yield batch, pos, seq, False
                    batch = []
    except OSError:
        pass
    yield batch, pos, seq, True


def _db_text_batches(texts, seq):
    """(chunks, next seq, last) for (role, text) pairs, DB_BATCH chunks at a time; the last batch may be empty."""
    batch = []
    for role, text in texts:
        for piece in _pieces(text):
            batch.append({"seq": seq, "role": role, "text": piece})
            seq += 1
            if len(batch) >= DB_BATCH:
                yield batch, seq, False
                batch = []
    yield batch, seq, True


def _db_drop_state(path):
    for table in _STATE_KEYS:
        _db[table].pop(path, None)


def _db_unsynced(path):
    """The helper refused (part of) the path's conversation: what it holds is not known to match the
    index, so the next attempt stores it again from the start (known stays: the row may exist)."""
    for table in ("gens", "cursors", "aux"):
        _db[table].pop(path, None)


def _db_forget_path(path, gen_, force=False, wait=None):
    """Forget the path's conversation in the database. The row is keyed (agent, id), not by path: unless
    force, it stays while another live path (a copy of the conversation) that is eligible still holds it."""
    key = _db["known"].get(path)
    if key is None:
        return True
    if force or not _eligible_holders(key):
        reply = _db_call({"op": "forget", "agent": key[0], "id": key[1], "gen": gen_}, wait=wait)
        if reply is None:
            return False
        _db["owner"].pop(key, None)
    _db_drop_state(path)
    return True


def _db_gen_of_batch(path, g, last):
    """The generation an ingest request stores. Only the last request of an entry carries g: an earlier
    one keeps the generation the path had, so that a helper that fails between two requests reports a
    generation other than g and the rest of the transcript is read again (g would make it look synced)."""
    if last:
        return g
    before = _db["gens"].get(path, 0)
    return before if before < g else g - 1


def _db_send(path, s, g, chunks, cursor, replace, last=True):
    """One ingest request: True when the database took it, False when the helper failed, None when it
    refused it (logged once per entry generation). An intermediate request (last False) does not
    store g."""
    request = _db_record(path, s, _db_gen_of_batch(path, g, last))
    request.update(chunks=chunks + _db_state_chunks(s), replace_chunks=replace,
                   cursor={"offset": cursor[0], "next_seq": cursor[1], "epoch": cursor[2]})
    reply = _db_call(request)
    if reply is None:
        return False
    if reply.get("ok"):
        return True
    if (path, g) not in _db["refused"]:
        _db["refused"].add((path, g))
        print(f"history: database refused {path}: {reply.get('error')}", flush=True)
    return None


def _db_progress(path, s, offset, seq, epoch):
    """What the database holds of the path after a request it took: the cursor, the row's owner, what the cursor stands for."""
    _db["known"][path] = (s["agent"], s["id"])
    _db["owner"][(s["agent"], s["id"])] = path
    _db["cursors"][path] = (offset, seq)
    _db["aux"][path] = epoch


def _db_sync_lines(path, entry, g):
    """A transcript of lines: the complete lines after the stored cursor. Stored again from the start
    when it shrank, was never indexed, or was read again from the start by the index since (its epoch
    moved: a rewrite that the database, unavailable meanwhile, did not see)."""
    s = entry["s"]
    offset, seq = _db["cursors"].get(path, (0, 0))
    replace = entry["offset"] < offset or path not in _db["cursors"] or _db["aux"].get(path) != entry["epoch"]
    if replace:
        offset, seq = 0, 0
    for chunks, offset, seq, last in _db_batches(path, s["agent"], offset, entry["offset"], seq):
        if _h._stop.is_set() and not last:
            return False   # shutting down: the stored cursor says where the next start goes on
        sent = _db_send(path, s, g, chunks, (offset, seq, entry["epoch"]), replace, last)
        if sent is not True:
            if sent is None:
                _db_unsynced(path)
            return sent
        replace = False
        _db_progress(path, s, offset, seq, entry["epoch"])
    _db["gens"][path] = g
    return True


def _db_sync_whole(path, entry, g):
    """Vibe and OpenCode: only the text the planner finds new. A source that cannot be read now leaves
    the stored chunks as they are and is not synced: it is tried again at the next scan, and the database
    is not read meanwhile (a conversation it does not know yet is still recorded, without text)."""
    s = entry["s"]
    known = path in _db["known"]
    cursor = _db["cursors"].get(path, (0, 0))
    plan = _WHOLE_TEXTS[s["agent"]](path, entry, _db["aux"].get(path) if known else None)
    if plan is None and known:
        return None   # the stored record may be stale: not synced, the next scan reads the source again
    replace, texts, offset, aux = plan or (False, [], cursor[0], None)
    before, seq = (0, 0) if replace else cursor
    for chunks, seq, last in _db_text_batches(texts, seq):
        if _h._stop.is_set() and not last:
            return False
        sent = _db_send(path, s, g, chunks, (offset if last else before, seq, 0), replace, last)
        if sent is not True:
            if sent is None:
                _db_unsynced(path)
            return sent
        replace = False
    _db["known"][path] = (s["agent"], s["id"])
    _db["owner"][(s["agent"], s["id"])] = path
    _db["cursors"][path] = (offset, seq)
    _db["aux"].pop(path, None)
    if plan is not None:
        _db["aux"][path] = aux
        if aux.get("partial"):
            _db["gens"].pop(path, None)   # chunks could not be read: the next scan tries them again
        else:
            _db["gens"][path] = g
    return True


def _eligible_holders(key):
    """The live paths of the conversation (agent, id) whose copy the database may hold, sorted."""
    with _h._lock:
        return [p for p in sorted(_h._keys.get(key, ())) if p in _h._files and _db_eligible(_h._files[p]["s"])]


def _db_canonical(path, s):
    """Whether this path is the copy of its conversation that the database row follows: the row is keyed
    (agent, id), and two live paths holding one conversation (agy's two roots, a copied claude project
    folder) must not replace each other's chunks. The first *eligible* holder in sort order is the one:
    an ineligible copy (no user prompt yet) never takes the row, nor forgets it while another holder is
    eligible. When no holder is eligible, any path may forget the row."""
    first = next(iter(_eligible_holders((s["agent"], s["id"]))), None)
    return first in (path, None)


def sync_one(path, entry):
    """Bring one transcript's record and chunks into the database. True: it is there; False: the helper
    failed; None: the helper refused it (then it is not synced, and not tried again until it changes)."""
    s, g = entry["s"], entry.get("g", 0)
    key = (s["agent"], s["id"])
    if _db["gens"].get(path) == g and _db["owner"].get(key) == path:
        return True
    if (path, g) in _db["refused"]:
        return None
    if time.monotonic() < _db["retry_at"]:
        return False   # no helper for now: do not read the transcript for nothing
    if not _db_started(None):   # what the database holds is learned when the helper starts: never decide before
        return False
    if not _db_canonical(path, s):
        _db_drop_state(path)
        return True
    if not _db_eligible(s):
        if key in _db["owner"]:
            _db["known"][path] = key   # the row is this conversation's, whichever copy fed it
        return _db_forget_path(path, g, force=True)
    if _db["owner"].get(key) not in (None, path):
        _db_drop_state(path)   # the row followed another copy: stored again from this one, from the start
    sync = _db_sync_whole if s["agent"] in _WHOLE_TEXTS else _db_sync_lines
    return sync(path, entry, g)


def sync_one_safe(path, entry):
    """sync_one that never raises: a failure is logged once per entry generation, and the path is stored
    again from the start at its next attempt (refused for this generation, so it does not fail at every scan)."""
    try:
        return sync_one(path, entry)
    except Exception as e:
        key = (path, entry.get("g", 0))
        if key not in _db["refused"]:
            _db["refused"].add(key)
            print(f"history: database sync of {path} failed ({type(e).__name__})", flush=True)
        _db_unsynced(path)
        return None


def reconcile(wait=None):
    """Remove from the database what the index no longer holds. Never raises. With wait (seconds), a
    helper busy for longer is left alone: the database then stops mirroring the index (readers use the
    index) until the scan that holds it ends and reconciles."""
    with _h._lock:
        live, g = set(_h._files), _h.gen
    if not _db_started(wait):   # what the database holds is learned when the helper starts
        return _db_unmirrored(wait)
    for path in [p for p in list(_db["known"]) if p not in live]:
        if _published(path):
            continue   # the scan published it after `live` was taken: the scan owns it
        if not _db_forget_path(path, g, wait=wait):
            return _db_unmirrored(wait)
        if _published(path):   # ... or while the helper was forgetting it: the scan syncs it again before it ends
            _db["resync"] = True
    return True


def _published(path):
    with _h._lock:
        return path in _h._files


def _db_started(wait):
    """The helper runs (it is started if need be: a scan that found nothing to store has not called it)."""
    proc = _db["proc"]
    return (proc is not None and proc.poll() is None) or _db_call({"op": "stats"}, wait=wait) is not None


def _db_unmirrored(wait):
    """A reconcile that could not finish: False; and with a wait bound, readers use the index meanwhile."""
    if wait is not None:
        _db["ready"] = False
    return False


def _sync_all():
    """(generation, complete) after syncing every entry of the index; None when stopped or the helper failed."""
    with _h._lock:
        mark, items = _h.gen, list(_h._files.items())
    complete = True
    for path, entry in items:
        synced = None if _h._stop.is_set() else sync_one_safe(path, entry)
        if synced is False or _h._stop.is_set():
            return None
        complete = complete and synced is not None
    return mark, complete


def finish():
    """At the end of a scan: sync what is left, and tell whether the database mirrors the index. A
    conversation the helper refused does not stop the others, but keeps the database from being read."""
    for _ in range(3):   # again when a reconcile forgot a path that a scan published meanwhile
        synced = _sync_all()
        if synced is None or not reconcile():
            return
        if not _db["resync"]:
            break
        _db["resync"] = False
    else:
        return   # a path kept racing the reconcile: the next scan decides
    mark, complete = synced
    if not complete and refused_count():   # a source that could not be read now is retried quietly at the next scan
        print(f"history: {refused_count()} conversation(s) refused by the database: it is not read until they are accepted",
              flush=True)
    with _h._lock:
        if _h.gen == mark and complete:
            _db["ready"] = _db["live"] = True


def refused_count():
    """How many (transcript, generation) pairs the helper refused and that are still current."""
    with _h._lock:
        return sum(1 for path, g in _db["refused"] if path in _h._files and _h._files[path].get("g", 0) == g)


def stats():
    """What the adapter knows of the database, for diagnostics; skipped: files the scan could not read."""
    return {"ready": _db["ready"], "live": _db["live"], "synced": len(_db["gens"]), "refused": refused_count(),
            "skipped": _h.skipped_count()}


# -- what is read (never waiting long for the helper: the in-memory index answers instead)

def listing(since):
    """(sessions, gone, full) from the database, or None when it does not mirror the index."""
    if not _db["ready"]:
        return None
    reply = _db_call({"op": "list", "since": since, "current": _h.gen}, read=True)   # the index owns the generations
    if not reply or not reply.get("ok") or not _db["ready"]:
        return None
    return reply["sessions"], reply["gone"], reply["full"]


def detail(agent, sid):
    if not _db["ready"]:
        return None
    reply = _db_call({"op": "detail", "agent": agent, "id": sid}, read=True)
    return reply["session"] if reply and reply.get("ok") and reply.get("found") else None


def search(q, limit=200):
    """The ids ("agent:id") of the conversations matching q, best first, from the database; None
    when it cannot answer (no helper, not synced yet, busy): the caller has ripgrep."""
    if not _db["live"] or not _searchable(q):
        return None
    reply = _db_call({"op": "search", "q": q, "mode": "text", "limit": limit}, read=True)
    if not reply or not reply.get("ok"):
        return None
    with _h._lock:   # a conversation deleted since the last sync (its forget not done yet) is not a hit
        return [f"{hit['agent']}:{hit['id']}" for hit in reply["results"] if (hit["agent"], hit["id"]) in _h._keys]


def _searchable(q):
    """Whether the database should be asked: a one-character term, or a prefix of fewer than three characters
    (the minimum of the History search box), matches most of a large index and may take longer than the read
    timeout; ripgrep answers those."""
    terms = re.findall(r"\w+", q)
    return bool(terms) and all(len(t) >= 2 for t in terms) and len(terms[-1]) >= 3
