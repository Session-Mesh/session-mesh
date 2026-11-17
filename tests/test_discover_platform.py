# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Outside Linux, process facts come from the native PTY host ({"op": "processes"}
on its socket). The same facts must give the same sessions as /proc gives on
Linux; a host that does not answer means "unknown", never "the process is gone"."""

import asyncio
import itertools
import json
import os
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

import discover
import localmesh
import observability
import ptyhost
import respawn
import server
from ptyhost_proc import daemon, wait_until  # noqa: F401  (daemon is a fixture)

REPO = Path(__file__).resolve().parent.parent

HOST = {"pid": 77, "incarnation": "1763100000000001"}
STAT_KEYS = ("pid", "ppid", "pgrp", "sid", "tpgid", "comm", "state", "incarnation")


def row(pid, ppid, sid, comm, tpgid=-1, pgrp=None, **details):
    return {"pid": pid, "ppid": ppid, "pgrp": pgrp or pid, "sid": sid, "tpgid": tpgid,
            "comm": comm, "state": "S", "incarnation": f"17631000{pid:08d}", **details}


# A terminal emulator with a shell running vim, an SSH login running codex, a
# daemon, and a process whose name is not UTF-8.
FACTS = [
    row(100, 1, 100, "terminator"),
    row(200, 100, 200, "bash", tpgid=210, argv=["bash"], cwd="/home/u/proj", stdin="/dev/pts/3"),
    row(210, 200, 200, "vim", tpgid=210, argv=["vim", "notes\udcff.txt"], cwd="/home/u/proj/sub"),
    row(290, 1, 290, "sshd-session"),
    row(300, 290, 300, "zsh", tpgid=310, argv=["-zsh"], cwd="/w", stdin="/dev/ttys004"),
    row(310, 300, 300, "codex", tpgid=310, argv=["codex", "--yolo"], cwd="/w", open_files=[]),
    row(400, 1, 400, "daemon"),
    row(500, 1, 500, "x\udcff"),
]


def encode(value):
    """JSON as the host writes it: strings are raw bytes, not necessarily UTF-8."""
    return json.dumps(value, ensure_ascii=False).encode("utf-8", "surrogateescape")


class FakeHost(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """A host on its own socket and threads: ``answer(request)`` gives the reply
    payload (bytes), or None to close without replying."""
    daemon_threads = True

    def __init__(self, path, answer):
        self.answer, self.requests = answer, []
        host = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                head = self.request.recv(5, socket.MSG_WAITALL)
                body = self.request.recv(struct.unpack(">I", head[1:])[0], socket.MSG_WAITALL)
                request = json.loads(body)
                host.requests.append(request)
                payload = host.answer(request)
                if payload is not None:
                    self.request.sendall(b"C" + struct.pack(">I", len(payload)) + payload)
        super().__init__(str(path), Handler)


@pytest.fixture
def fake_host(monkeypatch):
    """Start a fake host with fake_host(answer); ptyhost.SOCK points at it. Without
    a call, nothing listens there."""
    hosts = []
    directory = Path(tempfile.mkdtemp(prefix="fh-", dir=os.environ["SMESH_TEST_ROOT"]))
    monkeypatch.setattr(ptyhost, "SOCK", directory / "h.sock")

    def start(answer):
        host = FakeHost(ptyhost.SOCK, answer)
        threading.Thread(target=host.serve_forever, daemon=True).start()
        hosts.append(host)
        return host
    yield start
    for host in hosts:
        host.shutdown()
        host.server_close()


def answering(facts=FACTS, errors=()):
    """A host with this table, answering pid lookups from it too."""
    def answer(request):
        if "pids" not in request:
            return encode({"version": 1, "host": HOST, "complete": True, "processes": facts})
        found = [{key: r[key] for key in STAT_KEYS} for r in facts if r["pid"] in request["pids"]]
        missing = [{"pid": pid, "kind": dict(errors).get(pid, "not_found")}
                   for pid in request["pids"] if pid not in {r["pid"] for r in found}]
        return encode({"version": 1, "host": HOST, "complete": True, "processes": found,
                       "errors": missing})
    return answer


@pytest.fixture
def darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(discover, "_facts", {})   # no rows left by another test


def gone_pid():
    child = subprocess.Popen(["true"])
    child.wait()
    return child.pid


# ---------------------------------------------------------------- same facts, same sessions

def linux_reading(monkeypatch, facts):
    """What the /proc functions would answer for these facts on Linux."""
    by_pid = {r["pid"]: r for r in facts}

    def stat(pid):
        r = by_pid[pid]
        comm = r["comm"].encode("utf-8", "surrogateescape").decode("utf-8", "replace")
        return comm, r["state"], r["ppid"], r["pgrp"], r["sid"], 0, r["tpgid"]

    def detail(key, default, convert=lambda value: value):
        return lambda pid: convert(by_pid[pid][key]) if key in by_pid.get(pid, {}) else default
    monkeypatch.setattr(discover, "snapshot", lambda: {pid: stat(pid) for pid in by_pid})
    monkeypatch.setattr(discover, "cmdline", detail(
        "argv", [], lambda argv: [a.encode("utf-8", "surrogateescape") for a in argv]))
    monkeypatch.setattr(discover, "cwd", detail("cwd", None))
    monkeypatch.setattr(discover, "tty_of", detail("stdin", None))
    monkeypatch.setattr(discover, "proc_start", detail("incarnation", 0, lambda i: int(i) / 1e6))
    monkeypatch.setattr(discover, "_open_rollouts", detail("open_files", None))


def sessions_seen():
    procs = discover.snapshot()
    return (procs, discover.external_sessions(procs, exclude_parents={1}),
            [discover.describe(procs, sid) for sid in (200, 300)])


def test_the_host_facts_give_the_sessions_proc_gives(darwin, fake_host, monkeypatch):
    fake_host(answering())
    from_host = sessions_seen()
    with monkeypatch.context() as patched:
        linux_reading(patched, FACTS)
        from_proc = sessions_seen()
    assert from_host == from_proc
    procs, external, described = from_host
    assert procs[500][0] == "x\ufffd"
    assert [(s["pid"], s["host"], s["tty"]) for s in external] == [
        (200, "Terminator", "/dev/pts/3"), (300, "SSH", "/dev/ttys004")]
    assert described[0]["cmd"] == "vim notes.txt" and described[0]["cwd"] == "/home/u/proj/sub"
    assert described[1]["agent"]["type"] == "codex" and described[1]["agent"]["foreground"]


def test_one_snapshot_is_one_request(darwin, fake_host):
    host = fake_host(answering())
    procs = discover.snapshot()
    discover.describe(procs, 200)
    assert host.requests == [{"op": "processes"}]   # as on Linux, a codex re-reads the table
    assert discover.cmdline(210) == [b"vim", b"notes\xff.txt"]
    assert discover.tty_of(300) == "/dev/ttys004"
    assert discover.proc_start(310) == pytest.approx(1763100000.000310)
    assert discover._open_rollouts(310) == []


def test_facts_not_reported_are_unknown(darwin, fake_host, monkeypatch):
    fake_host(answering([row(1, 0, 1, "launchd", stdin="/dev/null", argv="bad", cwd=3)]))
    discover.snapshot()
    assert discover.tty_of(1) is None             # not a terminal
    assert (discover.cmdline(1), discover.cwd(1)) == ([], None)
    assert discover._open_rollouts(1) is None
    assert (discover.cmdline(2), discover.cwd(2), discover.proc_start(2)) == ([], None, 0)
    assert discover.proc_start(1) > 0
    monkeypatch.setattr(discover, "FACTS_SECONDS", 0)   # the table describes one refresh only
    assert discover.proc_start(1) == 0


def test_malformed_rows_are_skipped(darwin, fake_host):
    fake_host(answering([row(4242, 1, 4242, "codex"), {"pid": 7, "comm": "broken"}, 42,
                         {**row(4243, 1, 4243, "x"), "ppid": True}]))
    assert discover.snapshot() == {4242: ("codex", "S", 1, 4242, 4242, 0, -1)}


# ---------------------------------------------------------------- complete or not

TABLE_REPLIES = {
    "complete": ({"complete": True, "processes": FACTS}, True, True),
    "declared incomplete": ({"complete": False, "processes": FACTS}, True, False),
    "completeness not stated": ({"processes": FACTS}, True, False),
    "a malformed row": ({"complete": True, "processes": FACTS + [{"pid": 9}]}, True, False),
    "no table": ({"complete": True}, False, False),
}


@pytest.mark.parametrize("reply, answered, complete", TABLE_REPLIES.values(), ids=TABLE_REPLIES.keys())
def test_a_table_is_complete_only_when_the_host_says_so(darwin, fake_host, reply, answered, complete):
    fake_host(lambda request: encode({"version": 1, "host": HOST, **reply}))
    procs = discover.snapshot()
    assert (procs.answered, procs.complete, discover.known_complete(procs)) == (answered, complete, complete)
    assert len(procs) == (len(FACTS) if answered else 0)


def test_no_answer_is_not_a_complete_table(darwin, fake_host):
    procs = discover.snapshot()
    assert procs == {} and not procs.answered and not discover.known_complete(procs)


def test_a_linux_table_is_complete():
    assert discover.known_complete({})


def in_turn(*tables):
    """A host giving these whole-table replies in turn (None: closes without
    replying), and "not found" for every pid lookup."""
    pending = list(tables)

    def answer(request):
        if "pids" in request:
            return encode({"version": 1, "host": HOST, "complete": True, "processes": [],
                           "errors": [{"pid": pid, "kind": "not_found"} for pid in request["pids"]]})
        table = pending.pop(0)
        return None if table is None else encode({"version": 1, "host": HOST, **table})
    return answer


def agents_in(directory, comm, *pids, **details):
    started = f"{int((time.time() - 3600) * 1e6)}"
    return [{**row(pid, 1, pid, comm, argv=[comm], cwd=directory, stdin="/dev/ttys001", **details),
             "incarnation": started} for pid in pids]


TWO_PI = agents_in("/w", "pi", 100, 200)
SECOND_TABLE = {
    "complete again": {"complete": True, "processes": TWO_PI},
    "unanswered": None,
    "truncated": {"complete": False, "processes": TWO_PI[1:]},
    "complete, other cwd unknown": {"complete": True, "processes": [
        {key: value for key, value in TWO_PI[0].items() if key != "cwd"}, TWO_PI[1]]},
}


@pytest.mark.parametrize("second", SECOND_TABLE.values(), ids=SECOND_TABLE.keys())
def test_a_pi_does_not_take_another_pis_conversation(darwin, fake_host, monkeypatch, tmp_path, second):
    """Two pi in /w and one transcript: the transcript cannot say whose it is. A
    table that may hide the other pi, or its directory, must not attribute it."""
    transcript = tmp_path / "a.jsonl"
    transcript.write_text('{"type":"session","version":3,"cwd":"/w","id":"conversation-of-pi-A"}\n')
    monkeypatch.setattr(discover, "_pi_sessions", lambda: [str(transcript)])
    fake_host(in_turn({"complete": True, "processes": TWO_PI}, second))
    discover.snapshot()
    info = discover.pi_info(200)
    assert info.get("session_id") is None
    assert (discover.cwd(200), discover.cmdline(200)) == ("/w", [b"pi"])


def test_a_lone_pi_keeps_its_conversation(darwin, fake_host, monkeypatch, tmp_path):
    transcript = tmp_path / "a.jsonl"
    transcript.write_text('{"type":"session","version":3,"cwd":"/w","id":"conversation-of-pi-A"}\n')
    monkeypatch.setattr(discover, "_pi_sessions", lambda: [str(transcript)])
    lone = {"complete": True, "processes": TWO_PI[1:]}
    fake_host(in_turn(lone, lone))
    discover.snapshot()
    assert discover.pi_info(200)["session_id"] == "conversation-of-pi-A"


# On a real Mac a pi agent is a node process (comm "node") whose argv[0] is "pi",
# its other arguments blanked: only argv identifies it.
def mac_pi(pid, directory="/w", argv=("pi", "", "", "")):
    started = f"{int((time.time() - 3600) * 1e6)}"
    return {**row(pid, 1, pid, "node", tpgid=pid, cwd=directory, stdin="/dev/ttys001",
                  argv=None if argv is None else list(argv)), "incarnation": started}


def a_transcript(monkeypatch, tmp_path):
    transcript = tmp_path / "a.jsonl"
    transcript.write_text('{"type":"session","version":3,"cwd":"/w","id":"conversation-of-pi-A"}\n')
    monkeypatch.setattr(discover, "_pi_sessions", lambda: [str(transcript)])


def test_a_mac_pi_is_detected_by_its_argv(darwin, fake_host):
    fake_host(answering([mac_pi(200)]))
    procs = discover.snapshot()
    assert discover.is_agent(200, procs[200]) == "pi"
    assert discover.describe(procs, 200)["agent"]["type"] == "pi"


def test_a_node_of_unknown_argv_is_no_agent(darwin, fake_host):
    fake_host(answering([mac_pi(200, argv=None)]))
    procs = discover.snapshot()
    assert discover.is_agent(200, procs[200]) is None
    assert discover.describe(procs, 200)["agent"] is None


MAC_OTHERS = {
    "another mac pi": (mac_pi(100), None),
    "a node of unknown argv": (mac_pi(100, argv=None), None),
    "a node of empty argv": (mac_pi(100, argv=()), None),
    "a node of unknown argv and cwd": ({**mac_pi(100, argv=None), "cwd": None}, None),
    "a node of unknown argv elsewhere": (mac_pi(100, "/elsewhere", argv=None), "conversation-of-pi-A"),
    "another node program": (mac_pi(100, argv=("node", "server.js")), "conversation-of-pi-A"),
    "a mac pi elsewhere": (mac_pi(100, "/elsewhere"), "conversation-of-pi-A"),
}


@pytest.mark.parametrize("other, expected", MAC_OTHERS.values(), ids=MAC_OTHERS.keys())
def test_a_mac_pi_keeps_its_conversation_only_when_alone(darwin, fake_host, monkeypatch, tmp_path,
                                                         other, expected):
    """A node that may be another pi in /w (argv unknown, or cwd unknown) leaves
    the transcript unattributed: a complete table does not make its argv known."""
    a_transcript(monkeypatch, tmp_path)
    fake_host(answering([other, mac_pi(200)]))
    discover.snapshot()
    assert discover.pi_info(200).get("session_id") == expected


def test_the_pi_guard_reads_its_own_table(darwin, fake_host, monkeypatch, tmp_path):
    """Another thread publishes a partial table without the other pi between the
    guard's snapshot and its argv reads: the guard still sees that pi."""
    a_transcript(monkeypatch, tmp_path)
    other, mine = mac_pi(100), mac_pi(200)
    fake_host(answering([other, mine]))
    discover.snapshot()
    taken = discover.snapshot

    def snapshot_then_partial():
        procs = taken()
        discover._remember({200: mine}, True)   # a later answer that lists pi 200 only
        return procs
    monkeypatch.setattr(discover, "snapshot", snapshot_then_partial)
    assert discover.pi_info(200).get("session_id") is None


