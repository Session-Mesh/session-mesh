# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The static demo scene has a closed format, private CAS store and scoped routes."""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import demo_scene
import opens
from session_helpers import OTHER_NONCE, add_session

pytest_plugins = ("session_helpers",)

VECTORS = json.loads((Path(__file__).resolve().parents[1] / "ocaml" / "mesh_wire" / "test" / "demo-scene-v0-vectors.json").read_text())
V1_VECTORS = json.loads((Path(__file__).resolve().parents[1] / "ocaml" / "mesh_wire" / "test" / "demo-scene-v1-vectors.json").read_text())
V2_VECTORS = json.loads((Path(__file__).resolve().parents[1] / "ocaml" / "mesh_wire" / "test" / "demo-scene-v2-vectors.json").read_text())


@pytest.mark.parametrize("case", VECTORS["cases"] + V1_VECTORS["cases"] + V2_VECTORS["cases"], ids=lambda case: case["name"])
def test_scene_validator_shared_vectors(case):
    if case["accepted"]:
        assert demo_scene.validate(case["scene"]) == case["scene"]
    else:
        with pytest.raises(ValueError):
            demo_scene.validate(case["scene"])


@pytest.fixture
def scene_file(tmp_path, monkeypatch):
    path = tmp_path / "conf" / "demo-scenes.json"
    monkeypatch.setattr(demo_scene, "FILE", path)
    yield path


def scene(version=0, text="Prototype"):
    return {"format": "mesh-scene-v0", "version": version, "title": "Démo",
            "theme": "dark", "nodes": [{"type": "card", "children": [
                {"type": "heading", "text": text}, {"type": "shape", "text": "Runner → Serveur"}]}]}


def interactive_scene(version=0):
    return {"format": "mesh-scene-v1", "version": version, "title": "Parcours",
            "theme": "dark", "initial": "start", "states": [
                {"id": "start", "view": {"format": "mesh-view-v1", "nodes": [
                    {"type": "heading", "text": "<script>literal</script>"},
                    {"type": "row", "children": [{"type": "text", "text": "Un"},
                                                     {"type": "badge", "text": "Deux"}]}]},
                 "choices": [{"label": "Continuer", "target": "done"}]},
                {"id": "done", "view": {"format": "mesh-view-v1", "nodes": [
                    {"type": "shape", "text": "Terminé"}]},
                 "choices": [{"label": "Retour", "target": "start"}]},
            ]}


def test_v1_bounds_and_host_renderer_shell():
    document = interactive_scene()
    assert demo_scene.validate(document) == document
    rendered = demo_scene.render(document)
    assert "MeshDemoView" in rendered and "id=mesh-demo-root" in rendered
    assert "<script>literal</script>" not in rendered
    assert "connect-src 'none'" in demo_scene.csp_for(document)
    assert "sandbox allow-scripts" in demo_scene.csp_for(document)
    too_many = interactive_scene()
    too_many["states"][0]["choices"] = [
        {"label": str(index), "target": "start"} for index in range(33)]
    with pytest.raises(ValueError):
        demo_scene.validate(too_many)
    too_many_states = interactive_scene()
    too_many_states["states"] = [
        {"id": f"s{index}", "view": {"format": "mesh-view-v1", "nodes": []}, "choices": []}
        for index in range(17)]
    too_many_states["initial"] = "s0"
    with pytest.raises(ValueError):
        demo_scene.validate(too_many_states)


@pytest.mark.parametrize("bad", [
    {"type": "script", "text": "alert(1)"},
    {"type": "text", "text": "ok", "onclick": "evil()"},
    {"type": "shape", "text": "ok", "src": "https://evil.example"},
    {"type": "card", "children": [], "style": "url(https://evil.example)"},
    {"type": "link", "href": "javascript:alert(1)", "text": "go"},
    {"type": "disclosure", "summary": "ok", "children": [], "onclick": "evil()"},
    {"type": "disclosure", "summary": " ", "children": []},
    {"type": "disclosure", "summary": "ok", "children": [{"type": "script", "text": "evil()"}]},
])
def test_untrusted_code_and_urls_are_not_in_scene_language(bad):
    document = scene()
    document["nodes"] = [bad]
    with pytest.raises(ValueError):
        demo_scene.validate(document)


