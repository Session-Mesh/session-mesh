# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Read-only, evidence-labelled inventory for the owner's live Mesh sessions.

The only Git observation is delegated to two optional external executables,
``gitwright-worktree-observe`` and ``gitwright-contextual-diff``, looked up in
the bin directory of a local opam switch of the checkout.  Without them, the
worktree and contextual diff views report ``unavailable``.  They are invoked
for a bounded set of CWDs already observed in an authenticated Mesh snapshot.
This module never accepts a path from a client, does not run a shell, and does
not implement a Git command itself.
"""

import asyncio
import base64
from collections import OrderedDict, defaultdict
import hashlib
import hmac
import json
import math
from pathlib import Path
import secrets
import time


SOURCE = "ptyhost+proc"
NOT_COLLECTED = {"state": "not-collected"}
MAX_DIRECTORIES = 32
MAX_OUTPUT_BYTES = 262_144
OBSERVER_TIMEOUT_SECONDS = 3
MAX_OBSERVER_PROCESSES = 4
OBSERVER_SOURCE = "gitwright-worktree-observe@4ded2e0d"
DIFF_SOURCE = "gitwright-contextual-diff@04c1fcb"
DIFF_SELECTOR_TTL_SECONDS = 60
MAX_DIFF_SELECTORS = 256
MAX_DIFF_FILES = 128
MAX_DIFF_FILE_BYTES = 4096

# The selector is an opaque random handle plus a MAC.  Its binding lives only
# in this short, bounded in-memory table, so neither a CWD nor a session name
# is disclosed in a URL capability.
_diff_selectors = OrderedDict()


def observer_path(root):
    """Return the bootstrap-managed executable, never a PATH lookup."""
    return Path(root) / "_opam" / "bin" / "gitwright-worktree-observe"


def contextual_diff_path(root):
    """Return the bootstrap-managed contextual-diff binary, never PATH."""
    return Path(root) / "_opam" / "bin" / "gitwright-contextual-diff"


def _is_executable(path):
    try:
        return path.is_file() and bool(path.stat().st_mode & 0o111)
    except OSError:
        return False


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _agent(value):
    """Return the small, non-content agent projection, or None.

    The discovery object also has argv, transcript-derived text and a process
    id.  This projection must never accidentally make those fields part of the
    portfolio contract.
    """
    if not isinstance(value, dict):
        return None
    out = {}
    # ``name`` is intentionally excluded: discovery obtains it from agent
    # metadata, where it is not a closed Mesh-controlled vocabulary.  Status
    # is useful for an observed session inventory and is the only agent field
    # this projection needs.
    if isinstance(value.get("status"), str):
        out["status"] = value["status"]
    return out or None


def _session(value):
    """Whitelist one observed Mesh session, preserving its incarnation."""
    if not isinstance(value, dict):
        return None
    name = value.get("name")
    created = value.get("created")
    if not isinstance(name, str) or not name or not _number(created):
        return None
    out = {"id": value.get("id") if isinstance(value.get("id"), str) else name,
           "name": name, "created": created, "agent": _agent(value.get("agent"))}
    if _number(value.get("activity")):
        out["activity"] = value["activity"]
    return out


def observed_inventory(mesh_sessions, *, listed, observed_at):
    """Make a deterministic owner-only inventory from one session-list snapshot.

    ``listed=False`` is an unavailable observation, not an empty inventory.
    Unknown working directories stay visibly unlocated instead of being grouped
    under a guessed project.  Worktree and historical joins are deliberately
    represented as absent collection work, never inferred from a path.
    """
    if not listed:
        return {"observed_at": observed_at, "source": SOURCE,
                "mesh_sessions": {"state": "unavailable"},
                "worktrees": dict(NOT_COLLECTED),
                "historical_state": dict(NOT_COLLECTED)}

    directories = defaultdict(list)
    unlocated = []
    for raw in mesh_sessions if isinstance(mesh_sessions, list) else []:
        session = _session(raw)
        if session is None:
            continue
        cwd = raw.get("cwd") if isinstance(raw, dict) else None
        if isinstance(cwd, str) and cwd:
            directories[cwd].append(session)
        else:
            unlocated.append(session)

    rows = [{"cwd": cwd, "sessions": sorted(sessions, key=lambda s: (s["name"], s["created"]))}
            for cwd, sessions in sorted(directories.items())]
    return {"observed_at": observed_at, "source": SOURCE,
            "mesh_sessions": {"state": "observed", "directories": rows,
                              "unlocated": sorted(unlocated, key=lambda s: (s["name"], s["created"]))},
            "worktrees": dict(NOT_COLLECTED),
            "historical_state": dict(NOT_COLLECTED)}


def observed_cwds(inventory):
    """Closed, bounded CWD set from this snapshot; never from a request."""
    directories = inventory.get("mesh_sessions", {}).get("directories", [])
    if not isinstance(directories, list):
        return []
    return [row["cwd"] for row in directories[:MAX_DIRECTORIES]
            if isinstance(row, dict) and isinstance(row.get("cwd"), str) and row["cwd"]]


def _selector_mac(key, nonce, binding):
    body = json.dumps(binding, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(key, nonce.encode("ascii") + b"." + body, hashlib.sha256).digest()


def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def attach_diff_selectors(inventory, *, key, now=None):
    """Attach one short-lived opaque selector to each observed directory.

    A directory can have several Mesh sessions.  Binding the capability to the
    first deterministic session makes the CWD usable without accepting a
    client-selected session, while revalidation still rejects a replacement
    session with the same name.
    """
    now = time.time() if now is None else now
    expires = now + DIFF_SELECTOR_TTL_SECONDS
    directories = inventory.get("mesh_sessions", {}).get("directories", [])
    worktrees = inventory.get("worktrees", {})
    observed = {row.get("cwd") for row in worktrees.get("directories", [])
                if isinstance(row, dict) and row.get("state") == "observed"
                and isinstance(row.get("cwd"), str)} if isinstance(worktrees, dict) else set()
    if not isinstance(directories, list):
        return inventory
    for row in directories:
        sessions = row.get("sessions") if isinstance(row, dict) else None
        cwd = row.get("cwd") if isinstance(row, dict) else None
        if (not isinstance(cwd, str) or not cwd or cwd not in observed
                or not isinstance(sessions, list) or not sessions):
            continue
        session = sessions[0]
        if not isinstance(session, dict):
            continue
        name, created = session.get("name"), session.get("created")
        if not isinstance(name, str) or not name or not _number(created):
            continue
        nonce = secrets.token_urlsafe(24)
        binding = {"name": name, "created": created, "cwd": cwd, "expires": expires}
        mac = _b64(_selector_mac(key, nonce, binding))
        _diff_selectors[nonce] = binding
        _diff_selectors.move_to_end(nonce)
        row["diff_selector"] = f"{nonce}.{mac}"
    _prune_diff_selectors(now)
    return inventory


def _prune_diff_selectors(now):
    for nonce, binding in list(_diff_selectors.items()):
        if binding.get("expires", 0) < now:
            _diff_selectors.pop(nonce, None)
    while len(_diff_selectors) > MAX_DIFF_SELECTORS:
        _diff_selectors.popitem(last=False)


def resolve_diff_selector(selector, *, key, now=None):
    """Return an untrusted selector's binding only if its MAC and TTL hold."""
    now = time.time() if now is None else now
    if not isinstance(selector, str) or selector.count(".") != 1:
        return None
    nonce, encoded_mac = selector.split(".")
    binding = _diff_selectors.get(nonce)
    if binding is None or binding.get("expires", 0) < now:
        return None
    try:
        supplied = base64.urlsafe_b64decode(encoded_mac + "=" * (-len(encoded_mac) % 4))
    except (ValueError, UnicodeEncodeError):
        return None
    if not hmac.compare_digest(supplied, _selector_mac(key, nonce, binding)):
        return None
    return dict(binding)