def test_a_codex_count_reads_cwd_from_its_own_table(darwin, fake_host, monkeypatch):
    first, second = agents_in("/w", "codex", 300, 400)
    fake_host(answering([first, second]))
    taken = discover.snapshot

    def snapshot_then_moved():
        procs = taken()
        discover._remember({400: {**second, "cwd": "/elsewhere"}}, False)
        return procs
    monkeypatch.setattr(discover, "snapshot", snapshot_then_moved)
    assert discover._codex_count("/w") == 2


# A JSON escape of a lone surrogate outside U+DC80..U+DCFF (a buggy or foreign
# host) cannot be turned back into bytes: that field is unknown, never an error.
def test_a_lone_surrogate_is_an_unknown_field(darwin, fake_host):
    rows = [row(600, 1, 600, "\ud800", argv=["vim", "\ud800"], cwd="/w"),
            row(610, 1, 610, "\udcff\ud800x", tpgid=610, argv=["\ud800"], cwd="/w",
                stdin="/dev/ttys002")]
    fake_host(lambda request: json.dumps(
        {"version": 1, "host": HOST, "complete": True, "processes": rows,
         "errors": []}).encode())
    procs = discover.snapshot()
    assert procs[600][0] == procs[610][0] == discover.UNKNOWN_NAME
    assert discover.cmdline(600) == discover.cmdline(610) == []
    assert discover.read_stat(os.getpid()) == discover.PRESENT_UNKNOWN
    assert discover.describe(procs, 610)["cwd"] == "/w"
    assert isinstance(discover.external_sessions(procs), list)


