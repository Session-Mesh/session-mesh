#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Fail before pytest when its selected interpreter misses a pinned dependency."""

from __future__ import annotations

import argparse
import importlib.metadata
import re
import sys
from pathlib import Path


PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#]+)(?:\s*(?:#.*)?)?$")


class RequirementError(ValueError):
    """A requirement file is not the exact-pin input this preflight supports."""


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements(paths: list[Path]) -> dict[str, tuple[str, Path]]:
    """Read exact pins, with later files deliberately overriding earlier ones."""
    pins: dict[str, tuple[str, Path]] = {}
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise RequirementError(f"cannot read {path}: {error}") from error
        for number, raw in enumerate(lines, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            match = PIN.fullmatch(line)
            if not match:
                raise RequirementError(f"{path}:{number}: expected an exact NAME==VERSION pin")
            name, version = match.groups()
            pins[canonical_name(name)] = (version, path)
    return pins


def mismatches(pins: dict[str, tuple[str, Path]]) -> list[str]:
    problems = []
    for name, (expected, _) in sorted(pins.items()):
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            problems.append(f"{name}: expected {expected}, not installed")
        else:
            if actual != expected:
                problems.append(f"{name}: expected {expected}, found {actual}")
    return problems


def run(paths: list[Path]) -> int:
    try:
        pins = parse_requirements(paths)
    except RequirementError as error:
        print(f"test-environment: invalid input: {error}", file=sys.stderr)
        return 2
    problems = mismatches(pins)
    if not problems:
        print("test-environment: OK " + ", ".join(str(path) for path in paths))
        return 0
    print(f"test-environment: {sys.executable} does not match the pinned test requirements:", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    print("Create a worktree-local .venv, or set MESH_PYTHON to a prepared interpreter.", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requirements", nargs="+", type=Path, help="exact-pin requirement files, in install order")
    args = parser.parse_args()
    return run(args.requirements)


if __name__ == "__main__":
    raise SystemExit(main())
