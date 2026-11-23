# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Event-driven delivery of durable agent-mail wake generations."""

import asyncio
import contextlib
import json
import os
import re
import shutil
import time
from pathlib import Path

import agentmail
import fsutil


RETRY_SECONDS = 1.0
MAX_RETRY_SECONDS = 60.0
_DELIVERED = "delivered"
_READINESS_DEFERRED = "readiness-deferred"
_TRANSPORT_DEFERRED = "transport-deferred"
_UNCONFIRMED = "unconfirmed"
_READINESS_REASONS = frozenset((
    "human_dirty", "unsupported_foreground", "input_refused", "stale_incarnation", "not_confirmed",
    "not_idle"))


class Dispatcher:
    """Inject mailbox notices without making recipient agents poll.

    Mailbox persistence owns generations and idempotency.  The dispatcher is
    deliberately transport-thin: it resolves current incarnations, asks the
    PTY owner for one atomic injection, and only then marks the generation as
    delivered.
    """

    def __init__(self, live, notify, retry_seconds=RETRY_SECONDS,
                 max_retry_seconds=MAX_RETRY_SECONDS):
        self._live = live
        self._notify = notify
        self._retry_seconds = retry_seconds
        self._max_retry_seconds = max(retry_seconds, max_retry_seconds)
        self._changed = asyncio.Event()
        self._mailbox_lock = asyncio.Lock()
        self._task = None

    def trigger(self):
        self._changed.set()

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run())
        self.trigger()  # resume durable claimed/pending work after a restart

    async def close(self):
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def dispatch_once(self):
        async with self._mailbox_lock:
            return await self._dispatch_once_locked() != _DELIVERED

    async def mutate(self, operation, *args):
        """Serialize message removal/consent with claim→PTY→completion."""
        async with self._mailbox_lock:
            return await asyncio.to_thread(operation, *args)

    async def _dispatch_once_locked(self):
        live = await self._live()
        mail_live = [self._mail_identity(target) for target in live]
        outcome = _DELIVERED
        for target in live:
            mail_target = self._mail_identity(target)
            if target.get("wake_unsupported") is True:
                # This agent type has no reliable idle signal: its notice is
                # never typed and the message simply waits in the inbox.
                continue
            # Capability comes from the PTY owner in the same authoritative
            # listing as the incarnation.  Old hosts omit it: their wakes stay
            # durable and dormant instead of entering an unsupported-op loop.
            # Claiming is safe and lets us distinguish a dormant wake from an
            # incapable session with an empty inbox.
            if target.get("wake_capable") is not True:
                wake = await asyncio.to_thread(agentmail.claim_wake, mail_target, mail_live)
                if wake is not None:
                    outcome = _TRANSPORT_DEFERRED
                continue
            while True:
                wake = await asyncio.to_thread(agentmail.claim_wake, mail_target, mail_live)
                if wake is None:
                    break
                request = {
                    "op": "notify_if",
                    "name": target["id"],
                    "created": target["created"],
                    "agent": target["agent"],
                    "notification_id": wake["notification_id"],
                    "count": wake["count"],
                    "through_seq": wake["through_seq"],
                }
                # Optional transport details the server derived from the live incarnation: the time of
                # the last idle (the PTY host refuses the notice if input reached the terminal at or after
                # it, i.e. a new turn), a Claude session's own messaging socket (claudewake), a Codex
                # conversation identified exactly (UUID, no terminal input), and the finished turn the
                # snapshot saw (the notifier withdraws the Enter if another event has replaced it).
                for key in ("idle_since", "wake_socket", "wake_codex", "idle_generation"):
                    if key in target:
                        request[key] = target[key]
                try:
                    result = await self._notify(request)
                except Exception:
                    outcome = _TRANSPORT_DEFERRED
                    break
                accepted = result.get("ok") and (
                    result.get("accepted") is True
                    or result.get("reason") == "already_notified"
                )
                if not accepted and result.get("reason") == _UNCONFIRMED:
                    # A line was written and nobody followed it: the wake stays
                    # claimed (never counted as delivered), nothing more is sent
                    # or typed, and the owner sees it.  Reading the inbox triggers
                    # this loop again and confirms it.
                    break
                if not accepted:
                    # Dirty human input, an agent that is between foreground
                    # processes, or a transient incarnation race all remain
                    # durable.  A clean lease transition also triggers us, and
                    # the bounded retry covers process-boundary transitions.
                    if result.get("reason") in _READINESS_REASONS:
                        if outcome != _TRANSPORT_DEFERRED:
                            outcome = _READINESS_DEFERRED
                    else:
                        outcome = _TRANSPORT_DEFERRED
                    break
                await asyncio.to_thread(
                    agentmail.mark_wake_injected,
                    mail_target,
                    wake["notification_id"],
                    mail_live,
                )
        return outcome

    @staticmethod
    def _mail_identity(target):
        """Remove transport capabilities before crossing mailbox's strict schema."""
        return {key: target[key] for key in ("id", "created", "agent")}

    async def _run(self):
        retry = self._retry_seconds
        while True:
            await self._changed.wait()
            self._changed.clear()
            try:
                async with self._mailbox_lock:
                    outcome = await self._dispatch_once_locked()
            except Exception:
                # The web service may start before or outlive a restarting PTY
                # owner.  Durable mailbox state is the retry queue.
                outcome = _TRANSPORT_DEFERRED
            if outcome == _TRANSPORT_DEFERRED:
                # A trigger can wake this wait so it can be coalesced, but it
                # cannot advance the monotonic deadline.  This prevents send
                # or lease storms from bypassing transport/capability backoff.
                deadline = asyncio.get_running_loop().time() + retry
                while True:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        break
                    try:
                        await asyncio.wait_for(self._changed.wait(), remaining)
                    except asyncio.TimeoutError:
                        break
                    self._changed.clear()
                retry = min(retry * 2, self._max_retry_seconds)
                self._changed.set()
            elif outcome == _READINESS_DEFERRED:
                # Human input becoming clean and foreground-agent transitions
                # are normal readiness events, not transport failures.  Their
                # trigger may retry immediately and never inherits hard
                # exponential backoff from earlier refusals.
                retry = self._retry_seconds
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._changed.wait(), self._retry_seconds)
                self._changed.clear()
                self._changed.set()
            else:
                retry = self._retry_seconds