def test_render_escapes_every_text_field_and_has_no_executable_route():
    document = scene(text='<script src="https://evil.example/x"></script>')
    document["title"] = '<img src="https://evil.example/y">'
    rendered = demo_scene.render(document)
    assert "<script" not in rendered and "<img" not in rendered
    assert "&lt;script" in rendered and "&lt;img" in rendered
    assert "https://evil.example" in rendered  # inert escaped text, not a URL attribute
    csp = demo_scene.csp()
    assert "default-src 'none'" in csp and "sandbox" in csp and "form-action 'none'" in csp


def test_disclosure_is_native_interaction_without_script_or_navigation():
    document = scene()
    document["nodes"] = [{"type": "disclosure", "summary": '<img src="https://evil.example/a">',
                          "children": [{"type": "text", "text": '<script src="https://evil.example/b"></script>'}]}]
    validated = demo_scene.validate(document)
    assert validated["nodes"] == document["nodes"]
    rendered = demo_scene.render(document)
    assert "<details><summary>&lt;img" in rendered
    assert "&lt;script" in rendered
    assert "<script" not in rendered and "<img" not in rendered
    assert "allow-scripts" not in demo_scene.csp()


def test_checklist_is_local_native_interaction_without_script_or_form_submission():
    document = scene()
    document["nodes"] = [{"type": "checklist", "items": [
        '<img src="https://evil.example/a">', '<script>alert(1)</script>']}]
    validated = demo_scene.validate(document)
    assert validated["nodes"] == document["nodes"]
    rendered = demo_scene.render(document)
    assert rendered.count('<input type="checkbox">') == 2
    assert "&lt;img" in rendered and "&lt;script" in rendered
    assert "<script" not in rendered and "<img" not in rendered
    assert "allow-scripts" not in demo_scene.csp() and "form-action 'none'" in demo_scene.csp()


def test_progress_is_host_rendered_and_accepts_only_a_bounded_integer():
    document = scene()
    document["nodes"] = [{"type": "progress", "label": '<img src="https://evil.example/a">', "value": 42}]
    rendered = demo_scene.render(document)
    assert 'role="progressbar"' in rendered
    assert 'aria-valuenow="42"' in rendered and 'style="width:42%"' in rendered
    assert "&lt;img" in rendered and "<img" not in rendered
    for value in (-1, 101, True, 1.5):
        document["nodes"][0]["value"] = value
        with pytest.raises(ValueError):
            demo_scene.validate(document)


def test_metric_is_host_rendered_and_has_no_style_or_markup_escape_hatch():
    document = scene()
    document["nodes"] = [{"type": "metric", "label": '<img src="https://evil.example/a">',
                          "value": '<script>alert(1)</script>'}]
    rendered = demo_scene.render(document)
    assert '<div class="metric">' in rendered
    assert "&lt;img" in rendered and "&lt;script" in rendered
    assert "<img" not in rendered and "<script" not in rendered
    for bad in ({"type": "metric", "label": "Sessions", "value": " ",},
                {"type": "metric", "label": "Sessions", "value": "3", "style": "color:red"},
                {"type": "metric", "label": "Sessions", "value": 3}):
        document["nodes"] = [bad]
        with pytest.raises(ValueError):
            demo_scene.validate(document)


def test_status_is_host_rendered_with_a_closed_state_vocabulary():
    document = scene()
    document["nodes"] = [{"type": "status", "label": '<img src="https://evil.example/a">',
                          "state": "warning"}]
    rendered = demo_scene.render(document)
    assert '<div class="status status-warning" role="status">' in rendered
    assert "&lt;img" in rendered and "<img" not in rendered
    for bad in ({"type": "status", "label": "Ready", "state": "critical"},
                {"type": "status", "label": " ", "state": "info"},
                {"type": "status", "label": "Ready", "state": "success", "style": "color:red"}):
        document["nodes"] = [bad]
        with pytest.raises(ValueError):
            demo_scene.validate(document)