def write_rollouts(directory, cwd, *ids):
    paths = []
    for index, rollout_id in enumerate(ids):
        path = directory / f"rollout-{index}.jsonl"
        path.write_text(json.dumps({"payload": {"cwd": cwd, "id": rollout_id}}) + "\n")
        os.utime(path, (time.time() + index, time.time() + index))
        paths.append(str(path))
    return paths


ONE_CODEX = agents_in("/w", "codex", 300, open_files=[])
CODEX_SECOND_TABLE = {
    "unanswered": (None, None),
    "truncated": ({"complete": False, "processes": ONE_CODEX}, None),
    "complete, a codex of unknown cwd": ({"complete": True, "processes": ONE_CODEX + [
        {key: value for key, value in agents_in("/w", "codex", 400)[0].items() if key != "cwd"}]},
        None),
    "complete": ({"complete": True, "processes": ONE_CODEX}, "rid-new"),
}


@pytest.mark.parametrize("second, expected", CODEX_SECOND_TABLE.values(), ids=CODEX_SECOND_TABLE.keys())
def test_a_codex_takes_its_newest_rollout_only_when_alone(darwin, fake_host, monkeypatch, tmp_path,
                                                         second, expected):
    """A lone codex may have written several rollouts (/new): its newest is its own.
    Unless the table is known complete, another codex may run there."""
    rollouts = write_rollouts(tmp_path, "/w", "rid-old", "rid-new")
    monkeypatch.setattr(discover, "recent_rollouts", lambda: rollouts)
    fake_host(in_turn({"complete": True, "processes": ONE_CODEX}, second))
    discover.snapshot()
    assert discover.codex_info(300).get("session_id") == expected


