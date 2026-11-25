# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Synthetic read/resize attachments; no input or owner session required."""
import asyncio
import json
import os
import signal
import shlex
import subprocess
import sys
from pathlib import Path
import tempfile
import time

import pytest

import ptyhost
from helpers import read_until
from ptyhost_proc import Daemon, bounded, ptyhost_command, wait_until

pytestmark = [pytest.mark.ptyhost_t42]

WRITER_SOURCE = """
def write_payload(data, write, progress):
 view=memoryview(data); offset=0; writes=0; milestone=1024*1024
 if not view: progress(0,0)
 while offset<len(view):
  count=write(view[offset:])
  if type(count) is not int or count<=0 or count>len(view)-offset:
   raise ValueError('invalid emitter write result')
  offset+=count; writes+=1
  if offset>=milestone or offset==len(view):
   progress(offset,writes)
   milestone=(offset//(1024*1024)+1)*(1024*1024)
 return offset,writes
"""


def task_category(task):
    if not task.done():
        return "pending"
    if task.cancelled():
        return "cancelled"
    return "failed" if task.exception() is not None else "succeeded"


def emitter_progress(directory, index):
    try:
        with (directory / f"progress{index}").open("rb") as source:
            data = source.read(129)
        if len(data) > 128:
            return "unavailable"
        value = json.loads(data)
        if not isinstance(value, dict) or set(value) != {"bytes", "writes"}:
            return "unavailable"
        if any(type(n) is not int or not 0 <= n <= 2**63-1 for n in value.values()):
            return "unavailable"
        if not 0 <= value["writes"] <= value["bytes"] or (value["bytes"] > 0 and value["writes"] == 0):
            return "unavailable"
        return value
    except (OSError, ValueError):
        return "unavailable"