def test_store_is_durable_cas_and_revisions_are_immutable(scene_file):
    listed = [{"name": "alpha", "created": 1.0}]
    assert demo_scene.get("alpha", listed) == demo_scene.empty()
    first = demo_scene.replace("alpha", scene(), listed)
    assert first["version"] == 1
    assert demo_scene.get("alpha", listed, 0) == demo_scene.empty()
    second = demo_scene.replace("alpha", scene(1, "Changed"), listed)
    assert second["version"] == 2
    assert demo_scene.get("alpha", listed, 1) == first
    assert demo_scene.get("alpha", listed) == second
    assert demo_scene.revisions("alpha", listed) == {
        "format": "mesh-scene-v0", "current": 2, "versions": [0, 1, 2]}
    with pytest.raises(demo_scene.Conflict):
        demo_scene.replace("alpha", scene(), listed)
    assert os.stat(scene_file).st_mode & 0o777 == 0o600
    assert os.stat(scene_file.parent).st_mode & 0o777 == 0o700


def test_named_demos_have_independent_ids_and_revisions(scene_file):
    listed = [{"name": "alpha", "created": 1.0}]
    first = demo_scene.create_demo("alpha", scene(text="First"), listed)
    second = demo_scene.create_demo("alpha", scene(text="Second"), listed)
    assert first["id"] != second["id"]
    assert len(first["id"]) == 32
    assert demo_scene.list_demos("alpha", listed) == [
        {"id": first["id"], "title": "Démo", "version": 1},
        {"id": second["id"], "title": "Démo", "version": 1},
    ]
    changed = demo_scene.update_demo("alpha", first["id"], scene(1, "Changed"), listed)
    assert changed["version"] == 2
    assert demo_scene.get_demo("alpha", first["id"], listed, 1) == first["scene"]
    assert demo_scene.get_demo("alpha", second["id"], listed) == second["scene"]
    with pytest.raises(demo_scene.Conflict):
        demo_scene.update_demo("alpha", first["id"], scene(1, "Stale"), listed)
    with pytest.raises(demo_scene.DemoNotFound):
        demo_scene.get_demo("alpha", "0" * 32, listed)


def test_named_demo_restore_is_exact_immutable_and_cas(scene_file):
    listed = [{"name": "alpha", "created": 1.0}]
    first = demo_scene.create_demo("alpha", scene(text="First"), listed)
    same_title = demo_scene.create_demo("alpha", scene(text="Other"), listed)
    changed = demo_scene.update_demo("alpha", first["id"], scene(1, "Changed"), listed)
    before = demo_scene.get_demo("alpha", first["id"], listed, 1)

    assert demo_scene.demo_revisions("alpha", first["id"], listed) == {
        "demo_id": first["id"], "format": "mesh-scene-v0",
        "current": 2, "versions": [1, 2]}
    restored = demo_scene.restore_demo("alpha", first["id"], 1, changed["version"], listed)
    assert restored == {**before, "version": 3}
    assert demo_scene.get_demo("alpha", first["id"], listed, 1) == before
    assert demo_scene.get_demo("alpha", first["id"], listed, 2) == changed
    assert demo_scene.get_demo("alpha", same_title["id"], listed) == same_title["scene"]

    after = json.loads(scene_file.with_name("demo-catalogs.json").read_text())
    with pytest.raises(demo_scene.Conflict):
        demo_scene.restore_demo("alpha", first["id"], 1, 2, listed)
    with pytest.raises(demo_scene.DemoNotFound):
        demo_scene.restore_demo("alpha", first["id"], 99, 3, listed)
    with pytest.raises(demo_scene.DemoNotFound):
        demo_scene.restore_demo("alpha", "0" * 32, 1, 1, listed)
    assert json.loads(scene_file.with_name("demo-catalogs.json").read_text()) == after


def test_named_demo_restore_capacity_and_incarnation_refuse_without_write(scene_file, monkeypatch):
    old = [{"name": "alpha", "created": 1.0}]
    demo = demo_scene.create_demo("alpha", scene(), old)
    demo_scene.update_demo("alpha", demo["id"], scene(1, "Changed"), old)
    path = scene_file.with_name("demo-catalogs.json")
    before = path.read_bytes()
    monkeypatch.setattr(demo_scene, "HISTORY_LIMIT", 2)
    with pytest.raises(demo_scene.CapacityError):
        demo_scene.restore_demo("alpha", demo["id"], 1, 2, old)
    assert path.read_bytes() == before

    new = [{"name": "alpha", "created": 2.0}]
    with pytest.raises(demo_scene.DemoNotFound):
        demo_scene.restore_demo("alpha", demo["id"], 1, 2, new)
    assert path.read_bytes() == before


