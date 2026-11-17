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


def test_owner_approval_rearms_a_delivered_message_for_non_polling_retry(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "message", "read after approval", live, now=3.0)
    first = agentmail.claim_wake(beta, live)
    agentmail.mark_wake_injected(beta, first["notification_id"], live)
    with pytest.raises(agentmail.MailConsentPending) as pending:
        agentmail.read(beta, receipt["id"], live, now=4.0)
    agentmail.decide_consent(pending.value.request["id"], "yes", now=5.0)
    second = agentmail.claim_wake(beta, live)
    assert second["notification_id"] != first["notification_id"]
    assert second["count"] == 1


@pytest.mark.parametrize("operation", ["reject", "ack"])
def test_removing_the_last_message_cancels_a_claimed_wake(mailbox, operation):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "message", "discard", live, now=3.0)
    assert agentmail.claim_wake(beta, live)["state"] == "claimed"
    if operation == "reject":
        with pytest.raises(agentmail.MailConsentPending) as pending:
            agentmail.read(beta, receipt["id"], live, now=4.0)
        agentmail.decide_consent(pending.value.request["id"], "no", now=5.0)
    else:
        agentmail.acknowledge(beta, [receipt["id"]], live)
    assert agentmail.claim_wake(beta, live) is None


def test_metadata_precedes_deliberate_read_and_reply_keeps_conversation(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0, "claude")
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "task", "untrusted instructions", live, now=3.0)

    assert set(receipt) == {"id", "conversation_id", "target", "kind", "created", "seq"}
    metadata = agentmail.inbox(beta, live)
    assert metadata == [{"id": receipt["id"], "conversation_id": receipt["conversation_id"],
                         "source": alpha, "kind": "task", "created": 3.0, "seq": 1}]
    assert "untrusted" not in str(metadata)

    opened = owner_approved_read(beta, receipt["id"], live)
    assert opened["text"] == "untrusted instructions"
    reply = agentmail.reply(beta, receipt["id"], "message", "accepted", live, now=4.0)
    assert reply["conversation_id"] == receipt["conversation_id"]
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

    first = agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    second = agentmail.send(alpha, beta, "message", "two", live, now=4.0)

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
    agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    first = agentmail.claim_wake(beta, live)
    agentmail.mark_wake_injected(beta, first["notification_id"], live)

    second_message = agentmail.send(alpha, beta, "message", "two", live, now=4.0)
    second = agentmail.claim_wake(beta, live)

    assert second["notification_id"] != first["notification_id"]
    assert second["from_seq"] == second["through_seq"] == second_message["seq"]
    assert second["count"] == 1


def test_wake_count_is_exact_with_interleaved_recipients_and_ack(mailbox):
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0)
    gamma = identity("gamma", 3.0)
    live = [alpha, beta, gamma]
    first = agentmail.send(alpha, beta, "message", "one", live, now=4.0)
    agentmail.send(alpha, gamma, "message", "other inbox", live, now=5.0)
    third = agentmail.send(alpha, beta, "message", "three", live, now=6.0)

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
    agentmail.send(alpha, beta, "task", "review", live, now=3.0)

    claimed = agentmail.claim_wake(beta, live)
    assert agentmail.claim_wake(beta, live) == claimed
    completed = agentmail.mark_wake_injected(beta, claimed["notification_id"], live)
    assert completed["state"] == "injected"
    assert agentmail.mark_wake_injected(beta, claimed["notification_id"], live) == completed
    assert agentmail.claim_wake(beta, live) is None


def test_send_after_claim_creates_next_generation_at_dispatch_race_boundary(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    claimed = agentmail.claim_wake(beta, live)

    second = agentmail.send(alpha, beta, "message", "two", live, now=4.0)
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
    receipt = agentmail.send(alpha, beta, "message", "one", live, now=3.0)

    assert agentmail.acknowledge(beta, [receipt["id"]], live) == [receipt["id"]]
    assert agentmail.claim_wake(beta, live) is None


def test_ack_after_claim_cancels_empty_generation_and_next_send_is_separate(mailbox):
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    first = agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    claimed = agentmail.claim_wake(beta, live)

    agentmail.acknowledge(beta, [first["id"]], live)
    second = agentmail.send(alpha, beta, "message", "two", live, now=4.0)

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
    assert migrated["version"] == 3
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
    assert agentmail.read(beta, second["id"], live)["text"] == "two"
    assert agentmail.consent_projection()["always"] == [policy]

    agentmail.revoke_consent(policy["id"])
    with pytest.raises(agentmail.MailConsentPending):
        agentmail.read(beta, second["id"], live, now=7.0)

    fresh_alpha = identity("alpha", 8.0)
    third = agentmail.send(fresh_alpha, beta, "message", "three", [fresh_alpha, beta], now=9.0)
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


def test_valid_v2_file_migrates_to_consent_gated_v3(mailbox):
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

    with pytest.raises(agentmail.MailConsentPending):
        agentmail.read(beta, "1" * 32, [alpha, beta], now=4.0)
    migrated = json.loads(mailbox.read_text(encoding="utf-8"))
    assert migrated["version"] == 3
    assert migrated["messages"][0]["text"] == "kept"
    assert migrated["wakes"][0]["count"] == 1


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
    assert json.loads(mailbox.read_text(encoding="utf-8"))["version"] == 3
