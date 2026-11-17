# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import asyncio
import json
import sys

import pytest

import projectartifacts
import projectissues as issues
import server


def body(**changes):
    return {"boot": "a" * 64, "machine_id": "host", "project_id": "project", "source_id": "forge",
            "revision": "cfg1_" + "b" * 64, "page": 1, **changes}


def native(source=None):
    selected = source or {"id": "forge", "kind": "github", "url": "https://github.com/owner/repository/issues"}

    async def host(request):
        assert request == {"version": 1, "op": "project_read", "project_id": "project", "settings": {"kind": "source", "source_id": "forge"}}
        return {"kind": "mesh-project-reply", "version": 1, "op": "project_read", "status": "ok",
                "boot": "a" * 64, "machine_id": "host", "revision": "cfg1_" + "b" * 64,
                "project": {"id": "project"}, "observation_settings": {"kind": "source", "source": selected}}
    return host


def row(**changes):
    return {"number": 7, "title": "Read the issue 😀", "state": "open", "body": "# Exact description",
            "labels": [{"name": "bug", "color": "ff0000"}], "assignees": [{"login": "alice"}],
            "updated_at": "2026-11-17T01:00:00Z", **changes}


@pytest.mark.parametrize("change", [{"page": True}, {"page": 0}, {"page": 21}, {"url": "https://evil.test"},
                                    {"boot": "old"}, {"revision": "old"}, {"source_id": "../../other"}])
def test_request_is_finite_and_accepts_no_caller_url_or_cli(change):
    with pytest.raises(ValueError):
        issues.query(body(**change))


@pytest.mark.parametrize("url", ["http://github.com/a/b", "https://github.com.evil.test/a/b", "https://user" + chr(64) + "github.com/a/b",
                                 "https://github.com/a/b?state=all", "https://github.com/a/../b", "https://github.com/a/b/extra",
                                 "https://github.com/a/%2fsecret", "https://127.0.0.1/a/b"])
def test_source_repository_cannot_redirect_credentials(url):
    with pytest.raises(projectartifacts.Refusal):
        issues.repository({"kind": "github", "url": url})


def test_source_owns_repository_and_provider_scope():
    assert issues.repository({"kind": "github", "url": "https://github.com/a/b/issues"}) == ("github", "github.com", "a/b")
    assert issues.repository({"kind": "gitlab", "url": "https://gitlab.com/a/sub/b/-/issues"}) == ("gitlab", "gitlab.com", "a/sub/b")
    with pytest.raises(projectartifacts.Refusal):
        issues.repository({"kind": "linear", "url": "https://linear.app/workspace/team/ABC"})


async def test_read_rechecks_exact_native_source_and_uses_only_get(monkeypatch):
    calls = []

    async def command(executable, args):
        calls.append((executable, args))
        return [row(), row(number=8, pull_request={"url": "irrelevant"}), {"number": 9, "title": None}]

    monkeypatch.setattr(issues, "command", command)
    monkeypatch.setattr(issues.shutil, "which", lambda name: "/trusted/" + name)
    reply = await issues.Reader(native()).request(body())
    assert reply["status"] == "ok"
    assert reply["issues"]["items"][0]["labels"] == [{"name": "bug", "color": "#ff0000"}]
    assert reply["issues"]["items"][0]["assignees"] == ["alice"]
    assert len(reply["issues"]["items"]) == 1
    assert reply["issues"]["partial"] is True
    assert calls == [("/trusted/gh", ["api", "--hostname", "github.com", "--method", "GET",
                                     "repos/owner/repository/issues?state=all&sort=updated&direction=desc&per_page=25&page=1"])]
    for key in issues.CONTEXT:
        assert reply[key] == body()[key]


async def test_gitlab_nested_repository_is_encoded_as_one_native_id(monkeypatch):
    calls = []

    async def command(executable, args):
        calls.append(args)
        return [row(iid=4, description="GitLab body", labels=["workflow::review"], assignees=[{"username": "bob"}])]

    monkeypatch.setattr(issues, "command", command)
    reply = await issues.Reader(native({"id": "forge", "kind": "gitlab", "url": "https://gitlab.com/group/sub/repo"})).request(body())
    assert reply["status"] == "ok"
    assert calls[0][-1].startswith("projects/group%2Fsub%2Frepo/issues?")
    assert reply["issues"]["items"][0]["assignees"] == ["bob"]
    assert reply["issues"]["items"][0]["labels"] == [{"name": "workflow::review"}]


async def test_scope_change_cannot_publish_old_issue_content(monkeypatch):
    source = {"id": "forge", "kind": "github", "url": "https://github.com/a/first"}

    async def command(executable, args):
        source["url"] = "https://github.com/a/second"
        return [row()]

    monkeypatch.setattr(issues, "command", command)
    reply = await issues.Reader(native(source)).request(body())
    assert reply["status"] == "stale"
    assert "issues" not in reply