def test_named_demo_restore_has_one_atomic_cas_winner(scene_file):
    listed = [{"name": "alpha", "created": 1.0}]
    demo = demo_scene.create_demo("alpha", scene(), listed)

    def restore():
        try:
            return demo_scene.restore_demo("alpha", demo["id"], 1, 1, listed)
        except demo_scene.Conflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: restore(), range(2)))
    assert sum(result is not None for result in results) == 1
    assert demo_scene.demo_revisions("alpha", demo["id"], listed)["versions"] == [1, 2]


@pytest.mark.parametrize("value", [0, -1, True, 1.5, demo_scene.MAX_SAFE_INTEGER + 1])
def test_named_demo_restore_rejects_unsafe_revision_numbers_without_write(scene_file, value):
    listed = [{"name": "alpha", "created": 1.0}]
    demo = demo_scene.create_demo("alpha", scene(), listed)
    path = scene_file.with_name("demo-catalogs.json")
    before = path.read_bytes()
    with pytest.raises(ValueError):
        demo_scene.restore_demo("alpha", demo["id"], value, 1, listed)
    with pytest.raises(ValueError):
        demo_scene.restore_demo("alpha", demo["id"], 1, value, listed)
    assert path.read_bytes() == before


def test_named_demos_preserve_legacy_store_and_incarnation(scene_file):
    old = [{"name": "alpha", "created": 1.0}]
    legacy = demo_scene.replace("alpha", scene(), old)
    raw_legacy = json.loads(scene_file.read_text())
    assert raw_legacy["format"] == 1
    named = demo_scene.create_demo("alpha", scene(text="New"), old)
    assert demo_scene.get_demo("alpha", "legacy", old) == legacy
    assert {row["id"] for row in demo_scene.list_demos("alpha", old)} == {"legacy", named["id"]}
    assert demo_scene.get("alpha", old) == legacy
    assert demo_scene.get_demo("alpha", named["id"], old) == named["scene"]
    assert json.loads(scene_file.read_text()) == raw_legacy
    new = [{"name": "alpha", "created": 2.0}]
    assert demo_scene.list_demos("alpha", new) == []
    with pytest.raises(demo_scene.DemoNotFound):
        demo_scene.get_demo("alpha", named["id"], new)
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, legacy["version"], new)
    row = demo_scene.archives()[0]
    assert demo_scene.delete_archive("alpha", 1.0, legacy["version"], new,
                                     row["catalog_digest"]) == "catalog"
    assert demo_scene.archives() == [{"name": "alpha", "created": 1.0,
                                      "current": 1, "revisions": 2}]
    assert demo_scene.delete_archive("alpha", 1.0, legacy["version"], new) == "legacy"
    assert demo_scene.archives() == []


def test_named_archive_maintenance_requires_exact_inactive_catalog_cas(scene_file):
    old = [{"name": "alpha", "created": 1.0}]
    demo_scene.create_demo("alpha", scene(), old)
    row = demo_scene.archives()[0]
    assert row["current"] == 0 and row["demos"] == 1
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, 0, old, row["catalog_digest"])
    new = [{"name": "alpha", "created": 2.0}]
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, 0, new)
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, 0, new, "0" * 64)
    demo_scene.delete_archive("alpha", 1.0, 0, new, row["catalog_digest"])
    assert demo_scene.archives() == []


def test_named_demo_capacity_is_atomic(scene_file, monkeypatch):
    monkeypatch.setattr(demo_scene, "MAX_DEMOS_PER_SESSION", 2)
    listed = [{"name": "alpha", "created": 1.0}]
    first = demo_scene.create_demo("alpha", scene(), listed)
    second = demo_scene.create_demo("alpha", scene(), listed)
    with pytest.raises(demo_scene.CapacityError):
        demo_scene.create_demo("alpha", scene(), listed)
    assert [row["id"] for row in demo_scene.list_demos("alpha", listed)] == [first["id"], second["id"]]


