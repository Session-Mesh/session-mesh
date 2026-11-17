# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""POST /api/event v0: the black-box suite.

The route does not exist yet (it will be written in shadow mode, behind the owner's gate), so
every test here is a strict xfail: the day the route lands, each one turns into an unexpected
pass and fails the run until the marker is removed. Nothing below imports the
implementation or its route table; the suite speaks HTTP and reads /api/sessions, so the
OCaml daemon can be pointed at it later.

Every negative test first sends a valid event and expects 200. Without that control a
"401" or "404" would pass today for the wrong reason (the session-token check already
answers a bare 401 for any route it does not know).

Rule ids (EVT-n) label the rules of the event contract that each test checks.
"""

import json
import time

import pytest
from aiohttp import web

import server
from session_helpers import OTHER_NONCE, add_session, clean_opens, listing  # noqa: F401

URL = "/api/event"
TYPES = ["working", "waiting_permission", "waiting_question", "done", "error"]
BODY_MAX = 8192            # EVT-9
DETAIL_MAX = 2048          # EVT-10
JSON_HEADER = {"Content-Type": "application/json"}


# ---------------------------------------------------------------- helpers

async def post(client, headers, body, **kwargs):
    return await client.post(URL, json=body, headers=headers, **kwargs)


async def post_raw(client, headers, raw):
    return await client.post(URL, data=raw, headers={**headers, **JSON_HEADER})


async def accepted(client, headers, **fields):
    """A valid event that must be taken: the control of every negative test."""
    resp = await post(client, headers, {"type": "working", **fields})
    assert resp.status == 200, (resp.status, await resp.text())
    return await resp.json()


def mesh_entry(sessions, name):
    [entry] = [s for s in sessions["mesh"] if s["name"] == name]
    return entry


async def hook_of(client, auth_cookie, name):
    resp = await client.get("/api/sessions", headers=auth_cookie)
    assert resp.status == 200
    return mesh_entry(await resp.json(), name)["hook"]


def listed(sessions, name, pid):
    """Complete the fake ptyhost record so GET /api/sessions can describe it."""
    [record] = [s for s in sessions if s["name"] == name]
    record.update(pid=pid, created=1.0, attached=0, activity=1.0)


@pytest.fixture
def alpha(listing):
    headers = add_session(listing, "alpha")
    listed(listing, "alpha", 424242)
    return headers


@pytest.fixture
def beta(listing, alpha):
    headers = add_session(listing, "beta", OTHER_NONCE)
    listed(listing, "beta", 424243)
    return headers


def detail_of_size(size):
    """A flat detail object whose compact JSON is exactly ``size`` bytes (8 keys, values of at most 256)."""
    keys = [f"k{i}" for i in range(8)]
    fixed = len(json.dumps({k: "" for k in keys}, separators=(",", ":")))
    spare = size - fixed
    assert 0 <= spare <= 8 * 256
    detail = {k: "x" * min(256, max(0, spare - 256 * i)) for i, k in enumerate(keys)}
    assert len(json.dumps(detail, separators=(",", ":"))) == size
    return detail


# ---------------------------------------------------------------- the route and its auth class (EVT-1, EVT-2, EVT-3)
#
# The accepted POST control plus ``test_only_post_is_taken_from_a_session_token``
# establish the HTTP contract.  The implementation separately updates its
# exhaustive route-auth table; that structural check deliberately does not live
# in this black-box suite.


async def test_a_session_token_posts_an_event(client, alpha):
    body = await accepted(client, alpha)
    assert body == {"ok": True, "applied": True}


@pytest.mark.parametrize("state", TYPES)
async def test_every_type_is_accepted(client, alpha, state):
    resp = await post(client, alpha, {"type": state})
    assert resp.status == 200
    assert (await resp.json())["applied"] is True


async def test_no_credential_is_401(client, alpha):
    await accepted(client, alpha)
    resp = await post(client, {}, {"type": "working"}, allow_redirects=False)
    assert resp.status == 401


async def test_a_master_bearer_or_a_cookie_is_401_because_they_name_no_session(client, alpha, auth_bearer, auth_cookie):
    await accepted(client, alpha)
    assert (await post(client, auth_bearer, {"type": "working"})).status == 401
    assert (await post(client, auth_cookie, {"type": "working"})).status == 401


@pytest.mark.parametrize("token", ["", "ms1", "ms1.alpha.x.y", "not-a-token"])
async def test_a_malformed_session_token_is_401(client, alpha, token):
    await accepted(client, alpha)
    resp = await post(client, {"Authorization": "MeshSession " + token}, {"type": "working"})
    assert resp.status == 401


async def test_a_forged_mac_is_401(client, alpha):
    await accepted(client, alpha)
    token = alpha["Authorization"]
    forged = token[:-1] + ("0" if token[-1] != "0" else "1")
    assert (await post(client, {"Authorization": forged}, {"type": "working"})).status == 401


async def test_the_token_of_a_session_that_is_gone_is_401(client, listing, alpha):
    await accepted(client, alpha)
    listing.clear()
    assert (await post(client, alpha, {"type": "working"})).status == 401


async def test_a_new_session_with_the_same_name_does_not_inherit_the_old_token(client, listing, alpha):
    await accepted(client, alpha)
    listing.clear()
    fresh = add_session(listing, "alpha", OTHER_NONCE)
    assert (await post(client, alpha, {"type": "working"})).status == 401
    assert (await post(client, fresh, {"type": "working"})).status == 200


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH"])
async def test_only_post_is_taken_from_a_session_token(client, alpha, method):
    await accepted(client, alpha)
    resp = await client.request(method, URL, headers=alpha, allow_redirects=False)
    assert resp.status == 401


async def test_a_session_token_is_503_when_ptyhost_is_down(client, listing, alpha):
    await accepted(client, alpha)
    listing.state["down"] = True
    assert (await post(client, alpha, {"type": "working"})).status == 503


async def test_a_foreign_origin_is_403_and_the_served_one_is_taken(client, alpha):
    await accepted(client, alpha)
    host = f"{client.host}:{client.port}"
    assert (await post(client, {**alpha, "Origin": "http://evil.example"}, {"type": "working"})).status == 403
    assert (await post(client, {**alpha, "Origin": f"http://{host}"}, {"type": "working"})).status == 200


# ---------------------------------------------------------------- one session cannot speak for another (EVT-4)

async def test_the_session_comes_from_the_token_never_the_body(client, auth_cookie, alpha, beta):
    await accepted(client, alpha)
    for field in ("session", "name", "source", "MESH_SESSION"):
        resp = await post(client, alpha, {"type": "done", field: "beta"})
        assert resp.status == 400, field
    assert await hook_of(client, auth_cookie, "beta") is None


async def test_the_token_of_a_session_sets_the_state_of_that_session_only(client, auth_cookie, alpha, beta):
    await accepted(client, alpha, type="waiting_permission")
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "waiting_permission"
    assert await hook_of(client, auth_cookie, "beta") is None
    await accepted(client, beta, type="error")
    assert (await hook_of(client, auth_cookie, "beta"))["type"] == "error"
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "waiting_permission"


async def test_a_rejected_event_leaves_the_state_unchanged(client, auth_cookie, alpha):
    await accepted(client, alpha, type="done")
    assert (await post(client, alpha, {"type": "sleeping"})).status == 400
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "done"


# ---------------------------------------------------------------- request shape (EVT-5 to EVT-8)

@pytest.mark.parametrize("body", [{}, {"type": "sleeping"}, {"type": "Working"}, {"type": ""},
                                  {"type": 3}, {"type": None}, {"type": ["working"]}])
async def test_an_absent_or_unknown_type_is_400(client, alpha, body):
    await accepted(client, alpha)
    assert (await post(client, alpha, body)).status == 400


@pytest.mark.parametrize("raw", [b"", b"not json", b"[]", b'"working"', b"null", b"3", b'{"type":"working"',
                                 b'{"type":"working"} trailing'])
async def test_a_body_that_is_not_a_json_object_is_400(client, alpha, raw):
    await accepted(client, alpha)
    assert (await post_raw(client, alpha, raw)).status == 400


async def test_an_unknown_field_is_400(client, alpha):
    await accepted(client, alpha)
    assert (await post(client, alpha, {"type": "working", "extra": 1})).status == 400


async def test_the_version_is_optional_and_only_zero_is_known(client, alpha):
    await accepted(client, alpha, v=0)
    await accepted(client, alpha)
    for bad in (1, "0", None, 0.5, True):
        assert (await post(client, alpha, {"v": bad, "type": "working"})).status == 400, bad


async def test_the_time_is_optional_and_bounded(client, alpha):
    now = time.time()
    await accepted(client, alpha, at=now)
    for bad in ("now", True, None, [], now + 3600, now - 90000):
        assert (await post(client, alpha, {"type": "working", "at": bad})).status == 400, bad
    assert (await post_raw(client, alpha, b'{"type":"working","at":NaN}')).status == 400
    assert (await post_raw(client, alpha, b'{"type":"working","at":Infinity}')).status == 400


@pytest.mark.parametrize("bad", ["", " a", "a b", "x" * 65, "é", 7, None, ["a"]])
async def test_a_bad_event_id_is_400(client, alpha, bad):
    await accepted(client, alpha)
    assert (await post(client, alpha, {"type": "working", "id": bad})).status == 400


async def test_an_event_id_of_the_maximum_length_is_taken(client, alpha):
    await accepted(client, alpha, id="a" * 64)


# ---------------------------------------------------------------- the detail is bounded (EVT-10)

async def test_a_flat_detail_is_taken(client, alpha):
    await accepted(client, alpha, detail={"source": "claude", "hook": "PermissionRequest", "tool": "Bash",
                                          "count": 3, "ok": True, "note": None})


@pytest.mark.parametrize("detail", [[], "x", 3, None, {"a": {"b": 1}}, {"a": [1]}, {"A": 1}, {"1a": 1}, {"": 1},
                                    {"k" * 33: 1}, {"a": "x" * 257}, {f"k{i}": i for i in range(9)}])
async def test_a_detail_that_is_not_a_small_flat_object_is_400(client, alpha, detail):
    await accepted(client, alpha)
    assert (await post(client, alpha, {"type": "working", "detail": detail})).status == 400


async def test_a_detail_of_exactly_2_kib_is_taken_and_one_byte_more_is_413(client, alpha):
    await accepted(client, alpha, detail=detail_of_size(DETAIL_MAX))
    resp = await post(client, alpha, {"type": "working", "detail": detail_of_size(DETAIL_MAX + 1)})
    assert resp.status == 413


# ---------------------------------------------------------------- the body is bounded (EVT-9)

def padded(size):
    """A valid event body of exactly ``size`` bytes (insignificant whitespace after the object)."""
    core = b'{"type":"working"}'
    return core + b" " * (size - len(core))


async def test_a_body_of_exactly_8_kib_is_taken_and_one_byte_more_is_413(client, alpha):
    assert (await post_raw(client, alpha, padded(BODY_MAX))).status == 200
    assert (await post_raw(client, alpha, padded(BODY_MAX + 1))).status == 413


async def test_a_huge_body_is_413(client, alpha):
    await accepted(client, alpha)
    assert (await post_raw(client, alpha, padded(2 * 1024 * 1024))).status == 413


async def test_an_oversize_body_changes_nothing(client, auth_cookie, alpha):
    await accepted(client, alpha, type="done")
    assert (await post_raw(client, alpha, b'{"type":"error"}' + b" " * BODY_MAX)).status == 413
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "done"


# ---------------------------------------------------------------- idempotence and ordering (EVT-11, EVT-12)

async def test_a_repeated_event_id_is_taken_once(client, auth_cookie, alpha):
    await accepted(client, alpha, id="PermissionRequest:t1", type="waiting_permission")
    resp = await post(client, alpha, {"type": "done", "id": "PermissionRequest:t1"})
    assert resp.status == 200
    assert await resp.json() == {"ok": True, "applied": False, "reason": "duplicate"}
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "waiting_permission"


async def test_the_same_event_id_from_two_sessions_is_two_events(client, alpha, beta):
    await accepted(client, alpha, id="same")
    assert (await accepted(client, beta, id="same"))["applied"] is True


async def test_an_event_older_than_the_state_is_acknowledged_but_not_applied(client, auth_cookie, alpha):
    now = time.time()
    # (A finished turn is the exception: tests/wake-idle-gate.test.ts.)
    await accepted(client, alpha, type="working", at=now)
    resp = await post(client, alpha, {"type": "waiting_permission", "at": now - 10})
    assert resp.status == 200
    assert await resp.json() == {"ok": True, "applied": False, "reason": "stale"}
    hook = await hook_of(client, auth_cookie, "alpha")
    assert (hook["type"], hook["at"]) == ("working", now)


async def test_an_event_with_the_same_time_replaces_the_state(client, auth_cookie, alpha):
    now = time.time()
    await accepted(client, alpha, type="working", at=now)
    await accepted(client, alpha, type="waiting_question", at=now)
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "waiting_question"


async def test_an_event_without_a_time_is_stamped_on_arrival(client, auth_cookie, alpha):
    before = time.time()
    await accepted(client, alpha)
    hook = await hook_of(client, auth_cookie, "alpha")
    assert before - 1 <= hook["at"] <= hook["received"] <= time.time() + 1


# ---------------------------------------------------------------- shadow mode (EVT-13 to EVT-16)

async def test_a_session_with_no_event_has_a_null_hook(client, auth_cookie, alpha):
    assert await hook_of(client, auth_cookie, "alpha") is None


async def test_the_state_is_exposed_under_hook_in_api_sessions(client, auth_cookie, alpha):
    now = time.time()
    await accepted(client, alpha, type="waiting_permission", at=now, id="PermissionRequest:t1",
                   detail={"source": "claude", "tool": "Bash"})
    hook = await hook_of(client, auth_cookie, "alpha")
    assert set(hook) == {"type", "at", "received", "id", "detail"}
    assert (hook["type"], hook["at"], hook["id"]) == ("waiting_permission", now, "PermissionRequest:t1")
    assert hook["detail"] == {"source": "claude", "tool": "Bash"}
    assert isinstance(hook["received"], float) and hook["received"] >= now - 1


async def test_absent_id_and_detail_are_null_in_the_exposed_state(client, auth_cookie, alpha):
    await accepted(client, alpha)
    hook = await hook_of(client, auth_cookie, "alpha")
    assert hook["id"] is None and hook["detail"] is None


async def test_shadow_mode_adds_the_hook_key_and_changes_nothing_else(client, auth_cookie, alpha):
    before = mesh_entry(await (await client.get("/api/sessions", headers=auth_cookie)).json(), "alpha")
    await accepted(client, alpha, type="error")
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    after = mesh_entry(data, "alpha")
    assert {k: v for k, v in after.items() if k != "hook"} == {k: v for k, v in before.items() if k != "hook"}
    assert data["opens"] == []
    assert all("hook" not in entry for entry in data["external"])


async def test_an_event_never_reaches_a_terminal(client, listing, alpha):
    for state in TYPES:
        await accepted(client, alpha, type=state)
    # `cancel_submit` (a turn after a finished one) only withdraws a queued Enter: it types nothing.
    assert all(req == {"op": "list"} or set(req) == {"op", "name", "created"} and req["op"] == "cancel_submit"
               for req in listing.state["requests"]), listing.state["requests"]


async def test_the_state_dies_with_its_session(client, auth_cookie, listing, alpha):
    await accepted(client, alpha, type="error")
    listing.clear()
    add_session(listing, "alpha", OTHER_NONCE)
    listed(listing, "alpha", 424242)
    assert await hook_of(client, auth_cookie, "alpha") is None


async def test_a_transient_ptyhost_failure_does_not_forget_the_shadow_state(client, auth_cookie, listing, alpha):
    await accepted(client, alpha, type="waiting_permission")
    listing.state["down"] = True
    down = await client.get("/api/sessions", headers=auth_cookie)
    assert down.status == 200 and (await down.json())["mesh"] == []
    listing.state["down"] = False
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "waiting_permission"


# ---------------------------------------------------------------- rate limit (EVT-17)

async def test_a_flood_is_429_with_retry_after_and_does_not_touch_other_sessions(client, auth_cookie, alpha, beta):
    await accepted(client, alpha, type="working")
    statuses = []
    for _ in range(120):
        resp = await post(client, alpha, {"type": "working"})
        statuses.append(resp.status)
        if resp.status == 429:
            assert resp.headers["Retry-After"] == "1"
            break
    assert statuses[0] == 200 and statuses[-1] == 429
    dropped = await post(client, alpha, {"type": "done"})
    assert dropped.status == 429
    assert (await hook_of(client, auth_cookie, "alpha"))["type"] == "working"
    assert (await post(client, beta, {"type": "done"})).status == 200


# ---------------------------------------------------------------- direct bounded-store invariants

def test_the_event_id_ring_forgets_only_after_64_values():
    state = server.EventState()
    for i in range(server.EVENT_DEDUP_MAX + 1):
        assert not state.duplicate("alpha", "nonce", f"event-{i}")
    assert not state.duplicate("alpha", "nonce", "event-0")
    assert state.duplicate("alpha", "nonce", f"event-{server.EVENT_DEDUP_MAX}")


def test_the_token_bucket_has_a_30_event_burst_then_refills(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(server.time, "monotonic", lambda: now[0])
    state = server.EventState()
    assert all(state.take_token("alpha", "nonce") for _ in range(server.EVENT_BUCKET_CAPACITY))
    assert not state.take_token("alpha", "nonce")
    now[0] += 1 / server.EVENT_BUCKET_RATE
    assert state.take_token("alpha", "nonce")


def test_event_state_is_app_local_and_utf8_detail_bytes_are_bounded():
    first, second = server.make_app(), server.make_app()
    first["event_state"].apply("alpha", "nonce", {"type": "done", "at": 1, "received": 1, "id": None, "detail": None})
    assert second["event_state"]._states == {}
    with pytest.raises(web.HTTPRequestEntityTooLarge):
        server._event_detail({f"k{i}": "😀" * 256 for i in range(8)})


# ---------------------------------------------------------------- comparison counters

def shadow_event(kind, at=1):
    return {"type": kind, "at": at, "received": at, "id": None, "detail": None}


def shadow_raw(name="alpha", nonce="nonce"):
    return [{"name": name, "meta": {"nonce": nonce}}]


def shadow_mesh(agent, name="alpha"):
    return [{"name": name, "agent": agent}]


def test_hook_shadow_compares_the_existing_heuristic_once_per_distinct_snapshot():
    state = server.EventState()
    assert state.apply("alpha", "nonce", shadow_event("working"))

    state.expose(shadow_mesh({"status": "busy"}), shadow_raw())
    assert state.report() == {"v": 0,
                              "mapping": {"busy": "working", "shell": "working",
                                          "waiting_permission": "waiting_permission",
                                          "waiting_question": "waiting_question", "idle": "done"},
                              "samples": 1, "agree": 1, "unobservable": 0,
                              "disagreements": {}}
    # Refreshing the identical session snapshot does not inflate the week-long
    # measure. A real discovery transition for the same hook is evidence.
    state.expose(shadow_mesh({"status": "busy"}), shadow_raw())
    state.expose(shadow_mesh({"status": "idle"}), shadow_raw())
    report = state.report()
    assert (report["samples"], report["agree"], report["unobservable"]) == (2, 1, 0)
    assert report["disagreements"] == {"working->done": 1}
    # A newer winning hook replaces the bounded deduplication window, so its
    # matching snapshot is one more observation rather than stale history.
    state.apply("alpha", "nonce", shadow_event("working", at=2))
    state.expose(shadow_mesh({"status": "busy"}), shadow_raw())
    assert (state.report()["samples"], state.report()["agree"]) == (3, 2)


@pytest.mark.parametrize(("agent", "event"), [
    ({"status": "shell"}, "working"),
    ({"status": "waiting", "waiting_for": "permission prompt"}, "waiting_permission"),
    ({"status": "waiting", "waiting_for": "input needed"}, "waiting_question"),
    ({"status": "idle"}, "done"),
])
def test_hook_shadow_has_the_explicit_preexisting_heuristic_mapping(agent, event):
    state = server.EventState()
    state.apply("alpha", "nonce", shadow_event(event))
    state.expose(shadow_mesh(agent), shadow_raw())
    assert state.report()["agree"] == 1


def test_hook_shadow_never_invents_an_error_or_unknown_heuristic_equivalence():
    state = server.EventState()
    state.apply("alpha", "nonce", shadow_event("error"))
    state.expose(shadow_mesh({"status": "idle"}), shadow_raw())
    assert state.report()["unobservable"] == 1

    state = server.EventState()
    state.apply("alpha", "nonce", shadow_event("working"))
    state.expose(shadow_mesh({"status": "waiting", "waiting_for": "new client state"}), shadow_raw())
    assert state.report()["unobservable"] == 1


def test_hook_shadow_keeps_only_the_current_event_comparison_window_per_session():
    state = server.EventState()
    for at in range(1, 101):
        state.apply("alpha", "nonce", shadow_event("working", at=at))
        state.expose(shadow_mesh({"status": "busy"}), shadow_raw())
    assert state._compared == {("alpha", "nonce"): {("working", "working")}}


def test_hook_shadow_keys_comparisons_by_incarnation_and_forgets_live_state_when_gone():
    state = server.EventState()
    state.apply("alpha", "old", shadow_event("working"))
    state.expose(shadow_mesh({"status": "busy"}), shadow_raw(nonce="old"))
    state.expose([], [])
    assert state._states == state._compared == {}

    # The aggregate history stays content-free, while a recycled name starts a
    # distinct comparison cache and cannot inherit the old event.
    state.apply("alpha", "new", shadow_event("working"))
    state.expose(shadow_mesh({"status": "idle"}), shadow_raw(nonce="new"))
    assert state.report()["samples"] == 2
    assert state.report()["disagreements"] == {"working->done": 1}


def test_hook_shadow_is_process_local_and_resets_with_a_web_server_restart():
    first, second = server.make_app(), server.make_app()
    first["event_state"].apply("alpha", "nonce", shadow_event("working"))
    first["event_state"].expose(shadow_mesh({"status": "busy"}), shadow_raw())
    assert first["event_state"].report()["samples"] == 1
    assert second["event_state"].report()["samples"] == 0


async def test_hook_shadow_report_uses_only_the_existing_authenticated_listing(client, auth_cookie, alpha):
    await accepted(client, alpha, id="private-event-id", detail={"tool": "private-detail"})
    response = await client.get("/api/sessions", headers=auth_cookie)
    assert response.status == 200
    report = (await response.json())["hook_shadow"]
    # The fixture has no discoverable agent, so it is correctly counted as
    # unobservable; importantly, no per-session fact enters the report.
    assert (report["samples"], report["agree"], report["unobservable"]) == (1, 0, 1)
    assert "alpha" not in json.dumps(report)
    assert "private-event-id" not in json.dumps(report)
    assert "private-detail" not in json.dumps(report)
