# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Private, incarnation-bound transport for Mesh agent mailbox envelopes."""

import json

import pytest

import agentmail


@pytest.fixture
def mailbox(tmp_path, monkeypatch):
    path = tmp_path / "conf" / "agent-mail.json"
    monkeypatch.setattr(agentmail, "FILE", path)
    return path


def identity(name, created, agent="codex"):
    return {"id": name, "created": created, "agent": agent}


def owner_approved_read(target, message_id, live):
    with pytest.raises(agentmail.MailConsentPending) as pending:
        agentmail.read(target, message_id, live, now=99.0)
    agentmail.decide_consent(pending.value.request["id"], "yes", now=100.0)
    return agentmail.read(target, message_id, live)


def approve(receipt):
    request = next(item for item in agentmail.consent_projection()["requests"]
                   if item["message_id"] == receipt["id"])
    agentmail.decide_consent(request["id"], "yes")
    return receipt


def test_send_requests_consent_before_any_recipient_read_or_wake(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "message", "read after approval", live, now=3.0)
    request, = agentmail.consent_projection()["requests"]
    assert request["message_id"] == receipt["id"]
    assert "text" not in request
    waiting, = agentmail.inbox(beta, live)
    assert waiting["authorization_pending"] is True
    assert "authorization" not in waiting
    assert agentmail.claim_wake(beta, live) is None
    with pytest.raises(agentmail.MailConsentPending) as pending:
        agentmail.read(beta, receipt["id"], live, now=4.0)
    assert pending.value.request == request
    agentmail.decide_consent(request["id"], "yes", now=5.0)
    wake = agentmail.claim_wake(beta, live)
    assert wake["count"] == 1
    authorized, = agentmail.inbox(beta, live)
    assert authorized["authorization"] == "once"
    assert "authorization_pending" not in authorized
    assert "text" not in authorized
    assert agentmail.read(beta, receipt["id"], live)["text"] == "read after approval"
    assert "authorization" not in agentmail.inbox(beta, live)[0]


def test_out_of_order_approvals_and_revoke_only_wake_authorized_members(mailbox):
    alpha, beta, gamma = identity("alpha", 1.0), identity("beta", 2.0), identity("gamma", 3.0)
    live = [alpha, beta, gamma]
    first = agentmail.send(alpha, beta, "message", "first from alpha", live)
    middle = agentmail.send(gamma, beta, "message", "waiting for gamma", live)
    last = agentmail.send(alpha, beta, "message", "later from alpha", live)
    requests = {r["message_id"]: r for r in agentmail.consent_projection()["requests"]}
    policy = agentmail.decide_consent(requests[last["id"]]["id"], "always")["policy"]
    wake = agentmail.claim_wake(beta, live)
    assert (wake["from_seq"], wake["through_seq"], wake["count"]) == (first["seq"], last["seq"], 2)
    assert [r["message_id"] for r in agentmail.consent_projection()["requests"]] == [middle["id"]]

    agentmail.decide_consent(requests[middle["id"]]["id"], "yes")
    assert {m["id"]: m["authorization"] for m in agentmail.inbox(beta, live)} == {
        first["id"]: "always", middle["id"]: "once", last["id"]: "always"}
    assert agentmail.claim_wake(beta, live) == wake
    agentmail.revoke_consent(policy["id"])
    assert {m["id"]: m["authorization"] for m in agentmail.inbox(beta, live) if "authorization" in m} == {
        middle["id"]: "once"}
    following = agentmail.claim_wake(beta, live)
    assert following["notification_id"] != wake["notification_id"]
    assert (following["from_seq"], following["through_seq"], following["count"]) == (
        middle["seq"], middle["seq"], 1)
    assert {r["message_id"] for r in agentmail.consent_projection()["requests"]} == {
        first["id"], last["id"]}


