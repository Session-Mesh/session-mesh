# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Bounded private inboxes between live Mesh agent sessions.

Messages are addressed to a session *incarnation* (name plus creation time),
not merely to a reusable terminal name.  They are durable across Web-server
restarts, but are never delivered to a terminal: an agent must explicitly ask
its local MCP bridge to read its own inbox.  Message text is therefore still
untrusted agent-provided data, not an instruction authorised by Mesh.
"""

import contextlib
import fcntl
import json
import math
import re
import secrets
import threading
import time

import meshpaths
import fsutil
import respawn


FILE = meshpaths.CONF_DIR / "agent-mail.json"
MAX_MESSAGES = 256
MAX_INBOX = 32
MAX_OWNER_MAILBOX = 64   # messages per direction in one owner view
MAX_TEXT_BYTES = 8192
MAX_WAKE_BATCHES = 256
MAX_CONSENT_REQUESTS = 256
MAX_ALWAYS_POLICIES = 256
ID_RE = re.compile(r"[0-9a-f]{32}")
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
KINDS = frozenset(("message", "task"))
_lock = threading.Lock()
_pruning_held = False


class MailError(Exception):
    """Base class for an agent-mail request that must fail closed."""


class MailInvalidRequest(MailError, ValueError):
    """A caller supplied a malformed value at the mailbox boundary."""


class MailNotLive(MailError):
    """The source or target session incarnation is no longer live."""


class MailNotFound(MailError):
    """The requested inbox item is absent or belongs to another session."""


class MailFull(MailError):
    """The recipient already has the bounded number of pending messages."""


class MailStorageError(MailError):
    """The private durable queue cannot safely be read or written."""


class MailConsentPending(MailError):
    """The owner has not yet authorised revealing a message's text."""

    def __init__(self, request):
        super().__init__("Owner authorization required")
        self.request = request


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _identity(value):
    if not isinstance(value, dict) or set(value) != {"id", "created", "agent"}:
        return None
    name, created, agent = value["id"], value["created"], value["agent"]
    if not (isinstance(name, str) and NAME_RE.fullmatch(name) and _finite(created)
            and isinstance(agent, str) and agent):
        return None
    return {"id": name, "created": created, "agent": agent}


def _message(value):
    if not isinstance(value, dict) or set(value) != {
            "id", "conversation_id", "source", "target", "kind", "text", "created", "seq"}:
        return None
    if not (isinstance(value["id"], str) and ID_RE.fullmatch(value["id"])
            and isinstance(value["conversation_id"], str) and ID_RE.fullmatch(value["conversation_id"])
            and _identity(value["source"]) and _identity(value["target"])
            and value["kind"] in KINDS and isinstance(value["text"], str)
            and 0 < len(value["text"].encode("utf-8")) <= MAX_TEXT_BYTES
            and _finite(value["created"])
            and isinstance(value["seq"], int) and not isinstance(value["seq"], bool)
            and value["seq"] > 0):
        return None
    return {
        "id": value["id"], "conversation_id": value["conversation_id"],
        "source": dict(value["source"]), "target": dict(value["target"]),
        "kind": value["kind"], "text": value["text"], "created": value["created"],
        "seq": value["seq"],
    }


def _wake(value):
    required = {"notification_id", "target", "from_seq", "through_seq", "count", "state"}
    if not isinstance(value, dict) or set(value) != required:
        return None
    if not (isinstance(value["notification_id"], str)
            and ID_RE.fullmatch(value["notification_id"])
            and _identity(value["target"])
            and isinstance(value["from_seq"], int) and not isinstance(value["from_seq"], bool)
            and isinstance(value["through_seq"], int) and not isinstance(value["through_seq"], bool)
            and 0 < value["from_seq"] <= value["through_seq"]
            and isinstance(value["count"], int) and not isinstance(value["count"], bool)
            and 0 < value["count"] <= MAX_INBOX
            and value["state"] in {"pending", "claimed", "injected"}):
        return None
    return {"notification_id": value["notification_id"], "target": dict(value["target"]),
            "from_seq": value["from_seq"], "through_seq": value["through_seq"],
            "count": value["count"], "state": value["state"]}