def test_reused_session_name_cannot_read_or_overwrite_prior_incarnation(scene_file):
    old = [{"name": "alpha", "created": 1.0}]
    prior = demo_scene.replace("alpha", scene(), old)
    new = [{"name": "alpha", "created": 2.0}]
    assert demo_scene.get("alpha", new) == demo_scene.empty()
    saved = demo_scene.replace("alpha", scene(0, "new"), new)
    assert saved["version"] == 1
    assert demo_scene.get("alpha", old) == prior
    assert len(json.loads(scene_file.read_text())["scenes"]) == 2


def test_capacity_refuses_without_pruning_a_pinned_revision(scene_file, monkeypatch):
    monkeypatch.setattr(demo_scene, "HISTORY_LIMIT", 2)
    listed = [{"name": "alpha", "created": 1.0}]
    first = demo_scene.replace("alpha", scene(), listed)
    with pytest.raises(demo_scene.CapacityError):
        demo_scene.replace("alpha", scene(1, "later"), listed)
    assert demo_scene.get("alpha", listed, 1) == first


def test_explicit_archive_maintenance_requires_inactive_exact_cas(scene_file):
    old = [{"name": "alpha", "created": 1.0}]
    first = demo_scene.replace("alpha", scene(), old)
    assert demo_scene.archives() == [{"name": "alpha", "created": 1.0,
                                      "current": 1, "revisions": 2}]
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, 1, old)
    new = [{"name": "alpha", "created": 2.0}]
    with pytest.raises(demo_scene.Conflict):
        demo_scene.delete_archive("alpha", 1.0, 2, new)
    assert demo_scene.get("alpha", old) == first
    demo_scene.delete_archive("alpha", 1.0, 1, new)
    assert demo_scene.archives() == []
    assert demo_scene.get("alpha", old) == demo_scene.empty()


def test_symlink_and_hardlink_storage_are_refused(scene_file, tmp_path):
    listed = [{"name": "alpha", "created": 1.0}]
    scene_file.parent.mkdir(mode=0o700)
    other = tmp_path / "other"
    other.write_text('{"format":1,"scenes":{}}')
    other.chmod(0o600)
    scene_file.symlink_to(other)
    with pytest.raises(demo_scene.StorageError):
        demo_scene.get("alpha", listed)
    scene_file.unlink()
    os.link(other, scene_file)
    with pytest.raises(demo_scene.StorageError):
        demo_scene.get("alpha", listed)


async def test_session_token_scoped_routes_and_owner_frame(client, listing, scene_file, auth_cookie, auth_bearer):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    created = listing[0]["created"]
    response = await client.put("/api/demo-scene/@self", headers=alpha, json=scene())
    assert response.status == 200 and (await response.json())["version"] == 1
    summary = await client.get("/api/demo-scene/@self/revisions", headers=alpha)
    assert summary.status == 200
    assert await summary.json() == {"format": "mesh-scene-v0", "current": 1, "versions": [0, 1]}
    assert (await client.get("/api/demo-scene/@self", headers=beta)).status == 200
    assert (await (await client.get("/api/demo-scene/@self", headers=beta)).json())["version"] == 0
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get("/api/demo-scene/@self", headers=credentials)).status == 401
        assert (await client.get("/api/demo-scene/@self/revisions", headers=credentials)).status == 401
        assert (await client.put("/api/demo-scene/@self", headers=credentials, json=scene())).status == 401
    assert (await client.get(f"/api/demo-scene/alpha?created={created}", headers=alpha)).status == 401
    described = await client.get(f"/api/demo-scene/alpha?created={created}", headers=auth_cookie)
    assert described.status == 200
    assert described.headers["X-Mesh-Frame-Sandbox"] == demo_scene.frame_sandbox(scene())
    frame = await client.get(f"/demo-scene/alpha/1?created={created}", headers=auth_cookie)
    assert frame.status == 200 and "default-src 'none'" in frame.headers["Content-Security-Policy"]
    assert "sandbox" in frame.headers["Content-Security-Policy"]
    assert frame.headers["X-Content-Type-Options"] == "nosniff"
    assert (await client.get("/demo-scene/alpha/1?created=999", headers=auth_cookie)).status == 409
    assert (await client.get(f"/demo-scene/alpha/99?created={created}", headers=auth_cookie)).status == 404


