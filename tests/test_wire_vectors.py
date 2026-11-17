# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Golden token and ptyhost-wire vectors."""

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/wire-vectors-v1.json"
OCAML_FIXTURE = ROOT / "ocaml/mesh_wire/test/wire-vectors-v1.json"
GENERATOR = ROOT / "scripts/generate_wire_vectors.py"


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_wire_vectors", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_wire_vectors_are_regenerated_from_the_python_reference():
    expected = json.loads(FIXTURE.read_text())
    assert load_generator().vectors() == expected


def test_ocaml_codec_fixture_is_the_same_python_reference():
    """The OCaml codec must not silently fork its cross-language golden vectors."""
    assert json.loads(OCAML_FIXTURE.read_text()) == json.loads(FIXTURE.read_text())