def revalidate_diff_selector(selector, live_sessions, *, key, now=None):
    """Resolve only if ptyhost still has that exact session incarnation/CWD."""
    binding = resolve_diff_selector(selector, key=key, now=now)
    if binding is None or not isinstance(live_sessions, list):
        return None
    for session in live_sessions:
        if not isinstance(session, dict):
            continue
        if (session.get("name") == binding["name"] and session.get("created") == binding["created"]
                and session.get("cwd") == binding["cwd"]):
            return binding["cwd"]
    return None


def _worktree(value):
    if not isinstance(value, dict) or set(value) != {"path", "head", "branch", "detached", "bare"}:
        return None
    path = value.get("path")
    head = value.get("head")
    branch = value.get("branch")
    if (not isinstance(path, str) or not path or
            (head is not None and not isinstance(head, str)) or
            (branch is not None and not isinstance(branch, str)) or
            not isinstance(value.get("detached"), bool) or not isinstance(value.get("bare"), bool)):
        return None
    return {key: value[key] for key in ("path", "head", "branch", "detached", "bare")}


def parse_observer_output(raw):
    """Accept exactly the public closed JSON contract of the upstream binary."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {"state": "invalid-output"}
    if not isinstance(value, dict) or not isinstance(value.get("state"), str):
        return {"state": "invalid-output"}
    state = value["state"]
    if state in {"not-a-repository", "unavailable", "invalid-output"}:
        return {"state": state} if set(value) == {"state"} else {"state": "invalid-output"}
    if state != "observed" or set(value) != {"state", "worktrees"} or not isinstance(value["worktrees"], list):
        return {"state": "invalid-output"}
    worktrees = [_worktree(item) for item in value["worktrees"]]
    if any(item is None for item in worktrees):
        return {"state": "invalid-output"}
    return {"state": "observed", "worktrees": worktrees}


async def _run_observer(executable, cwd):
    """Run the one fixed observer with a small output/time budget."""
    if not _is_executable(executable):
        return {"state": "unavailable"}
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            str(executable), cwd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=MAX_OUTPUT_BYTES + 1)
        output = await asyncio.wait_for(proc.stdout.read(MAX_OUTPUT_BYTES + 1), OBSERVER_TIMEOUT_SECONDS)
        if len(output) > MAX_OUTPUT_BYTES:
            await _stop_process(proc)
            return {"state": "unavailable"}
        code = await asyncio.wait_for(proc.wait(), OBSERVER_TIMEOUT_SECONDS)
    except (OSError, asyncio.TimeoutError):
        if proc is not None:
            await _stop_process(proc)
        return {"state": "unavailable"}
    if code != 0:
        return {"state": "unavailable"}
    try:
        return parse_observer_output(output.decode("utf-8", "strict"))
    except UnicodeDecodeError:
        return {"state": "invalid-output"}


_INSTALLED_OBSERVER = _run_observer


def parse_contextual_diff_output(raw):
    """Accept only the small closed contract of gitwright-contextual-diff."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {"state": "invalid-output"}
    if not isinstance(value, dict) or not isinstance(value.get("state"), str):
        return {"state": "invalid-output"}
    state = value["state"]
    if state in {"not-a-repository", "unavailable", "invalid-output", "clean", "over-limit"}:
        return {"state": state} if set(value) == {"state"} else {"state": "invalid-output"}
    if state != "observed" or set(value) != {"state", "files", "unified"}:
        return {"state": "invalid-output"}
    files, unified = value.get("files"), value.get("unified")
    if not isinstance(files, list) or len(files) > MAX_DIFF_FILES or not isinstance(unified, str):
        return {"state": "invalid-output"}
    try:
        files_ok = all(isinstance(path, str) and path
                       and len(path.encode("utf-8", "strict")) <= MAX_DIFF_FILE_BYTES for path in files)
        # JSON permits lone surrogate escapes; they are not safe text for the
        # public contract and must remain a nonfact rather than causing a 500.
        unified.encode("utf-8", "strict")
    except UnicodeEncodeError:
        return {"state": "invalid-output"}
    if not files_ok:
        return {"state": "invalid-output"}
    return {"state": "observed", "files": files, "unified": unified}