def test_a_failed_snapshot_keeps_the_listing_in_progress(darwin, fake_host):
    """describe() of a listing reads the table its snapshot got, even when a nested
    snapshot meanwhile got no answer: no cwd None or argv [] for a resume to use."""
    fake_host(in_turn({"complete": True, "processes": FACTS}, None, None))
    procs = discover.snapshot()
    before = discover.describe(procs, 300)
    assert discover.snapshot() == {}
    assert discover.describe(procs, 300) == before
    assert before["cwd"] == "/w" and before["agent"]["argv"] == ["codex", "--yolo"]
    assert [s["pid"] for s in discover.external_sessions(procs, exclude_parents={1})] == [200, 300]
    assert discover.tty_of(200) == "/dev/pts/3"


def test_a_truncated_snapshot_adds_without_erasing(darwin, fake_host):
    moved = row(210, 200, 200, "vim", tpgid=210, argv=["vim"], cwd="/elsewhere")
    fake_host(in_turn({"complete": True, "processes": FACTS},
                      {"complete": False, "processes": [moved]},
                      {"complete": True, "processes": FACTS[:1]}))
    discover.snapshot()
    discover.snapshot()
    assert (discover.cwd(210), discover.cwd(300)) == ("/elsewhere", "/w")
    discover.snapshot()   # a complete table: the processes it does not list are gone
    assert (discover.cwd(210), discover.cwd(300)) == (None, None)


