# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check-test-environment.py"
SPEC = importlib.util.spec_from_file_location("check_test_environment", SCRIPT)
assert SPEC and SPEC.loader
environment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(environment)


def test_parse_requirements_accepts_exact_pins_and_later_overrides(tmp_path):
    first = tmp_path / "first.txt"
    first.write_text("# base\nexample_name==1.0\nother==2.0  # stable\n", encoding="utf-8")
    second = tmp_path / "second.txt"
    second.write_text("example-name==3.0\n", encoding="utf-8")

    assert environment.parse_requirements([first, second]) == {
        "example-name": ("3.0", second),
        "other": ("2.0", first),
    }


@pytest.mark.parametrize("line", ["example", "example>=1", "-r nested.txt"])
def test_parse_requirements_rejects_non_exact_pins(tmp_path, line):
    requirements = tmp_path / "requirements.txt"
    requirements.write_text(line + "\n", encoding="utf-8")

    with pytest.raises(environment.RequirementError, match="expected an exact NAME==VERSION pin"):
        environment.parse_requirements([requirements])
