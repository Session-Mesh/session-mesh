# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Discover terminal sessions (mesh, Terminator tabs, SSH logins…) and describe
the Claude / Codex agent running in each one."""

import collections
import contextlib
import contextvars
import glob
import json
import os
import re
import sys
import threading
import time

import fsutil
import meshpaths
import resumeargs

HOME = os.path.expanduser("~")
# copilot: the native binary, argv[0] ends in /copilot (its kernel name is MainThread)
AGENTS = ("claude", "codex", "pi", "opencode", "gemini", "agy", "vibe", "copilot")
# The process name of an agent that is not the name of its type: `vibe` execs its bundled TUI, vibe-rs.
PROCESS_AGENTS = {"vibe-rs": "vibe"}


def _pi_sessions():
    base = os.environ.get("PI_CODING_AGENT_DIR") or f"{HOME}/.pi/agent"
    return glob.glob(f"{os.path.expanduser(base)}/sessions/*/*.jsonl")


# ---------------------------------------------------------------- /proc

# Outside Linux there is no /proc. The native PTY host, which reads processes
# through its platform layer, serves them on its socket ({"op": "processes"}).
# snapshot() asks it for the whole table; cmdline, cwd, tty_of, proc_start and
# the open rollouts read the rows the latest answers gave, and a process they
# do not describe is unknown, like an unreadable /proc entry. Those rows are
# shared by every thread: a complete table replaces them, a partial one adds
# its rows, and a request that got no answer leaves them as they were, so a
# failed snapshot taken during a listing does not blank the processes it lists.
# A table the host did not declare complete is marked so (HostProcesses): a
# check that no other agent runs somewhere fails closed on it, and reads argv and
# cwd from that same table (its rows), not from the shared ones, which another
# thread may have replaced by a partial answer in between.
# read_stat never reads those rows: its None means "the process is gone", which
# only the kernel or a fresh answer about that one process may say.
# The host answers in milliseconds; read_stat runs on the event loop of the
# resume path, so a host that does not answer must not hold it for long.
HOST_TIMEOUT = 1.0
FACTS_SECONDS = 5.0   # how long a host row describes a pid
_facts_lock = threading.Lock()   # serialises updates; a published dict is never mutated
_facts = {}           # pid -> (time.monotonic() when the host reported it, host row)
# read_stat of a process that exists but that the host did not describe: not
# "Z", so a wait for its exit goes on; -1 matches no pid, session or group.
UNKNOWN_NAME = "?"
PRESENT_UNKNOWN = (UNKNOWN_NAME, "?", -1, -1, -1, 0, -1)


class HostProcesses(dict):
    """snapshot() outside Linux. answered: the host replied with a table;
    complete: it said the table is complete and every row was readable;
    rows: pid -> the host row of this table."""
    answered = False
    complete = False
    rows = {}


def known_complete(procs):
    """Whether a snapshot lists every process. On Linux (a plain dict), always."""
    return getattr(procs, "complete", True)


def _host_processes(pids=None):
    """The host's reply to a processes request (a dict), or None."""
    import ptyhost   # imported here: ptyhost imports this module
    req = {"op": "processes"} if pids is None else {"op": "processes", "pids": list(pids)}
    reply = ptyhost.request_sync(req, HOST_TIMEOUT)
    return reply if isinstance(reply, dict) else None


def _listed(reply, key):
    value = reply.get(key) if reply else None
    return value if isinstance(value, list) else []


def _stat_of(row):
    """The read_stat tuple of one host row, or None. The name decodes as on Linux:
    a byte that is not UTF-8 becomes U+FFFD; a name that is not even bytes (a
    lone surrogate outside U+DC80..U+DCFF) is unknown, "?". tty_nr is not
    reported: 0, as for a process without a terminal; no caller reads it."""
    if not isinstance(row, dict):
        return None
    comm, state = row.get("comm"), row.get("state")
    numbers = [row.get(key) for key in ("pid", "ppid", "pgrp", "sid", "tpgid")]
    if not (isinstance(comm, str) and isinstance(state, str)
            and all(type(value) is int for value in numbers)):
        return None
    _, ppid, pgrp, sid, tpgid = numbers
    try:
        comm = comm.encode("utf-8", "surrogateescape").decode("utf-8", "replace")
    except UnicodeEncodeError:
        comm = UNKNOWN_NAME
    return comm, state, ppid, pgrp, sid, 0, tpgid


def _host_snapshot():
    reply = _host_processes()
    rows = reply.get("processes") if reply else None
    rows = rows if isinstance(rows, list) else None
    table = {row["pid"]: row for row in rows or () if _stat_of(row)}
    procs = HostProcesses((pid, _stat_of(row)) for pid, row in table.items())
    procs.rows = table
    procs.answered = rows is not None
    procs.complete = procs.answered and reply.get("complete") is True and len(table) == len(rows)
    if procs.answered:
        _remember(table, procs.complete)
    return procs


def _remember(table, complete):
    """Publish the rows of an answer: a complete table replaces the rows known,
    a partial one adds to those still fresh."""
    global _facts
    now = time.monotonic()
    with _facts_lock:
        kept = {} if complete else {pid: seen for pid, seen in _facts.items()
                                    if now - seen[0] < FACTS_SECONDS}
        kept.update((pid, (now, row)) for pid, row in table.items())
        _facts = kept


def _fact(pid, key):
    """One field of the latest host row for this pid, None when unknown."""
    with _facts_lock:
        seen = _facts.get(pid)
    row = seen[1] if seen and time.monotonic() - seen[0] < FACTS_SECONDS else None
    return row.get(key) if row else None


def _host_stat(pid):
    """read_stat outside Linux: None only when the process is known to be gone.
    When it exists but the host does not describe it (no host, no answer, no
    access), PRESENT_UNKNOWN: a caller waiting for an exit must not take "no
    answer" for "gone", nor its unknown parent or session for real ones."""
    if not isinstance(pid, int) or not 0 < pid <= 0x7FFFFFFF:
        return None   # no such process, as /proc/<pid> would say
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass   # it exists, under another account
    reply = _host_processes([pid])
    for row in _listed(reply, "processes"):
        if isinstance(row, dict) and row.get("pid") == pid and _stat_of(row):
            return _stat_of(row)
    if any(isinstance(error, dict) and error.get("pid") == pid and error.get("kind") == "not_found"
           for error in _listed(reply, "errors")):
        return None   # it exited after kill() saw it
    return PRESENT_UNKNOWN


def _argv_of(row):
    """The argv of a host row as bytes, or None when unknown (absent, malformed,
    or an argument that is not even bytes: a lone surrogate outside
    U+DC80..U+DCFF)."""
    argv = row.get("argv") if isinstance(row, dict) else None
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        return None
    try:
        return [arg.encode("utf-8", "surrogateescape") for arg in argv]
    except UnicodeEncodeError:
        return None