def test_concurrent_snapshots_keep_the_rows(darwin, fake_host):
    """Snapshots from several threads, some unanswered or truncated, never leave
    a process of the table unknown in between."""
    replies = itertools.cycle([{"complete": True, "processes": FACTS}, None,
                               {"complete": False, "processes": FACTS[:2]}])
    lock = threading.Lock()

    def answer(request):
        with lock:
            reply = next(replies)
        return None if reply is None else encode({"version": 1, "host": HOST, **reply})
    fake_host(answer)
    discover.snapshot()
    done, seen = threading.Event(), []

    def read():
        while not done.is_set():
            seen.append((discover.cwd(300), tuple(discover.cmdline(310)), discover.tty_of(200)))

    def take():
        for _ in range(10):
            discover.snapshot()
    reader = threading.Thread(target=read)
    reader.start()
    takers = [threading.Thread(target=take) for _ in range(6)]
    for thread in takers:
        thread.start()
    for thread in takers:
        thread.join()
    done.set()
    reader.join()
    assert seen and set(seen) == {("/w", (b"codex", b"--yolo"), "/dev/pts/3")}


# ---------------------------------------------------------------- no answer

NO_ANSWER = {
    "no host": None,
    "closed without reply": lambda request: None,
    "not JSON": lambda request: b"not json",
    "not an object": lambda request: b"[]",
    "error reply": lambda request: b'{"error": "invalid request"}',
}


