# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Owner-only public Roster artifacts retain native configured source authority."""


import copy
import hashlib
import json

import pytest
import server


async def test_artifact_route_rejects_missing_context(client, auth_cookie):
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json={})
    assert response.status == 400

CONTEXT = dict(project_id="project_one", source_id="roster", boot="a" * 64,
               machine_id="machine_one", revision="cfg1_" + "b" * 64)
SCHEMA = dict(id="https://github.com/mathiasbourgoin/roster/schema/artifact-observation/v1",
              digest="9f387ff919be0af0de07d2f44084c3a99c5ceb818ae224c232e3aaf2d33d45bb")


def source_identity(root, task):
    value = json.dumps(["artifact-source/v1", str(root), "task", task], separators=(",", ":"))
    return dict(id=hashlib.sha256(value.encode()).hexdigest(), scope="task", task=task)


@pytest.fixture
def native_scope(tmp_path, monkeypatch):
    root = tmp_path / "pipeline"
    root.mkdir()
    state = dict(enabled=True, revision=CONTEXT["revision"],
                 selector=dict(kind="pipeline", root=str(root), task="build-cache"), calls=[])

    async def host(body):
        state["calls"].append(copy.deepcopy(body))
        assert body["op"] == "project_read"
        reply = dict(kind="mesh-project-reply", version=1, op="project_read", status="ok",
                     boot=CONTEXT["boot"], machine_id=CONTEXT["machine_id"], revision=state["revision"],
                     project=dict(id=CONTEXT["project_id"]))
        if body["settings"]["kind"] == "project":
            reply["observation_settings"] = dict(kind="project", plan=dict(
                repository=False, source_ids=["roster"] if state["enabled"] else []))
        else:
            reply["observation_settings"] = dict(kind="source", source=dict(
                id="roster", kind="roster", label="Configured", selector=state["selector"]))
        return reply

    monkeypatch.setattr(server, "host", host)
    return root, state


@pytest.fixture
def public_runtime(native_scope, monkeypatch):
    import projectartifacts
    root, state = native_scope
    calls = []
    envelope = dict(schema_version=1, kind="artifact-list", schema=SCHEMA,
                    source=source_identity(root, "build-cache"), data=dict(items=[], next_cursor=None))

    async def run(self, executable, args):
        calls.append((executable, args))
        if args[0] == "artifact-capabilities":
            return dict(schema_version=1, kind="artifact-capabilities", schema=SCHEMA,
                        source=None, data=dict(reference_version=1, cursor_version=1))
        return copy.deepcopy(envelope)

    monkeypatch.setenv("MESH_PROJECT_ROSTER_PIPELINE_CLI", "/private/pipeline")
    monkeypatch.setenv("MESH_PROJECT_ROSTER_CLI", "/private/roadmap")
    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    return calls, envelope


async def test_native_scope_and_public_reply_survive_unchanged(client, auth_cookie, native_scope, public_runtime):
    calls, envelope = public_runtime
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    assert response.status == 200
    reply = await response.json()
    assert reply == dict(CONTEXT, kind="mesh-project-artifact-reply", version=1, status="ok", artifact=envelope)
    assert len(native_scope[1]["calls"]) == 4
    assert calls[-1][1] == ["artifact-list", "--root", str(native_scope[0]), "--scope", "task",
                            "--task", "build-cache", "--limit", "25"]


@pytest.mark.parametrize("field,value", [("root", "/etc"), ("task", "foreign"),
    ("scope", "project"), ("executable", "/bin/sh"), ("page_bytes", 999999),
    ("roadmap_task_id", "../VA"), ("ref", "x" * 4097), ("cursor", "x" * 8193)])
async def test_caller_cannot_supply_authority_or_oversized_tokens(client, auth_cookie, field, value):
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list", **{field: value}))
    assert response.status == 400


async def test_disabled_source_refuses_without_running_public_code(client, auth_cookie, native_scope, public_runtime):
    native_scope[1]["enabled"] = False
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    reply = await response.json()
    assert reply["status"] == "refused" and "artifact" not in reply
    assert public_runtime[0] == []


