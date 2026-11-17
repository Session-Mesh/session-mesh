# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A FIFO in place of a document does not block the server (R20).

Opening a FIFO for reading blocks until a writer comes, and nothing can cancel
the thread blocked in it. Each test therefore opens the writing end itself after
a deadline: a regression fails within seconds instead of hanging the suite."""

import os
import stat
import threading

import pytest
from aiohttp import web
from test_view_review import descriptor_platform, get, swap_after_authorize  # noqa: F401 (fixture)

import view

DEADLINE = 3     # seconds a non-blocking open never comes near


def release_after_deadline(fifo, done):
    """Unless ``done`` is set within DEADLINE, opens ``fifo``'s writing end so that
    a reader blocked in open returns. The list it returns says whether it had to."""
    released = []

    def run():
        while not done.wait(DEADLINE):
            try:
                os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
            except OSError:          # no reader yet
                continue
            released.append(True)
            return

    threading.Thread(target=run, daemon=True).start()
    return released


def test_opening_a_fifo_returns_at_once(home_dir):
    fifo = home_dir / "pipe.txt"
    os.mkfifo(fifo)
    done = threading.Event()
    released = release_after_deadline(fifo, done)
    try:
        with pytest.raises(web.HTTPException):
            view._open_checked(fifo)
    finally:
        done.set()
    assert not released, "the open blocked until a writer came"


@pytest.mark.usefixtures("descriptor_platform")
async def test_a_fifo_swapped_in_after_the_checks_is_not_served(client, signed_url, home_dir,
                                                                monkeypatch):
    doc = home_dir / "proj" / "page.html"
    doc.parent.mkdir()
    doc.write_text("<p>page</p>")
    url = await signed_url(doc)
    opened = []
    descriptor_servable = view._descriptor_servable
    done = threading.Event()
    releases = []

    def record(fd, path, protected):
        opened.append(stat.S_ISFIFO(os.fstat(fd).st_mode))
        return descriptor_servable(fd, path, protected)

    def swap():
        doc.unlink()
        os.mkfifo(doc)               # same name, not a regular file
        releases.append(release_after_deadline(doc, done))

    monkeypatch.setattr(view, "_descriptor_servable", record)
    swap_after_authorize(monkeypatch, swap)
    try:
        status, _, _ = await get(client, url)
    finally:
        done.set()
    assert releases == [[]], "the open blocked until a writer came"
    assert status == 404
    assert opened == [True]          # the FIFO was opened, and refused by the descriptor check
