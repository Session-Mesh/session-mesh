# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import json
import os
import stat

import pytest

import board


@pytest.fixture
def board_file(tmp_path, monkeypatch):
    path = tmp_path / "conf" / "board.json"
    monkeypatch.setattr(board, "FILE", path)
    return path


def live(name="alpha", created=1.0):
    return [{"name": name, "created": created}]


def document(version=0, elements=None, app_state=None):
    return {"elements": elements or [], "appState": app_state or {}, "files": {}, "version": version}


def test_missing_document_is_empty_and_bound_to_live_identity(board_file):
    assert board.get("alpha", live()) == document()
    with pytest.raises(board.BoardNotLive):
        board.get("alpha", [])


def test_write_is_cas_and_private_atomic_file(board_file):
    saved = board.replace("alpha", document(elements=[{"type": "rectangle", "id": "r"}]), live())
    assert saved["version"] == 1
    assert board.get("alpha", live()) == saved
    assert stat.S_IMODE(os.stat(board_file).st_mode) == 0o600
    raw = json.loads(board_file.read_text())
    assert raw["boards"]["alpha"]["created"] == 1.0
    with pytest.raises(board.BoardConflict):
        board.replace("alpha", document(), live())


def test_same_name_new_identity_is_empty(board_file):
    board.replace("alpha", document(), live(created=1.0))
    assert board.get("alpha", live(created=2.0)) == document()


@pytest.mark.parametrize("bad", [
    {},
    {"elements": [], "appState": {}, "files": {}, "version": True},
    {"elements": [], "appState": {}, "files": {"asset": {}}, "version": 0},
    {"elements": [{"type": "image"}], "appState": {}, "files": {}, "version": 0},
    {"elements": ["not-object"], "appState": {}, "files": {}, "version": 0},
])
def test_document_root_rejects_files_images_and_wrong_types(bad):
    with pytest.raises(ValueError):
        board.validate_document(bad)


def test_document_rejects_non_json_and_excessive_shape():
    with pytest.raises(ValueError):
        board.validate_document(document(app_state={"n": float("nan")}))
    with pytest.raises(ValueError):
        board.validate_document(document(elements=[{}] * (board.MAX_ELEMENTS + 1)))
    nested = {}
    for _ in range(board.MAX_DEPTH + 1):
        nested = {"x": nested}
    with pytest.raises(ValueError):
        board.validate_document(document(app_state=nested))


def test_corrupt_file_is_retained_before_fresh_empty_state(board_file):
    board_file.parent.mkdir()
    board_file.write_text("not json")
    assert board.get("alpha", live()) == document()
    assert list(board_file.parent.glob("board.json.corrupt-*"))


def test_lock_and_save_fail_closed(board_file, monkeypatch):
    def broken_lock(*args):
        raise OSError("locked out")
    with monkeypatch.context() as changed:
        changed.setattr(board.fcntl, "flock", broken_lock)
        with pytest.raises(board.BoardStorageError):
            board.get("alpha", live())

    with monkeypatch.context() as changed:
        changed.setattr(board.fsutil, "atomic_write", lambda *args: (_ for _ in ()).throw(OSError("full")))
        with pytest.raises(board.BoardStorageError):
            board.replace("alpha", document(), live())


def test_transfer_and_explicit_remove_are_identity_bound(board_file):
    saved = board.replace("old", document(elements=[{"type": "text", "text": "hi"}]), live("old", 3.0))
    assert board.transfer("old", 3.0, "new", 4.0)
    assert board.get("new", live("new", 4.0)) == saved
    assert not board.remove("new", 99.0)
    assert board.remove("new", 4.0)
    assert board.get("new", live("new", 4.0)) == document()


def test_updated_reference_contains_no_document_data():
    assert board.updated_envelope("alpha", 7, 1.5) == {
        "v": 0, "type": "board.updated", "source": "alpha",
        "object": {"kind": "board", "id": "alpha", "version": 7}, "at": 1.5,
    }


def test_v1_migrates_atomically_without_changing_its_canonical_document(board_file):
    original = document(4, [{"id": "kept", "version": 1, "type": "rectangle"}])
    board_file.parent.mkdir()
    board_file.write_text(json.dumps({"version": 1, "boards": {"alpha": {"created": 1.0, "document": original}}}))
    assert board.get("alpha", live()) == original
    migrated = json.loads(board_file.read_text())
    assert migrated["version"] == 3
    assert migrated["boards"]["alpha"] == {"created": 1.0, "document": original, "history": [],
                                               "provenance": "legacy-unknown"}


def test_unknown_store_version_is_quarantined_and_reset(board_file):
    board_file.parent.mkdir()
    board_file.write_text(json.dumps({"version": 4, "boards": {}}))
    assert board.get("alpha", live()) == document()
    assert list(board_file.parent.glob("board.json.corrupt-*"))
    assert not board_file.exists()