async def test_configuration_changed_during_read_cannot_publish(client, auth_cookie, native_scope, public_runtime, monkeypatch):
    import projectartifacts
    original = projectartifacts.Reader.run

    async def run(self, executable, args):
        result = await original(self, executable, args)
        if args[0] == "artifact-list":
            native_scope[1]["revision"] = "cfg1_" + "c" * 64
        return result

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    reply = await response.json()
    assert reply["status"] == "stale" and "artifact" not in reply


async def test_board_task_uses_public_membership_and_only_literal_descendant(client, auth_cookie, native_scope, monkeypatch):
    import projectartifacts
    root, state = native_scope
    task_root = root / "tasks" / "VA"
    task_root.mkdir(parents=True)
    state["selector"] = dict(kind="board", path=str(root))
    calls = []

    async def run(self, executable, args):
        calls.append(args)
        if args[0] == "view":
            return dict(schema_version=1, kind="roster-roadmap-view", version="board-version",
                        tasks=[dict(id="VA")])
        if args[0] == "artifact-capabilities":
            return dict(schema_version=1, kind="artifact-capabilities", schema=SCHEMA,
                        source=None, data=dict(reference_version=1, cursor_version=1))
        return dict(schema_version=1, kind="artifact-list", schema=SCHEMA,
                    source=source_identity(task_root, None), data=dict(items=[], next_cursor=None))

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    monkeypatch.setenv("MESH_PROJECT_ROSTER_PIPELINE_CLI", "/private/pipeline")
    monkeypatch.setenv("MESH_PROJECT_ROSTER_CLI", "/private/roadmap")
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list", roadmap_task_id="VA"))
    reply = await response.json()
    assert reply["status"] == "ok" and reply["roadmap_task_id"] == "VA"
    assert [a for a in calls if a[0] == "artifact-list"][0] == ["artifact-list", "--root", str(task_root), "--scope", "task", "--limit", "25"]
    assert len([a for a in calls if a[0] == "view"]) == 2


async def test_unknown_board_mission_cannot_select_a_real_directory(client, auth_cookie, native_scope, monkeypatch):
    import projectartifacts
    root, state = native_scope
    (root / "tasks" / "foreign").mkdir(parents=True)
    state["selector"] = dict(kind="board", path=str(root))

    async def run(self, executable, args):
        assert args[0] == "view"
        return dict(schema_version=1, kind="roster-roadmap-view", version="current", tasks=[dict(id="VA")])

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list", roadmap_task_id="foreign"))
    reply = await response.json()
    assert reply["status"] == "refused" and "artifact" not in reply


async def test_symlink_task_directory_refused_before_artifact_read(client, auth_cookie, native_scope, monkeypatch):
    import projectartifacts
    root, state = native_scope
    (root / "tasks").mkdir()
    (root / "tasks" / "VA").symlink_to(root, target_is_directory=True)
    state["selector"] = dict(kind="board", path=str(root))

    async def run(self, executable, args):
        assert args[0] == "view"
        return dict(schema_version=1, kind="roster-roadmap-view", version="current", tasks=[dict(id="VA")])

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list", roadmap_task_id="VA"))
    reply = await response.json()
    assert reply["status"] == "refused" and reply["code"] == "unsafe-source" and "artifact" not in reply


async def test_actual_public583_all_slots_and_complete_unicode_body(client, auth_cookie, native_scope):
    import os
    executable = os.environ.get("MESH_PROJECT_ROSTER_PIPELINE_CLI")
    if not executable:
        pytest.skip("optional public Roster runtime not configured")
    root, _ = native_scope
    (root / "specs").mkdir()
    body = "\ufeff# Full canonical document\n" + ("café 🌍 中文 <script>inert()</script> \" \\ \n" * 6000)
    (root / "specs" / "build-cache.md").write_text(body)
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    listing = await response.json()
    assert listing["status"] == "ok", listing
    items = listing["artifact"]["data"]["items"]
    assert len(items) == 14
    assert {i["kind"] for i in items} == {"spec", "intake", "spec-result", "plan", "plan-data", "implementer-brief", "reviewer-brief", "qa-scope", "implementation", "review", "qa-state", "qa", "ledger", "manifest"}
    item = next(i for i in items if i["kind"] == "spec")
    assert item["body"]["total_bytes"] == len(body.encode()) > 131072
    ref = item["body"]["ref"]
    cursor, assembled, pages = None, bytearray(), 0
    while True:
        request = dict(CONTEXT, kind="artifact-read", ref=ref)
        if cursor:
            request["cursor"] = cursor
        response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json=request)
        reply = await response.json()
        assert reply["status"] == "ok", reply
        artifact = reply["artifact"]
        assert artifact["schema"] == SCHEMA and artifact["source"] == source_identity(root, "build-cache")
        data = artifact["data"]
        assert data["ref"] == ref and data["sha256"] == item["body"]["sha256"]
        assert data["total_bytes"] == len(body.encode()) and data["range"]["start"] == len(assembled)
        assembled.extend(data["text"].encode())
        assert data["range"]["end"] == len(assembled)
        pages += 1
        cursor = data["next_cursor"]
        if data["eof"]:
            assert cursor is None
            break
        assert cursor and pages < 129
    assert pages >= 2 and bytes(assembled) == body.encode()
    assert hashlib.sha256(assembled).hexdigest() == item["body"]["sha256"]
    (root / "specs" / "build-cache.md").write_text("changed")
    stale = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                              json=dict(CONTEXT, kind="artifact-read", ref=ref))
    assert (await stale.json())["status"] == "refused"


