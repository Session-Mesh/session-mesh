# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import json

import ptyhost
import server


def test_browser_control_accepts_only_strict_resize_and_human_lease_messages():
    assert server.browser_control_frame(json.dumps({"t": "r", "rows": 42, "cols": 120})) == \
        ptyhost.frame(b"R", {"rows": 42, "cols": 120})
    dirty = json.dumps({"t": "h", "client_id": "browser_tab_0001", "dirty": True})
    clean = json.dumps({"t": "h", "client_id": "browser_tab_0001", "dirty": False})
    assert server.browser_control_frame(dirty) == \
        ptyhost.frame(b"H", {"client_id": "browser_tab_0001", "dirty": True})
    assert server.browser_control_frame(clean) == \
        ptyhost.frame(b"H", {"client_id": "browser_tab_0001", "dirty": False})
    assert not server.releases_human_input(dirty)
    assert server.releases_human_input(clean)

    invalid = [
        "not-json",
        json.dumps({"t": "h", "client_id": "short", "dirty": False}),
        json.dumps({"t": "h", "client_id": "browser_tab_0001", "dirty": 0}),
        json.dumps({"t": "h", "client_id": "browser_tab_0001", "dirty": False, "extra": 1}),
        json.dumps({"t": "r", "rows": 42, "cols": 120, "extra": 1}),
    ]
    assert all(server.browser_control_frame(value) is None for value in invalid)
    assert all(not server.releases_human_input(value) for value in invalid)


def test_human_lease_capability_is_bound_to_the_attach_reply():
    assert server.attach_supports(
        {"ok": True, "pty_capabilities": ["human_input_lease_v1"]},
        "human_input_lease_v1")
    assert not server.attach_supports({"ok": True}, "human_input_lease_v1")
    assert not server.attach_supports(
        {"ok": True, "pty_capabilities": ["human_input_lease_v1", "human_input_lease_v1"]},
        "human_input_lease_v1")