async def test_v1_routes_history_restore_and_csp_remain_incarnation_scoped(
        client, listing, scene_file, auth_cookie):
    alpha = add_session(listing, "alpha")
    created = listing[0]["created"]
    response = await client.post("/api/demo-scene/@self/catalog", headers=alpha,
                                 json=interactive_scene())
    assert response.status == 200
    demo_id = (await response.json())["id"]
    changed = await client.put(f"/api/demo-scene/@self/selected?demo_id={demo_id}",
                               headers=alpha, json=interactive_scene(1))
    assert changed.status == 200
    stale = await client.put(f"/api/demo-scene/@self/selected?demo_id={demo_id}",
                             headers=alpha, json=interactive_scene(0))
    assert stale.status == 409
    revisions = await client.get(
        f"/api/demo-scene/@self/selected/revisions?demo_id={demo_id}", headers=alpha)
    assert await revisions.json() == {"demo_id": demo_id, "format": "mesh-scene-v1",
                                      "current": 2, "versions": [1, 2]}
    restored = await client.post("/api/demo-scene/@self/selected/restore", headers=alpha,
        json={"demo_id": demo_id, "version": 1, "expected_version": 2})
    assert restored.status == 200 and (await restored.json())["version"] == 3
    assert restored.headers["X-Mesh-Frame-Sandbox"] == demo_scene.frame_sandbox(interactive_scene())
    described = await client.get(
        f"/api/demo-scene/alpha/selected?created={created}&demo_id={demo_id}&version=1",
        headers=auth_cookie)
    assert described.status == 200
    assert described.headers["X-Mesh-Frame-Sandbox"] == demo_scene.frame_sandbox(interactive_scene())
    frame = await client.get(
        f"/demo-scene/alpha/{demo_id}/3?created={created}", headers=auth_cookie)
    assert frame.status == 200
    assert "sandbox allow-scripts" in frame.headers["Content-Security-Policy"]
    assert "connect-src 'none'" in frame.headers["Content-Security-Policy"]
    assert "MeshDemoView" in await frame.text()


async def test_named_demo_routes_use_only_exact_live_session_token(client, listing, scene_file, auth_cookie, auth_bearer):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    created = listing[0]["created"]
    catalog = "/api/demo-scene/@self/catalog"
    selected = "/api/demo-scene/@self/selected"
    first = await client.post(catalog, headers=alpha, json=scene())
    assert first.status == 200
    demo_id = (await first.json())["id"]
    assert (await (await client.get(catalog, headers=alpha)).json())[0]["id"] == demo_id
    assert await (await client.get(f"{selected}?demo_id={demo_id}", headers=alpha)).json() == (await first.json())["scene"]
    assert (await client.get(catalog, headers=beta)).status == 200
    assert await (await client.get(catalog, headers=beta)).json() == []
    assert (await client.get(f"{selected}?demo_id={demo_id}", headers=beta)).status == 404
    owner_catalog = f"/api/demo-scene/alpha/catalog?created={created}"
    assert (await client.get(owner_catalog, headers=auth_cookie)).status == 200
    assert (await client.get(owner_catalog, headers=alpha)).status == 401
    owner_scene = f"/api/demo-scene/alpha/selected?created={created}&demo_id={demo_id}"
    assert (await client.get(owner_scene, headers=auth_cookie)).status == 200
    assert (await client.get(owner_scene, headers=alpha)).status == 401
    frame = f"/demo-scene/alpha/{demo_id}/1?created={created}"
    assert (await client.get(frame, headers=auth_cookie)).status == 200
    assert (await client.get(frame, headers=alpha)).status == 401
    assert (await client.get(f"/demo-scene/alpha/{demo_id}/1?created=999", headers=auth_cookie)).status == 409
    assert (await client.get(selected, headers=alpha)).status == 400
    assert (await client.put(f"{selected}?demo_id={demo_id}", headers=alpha, json=scene())).status == 409
    assert (await client.put(f"{selected}?demo_id={demo_id}", headers=alpha, json=scene(1, "changed"))).status == 200
    assert (await client.post("/api/demo-scene/@self/open-named", headers=alpha,
                              json={"demo_id": demo_id})).status == 200
    first_open = opens.snapshot({"alpha": created})[-1]
    assert first_open["demo_id"] == demo_id
    assert (await client.post("/api/demo-scene/@self/open-named", headers=alpha,
                              json={"demo_id": demo_id})).status == 200
    assert opens.snapshot({"alpha": created})[-1]["seq"] > first_open["seq"]
    assert (await client.post("/api/demo-scene/@self/open-named", headers=alpha,
                              json={"demo_id": "0" * 32})).status == 404
    assert (await client.post("/api/demo-scene/@self/open-named", headers=alpha,
                              json={"demo_id": demo_id, "session": "beta"})).status == 400
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get(catalog, headers=credentials)).status == 401
        assert (await client.post(catalog, headers=credentials, json=scene())).status == 401
        assert (await client.get(f"{selected}?demo_id={demo_id}", headers=credentials)).status == 401
        assert (await client.put(f"{selected}?demo_id={demo_id}", headers=credentials, json=scene(2))).status == 401
        assert (await client.post("/api/demo-scene/@self/open-named", headers=credentials,
                                  json={"demo_id": demo_id})).status == 401
    listing.clear()
    add_session(listing, "alpha", OTHER_NONCE)
    assert (await client.get(catalog, headers=alpha)).status == 401
    assert (await client.get(f"{selected}?demo_id={demo_id}", headers=alpha)).status == 401
    assert (await client.get(f"/api/demo-scene/alpha?created={created}", headers=alpha)).status == 401