def test_metadata_precedes_deliberate_read_and_reply_keeps_conversation(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0, "claude")
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "task", "untrusted instructions", live, now=3.0)

    assert set(receipt) == {"id", "conversation_id", "target", "kind", "created", "seq"}
    metadata = agentmail.inbox(beta, live)
    assert metadata == [{"id": receipt["id"], "conversation_id": receipt["conversation_id"],
                         "source": alpha, "kind": "task", "created": 3.0, "seq": 1,
                         "authorization_pending": True}]
    assert "untrusted" not in str(metadata)

    opened = owner_approved_read(beta, receipt["id"], live)
    assert opened["text"] == "untrusted instructions"
    reply = agentmail.reply(beta, receipt["id"], "message", "accepted", live, now=4.0)
    assert reply["conversation_id"] == receipt["conversation_id"]
    assert agentmail.claim_wake(alpha, live) is None
    request, = agentmail.consent_projection()["requests"]
    assert (request["message_id"], request["source"], request["target"]) == (reply["id"], beta, alpha)
    assert owner_approved_read(alpha, reply["id"], live)["source"] == beta


def test_name_reuse_and_acknowledgement_cannot_cross_inbox_boundaries(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0, "claude")
    receipt = agentmail.send(alpha, beta, "message", "hello", [alpha, beta], now=3.0)
    with pytest.raises(agentmail.MailNotFound):
        agentmail.acknowledge(alpha, [receipt["id"]], [alpha, beta])

    fresh_beta = identity("beta", 4.0, "claude")
    assert agentmail.inbox(fresh_beta, [alpha, fresh_beta]) == []
    assert not mailbox.exists() or "hello" not in mailbox.read_text(encoding="utf-8")


def test_sender_exit_does_not_erase_unread_message_but_prevents_dead_reply(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0, "claude")
    receipt = agentmail.send(alpha, beta, "message", "please review", [alpha, beta], now=3.0)

    # The recipient can still make the owner-approved read/ack decision after
    # its peer has stopped.  The historic source identity remains attributable.
    assert owner_approved_read(beta, receipt["id"], [beta])["source"] == alpha
    with pytest.raises(agentmail.MailNotLive):
        agentmail.reply(beta, receipt["id"], "message", "done", [beta], now=4.0)
    assert agentmail.acknowledge(beta, [receipt["id"]], [beta]) == [receipt["id"]]


def test_full_global_queue_refuses_without_evicting_another_inbox(mailbox, monkeypatch):
    alpha, beta, gamma = identity("alpha", 1.0), identity("beta", 2.0), identity("gamma", 3.0)
    monkeypatch.setattr(agentmail, "MAX_MESSAGES", 1)
    first = agentmail.send(alpha, beta, "message", "first", [alpha, beta, gamma], now=4.0)

    with pytest.raises(agentmail.MailFull):
        agentmail.send(alpha, gamma, "message", "second", [alpha, beta, gamma], now=5.0)
    assert owner_approved_read(beta, first["id"], [alpha, beta, gamma])["text"] == "first"