async def test_real_board_scope_and_ref_reject_cross_board(client, auth_cookie, native_scope):
    import os
    import projectartifacts
    executable = os.environ.get("MESH_PROJECT_ROSTER_CLI")
    if not executable:
        pytest.skip("optional public Roster runtime not configured")
    root, state = native_scope
    board_root = root / "board"
    reader = projectartifacts.Reader(None)
    await reader.run(executable, ["init", str(board_root), "--id", "private-reader"])
    roadmap = board_root / "roadmap.json"
    contract = json.loads(roadmap.read_text())
    contract["tasks"] = [dict(id="VA", objective="Private read fixture")]
    roadmap.write_text(json.dumps(contract))
    task_root = board_root / "tasks" / "VA"
    (task_root / "specs").mkdir(parents=True)
    text = "# Actual board task document\n" + "Full public body 🌍\n" * 300
    (task_root / "specs" / "reader.md").write_text(text)
    state["selector"] = dict(kind="board", path=str(board_root))
    request = dict(CONTEXT, kind="artifact-list", roadmap_task_id="VA")
    listing = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json=request)).json()
    assert listing["status"] == "ok", listing
    item = next(i for i in listing["artifact"]["data"]["items"] if i["kind"] == "spec")
    request.update(kind="artifact-read", ref=item["body"]["ref"])
    read = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json=request)).json()
    assert read["status"] == "ok", read
    assert read["artifact"]["source"] == source_identity(task_root, "reader")
    assert read["artifact"]["data"]["text"] == text
    # Another authorized board with an identical task and bytes still cannot use this ref.
    other = root / "other"
    await reader.run(executable, ["init", str(other), "--id", "private-other"])
    (other / "roadmap.json").write_text(json.dumps(dict(contract, id="private-other")))
    (other / "tasks" / "VA" / "specs").mkdir(parents=True)
    (other / "tasks" / "VA" / "specs" / "reader.md").write_text(text)
    state["selector"] = dict(kind="board", path=str(other))
    crossed = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json=request)).json()
    assert crossed["status"] == "refused" and "artifact" not in crossed


async def test_body_limit_and_duplicate_fields(client, auth_cookie):
    oversized = await client.post('/api/projects/artifacts/v1', headers=auth_cookie, data=b" " * 24577)
    assert oversized.status == 413
    duplicate = json.dumps(dict(CONTEXT, kind="artifact-list"))[:-1] + ',"kind":"artifact-list"}'
    assert (await client.post('/api/projects/artifacts/v1', headers=auth_cookie, data=duplicate)).status == 400


async def test_two_owned_operations_busy_and_cancel_settle(monkeypatch):
    import asyncio
    import projectartifacts
    reader = projectartifacts.Reader(None)
    entered = []
    settled = []

    async def collect(body):
        entered.append(body)
        try:
            await asyncio.Future()
        finally:
            settled.append(body)

    monkeypatch.setattr(reader, "collect", collect)
    first = asyncio.create_task(reader.request(dict(CONTEXT), None))
    second = asyncio.create_task(reader.request(dict(CONTEXT), None))
    for _ in range(10):
        if len(entered) == 2:
            break
        await asyncio.sleep(0)
    assert len(entered) == 2
    busy = await reader.request(dict(CONTEXT), None)
    assert busy["status"] == "busy" and "artifact" not in busy
    first.cancel()
    second.cancel()
    results = await asyncio.gather(first, second, return_exceptions=True)
    assert all(isinstance(result, asyncio.CancelledError) for result in results)
    assert len(settled) == 2 and reader.active == 0