def _host_cmdline(pid):
    return _argv_of({"argv": _fact(pid, "argv")}) or []


def _host_cwd(pid):
    path = _fact(pid, "cwd")
    return path if isinstance(path, str) else None


def _host_tty(pid):
    path = _fact(pid, "stdin")
    return path if isinstance(path, str) and re.fullmatch(r"/dev/(pts/|ttys)[0-9]+", path) else None


def _host_start(pid):
    """macOS reports the start time in microseconds since the epoch; elsewhere unknown."""
    value = _fact(pid, "incarnation") if sys.platform == "darwin" else None
    return int(value) / 1e6 if isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}", value) else 0


def _host_open_files(pid):
    paths = _fact(pid, "open_files")
    if not isinstance(paths, list):
        return None
    return [path for path in paths if isinstance(path, str)]


def read_proc_text(path):
    """A /proc file as text. A process name is bytes chosen by whoever ran it, not
    necessarily UTF-8: an undecodable byte becomes U+FFFD instead of an error."""
    with open(path, "rb") as stream:
        return stream.read().decode("utf-8", errors="replace")


def read_stat(pid):
    """Return (comm, state, ppid, pgrp, sid, tty_nr, tpgid), or None when the
    process does not exist. Outside Linux, PRESENT_UNKNOWN when it exists but
    its details are unknown."""
    if sys.platform != "linux":
        return _host_stat(pid)
    try:
        raw = read_proc_text(f"/proc/{pid}/stat")
    except OSError:
        return None
    lp, rp = raw.index("("), raw.rindex(")")
    f = raw[rp + 2:].split()
    return raw[lp + 1:rp], f[0], int(f[1]), int(f[2]), int(f[3]), int(f[4]), int(f[5])


def cmdline(pid):
    if sys.platform != "linux":
        return _host_cmdline(pid)
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")[:-1]
    except OSError:
        return []


def cwd(pid):
    if sys.platform != "linux":
        return _host_cwd(pid)
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def tty_of(pid):
    if sys.platform != "linux":
        return _host_tty(pid)
    try:
        t = os.readlink(f"/proc/{pid}/fd/0")
        return t if t.startswith("/dev/pts/") else None
    except OSError:
        return None


def snapshot():
    """pid -> stat tuple for every visible process."""
    if sys.platform != "linux":
        return _host_snapshot()
    procs = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            st = read_stat(int(d))
            if st:
                procs[int(d)] = st
    return procs


def is_agent(pid, st):
    if st[0] in AGENTS:
        return st[0]
    if st[0] in PROCESS_AGENTS:
        return PROCESS_AGENTS[st[0]]
    return _agent_of_argv(cmdline(pid))


def _agent_of_argv(argv):
    if argv:
        base = os.path.basename(argv[0].decode(errors="ignore"))
        if base in AGENTS:
            return base
        if base in PROCESS_AGENTS:
            return PROCESS_AGENTS[base]
        if (base in ("node", "nodejs") and len(argv) > 1
                and argv[1].decode(errors="ignore").endswith(
                    ("/pi-coding-agent/dist/cli.js", "/pi-coding-agent/dist/bundle/cli.js"))):
            return "pi"
        if base in ("node", "nodejs") and _is_gemini_script(_node_script(argv)):
            return "gemini"
    return None


def _node_script(argv):
    """The script a node process runs: its first word after the options (a relaunch adds
    ``--max-old-space-size=N``), as text, or None."""
    for word in argv[1:]:
        text = word.decode(errors="ignore")
        if not text.startswith("-"):
            return text
    return None


def _is_gemini_script(script):
    """Gemini CLI: the installed ``gemini`` link (the path node was given, not its target) or its bundle."""
    return bool(script) and os.path.basename(script) in ("gemini", "gemini.js")


def session_agent(procs, sid):
    """The outermost claude/codex process of a terminal session, if any.
    Prefer the one in the foreground process group."""
    found = []
    for pid, st in procs.items():
        if st[4] != sid:
            continue
        kind = is_agent(pid, st)
        if not kind:
            continue
        parent = procs.get(st[2])
        if parent and parent[4] == sid and is_agent(st[2], parent):
            continue  # nested helper of another agent
        found.append((pid, kind, st))
    if not found:
        return None
    leader = procs.get(sid)
    tpgid = leader[6] if leader else -1
    found.sort(key=lambda x: (x[2][3] != tpgid, x[0]))
    return found[0][0], found[0][1]


def foreground(procs, sid):
    leader = procs.get(sid)
    if not leader:
        return sid
    tpgid = leader[6]
    return tpgid if tpgid in procs else sid


# ---------------------------------------------------------------- transcripts

_cache = {}


