# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Static guards for the deterministic Quint/ITF lifecycle checker."""

from pathlib import Path


ROOT = Path(__file__).parents[1]
CHECKER = ROOT / "tools" / "check-ptyhost-lifecycle-itf.mjs"


def test_checker_forces_the_locked_local_typescript_backend():
    source = CHECKER.read_text()

    assert 'const quintBackend = "typescript";' in source
    assert '"--backend", quintBackend' in source
    assert "QUINT_HOME: quintHome" in source
    assert "await readdir(quintHome)" in source
    assert "must not provision an evaluator in QUINT_HOME" in source
