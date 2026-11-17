# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The replay buffer is bounded and trimmed at a parseable boundary (protocol).

The unit tests of the trim function are tests/test_ptyhost_trim.py (implementation); this is the
same rule seen only through the socket: output well past 2 MiB, then a late attach.
"""

import pytest

import ptyhost
from helpers import read_next_kind, read_until
from ptyhost_proc import daemon  # noqa: F401  (daemon is a fixture)

REPLAY_BYTES = 2 * 1024 * 1024
# Each of the 300000 lines is "ESC[31m<n>\r\n": about 4 MiB in all, so the trim must cut.
EMIT = "seq 1 300000 | sed 's/^/\\x1b[31m/'; printf 'EN''D\\n'\r"


async def test_a_late_attach_gets_a_bounded_replay_that_starts_on_a_line_boundary(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("flood")
    reader, writer = await daemon.attach("flood")
    writer.write(ptyhost.frame(b"D", EMIT.encode()))
    await read_until(reader, b"END", timeout=30)

    late_reader, _ = await daemon.attach("flood")
    _, replay = await read_next_kind(late_reader, {b"D"})
    assert len(replay) <= REPLAY_BYTES
    assert len(replay) > REPLAY_BYTES // 2            # trimmed, not dropped
    assert replay.startswith(b"\x1b[31m"), replay[:40]    # whole line: never inside an escape sequence
    assert b"END" in replay                           # the newest output is kept