@pytest.mark.parametrize("answer", NO_ANSWER.values(), ids=NO_ANSWER.keys())
def test_no_answer_means_unknown(darwin, fake_host, answer):
    if answer:
        fake_host(answer)
    assert discover.snapshot() == {}
    assert discover.cmdline(os.getpid()) == []
    assert discover.cwd(os.getpid()) is None
    assert discover.tty_of(os.getpid()) is None
    assert discover.codex_info(os.getpid()) == {"type": "codex"}
    # alive, details unknown: not "gone"
    assert discover.read_stat(os.getpid()) == discover.PRESENT_UNKNOWN
    with pytest.raises(OSError):
        localmesh._parent(os.getpid())
    assert discover.read_stat(gone_pid()) is None   # the kernel says it is gone


def test_a_frame_too_large_is_no_answer(fake_host, monkeypatch):
    fake_host(lambda request: b'{"a": 1}')
    assert ptyhost.request_sync({"op": "processes"}, 1.0) == {"a": 1}
    monkeypatch.setattr(ptyhost, "MAX_SMALL_FRAME", 4)
    assert ptyhost.request_sync({"op": "processes"}, 1.0) is None


def test_a_silent_host_is_bounded(darwin, fake_host, monkeypatch):
    release = threading.Event()
    fake_host(lambda request: release.wait(5) and None)
    monkeypatch.setattr(discover, "HOST_TIMEOUT", 0.2)
    try:
        assert discover.snapshot() == {}
    finally:
        release.set()


def test_request_sync_is_bounded_by_one_deadline_across_phases(monkeypatch):
    """Connect and send each take 0.15 s (they honour the timeout they are given):
    with a 0.2 s budget the whole call stops at about 0.2 s, not 0.3 s or 0.4 s."""
    class SlowSocket:
        def __init__(self, *args):
            self.limit = None

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def settimeout(self, value):
            self.limit = value

        def _spend(self, wanted):
            time.sleep(min(wanted, self.limit))
            if self.limit < wanted:
                raise socket.timeout("timed out")

        def connect(self, path):
            self._spend(0.15)

        def sendall(self, data):
            self._spend(0.15)

        def recv(self, size):
            self._spend(5)

    monkeypatch.setattr(ptyhost.socket, "socket", SlowSocket)
    started = time.monotonic()
    assert ptyhost.request_sync({"op": "processes"}, 0.2) is None
    assert time.monotonic() - started < 0.28


