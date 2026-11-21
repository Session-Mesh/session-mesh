# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""ptyhost input queue and exit reaping, black-box against a ptyhost subprocess (protocol).

Every wait is bounded; timing bounds are generous and compare against the old
code's behaviour (a loop frozen for good, or blocked ~2 s), not tight latencies.
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path

import pytest

import ptyhost
from helpers import read_next_kind, read_until
from ptyhost_proc import daemon, proc_state, wait_until  # noqa: F401  (daemon is a fixture)

pytestmark = [pytest.mark.ptyhost_t43,
              pytest.mark.usefixtures("plain_transport_shell")]

MIB = 1024 * 1024
RAW = "stty raw -echo -iexten"   # -iexten: no ^V/^O processing, so every byte is data


async def gone(daemon, name):
    return name not in await daemon.names()


async def send_input(writer, data, drain_timeout=5.0):
    """Write one D frame; a stalled socket is tolerated (it is the M1 symptom, asserted elsewhere)."""
    writer.write(ptyhost.frame(b"D", data))
    try:
        await asyncio.wait_for(writer.drain(), drain_timeout)
    except asyncio.TimeoutError:
        pass


def work_dir():
    return Path(tempfile.mkdtemp(prefix="w-", dir=os.environ["HOME"]))


async def file_settles(path, expected_size, timeout=15.0):
    await wait_until(lambda: path.exists() and path.stat().st_size >= expected_size, timeout)
    await asyncio.sleep(0.3)          # nothing more may arrive after the expected bytes
    return path.read_bytes()


async def test_subprocess_harness_new_list_kill(daemon):
    await daemon.new("smoke")
    assert await daemon.names() == ["smoke"]
    assert await daemon.request({"op": "kill", "name": "smoke"}) == {"ok": True}
    await wait_until(lambda: gone(daemon, "smoke"), timeout=5)


# ---------------------------------------------------------------- input queue (M1)

async def test_other_sessions_stay_live_during_a_stuck_paste(daemon):
    _, stuck = await daemon.raw_idle_session("stuck")
    await daemon.new("other")
    other_reader, other_writer = await daemon.attach("other")
    other_writer.write(ptyhost.frame(b"D", b"printf 'PRO''MPT\\n'\r"))
    await read_until(other_reader, b"PROMPT")

    await send_input(stuck, b"x" * MIB)
    await asyncio.sleep(0.5)
    other_writer.write(ptyhost.frame(b"D", b"echo ok-'B'\r"))
    await read_until(other_reader, b"ok-B", timeout=2)


async def test_kill_still_works_during_a_stuck_paste(daemon):
    _, stuck = await daemon.raw_idle_session("stuck")
    await send_input(stuck, b"x" * MIB)
    await asyncio.sleep(0.5)
    assert await daemon.request({"op": "kill", "name": "stuck"}, timeout=1) == {"ok": True}
    await wait_until(lambda: gone(daemon, "stuck"), timeout=3)


async def test_queued_input_is_delivered_whole_and_in_order(daemon):
    cwd = work_dir()
    await daemon.new("fidelity", cwd=str(cwd))
    reader, writer = await daemon.attach("fidelity")
    writer.write(ptyhost.frame(b"D", f"{RAW}; printf 'RE''ADY\\n'; head -c {3 * MIB} > out.bin; "
                                     f"printf 'DO''NE\\n'\r".encode()))
    await read_until(reader, b"READY", timeout=15)
    payload = os.urandom(3 * MIB)
    for i in range(3):
        await send_input(writer, payload[i * MIB:(i + 1) * MIB], drain_timeout=10)
    await read_until(reader, b"DONE", timeout=20)
    assert (cwd / "out.bin").read_bytes() == payload


async def test_overflow_drops_whole_frames_only_and_logs_once(daemon):
    cwd = work_dir()
    await daemon.new("overflow", cwd=str(cwd))
    reader, writer = await daemon.attach("overflow")
    writer.write(ptyhost.frame(b"D", f"{RAW}; printf 'RE''ADY\\n'; "
                                     f"while [ ! -e go ]; do sleep 0.1; done; cat > out.bin\r".encode()))
    await read_until(reader, b"READY", timeout=15)
    frame_a, frame_b, frame_c = os.urandom(6 * MIB), os.urandom(3 * MIB), os.urandom(1024)
    await send_input(writer, frame_a, drain_timeout=10)
    await send_input(writer, frame_b, drain_timeout=10)    # 6 + 3 MiB > WRITE_CAP: dropped
    await send_input(writer, frame_b, drain_timeout=10)    # same episode: dropped, not re-logged
    (cwd / "go").touch()
    assert await file_settles(cwd / "out.bin", len(frame_a)) == frame_a
    await send_input(writer, frame_c)
    assert await file_settles(cwd / "out.bin", len(frame_a) + len(frame_c)) == frame_a + frame_c
    assert await daemon.names() == ["overflow"]
    drops = [line for line in daemon.stderr().splitlines() if "input dropped" in line]
    assert len(drops) == 1, daemon.stderr()
    assert "overflow" in drops[0]