def _consent_request(value):
    required = {"id", "message_id", "source", "target", "created", "state"}
    if not isinstance(value, dict) or set(value) != required:
        return None
    if not (isinstance(value["id"], str) and ID_RE.fullmatch(value["id"])
            and isinstance(value["message_id"], str) and ID_RE.fullmatch(value["message_id"])
            and _identity(value["source"]) and _identity(value["target"])
            and _finite(value["created"]) and value["state"] in {"pending", "granted"}):
        return None
    return {"id": value["id"], "message_id": value["message_id"],
            "source": dict(value["source"]), "target": dict(value["target"]),
            "created": value["created"], "state": value["state"]}


def _always_policy(value):
    required = {"id", "source", "target", "created"}
    if not isinstance(value, dict) or set(value) != required:
        return None
    if not (isinstance(value["id"], str) and ID_RE.fullmatch(value["id"])
            and _identity(value["source"]) and _identity(value["target"])
            and _finite(value["created"])):
        return None
    return {"id": value["id"], "source": dict(value["source"]),
            "target": dict(value["target"]), "created": value["created"]}


def _empty_state():
    return {"next_seq": 1, "messages": [], "wakes": [],
            "consent_requests": [], "always_policies": []}


@contextlib.contextmanager
def _locked():
    with _lock:
        try:
            FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            lockfile = open(FILE.with_name(FILE.name + ".lock"), "a")
        except OSError as exc:
            raise MailStorageError("Agent message storage unavailable") from exc
        with lockfile:
            try:
                fcntl.flock(lockfile, fcntl.LOCK_EX)
            except OSError as exc:
                raise MailStorageError("Agent message storage unavailable") from exc
            try:
                yield
            finally:
                fcntl.flock(lockfile, fcntl.LOCK_UN)


def _corrupt():
    try:
        FILE.replace(FILE.with_name(f"{FILE.name}.corrupt-{time.time_ns()}"))
    except OSError as exc:
        raise MailStorageError("Agent messages corrupted, cannot save") from exc
    return _empty_state()


def _migrate_v1(raw):
    """Losslessly add sequence/wake metadata to the original mailbox shape."""
    if not isinstance(raw, dict) or set(raw) != {"version", "messages"} \
            or raw.get("version") != 1 or not isinstance(raw.get("messages"), list) \
            or len(raw["messages"]) > MAX_MESSAGES:
        return None
    messages = []
    for seq, old in enumerate(raw["messages"], 1):
        if not isinstance(old, dict):
            return None
        message = _message({**old, "seq": seq})
        if message is None:
            return None
        messages.append(message)
    if len({message["id"] for message in messages}) != len(messages):
        return None
    wakes = []
    for target in {json.dumps(message["target"], sort_keys=True) for message in messages}:
        identity = json.loads(target)
        seqs = [message["seq"] for message in messages if message["target"] == identity]
        wakes.append({"notification_id": secrets.token_hex(16), "target": identity,
                      "from_seq": min(seqs), "through_seq": max(seqs),
                      "count": len(seqs), "state": "pending"})
    return {"next_seq": len(messages) + 1, "messages": messages, "wakes": wakes,
            "consent_requests": [], "always_policies": []}


