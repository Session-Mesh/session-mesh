# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Source files in the document panel, shown read-only in Monaco.

A code file is served as a small page that embeds the text and loads the
vendored Monaco build from /viewlib/monaco/. It runs under the same opaque-
origin sandbox and no-data-out policy as rendered Markdown; its scripts run
by nonce, and Monaco's AMD loader stamps the nonce on the modules it adds
(no 'strict-dynamic', so no script from anywhere else can run).
Web workers stay off (worker-src 'none'): Monaco then runs its language
support on the page, which is enough for a read-only view.
"""

import json
import re
from pathlib import Path

from aiohttp import web

STATIC = Path(__file__).resolve().parent / "static"
MONACO = (STATIC / "vendor" / "monaco").resolve()
MAX_BYTES = 4 * 1024 * 1024   # larger files are served as plain text


def _monaco_version():
    """The vendored Monaco version, from its loader's header: module URLs carry
    it, so an upgrade never mixes cached old and new modules."""
    head = (MONACO / "vs" / "loader.js").read_text(errors="replace")[:2000]
    match = re.search(r"Version: ([0-9][0-9A-Za-z.\-]*)", head)
    return match[1] if match else "unknown"


MONACO_VERSION = _monaco_version()

# extension -> Monaco language id
CODE_LANG = {
    ".py": "python", ".pyi": "python", ".ml": "fsharp", ".mli": "fsharp", ".mll": "fsharp",
    ".mly": "fsharp", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".json": "json",
    ".jsonc": "json", ".jsonl": "plaintext", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
    ".ini": "ini", ".cfg": "ini", ".conf": "ini", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".rs": "rust", ".go": "go", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
    ".cxx": "cpp", ".java": "java", ".kt": "kotlin", ".scala": "scala", ".rb": "ruby",
    ".php": "php", ".lua": "lua", ".pl": "perl", ".sql": "sql", ".css": "css", ".scss": "scss",
    ".less": "less", ".swift": "swift", ".dart": "dart", ".r": "r", ".jl": "julia",
    ".tex": "plaintext", ".diff": "plaintext", ".patch": "plaintext", ".txt": "plaintext",
    ".log": "plaintext", ".csv": "plaintext", ".xml": "xml", ".proto": "protobuf",
    ".graphql": "graphql", ".el": "scheme", ".clj": "clojure", ".ex": "elixir", ".exs": "elixir",
    ".erl": "plaintext", ".hs": "plaintext", ".v": "plaintext", ".sv": "systemverilog", ".md": "markdown", ".rst": "restructuredtext", ".tf": "hcl", ".hcl": "hcl", ".ps1": "powershell", ".bat": "bat", ".cs": "csharp", ".m": "objective-c", ".qnt": "typescript",
    ".tla": "plaintext", ".sol": "solidity", ".mligo": "cameligo", ".tz": "plaintext",
    ".dockerfile": "dockerfile", ".mk": "plaintext", ".vue": "html", ".svelte": "html",
}
# file name (no or ambiguous extension) -> language
CODE_NAMES = {"Dockerfile": "dockerfile", "Makefile": "plaintext", "dune": "scheme",
              "dune-project": "scheme", "CMakeLists.txt": "plaintext", "Justfile": "plaintext"}


def language_for(path):
    """Monaco language for a path, or None when it is not shown as code."""
    return CODE_NAMES.get(path.name) or CODE_LANG.get(path.suffix.lower())


def is_text(data):
    return b"\0" not in data[:8192]


def code_csp(nonce, sandbox):
    return (f"sandbox {sandbox}; default-src 'none'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; "
            "form-action 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; "
            f"script-src 'nonce-{nonce}'; frame-src 'none'")


def code_page(path, text, nonce, language):
    # "</" would close the script element; "<!--" would switch the parser's script state
    # ensure_ascii=False: an invalid byte (U+FFFD) stays 3 bytes instead of a 6-byte escape;
    # U+2028/2029 are escaped anyway (harmless in JSON, kept out of the script text)
    src = (json.dumps(text, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\u0021--")
           .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
    values = {"title": _html_escape(path.name), "src": src, "nonce": nonce, "lang": language,
              "monaco": MONACO_VERSION}
    return _PLACEHOLDER_RE.sub(lambda match: values[match[1]], _TEMPLATE)


def _html_escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


_TEMPLATE = (STATIC / "code.html").read_text()
_PLACEHOLDER_RE = re.compile(r"\{\{(title|src|nonce|lang|monaco)\}\}")


async def monaco_lib(request):
    """Monaco's files, for sandboxed code pages (which carry no cookie).
    Public library code only; the path cannot leave the vendored directory."""
    try:
        path = (MONACO / request.match_info["tail"]).resolve()
        if MONACO not in path.parents or not path.is_file():
            raise web.HTTPNotFound()
    except (ValueError, OSError):        # a NUL byte, a name too long
        raise web.HTTPNotFound()
    # CORS for the codicon font: a sandboxed page has an opaque origin, and fonts
    # are fetched in CORS mode. Public library files, so any origin may read them.
    return web.FileResponse(path, headers={"Cache-Control": "max-age=86400",
                                           "X-Content-Type-Options": "nosniff",
                                           "Access-Control-Allow-Origin": "*"})
