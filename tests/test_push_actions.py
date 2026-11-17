# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Answering a claude question from its notification (server.py api_push_act,
with_actions; discover.py _claude_choices)."""

import asyncio
import time

import pytest

import discover
import server
from ptyhost_proc import daemon  # noqa: F401  (pytest fixture)

ASK = {"type": "tool_use", "name": "AskUserQuestion",
       "input": {"questions": [{"question": "Tea or coffee?", "options": [{"label": "Tea"}, {"label": "Coffee"}, {"label": "Water"}]}]}}


@pytest.mark.parametrize("content,choices", [
    ([ASK], ["Tea", "Coffee", "Water"]),
    ([{"type": "text", "text": "x"}, ASK], ["Tea", "Coffee", "Water"]),
    ([ASK, {"type": "text", "text": "x"}], None),                                       # the question is not last
    ([{**ASK, "input": {"questions": [{**ASK["input"]["questions"][0], "multiSelect": True}]}}], None),
    ([{**ASK, "input": {"questions": ASK["input"]["questions"] * 2}}], None),           # several questions
    ([{**ASK, "input": {"questions": [{"question": "q", "options": [{"label": "only"}]}]}}], None),
    ([{**ASK, "input": {"questions": [{"question": "q", "options": [{"label": 1}, {"label": "b"}]}]}}], None),
    ([{"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}], None),
    ("text", None), (None, None), ([], None),
])
def test_claude_choices(content, choices):
    assert discover._claude_choices(content) == choices


def mesh(sid="ask", status="waiting", choices=("Tea", "Coffee"), said="❓ Tea or coffee?", kind="mesh",
         ask_id="toolu_1", waiting_for="input needed"):
    return {"id": sid, "kind": kind, "agent": {"type": "claude", "status": status, "said": said, "waiting_for": waiting_for,
                                               "choices": list(choices) if choices else None, "ask_id": ask_id}}


@pytest.fixture(autouse=True)
def no_actions(monkeypatch):
    monkeypatch.setattr(server, "ACTIONS", {})
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)   # these tests cover the switch being on


def test_buttons_only_for_a_waiting_mesh_question():
    base = {"title": "t", "body": "b", "id": "ask"}
    m = server.with_actions(base, mesh())
    assert [a["title"] for a in m["actions"]] == ["Tea", "Coffee"] and m["token"] in server.ACTIONS
    for s in (mesh(kind="external"), mesh(status="busy"), mesh(choices=None), mesh(ask_id=None),
              mesh(waiting_for="dialog open")):
        assert "actions" not in server.with_actions(base, s)


def test_expired_tokens_are_pruned():
    server.ACTIONS["old"] = {"id": "x", "ask_id": "t", "choices": ["a", "b"], "exp": time.time() - 1}
    server.with_actions({"id": "ask"}, mesh())
    assert "old" not in server.ACTIONS


@pytest.fixture
def listed(monkeypatch):
    state = {"session": mesh()}

    async def sessions(*_args, **_kwargs):
        return {"mesh": [state["session"]], "external": []}
    monkeypatch.setattr(server, "sessions", sessions)
    return state


async def act(client, auth_cookie, token, action="0"):
    return await client.post("/api/push/act", json={"token": token, "action": action}, headers=auth_cookie)


async def test_a_button_types_the_choice_once(client, auth_cookie, listed, monkeypatch):
    typed = []

    async def type_into(name, data):
        typed.append((name, data))
    monkeypatch.setattr(server, "type_into", type_into)
    token = server.with_actions({"id": "ask"}, listed["session"])["token"]
    resp = await act(client, auth_cookie, token, "1")
    assert resp.status == 200 and (await resp.json())["choice"] == "Coffee"
    assert typed == [("ask", b"2")]
    assert (await act(client, auth_cookie, token, "1")).status == 410    # single use


@pytest.mark.parametrize("change", [
    {"status": "busy"}, {"ask_id": "toolu_2"}, {"ask_id": None}, {"waiting_for": "dialog open"},
])
async def test_a_changed_question_is_not_answered(client, auth_cookie, listed, monkeypatch, change):
    monkeypatch.setattr(server, "type_into", lambda *a: pytest.fail("typed into a changed session"))
    token = server.with_actions({"id": "ask"}, listed["session"])["token"]
    listed["session"] = {**listed["session"], "agent": {**listed["session"]["agent"], **change}}
    assert (await act(client, auth_cookie, token)).status == 409


async def test_bad_and_expired_actions(client, auth_cookie, listed):
    token = server.with_actions({"id": "ask"}, listed["session"])["token"]
    assert (await act(client, auth_cookie, token, "2")).status == 400   # only the two buttons
    token = server.with_actions({"id": "ask"}, listed["session"])["token"]
    server.ACTIONS[token]["exp"] = time.time() - 1
    assert (await act(client, auth_cookie, token)).status == 410
    assert (await act(client, auth_cookie, "made-up")).status == 410


async def test_act_needs_auth_and_same_origin(client, auth_cookie, listed):
    token = server.with_actions({"id": "ask"}, listed["session"])["token"]
    assert (await client.post("/api/push/act", json={"token": token, "action": "0"})).status == 401
    resp = await client.post("/api/push/act", json={"token": token, "action": "0"},
                             headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403 and token in server.ACTIONS


async def test_type_into_reaches_the_session_without_resizing_it(daemon, tmp_path, plain_transport_shell):
    # a real ptyhost process: an in-process one did not show the lost keystroke
    out = tmp_path / "got"
    # a real session has a long replay (here 2.6 MB): it must not swallow the keystroke
    await daemon.new("typed", f"head -c 2600000 /dev/zero | tr '\\0' a | fold -w 100; "
                           f"stty raw -echo; stty size > {out}.before; head -c 1 > {out}; stty size > {out}.after; sleep 30")
    for _ in range(200):
        if (tmp_path / "got.before").exists():
            break
        await asyncio.sleep(0.05)
    await server.type_into("typed", b"2")
    for _ in range(100):
        if (tmp_path / "got.after").exists() and (tmp_path / "got.after").read_text():
            break
        await asyncio.sleep(0.05)
    assert out.read_bytes() == b"2"
    assert (tmp_path / "got.before").read_text() == (tmp_path / "got.after").read_text()
    with pytest.raises(LookupError):
        await server.type_into("nope", b"1")


def claude_transcript(tmp_path, monkeypatch, lines, waiting_for="input needed"):
    import json
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    sid = "0a1b2c3d-0000-0000-0000-00000000aaaa"
    (tmp_path / ".claude" / "sessions").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "sessions" / "9.json").write_text(json.dumps(
        {"sessionId": sid, "status": "waiting", "waitingFor": waiting_for}))
    proj = tmp_path / ".claude" / "projects" / "-x"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / f"{sid}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    return discover.claude_info(9)


def assistant(mid, *blocks):
    return [{"type": "assistant", "message": {"id": mid, "content": [b]}} for b in blocks]


def test_an_unanswered_question_exposes_its_id(tmp_path, monkeypatch):
    info = claude_transcript(tmp_path, monkeypatch, assistant("m1", {**ASK, "id": "toolu_q"}))
    assert (info["ask_id"], info["choices"]) == ("toolu_q", ["Tea", "Coffee", "Water"])


def test_an_answered_question_has_no_keys(tmp_path, monkeypatch):
    lines = assistant("m1", {**ASK, "id": "toolu_q"}) + [
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_q", "content": "Tea"}]}}]
    info = claude_transcript(tmp_path, monkeypatch, lines)
    assert info["ask_id"] is None and info["choices"] is None


def test_a_question_asked_with_another_tool_has_no_keys(tmp_path, monkeypatch):
    lines = assistant("m1", {"type": "tool_use", "id": "toolu_b", "name": "Bash", "input": {"command": "ls"}},
                      {**ASK, "id": "toolu_q"})
    assert claude_transcript(tmp_path, monkeypatch, lines)["ask_id"] is None


def test_two_questions_in_one_message_have_no_keys(tmp_path, monkeypatch):
    other = {**ASK, "id": "toolu_q2", "input": {"questions": [{"question": "Colour?", "options": [{"label": "Red"}, {"label": "Blue"}]}]}}
    lines = assistant("m1", {**ASK, "id": "toolu_q1"}, other)
    assert claude_transcript(tmp_path, monkeypatch, lines)["ask_id"] is None