async def test_owned_child_cancellation_kills_and_settles(tmp_path):
    import asyncio
    import os
    import sys
    import projectartifacts
    pidfile = tmp_path / "child-pid"
    child = tmp_path / "wait.py"
    child.write_text("import os,time\nfrom pathlib import Path\nPath(" + repr(str(pidfile)) + ").write_text(str(os.getpid()))\ntime.sleep(60)\n")
    reader = projectartifacts.Reader(None)
    pending = asyncio.create_task(reader.run(sys.executable, [str(child)]))
    for _ in range(100):
        if pidfile.exists():
            break
        await asyncio.sleep(.01)
    assert pidfile.exists()
    pid = int(pidfile.read_text())
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 2)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


async def test_deadline_and_disconnect_retire_operation(monkeypatch):
    import asyncio
    import projectartifacts
    from types import SimpleNamespace
    reader = projectartifacts.Reader(None)
    settled = []

    async def collect(body):
        try:
            await asyncio.Future()
        finally:
            settled.append(True)

    monkeypatch.setattr(reader, "collect", collect)
    monkeypatch.setattr(projectartifacts, "DEADLINE", .03)
    timed = await reader.request(dict(CONTEXT), None)
    assert timed["status"] == "cancelled" and timed["code"] == "reader-deadline"
    assert settled == [True] and reader.active == 0
    closed = await reader.request(dict(CONTEXT), SimpleNamespace(is_closing=lambda: True))
    assert closed["status"] == "cancelled" and closed["code"] == "reader-disconnected"
    assert settled == [True, True] and reader.active == 0


@pytest.mark.parametrize("script,reason", [
    ("import sys;sys.stdout.buffer.write(b'x'*(2*1024*1024+1))", "producer-output-limit"),
    ("print('{not JSON}')", "producer-invalid"),
    ("import sys;sys.stderr.write('secret path');sys.exit(2)", "producer-refused")])
async def test_public_process_output_is_bounded_and_errors_not_exposed(script, reason):
    import sys
    import projectartifacts
    reader = projectartifacts.Reader(None)
    with pytest.raises(projectartifacts.Refusal) as error:
        await reader.run(sys.executable, ["-c", script])
    assert error.value.code == reason


@pytest.mark.parametrize("field,value", [("boot", "c" * 64), ("machine_id", "foreign"),
    ("revision", "cfg1_" + "c" * 64), ("project_id", "foreign")])
async def test_wrong_original_native_context_never_runs_producer(client, auth_cookie, native_scope, public_runtime, field, value):
    request = dict(CONTEXT, kind="artifact-list", **{field: value})
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie, json=request)).json()
    assert reply["status"] == "stale" and "artifact" not in reply
    assert public_runtime[0] == []


async def test_optional_missing_runtime_preserves_closed_source_local_failure(client, auth_cookie, native_scope, monkeypatch):
    monkeypatch.delenv("MESH_PROJECT_ROSTER_PIPELINE_CLI", raising=False)
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                     json=dict(CONTEXT, kind="artifact-list"))).json()
    assert reply["status"] == "unsupported" and "artifact" not in reply


@pytest.mark.parametrize("command,status,code", [
    ("artifact-capabilities", "unsupported", "artifact-capability-unavailable"),
    ("artifact-list", "unavailable", "producer-refused"),
])
async def test_legacy_capability_refusal_is_distinct_from_document_refusal(
        client, auth_cookie, native_scope, public_runtime, monkeypatch, command, status, code):
    import projectartifacts
    original = projectartifacts.Reader.run
    calls = []

    async def run(self, executable, args):
        calls.append(args[0])
        if args[0] == command:
            raise projectartifacts.Refusal("unavailable", "producer-refused")
        return await original(self, executable, args)

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                     json=dict(CONTEXT, kind="artifact-list"))).json()
    assert reply["status"] == status and reply["code"] == code and "artifact" not in reply
    assert calls == (["artifact-capabilities"] if command == "artifact-capabilities"
                     else ["artifact-capabilities", "artifact-list"])