async def test_input_overflow_log_rearms_after_the_queue_drains(daemon):
    cwd = work_dir()
    await daemon.new("rearm", cwd=str(cwd))
    reader, writer = await daemon.attach("rearm")
    writer.write(ptyhost.frame(
        b"D", f"{RAW}; printf 'RE''ADY\\n'; "
        "while [ ! -e go1 ]; do sleep 0.1; done; "
        f"head -c {6 * MIB} > first.bin; touch ready2; "
        "while [ ! -e go2 ]; do sleep 0.1; done; "
        f"head -c {6 * MIB} > second.bin; printf 'DO''NE\\n'\r".encode()))
    await read_until(reader, b"READY", timeout=15)
    first, second = os.urandom(6 * MIB), os.urandom(6 * MIB)
    overflow = os.urandom(3 * MIB)
    await send_input(writer, first, drain_timeout=10)
    await send_input(writer, overflow, drain_timeout=10)
    (cwd / "go1").touch()
    assert await file_settles(cwd / "first.bin", len(first)) == first
    await wait_until((cwd / "ready2").exists)
    await send_input(writer, second, drain_timeout=10)
    await send_input(writer, overflow, drain_timeout=10)
    (cwd / "go2").touch()
    assert await file_settles(cwd / "second.bin", len(second)) == second
    await read_until(reader, b"DONE", timeout=15)
    drops = [line for line in daemon.stderr().splitlines() if "input dropped" in line]
    assert len(drops) == 2, daemon.stderr()


async def test_input_to_an_exited_program_is_harmless(daemon):
    await daemon.new("leaver")
    # The exit is read on a connection that writes nothing: the one that floods the input can find the host's end
    # closed in the middle of a write, and that broken pipe ends its own connection before its exit frame is read.
    reader, _ = await daemon.attach("leaver")
    _, writer = await daemon.attach("leaver")
    writer.write(ptyhost.frame(b"D", b"exit 0\r"))
    for _ in range(64):
        writer.write(ptyhost.frame(b"D", b"y" * 65536))
    kind, payload = await read_next_kind(reader, {b"X"})
    assert json.loads(payload) == {"code": 0}
    await wait_until(lambda: gone(daemon, "leaver"), timeout=5)
    assert daemon.alive()
    assert await daemon.names() == []
    assert "Traceback" not in daemon.stderr()


async def test_new_with_a_command_types_it(daemon):
    await daemon.new("typed", command="echo typed-$((1+1))")
    reader, _ = await daemon.attach("typed")
    await read_until(reader, b"typed-2", timeout=12)


# ---------------------------------------------------------------- exit reaping (M2)

async def at_prompt(daemon, name):
    """A fresh session whose shell has read input once; returns (reader, writer, shell pid)."""
    await daemon.new(name)
    [info] = [s for s in await daemon.request({"op": "list"}) if s["name"] == name]
    reader, writer = await daemon.attach(name)
    writer.write(ptyhost.frame(b"D", b"printf 'PRO''MPT\\n'\r"))
    await read_until(reader, b"PROMPT")
    return reader, writer, info["pid"]


async def list_latencies(daemon, duration, interval=0.2):
    loop = asyncio.get_running_loop()
    latencies, end = [], loop.time() + duration
    while loop.time() < end:
        start = loop.time()
        await daemon.request({"op": "list"})
        latencies.append(loop.time() - start)
        await asyncio.sleep(interval)
    return latencies


async def test_slow_exit_keeps_the_loop_live_and_leaves_no_zombie(daemon):
    """Master EOF while the session pid lives on (no slave fd held): the old code blocked ~2 s."""
    reader, writer, pid = await at_prompt(daemon, "slow")
    loop = asyncio.get_running_loop()
    writer.write(ptyhost.frame(b"D", b"exec sh -c 'exec </dev/null >/dev/null 2>&1; sleep 4'\r"))
    eof_at = loop.time()
    exit_frame = asyncio.ensure_future(read_next_kind(reader, {b"X"}, timeout=6))

    latencies = await list_latencies(daemon, 2.4)
    assert len(latencies) >= 8 and max(latencies) < 0.3, latencies

    _, payload = await exit_frame
    x_at = loop.time() - eof_at
    assert json.loads(payload) == {"code": None}
    assert 1.8 <= x_at <= 3.0, x_at
    assert "slow" not in await daemon.names()

    await wait_until(lambda: proc_state(pid) is None, timeout=8)   # reaped, not a zombie


async def test_normal_exit_is_prompt_and_frees_the_name(daemon):
    reader, writer, _ = await at_prompt(daemon, "quick")
    loop = asyncio.get_running_loop()
    writer.write(ptyhost.frame(b"D", b"exit 3\r"))
    start = loop.time()
    _, payload = await read_next_kind(reader, {b"X"}, timeout=5)
    assert loop.time() - start < 1.0
    assert json.loads(payload) == {"code": 3}
    await daemon.new("quick")