@pytest.fixture
async def emitting(monkeypatch, tmp_path):
    shell = tmp_path / "emit.py"
    shell.write_text("#!/usr/bin/python3\n"
        "import os,time,pathlib,fcntl,termios,struct,sys,tty,signal,json\n"
        + WRITER_SOURCE +
        "tty.setcbreak(0)\n"
        "home=pathlib.Path.cwd()\n"
        "(home/'ready').touch()\n"
        "index=0; previous_size=None\n"
        "while True:\n"
        " if (home/('hold-'+str(os.getpid()))).exists():\n"
        "  (home/('parked-'+str(os.getpid()))).touch()\n"
        "  time.sleep(.005); continue\n"
        " if (home/'ignore_hup').exists():\n"
        "  signal.signal(signal.SIGHUP,signal.SIG_IGN)\n"
        "  (home/'hup_ignored').touch()\n"
        " size=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))[:2]\n"
        " if size!=previous_size:\n"
        "  (home/'geometry.tmp').write_text('%s:%s'%size)\n"
        "  (home/'geometry.tmp').replace(home/'geometry')\n"
        "  previous_size=size\n"
        " path=home/('step'+str(index))\n"
        " if not path.exists(): time.sleep(.005); continue\n"
        " command=path.read_bytes()\n"
        " if command==b'SIZE':\n"
        "  data=('SIZE:%s:%s\\n'%struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))[:2]).encode()\n"
        " elif command==b'INPUT':\n"
        "  flags=fcntl.fcntl(0,fcntl.F_GETFL)\n"
        "  fcntl.fcntl(0,fcntl.F_SETFL,flags|os.O_NONBLOCK)\n"
        "  try:\n"
        "   try: data=b'INPUT:'+os.read(0,4096)+b'\\n'\n"
        "   except BlockingIOError: data=b'INPUT:EMPTY\\n'\n"
        "  finally: fcntl.fcntl(0,fcntl.F_SETFL,flags)\n"
        " elif command==b'EXIT': os.write(1,b'FINAL\\n'); sys.exit(3)\n"
        " elif command==b'HANG':\n"
        "  for fd in (0,1,2): os.close(fd)\n"
        "  (home/'hanging').touch()\n"
        "  while True: time.sleep(.1)\n"
        " else: data=command\n"
        " def progress(written,writes):\n"
        "  staged=home/('progress'+str(index)+'.tmp')\n"
        "  staged.write_text(json.dumps({'bytes':written,'writes':writes}))\n"
        "  staged.replace(home/('progress'+str(index)))\n"
        " write_payload(data,lambda view:os.write(1,view),progress)\n"
        " (home/('done'+str(index))).touch()\n"
        " index+=1\n")
    shell.chmod(0o700)
    runtime = Path(tempfile.mkdtemp(prefix="t42-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={"SHELL": str(shell), "PATH": "/usr/bin:/bin"})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("emit", cwd=str(tmp_path))
        await wait_until((tmp_path / "ready").exists)
        yield handle, tmp_path
    finally:
        assert handle.teardown() == {}


def publish(home, index, data):
    staged = home / f"pending{index}"
    staged.write_bytes(data)
    staged.replace(home / f"step{index}")


async def emit(home, index, data):
    publish(home, index, data)
    await wait_until((home / f"done{index}").exists)


async def frame(reader):
    return await bounded(ptyhost.read_frame(reader))


async def conditional_wire(handle, body, trailing=b""):
    reader, writer = await bounded(asyncio.open_unix_connection(str(handle.sock)))
    handle.writers.append(writer)
    writer.write(ptyhost.frame(b"C", body) + trailing)
    await bounded(writer.drain())
    kind, payload = await frame(reader)
    assert kind == b"C"
    return json.loads(payload), reader, writer


async def current_created(handle):
    return (await handle.request({"op": "list"}))[0]["created"]


async def test_conditional_attach_matching_input_and_geometry(emitting):
    handle, home = emitting
    created = await current_created(handle)
    reply, reader, writer = await conditional_wire(handle, {
        "op": "attach_if", "name": "emit", "created": created, "rows": 33, "cols": 91})
    assert reply == {"ok": True,
                     "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
                     "replay_geometry": {"rows": 50, "cols": 200}}
    assert await frame(reader) == (b"D", b"")
    await wait_until(lambda: (home / "geometry").read_text() == "33:91")
    writer.write(ptyhost.frame(b"D", b"SELECTED\n"))
    await bounded(writer.drain())
    await emit(home, 0, b"INPUT")
    assert b"INPUT:SELECTED" in await read_until(reader, b"INPUT:SELECTED")
    assert (await handle.request({"op": "list"}))[0]["attached"] == 1


async def test_conditional_attach_replacement_has_no_input_or_resize(emitting):
    handle, home = emitting
    old = await current_created(handle)
    assert await handle.request({"op": "kill_if", "name": "emit", "created": old}) == {"ok": True}
    await wait_until(lambda: _no_emit(handle))
    (home / "ready").unlink(missing_ok=True)
    (home / "geometry").unlink(missing_ok=True)
    await handle.new("emit", cwd=str(home))
    await wait_until((home / "ready").exists)
    await wait_until((home / "geometry").exists)
    assert await current_created(handle) != old
    reply, _, _ = await conditional_wire(handle, {
        "op": "attach_if", "name": "emit", "created": old, "rows": 17, "cols": 71},
        trailing=ptyhost.frame(b"D", b"WRONG-SESSION\n"))
    assert reply == {"ok": False, "outcome": "denied"}
    assert (await handle.request({"op": "list"}))[0]["attached"] == 0
    assert (home / "geometry").read_text() == "50:200"
    reader, _ = await handle.attach("emit")
    await frame(reader)
    await emit(home, 0, b"INPUT")
    output = await read_until(reader, b"INPUT:EMPTY")
    assert b"WRONG-SESSION" not in output


async def _no_emit(handle):
    return "emit" not in await handle.names()


async def test_conditional_attach_kill_requested_refuses_before_geometry(emitting):
    handle, home = emitting
    await wait_until((home / "geometry").exists)
    (home / "ignore_hup").touch()
    await wait_until((home / "hup_ignored").exists)
    created = await current_created(handle)
    assert await handle.request({"op": "kill_if", "name": "emit", "created": created}) == {"ok": True}
    reply, _, _ = await conditional_wire(handle, {
        "op": "attach_if", "name": "emit", "created": created, "rows": 17, "cols": 71})
    assert reply == {"ok": False, "outcome": "denied"}
    assert (await handle.request({"op": "list"}))[0]["attached"] == 0
    assert (home / "geometry").read_text() == "50:200"


async def test_conditional_attach_bound_stream_never_targets_replacement(emitting):
    handle, home = emitting
    created = await current_created(handle)
    reply, reader, writer = await conditional_wire(handle, {
        "op": "attach_if", "name": "emit", "created": created})
    assert reply == {"ok": True,
                     "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
                     "replay_geometry": {"rows": 50, "cols": 200}}
    assert await frame(reader) == (b"D", b"")
    assert await handle.request({"op": "kill_if", "name": "emit", "created": created}) == {"ok": True}
    await wait_until(lambda: _no_emit(handle))
    (home / "ready").unlink(missing_ok=True)
    (home / "geometry").unlink(missing_ok=True)
    await handle.new("emit", cwd=str(home))
    await wait_until((home / "ready").exists)
    await wait_until((home / "geometry").exists)
    assert await current_created(handle) != created
    try:
        writer.write(ptyhost.frame(b"R", {"rows": 17, "cols": 71}) +
                     ptyhost.frame(b"D", b"WRONG-REPLACEMENT\n"))
        await bounded(writer.drain())
    except (BrokenPipeError, ConnectionResetError):
        pass  # The old physical attachment may already have been closed.
    assert (home / "geometry").read_text() == "50:200"
    replacement_reader, _ = await handle.attach("emit")
    await frame(replacement_reader)
    await emit(home, 0, b"INPUT")
    assert b"INPUT:EMPTY" in await read_until(replacement_reader, b"INPUT:EMPTY")
    await wait_until(lambda: (home / "geometry").read_text() == "24:80")


@pytest.mark.parametrize("mutation", [
    "duplicate_op", "duplicate_name", "duplicate_created", "duplicate_rows",
    "duplicate_cols", "unknown_key", "partial_geometry", "bad_cols",
    "bool_rows", "float_rows", "string_created", "bool_created", "infinite_created",
    "rounded_integer_created",
])
async def test_conditional_attach_strict_shape_has_no_geometry_effect(emitting, mutation):
    handle, home = emitting
    await wait_until((home / "geometry").exists)
    created = await current_created(handle)
    fields = {"op": "attach_if", "name": "emit", "created": created, "rows": 19, "cols": 73}
    if mutation.startswith("duplicate_"):
        key = mutation.removeprefix("duplicate_")
        body = json.dumps(fields)[:-1] + "," + json.dumps(key) + ":" + json.dumps(fields[key]) + "}"
    else:
        if mutation == "unknown_key": fields["extra"] = True
        elif mutation == "partial_geometry": fields.pop("cols")
        elif mutation == "bad_cols": fields["cols"] = "invalid"
        elif mutation == "bool_rows": fields["rows"] = True
        elif mutation == "float_rows": fields["rows"] = 19.0
        elif mutation == "string_created": fields["created"] = str(created)
        elif mutation == "bool_created": fields["created"] = True
        elif mutation == "infinite_created": fields["created"] = float("inf")
        elif mutation == "rounded_integer_created": fields["created"] = 2**53 + 1
        body = json.dumps(fields)
    reply, _, _ = await conditional_wire(handle, body.encode(), trailing=ptyhost.frame(b"D", b"DENIED\n"))
    assert reply == {"ok": False, "outcome": "denied"}
    assert (await handle.request({"op": "list"}))[0]["attached"] == 0
    assert (home / "geometry").read_text() == "50:200"


async def drain_until(reader, marker, progress=None):
    # A healthy sink must not become quadratic by scanning the entire retained
    # flood for every frame. Retain just the crossing-marker tail.
    tail = b""
    count = 0
    while marker not in tail:
        kind, payload = await frame(reader)
        assert kind == b"D"
        count += len(payload)
        if progress is not None:
            progress["bytes"] = count
            progress["frames"] += 1
        tail = (tail + payload)[-max(256,len(marker)):]
    return count


async def test_replay_live_fanout_and_detach(emitting):
    handle, home = emitting
    first, w1 = await handle.attach("emit")
    assert await frame(first) == (b"D", b"")
    await emit(home, 0, b"FIRST\n")
    await read_until(first, b"FIRST")
    second, w2 = await handle.attach("emit")
    kind, replay = await frame(second)
    assert kind == b"D" and replay == b"FIRST\r\n"
    await emit(home, 1, b"SECOND\n")
    await read_until(first, b"SECOND")
    await read_until(second, b"SECOND")
    assert (await handle.request({"op": "list"}))[0]["attached"] == 2
    w1.close()
    async def only_second():
        return (await handle.request({"op": "list"}))[0]["attached"] == 1
    await wait_until(only_second)
    await emit(home, 2, b"SURVIVES\n")
    await read_until(second, b"SURVIVES")


async def test_synthetic_command_publication_is_atomic(emitting, monkeypatch):
    handle, home = emitting
    reader, _ = await handle.attach("emit")
    await frame(reader)
    original = Path.write_bytes

    def interrupted_write(path, data):
        if path == home / "step0":
            original(path, data[:5])
            deadline = time.monotonic() + 1
            while not (home / "done0").exists() and time.monotonic() < deadline:
                time.sleep(.005)
            with path.open("ab") as stream:
                stream.write(data[5:])
            return len(data)
        return original(path, data)

    monkeypatch.setattr(Path, "write_bytes", interrupted_write)
    await emit(home, 0, b"FIRST-LAST\n")
    assert await read_until(reader, b"LAST\r\n") == b"FIRST-LAST\r\n"


async def test_final_output_precedes_exit_and_name_reuse(emitting):
    handle, home = emitting
    reader, _ = await handle.attach("emit")
    assert await frame(reader) == (b"D", b"")
    publish(home, 0, b"EXIT")
    output = b""
    while True:
        kind, payload = await frame(reader)
        if kind == b"X":
            assert json.loads(payload) == {"code": 3}
            break
        assert kind == b"D"
        output += payload
    assert output == b"FINAL\r\n"
    assert await bounded(reader.read()) == b""
    await wait_until(lambda: name_absent(handle))
    # Reuse the exact name only after the old attachment has terminated.
    await handle.new("emit", cwd=str(home))


async def name_absent(handle):
    return "emit" not in await handle.names()


async def observe_geometry(home, expected):
    path = home / "geometry"
    await wait_until(lambda: path.exists() and path.read_text() == expected)


@pytest.mark.parametrize("rows,cols,expected", [
    (24, 80, "24:80"),
    (" +3_3 ", 10**9, "33:65535"),
    (-9, False, "2:2"),
])
async def test_initial_attach_applies_coerced_clamped_child_geometry(emitting, rows, cols, expected):
    handle, home = emitting
    await observe_geometry(home, "50:200")
    reader, _ = await handle.attach("emit", rows=rows, cols=cols)
    assert await frame(reader) == (b"D", b"")
    await observe_geometry(home, expected)
    await emit(home, 0, b"SIZE")
    await read_until(reader, f"SIZE:{expected}".encode())
    assert (await handle.request({"op": "list"}))[0]["attached"] == 1


async def test_latest_observed_resize_wins_across_two_clients(emitting):
    handle, home = emitting
    first, w1 = await handle.attach("emit", rows=24, cols=80)
    assert await frame(first) == (b"D", b"")
    await observe_geometry(home, "24:80")
    second, w2 = await handle.attach("emit", rows=0, cols=0)
    assert await frame(second) == (b"D", b"")
    for index, (writer, rows, cols) in enumerate([(w1, 31, 71), (w2, 32, 72), (w1, 33, 73)]):
        writer.write(ptyhost.frame(b"R", {"rows": rows, "cols": cols}))
        await bounded(writer.drain())
        expected = f"{rows}:{cols}"
        # Socket drain is not an acknowledgment: wait for the child's ioctl.
        await observe_geometry(home, expected)
        await emit(home, index, b"SIZE")
        await read_until(first, f"SIZE:{expected}".encode())
        await read_until(second, f"SIZE:{expected}".encode())
        assert (await handle.request({"op": "list"}))[0]["attached"] == 2


@pytest.mark.parametrize("rows,cols,expected", [(0,65535,b"SIZE:2:65535"),(-9,10**9,b"SIZE:2:65535"),("33","77",b"SIZE:33:77"),(" +3_3 ","7_7",b"SIZE:33:77"),(33.9,77.1,b"SIZE:33:77"),(True,False,b"SIZE:2:2")])
async def test_resize_conversion_clamp_and_bad_frames(emitting, rows, cols, expected):
    handle, home = emitting
    reader, writer = await handle.attach("emit", rows=0,cols=0)
    await frame(reader)
    await emit(home,0,b"SIZE")
    await read_until(reader,b"SIZE:50:200")
    writer.write(ptyhost.frame(b"R",{"rows":rows,"cols":cols}))
    await writer.drain()
    # R has no acknowledgment. Observe the synthetic child's ioctl state before
    # asking it to emit SIZE; socket drain is not server-side consumption.
    expected_geometry = expected.removeprefix(b"SIZE:").decode()
    await wait_until(lambda:(home/"geometry").read_text()==expected_geometry)
    await emit(home,1,b"SIZE")
    await read_until(reader,expected)
    for bad in [b"{",b"\xff",b'{"rows":"no","cols":80}',b'{"rows":1e999,"cols":80}',b'{"rows":NaN,"cols":80}',b'{"rows":'+b'['*129+b'0'+b']'*129+b',"cols":80}']:
        writer.write(ptyhost.frame(b"R",bad))
    await writer.drain()
    await emit(home,2,b"SIZE")
    await read_until(reader,expected)


async def test_signal_exit_code_is_negative_and_stream_closes(emitting):
    handle, _ = emitting
    reader, _ = await handle.attach("emit")
    await frame(reader)
    [info] = await handle.request({"op":"list"})
    os.kill(info["pid"],signal.SIGTERM)
    kind,payload = await frame(reader)
    assert kind == b"X" and json.loads(payload) == {"code":-signal.SIGTERM}
    assert await bounded(reader.read()) == b""


async def test_fragmented_handshake_and_unknown_or_invalid_attach(emitting):
    handle, _ = emitting
    for request in [{"op":"attach","name":"missing"},{"op":"attach","name":"emit","rows":"bad","cols":80}]:
        assert "error" in await handle.request(request)
    assert (await handle.request({"op":"list"}))[0]["attached"] == 0
    reader, writer = await bounded(asyncio.open_unix_connection(str(handle.sock)))
    handle.writers.append(writer)
    wire = ptyhost.frame(b"C",{"op":"attach","name":"emit","rows":24,"cols":80})
    for byte in wire:
        writer.write(bytes([byte])); await writer.drain()
    kind,payload = await frame(reader)
    assert kind == b"C" and json.loads(payload) == {
        "ok": True,
        "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
        "replay_geometry": {"rows": 50, "cols": 200},   # the birth size, before this attach's
    }
    assert await frame(reader) == (b"D",b"")


async def test_bounded_parseable_replay_and_slow_client_isolation(emitting):
    handle,home = emitting
    slow,slow_writer = await handle.attach("emit")
    await frame(slow)
    slow._transport.pause_reading()
    healthy,_ = await handle.attach("emit")
    await frame(healthy)
    data = b"\x1b[31mline\n" * (2 * 1024 * 1024) + b"END\n"
    received = {"bytes": 0, "frames": 0}
    drain = asyncio.create_task(drain_until(healthy,b"END",received))
    flood = asyncio.create_task(emit(home,0,data))
    async def status():
        attachment_count = "unavailable"
        other_session_present = "unavailable"
        try:
            sessions = await bounded(handle.request({"op": "list"}))
            attachment_count = next(
                (session["attached"] for session in sessions if session["name"] == "emit"),
                "absent",
            )
            other_session_present = any(session["name"] != "emit" for session in sessions)
        except Exception:
            # Diagnostics must neither hang nor replace the original failure.
            pass
        return {
            "emit_attached": attachment_count,
            "other_session_present": other_session_present,
            "slow_eof": slow.at_eof(),
            "healthy_eof": healthy.at_eof(),
            "flood_done": flood.done(),
            "flood_state": task_category(flood),
            "child_done": (home / "done0").exists(),
            "child_progress": emitter_progress(home, 0),
            "drain_done": drain.done(),
            "drain_state": task_category(drain),
            "healthy_progress": dict(received),
        }
    # Control requests remain bounded while a reader is stalled and the child
    # is actively filling the PTY, not only after the flood has drained.
    assert "emit" in await bounded(handle.names())
    other = home / "control-other"
    other.mkdir(mode=0o700)
    await bounded(handle.new("other",cwd=str(other)))
    assert (await bounded(handle.request({"op":"kill","name":"other"})))["ok"]
    try:
        await flood
        await drain
    except (AssertionError, TimeoutError) as error:
        raise AssertionError(f"flood completion failed: {await status()}") from error
    async def only_healthy():
        return (await handle.request({"op":"list"}))[0]["attached"] == 1
    try:
        await wait_until(only_healthy)
    except AssertionError as error:
        raise AssertionError(f"slow-client isolation failed: {await status()}") from error
    late,_ = await handle.attach("emit")
    kind,replay = await frame(late)
    assert kind==b"D" and 1024*1024 < len(replay) <= 2*1024*1024
    assert replay.startswith(b"\x1b[31m") and replay.endswith(b"END\r\n")
    assert handle.alive()


async def test_attach_atomic_snapshot_has_no_gap_or_duplicate(emitting):
    handle,home = emitting
    healthy,_ = await handle.attach("emit")
    await frame(healthy)
    data = b"".join(f"SEQ{i:05d}\n".encode() for i in range(2000)) + b"END\n"
    publish(home, 0, data)
    reader,_ = await handle.attach("emit")
    async def collect():
        out = b""
        while b"END\r\n" not in out:
            kind,payload = await frame(reader)
            assert kind==b"D"
            out += payload
        return out
    got = await collect()
    assert got == data.replace(b"\n",b"\r\n")
    await drain_until(healthy,b"END")


async def test_pending_replay_finishes_before_final_x(emitting):
    handle,home = emitting
    healthy,_ = await handle.attach("emit")
    await frame(healthy)
    drain = asyncio.create_task(drain_until(healthy,b"END"))
    await emit(home,0,b"line\n" * 500000 + b"END\n")
    await drain
    reader,writer = await bounded(asyncio.open_unix_connection(str(handle.sock)))
    handle.writers.append(writer)
    reader._transport.pause_reading()
    writer.write(ptyhost.frame(b"C",{"op":"attach","name":"emit","rows":0,"cols":0}))
    await writer.drain()
    async def joined():
        return (await handle.request({"op":"list"}))[0]["attached"]==2
    await wait_until(joined)
    [info] = await handle.request({"op":"list"})
    publish(home, 1, b"EXIT")
    # Observe the original child's actual exit, not an arbitrary delay.
    await wait_until(lambda:not Path(f"/proc/{info['pid']}").exists())
    reader._transport.resume_reading()
    kind,payload = await frame(reader)
    assert kind == b"C" and json.loads(payload) == {
        "ok": True,
        "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
        "replay_geometry": {"rows": 24, "cols": 80},   # the first attachment's size
    }
    kind,replay = await frame(reader)
    assert kind==b"D" and replay.endswith(b"END\r\n")
    tail=b""
    while True:
        kind,payload = await frame(reader)
        if kind==b"X":
            assert json.loads(payload)=={"code":3}
            break
        assert kind==b"D"
        tail+=payload
    assert tail==b"FINAL\r\n"
    assert await bounded(reader.read())==b""


async def test_finishing_refuses_fresh_attach_before_x_without_enrollment(emitting):
    handle, home = emitting
    reader, _ = await handle.attach("emit", rows=0, cols=0)
    assert await frame(reader) == (b"D", b"")
    [old] = await handle.request({"op": "list"})
    assert old["attached"] == 1
    publish(home, 0, b"HANG")
    await wait_until((home / "hanging").exists)
    # HANG proves the synthetic child closed its tty but remains alive. X is
    # independently observed; a removed name is never proof of finishing refusal.
    ending = asyncio.create_task(frame(reader))
    deadline = asyncio.get_running_loop().time() + 1.5
    try:
        while True:
            assert not ending.done(), "X arrived before a finishing refusal was observed"
            [before] = await handle.request({"op": "list"})
            assert before["pid"] == old["pid"] and before["attached"] == 1
            fresh, writer = await bounded(asyncio.open_unix_connection(str(handle.sock)))
            handle.writers.append(writer)
            writer.write(ptyhost.frame(b"C", {"op": "attach", "name": "emit", "rows": 0, "cols": 0}))
            await bounded(writer.drain())
            kind, payload = await frame(fresh)
            assert kind == b"C"
            reply = json.loads(payload)
            if "error" in reply:
                assert await bounded(fresh.read()) == b""
                [after] = await handle.request({"op": "list"})
                assert after["pid"] == old["pid"] and after["attached"] == 1
                assert Path(f"/proc/{old['pid']}").exists()
                assert not ending.done(), "refusal only observed after X"
                break
            # The kernel EOF and daemon observation can race. Cleanly detach any
            # probe accepted before finishing rather than accepting it as proof.
            assert reply == {"ok": True,
                             "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"]}
            assert await frame(fresh) == (b"D", b"")
            writer.close()

            async def only_original():
                entries = await handle.request({"op": "list"})
                return len(entries) == 1 and entries[0]["pid"] == old["pid"] and entries[0]["attached"] == 1

            await wait_until(only_original)
            assert asyncio.get_running_loop().time() < deadline, "finishing attach was never refused"
        kind, payload = await ending
        assert kind == b"X" and json.loads(payload) == {"code": None}
        assert await bounded(reader.read()) == b""
        await wait_until(lambda: name_absent(handle))
        # A null result preserves ownership until the real child is reaped.
        assert Path(f"/proc/{old['pid']}").exists()
        os.kill(old["pid"], signal.SIGTERM)
        await wait_until(lambda: not Path(f"/proc/{old['pid']}").exists())
    finally:
        ending.cancel()
        await asyncio.gather(ending, return_exceptions=True)


async def test_null_exit_retains_child_ownership_and_name_incarnation(emitting):
    handle,home = emitting
    reader,_ = await handle.attach("emit")
    await frame(reader)
    [old] = await handle.request({"op":"list"})
    publish(home, 0, b"HANG")
    kind,payload = await frame(reader)
    assert kind==b"X" and json.loads(payload)=={"code":None}
    assert Path(f"/proc/{old['pid']}").exists()
    await wait_until(lambda:name_absent(handle))
    (home/"step0").unlink()
    await handle.new("emit",cwd=str(home))
    [new] = await handle.request({"op":"list"})
    assert new["pid"]!=old["pid"]
    os.kill(old["pid"],signal.SIGTERM)
    await wait_until(lambda:not Path(f"/proc/{old['pid']}").exists())
    assert (await handle.request({"op":"list"}))[0]["pid"]==new["pid"]
    handle.proc.send_signal(signal.SIGTERM)
    await wait_until(lambda:handle.proc.poll() is not None,timeout=5)
    assert handle.proc.returncode==0,handle.stderr()
    assert not Path(f"/proc/{new['pid']}").exists()


@pytest.mark.parametrize("wire",[b"R"+(1<<31).to_bytes(4,"big"),pytest.param(ptyhost.frame(b"?",b""))])
async def test_oversized_or_unknown_attached_frame_only_closes_its_client(emitting,wire):
    handle,home = emitting
    reader,writer = await handle.attach("emit")
    await frame(reader)
    writer.write(wire); await writer.drain()
    assert await bounded(reader.read())==b""
    healthy,_ = await handle.attach("emit")
    await frame(healthy)
    await emit(home,0,b"STILL-LIVE\n")
    await read_until(healthy,b"STILL-LIVE")


def _itf_adapter_path():
    default = Path(__file__).resolve().parents[1]/"ocaml/_build/default/mesh_wire/test/ptyhost_lifecycle_itf.exe"
    binary = Path(os.environ["MESH_ITF_ADAPTER"]) if "MESH_ITF_ADAPTER" in os.environ else default
    assert binary.is_absolute(), "mandatory lifecycle adapter path must be absolute"
    assert binary.is_file() and os.access(binary, os.X_OK), "mandatory lifecycle adapter must be built and executable before candidate gate (scripts/bootstrap.sh without --install-only builds it)"
    return binary


@pytest.mark.parametrize("kind", ["missing", "nonexecutable", "relative"])
def test_explicit_itf_adapter_refuses_invalid_path_without_fallback(monkeypatch, tmp_path, kind):
    adapter = tmp_path/"adapter"
    if kind == "nonexecutable":
        adapter.touch()
    supplied = "relative-adapter" if kind == "relative" else str(adapter)
    monkeypatch.setenv("MESH_ITF_ADAPTER", supplied)
    with pytest.raises(AssertionError):
        _itf_adapter_path()


def test_itf_adapter_default_path_is_unchanged(monkeypatch):
    monkeypatch.delenv("MESH_ITF_ADAPTER", raising=False)
    expected = Path(__file__).resolve().parents[1]/"ocaml/_build/default/mesh_wire/test/ptyhost_lifecycle_itf.exe"
    monkeypatch.setattr(Path, "is_file", lambda self: self == expected)
    monkeypatch.setattr(os, "access", lambda path, mode: path == expected and mode == os.X_OK)
    assert _itf_adapter_path() == expected


def _itf_adapter_or_skip():
    """The adapter, or a skip where it is not built (the python job); the t41 gate requires it.

    ``MESH_REQUIRE_ITF_ADAPTER=1`` (set by scripts/test-ptyhost-t41.sh, which the ``ocaml`` job runs)
    turns the skip into a failure, so the job that builds the adapter can never pass without running it.
    """
    default = Path(__file__).resolve().parents[1]/"ocaml/_build/default/mesh_wire/test/ptyhost_lifecycle_itf.exe"
    if "MESH_ITF_ADAPTER" not in os.environ and not default.exists() and os.environ.get("MESH_REQUIRE_ITF_ADAPTER") != "1":
        pytest.skip(f"lifecycle ITF adapter not built ({default}): scripts/bootstrap.sh builds it; "
                    "set MESH_REQUIRE_ITF_ADAPTER=1 to require it")
    return _itf_adapter_path()


def test_missing_adapter_skips_unless_required(monkeypatch):
    monkeypatch.delenv("MESH_ITF_ADAPTER", raising=False)
    monkeypatch.setattr(Path, "exists", lambda self: False)
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    monkeypatch.delenv("MESH_REQUIRE_ITF_ADAPTER", raising=False)
    with pytest.raises(pytest.skip.Exception):
        _itf_adapter_or_skip()
    monkeypatch.setenv("MESH_REQUIRE_ITF_ADAPTER", "1")
    with pytest.raises(AssertionError):
        _itf_adapter_or_skip()


def test_generated_itf_replay_is_explicit_and_fail_closed(tmp_path):
    binary = _itf_adapter_or_skip()
    # Dune may not stage alias-only fixture deps beside the built executable.
    # Run the fixture from a disposable directory so Alcotest cannot leave
    # `_build/` output inside the source tree.
    source = Path(__file__).resolve().parents[1]/"ocaml/mesh_wire/test"
    for name in ("ptyhost_lifecycle.itf.json", "ptyhost_lifecycle.qnt"):
        (tmp_path/name).symlink_to(source/name)
    cwd = tmp_path
    # This valid executable refuses startup: the replay must fail with it, so a replay that ignored
    # MESH_PTYHOST_CMD (or passed without a host) would be caught.
    refusing = tmp_path/"refusing-host"
    refusing.write_text("#!/bin/sh\nexit 17\n")
    refusing.chmod(0o700)
    env = {**os.environ,"PYTHON":sys.executable,"DUNE_SOURCEROOT":str(Path(__file__).resolve().parents[1]/"ocaml")}
    result = subprocess.run([str(binary)],cwd=cwd,env={**env,"MESH_PTYHOST_CMD":str(refusing)},capture_output=True,text=True,timeout=20)
    assert result.returncode!=0,"the lifecycle replay passed against a host that refuses to start"
    host = ptyhost_command()
    assert len(host)==1 and Path(host[0]).is_absolute()
    result = subprocess.run([str(binary)],cwd=cwd,env={**env,"MESH_PTYHOST_CMD":host[0]},capture_output=True,text=True,timeout=20)
    assert result.returncode==0,result.stdout+result.stderr