# ------------------------------------------------------------ Codex: `codex queue`

THREAD_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
QUEUE_TEXT = "Mesh: new message(s) in your inbox; check mail.inbox and ask yes/no/always before reading."
QUEUE_ENV_KEYS = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
                  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME")
QUEUE_OUTPUT_MAX = 64 * 1024
QUEUE_MAX_TRACKED = 1024
_QUEUE_STATES = frozenset(("started", "queued", "unconfirmed", "cleared"))


def _queue_seconds():
    """MESH_CODEX_QUEUE_TIMEOUT_SECONDS (1 to 60, default 15) bounds one `codex queue`."""
    try:
        value = float(os.environ.get("MESH_CODEX_QUEUE_TIMEOUT_SECONDS", ""))
    except ValueError:
        return 15.0
    return value if 1.0 <= value <= 60.0 else 15.0


def _queue_limit():
    """MESH_CODEX_QUEUE_MAX_TRACKED (1 to 1024, default 1024): the attempts kept; a reduced value is for tests."""
    try:
        value = int(os.environ.get("MESH_CODEX_QUEUE_MAX_TRACKED", ""))
    except ValueError:
        return QUEUE_MAX_TRACKED
    return value if 1 <= value <= QUEUE_MAX_TRACKED else QUEUE_MAX_TRACKED


def queue_wake_enabled(environ=None):
    """MESH_CODEX_QUEUE_WAKE=1 turns the Codex wake on; anything else leaves it off.

    Off by default: delivery through `codex queue` to a Codex open in a terminal has not been tried on a
    real session, which the integration rule requires before a wake is enabled."""
    return (os.environ if environ is None else environ).get("MESH_CODEX_QUEUE_WAKE") == "1"