def _load():
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty_state()
    except (OSError, ValueError):
        return _corrupt()
    if isinstance(raw, dict) and raw.get("version") == 1:
        migrated = _migrate_v1(raw)
        if migrated is None:
            return _corrupt()
        _save(migrated)
        return migrated
    if isinstance(raw, dict) and raw.get("version") == 2:
        messages_by_target = raw.get("messages") if isinstance(raw.get("messages"), list) else []
        migrated_wakes = []
        for wake in raw.get("wakes", []) if isinstance(raw.get("wakes"), list) else []:
            if not isinstance(wake, dict):
                migrated_wakes.append(wake)
                continue
            count = sum(isinstance(message, dict)
                        and message.get("target") == wake.get("target")
                        and isinstance(message.get("seq"), int)
                        and isinstance(wake.get("from_seq"), int)
                        and isinstance(wake.get("through_seq"), int)
                        and wake["from_seq"] <= message["seq"] <= wake["through_seq"]
                        for message in messages_by_target)
            if count > 0:
                migrated_wakes.append({**wake, "count": count})
            elif wake.get("state") in {"claimed", "injected"}:
                # V2 did not persist the frozen count, and acknowledgement may
                # already have removed every covered message.  Keep completion
                # idempotence without pretending an empty pending batch exists.
                migrated_wakes.append({**wake, "count": 1})
            elif wake.get("state") != "pending":
                # Preserve malformed data so normal validation quarantines the
                # whole file instead of silently laundering it during migration.
                migrated_wakes.append({**wake, "count": 0})
        raw = {**raw, "version": 3, "wakes": migrated_wakes,
               "consent_requests": [], "always_policies": []}
        migrated_v2 = True
    else:
        migrated_v2 = False
    if not isinstance(raw, dict) or set(raw) != {"version", "next_seq", "messages", "wakes",
                                                "consent_requests", "always_policies"} \
            or raw["version"] != 3 or not isinstance(raw["messages"], list) \
            or not isinstance(raw["wakes"], list) or len(raw["messages"]) > MAX_MESSAGES \
            or len(raw["wakes"]) > MAX_WAKE_BATCHES \
            or not isinstance(raw["consent_requests"], list) \
            or len(raw["consent_requests"]) > MAX_CONSENT_REQUESTS \
            or not isinstance(raw["always_policies"], list) \
            or len(raw["always_policies"]) > MAX_ALWAYS_POLICIES \
            or not isinstance(raw["next_seq"], int) or isinstance(raw["next_seq"], bool) \
            or raw["next_seq"] < 1:
        return _corrupt()
    messages = [_message(value) for value in raw["messages"]]
    wakes = [_wake(value) for value in raw["wakes"]]
    consents = [_consent_request(value) for value in raw["consent_requests"]]
    policies = [_always_policy(value) for value in raw["always_policies"]]
    seqs = [value["seq"] for value in messages if value is not None]
    valid_messages = {value["id"]: value for value in messages if value is not None}
    if (any(value is None for value in messages) or any(value is None for value in wakes)
            or any(value is None for value in consents) or any(value is None for value in policies)
            or len({value["id"] for value in messages}) != len(messages)
            or len(set(seqs)) != len(seqs) or any(seq >= raw["next_seq"] for seq in seqs)
            or any(value["through_seq"] >= raw["next_seq"] for value in wakes)
            or len({value["notification_id"] for value in wakes}) != len(wakes)
            or len({value["id"] for value in consents}) != len(consents)
            or len({value["message_id"] for value in consents}) != len(consents)
            or len({value["id"] for value in policies}) != len(policies)
            or any(valid_messages.get(value["message_id"], {}).get("source") != value["source"]
                   or valid_messages.get(value["message_id"], {}).get("target") != value["target"]
                   for value in consents)
            or any(value["state"] == "pending" and value["count"] != sum(
                message["target"] == value["target"]
                and value["from_seq"] <= message["seq"] <= value["through_seq"]
                for message in messages if message is not None)
                   for value in wakes)):
        return _corrupt()
    state = {"next_seq": raw["next_seq"], "messages": messages, "wakes": wakes,
             "consent_requests": consents, "always_policies": policies}
    if migrated_v2:
        _save(state)
    return state


def _save(state):
    try:
        fsutil.atomic_write(FILE, json.dumps({"version": 3, **state}, ensure_ascii=False,
                                              separators=(",", ":"), allow_nan=False))
    except OSError as exc:
        raise MailStorageError("Could not save agent messages") from exc


def _live_identities(live):
    """Return detached agent identities keyed by their immutable Mesh name."""
    result = {}
    for value in live:
        identity = _identity(value)
        if identity is not None:
            result[identity["id"]] = identity
    return result


def hold_pruning():
    """Stop pruning until release_pruning: the web server calls this at start-up, because
    neither the PTY host's list nor the restore offers have been read yet."""
    global _pruning_held
    _pruning_held = True


