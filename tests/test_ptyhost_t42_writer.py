# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Exact generated-emitter controls, without running the large flood."""
import asyncio
import json

import pytest

import test_ptyhost_t42 as fixture
from ptyhost_proc import bounded, wait_until
from test_ptyhost_t42 import emitting  # noqa: F401

pytestmark = [pytest.mark.ptyhost_t42]


async def writer_binding_case(emitting, *, shared=False):
    handle, home = emitting
    primary = (await handle.request({"op": "list"}))[0]
    hold = home / f"hold-{primary['pid']}"
    hold.touch()
    waiter = None
    try:
        await wait_until((home / f"parked-{primary['pid']}").exists)
        other = home if shared else home / "other"
        if other != home:
            other.mkdir(mode=0o700)
        await handle.new("other", cwd=str(other))
        await wait_until((other / "ready").exists)
        other_reader, _ = await handle.attach("other")
        await fixture.frame(other_reader)
        primary_reader, _ = await handle.attach("emit")
        await fixture.frame(primary_reader)
        waiter = asyncio.create_task(wait_until((home / "done0").exists))
        await fixture.emit(other, 0, b"OTHER\x00\xff\n")
        assert await fixture.read_until(other_reader, b"OTHER\x00\xff\r\n") == b"OTHER\x00\xff\r\n"
        assert not (home / "done0").exists(), "unrelated writer completed primary"
        assert not (home / "step0").exists()
        assert not waiter.done()
        fixture.publish(home, 0, b"PRIMARY\x00\xfe\n")
        hold.unlink()
        await waiter
        assert await fixture.read_until(primary_reader, b"PRIMARY\x00\xfe\r\n") == b"PRIMARY\x00\xfe\r\n"
    finally:
        hold.unlink(missing_ok=True)
        if waiter is not None:
            if not waiter.done():
                waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)


async def test_unrelated_writer_cannot_complete_primary(emitting):
    await writer_binding_case(emitting)


async def test_shared_root_counterproof_has_wrong_writer_completion(emitting):
    with pytest.raises(AssertionError, match="unrelated writer completed primary"):
        await writer_binding_case(emitting, shared=True)


async def test_actual_progress_failure_cannot_publish_completion(emitting):
    handle, home = emitting
    reader, _ = await handle.attach("emit")
    await fixture.frame(reader)
    # Exact owned path deliberately prevents atomic numeric progress publication.
    (home / "progress0.tmp").mkdir(mode=0o700)
    fixture.publish(home, 0, b"PROGRESS-FAULT\n")
    async def ending():
        while True:
            kind, payload = await fixture.frame(reader)
            if kind == b"X":
                return json.loads(payload)
            assert kind == b"D"
    assert await bounded(ending()) == {"code": 1}
    assert not (home / "done0").exists()
    assert fixture.emitter_progress(home, 0) == "unavailable"


def generated_writer():
    namespace = {}
    exec(fixture.WRITER_SOURCE, namespace)
    return namespace["write_payload"]


def test_generated_writer_exact_partial_binary_output():
    write_payload = generated_writer()
    data = b"\x00\xffA\x80\nEND\x00" * 7
    received = bytearray()
    progress = []
    sizes = iter([1, 2, 5, 1, 3, 7, 2])
    def write(view):
        assert isinstance(view, memoryview)
        assert view.obj is data
        count = min(next(sizes, 4), len(view))
        received.extend(view[:count])
        return count
    written, calls = write_payload(data, write, lambda b, n: progress.append((b, n)))
    assert bytes(received) == data
    assert written == len(data)
    assert calls > 1
    assert progress[-1] == (len(data), calls)
    assert all(a[0] <= b[0] and a[1] < b[1] for a, b in zip(progress, progress[1:]))


@pytest.mark.parametrize("result", [0, -1, 9, True])
def test_generated_writer_refuses_invalid_write_result(result):
    with pytest.raises(ValueError, match="^invalid emitter write result$"):
        generated_writer()(b"x", lambda _: result, lambda *_: None)


@pytest.mark.parametrize("fault", [OSError("private write"), RuntimeError("programmer"), KeyboardInterrupt(), MemoryError()])
def test_generated_writer_preserves_fault(fault):
    def write(_):
        raise fault
    with pytest.raises(type(fault)) as observed:
        generated_writer()(b"x", write, lambda *_: None)
    assert observed.value is fault


def test_task_categories_distinguish_failed_completion():
    async def exercise():
        pending = asyncio.create_task(asyncio.Event().wait())
        success = asyncio.create_task(asyncio.sleep(0))
        async def fail():
            raise ValueError("private payload")
        failure = asyncio.create_task(fail())
        await asyncio.gather(success, failure, return_exceptions=True)
        assert fixture.task_category(pending) == "pending"
        assert fixture.task_category(success) == "succeeded"
        assert fixture.task_category(failure) == "failed"
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        assert fixture.task_category(pending) == "cancelled"
    asyncio.run(exercise())


def test_progress_unavailable_is_not_zero(tmp_path):
    assert fixture.emitter_progress(tmp_path, 0) == "unavailable"
    (tmp_path / "progress0").write_text(json.dumps({"bytes": 0, "writes": 0}))
    assert fixture.emitter_progress(tmp_path, 0) == {"bytes": 0, "writes": 0}


@pytest.mark.parametrize("record", [
    b"not json", b"\xff", b"x" * 129,
    b'{"bytes":1,"writes":0}', b'{"bytes":1,"writes":2}',
    b'{"bytes":true,"writes":0}', b'{"bytes":-1,"writes":0}',
    b'{"bytes":0,"writes":0,"payload":"private"}',
])
def test_progress_rejects_untrusted_or_inconsistent_records(tmp_path, record):
    (tmp_path / "progress0").write_bytes(record)
    assert fixture.emitter_progress(tmp_path, 0) == "unavailable"


def test_generated_writer_progress_is_coarse_and_final():
    data = b"x" * (2 * 1024 * 1024 + 7)
    progress = []
    received = bytearray()
    def write(view):
        count = min(65536, len(view))
        received.extend(view[:count])
        return count
    written, writes = generated_writer()(data, write, lambda b, n: progress.append((b, n)))
    assert bytes(received) == data
    assert written == len(data) and writes == 33
    assert progress == [(1024 * 1024, 16), (2 * 1024 * 1024, 32), (len(data), 33)]
    progress.clear()
    assert generated_writer()(b"", write, lambda b, n: progress.append((b, n))) == (0, 0)
    assert progress == [(0, 0)]


def test_progress_failure_prevents_false_completion():
    fault = OSError("private progress sink")
    def progress(*_):
        raise fault
    with pytest.raises(OSError) as observed:
        generated_writer()(b"x", lambda view: len(view), progress)
    assert observed.value is fault
