# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The candidate gate must be mandatory, fail-closed and shared by full/CI."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/test-ptyhost-t41.sh"


def test_local_suite_builds_the_host_before_every_test_that_starts_it():
    full = (ROOT / "scripts/test-local.sh").read_text()
    invocation = 'PYTHON="$PY" bash scripts/test-ptyhost-t41.sh "$NATIVE_HOST"'
    assert full.index("bash scripts/bootstrap.sh") < full.index('export MESH_PTYHOST_CMD="$NATIVE_HOST"')
    run = full[full.index("# The host first:"):]
    assert run.index("\nbuild_native_host\n") < run.index("\nnode_tests\n") < run.index('"$PY" -m pytest -q "$@"')
    assert run.index('"$PY" -m pytest -q "$@"') < run.index("\nptyhost_gate\n")
    assert invocation in full


@pytest.fixture
def fake_runner_environment(tmp_path):
    python = tmp_path / "fake-python"
    log = tmp_path / "call.json"
    python.write_text(f"#!{sys.executable}\n" +
        "import json,os,pathlib,sys\n"
        "if sys.argv[1:3] != ['-m','pytest']: os.execv(sys.executable,[sys.executable]+sys.argv[1:])\n"
        "pathlib.Path(os.environ['T41_TEST_LOG']).write_text(json.dumps({'args':sys.argv[1:],'candidate':os.environ.get('MESH_PTYHOST_CMD'),'require_itf':os.environ.get('MESH_REQUIRE_ITF_ADAPTER')}))\n"
        "mode=os.environ.get('T41_TEST_MODE','pass')\n"
        "if mode=='fail': sys.exit(23)\n"
        "report=next(a.split('=',1)[1] for a in sys.argv if a.startswith('--junitxml='))\n"
        "case='<testcase name=\"executed\"/>'\n"
        "if mode=='skip': case='<testcase name=\"skipped\"><skipped/></testcase>'\n"
        "if mode=='error': case='<testcase name=\"collection\"><error/></testcase>'\n"
        "if mode=='empty': case=''\n"
        "pathlib.Path(report).write_text('<testsuites><testsuite>'+case+'</testsuite></testsuites>')\n")
    python.chmod(0o700)
    binary = tmp_path / "candidate with spaces"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o700)
    env = {**os.environ, "PYTHON": str(python), "T41_TEST_LOG": str(log),
           "MESH_PTYHOST_CMD": "unrelated-parent-command"}
    return binary, env, log


def run_gate(binary, env):
    return subprocess.run(["bash", str(RUNNER), str(binary)], env=env,
                          cwd=ROOT, text=True, capture_output=True, timeout=5)


def test_runner_selects_candidate_only_and_does_not_export_it_to_parent(fake_runner_environment):
    binary, env, log = fake_runner_environment
    result = run_gate(binary, env)
    assert result.returncode == 0, result.stderr
    call = json.loads(log.read_text())
    # One path, as given (the binary's name has spaces): never quoted or split.
    assert call["candidate"] == str(binary)
    # The gate requires the lifecycle ITF adapter: its test must fail, never skip, here.
    assert call["require_itf"] == "1"
    assert call["args"][call["args"].index("-m") + 1] == "pytest"
    assert "ptyhost_t41 or ptyhost_t42 or ptyhost_t43 or ptyhost_t44e" in call["args"]
    assert {arg for arg in call["args"] if arg.startswith("tests/")} == {
        "tests/test_ptyhost.py", "tests/test_ptyhost_env.py",
        "tests/test_ptyhost_errors.py", "tests/test_ptyhost_t41.py", "tests/test_ptyhost_t42.py",
        "tests/test_ptyhost_nonblocking.py", "tests/test_ptyhost_t43.py",
        "tests/test_ptyhost_t44e.py"}
    assert "xfail_strict=true" in call["args"]
    assert env["MESH_PTYHOST_CMD"] == "unrelated-parent-command"


@pytest.mark.parametrize("mode", ["fail", "skip", "empty", "error"])
def test_runner_fails_on_pytest_failure_skip_or_no_executed_case(fake_runner_environment, mode):
    binary, env, _ = fake_runner_environment
    result = run_gate(binary, {**env, "T41_TEST_MODE": mode})
    assert result.returncode != 0
    if mode == "fail":
        assert result.returncode == 23


@pytest.mark.parametrize("missing", [True, False])
def test_runner_refuses_missing_or_nonexecutable_binary_before_pytest(fake_runner_environment, missing):
    binary, env, log = fake_runner_environment
    if missing:
        binary = binary.with_name("missing")
    else:
        binary.chmod(0o600)
    result = run_gate(binary, env)
    assert result.returncode != 0
    assert "candidate executable" in result.stderr
    assert not log.exists()