async def test_named_demo_revision_and_restore_routes_are_closed_cas_and_session_only(
        client, listing, scene_file, auth_cookie, auth_bearer, monkeypatch):
    alpha = add_session(listing, "alpha")
    beta = add_session(listing, "beta", OTHER_NONCE)
    created = await client.post("/api/demo-scene/@self/catalog", headers=alpha, json=scene())
    demo_id = (await created.json())["id"]
    await client.put(f"/api/demo-scene/@self/selected?demo_id={demo_id}",
                     headers=alpha, json=scene(1, "Changed"))
    revisions = f"/api/demo-scene/@self/selected/revisions?demo_id={demo_id}"
    restore = "/api/demo-scene/@self/selected/restore"
    assert await (await client.get(revisions, headers=alpha)).json() == {
        "demo_id": demo_id, "format": "mesh-scene-v0", "current": 2,
        "versions": [1, 2]}
    response = await client.post(restore, headers=alpha, json={
        "demo_id": demo_id, "version": 1, "expected_version": 2})
    assert response.status == 200 and (await response.json())["version"] == 3
    assert (await client.post(restore, headers=alpha, json={
        "demo_id": demo_id, "version": 1, "expected_version": 2})).status == 409
    assert (await client.post(restore, headers=alpha, json={
        "demo_id": demo_id, "version": 99, "expected_version": 3})).status == 404
    assert (await client.get(revisions, headers=beta)).status == 404

    for bad in ({"demo_id": demo_id, "version": 1, "expected_version": 3, "title": "Démo"},
                {"demo_id": "Démo", "version": 1, "expected_version": 3},
                {"demo_id": demo_id, "version": True, "expected_version": 3},
                {"demo_id": demo_id, "version": 1,
                 "expected_version": demo_scene.MAX_SAFE_INTEGER + 1}):
        assert (await client.post(restore, headers=alpha, json=bad)).status == 400
    assert (await client.get("/api/demo-scene/@self/selected/revisions?demo_id=Démo",
                             headers=alpha)).status == 400
    assert (await client.get(f"{revisions}&title=Démo", headers=alpha)).status == 400
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get(revisions, headers=credentials)).status == 401
        assert (await client.post(restore, headers=credentials, json={
            "demo_id": demo_id, "version": 1, "expected_version": 3})).status == 401

    created_at = listing[0]["created"]
    owner_revisions = (f"/api/demo-scene/alpha/selected/revisions"
                       f"?created={created_at}&demo_id={demo_id}")
    owner_restore = f"/api/demo-scene/alpha/selected/restore?created={created_at}"
    for credentials in (auth_cookie, auth_bearer):
        owner_summary = await client.get(owner_revisions, headers=credentials)
        assert owner_summary.status == 200
        assert (await owner_summary.json())["current"] == 3
    owner_result = await client.post(owner_restore, headers=auth_cookie, json={
        "demo_id": demo_id, "version": 2, "expected_version": 3})
    assert owner_result.status == 200 and (await owner_result.json())["version"] == 4
    assert (await client.post(owner_restore, headers=auth_bearer, json={
        "demo_id": demo_id, "version": 1, "expected_version": 3})).status == 409
    assert (await client.get(f"{owner_revisions}&title=Démo", headers=auth_cookie)).status == 400
    assert (await client.post(f"{owner_restore}&demo_id={demo_id}", headers=auth_cookie, json={
        "demo_id": demo_id, "version": 1, "expected_version": 4})).status == 400
    assert (await client.get(owner_revisions, headers=beta)).status == 401

    monkeypatch.setattr(demo_scene, "HISTORY_LIMIT", 4)
    before = scene_file.with_name("demo-catalogs.json").read_bytes()
    assert (await client.post(restore, headers=alpha, json={
        "demo_id": demo_id, "version": 1, "expected_version": 4})).status == 507
    assert (await client.post(owner_restore, headers=auth_cookie, json={
        "demo_id": demo_id, "version": 1, "expected_version": 4})).status == 507
    assert scene_file.with_name("demo-catalogs.json").read_bytes() == before


