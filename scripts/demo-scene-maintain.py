#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Local operator maintenance for bounded, private static demo archives.

This is not an OS security boundary against same-UID agent shell code. It is
deliberately not exposed through the Mesh API or MCP tools.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import demo_scene  # noqa: E402
import ptyhost  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="list archive identity/revision metadata only")
    delete = commands.add_parser("delete", help="delete exactly one inactive archive")
    delete.add_argument("--name", required=True)
    delete.add_argument("--created", type=float, required=True)
    delete.add_argument("--expected-current", type=int, required=True)
    delete.add_argument("--expected-catalog", help="catalog_digest from list; required for named demos")
    delete.add_argument("--confirm-delete", action="store_true", required=True)
    args = parser.parse_args()
    try:
        if args.command == "list":
            print(json.dumps(demo_scene.archives(), ensure_ascii=False, indent=2))
            return 0
        # Fail closed when ptyhost cannot observe activity. This snapshot and
        # the store write are not atomic together; operators must prevent a
        # concurrent resume while performing manual archive maintenance.
        sessions = asyncio.run(ptyhost.request({"op": "list"}))
        if not isinstance(sessions, list):
            raise demo_scene.StorageError("Session list unavailable")
        kind = demo_scene.delete_archive(args.name, args.created, args.expected_current, sessions,
                                         args.expected_catalog)
        print(f"Archive {kind} deleted: exact incarnation and revision confirmed. "
              "Run list again to check the other archives of this incarnation.")
        return 0
    except (demo_scene.StorageError, demo_scene.Conflict, ValueError, OSError) as exc:
        print(f"demo-scene-maintain: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
