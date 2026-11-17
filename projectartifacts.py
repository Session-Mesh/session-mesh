# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Owner-only public Roster pages, scoped by fresh native project settings.

The board/tasks/<mission> rule is an explicit owner-approved artifact grant.
Neither producer tokens nor document paths can enlarge that configured scope.
"""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat

from aiohttp import web

REQUEST_BYTES = 24576
OUTPUT_BYTES = 2 * 1024 * 1024
REPLY_BYTES = OUTPUT_BYTES + 4096
DEADLINE = 30
SCHEMA = {"id": "https://github.com/mathiasbourgoin/roster/schema/artifact-observation/v1",
          "digest": "9f387ff919be0af0de07d2f44084c3a99c5ceb818ae224c232e3aaf2d33d45bb"}
CONTEXT = ("boot", "machine_id", "project_id", "source_id", "revision")
READER = web.AppKey("project_artifact_reader", object)


class Refusal(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value)


def query(value):
    if not isinstance(value, dict) or set(value) - set(CONTEXT) - {"kind", "roadmap_task_id", "ref", "cursor"}:
        raise ValueError("fields")
    if not all(identifier(value.get(k)) for k in ("machine_id", "project_id", "source_id")):
        raise ValueError("identity")
    if not isinstance(value.get("boot"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["boot"]):
        raise ValueError("boot")
    if not isinstance(value.get("revision"), str) or not re.fullmatch(r"cfg1_[a-f0-9]{64}", value["revision"]):
        raise ValueError("revision")
    if value.get("kind") not in ("artifact-list", "artifact-read"):
        raise ValueError("kind")
    if "roadmap_task_id" in value and not identifier(value["roadmap_task_id"]):
        raise ValueError("mission")
    for name, limit in (("ref", 4096), ("cursor", 8192)):
        if name in value and (not isinstance(value[name], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1," + str(limit) + "}", value[name])):
            raise ValueError("token")
    if (value["kind"] == "artifact-read") != ("ref" in value):
        raise ValueError("reference")
    return value


def safe_root(value):
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise Refusal("refused", "unsafe-source")
    root = Path(value)
    if ".." in root.parts:
        raise Refusal("refused", "unsafe-source")
    try:
        for parent in [*reversed(root.parents), root]:
            if not stat.S_ISDIR(parent.lstat().st_mode):
                raise Refusal("refused", "unsafe-source")
    except OSError:
        raise Refusal("unavailable", "source-unavailable") from None
    return str(root)


def producer_source(root, task):
    wire = json.dumps(["artifact-source/v1", root, "task", task], ensure_ascii=False, separators=(",", ":"))
    return {"id": hashlib.sha256(wire.encode()).hexdigest(), "scope": "task", "task": task}


class Reader:
    def __init__(self, host):
        self.host = host
        self.active = 0

    async def settings(self, body, target):
        reply = await self.host({"version": 1, "op": "project_read", "project_id": body["project_id"], "settings": target})
        if not isinstance(reply, dict) or reply.get("kind") != "mesh-project-reply" or reply.get("version") != 1 or reply.get("op") != "project_read":
            raise Refusal("unavailable", "native-unavailable")
        if reply.get("status") != "ok":
            raise Refusal("refused", "native-refused")
        if any(reply.get(k) != body[k] for k in ("boot", "machine_id", "revision")) or reply.get("project", {}).get("id") != body["project_id"]:
            raise Refusal("stale", "context-changed")
        return reply.get("observation_settings", {})

    async def scope(self, body):
        project = await self.settings(body, {"kind": "project"})
        if project.get("kind") != "project" or not isinstance(project.get("plan"), dict) or not isinstance(project["plan"].get("source_ids"), list) or body["source_id"] not in project["plan"]["source_ids"]:
            raise Refusal("refused", "source-disabled")
        settings = await self.settings(body, {"kind": "source", "source_id": body["source_id"]})
        source = settings.get("source", {})
        if settings.get("kind") != "source" or source.get("id") != body["source_id"] or source.get("kind") != "roster":
            raise Refusal("refused", "unknown-source")
        selector = source.get("selector")
        if not isinstance(selector, dict) or selector.get("kind") not in ("board", "pipeline"):
            raise Refusal("unsupported", "artifact-selector-unavailable")
        return selector

    async def run(self, executable, args, *, allow_list=False):
        if not executable or not os.path.isabs(executable):
            raise Refusal("unsupported", "roster-runtime-unavailable")
        try:
            proc = await asyncio.create_subprocess_exec(executable, *args, stdout=asyncio.subprocess.PIPE,
                                                       stderr=asyncio.subprocess.PIPE, start_new_session=True)
        except OSError:
            raise Refusal("unsupported", "roster-runtime-unavailable") from None

        async def read(stream, limit):
            chunks, size = [], 0
            while chunk := await stream.read(min(65536, limit + 1 - size)):
                size += len(chunk)
                if size > limit:
                    raise Refusal("failed", "producer-output-limit")
                chunks.append(chunk)
            return b"".join(chunks)

        stdout = asyncio.create_task(read(proc.stdout, OUTPUT_BYTES))
        stderr = asyncio.create_task(read(proc.stderr, 8192))
        try:
            out, _, code = await asyncio.gather(stdout, stderr, proc.wait())
            if code:
                raise Refusal("unavailable", "producer-refused")
            try:
                result = json.loads(out.decode("utf-8"), object_pairs_hook=pairs)
                if not isinstance(result, dict) and not (allow_list and isinstance(result, list)):
                    raise ValueError("envelope")
                return result
            except (ValueError, UnicodeError, RecursionError):
                raise Refusal("failed", "producer-invalid") from None
        finally:
            # The private process group also owns descendants after its leader exits.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            for task in (stdout, stderr):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stdout, stderr, return_exceptions=True)
            await proc.wait()

    async def board(self, selector, body):
        mission = body.get("roadmap_task_id")
        if not mission:
            raise Refusal("refused", "roadmap-task-required")
        root = safe_root(selector.get("path"))
        view = await self.run(os.environ.get("MESH_PROJECT_ROSTER_CLI"), ["view", root, "--events", "0", "--task", mission])
        if view.get("schema_version") != 1 or view.get("kind") != "roster-roadmap-view" or not isinstance(view.get("version"), str) or [t.get("id") for t in view.get("tasks", [])] != [mission]:
            raise Refusal("refused", "roadmap-task-unavailable")
        return safe_root(str(Path(root) / "tasks" / mission)), view["version"]

    def artifact(self, value, kind, root, task):
        if value.get("schema_version") != 1 or value.get("kind") != kind or value.get("schema") != SCHEMA or value.get("source") != producer_source(root, task) or not isinstance(value.get("data"), dict):
            raise Refusal("failed", "producer-context-mismatch")
        return value

    async def discover(self, executable, root, task, body):
        cursor = None
        # Public task scans admit at most 10000 names, each with 14 canonical slots.
        # The shared 30s deadline also bounds all calls; retain only one page.
        for _ in range(5601):
            args = ["artifact-list", "--root", root, "--scope", "task"]
            if task is not None:
                args += ["--task", task]
            args += ["--limit", "25"]
            if cursor:
                args += ["--cursor", cursor]
            page = self.artifact(await self.run(executable, args), "artifact-list", root, task)
            for item in page["data"].get("items", []):
                if item.get("body", {}).get("ref") == body["ref"]:
                    selected = item.get("task")
                    if not isinstance(selected, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", selected) or (task is not None and selected != task):
                        raise Refusal("failed", "producer-context-mismatch")
                    return selected
            next_cursor = page["data"].get("next_cursor")
            if not next_cursor:
                raise Refusal("refused", "stale-reference")
            if next_cursor == cursor or not isinstance(next_cursor, str) or len(next_cursor) > 8192:
                raise Refusal("failed", "producer-invalid")
            cursor = next_cursor
        raise Refusal("failed", "producer-output-limit")

    async def collect(self, body):
        selector = await self.scope(body)
        if selector["kind"] == "board":
            root, board_version = await self.board(selector, body)
            task = None
        else:
            if "roadmap_task_id" in body:
                raise Refusal("refused", "selector-mismatch")
            root, task = safe_root(selector.get("root")), selector.get("task")
            if not isinstance(task, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", task):
                raise Refusal("refused", "selector-mismatch")
            board_version = None
        executable = os.environ.get("MESH_PROJECT_ROSTER_PIPELINE_CLI")
        try:
            caps = await self.run(executable, ["artifact-capabilities"])
        except Refusal as error:
            if error.code == "producer-refused":
                raise Refusal("unsupported", "artifact-capability-unavailable") from None
            raise
        if caps.get("schema_version") != 1 or caps.get("kind") != "artifact-capabilities" or caps.get("schema") != SCHEMA or caps.get("source") is not None or caps.get("data", {}).get("reference_version") != 1 or caps.get("data", {}).get("cursor_version") != 1:
            raise Refusal("unsupported", "artifact-capability-unavailable")
        if body["kind"] == "artifact-read":
            task = await self.discover(executable, root, task, body)
        args = [body["kind"], "--root", root, "--scope", "task"]
        if task is not None:
            args += ["--task", task]
        args += ["--ref", body["ref"], "--page-bytes", "131072"] if body["kind"] == "artifact-read" else ["--limit", "25"]
        if "cursor" in body:
            args += ["--cursor", body["cursor"]]
        kind = "artifact-page" if body["kind"] == "artifact-read" else "artifact-list"
        result = self.artifact(await self.run(executable, args), kind, root, task)
        if await self.scope(body) != selector:
            raise Refusal("stale", "context-changed")
        if board_version is not None and (await self.board(selector, body))[1] != board_version:
            raise Refusal("stale", "roadmap-changed")
        return result

    async def request(self, body, transport):
        reply = {k: body[k] for k in (*CONTEXT, "roadmap_task_id") if k in body}
        reply.update(kind="mesh-project-artifact-reply", version=1)
        if self.active >= 2:
            return dict(reply, status="busy", code="reader-capacity")
        self.active += 1
        operation = asyncio.create_task(self.collect(body))

        async def disconnected():
            while transport is not None and not transport.is_closing():
                await asyncio.sleep(.05)
            if transport is not None:
                raise Refusal("cancelled", "reader-disconnected")
            await asyncio.Future()

        watcher = asyncio.create_task(disconnected())
        try:
            async with asyncio.timeout(DEADLINE):
                await asyncio.wait((operation, watcher), return_when=asyncio.FIRST_COMPLETED)
                if watcher.done():
                    await watcher
                return dict(reply, status="ok", artifact=await operation)
        except TimeoutError:
            return dict(reply, status="cancelled", code="reader-deadline")
        except Refusal as error:
            return dict(reply, status=error.status, code=error.code)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            return dict(reply, status="failed", code="reader-invalid")
        finally:
            for task in (operation, watcher):
                if not task.done():
                    task.cancel()
            await asyncio.gather(operation, watcher, return_exceptions=True)
            self.active -= 1


async def handle(request):
    data = bytearray()
    async for chunk in request.content.iter_chunked(16384):
        if len(data) + len(chunk) > REQUEST_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=REQUEST_BYTES, actual_size=len(data) + len(chunk))
        data.extend(chunk)
    try:
        body = query(json.loads(data, object_pairs_hook=pairs))
    except (ValueError, UnicodeError, RecursionError):
        raise web.HTTPBadRequest(text="Invalid project request") from None
    reply = await request.app[READER].request(body, request.transport)
    # Match the public UTF-8 wire; escaped surrogate metadata remains JSON data.
    wire = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "backslashreplace")
    if len(wire) > REPLY_BYTES:
        reply.pop("artifact", None)
        reply.update(status="failed", code="result-capacity")
        wire = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return web.Response(body=wire, content_type="application/json", headers={"Cache-Control": "no-store"})