def test_rejects_malformed_or_unbounded_payloads(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    with pytest.raises(ValueError):
        agentmail.send(alpha, beta, "message", "", [alpha, beta])
    with pytest.raises(ValueError):
        agentmail.send(alpha, beta, "instruction", "x", [alpha, beta])
    with pytest.raises(ValueError):
        agentmail.send(alpha, alpha, "message", "x", [alpha])


def test_two_sends_get_monotonic_sequences_and_one_pending_wake(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]

    first = approve(agentmail.send(alpha, beta, "message", "one", live, now=3.0))
    second = approve(agentmail.send(alpha, beta, "message", "two", live, now=4.0))

    assert (first["seq"], second["seq"]) == (1, 2)
    wake = agentmail.claim_wake(beta, live)
    assert wake["from_seq"] == 1
    assert wake["through_seq"] == 2
    assert wake["count"] == 2
    assert wake["state"] == "claimed"
    state = json.loads(mailbox.read_text(encoding="utf-8"))
    assert len(state["wakes"]) == 1


def test_message_after_injected_watermark_creates_new_generation(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    approve(agentmail.send(alpha, beta, "message", "one", live, now=3.0))
    first = agentmail.claim_wake(beta, live)
    agentmail.mark_wake_injected(beta, first["notification_id"], live)

    second_message = approve(agentmail.send(alpha, beta, "message", "two", live, now=4.0))
    second = agentmail.claim_wake(beta, live)

    assert second["notification_id"] != first["notification_id"]
    assert second["from_seq"] == second["through_seq"] == second_message["seq"]
    assert second["count"] == 1


def test_wake_count_is_exact_with_interleaved_recipients_and_ack(mailbox):
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0)
    gamma = identity("gamma", 3.0)
    live = [alpha, beta, gamma]
    first = approve(agentmail.send(alpha, beta, "message", "one", live, now=4.0))
    approve(agentmail.send(alpha, gamma, "message", "other inbox", live, now=5.0))
    third = approve(agentmail.send(alpha, beta, "message", "three", live, now=6.0))

    state = json.loads(mailbox.read_text(encoding="utf-8"))
    beta_wake = next(wake for wake in state["wakes"] if wake["target"] == beta)
    assert (beta_wake["from_seq"], beta_wake["through_seq"], beta_wake["count"]) == (1, 3, 2)

    agentmail.acknowledge(beta, [first["id"]], live)
    wake = agentmail.claim_wake(beta, live)
    assert (wake["from_seq"], wake["through_seq"], wake["count"]) == (
        third["seq"], third["seq"], 1)


def test_claim_and_injected_completion_are_idempotent_across_retries(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    approve(agentmail.send(alpha, beta, "task", "review", live, now=3.0))

    claimed = agentmail.claim_wake(beta, live)
    assert agentmail.claim_wake(beta, live) == claimed
    completed = agentmail.mark_wake_injected(beta, claimed["notification_id"], live)
    assert completed["state"] == "injected"
    assert agentmail.mark_wake_injected(beta, claimed["notification_id"], live) == completed
    assert agentmail.claim_wake(beta, live) is None


def test_send_after_claim_creates_next_generation_at_dispatch_race_boundary(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    approve(agentmail.send(alpha, beta, "message", "one", live, now=3.0))
    claimed = agentmail.claim_wake(beta, live)

    second = approve(agentmail.send(alpha, beta, "message", "two", live, now=4.0))
    retried = agentmail.claim_wake(beta, live)

    assert retried["notification_id"] == claimed["notification_id"]
    assert retried["from_seq"] == 1
    assert retried["through_seq"] == 1
    agentmail.mark_wake_injected(beta, claimed["notification_id"], live)
    following = agentmail.claim_wake(beta, live)
    assert following["notification_id"] != claimed["notification_id"]
    assert following["from_seq"] == following["through_seq"] == second["seq"] == 2


def test_acknowledging_all_messages_removes_empty_uninjected_wake(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = approve(agentmail.send(alpha, beta, "message", "one", live, now=3.0))

    assert agentmail.acknowledge(beta, [receipt["id"]], live) == [receipt["id"]]
    assert agentmail.claim_wake(beta, live) is None


def test_ack_after_claim_cancels_empty_generation_and_next_send_is_separate(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    first = approve(agentmail.send(alpha, beta, "message", "one", live, now=3.0))
    claimed = agentmail.claim_wake(beta, live)

    agentmail.acknowledge(beta, [first["id"]], live)
    second = approve(agentmail.send(alpha, beta, "message", "two", live, now=4.0))

    following = agentmail.claim_wake(beta, live)
    assert following["notification_id"] != claimed["notification_id"]
    assert following["from_seq"] == following["through_seq"] == second["seq"]


def test_v1_file_migrates_without_message_loss(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    old = {"version": 1, "messages": [{
        "id": "1" * 32, "conversation_id": "2" * 32,
        "source": alpha, "target": beta, "kind": "message",
        "text": "kept", "created": 3.0,
    }]}
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps(old), encoding="utf-8")

    opened = owner_approved_read(beta, "1" * 32, [alpha, beta])

    assert opened["text"] == "kept"
    assert opened["seq"] == 1
    migrated = json.loads(mailbox.read_text(encoding="utf-8"))
    assert migrated["version"] == 4
    assert migrated["next_seq"] == 2
    assert migrated["messages"][0]["text"] == "kept"
    assert migrated["wakes"][0]["through_seq"] == 1


def test_corrupt_v2_wake_is_quarantined_fail_closed(mailbox):
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps({"version": 2, "next_seq": 1, "messages": [],
                                   "wakes": [{"unexpected": True}]}), encoding="utf-8")
    alpha = identity("alpha", 1.0)

    assert agentmail.claim_wake(alpha, [alpha]) is None
    assert list(mailbox.parent.glob("agent-mail.json.corrupt-*"))


def test_read_is_pending_without_text_then_once_grant_is_consumed(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "task", "secret peer text", live, now=3.0)

    with pytest.raises(agentmail.MailConsentPending) as first:
        agentmail.read(beta, receipt["id"], live, now=4.0)
    assert "secret peer text" not in str(first.value.request)
    with pytest.raises(agentmail.MailConsentPending) as retry:
        agentmail.read(beta, receipt["id"], live, now=5.0)
    assert retry.value.request["id"] == first.value.request["id"]

    agentmail.decide_consent(first.value.request["id"], "yes", now=6.0)
    assert agentmail.read(beta, receipt["id"], live)["text"] == "secret peer text"
    with pytest.raises(agentmail.MailConsentPending) as second_request:
        agentmail.read(beta, receipt["id"], live, now=7.0)
    assert second_request.value.request["id"] != first.value.request["id"]


def test_no_rejects_and_acknowledges_message_atomically(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "message", "reject me", live, now=3.0)
    with pytest.raises(agentmail.MailConsentPending) as pending:
        agentmail.read(beta, receipt["id"], live, now=4.0)

    result = agentmail.decide_consent(pending.value.request["id"], "no", now=5.0)
    assert result["decision"] == "no"
    assert agentmail.inbox(beta, live) == []
    assert agentmail.claim_wake(beta, live) is None
    assert agentmail.consent_projection()["requests"] == []


def test_always_is_exactly_incarnation_bound_persistent_and_revocable(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    first = agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    with pytest.raises(agentmail.MailConsentPending) as pending:
        agentmail.read(beta, first["id"], live, now=4.0)
    decided = agentmail.decide_consent(pending.value.request["id"], "always", now=5.0)
    policy = decided["policy"]

    assert agentmail.read(beta, first["id"], live)["text"] == "one"
    second = agentmail.send(alpha, beta, "message", "two", live, now=6.0)
    assert [m["authorization"] for m in agentmail.inbox(beta, live)] == ["always", "always"]
    assert agentmail.read(beta, second["id"], live)["text"] == "two"
    assert agentmail.consent_projection()["always"] == [policy]

    agentmail.revoke_consent(policy["id"])
    with pytest.raises(agentmail.MailConsentPending):
        agentmail.read(beta, second["id"], live, now=7.0)

    fresh_alpha = identity("alpha", 8.0)
    third = agentmail.send(fresh_alpha, beta, "message", "three", [fresh_alpha, beta], now=9.0)
    third_entry = next(m for m in agentmail.inbox(beta, [fresh_alpha, beta]) if m["id"] == third["id"])
    assert third_entry["authorization_pending"] is True
    assert "authorization" not in third_entry
    with pytest.raises(agentmail.MailConsentPending):
        agentmail.read(beta, third["id"], [fresh_alpha, beta], now=10.0)


def test_always_for_one_claude_session_never_authorises_another(mailbox):
    """Provider/type similarity is not a consent identity.

    The immutable Mesh incarnation is the full ``(id, created, agent)`` tuple.
    A label rename leaves that tuple alone; a restart, fork or migration creates
    another tuple and must therefore ask the owner again.
    """
    claude_a = identity("review-claude", 1.0, "claude")
    claude_b = identity("review-claude-2", 2.0, "claude")
    codex = identity("recipient-codex", 3.0, "codex")
    live = [claude_a, claude_b, codex]

    first = agentmail.send(claude_a, codex, "message", "from A", live, now=4.0)
    with pytest.raises(agentmail.MailConsentPending) as pending_a:
        agentmail.read(codex, first["id"], live, now=5.0)
    agentmail.decide_consent(pending_a.value.request["id"], "always", now=6.0)
    assert agentmail.read(codex, first["id"], live)["text"] == "from A"

    second = agentmail.send(claude_b, codex, "message", "from B", live, now=7.0)
    with pytest.raises(agentmail.MailConsentPending) as pending_b:
        agentmail.read(codex, second["id"], live, now=8.0)
    assert pending_b.value.request["source"] == claude_b
    assert pending_b.value.request["id"] != pending_a.value.request["id"]


def test_valid_v2_file_migrates_without_waking_unapproved_mail(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps({
        "version": 2, "next_seq": 2,
        "messages": [{"id": "1" * 32, "conversation_id": "2" * 32,
                      "source": alpha, "target": beta, "kind": "message",
                      "text": "kept", "created": 3.0, "seq": 1}],
        "wakes": [{"notification_id": "3" * 32, "target": beta,
                   "from_seq": 1, "through_seq": 1, "state": "pending"}],
    }), encoding="utf-8")

    assert agentmail.claim_wake(beta, [alpha, beta]) is None
    assert agentmail.consent_projection()["requests"][0]["message_id"] == "1" * 32
    migrated = json.loads(mailbox.read_text(encoding="utf-8"))
    assert migrated["version"] == 4
    assert migrated["messages"][0]["text"] == "kept"
    assert migrated["wakes"] == []


def test_v3_keeps_existing_grants_without_replaying_unapproved_wakes(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    mailbox.parent.mkdir(parents=True)
    messages = [{"id": str(seq) * 32, "conversation_id": "a" * 32, "source": alpha,
                 "target": beta, "kind": "message", "text": f"message {seq}",
                 "created": float(seq + 4), "seq": seq} for seq in (1, 2, 3)]
    pending = {"id": "d" * 32, "message_id": messages[1]["id"], "source": alpha,
               "target": beta, "created": 9.0, "state": "pending"}
    granted = {**pending, "id": "e" * 32, "message_id": messages[2]["id"], "state": "granted"}
    mailbox.write_text(json.dumps({
        "version": 3, "next_seq": 4, "messages": messages, "always_policies": [],
        "consent_requests": [pending, granted],
        "wakes": [{"notification_id": "f" * 32, "target": beta, "from_seq": 1,
                   "through_seq": 3, "count": 3, "state": "pending"}],
    }), encoding="utf-8")

    wake = agentmail.claim_wake(beta, live)
    assert (wake["notification_id"], wake["from_seq"], wake["through_seq"], wake["count"]) == (
        "f" * 32, 3, 3, 1)
    requests = {r["message_id"]: r for r in agentmail.consent_projection()["requests"]}
    assert set(requests) == {messages[0]["id"], messages[1]["id"]}
    assert requests[messages[1]["id"]] == pending
    assert agentmail.read(beta, messages[2]["id"], live)["text"] == "message 3"
    agentmail.mark_wake_injected(beta, wake["notification_id"], live)
    assert agentmail.claim_wake(beta, live) is None


def test_v2_migration_preserves_claim_completion_after_messages_were_acked(mailbox):
    beta = identity("beta", 2.0)
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps({
        "version": 2, "next_seq": 2, "messages": [],
        "wakes": [{"notification_id": "3" * 32, "target": beta,
                   "from_seq": 1, "through_seq": 1, "state": "claimed"}],
    }), encoding="utf-8")

    completed = agentmail.mark_wake_injected(beta, "3" * 32, [beta])
    assert completed["state"] == "injected"
    assert json.loads(mailbox.read_text(encoding="utf-8"))["version"] == 4


@pytest.mark.parametrize("version,wake_state", [(2, "pending"), (3, "pending"), (3, "claimed")])
def test_large_legacy_wake_migrates_without_losing_mail_or_claim_identity(mailbox, version, wake_state):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    count = agentmail.MAX_INBOX + 8
    messages = [{"id": f"{seq:032x}", "conversation_id": "a" * 32, "source": alpha,
                 "target": beta, "kind": "message", "text": f"message {seq}",
                 "created": float(seq + 4), "seq": seq} for seq in range(1, count + 1)]
    wake = {"notification_id": "f" * 32, "target": beta, "from_seq": 1,
            "through_seq": count, "state": wake_state}
    raw = {"version": version, "next_seq": count + 1, "messages": messages, "wakes": [wake]}
    if version == 3:
        wake["count"] = count
        raw["consent_requests"] = []
        raw["always_policies"] = [{"id": "e" * 32, "source": alpha, "target": beta, "created": 3.0}]
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps(raw), encoding="utf-8")

    if wake_state == "claimed":
        original = mailbox.read_bytes()
        with pytest.raises(agentmail.MailStorageError, match="explicit recovery"):
            agentmail.claim_wake(beta, [alpha, beta])
        assert mailbox.read_bytes() == original
        return
    first = agentmail.claim_wake(beta, [alpha, beta])
    saved = json.loads(mailbox.read_text(encoding="utf-8"))
    assert saved["version"] == 4
    assert saved["messages"] == messages
    if version == 2:
        assert first is None
        assert saved["wakes"] == []
        assert len(saved["consent_requests"]) == count
    else:
        assert first["notification_id"] == wake["notification_id"]
        assert first["count"] == agentmail.MAX_INBOX
        assert agentmail.claim_wake(beta, [alpha, beta]) == first
        assert [item["count"] for item in saved["wakes"]] == [agentmail.MAX_INBOX, 8]
        assert [seq for item in saved["wakes"] for seq in item["seqs"]] == list(range(1, count + 1))
        agentmail.mark_wake_injected(beta, first["notification_id"], [alpha, beta])
        second = agentmail.claim_wake(beta, [alpha, beta])
        assert second["count"] == 8
        assert agentmail.claim_wake(beta, [alpha, beta]) == second
        agentmail.mark_wake_injected(beta, second["notification_id"], [alpha, beta])
        assert agentmail.claim_wake(beta, [alpha, beta]) is None
    assert not list(mailbox.parent.glob(mailbox.name + ".corrupt*"))


def test_large_legacy_wake_over_batch_limit_preserves_original_file(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    count = agentmail.MAX_INBOX + 1
    messages = [{"id": f"{seq:032x}", "conversation_id": "a" * 32, "source": alpha,
                 "target": beta, "kind": "message", "text": f"message {seq}",
                 "created": float(seq + 4), "seq": seq} for seq in range(1, count + 1)]
    wakes = [{"notification_id": f"{seq + 1000:032x}", "target": beta, "from_seq": 1,
              "through_seq": 1, "count": 1, "state": "injected"}
             for seq in range(agentmail.MAX_WAKE_BATCHES - 1)]
    wakes.append({"notification_id": "f" * 32, "target": beta, "from_seq": 1,
                  "through_seq": count, "count": count, "state": "pending"})
    raw = {"version": 3, "next_seq": count + 1, "messages": messages, "wakes": wakes,
           "consent_requests": [], "always_policies": [
               {"id": "e" * 32, "source": alpha, "target": beta, "created": 3.0}]}
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps(raw), encoding="utf-8")
    original = mailbox.read_bytes()
    with pytest.raises(agentmail.MailStorageError, match="Too many legacy wake batches"):
        agentmail.claim_wake(beta, [alpha, beta])
    assert mailbox.read_bytes() == original
    assert not list(mailbox.parent.glob(mailbox.name + ".corrupt*"))


@pytest.mark.parametrize("wake_state", ["injected", "claimed"])
def test_oversized_legacy_empty_completion_survives_two_loads(mailbox, wake_state):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    count = agentmail.MAX_INBOX + 8
    messages = [{"id": f"{seq:032x}", "conversation_id": "a" * 32, "source": alpha,
                 "target": beta, "kind": "message", "text": f"message {seq}",
                 "created": float(seq + 4), "seq": seq} for seq in range(1, count + 1)]
    wake = {"notification_id": "f" * 32, "target": beta, "from_seq": 1,
            "through_seq": count, "count": count, "state": wake_state}
    raw = {"version": 3, "next_seq": count + 1, "messages": messages, "wakes": [wake],
           "consent_requests": [], "always_policies": []}
    mailbox.parent.mkdir(parents=True)
    mailbox.write_text(json.dumps(raw), encoding="utf-8")

    first = agentmail._load()
    assert first["messages"] == messages
    completion, = first["wakes"]
    assert completion["notification_id"] == wake["notification_id"]
    assert completion["state"] == "injected" and completion["seqs"] == []
    assert completion["count"] == agentmail.MAX_INBOX
    assert agentmail._load() == first
    assert not list(mailbox.parent.glob(mailbox.name + ".corrupt*"))