async def test_wrong_context_never_invokes_provider(monkeypatch):
    async def command(*_):
        pytest.fail("provider must not run")

    monkeypatch.setattr(issues, "command", command)
    reply = await issues.Reader(native()).request(body(boot="c" * 64))
    assert reply["status"] == "stale"
    assert "issues" not in reply


def test_optional_bad_fields_are_local_and_do_not_execute_markup():
    item = issues.issue(row(labels=[None, {"name": "<svg onload=alert(1)>", "color": "url(evil)"}],
                            assignees=[None, {"login": "alice"}], body=27), "github", "owner/repo")
    assert item["labels"] == [{"name": "<svg onload=alert(1)>"}]
    assert item["assignees"] == ["alice"]
    assert item["description"] is None
    assert issues.issue(row(state="closed", state_reason="not_planned"), "github", "a/b")["column"] == "cancelled"
    assert issues.issue(row(state="future-state"), "github", "a/b")["column"] == "unknown"


def test_control_characters_do_not_discard_otherwise_readable_issue():
    item = issues.issue(row(title="Readable\x1b title", body="Description\x0c retained"), "github", "a/b")
    assert item["title"] == "Readable title"
    assert item["description"] == "Description retained"


async def test_concurrency_budget_is_owned_by_issues_not_sessions():
    reader = issues.Reader(native())
    reader.active = 2
    reply = await reader.request(body())
    assert reply["code"] == "issue-reader-busy"
    assert reader.active == 2


async def test_missing_cli_has_dedicated_unsupported_status(monkeypatch):
    monkeypatch.setattr(issues.shutil, "which", lambda _: None)
    reply = await issues.Reader(native()).request(body())
    assert reply["status"] == "unsupported"
    assert reply["code"] == "issue-cli-unavailable"


async def test_disconnect_cancels_and_drains_provider_operation(monkeypatch):
    started, drained = asyncio.Event(), asyncio.Event()

    class Transport:
        closed = False

        def is_closing(self):
            return self.closed

    async def command(*_):
        started.set()
        try:
            await asyncio.Future()
        finally:
            drained.set()

    monkeypatch.setattr(issues, "command", command)
    transport = Transport()
    reader = issues.Reader(native())
    operation = asyncio.create_task(reader.request(body(), transport))
    await asyncio.wait_for(started.wait(), 1)
    transport.closed = True
    reply = await asyncio.wait_for(operation, 1)
    assert reply["status"] == "cancelled"
    assert drained.is_set()
    assert reader.active == 0


async def test_existing_runner_accepts_arrays_only_for_opted_in_issue_reads():
    reader = projectartifacts.Reader(None)
    assert await reader.run(sys.executable, ["-c", "print('[]')"], allow_list=True) == []
    with pytest.raises(projectartifacts.Refusal) as error:
        await reader.run(sys.executable, ["-c", "print('[]')"])
    assert error.value.code == "producer-invalid"


async def test_owner_http_issues_route_and_duplicate_fields(client, monkeypatch):
    monkeypatch.setattr(server, "host", native())

    async def command(*_):
        return [row()]

    monkeypatch.setattr(issues, "command", command)
    response = await client.post("/api/projects/issues/v1", json=body(), headers={"Authorization": "Bearer " + server.TOKEN})
    assert response.status == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert (await response.json())["issues"]["items"][0]["id"] == "7"
    duplicate = json.dumps(body())[:-1] + ',"page":2}'
    response = await client.post("/api/projects/issues/v1", data=duplicate, headers={"Authorization": "Bearer " + server.TOKEN})
    assert response.status == 400


@pytest.mark.parametrize("kind,extra", [("github", {"node_id": "I_node123"}), ("gitlab", {"project_id": 9007199254740993})])
def test_native_identity_preserves_exact_ids_separately_from_display_number(kind, extra):
    item = issues.issue(row(id=9007199254740995, iid=7, **extra), kind, "a/b")
    assert item["id"] == "7"
    identity = item["native_identity"]
    assert identity["issue_id"] == "9007199254740995"
    assert identity["host"] == kind + ".com"
    assert identity["node_id"] == ("I_node123" if kind == "github" else None)
    assert identity["project_id"] == ("9007199254740993" if kind == "gitlab" else None)


@pytest.mark.parametrize("value", [None, True, 0, -1, 2**64, "123"])
def test_missing_or_malformed_native_id_keeps_issue_readable_without_identity(value):
    item = issues.issue(row(id=value), "github", "a/b")
    assert item["title"] == "Read the issue 😀"
    assert item["native_identity"] is None