# ---------------------------------------------------------------- read_stat and _wait_dead

def test_read_stat_asks_the_host_for_that_process(darwin, fake_host):
    me = os.getpid()
    host = fake_host(answering([row(me, 1, me, "python", tpgid=me)]))
    assert discover.read_stat(me) == ("python", "S", 1, me, me, 0, me)
    assert host.requests == [{"op": "processes", "pids": [me]}]
    assert discover.read_stat(0) is None and discover.read_stat(-1) is None


def test_read_stat_believes_the_host_not_found(darwin, fake_host):
    fake_host(answering([]))
    assert discover.read_stat(os.getpid()) is None   # it exited after kill() saw it


def test_read_stat_takes_denied_for_present_unknown(darwin, fake_host):
    fake_host(answering([], errors=[(os.getpid(), "denied")]))
    assert discover.read_stat(os.getpid()) == discover.PRESENT_UNKNOWN


@pytest.mark.parametrize("answer", NO_ANSWER.values(), ids=NO_ANSWER.keys())
def test_read_stat_takes_no_answer_for_present_unknown(darwin, fake_host, answer):
    if answer:
        fake_host(answer)
    assert discover.read_stat(os.getpid()) == discover.PRESENT_UNKNOWN
    assert discover.read_stat(gone_pid()) is None   # ESRCH: gone, whatever the host says


def test_read_stat_gives_up_on_a_late_host(darwin, fake_host, monkeypatch):
    release = threading.Event()
    fake_host(lambda request: release.wait(5) and None)
    monkeypatch.setattr(discover, "HOST_TIMEOUT", 0.2)
    try:
        assert discover.read_stat(os.getpid()) == discover.PRESENT_UNKNOWN
    finally:
        release.set()


def test_present_unknown_matches_no_process():
    """Its parent, group, session and foreground group cannot be a real pid, and its
    state is not a zombie's."""
    comm, state, ppid, pgrp, sid, _tty, tpgid = discover.PRESENT_UNKNOWN
    assert state != "Z" and comm not in discover.AGENTS
    assert all(value < 0 for value in (ppid, pgrp, sid, tpgid))


@pytest.mark.parametrize("answer", [None, lambda request: None], ids=["no host", "late host"])
async def test_wait_dead_does_not_take_no_answer_for_an_exit(darwin, fake_host, answer):
    """A resume stops the agent, then waits for it to exit before starting a new
    one on the same conversation: no answer must fail the resume (False: 409),
    not start a second agent next to the first, nor raise (500)."""
    if answer:
        fake_host(answer)
    assert await server._wait_dead(os.getpid(), timeout=0.5) is False


async def test_wait_dead_sees_an_exit(darwin, fake_host):
    assert await server._wait_dead(gone_pid(), timeout=1)


async def test_wait_dead_waits_while_the_host_sees_the_process(darwin, fake_host):
    me = os.getpid()
    fake_host(answering([row(me, 1, me, "python")]))
    assert not await server._wait_dead(me, timeout=0.5)


async def test_wait_dead_takes_a_zombie_for_an_exit(darwin, fake_host):
    me = os.getpid()
    fake_host(answering([{**row(me, 1, me, "python"), "state": "Z"}]))
    assert await server._wait_dead(me, timeout=0.5)