def release_pruning():
    """Pruning may resume: the PTY list was read and the snapshot with the offers was written."""
    global _pruning_held
    _pruning_held = False


def _prune(state, live):
    """Drop what no current incarnation can receive.

    A target that is gone but still has a valid restore offer (respawn.mail_offers, at most
    respawn.MAIL_RETENTION_SECONDS after it was lost) keeps its mail until transfer_incarnation
    moves it, the offer is dropped or the retention ends. In any doubt (pruning held, offers unreadable)
    nothing is removed."""
    if _pruning_held:
        return False
    offers = respawn.mail_offers()
    if offers is None:
        return False
    kept = [*_live_identities(live).values(), *offers]
    before = state["messages"]
    state["messages"] = [message for message in before if message["target"] in kept]
    wakes_before = state["wakes"]
    state["wakes"] = [wake for wake in wakes_before if wake["target"] in kept]
    message_ids = {message["id"] for message in state["messages"]}
    consents_before = state["consent_requests"]
    state["consent_requests"] = [request for request in consents_before
                                  if request["message_id"] in message_ids]
    return (before != state["messages"] or wakes_before != state["wakes"]
            or consents_before != state["consent_requests"])


def transfer_incarnation(old, new):
    """Move everything addressed to or sent by the incarnation ``old`` to ``new``: messages,
    wakes, consent requests and always-policies. The caller must have established that both are
    the same resumed conversation (server._transfer_restored_mail establishes it); the agent kind
    must match.
    Done under the mail lock, so a prune cannot interleave; idempotent. Once moved, nothing
    refers to ``old`` any more, which ends its retention. True when something was moved."""
    old, new = _identity(old), _identity(new)
    if old is None or new is None or old["agent"] != new["agent"]:
        raise MailInvalidRequest("Invalid incarnation mapping")
    if old == new:
        return False
    with _locked():
        state = _load()
        changed = False
        for collection in ("messages", "wakes", "consent_requests", "always_policies"):
            for item in state[collection]:
                for field in ("source", "target"):
                    if item.get(field) == old:
                        item[field] = dict(new)
                        changed = True
        if changed:
            state["always_policies"] = _one_policy_per_pair(state["always_policies"])
            _save(state)
        return changed


def _pair_key(policy):
    return json.dumps([policy["source"], policy["target"]], sort_keys=True)


def _one_policy_per_pair(policies):
    """The permanent permissions with at most one per (source, target): a transfer can bring a pair that
    already had one (the new incarnation was granted before), and the oldest then stays."""
    oldest = {}
    for policy in sorted(policies, key=lambda item: (item["created"], item["id"])):
        oldest.setdefault(_pair_key(policy), policy)
    return [policy for policy in policies if oldest[_pair_key(policy)] is policy]


def _require_live(identity, live):
    found = _live_identities(live).get(identity["id"])
    if found != identity:
        raise MailNotLive()


def peers(source, live):
    _require_live(source, live)
    return [identity for identity in _live_identities(live).values() if identity != source]


def inbox(target, live):
    """Return arrival metadata only; message text needs a deliberate read."""
    _require_live(target, live)
    with _locked():
        state = _load()
        changed = _prune(state, live)
        if changed:
            _save(state)
        return [{key: message[key] for key in
                 ("id", "conversation_id", "source", "kind", "created", "seq")}
                for message in state["messages"] if message["target"] == target]


def _public_consent(request):
    return {key: request[key] for key in
            ("id", "message_id", "source", "target", "created", "state")}