async def test_stale_token_and_open_queue_are_incarnation_bound(client, listing, scene_file):
    old = add_session(listing, "alpha")
    assert (await client.post("/api/demo-scene/@self/open", headers=old)).status == 200
    assert opens.snapshot({"alpha": listing[0]["created"]})[-1]["kind"] == "demo-scene-open"
    listing.clear()
    fresh = add_session(listing, "alpha", OTHER_NONCE)
    assert (await client.get("/api/demo-scene/@self", headers=old)).status == 401
    assert opens.snapshot({"alpha": listing[0]["created"]}) == []
    assert (await client.post("/api/demo-scene/@self/open", headers=fresh, data=b"x")).status == 400
    assert (await client.post("/api/demo-scene/@self/open", headers=fresh)).status == 200


async def test_open_auth_to_poll_incarnation_change_drops_request(client, listing, scene_file, monkeypatch):
    token = add_session(listing, "alpha")
    original = opens.record_demo_scene_open

    def switch_before_record(name, created):
        listing.clear()
        add_session(listing, "alpha", OTHER_NONCE)
        return original(name, created)

    monkeypatch.setattr(opens, "record_demo_scene_open", switch_before_record)
    assert (await client.post("/api/demo-scene/@self/open", headers=token)).status == 200
    assert opens.snapshot({"alpha": listing[0]["created"]}) == []


async def test_capacity_returns_507_without_overwriting_scene(client, listing, scene_file, monkeypatch):
    monkeypatch.setattr(demo_scene, "HISTORY_LIMIT", 2)
    token = add_session(listing, "alpha")
    first = await client.put("/api/demo-scene/@self", headers=token, json=scene())
    assert first.status == 200
    refused = await client.put("/api/demo-scene/@self", headers=token, json=scene(1, "Later"))
    assert refused.status == 507
    current = await client.get("/api/demo-scene/@self", headers=token)
    assert (await current.json())["version"] == 1


async def test_shape_and_size_rejections(client, listing, scene_file):
    token = add_session(listing, "alpha")
    bad = scene()
    bad["nodes"] = [{"type": "text", "text": "x", "style": "color:red"}]
    assert (await client.put("/api/demo-scene/@self", headers=token, json=bad)).status == 400
    assert (await client.put("/api/demo-scene/@self", headers=token, data=b"x" * (demo_scene.MAX_BYTES + 1))).status == 413
    assert (await client.put("/api/demo-scene/@self", headers=token, json=scene())).status == 200
    assert (await client.put("/api/demo-scene/@self", headers=token, json=scene())).status == 409