def test_an_unknown_parent_leaves_two_codex_ambiguous(darwin, monkeypatch):
    procs = {pid: ("codex", "S", pid - 1, pid, 1, 0, pid) for pid in (10, 20)}
    monkeypatch.setattr(discover, "snapshot", lambda: procs)
    monkeypatch.setattr(discover, "is_agent", lambda pid, st: "codex")
    monkeypatch.setattr(discover, "cwd", lambda pid: "/w")

    monkeypatch.setattr(discover, "read_stat", lambda pid: discover.PRESENT_UNKNOWN)
    assert discover._codex_count("/w") == 2


def test_the_session_ancestry_survives_an_unknown_parent(darwin, fake_host, monkeypatch):
    monkeypatch.delenv("MESH_SESSION", raising=False)
    assert localmesh.current_session([{"pid": 1, "name": "x"}], pid=os.getpid()) is None


def test_observability_reads_no_procfs_outside_linux(darwin):
    assert observability._read_process(os.getpid()) is None
    assert observability._read_start_ticks(os.getpid()) is None


# ---------------------------------------------------------------- host identity

async def test_host_identity_comes_from_the_host(darwin, fake_host):
    host = fake_host(answering())
    identity = await ptyhost.host_identity()
    assert identity == "77:1763100000000001" and respawn.HOST_RE.fullmatch(identity)
    assert host.requests == [{"op": "processes", "pids": []}]


BAD_IDENTITIES = [None, {}, {"pid": 0, "incarnation": "1"}, {"pid": True, "incarnation": "1"},
                  {"pid": 1, "incarnation": 1}, {"pid": 1, "incarnation": "1x"},
                  {"pid": 1, "incarnation": "1" * 21}, {"pid": 10**10, "incarnation": "1"}]


@pytest.mark.parametrize("identity", BAD_IDENTITIES)
async def test_host_identity_is_none_when_unknown(darwin, fake_host, identity):
    fake_host(lambda request: encode({"version": 1, "host": identity, "processes": []}))
    assert await ptyhost.host_identity() is None


async def test_host_identity_is_none_without_a_host(darwin, fake_host):
    assert await ptyhost.host_identity() is None


# ---------------------------------------------------------------- the real host

async def test_the_real_host_agrees_with_proc(daemon, monkeypatch):
    """The non-Linux path, run on Linux against the built host, sees a session as /proc does."""
    await daemon.new("s", command="sleep 600")
    shell = next(s["pid"] for s in await daemon.request({"op": "list"}))
    await wait_until(lambda: any(st[2] == shell for st in discover.snapshot().values()))
    identity = await ptyhost.host_identity()

    def seen():
        procs = discover.snapshot()
        members = sorted(pid for pid, st in procs.items() if st[4] == shell)
        return ({pid: procs[pid][:5] + procs[pid][6:] for pid in members},   # tty_nr aside
                [(discover.cmdline(pid), discover.cwd(pid)) for pid in members],
                discover.tty_of(shell), discover.describe(procs, shell))
    from_proc = await asyncio.to_thread(seen)
    assert from_proc[2].startswith("/dev/pts/")
    with monkeypatch.context() as patched:   # the fixture's teardown reads /proc again
        patched.setattr(sys, "platform", "freebsd14")
        assert await asyncio.to_thread(seen) == from_proc
        assert (await asyncio.to_thread(discover.read_stat, shell))[4] == shell
        assert await ptyhost.host_identity() == identity      # same pid and start ticks


# ---------------------------------------------------------------- the socket's default directory
def test_the_macos_default_runtime_dir_is_below_the_passwd_home(darwin, monkeypatch):
    """As the native host: the user database's home, not $HOME."""
    monkeypatch.setenv("HOME", "/elsewhere")
    entry = type("Entry", (), {"pw_dir": "/home-of-db/someone"})
    monkeypatch.setattr(ptyhost.pwd, "getpwuid", lambda uid: entry)
    assert ptyhost._default_runtime_dir() == Path(
        "/home-of-db/someone/Library/Application Support/session-mesh/run")


def test_the_linux_default_runtime_dir_is_unchanged(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert ptyhost._default_runtime_dir() == Path(f"/run/user/{os.getuid()}")