def read(target, message_id, live, now=None):
    """Reveal text only after a persisted, server-enforced owner choice."""
    _require_live(target, live)
    if not isinstance(message_id, str) or not ID_RE.fullmatch(message_id):
        raise MailInvalidRequest("Invalid agent message ID")
    with _locked():
        state = _load()
        changed = _prune(state, live)
        if changed:
            _save(state)
        message = next((item for item in state["messages"]
                        if item["id"] == message_id and item["target"] == target), None)
        if message is None:
            raise MailNotFound()
        always = any(policy["source"] == message["source"]
                     and policy["target"] == message["target"]
                     for policy in state["always_policies"])
        request = next((item for item in state["consent_requests"]
                        if item["message_id"] == message_id), None)
        if not always and (request is None or request["state"] != "granted"):
            if request is None:
                if len(state["consent_requests"]) >= MAX_CONSENT_REQUESTS:
                    raise MailFull()
                created = time.time() if now is None else now
                if not _finite(created):
                    raise MailInvalidRequest("Invalid authorization request date")
                request = {"id": secrets.token_hex(16), "message_id": message_id,
                           "source": dict(message["source"]), "target": dict(message["target"]),
                           "created": created, "state": "pending"}
                state["consent_requests"].append(request)
                _save(state)
            elif changed:
                _save(state)
            raise MailConsentPending(_public_consent(request))
        if request is not None:
            # A once grant is a capability consumed by this single successful read.
            state["consent_requests"].remove(request)
            _save(state)
        elif changed:
            _save(state)
        return {key: message[key] for key in
                ("id", "conversation_id", "source", "kind", "text", "created", "seq")}


def consent_projection():
    """Return consent metadata to the owner, never peer-provided message text."""
    with _locked():
        state = _load()
        return {
            "requests": [_public_consent(item) for item in state["consent_requests"]
                         if item["state"] == "pending"],
            "always": [dict(item) for item in state["always_policies"]],
        }


def owner_overview(live):
    """Metadata only, keyed by exact live incarnation; never expose message text."""
    identities = _live_identities(live)
    with _locked():
        state = _load()
        # Observation must not delete messages during a transient inventory gap.
        retained = [message for message in state["messages"]
                    if identities.get(message["target"]["id"]) == message["target"]]
        return [{"identity": identity,
                 "inbox_count": sum(message["target"] == identity for message in retained),
                 "outbox_count": sum(message["source"] == identity for message in retained),
                 "always": [dict(policy) for policy in state["always_policies"]
                            if policy["source"] == identity or policy["target"] == identity]}
                for identity in identities.values()]


def owner_mailbox(identity, live):
    """The owner's view of one live incarnation: texts included, nothing consumed.

    Read-only on purpose: it neither prunes, saves, acknowledges nor consumes a
    "read once" grant, and it never creates an authorization request. The text
    is for the human owner's page only; the agent-facing `read` stays gated.
    """
    identity = _identity(identity)
    if identity is None or _live_identities(live).get(identity["id"]) != identity:
        raise MailNotLive()
    with _locked():
        state = _load()
        live_ids = _live_identities(live)
        # Same retention rule as owner_overview: an inventory gap deletes nothing.
        retained = [message for message in state["messages"]
                    if live_ids.get(message["target"]["id"]) == message["target"]]
        received = [message for message in retained if message["target"] == identity]
        sent = [message for message in retained if message["source"] == identity]
        involved = [item for item in state["consent_requests"]
                    if item["state"] == "pending"
                    and identity in (item["source"], item["target"])]
        return {
            "identity": identity,
            "received": [dict(message) for message in received[-MAX_OWNER_MAILBOX:]],
            "sent": [dict(message) for message in sent[-MAX_OWNER_MAILBOX:]],
            "truncated": (len(received) > MAX_OWNER_MAILBOX or len(sent) > MAX_OWNER_MAILBOX),
            "requests": [_public_consent(item) for item in involved],
            "always": [dict(policy) for policy in state["always_policies"]
                       if identity in (policy["source"], policy["target"])],
        }


def _drop_message(state, message_id):
    state["messages"] = [message for message in state["messages"]
                         if message["id"] != message_id]
    state["consent_requests"] = [request for request in state["consent_requests"]
                                  if request["message_id"] != message_id]
    retained = []
    for wake in state["wakes"]:
        if wake["state"] == "injected":
            retained.append(wake)
            continue
        seqs = [message["seq"] for message in state["messages"]
                if message["target"] == wake["target"]
                and wake["from_seq"] <= message["seq"] <= wake["through_seq"]]
        if seqs:
            wake.update(from_seq=min(seqs), through_seq=max(seqs), count=len(seqs))
            retained.append(wake)
    state["wakes"] = retained


