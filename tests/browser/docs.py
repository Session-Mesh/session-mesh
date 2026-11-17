# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Documents the browser tests write into the temporary home."""

import struct
import zlib

STYLE_COLOR = "rgb(1, 2, 3)"


def png(width=4, height=3):
    """A valid RGB PNG, so naturalWidth is meaningful."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\x00" + b"\x80\x40\x20" * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


REPORT_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"></head>
<body><p class="mark" id="mark">report</p><img id="logo" src="assets/img/logo.png">
<script>document.body.dataset.ran = "1";</script></body></html>
"""

REPORT_CSS = ".mark { color: %s; }\n" % STYLE_COLOR

README_MD = """# Rapport

| a | b |
|---|---|
| 1 | 2 |

- [x] fait
- [ ] à faire

![logo](img/logo.png)

```python
def answer():
    return 42
```

```mermaid
graph TD
  A --> B
```
"""


def write(directory, relpath, content):
    path = directory / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    return path


def report(directory):
    """``rep/report.html`` with a stylesheet and an image two levels down."""
    write(directory, "rep/assets/style.css", REPORT_CSS)
    write(directory, "rep/assets/img/logo.png", png())
    return write(directory, "rep/report.html", REPORT_HTML)


def readme(directory, text=README_MD):
    write(directory, "rep/img/logo.png", png())
    return write(directory, "rep/README.md", text)
