#!/usr/bin/env python3
"""Tiny paste-burst-aware editor used by the PTY host conformance gate."""

import os
import time
import tty


LIMIT = 4096


def main():
    tty.setraw(0)
    os.write(1, b"WAKE_EDITOR_READY\r\n")
    pending = bytearray()
    last_text = None
    while True:
        chunk = os.read(0, 4096)
        if not chunk:
            return
        now = time.monotonic()
        pending += chunk
        if len(pending) > LIMIT:
            del pending[:-LIMIT]
        if chunk != b"\r":
            last_text = now
        while 13 in pending:
            enter = pending.index(13)
            body = bytes(pending[:enter])
            if (last_text is not None and now - last_text >= 0.1
                    and body.startswith(b"# Mesh:") and b"agent_inbox" in body):
                os.write(1, b"WAKE_SUBMITTED\r\n")
            del pending[:enter + 1]


if __name__ == "__main__":
    main()