def decide_consent(request_id, decision, now=None):
    """Apply one owner choice: reject, grant once, or persist exact-peer trust."""
    if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id):
        raise MailInvalidRequest("Invalid authorization request ID")
    if decision not in {"no", "yes", "always"}:
        raise MailInvalidRequest("Invalid authorization decision")
    now = time.time() if now is None else now
    if not _finite(now):
        raise MailInvalidRequest("Invalid authorization decision date")
    with _locked():
        state = _load()
        request = next((item for item in state["consent_requests"]
                        if item["id"] == request_id and item["state"] == "pending"), None)
        if request is None:
            raise MailNotFound()
        result = _public_consent(request)
        result["decision"] = decision
        if decision == "no":
            _drop_message(state, request["message_id"])
        elif decision == "yes":
            request["state"] = "granted"
        else:
            policy = next((item for item in state["always_policies"]
                           if item["source"] == request["source"]
                           and item["target"] == request["target"]), None)
            if policy is None:
                if len(state["always_policies"]) >= MAX_ALWAYS_POLICIES:
                    # Losing an old preference is fail-closed: its peer must ask again.
                    state["always_policies"].sort(key=lambda item: (item["created"], item["id"]))
                    state["always_policies"].pop(0)
                policy = {"id": secrets.token_hex(16), "source": dict(request["source"]),
                          "target": dict(request["target"]), "created": now}
                state["always_policies"].append(policy)
            state["consent_requests"] = [item for item in state["consent_requests"]
                                          if not (item["source"] == request["source"]
                                                  and item["target"] == request["target"])]
            result["policy"] = dict(policy)
        if decision != "no":
            message = next(item for item in state["messages"]
                           if item["id"] == request["message_id"])
            covered = any(wake["target"] == message["target"]
                          and wake["state"] != "injected"
                          and wake["from_seq"] <= message["seq"] <= wake["through_seq"]
                          for wake in state["wakes"])
            if not covered:
                while len(state["wakes"]) >= MAX_WAKE_BATCHES:
                    old = next((wake for wake in state["wakes"]
                                if wake["state"] == "injected"), None)
                    if old is None:
                        raise MailFull()
                    state["wakes"].remove(old)
                state["wakes"].append({"notification_id": secrets.token_hex(16),
                                       "target": dict(message["target"]),
                                       "from_seq": message["seq"],
                                       "through_seq": message["seq"],
                                       "count": 1, "state": "pending"})
        _save(state)
        return result


def revoke_consent(policy_id):
    if not isinstance(policy_id, str) or not ID_RE.fullmatch(policy_id):
        raise MailInvalidRequest("Invalid authorization policy ID")
    with _locked():
        state = _load()
        policy = next((item for item in state["always_policies"]
                       if item["id"] == policy_id), None)
        if policy is None:
            raise MailNotFound()
        state["always_policies"].remove(policy)
        _save(state)
        return dict(policy)


