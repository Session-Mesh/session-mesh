#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Generate the versioned Python-reference vectors used by ``mesh-wire``."""

import argparse
import hashlib
import hmac
import json
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ptyhost  # noqa: E402
import sessiontoken  # noqa: E402


FIXTURE = ROOT / "tests/fixtures/wire-vectors-v1.json"
MASTER_TOKEN = "mesh-wire-reference-v1"
NAME = "alpha"
NONCE = "0123456789abcdef0123456789abcdef"


def header(kind, length):
    return (kind + struct.pack(">I", length)).hex()


def token_vectors():
    previous_key = sessiontoken.KEY
    try:
        sessiontoken.configure(MASTER_TOKEN)
        valid = sessiontoken.issue(NAME, NONCE)
        legacy_mac = hmac.new(sessiontoken.KEY, b"\0".join((b"ds1", NAME.encode(), NONCE.encode())),
                              hashlib.sha256).hexdigest()
    finally:
        sessiontoken.KEY = previous_key
    mac = valid[:-1] + ("0" if valid[-1] != "0" else "1")
    return {
        "master_token": MASTER_TOKEN,
        "valid": valid,
        "bad_mac": mac,
        "other_name": valid.replace(".alpha.", ".beta.", 1),
        "malformed_nonce": valid.replace(f".{NONCE}.", ".not-a-nonce.", 1),
        "different_case": valid.replace(".alpha.", ".Alpha.", 1),
        "legacy_prefix": f"ds1.{NAME}.{NONCE}.{legacy_mac}",   # well formed, signed under the retired ds1 domain
    }


def frame_vector(kind, payload):
    wire = ptyhost.frame(kind, payload)
    return {"kind": kind.decode(), "payload_hex": bytes(payload).hex(), "wire_hex": wire.hex()}


def vectors():
    """The stable JSON object committed for cross-language verification."""
    return {
        "format": 1,
        "session_token": token_vectors(),
        "frames": [
            frame_vector(b"C", b'{"op":"list"}'),
            frame_vector(b"D", b"terminal bytes\x00\xff"),
            frame_vector(b"R", b'{"rows":24,"cols":80}'),
            frame_vector(b"X", b'{"code":0}'),
        ],
        "length_limits": [
            {"kind": "C", "length": ptyhost.MAX_SMALL_FRAME, "accepted": True,
             "header_hex": header(b"C", ptyhost.MAX_SMALL_FRAME)},
            {"kind": "C", "length": ptyhost.MAX_SMALL_FRAME + 1, "accepted": False,
             "header_hex": header(b"C", ptyhost.MAX_SMALL_FRAME + 1)},
            {"kind": "D", "length": ptyhost.MAX_FRAME[b"D"], "accepted": True,
             "header_hex": header(b"D", ptyhost.MAX_FRAME[b"D"])},
            {"kind": "D", "length": ptyhost.MAX_FRAME[b"D"] + 1, "accepted": False,
             "header_hex": header(b"D", ptyhost.MAX_FRAME[b"D"] + 1)},
        ],
        "truncated_frames": [
            {"kind": "C", "wire_hex": "43000000027b", "result": "incomplete_payload"},
            {"kind": "D", "wire_hex": "4400000001", "result": "incomplete_payload"},
        ],
    }


def rendered():
    return json.dumps(vectors(), indent=2, sort_keys=True) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed vectors are stale")
    args = parser.parse_args()
    output = rendered()
    if args.check:
        return 0 if FIXTURE.read_text() == output else 1
    print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