def _tail_lines(path, max_bytes=1_500_000):
    try:
        st = os.stat(path)
    except OSError:
        return [], 0
    key = (path, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
    if key in _cache:
        return _cache[key], st.st_mtime
    with open(path, "rb") as fh:
        if st.st_size > max_bytes:
            fh.seek(st.st_size - max_bytes)
            fh.readline()
        data = fh.read().decode(errors="ignore").splitlines()
    for k in [k for k in _cache if k[0] == path]:
        del _cache[k]
    _cache[key] = data
    return data, st.st_mtime


_parsed = collections.OrderedDict()     # (parser, path) -> (the line list it parsed, its result)
_parsed_lock = threading.Lock()
PARSED_MAX = 256


def _parsed_tail(parse, path, max_bytes):
    """parse(lines, mtime) of the end of ``path``, computed again only when _tail_lines read the file again: a
    file of another device, inode, size or mtime_ns (written, renamed over, a symlink moved) is a miss."""
    lines, mtime = _tail_lines(path, max_bytes)
    key = (parse, path)
    with _parsed_lock:
        hit = _parsed.get(key)
    if hit is None or hit[0] is not lines:
        hit = (lines, parse(lines, mtime))
    with _parsed_lock:
        _parsed[key] = hit
        _parsed.move_to_end(key)
        while len(_parsed) > PARSED_MAX:
            _parsed.popitem(last=False)
    return hit[1]


def _json_line(line):
    """One transcript line as JSON, or None. Transcripts are written by other programs: a
    line that is not JSON, or nested past the parser's depth, is skipped, never fatal."""
    try:
        return json.loads(line)
    except (ValueError, RecursionError):
        return None


def _clip(s, n=240):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def claude_info(pid):
    info = {"type": "claude"}
    try:
        with open(f"{HOME}/.claude/sessions/{pid}.json", "rb") as stream:
            meta = json.load(stream)
    except (OSError, ValueError, RecursionError):
        return info
    if not isinstance(meta, dict):
        return info
    sid = meta.get("sessionId")
    since = meta.get("statusUpdatedAt")
    info.update(session_id=sid, identity_source="pid_metadata", name=meta.get("name"), status=meta.get("status"),
                since=since / 1000 if isinstance(since, (int, float)) else None,
                waiting_for=meta.get("waitingFor") if meta.get("status") == "waiting" else None)
    paths = glob.glob(f"{HOME}/.claude/projects/*/{sid}.jsonl") if sid else []
    if not paths:
        return info
    found = _parsed_tail(_claude_transcript, paths[0], 1_500_000)
    info.update(found, choices=list(found["choices"]) if found["choices"] else None)
    return info


def _claude_transcript(lines, mtime):
    """What a Claude transcript says of the conversation: title, last prompt, reply, folder, pending question."""
    title = last = here = said = ask = ask_msg = None
    msg_tools = []
    for line in lines:
        d = _json_line(line)
        if not isinstance(d, dict):
            continue
        if d.get("type") == "assistant" and not d.get("isSidechain") and isinstance(d.get("message"), dict):
            m = d["message"]
            content = m.get("content")
            said = _claude_said(content) or said
            if not m.get("id") or m.get("id") != ask_msg:   # one message spans several lines, one per block
                ask_msg, msg_tools = m.get("id"), []
            if isinstance(content, list):
                msg_tools += [b.get("name") for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
            ask = _claude_ask(content)
        elif d.get("type") == "user" and not d.get("isSidechain"):
            ask = None   # answered (a tool_result) or a new prompt
        if not d.get("isSidechain") and d.get("cwd"):
            here = d["cwd"]   # claude's working directory now, after any cd
        t = d.get("type")
        if t in ("summary", "custom-title", "ai-title"):
            title = d.get("customTitle") or d.get("aiTitle") or d.get("summary") or title
        elif t == "user" and not d.get("isMeta") and not d.get("isSidechain") and isinstance(d.get("message"), dict):
            c = d["message"].get("content")
            if isinstance(c, list):
                c = " ".join(x.get("text", "") for x in c
                             if isinstance(x, dict) and x.get("type") == "text")
            if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<") \
                    and not c.startswith("This session is being continued"):
                last = c
    # the question must be the message's only tool: another one (a permission, a second
    # question) could be on screen first and take the answer keys
    if ask and msg_tools != ["AskUserQuestion"]:
        ask = None
    return dict(title=title, last=_clip(last) if last else None, updated=mtime, cwd=here,
                said=_clip(said) if said else None, choices=ask[1] if ask else None, ask_id=ask[0] if ask else None)


def _claude_ask(content):
    """(tool_use id, choice labels) of an answerable question the message ends with, or None."""
    choices = _claude_choices(content)
    if not choices:
        return None
    tool_id = content[-1].get("id")
    return (tool_id, choices) if isinstance(tool_id, str) and tool_id else None


def _claude_choices(content):
    """The labels of a single single-choice question the message ends with: what
    the keys 1, 2… answer at once in claude's question dialog. None otherwise
    (several questions or a multi-choice one need more than one key)."""
    if not isinstance(content, list) or not content or not isinstance(content[-1], dict):
        return None
    b = content[-1]
    args = b.get("input") if isinstance(b.get("input"), dict) else {}
    qs = args.get("questions")
    if b.get("type") != "tool_use" or b.get("name") != "AskUserQuestion" or not isinstance(qs, list) or len(qs) != 1:
        return None
    q = qs[0] if isinstance(qs[0], dict) else {}
    opts = q.get("options") if isinstance(q.get("options"), list) else []
    labels = [o.get("label") for o in opts if isinstance(o, dict)]
    if q.get("multiSelect") or len(labels) < 2 or not all(isinstance(x, str) and x.strip() for x in labels):
        return None
    return [_clip(x, 40) for x in labels]


_TOOL_ARG = ("command", "file_path", "path", "pattern", "url", "query", "description", "prompt")


def _claude_said(content):
    """What an assistant message ends with: its text, or the tool it asks to run
    ("⚙ Bash · git push"), which is what a waiting session waits on."""
    if isinstance(content, str):
        return content.strip() or None
    if not isinstance(content, list) or not content:
        return None
    b = content[-1]
    if not isinstance(b, dict):
        return None
    if b.get("type") == "text":
        return b["text"].strip() or None if isinstance(b.get("text"), str) else None
    if b.get("type") == "tool_use":
        args = b.get("input") if isinstance(b.get("input"), dict) else {}
        qs = args.get("questions")
        if isinstance(qs, list) and qs and isinstance(qs[0], dict) and qs[0].get("question"):
            return f"❓ {qs[0]['question']}"
        arg = next((str(args[k]) for k in _TOOL_ARG if args.get(k)), "")
        return f"⚙ {b.get('name') or 'tool'}" + (f" · {arg}" if arg else "")
    return None


_meta_cache = {}
# The first-line cache survives a restart in META_FILE: path -> [dev, ino, size, mtime_ns, cwd, is_subagent, id],
# used only for a file with the same four numbers. Ids and folders only, never transcript text.
META_FILE = meshpaths.CACHE_DIR / "codex-rollout-meta.json"
META_FILE_VERSION = 1
META_FILE_MAX = 4096
_meta_stamp = {}        # path -> [dev, ino, size, mtime_ns] when its _meta_cache entry was made
_meta_stored = None     # META_FILE as read once, {} when missing, unreadable or of another version
_meta_dirty = False
_meta_lock = threading.Lock()


def _rollout_meta(path):
    """(cwd, is_subagent, id) from a rollout's first line; immutable, so cached (on disk too, see META_FILE)."""
    global _meta_dirty
    if path not in _meta_cache:
        try:
            st = os.stat(path)
            stamp = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
            stored = _stored_meta().get(path)
            meta = tuple(stored[4:]) if stored and stored[:4] == stamp else _read_rollout_meta(path)
        except OSError:
            return (None, True, None)
        if meta is None:
            return (None, True, None)
        with _meta_lock:
            _meta_cache[path], _meta_stamp[path] = meta, stamp
            _meta_dirty = _meta_dirty or stored is None or stored[:4] != stamp
    return _meta_cache[path]


def _read_rollout_meta(path):
    """(cwd, is_subagent, id) of the first line of a rollout, or None when it is not a JSON object."""
    with open(path, "rb") as stream:
        first = _json_line(stream.readline())
    if not isinstance(first, dict):
        return None
    p = first.get("payload")
    p = p if isinstance(p, dict) else {}
    return (p.get("cwd"), isinstance(p.get("source"), dict), p.get("id"))


def _stored_meta():
    """The rows of META_FILE, read once per process."""
    global _meta_stored
    with _meta_lock:
        if _meta_stored is None:
            try:
                raw = json.loads(fsutil.read_bounded(META_FILE, 8_000_000) or "null")
                rows = raw["files"].items() if raw.get("v") == META_FILE_VERSION else ()
                _meta_stored = {path: row for path, row in rows if _valid_meta_row(row)}
            except (OSError, UnicodeError, ValueError, RecursionError, AttributeError, KeyError, TypeError):
                _meta_stored = {}
        return _meta_stored


def _valid_meta_row(row):
    """A row of META_FILE: four integers, a folder and an id that are text or null, a flag."""
    return (isinstance(row, list) and len(row) == 7 and all(type(n) is int for n in row[:4])
            and isinstance(row[5], bool) and all(v is None or isinstance(v, str) for v in (row[4], row[6])))


def save_rollout_meta():
    """Write the first-line cache when it learned something since the last write; the newest META_FILE_MAX."""
    global _meta_dirty
    with _meta_lock:
        if not _meta_dirty:
            return
        _meta_dirty = False
        rows = [(path, [*stamp, *_meta_cache[path]]) for path, stamp in _meta_stamp.items()]
    rows = sorted((item for item in rows if _valid_meta_row(item[1])), key=lambda item: -item[1][3])
    try:
        META_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fsutil.atomic_write(META_FILE, json.dumps({"v": META_FILE_VERSION, "files": dict(rows[:META_FILE_MAX])}))
    except OSError as error:
        print(f"discover: rollout cache not saved: {error}", flush=True)


def recent_rollouts(days=30):
    cutoff = time.time() - days * 86400
    out = []
    for d in glob.glob(f"{HOME}/.codex/sessions/*/*/*"):
        try:
            if os.path.getmtime(d) < cutoff:
                continue
        except OSError:
            continue
        out.extend(glob.glob(f"{d}/rollout-*.jsonl"))
    return out


def proc_start(pid):
    if sys.platform != "linux":
        return _host_start(pid)
    try:
        ticks = int(read_proc_text(f"/proc/{pid}/stat").rsplit(")", 1)[1].split()[19])
        btime = next(int(line.split()[1]) for line in open("/proc/stat") if line.startswith("btime"))
        return btime + ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        return 0


def _codex_count(directory):
    """How many codex agents run with this working directory; at least two when
    the process table is not known complete, so that the caller stays ambiguous."""
    return _codex_view().count(directory)


def _run_dir(pid, procs):
    """The working directory of this process, or None when unknown. Outside Linux the cwd is
    the one of the snapshot procs, not of a later answer."""
    if isinstance(procs, HostProcesses):
        here = procs.rows.get(pid, {}).get("cwd")
        return here if isinstance(here, str) else None
    return cwd(pid)


def _runs_in(here, directory):
    """Whether a process whose cwd is ``here`` may run in ``directory``: the same folder, or,
    outside Linux, a cwd the host did not report."""
    return here == directory or (here is None and sys.platform != "linux")


def _may_run_in(pid, directory, procs):
    """Whether this process may run in this directory."""
    return _runs_in(_run_dir(pid, procs), directory)


def _may_be_pi(pid, st, procs):
    """Whether this process may be a pi agent. Outside Linux argv comes from the
    snapshot procs; a node whose argv is unknown, or a process whose name is
    unknown too, may be one (on macOS a pi is a node named by argv[0] only)."""
    if not isinstance(procs, HostProcesses):
        return is_agent(pid, st) == "pi"
    argv = _argv_of(procs.rows.get(pid))
    if st[0] in AGENTS or argv:
        return (st[0] if st[0] in AGENTS else _agent_of_argv(argv)) == "pi"
    return st[0] in ("node", "nodejs", UNKNOWN_NAME)


def _open_rollouts(pid):
    """The codex rollouts the process holds open, or None if its files are unknown."""
    if sys.platform != "linux":
        files = _host_open_files(pid)
        return None if files is None else [t for t in files
                                           if "/.codex/sessions/" in t and "rollout-" in t]
    rollouts = []
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                t = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if "/.codex/sessions/" in t and "rollout-" in t:
                rollouts.append(t)
    except OSError:
        return None
    return rollouts


def _fds_gone(pid):
    """Whether the process exited: its fd directory no longer exists (as opposed to being unreadable)."""
    try:
        os.listdir(f"/proc/{pid}/fd")
    except (FileNotFoundError, ProcessLookupError):
        return True
    except OSError:
        return False
    return False


def _same_user(pid):
    """Whether the process belongs to this user; True when that cannot be told (fail closed)."""
    try:
        return os.stat(f"/proc/{pid}").st_uid == os.getuid()
    except OSError:
        return True


def _neighbour_rollouts(pid):
    """The rollouts a neighbouring codex holds open, or None when they cannot be known. A neighbour
    that exited meanwhile holds nothing, and neither does one of another user whose files cannot be
    read: the candidates come from this user's ~/.codex, where only this user's codex writes."""
    rollouts = _open_rollouts(pid)
    if rollouts is not None:
        return set(rollouts)
    if sys.platform == "linux" and (_fds_gone(pid) or not _same_user(pid)):
        return set()
    return None


def _is_top_level_codex(pid, st):
    """A codex agent that is not a helper process of another codex."""
    if st[0] != "codex" or is_agent(pid, st) != "codex":
        return False
    parent = read_stat(st[2])   # an unknown parent is not "codex": counted
    return not (parent and parent[0] == "codex")


class _CodexView:
    """What the codex identity rules need to know about the host's codex processes, read once from one
    process table: the folder of each top-level codex, the conversation each was launched on and the rollouts
    each codex holds open."""

    def __init__(self):
        self._procs, self._read, self._dirs, self._held, self._launched = None, False, None, None, None
        self._rollouts = None

    def _table(self):
        if not self._read:
            self._read = True
            try:
                self._procs = snapshot()
            except OSError:
                self._procs = None      # unreadable: callers stay ambiguous
        return self._procs

    def rollouts(self):
        """The recent rollouts, listed once per view: once per listing inside listing_scope."""
        if self._rollouts is None:
            self._rollouts = recent_rollouts()
        return self._rollouts

    def count(self, directory):
        procs = self._table()
        if procs is None:
            return 2
        if self._dirs is None:
            self._dirs = [_run_dir(pid, procs) for pid, st in procs.items() if _is_top_level_codex(pid, st)]
        count = sum(1 for here in self._dirs if _runs_in(here, directory))
        return count if known_complete(procs) else max(count, 2)

    def held_by_others(self, pid):
        """The rollouts the codex processes other than ``pid`` and its own helpers hold open, or None when one
        cannot be known."""
        procs = self._table()
        if procs is None:
            return None
        if self._held is None:
            self._held = {other: _neighbour_rollouts(other) for other, st in procs.items()
                          if st[0] == "codex" and is_agent(other, st) == "codex"}
        others = [r for other, r in self._held.items() if other != pid and not _descends_from(other, pid, procs)]
        return None if any(r is None for r in others) else set().union(*others)

    def named_by_others(self, pid, sid):
        """Whether another top-level codex may have been launched on conversation ``sid``: one of its arguments
        is ``sid`` (case ignored), it has a ``resume`` whose id cannot be read, or its arguments are unknown.
        Lenient on purpose, since it only withdraws an id. True when the process table is unknown or incomplete."""
        procs = self._table()
        if procs is None or not known_complete(procs):
            return True
        if self._launched is None:
            self._launched = {other: _launch_words(other, procs) for other, st in procs.items()
                              if _is_top_level_codex(other, st)}
        return any(other != pid and _may_name(words, sid) for other, words in self._launched.items())

    def claimed_by_others(self, pid, sid):
        """Whether conversation ``sid`` is another codex's too: another top-level codex may have been launched
        on it, or another codex holds its rollout open. True when that cannot be known."""
        if self.named_by_others(pid, sid):
            return True
        held = self.held_by_others(pid)
        return held is None or any(_rollout_meta(path)[2] == sid for path in held)


def _descends_from(pid, ancestor, procs):
    """Whether ``pid`` is a descendant of ``ancestor`` in the process table (a helper of that codex)."""
    seen = set()
    while pid in procs and pid not in seen:
        seen.add(pid)
        pid = procs[pid][2]
        if pid == ancestor:
            return True
    return False


def _words(argv):
    """Process arguments as text; a byte that is not UTF-8 stays an escape that matches nothing, never dropped."""
    return [a.decode("utf-8", "surrogateescape") for a in argv]


def _launch_words(pid, procs):
    """The arguments a codex was launched with, as text, or None when they are unknown (outside Linux, a row
    without argv)."""
    argv = _argv_of(procs.rows.get(pid)) if isinstance(procs, HostProcesses) else cmdline(pid)
    return None if argv is None else _words(argv)


def _may_name(words, sid):
    """Whether launch arguments may name conversation ``sid`` (see _CodexView.named_by_others)."""
    if words is None or sid.lower() in (w.lower() for w in words):
        return True
    return "resume" in words and resumeargs.resumed_codex_id(words) is None


_LISTING_VIEW = contextvars.ContextVar("codex_listing_view", default=None)


@contextlib.contextmanager
def listing_scope():
    """Share one codex process scan and one rollout listing between all the sessions of one listing (not kept
    afterwards)."""
    token = _LISTING_VIEW.set(_CodexView())
    try:
        yield
    finally:
        _LISTING_VIEW.reset(token)
        save_rollout_meta()


def _codex_view():
    return _LISTING_VIEW.get() or _CodexView()


def _held_by_other_codex(pid):
    """The rollouts another codex process of the host holds open, or None when one cannot be known."""
    return _codex_view().held_by_others(pid)


def _lone_codex_candidates(pid, here, started):
    """The rollouts this codex may own when it holds none open: the top-level rollouts of its folder written
    since it started, but only when it is the one codex running there and no other codex holds them open
    (a later codex's rollout would otherwise be taken for this one's). Empty when any of that is unknown."""
    candidates = [p for p in _codex_view().rollouts()
                  if _rollout_meta(p)[0] == here and not _rollout_meta(p)[1]
                  and os.path.getmtime(p) >= started]
    if not candidates or _codex_count(here) != 1:
        return []
    held = _held_by_other_codex(pid)
    return [] if held is None else [p for p in candidates if p not in held]


def _newest_top_level(paths):
    """(path, id) of the most recently written top-level rollout among paths (sub-agent ones skipped), or None."""
    best = None
    for path in set(paths):
        rcwd, sub, rid = _rollout_meta(path)
        if sub:
            continue  # sub-agent rollout
        m = os.path.getmtime(path)
        if not best or m > best[0]:
            best = (m, path, rid)
    return best[1:] if best else None


def _rollout_of(sid):
    """The recent top-level rollout of conversation sid, or None (an older one is not searched)."""
    found = _newest_top_level(p for p in _codex_view().rollouts() if _rollout_meta(p)[2] == sid)
    return found[0] if found else None


_argv_conflicts_noted = set()


def _note_argv_conflict(pid):
    """Say once per process that the rollout it holds open is not the conversation its ``resume`` argument
    names (a /new or a /resume inside Codex): the open rollout is the one used."""
    if pid in _argv_conflicts_noted:
        return
    if len(_argv_conflicts_noted) > 4096:
        _argv_conflicts_noted.clear()
    _argv_conflicts_noted.add(pid)
    print(f"discover: codex {pid} holds open another conversation than the one its resume argument names; "
          "the open rollout is used", flush=True)


def _later_conversation(pid, named, named_path):
    """Whether the folder of this codex shows a conversation newer than the one it was launched on (a /new or
    a /resume inside Codex): a top-level rollout of another id, written since the process started and after the
    named one's, that no other codex holds open or may have been launched on. True when that cannot be known."""
    started, here = proc_start(pid), cwd(pid)
    named_at = os.path.getmtime(named_path) if named_path else None
    later = [p for p in _codex_view().rollouts() if _rollout_meta(p)[0] == here and not _rollout_meta(p)[1]
             and _rollout_meta(p)[2] != named and os.path.getmtime(p) >= started
             and (named_at is None or os.path.getmtime(p) > named_at)]
    if not later:
        return False
    view = _codex_view()
    held = view.held_by_others(pid)
    return held is None or any(p not in held and not view.named_by_others(pid, _rollout_meta(p)[2]) for p in later)


def _codex_conversation(pid, rollouts):
    """(rollout or None, id, source) of the conversation of this codex, or None. In order: the rollout it
    holds open (open_rollout, exact); the id it was launched on, ``codex resume <id>`` (argv_resume: where it
    started, not always what it runs now), unless another codex may claim that id too (then none: contested)
    or its folder shows a later conversation (then the guess below); the lone-codex guess (cwd_unique)."""
    named = resumeargs.resumed_codex_id(_words(cmdline(pid)))
    held = _newest_top_level(rollouts)
    if held:
        if named and held[1] != named:
            _note_argv_conflict(pid)
        return (*held, "open_rollout")
    if named:
        if _codex_view().claimed_by_others(pid, named):
            return None
        named_path = _rollout_of(named)
        if not _later_conversation(pid, named, named_path):
            return (named_path, named, "argv_resume")
    # Codex does not always keep its rollout open: fall back to the most
    # recent top-level rollout for this cwd written since the process started.
    # A lone codex may have written several (/new): its newest is the right one. With another codex
    # in the folder the newest may be that one's, and resuming it would kill this codex to reopen a
    # conversation running elsewhere, so the answer is then none (fail-closed).
    guessed = _newest_top_level(_lone_codex_candidates(pid, cwd(pid), proc_start(pid)))
    return (*guessed, "cwd_unique") if guessed else None


def _codex_transcript(path):
    """What the rollout says of the conversation: the last user message, the reply, the folder, the state."""
    found = dict(_parsed_tail(_codex_rollout, path, 8_000_000))
    found["status"] = "busy" if time.time() - found["updated"] < 20 else "idle"   # the clock moves: not cached
    return found


def _codex_rollout(lines, mtime):
    """The parse of a rollout for _codex_transcript, without the state, which depends on the clock."""
    last = here = said = None
    for line in lines:
        d = _json_line(line)
        if not isinstance(d, dict) or not isinstance(d.get("payload"), dict):
            continue
        p = d["payload"]
        said = _codex_reply(d.get("type"), p) or said
        if d.get("type") == "turn_context" and isinstance(p.get("cwd"), str) and p["cwd"]:
            here = p["cwd"]   # codex's working directory for the latest turn
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            t = _text_blocks(p.get("content"))
            if t and not t.startswith("<") and not t.startswith("# AGENTS"):
                last = t
    return {"last": _clip(last) if last else None, "updated": mtime, "cwd": here,
            "status": None, "said": _clip(said) if said else None}


def codex_info(pid):
    info = {"type": "codex"}
    rollouts = _open_rollouts(pid)
    found = None if rollouts is None else _codex_conversation(pid, rollouts)
    if not found:
        return info
    path, sid, source = found
    info.update(session_id=sid, identity_source=source)
    if path:
        info.update(_codex_transcript(path))
    return info


GUESSED_ID_SOURCES = ("cwd_unique", "history_cwd")


def _guessed_source(source):
    return source in GUESSED_ID_SOURCES or (isinstance(source, str) and source.startswith("unique_"))


LAUNCH_ID_SOURCES = ("argv_resume",)


def drop_duplicate_guessed_ids(descriptions):
    """Remove a conversation id that another session also reports, when one of them is not observed: a guess
    (see GUESSED_ID_SOURCES) loses to an observed id, two guesses of one id are both dropped, and an id read
    from launch arguments (LAUNCH_ID_SOURCES, possibly stale) is dropped with every session sharing it.
    Observed ids that collide only with each other are not touched."""
    agents = [d["agent"] for d in descriptions if isinstance(d.get("agent"), dict) and d["agent"].get("session_id")]
    reported = collections.Counter(a["session_id"] for a in agents)
    launched = {a["session_id"] for a in agents if a.get("identity_source") in LAUNCH_ID_SOURCES}
    exact = {a["session_id"] for a in agents if not _guessed_source(a.get("identity_source"))}
    guessed = collections.Counter(a["session_id"] for a in agents if _guessed_source(a.get("identity_source")))
    for a in agents:
        sid, guess = a["session_id"], _guessed_source(a.get("identity_source"))
        if guess and (sid in exact or guessed[sid] > 1) or sid in launched and reported[sid] > 1:
            a["session_id"] = None
            a["identity_source"] = None


def _text_blocks(blocks):
    """The text of a list of content blocks (codex spells the key "text" in both forms)."""
    if not isinstance(blocks, list):
        return ""
    return " ".join(b["text"] for b in blocks if isinstance(b, dict) and isinstance(b.get("text"), str)).strip()


def _codex_reply(kind, p):
    """The agent's reply a rollout line carries, or None. Codex <= 0.159 wrote event_msg
    agent_message; 0.160 writes event_msg item_completed (AgentMessage), an assistant
    response_item and event_msg task_complete.last_agent_message instead."""
    sub = p.get("type")
    if kind == "event_msg" and sub == "agent_message":
        text = p.get("message")
    elif kind == "event_msg" and sub == "item_completed":
        item = p.get("item")
        text = (_text_blocks(item.get("content"))
                if isinstance(item, dict) and item.get("type") == "AgentMessage" else None)
    elif kind == "event_msg" and sub == "task_complete":
        text = p.get("last_agent_message")
    elif kind == "response_item" and sub == "message" and p.get("role") == "assistant":
        text = _text_blocks(p.get("content"))
    else:
        return None
    return text.strip() or None if isinstance(text, str) else None


def _pi_header(path):
    try:
        with open(path, encoding="utf-8") as stream:
            header = json.loads(stream.readline())
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None
    if (not isinstance(header, dict) or header.get("type") != "session"
            or header.get("version") != 3 or not isinstance(header.get("cwd"), str)
            or not isinstance(header.get("id"), str)):
        return None
    return header


def pi_session_path(sid):
    """Only resume a unique, existing v3 transcript; Pi creates missing paths."""
    if not isinstance(sid, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", sid):
        return None
    matches = [p for p in _pi_sessions()
               if (h := _pi_header(p)) and h["id"] == sid]
    return matches[0] if len(matches) == 1 else None


def _another_pi_may_run_in(pid, here):
    """A transcript's cwd and timestamp cannot identify its writer if another Pi
    process is also running there, even when only one transcript exists. A
    process table not known complete may hide one."""
    procs = snapshot()
    if not known_complete(procs):
        return True
    return any(other != pid and _may_be_pi(other, stat, procs) and _may_run_in(other, here, procs)
               for other, stat in procs.items())


def pi_info(pid):
    info = {"type": "pi"}
    here, started = cwd(pid), proc_start(pid)
    if not here:
        return info
    if _another_pi_may_run_in(pid, here):
        return info
    candidates = []
    for path in _pi_sessions():
        header = _pi_header(path)
        if not header or header["cwd"] != here:
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if mtime >= started - 2:
            candidates.append((mtime, path, header["id"]))
    # A second Pi in the same directory or a /new conversation is ambiguous.
    if len(candidates) != 1:
        return info
    mtime, path, sid = candidates[0]
    lines, _ = _tail_lines(path)
    last = said = None
    for line in lines:
        event = _json_line(line)
        message = event.get("message") if isinstance(event, dict) else None
        if not isinstance(message, dict):
            continue
        blocks = message.get("content")
        text = _text_blocks(blocks) if isinstance(blocks, list) else None
        if message.get("role") == "user" and text:
            last = text
        elif message.get("role") == "assistant" and text:
            said = text
    info.update(session_id=sid, identity_source="unique_pi_transcript", cwd=here,
                updated=mtime, status="busy" if time.time() - mtime < 20 else "idle",
                last=_clip(last) if last else None, said=_clip(said) if said else None)
    return info


# ---------------------------------------------------------------- OpenCode

OPENCODE_ID = re.compile(r"ses_[0-9A-Za-z]{8,60}")


def _opencode_db():
    base = os.environ.get("XDG_DATA_HOME") or f"{HOME}/.local/share"
    return f"{os.path.expanduser(base)}/opencode/opencode.db"


def _opencode_query(sql, args=()):
    """Rows of one read-only query on OpenCode's SQLite store, [] when it cannot be read.
    That file also holds the user's provider credentials: only the session, message and part tables (1.x),
    session_v2 and session_message (2.x) are queried."""
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{_opencode_db()}?mode=ro", uri=True, timeout=0.5)
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []


def _argv_session(argv):
    """The conversation an OpenCode started with ``-s``/``--session`` names, if any."""
    words = [a.decode(errors="ignore") for a in argv]
    for i, word in enumerate(words):
        if word in ("-s", "--session"):
            value = words[i + 1] if i + 1 < len(words) else ""
        else:
            value = word.split("=", 1)[1] if word.startswith("--session=") else ""
        if OPENCODE_ID.fullmatch(value):
            return value
    return None


def _another_agent_runs_in(pid, here, kind="opencode"):
    """Like _another_pi_may_run_in: a directory shared by two OpenCode processes cannot name a writer."""
    procs = snapshot()
    if not known_complete(procs):
        return True
    return any(other != pid and is_agent(other, stat) == kind and _may_run_in(other, here, procs)
               for other, stat in procs.items())


# OpenCode 2 keeps its conversations in ``session_v2`` / ``session_message`` (a database migrated from 1.x
# still holds the old ``session`` / ``message`` / ``part`` tables, 1.x conversations are copied to the new
# ones at the first 2.x start).  Both layouts are read, the 2.x one first.
_OPENCODE_SESSION_TABLES = ("session_v2", "session")


def _opencode_sessions(where, args=()):
    """(id, time_updated) rows of the root conversations matching ``where``, from the first layout that has some."""
    for table in _OPENCODE_SESSION_TABLES:
        rows = _opencode_query(f"SELECT id, time_updated FROM {table} WHERE {where}", args)
        if rows:
            return rows
    return []


def opencode_session_exists(sid):
    """True when OpenCode's store holds the conversation ``sid``.  OpenCode 2 creates an empty conversation
    for an unknown ``--session`` instead of failing, so a resume checks first."""
    return bool(OPENCODE_ID.fullmatch(sid or "")) and any(
        _opencode_query(f"SELECT 1 FROM {table} WHERE id = ?", (sid,)) for table in _OPENCODE_SESSION_TABLES)


def _opencode_texts(sid):
    """(last user text, last assistant text) of a conversation."""
    found = {}
    for role in ("user", "assistant"):
        rows = _opencode_query(
            "SELECT json_extract(data,'$.text') FROM session_message WHERE session_id = ? AND type = 'user' "
            "ORDER BY seq DESC LIMIT 1", (sid,)) if role == "user" else _opencode_query(
            "SELECT json_extract(c.value,'$.text') FROM session_message m, json_each(m.data,'$.content') c "
            "WHERE m.session_id = ? AND m.type = 'assistant' AND json_extract(c.value,'$.type') = 'text' "
            "ORDER BY m.seq DESC, c.key DESC LIMIT 1", (sid,))
        if not rows:
            rows = _opencode_query(
                "SELECT json_extract(p.data,'$.text') FROM part p JOIN message m ON m.id = p.message_id "
                "WHERE p.session_id = ? AND json_extract(m.data,'$.role') = ? "
                "AND json_extract(p.data,'$.type') = 'text' ORDER BY p.time_created DESC LIMIT 1", (sid, role))
        found[role] = _clip(rows[0][0]) if rows and isinstance(rows[0][0], str) and rows[0][0] else None
    return found["user"], found["assistant"]


def _opencode_busy(sid, started):
    """A turn is running while the newest message is the user's or an assistant message not completed
    (2.x: while the conversation was set busy after it was last set idle).  A live process has no
    time limit: a long tool call writes nothing for many minutes and is still a turn, and the restart
    "when idle" would SIGTERM it.  Only a mark written before this process started is dropped: another
    process left it, this one did not begin that turn (``started``: 0 when unknown keeps the mark)."""
    since_ms = max(started - 2, 0) * 1000
    rows = _opencode_query("SELECT time_busy, time_idle FROM session_v2 WHERE id = ?", (sid,))
    if rows:
        busy, idle = rows[0]
        return busy is not None and busy >= since_ms and (idle is None or idle < busy)
    rows = _opencode_query("SELECT json_extract(data,'$.role'), json_extract(data,'$.time.completed'), time_created "
                           "FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1", (sid,))
    open_turn = bool(rows) and (rows[0][0] == "user" or (rows[0][0] == "assistant" and rows[0][1] is None))
    return open_turn and rows[0][2] >= since_ms


def opencode_info(pid):
    info = {"type": "opencode"}
    here, started = cwd(pid), proc_start(pid)
    info["started"] = started       # lets the server drop a hook report that predates this process
    if not here:
        return info
    named = _argv_session(cmdline(pid))
    if named:
        rows = _opencode_sessions("id = ? AND directory = ? AND parent_id IS NULL", (named, here))
        source = "argv_session"
    else:
        # A lone OpenCode in a directory: the root conversation written since it started. A second one
        # there, or a /new conversation, is ambiguous and names none.
        rows = [] if _another_agent_runs_in(pid, here) else _opencode_sessions(
            "directory = ? AND parent_id IS NULL AND time_archived IS NULL AND time_updated >= ? "
            "ORDER BY time_updated DESC", (here, int((started - 2) * 1000)))
        rows = rows if len(rows) == 1 else []
        source = "unique_opencode_session"
    if not rows:
        return info
    sid, updated = rows[0][0], rows[0][1] / 1000
    last, said = _opencode_texts(sid)
    info.update(session_id=sid, identity_source=source, cwd=here, updated=updated,
                status="busy" if _opencode_busy(sid, started) else "idle", last=last, said=said)
    return info


def gemini_info(pid):
    """Gemini keeps its chats as JSON per project hash; the conversation comes from its hooks
    (server._apply_reported_state), so discovery alone names none."""
    return {"type": "gemini", "started": proc_start(pid)}   # lets the server drop a hook report older than this process


# ---------------------------------------------------------------- Antigravity (agy)

AGY_ID = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{7,63}")


def agy_info(pid):
    """What the process says of itself: the conversation named by ``--conversation`` and the folder.
    agy keeps its conversations under ~/.gemini, next to the user's login: nothing there is read. The
    state and the conversation of an agy started by the mesh come from its hooks (bin/mesh-event agy)."""
    info = {"type": "agy", "started": proc_start(pid)}   # lets the server drop a hook report older than this process
    here = cwd(pid)
    if here:
        info["cwd"] = here
    words = [a.decode(errors="ignore") for a in cmdline(pid)]
    for i, word in enumerate(words):
        value = (words[i + 1] if i + 1 < len(words) else "") if word in ("--conversation", "-conversation") else (
            word.split("=", 1)[1] if word.startswith(("--conversation=", "-conversation=")) else "")
        if AGY_ID.fullmatch(value):
            info.update(session_id=value, identity_source="argv_conversation")
            break
    return info


# ---------------------------------------------------------------- GitHub Copilot CLI

COPILOT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")   # a UUID: nothing else names a conversation


def _argv_copilot_session(argv):
    """The conversation a Copilot started with ``--resume=<id>``, ``--resume <id>`` or ``--session-id`` names.
    A name or an id prefix (``--resume=my-feature``) is not an id: it names none."""
    words = [a.decode(errors="ignore") for a in argv]
    for i, word in enumerate(words):
        name, equals, value = word.partition("=")
        if name not in ("--resume", "--session-id", "-r"):
            continue
        if not equals:
            value = words[i + 1] if i + 1 < len(words) else ""
        if COPILOT_ID.fullmatch(value):
            return value
    return None


def copilot_info(pid):
    """What can be read from the process: its folder and the conversation named in its arguments. The
    state and the conversation it is in now come from the hooks of Mesh's plugin (server._apply_copilot_hooks);
    Copilot's own files (session-state/, config.json with the accounts) are never opened here."""
    # No state until a hook reports one: a fresh Copilot says nothing.  ``started`` lets the server drop a
    # hook report older than this process.
    info = {"type": "copilot", "started": proc_start(pid)}
    here = cwd(pid)
    if here:
        info["cwd"] = here
    named = _argv_copilot_session(cmdline(pid))
    if named:
        info.update(session_id=named, identity_source="argv_session")
    return info


# ---------------------------------------------------------------- Mistral Vibe

VIBE_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def _vibe_sessions():
    """Vibe's conversation directories (its unified session store, one directory per conversation)."""
    base = os.environ.get("VIBE_HOME") or f"{HOME}/.vibe"
    return glob.glob(f"{os.path.expanduser(base)}/logs/session/unified/*/meta.json")


def _vibe_meta(path):
    """(id, working directory) of a conversation written by Vibe, None when unreadable or a sub-agent's."""
    try:
        with open(path, encoding="utf-8") as handle:
            meta = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("parent_session_id") or not isinstance(meta.get("session_id"), str):
        return None
    where = (meta.get("environment") or {}).get("working_directory")
    return (meta["session_id"], where) if VIBE_ID.fullmatch(meta["session_id"]) and isinstance(where, str) else None


def _argv_vibe_session(argv):
    """The conversation a Vibe started with ``--resume <id>`` names, if any."""
    words = [a.decode(errors="ignore") for a in argv]
    for i, word in enumerate(words):
        value = word.split("=", 1)[1] if word.startswith("--resume=") else (
            words[i + 1] if word == "--resume" and i + 1 < len(words) else "")
        if VIBE_ID.fullmatch(value):
            return value
    return None


def vibe_info(pid):
    """Vibe has no prompt Mesh can recognise on the screen and its store is a versioned journal: the state
    comes from its hooks (server._apply_reported_state).  The conversation is named by ``--resume``, else
    it is the single one written in the folder since the process started."""
    started = proc_start(pid)
    info = {"type": "vibe", "started": started}    # ``started``: lets the server drop a hook report older than this process
    here = cwd(pid)
    if not here:
        return info
    named = _argv_vibe_session(cmdline(pid))
    if named:
        return {**info, "session_id": named, "identity_source": "argv_resume", "cwd": here}
    if _another_agent_runs_in(pid, here, "vibe"):
        return info
    found = []
    for path in _vibe_sessions():
        try:
            written = os.path.getmtime(path)
        except OSError:
            continue
        meta = _vibe_meta(path) if written >= started - 2 else None
        if meta and meta[1] == here:
            found.append((written, meta[0]))
    if len(found) != 1:
        return info
    return {**info, "session_id": found[0][1], "identity_source": "unique_vibe_session", "cwd": here,
            "updated": found[0][0]}


def agent_info(pid, kind):
    if kind == "copilot":
        info = copilot_info(pid)
    else:
        info = {"claude": claude_info, "codex": codex_info, "pi": pi_info, "opencode": opencode_info,
                "gemini": gemini_info, "agy": agy_info, "vibe": vibe_info}[kind](pid)
    info["pid"] = pid
    info["argv"] = [a.decode(errors="ignore") for a in cmdline(pid)]
    return info


def describe(procs, sid):
    fg = foreground(procs, sid)
    ag = session_agent(procs, sid)
    argv = [a.decode(errors="ignore") for a in cmdline(fg)]
    agent = agent_info(*ag) if ag else None
    if agent:
        leader = procs.get(sid)
        # An agent can still exist in the session after ``codex &`` or after a
        # job-control hand-off, while input goes to the shell's foreground
        # process group. Surface that distinction to input-bearing UI only;
        # session_agent deliberately remains useful for passive discovery.
        agent_state = procs.get(ag[0])
        agent["foreground"] = bool(leader and agent_state and agent_state[3] == leader[6])
    return {
        "cwd": cwd(ag[0] if ag else fg) or cwd(sid),
        "cmd": " ".join(argv)[:160] or (procs[fg][0] if fg in procs else "?"),
        "agent": agent,
    }


# ---------------------------------------------------------------- other terminals

# What owns a terminal, from the parent of its session leader.
HOSTS = {"terminator": "Terminator", "sshd-session": "SSH", "sshd": "SSH", "kitty": "kitty",
         "tmux: server": "tmux", "alacritty": "Alacritty", "konsole": "Konsole",
         "gnome-terminal-": "GNOME Terminal", "wezterm-gui": "WezTerm", "foot": "foot",
         "xterm": "xterm", "code": "VS Code", "zellij": "zellij"}


def external_sessions(procs, exclude_parents=()):
    """Every terminal session on a /dev/pts tty that the mesh does not own:
    Terminator tabs, SSH logins, other emulators. One entry per session leader."""
    out = []
    for pid, st in procs.items():
        if st[4] != pid or st[2] in exclude_parents:
            continue
        tty = tty_of(pid)
        if not tty:
            continue
        parent = procs.get(st[2])
        pcomm = parent[0] if parent else "?"
        host = HOSTS.get(pcomm)
        if not host:
            if st[0] in ("bash", "zsh", "fish", "sh") or session_agent(procs, pid):
                host = pcomm
            else:
                continue  # a daemon's helper tty, not a terminal someone uses
        d = describe(procs, pid)
        d.update(id=f"t{pid}", pid=pid, tty=tty, kind="external", host=host)
        out.append(d)
    return out