def _text(value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_TEXT_BYTES:
        raise MailInvalidRequest("Invalid agent message text")
    return value


def _kind(value):
    if value not in KINDS:
        raise MailInvalidRequest("Invalid agent message type")
    return value


def _append(state, source, target, kind, text, conversation_id, now):
    if (len(state["messages"]) >= MAX_MESSAGES
            or sum(message["target"] == target for message in state["messages"]) >= MAX_INBOX):
        raise MailFull()
    # Claim freezes a dispatch watermark.  A message racing with an accepted
    # notification must form the next generation, never hide behind the
    # already-dispatched notification.
    active = next((wake for wake in reversed(state["wakes"])
                   if wake["target"] == target and wake["state"] == "pending"), None)
    if active is None:
        while len(state["wakes"]) >= MAX_WAKE_BATCHES:
            old = next((wake for wake in state["wakes"] if wake["state"] == "injected"), None)
            if old is None:
                raise MailFull()
            state["wakes"].remove(old)
    seq = state["next_seq"]
    message = {"id": secrets.token_hex(16), "conversation_id": conversation_id,
               "source": dict(source), "target": dict(target), "kind": kind,
               "text": text, "created": now, "seq": seq}
    state["messages"].append(message)
    state["next_seq"] += 1
    if active is None:
        state["wakes"].append({"notification_id": secrets.token_hex(16),
                               "target": dict(target), "from_seq": seq,
                               "through_seq": seq, "count": 1, "state": "pending"})
    else:
        active["through_seq"] = seq
        active["count"] += 1
    return {key: value for key, value in message.items() if key not in {"source", "text"}}


def claim_wake(target, live):
    """Durably claim the oldest uninjected notification; retries return its same id."""
    _require_live(target, live)
    with _locked():
        state = _load()
        changed = _prune(state, live)
        wake = next((item for item in state["wakes"]
                     if item["target"] == target and item["state"] != "injected"), None)
        if wake is not None and wake["state"] == "pending":
            wake["state"] = "claimed"
            changed = True
        if changed:
            _save(state)
        return None if wake is None else dict(wake)


def mark_wake_injected(target, notification_id, live):
    """Record successful injection, idempotently, before another generation may form."""
    _require_live(target, live)
    if not isinstance(notification_id, str) or not ID_RE.fullmatch(notification_id):
        raise MailInvalidRequest("Invalid agent notification ID")
    with _locked():
        state = _load()
        changed = _prune(state, live)
        wake = next((item for item in state["wakes"]
                     if item["notification_id"] == notification_id
                     and item["target"] == target), None)
        if wake is None:
            if changed:
                _save(state)
            raise MailNotFound()
        if wake["state"] == "pending":
            raise MailError("Notification not claimed")
        if wake["state"] != "injected":
            wake["state"] = "injected"
            _save(state)
        elif changed:
            _save(state)
        return dict(wake)


def send(source, target, kind, text, live, now=None):
    _require_live(source, live)
    _require_live(target, live)
    if source == target:
        raise MailInvalidRequest("An agent cannot send a message to itself")
    kind, text = _kind(kind), _text(text)
    now = time.time() if now is None else now
    if not _finite(now):
        raise MailInvalidRequest("Invalid agent message date")
    with _locked():
        state = _load()
        pruned = _prune(state, live)
        try:
            receipt = _append(state, source, target, kind, text, secrets.token_hex(16), now)
        except MailError:
            if pruned:
                _save(state)
            raise
        _save(state)
    return receipt


def reply(target, reply_to, kind, text, live, now=None):
    _require_live(target, live)
    if not isinstance(reply_to, str) or not ID_RE.fullmatch(reply_to):
        raise MailInvalidRequest("Invalid agent message ID")
    kind, text = _kind(kind), _text(text)
    now = time.time() if now is None else now
    if not _finite(now):
        raise MailInvalidRequest("Invalid agent message date")
    with _locked():
        state = _load()
        pruned = _prune(state, live)
        original = next((message for message in state["messages"]
                         if message["id"] == reply_to and message["target"] == target), None)
        if original is None:
            if pruned:
                _save(state)
            raise MailNotFound()
        _require_live(original["source"], live)
        try:
            receipt = _append(state, target, original["source"], kind, text,
                              original["conversation_id"], now)
        except MailError:
            if pruned:
                _save(state)
            raise
        _save(state)
    return receipt


def acknowledge(target, ids, live):
    _require_live(target, live)
    if not (isinstance(ids, list) and 1 <= len(ids) <= MAX_INBOX
            and all(isinstance(value, str) and ID_RE.fullmatch(value) for value in ids)):
        raise MailInvalidRequest("Invalid agent message IDs")
    ids = set(ids)
    with _locked():
        state = _load()
        _prune(state, live)
        owned = {message["id"] for message in state["messages"] if message["target"] == target}
        if not ids <= owned:
            raise MailNotFound()
        for message_id in ids:
            _drop_message(state, message_id)
        _save(state)
    return sorted(ids)