async def test_wrong_public_source_never_publishes(client, auth_cookie, native_scope, public_runtime):
    public_runtime[1]["source"]["id"] = "f" * 64
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                     json=dict(CONTEXT, kind="artifact-list"))).json()
    assert reply["status"] == "failed" and reply["code"] == "producer-context-mismatch"
    assert "artifact" not in reply


async def test_board_change_after_read_retires_result(client, auth_cookie, native_scope, monkeypatch):
    import projectartifacts
    root, state = native_scope
    task_root = root / "tasks" / "VA"
    task_root.mkdir(parents=True)
    state["selector"] = dict(kind="board", path=str(root))
    reads = []

    async def run(self, executable, args):
        if args[0] == "view":
            reads.append(True)
            return dict(schema_version=1, kind="roster-roadmap-view", version=str(len(reads)), tasks=[dict(id="VA")])
        if args[0] == "artifact-capabilities":
            return dict(schema_version=1, kind="artifact-capabilities", schema=SCHEMA,
                        source=None, data=dict(reference_version=1, cursor_version=1))
        return dict(schema_version=1, kind="artifact-list", schema=SCHEMA,
                    source=source_identity(task_root, None), data=dict(items=[], next_cursor=None))

    monkeypatch.setattr(projectartifacts.Reader, "run", run)
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                     json=dict(CONTEXT, kind="artifact-list", roadmap_task_id="VA"))).json()
    assert reply["status"] == "stale" and reply["code"] == "roadmap-changed" and "artifact" not in reply


async def test_cancellation_settles_descendant_after_leader_exit(tmp_path):
    import asyncio
    import os
    import sys
    from pathlib import Path
    import projectartifacts
    pidfile = tmp_path / "descendant-pid"
    code = ("import subprocess,sys\nfrom pathlib import Path\n"
            "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\n"
            "Path(" + repr(str(pidfile)) + ").write_text(str(p.pid))\n")
    reader = projectartifacts.Reader(None)
    pending = asyncio.create_task(reader.run(sys.executable, ["-c", code]))
    for _ in range(100):
        if pidfile.exists():
            break
        await asyncio.sleep(.01)
    assert pidfile.exists()
    pid = int(pidfile.read_text())
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 2)
    # An orphan can await init's reap, but it must no longer execute or hold pipes.
    for _ in range(100):
        # Read once: the process can be reaped between an exists() check and the read.
        try:
            state = Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):  # reaped: the process is gone
            break
        if state == "Z":
            break
        await asyncio.sleep(.01)
    else:
        os.kill(pid, 9)
        pytest.fail("owned descendant survived cancellation")


async def test_public_page_plus_native_context_must_fit_transport_ceiling(client, auth_cookie, native_scope, public_runtime):
    import projectartifacts
    public_runtime[1]["data"]["padding"] = "x" * (projectartifacts.OUTPUT_BYTES + 4096)
    reply = await (await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                     json=dict(CONTEXT, kind="artifact-list"))).json()
    assert reply["status"] == "failed" and reply["code"] == "result-capacity" and "artifact" not in reply


async def test_near_limit_unicode_wrapper_uses_actual_utf8_wire_bytes(client, auth_cookie, native_scope, public_runtime):
    import projectartifacts
    envelope = public_runtime[1]
    size = len(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode())
    envelope["data"]["padding"] = "🌍" * ((projectartifacts.OUTPUT_BYTES - size - 64) // 4)
    child_bytes = len(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode())
    assert projectartifacts.OUTPUT_BYTES - 128 < child_bytes < projectartifacts.OUTPUT_BYTES
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    wire = await response.read()
    assert child_bytes < len(wire) <= projectartifacts.OUTPUT_BYTES + 4096
    assert "🌍".encode() in wire
    reply = json.loads(wire)
    assert reply["status"] == "ok" and reply["artifact"] == envelope


async def test_public_json_escaped_surrogate_metadata_remains_valid_json(client, auth_cookie, native_scope, public_runtime):
    public_runtime[1]["data"]["metadata"] = "\ud800"
    response = await client.post('/api/projects/artifacts/v1', headers=auth_cookie,
                                 json=dict(CONTEXT, kind="artifact-list"))
    wire = await response.read()
    wire.decode("utf-8", errors="strict")
    assert json.loads(wire)["artifact"] == public_runtime[1]