def queue_environment(base):
    """The environment of `codex queue`: a short allow-list, never a MESH_* name or a secret."""
    return {key: base[key] for key in QUEUE_ENV_KEYS if isinstance(base.get(key), str)}


async def _drain(stream):
    """False once more than QUEUE_OUTPUT_MAX bytes came out of the stream; the output is read and
    dropped, never kept and never logged."""
    seen = 0
    while chunk := await stream.read(4096):
        seen += len(chunk)
        if seen > QUEUE_OUTPUT_MAX:
            return False
    return True


async def _discard(stream):
    """Read and drop the rest of a stream (to its end)."""
    while await stream.read(65536):
        pass


class CodexQueue:
    """Wake a Codex conversation with `codex queue --thread <uuid> --message <fixed text>`.

    No terminal input.  One execution per notification: the attempt is recorded
    (fsync, atomic replace) before the process starts and is never repeated, so a
    timeout, a non-zero exit, a huge output or a restart leave the wake
    `unconfirmed` (shown to the owner, cleared by a look at the inbox) instead of
    risking a second message.  Only exit 0 is accepted.  The thread is an exact
    conversation UUID checked by ``verify`` just before the start; a name is never used."""

    def __init__(self, path, environment, verify, timeout=None, clock=time.time, enabled=False):
        self.enabled = enabled
        self._path = Path(path)
        self._environment = environment
        self._verify = verify
        self._timeout = _queue_seconds() if timeout is None else timeout
        self._clock = clock
        self._limit = _queue_limit()
        self._withheld = set()      # incarnations whose wake was refused, shown as unconfirmed
        # Disabled: the file is neither read nor written, whatever an earlier trial left in it.
        self._entries, self._doubt, self._damaged, self._doubt_pending = (
            self._load() if enabled else ({}, set(), False, False))
        if self._damaged:
            self._repair()

    def _load(self):
        """(entries, incarnations in doubt, damaged, all in doubt): an unreadable or invalid file is damaged,
        never empty.  "All in doubt" is the marker a repair writes: the incarnations alive at the next `retain`
        are in doubt, and it survives a restart that comes before that `retain`."""
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}, set(), False, False
        except (OSError, UnicodeDecodeError):
            return {}, set(), True, False
        try:
            data = json.loads(raw)
            items = data["entries"]
            pending = data.get("all_in_doubt", False)
            doubt = {(name, created) for name, created in data.get("doubt", [])}
            if not isinstance(items, dict) or any(
                    not isinstance(key, str) or not agentmail.ID_RE.fullmatch(key) or not isinstance(item, dict)
                    or not isinstance(item.get("name"), str) or isinstance(item.get("created"), bool)
                    or not isinstance(item.get("created"), (int, float))
                    or item.get("state") not in _QUEUE_STATES for key, item in items.items()) or any(
                    not isinstance(name, str) or isinstance(created, bool) or not isinstance(created, (int, float))
                    for name, created in doubt) or not isinstance(pending, bool):
                return {}, set(), True, False
        except (ValueError, KeyError, TypeError, AttributeError):
            return {}, set(), True, False
        return items, doubt, False, pending

    def _repair(self):
        """A damaged state file is set aside (linked or copied), never deleted, and replaced at once by a file holding
        the marker "all in doubt" (which incarnations alive now had an attempt is unknown; it must survive a restart
        before the next `retain`, see `post`).  If either step fails, every wake stays unconfirmed."""
        stem = f"{self._path.name}.damaged-{int(self._clock())}"
        print(f"codex queue wake: state file {self._path} is damaged; every Codex wake stays unconfirmed "
              f"for the sessions alive now (the file is kept as {stem}, or {stem}-<n>)", flush=True)
        try:
            self._link_aside(stem)
            self._doubt_pending = True
            self._save()
        except OSError as error:
            self._doubt_pending = False
            print(f"codex queue wake: the damaged state file could not be set aside ({error!r}): "
                  "every Codex wake stays unconfirmed", flush=True)
            return
        self._damaged = False

    def _link_aside(self, stem):
        """Set the damaged file aside under a free name: ``stem``, else ``stem-1``, ``stem-2``... (never overwrites)."""
        for attempt in range(1000):
            try:
                self._set_aside(self._path.with_name(stem if attempt == 0 else f"{stem}-{attempt}"))
                return
            except FileExistsError:
                continue
        raise OSError("no free name for the damaged state file")

    def _set_aside(self, target):
        """A hard link to ``target``, else (no hard links: EPERM, ENOTSUP) a private copy, removed if it fails midway
        so a truncated file never passes for the evidence.  The damaged file stays in place until the marker replaces it."""
        try:
            os.link(self._path, target)
        except FileExistsError:
            raise
        except OSError:
            with open(self._path, "rb") as source, open(target, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as copy:
                try:
                    shutil.copyfileobj(source, copy)
                    copy.flush()
                    os.fsync(copy.fileno())
                except BaseException:
                    Path(target).unlink(missing_ok=True)
                    raise

    def _make_room(self):
        """Room for one more attempt, or False.

        Only a `queued` attempt (accepted: its notification is injected or about to be) may be forgotten.
        Forgetting a `started`, `unconfirmed` or not yet answered `cleared` one would let its notification,
        still claimed, run a second time."""
        while len(self._entries) >= self._limit:
            finished = [key for key, item in self._entries.items() if item["state"] == "queued"]
            if not finished:
                return False
            del self._entries[min(finished, key=lambda key: self._entries[key].get("at", 0))]
        return True

    def _save(self):
        fsutil.atomic_write(self._path, json.dumps({"version": 1, "entries": self._entries, "doubt": sorted(self._doubt),
                                                   **({"all_in_doubt": True} if self._doubt_pending else {})},
                                              separators=(",", ":")),
                            sync_dir=True)

    def _save_quietly(self):
        """Save, leaving the previous file in place when the write fails (the callers read that as doubt)."""
        with contextlib.suppress(OSError):
            self._save()

    def executable(self):
        """The `codex` first on the PATH sessions get, as an absolute path, or None."""
        found = shutil.which("codex", path=self._environment().get("PATH") or "/usr/bin:/bin")
        return found if found and os.path.isabs(found) else None

    def retain(self, live):
        """Forget the attempts of incarnations that are gone."""
        keep = set(live)
        self._withheld &= keep
        gone = [key for key, item in self._entries.items() if (item["name"], item["created"]) not in keep]
        pending = self._doubt_pending
        doubt = (self._doubt | keep) if pending else (self._doubt & keep)
        if self._damaged:
            return
        self._doubt_pending = False
        if gone or pending or doubt != self._doubt:
            for key in gone:
                del self._entries[key]
            self._doubt = doubt
            self._save_quietly()

    def unconfirmed(self):
        return {(item["name"], item["created"]) for item in self._entries.values()
                if item["state"] in ("started", "unconfirmed")} | self._withheld

    def note_inbox_read(self, name, created):
        changed = False
        for item in self._entries.values():
            if (item["name"], item["created"]) == (name, created) and item["state"] in ("started", "unconfirmed"):
                item["state"] = "cleared"
                changed = True
        if changed and not self._damaged:
            self._save_quietly()

    async def post(self, request, wake):
        """A notify result: accepted only for exit 0; `unconfirmed` once a process was started."""
        notification = request["notification_id"]
        thread = wake.get("thread") if isinstance(wake, dict) else None
        if self._damaged or self._doubt_pending or (request["name"], request["created"]) in self._doubt:
            # The state cannot say that nothing was run for this incarnation (or, before the next `retain`
            # has listed the incarnations in doubt, for any): nothing is run, the wake is shown as
            # unconfirmed, and a look at the inbox does not lift it (until the session restarts).
            self._withheld.add((request["name"], request["created"]))
            return {"ok": False, "reason": "unconfirmed"}
        known = self._entries.get(notification)
        if known is not None:
            return self._known_answer(known)
        if not isinstance(thread, str) or THREAD_RE.fullmatch(thread) is None:
            return {"ok": False, "reason": "stale_incarnation"}
        if await self._verify(request["name"], request["created"]) != thread:
            return {"ok": False, "reason": "stale_incarnation"}   # not the same conversation any more
        binary = self.executable()
        if binary is None:
            return {"ok": False, "reason": "codex_unavailable"}
        if not self._make_room():
            # Every kept attempt is still in doubt: nothing is run (no record could be made), the wake
            # stays claimed and the owner sees it; a look at an inbox makes room.
            print(f"codex queue wake: {len(self._entries)} attempts in doubt, wake of {request['name']} withheld", flush=True)
            self._withheld.add((request["name"], request["created"]))
            return {"ok": False, "reason": "state_full"}   # retried with backoff, never run
        self._withheld.discard((request["name"], request["created"]))
        self._entries[notification] = {"name": request["name"], "created": request["created"],
                                       "at": self._clock(), "state": "started"}
        try:
            self._save()
        except OSError:
            del self._entries[notification]
            return {"ok": False, "reason": "state_unwritable"}  # nothing run: a record that cannot be made durable sends nothing
        outcome = await self._run(binary, thread)
        self._entries[notification]["state"] = "queued" if outcome else "unconfirmed"
        self._save_quietly()     # not written: "started" stays on disk, read as unconfirmed, never replayed
        if outcome:
            return {"ok": True, "accepted": True}
        return {"ok": False, "reason": "unconfirmed"}

    def _known_answer(self, entry):
        """The answer for a notification that already has an attempt: never a second execution.

        `queued` (exit 0 was seen) and `cleared` (the agent looked at its inbox after an ambiguous
        outcome) are accepted so that the dispatcher marks the notification injected and the next one
        can be woken; a `cleared` attempt then counts as settled (`queued`) and may be forgotten at the
        limit.  `started` and `unconfirmed` stay in doubt until the inbox is read."""
        if entry["state"] == "cleared":
            entry["state"] = "queued"
            self._save_quietly()    # not written: `cleared` stays on disk and is answered the same way
        if entry["state"] == "queued":
            return {"ok": True, "accepted": True}
        return {"ok": False, "reason": "unconfirmed"}

    async def _run(self, binary, thread):
        """True only when the process exited 0 within the time and output limits."""
        argv = [binary, "queue", "--thread", thread, "--message", QUEUE_TEXT]
        try:
            process = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, cwd="/", env=queue_environment(self._environment()),
                start_new_session=True)
        except (OSError, ValueError):
            return False
        if not await self._within_limits(process):
            # Timeout or excess: the whole process group is killed at once, not when the clock runs out.
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, 9)
            # The streams are still read (and dropped) so that a full pipe does not keep the transport open:
            # `wait` then returns as soon as the process is gone, not after the 2 s bound.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.gather(
                    process.wait(), _discard(process.stdout), _discard(process.stderr)), 2)
            return False
        return process.returncode == 0

    async def _within_limits(self, process):
        """True when the process ended, with both streams closed, before the time limit and before
        either stream went over QUEUE_OUTPUT_MAX; False as soon as one of these fails."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout
        drains = {asyncio.ensure_future(_drain(stream)) for stream in (process.stdout, process.stderr)}
        pending = drains | {asyncio.ensure_future(process.wait())}
        try:
            while pending:
                done, pending = await asyncio.wait(pending, timeout=max(0.0, deadline - loop.time()),
                                                   return_when=asyncio.FIRST_COMPLETED)
                if not done or any(task.result() is False for task in done & drains):
                    return False
            return True
        finally:
            for task in pending:
                task.cancel()