def test_history_is_bounded_derived_and_moves_or_purges_with_its_identity(board_file):
    for version in range(21):
        board.replace("alpha", document(version, [{"id": "one", "version": version}]), live(),
                      "mcp-session" if version % 2 else "owner", at=float(version))
    raw = json.loads(board_file.read_text())["boards"]["alpha"]
    assert len(raw["history"]) == board.HISTORY_LIMIT
    assert raw["history"][0]["document"]["version"] == 1
    assert {entry["provenance"] for entry in raw["history"]} == {"owner", "mcp-session"}
    assert board.transfer("alpha", 1.0, "beta", 2.0)
    assert len(json.loads(board_file.read_text())["boards"]["beta"]["history"]) == board.HISTORY_LIMIT
    assert board.remove("beta", 2.0)
    assert not json.loads(board_file.read_text())["boards"]


def test_v2_snapshot_writer_provenance_migrates_to_explicit_unknown(board_file):
    old = document(1, [{"id": "old", "version": 0}])
    board_file.parent.mkdir()
    board_file.write_text(json.dumps({"version": 2, "boards": {"alpha": {
        "created": 1.0, "document": document(2, [{"id": "new", "version": 1}]),
        "history": [{"document": old, "provenance": "mcp-session", "at": 1.0}],
    }}}))
    assert board.revisions("alpha", live()) == [
        {"version": 1, "element_count": 1, "status": "available", "provenance": "legacy-unknown"},
        {"version": 2, "element_count": 1, "status": "available", "provenance": "legacy-unknown"},
    ]
    assert json.loads(board_file.read_text())["version"] == 3


def test_revision_summaries_and_diff_never_return_element_data(board_file):
    board.replace("alpha", document(0, [{"id": "old", "version": 0, "text": "private"}]), live())
    board.replace("alpha", document(1, [{"id": "old", "version": 1, "text": "changed"},
                                          {"id": "new", "version": 0, "x": 44}]), live(), "mcp-session")
    assert board.revisions("alpha", live()) == [
        {"version": 0, "element_count": 0, "status": "available", "provenance": "legacy-unknown"},
        {"version": 1, "element_count": 1, "status": "available", "provenance": "owner"},
        {"version": 2, "element_count": 2, "status": "available", "provenance": "mcp-session"},
    ]
    assert board.revision_diff("alpha", 1, 2, live()) == {
        "status": "available", "added": 1, "removed": 0, "modified": 1}
    response = str(board.revision_diff("alpha", 1, 2, live()))
    assert all(value not in response for value in ("old", "new", "private", "changed", "44"))


def test_latest_change_is_only_the_immediate_safe_structural_transition(board_file):
    assert board.latest_change("alpha", live()) == {"status": "unavailable"}
    board.replace("alpha", document(0, [{"id": "old", "version": 0, "text": "private"}]), live())
    board.replace("alpha", document(1, [{"id": "old", "version": 1, "text": "changed"},
                                           {"id": "new", "version": 0, "x": 44}]), live(), "mcp-session")
    change = board.latest_change("alpha", live())
    assert change == {"status": "available",
                      "from": {"version": 1, "element_count": 1, "provenance": "owner"},
                      "to": {"version": 2, "element_count": 2, "provenance": "mcp-session"},
                      "diff": {"added": 1, "removed": 0, "modified": 1}}
    assert all(value not in str(change) for value in ("old", "new", "private", "changed", "44"))


def test_restore_is_cas_scoped_and_creates_a_new_revision(board_file):
    first = board.replace("alpha", document(0, [{"id": "old", "version": 0}]), live())
    second = board.replace("alpha", document(first["version"], [{"id": "new", "version": 0}]), live())
    restored = board.restore("alpha", 1, second["version"], live(), "mcp-session", 5.0)
    assert restored == {**document(1, [{"id": "old", "version": 0}]), "version": 3}
    with pytest.raises(board.BoardConflict):
        board.restore("alpha", 1, second["version"], live())
    with pytest.raises(ValueError):
        board.restore("alpha", 99, restored["version"], live())
    with pytest.raises(ValueError):
        board.restore("alpha", 1, restored["version"], live(), at=float("nan"))


@pytest.mark.parametrize("before,after", [
    (document(0, [{"id": "duplicate", "version": 0}, {"id": "duplicate", "version": 1}]), document(1)),
    (document(0, [{"id": "bad", "version": True}]), document(1)),
    (document(0, [{"id": "same", "version": 0, "text": "one"}]),
     document(0, [{"id": "same", "version": 0, "text": "two"}])),
])
def test_diff_fails_closed_for_ambiguous_or_same_version_content(board_file, before, after):
    assert board.diff_documents(before, after) == {"status": "unavailable"}
