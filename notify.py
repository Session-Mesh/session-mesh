# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Which session changes deserve a push notification.

Two moments matter to the owner: an agent starts waiting for them (claude says
so: a question or a permission) and an agent that was working stops (it is
done, or silently stuck). A session seen for the first time is only recorded:
a server restart must not notify every session at once.

"Finished" is only announced once the agent has stayed idle for a while
(codex is "busy" only while its log was written in the last 20 s: a pause in a
long build is not the end), and each kind has its own spacing, so a "finished"
never swallows the "waiting" that follows the owner's reply.
"""

import time

SETTLE = {"claude": 5, "codex": 60}   # seconds idle before "finished" (claude reports its state)
SPACING = {"wait": 30, "done": 30}    # seconds between two notifications of one kind for one session
TITLE_MAX, BODY_MAX = 60, 140         # a payload must stay well under the 4 KB push limit
QUESTION_DIALOG = "input needed"      # what claude reports while its question dialog is open
KIND_TEXT = {"waiting": "is waiting for you", "question": "is waiting for you · question", "finished": "finished"}


def _label(s):
    a = s.get("agent") or {}
    return s.get("label") or a.get("title") or a.get("name") or s.get("name") or "session"


def _plain_label(s):
    """What the owner or the session named it: never the agent's conversation title, which
    claude can generate from what was said."""
    a = s.get("agent") or {}
    return s.get("label") or a.get("name") or s.get("name") or "session"


def _clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


class Watcher:
    """Notifications are deferred, never dropped: one held back by the spacing goes
    out at a later poll if the session is still in that state."""

    def __init__(self):
        self.status = {}    # session id -> last agent status seen
        self.idle_at = {}   # session id -> when it went from busy to idle (finish not announced yet)
        self.asking = set() # session ids waiting whose "waiting" is not announced yet
        self.question = {}  # session id -> what it last waited on
        self.sent = {}      # (session id, kind) -> time of the last notification

    def _due(self, sid, kind, now):
        if now - self.sent.get((sid, kind), float("-inf")) < SPACING[kind]:
            return False
        self.sent[(sid, kind)] = now
        return True

    def _event(self, s, kind, detail=None):
        """What happened, with everything either form of the notification may show; the wire
        message is built from it by minimal() or detailed(), never from the session."""
        return {"id": s["id"], "kind": kind, "label": _plain_label(s), "full_label": _label(s),
                "type": s["agent"].get("type") or "agent", "detail": detail}

    def _one(self, s, now):
        a, sid = s["agent"], s["id"]
        status = a.get("status")
        if status is None:   # state file unreadable this time (being rewritten): learn nothing
            return None
        before = self.status.get(sid, "?")
        self.status[sid] = status
        if before == "?":
            return None
        if status == "waiting":
            self.idle_at.pop(sid, None)
            question = a.get("said") or a.get("waiting_for")
            # a new question, even when the answer and the next question fell between two polls
            if before != "waiting" or question != self.question.get(sid):
                self.asking.add(sid)
            self.question[sid] = question
            if sid in self.asking and self._due(sid, "wait", now):
                self.asking.discard(sid)
                kind = "question" if a.get("waiting_for") == QUESTION_DIALOG else "waiting"
                return self._event(s, kind, a.get("said") or a.get("waiting_for") or "an answer")
            return None
        self.asking.discard(sid)
        # "shell": claude's turn is over but a background shell it left still runs; the owner
        # has the reply, so it settles and notifies like idle (any other status is not a turn end)
        if status not in ("idle", "shell"):
            self.idle_at.pop(sid, None)
            return None
        if before == "busy":
            self.idle_at[sid] = now
        start = self.idle_at.get(sid)
        if start is None or now - start < SETTLE.get(a.get("type"), 30) or not self._due(sid, "done", now):
            return None
        del self.idle_at[sid]
        return self._event(s, "finished", a.get("said"))

    def changes(self, data, now=None):
        """The events due for this listing ({"mesh": [...], "external": [...]}), as _event()."""
        now = time.time() if now is None else now
        out, alive = [], set()
        for s in data.get("mesh", []) + data.get("external", []):
            if not s.get("agent"):
                continue
            alive.add(s["id"])
            message = self._one(s, now)
            if message:
                out.append(message)
        for gone in set(self.status) - alive:   # an id can come back with another process
            self.status.pop(gone, None)
            self.idle_at.pop(gone, None)
            self.asking.discard(gone)
            self.question.pop(gone, None)
        self.sent = {k: t for k, t in self.sent.items() if k[0] in alive}
        return out


# ---------------------------------------------------------------- the wire messages

def minimal(event):
    """The default notification: the session's label and the kind of event, nothing the agent
    wrote (no text, tool, argument, question or choice). The id only lets a tap open the session."""
    return {"title": _clip(event["label"], TITLE_MAX), "body": KIND_TEXT[event["kind"]],
            "id": event["id"], "kind": event["kind"]}


def detailed(event):
    """The opt-in form, per device: also the agent's last text, or the tool it waits on."""
    head = "finished" if event["kind"] == "finished" else "is waiting for you"
    return {"title": _clip(f"{event['full_label']} ({event['type']})", TITLE_MAX),
            "body": _clip(f"{head} · {event['detail']}" if event["detail"] else head, BODY_MAX),
            "id": event["id"], "kind": event["kind"]}


def message(event, detail):
    return detailed(event) if detail else minimal(event)
