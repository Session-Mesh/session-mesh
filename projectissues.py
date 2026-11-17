# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Explicit owner reads of configured issue sources; never a workflow mutation.

The owner-selected source URL fixes the host/repository. Browser input can only
choose a bounded page, and source settings are checked again before publication.
"""
import asyncio
from datetime import datetime, timezone
import json
import re
import shutil
from urllib.parse import urlsplit, quote

from aiohttp import web
from projectartifacts import Reader as NativeReader, Refusal, CONTEXT, pairs, identifier

KEY = web.AppKey("project_issue_reader", object)
LIMIT = 25
MAX_BYTES = 2 * 1024 * 1024


def query(value):
    if not isinstance(value, dict) or set(value) != set(CONTEXT) | {"page"}:
        raise ValueError("fields")
    if not all(identifier(value.get(k)) for k in ("machine_id", "project_id", "source_id")):
        raise ValueError("identity")
    if not isinstance(value.get("boot"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["boot"]):
        raise ValueError("boot")
    if not isinstance(value.get("revision"), str) or not re.fullmatch(r"cfg1_[a-f0-9]{64}", value["revision"]):
        raise ValueError("revision")
    if type(value.get("page")) is not int or not 1 <= value["page"] <= 20:
        raise ValueError("page")
    return value


def repository(source):
    kind = source.get("kind")
    if kind not in ("github", "gitlab"):
        raise Refusal("unsupported", "issue-provider-unavailable")
    url = urlsplit(source.get("url", ""))
    # First finite adapters use the matching public forge and its CLI credentials.
    expected = "github.com" if kind == "github" else "gitlab.com"
    if url.scheme != "https" or url.netloc != expected or url.query or url.fragment:
        raise Refusal("unsupported", "issue-source-unavailable")
    parts = url.path.strip("/").split("/")
    if kind == "github" and len(parts) == 3 and parts[-1] == "issues":
        parts.pop()
    if kind == "gitlab" and parts[-2:] == ["-", "issues"]:
        parts = parts[:-2]
    if len(parts) < 2 or kind == "github" and len(parts) != 2 or not all(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", p) and p not in (".", "..") for p in parts):
        raise Refusal("unsupported", "issue-source-unavailable")
    return kind, expected, "/".join(parts)


def text(value, limit):
    if not isinstance(value, str):
        raise ValueError("text")
    return "".join(c for c in value if ord(c) >= 32 or c in "\n\r\t")[:limit]


def native_identity(row, kind):
    def stable_id(value):
        return str(value) if type(value) is int and 0 < value < 2**64 else None
    issue_id = stable_id(row.get("id"))
    if issue_id is None:
        return None
    node_id = row.get("node_id") if kind == "github" else None
    if not isinstance(node_id, str) or not re.fullmatch(r"[A-Za-z0-9_+/=:-]{1,240}", node_id):
        node_id = None
    return {"host": kind + ".com", "issue_id": issue_id, "node_id": node_id,
            "project_id": stable_id(row.get("project_id")) if kind == "gitlab" else None}


def issue(row, kind, repo):
    number = row.get("number" if kind == "github" else "iid")
    if type(number) is not int or not 1 <= number < 2**53:
        raise ValueError("number")
    state = text(row.get("state"), 80)
    labels = []
    for label in (row["labels"] if isinstance(row.get("labels"), list) else [])[:32]:
        try:
            name = text(label.get("name") if isinstance(label, dict) else label, 240)
            color = label.get("color", "") if isinstance(label, dict) else ""
            labels.append({"name": name, **({"color": "#" + color.lstrip("#")} if isinstance(color, str) and re.fullmatch(r"#?[a-fA-F0-9]{6}", color) else {})})
        except (ValueError, AttributeError):
            continue
    assignees = []
    for person in (row["assignees"] if isinstance(row.get("assignees"), list) else [])[:20]:
        try:
            assignees.append(text(person.get("login" if kind == "github" else "username"), 240))
        except (ValueError, AttributeError):
            continue
    reason = row.get("state_reason")
    column = "todo" if state in ("open", "opened") else "cancelled" if state == "closed" and reason == "not_planned" else "done" if state == "closed" else "unknown"
    description = row.get("body" if kind == "github" else "description")
    return {"id": str(number), "native_identity": native_identity(row, kind), "title": text(row.get("title"), 240), "state": state,
            "column": column, "labels": labels, "assignees": assignees, "priority": None,
            "description": text(description, 32768) if isinstance(description, str) else None,
            "description_truncated": isinstance(description, str) and len(description) > 32768,
            "updated_at": text(row.get("updated_at", ""), 80),
            "url": f"https://{kind}.com/{repo}/" + ("issues/" if kind == "github" else "-/issues/") + str(number)}


async def command(executable, arguments):
    if not executable:
        raise Refusal("unsupported", "issue-cli-unavailable")
    # Reuse the bounded runner's process-group ownership and output budget.
    runner = NativeReader(None)
    return await runner.run(executable, arguments, allow_list=True)


class Reader:
    def __init__(self, host):
        self.native = NativeReader(host)
        self.active = 0

    async def source(self, body):
        # An explicit authenticated owner read is distinct from the Roster-only
        # background observation plan; its grant is this exact configured URL.
        settings = await self.native.settings(body, {"kind": "source", "source_id": body["source_id"]})
        source = settings.get("source", {})
        if settings.get("kind") != "source" or source.get("id") != body["source_id"]:
            raise Refusal("refused", "unknown-source")
        return repository(source)

    async def collect(self, body):
        kind, host, repo = before = await self.source(body)
        page = body["page"]
        if kind == "github":
            executable = shutil.which("gh")
            endpoint = f"repos/{repo}/issues?state=all&sort=updated&direction=desc&per_page={LIMIT}&page={page}"
            args = ["api", "--hostname", host, "--method", "GET", endpoint]
        else:
            executable = shutil.which("glab")
            endpoint = f"projects/{quote(repo, safe='')}/issues?scope=all&state=all&order_by=updated_at&sort=desc&per_page={LIMIT}&page={page}"
            args = ["api", "--hostname", host, "--method", "GET", endpoint]
        try:
            raw = await command(executable, args)
        except Refusal as error:
            if error.status == "unsupported":
                raise Refusal("unsupported", "issue-cli-unavailable") from error
            raise Refusal("unavailable", "issue-read-unavailable") from error
        if not isinstance(raw, list) or len(raw) > LIMIT:
            raise ValueError("items")
        items, partial = [], False
        for row in raw:
            if not isinstance(row, dict):
                partial = True
                continue
            if kind == "github" and "pull_request" in row:
                continue
            try:
                items.append(issue(row, kind, repo))
            except (ValueError, TypeError, AttributeError):
                partial = True
        if await self.source(body) != before:
            raise Refusal("stale", "source-changed")
        return {"provider": kind, "repository": repo, "items": items, "partial": partial,
                "has_more": len(raw) == LIMIT and page < 20,
                "page": page, "observed_at": datetime.now(timezone.utc).isoformat()}

    async def request(self, body, transport=None):
        reply = {"kind": "mesh-project-issues-reply", "version": 1, **{k: body[k] for k in CONTEXT}, "page": body["page"]}
        if self.active >= 2:
            return dict(reply, status="unavailable", code="issue-reader-busy")
        self.active += 1
        operation = asyncio.create_task(self.collect(body))

        async def disconnected():
            while transport is not None and not transport.is_closing():
                await asyncio.sleep(.1)
            if transport is not None:
                raise Refusal("cancelled", "issue-reader-disconnected")
            await asyncio.Future()

        watcher = asyncio.create_task(disconnected())
        try:
            async with asyncio.timeout(20):
                await asyncio.wait((operation, watcher), return_when=asyncio.FIRST_COMPLETED)
                if watcher.done():
                    await watcher
                return dict(reply, status="ok", issues=await operation)
        except TimeoutError:
            return dict(reply, status="unavailable", code="issue-reader-deadline")
        except Refusal as error:
            return dict(reply, status=error.status, code=error.code)
        except (ValueError, TypeError, AttributeError, OSError, RecursionError):
            return dict(reply, status="unavailable", code="issue-reader-invalid")
        finally:
            for task in (operation, watcher):
                if not task.done():
                    task.cancel()
            await asyncio.gather(operation, watcher, return_exceptions=True)
            self.active -= 1


async def handle(request):
    raw = bytearray()
    async for chunk in request.content.iter_chunked(4096):
        raw.extend(chunk)
        if len(raw) > 8192:
            raise web.HTTPRequestEntityTooLarge(max_size=8192, actual_size=len(raw))
    try:
        body = query(json.loads(raw, object_pairs_hook=pairs))
    except (ValueError, UnicodeError, RecursionError):
        raise web.HTTPBadRequest(text="Invalid project issue request") from None
    reply = await request.app[KEY].request(body, request.transport)
    wire = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "backslashreplace")
    if len(wire) > MAX_BYTES:
        reply.pop("issues", None)
        reply.update(status="unavailable", code="issue-result-capacity")
        wire = json.dumps(reply).encode()
    return web.Response(body=wire, content_type="application/json", headers={"Cache-Control": "no-store"})
