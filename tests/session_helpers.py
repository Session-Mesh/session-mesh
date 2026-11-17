# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Shared by the session-document tests: a fake ptyhost `list`, minted tokens, a clean OPENS.

Import the fixtures by name:  from session_helpers import listing, clean_opens  # noqa: F401
"""

import pytest

import opens
import ptyhost
import sessiontoken

NONCE = "0123456789abcdef0123456789abcdef"
OTHER_NONCE = "fedcba9876543210fedcba9876543210"


@pytest.fixture(autouse=True)
def clean_opens():
    opens.OPENS.clear()
    opens._BOARD_OPEN_IDENTITIES.clear()
    yield
    opens.OPENS.clear()
    opens._BOARD_OPEN_IDENTITIES.clear()


class Listing(list):
    """The fake ptyhost's session records; ``state`` says whether it is down and what it was asked."""
    state = None


@pytest.fixture
def listing(monkeypatch):
    """A fake ptyhost whose `list` reply is this (mutable) list of session records."""
    sessions = Listing()
    state = {"down": False, "requests": [], "created": 0}

    async def fake_request(req):
        state["requests"].append(req)
        if state["down"]:
            raise ConnectionRefusedError()
        if req.get("op") == "cancel_submit":   # sent after a turn that follows a finished one
            return {"ok": True, "cancelled": False}
        assert req == {"op": "list"}, req
        return list(sessions)

    monkeypatch.setattr(ptyhost, "request", fake_request)
    sessions.state = state
    return sessions


def add_session(sessions, name, nonce=NONCE):
    """List a session and return the headers of the request its shell would make."""
    sessions.state["created"] += 1
    sessions.append({"name": name, "cwd": "/", "created": float(sessions.state["created"]),
                     "meta": {"agent": None, "nonce": nonce}})
    return {"Authorization": "MeshSession " + sessiontoken.issue(name, nonce)}