async def _run_contextual_diff(executable, cwd):
    """Run only the fixed, read-only upstream diff executable under hard bounds."""
    if not _is_executable(executable):
        return {"state": "unavailable"}
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            str(executable), cwd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=MAX_OUTPUT_BYTES + 1)
        output = await asyncio.wait_for(proc.stdout.read(MAX_OUTPUT_BYTES + 1), OBSERVER_TIMEOUT_SECONDS)
        if len(output) > MAX_OUTPUT_BYTES:
            await _stop_process(proc)
            return {"state": "unavailable"}
        code = await asyncio.wait_for(proc.wait(), OBSERVER_TIMEOUT_SECONDS)
    except (OSError, asyncio.TimeoutError):
        if proc is not None:
            await _stop_process(proc)
        return {"state": "unavailable"}
    if code != 0:
        return {"state": "unavailable"}
    try:
        return parse_contextual_diff_output(output.decode("utf-8", "strict"))
    except UnicodeDecodeError:
        return {"state": "invalid-output"}


async def _stop_process(proc):
    """Best-effort bounded cleanup for a violated observer budget."""
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), 0.2)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), 0.2)
        except asyncio.TimeoutError:
            # The child is now outside this request's time budget.  Do not let
            # a pathological kernel wait turn a read-only listing into a hang.
            return


async def collect_worktrees(inventory, *, root, observed_at, runner=None):
    """Attach per-CWD Git facts to an existing owner snapshot.

    Failures stay per-directory and do not suppress the already observed Mesh
    inventory.  At most four fixed observers run at once: this is a bounded
    status projection, not a filesystem scan.
    """
    if inventory.get("mesh_sessions", {}).get("state") != "observed":
        inventory["worktrees"] = {"state": "unavailable", "source": OBSERVER_SOURCE,
                                   "observed_at": observed_at, "directories": []}
        return inventory
    executable = observer_path(root)
    runner = _run_observer if runner is None else runner
    if runner is _INSTALLED_OBSERVER and not _is_executable(executable):
        # The optional observer is not installed: one honest state, no per-CWD rows.
        inventory["worktrees"] = {"state": "unavailable", "source": OBSERVER_SOURCE,
                                   "observed_at": observed_at, "directories": []}
        return inventory
    semaphore = asyncio.Semaphore(MAX_OBSERVER_PROCESSES)

    async def observe(cwd):
        try:
            async with semaphore:
                result = await runner(executable, cwd)
        except Exception:  # observer failures must not leak diagnostics or break listing
            result = {"state": "unavailable"}
        row = {"cwd": cwd, "state": result.get("state", "invalid-output"),
               "source": OBSERVER_SOURCE, "observed_at": observed_at}
        if row["state"] == "observed" and isinstance(result.get("worktrees"), list):
            row["worktrees"] = result["worktrees"]
        return row

    directories = await asyncio.gather(*(observe(cwd) for cwd in observed_cwds(inventory)))
    inventory["worktrees"] = {"state": "observed", "source": OBSERVER_SOURCE,
                               "observed_at": observed_at, "directories": directories}
    return inventory
