# Session Mesh OCaml tools

This directory is the opam package `session_mesh`. It builds five programs:

| Program | What it is | Used by |
|---|---|---|
| `mesh-ptyhost` | The PTY host, the only one: the Unix-socket protocol that `ptyhost.py` (the Python client module of the web server) speaks, implemented with Eio, plus a `processes` operation that serves process facts (process table, argv, working directory, terminal) to its local clients where they cannot read `/proc` themselves (macOS). | `./install.sh` finds it on `PATH` or in the opam switch, or takes `--ptyhost PATH` ([Native PTY host](../docs/install.md#native-pty-host)). |
| `mesh-board-mcp` | The stdio MCP server, with 30 tools, that Claude, Codex and Pi sessions started by the mesh receive. | The web server, which finds it in the opam switch named by `MESH_OPAM_SWITCH` (`agentmcp.py`). |
| `mesh-platform` | A diagnostic CLI that prints, as JSON, what the `mesh_platform` library sees on this system: capabilities, runtime directory, process table, one process or its command line, and whether a Linux-only feature is available. | Tests and manual checks. |
| `mesh-read` | A stdio MCP server with 2 tools, `list_sessions` and `read_transcript`, that reads local Claude and Codex transcripts under `$HOME/.claude/projects` and `$HOME/.codex/sessions`. | Not wired by the web server; an agent configuration can add it. |
| `mesh-history` | The History index: a SQLite database (FTS5 full-text search) driven over stdin/stdout in JSON lines. | The web server (`history.py`), which feeds it the parsed conversations and reads listings and searches from it; without the program it keeps the JSON cache and ripgrep. |

## mesh-history

One process, one request per input line, one response per line; the protocol is documented in
`lib/mesh_history_protocol.mli` and driven end to end by `tests/history-db-protocol.test.ts`. The
database is `history.sqlite` in `MESH_CACHE_DIR` (default `~/.cache/session-mesh`), or the file
named by `MESH_HISTORY_DB`; it is created with mode 0600 in WAL mode, holds prompts and replies, and
is only a cache that the web server rebuilds from the transcripts (a corrupt file is set aside).

- Operations: `hello`, `ingest`, `forget`, `list`, `detail`, `search` (`mode` is `text`), `cursors`,
  `stats`. An error response carries a `code`: `bad_request`, `busy` (database locked), `corrupt`
  or `db`; the process keeps serving.
- Search is full-text over chunk text and titles, ranked by bm25, one hit per conversation. A query
  is cut into letter and digit terms that are quoted and bound as a parameter, so FTS5 syntax typed
  by a user is plain text; every term must be in the same chunk, the last one also matches as a
  prefix. Accents and case are ignored (`unicode61 remove_diacritics`; level 2 needs SQLite 3.27,
  older libraries fall back to level 1).
- Schema: `schema_migrations` records the applied versions; `lib/mesh_history_store.ml` lists the
  migrations (version 1: `state`, `conversations`, `chunks` with the title as chunk -1, `tombstones`,
  the `chunk_fts` external-content index and its triggers). A database written by a newer build
  is refused. A vector table for semantic search is meant to arrive as migration 2.
- A source build needs the system's `libsqlite3` with FTS5 (the opam package `sqlite3`). The
  release executables carry their own SQLite instead: `scripts/build-sqlite.sh` compiles the
  pinned amalgamation (`scripts/bundle/sqlite.sha256`, FTS5 on, loadable extensions off) into a
  static library, and `scripts/bootstrap.sh` with `MESH_SQLITE_PREFIX` set points the `sqlite3`
  binding at it through `PKG_CONFIG_PATH`. The binary then links no `libsqlite3`, and every
  release platform has the same SQLite (3.54.1). `MESH_SQLITE_PREFIX` must name a directory
  dedicated to that build: missing, empty, or one `build-sqlite.sh` made before (it carries a
  `.mesh-sqlite-prefix` marker). Any other non-empty directory (a home, `~/.local`) is refused and
  left untouched; the script only replaces the three files it installs.

## mesh-board-mcp

The server reaches only the mesh of its own session: `@self` routes under
`http://127.0.0.1:$MESH_PORT/api/`, authenticated with the inherited `MESH_SESSION_TOKEN`
(`Authorization: MeshSession …`). It has no board-name, path, URL, cookie or master-token option,
never reads `MESH_SESSION`, and never sends a session identity supplied by an agent.
`MESH_SESSION_TOKEN` is required; `MESH_PORT` defaults to `7690` and must be a TCP port.

Its 30 tools, by group (the list is in `server`, at the end of `lib/mesh_board_mcp.ml`):

- **Whiteboard (9):** read and replace the session's Excalidraw document with a compare-and-swap
  `version`, open or refresh it in the page, list, read, diff and restore its revisions, and read
  the latest change.
- **Demos (11):** create, update and open the session's own declarative demo scene and list its
  revisions; list the named demos, and create, read, update, open and restore one of them and list
  its revisions.
- **Agent messages (6):** list peers, list the inbox, read, send, reply to and acknowledge a
  message. Message text is untrusted data.
- **Session requests (3):** ask the owner to create or restart a session, and read the status of
  such a request. The owner approves each request in the page.
- **Agent guide (1):** `agent_guide_read` returns the agent guide built into the program; it takes
  no argument and sends no request to the mesh. `lib/agent-guide.md`, the embedded text, is a
  byte-for-byte copy of `../docs/agent-guide.md`, kept in this directory so the package builds on
  its own; `tests/agent-guide-copy.test.ts` fails when the two differ.

After the bootstrap, run it by hand with
`opam exec --switch="$MESH_OPAM_SWITCH" -- mesh-board-mcp`.

### Legacy MCP clients

The server selects mcp-kit's explicit legacy response policy once per MCP connection. A client
negotiating protocol `2025-06-18` receives the strict standard response shape: initialization,
tool listing and tool results omit the newer `resultType`, `ttlMs` and `cacheScope` extensions.
Other legacy versions keep the mcp-kit `Modern` profile. This is a protocol-version policy, not a
client-name special case.

It also serves the static resource `mesh://compatibility/matrix`, a generated feature ×
protocol-profile diagnostic: it describes the three wire profiles the server supports and which
outputs each receives. It is not derived from a client-provided name or version, grants no
capability, and exposes no board or session identity.

## Dependencies and pins

The dependencies are declared in `dune-project`; `session_mesh.opam` is generated from it.

- **Every program:** OCaml 5.3, dune 3.24 or later, `yojson`.
- **`mesh-ptyhost`:** `eio` and `eio_main` 1.4 or later, `cstruct`, `mtime`, `digestif`.
- **`mesh-board-mcp` and `mesh-read`:** `mcp-kit` newer than 0.2.0; `mesh-board-mcp` also uses
  `cohttp-lwt-unix` (with `cohttp`, `cohttp-lwt`, `lwt`, `uri`) and, for demo scenes, `uutf` and
  `uucp`.
- **Libraries checked by the tests:** `base64` (demo artifacts).
- **Tests only:** `alcotest`, `qcheck-core`, `quint-connect` 0.3.0 or later (the opam package that installs the `ocaml-quint-connect` library).

`scripts/bootstrap.sh` pins two packages in the switch it uses; everything else comes from the
default opam repository:

- `dune` to 3.24.2, so that the dependency phase does not upgrade it;
- `mcp-kit` as `0.2.0+pin`, to a public source revision: `mesh-board-mcp` needs an API newer than
  the 0.2.0 release (response policy, compatibility resource).

The exact revision is in `scripts/bootstrap.sh`. The `mcp-kit` pin is provisional, until a release
has that API. `quint-connect` (ITF replay of the PTY host lifecycle) comes from opam; a switch
prepared by an earlier version still pins `ocaml-quint-connect` to a Git revision, and the script
removes that stale pin because the two packages conflict.

## Build and local verification

`scripts/test-local.sh` runs the complete local suite and calls `scripts/bootstrap.sh` for the
OCaml part. For an OCaml-only iteration, run the bootstrap directly in an existing OCaml 5.3
switch; it never creates a switch:

```sh
opam switch create session-mesh ocaml-base-compiler.5.3.0
MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh
```

Without `MESH_OPAM_SWITCH` the current opam switch is used. The bootstrap installs the pins above
and the package's dependencies and test dependencies, builds and tests the package, then installs
`mesh-ptyhost`, `mesh-board-mcp`, `mesh-read` and `mesh-platform` into that switch.
`bash scripts/bootstrap.sh --install-only` installs the same dependencies but runs no test.

Some OCaml tests drive `mesh-ptyhost` through the Python test harness `tests/ptyhost_proc.py`: the
interpreter named by `PYTHON`, otherwise `python3`, must provide `pytest` (the `.venv/` that
`scripts/test-local.sh` creates does). The bootstrap says so before installing anything when it
does not. Without `pytest`, `dune test` fails those cases on Linux and skips them with a
printed reason elsewhere.

On macOS the suite runs except for these parts, each skipped with a printed reason or not built:
the live checks of the Linux backend against the running kernel (the macOS backend has its own),
the `mesh-platform` CLI cases that need `/dev/full` or Linux executables, the cases that use
the Python test harness when the Python interpreter has no `pytest` (on Linux a missing `pytest` fails them),
and the two host checks that read another process's working directory and environment through
`/proc`. Host tests put their scratch directories under `/tmp` when the temporary directory is too
long for a socket path (the default macOS one is).

On macOS, with neither `MESH_RUNTIME_DIR` nor `XDG_RUNTIME_DIR` set, `mesh-ptyhost` uses
`~/Library/Application Support/session-mesh/run` (the home directory of the user database, not
`$HOME`), creating `session-mesh` and `run` with mode 0700; on Linux the default stays
`/run/user/<uid>`. `MESH_RUNTIME_DIR` overrides both. `mesh-platform runtime-dir` prints the
directory and its source (`macos_default` for this one); the rules are in
[Replacing the PTY host](../docs/operations.md#replacing-the-pty-host).

### Quint lifecycle fixture

`npm run check:ptyhost-lifecycle` uses the lockfile-pinned Quint `0.32.0` to typecheck
`mesh_wire/test/ptyhost_lifecycle.qnt`, generate its one fixed-seed ITF trace through Quint's local
TypeScript backend, remove only volatile Quint metadata, and compare the remaining public fields
with the checked-in `ptyhost_lifecycle.itf.json`. Every Quint invocation receives a fresh empty
`QUINT_HOME`; the checker rejects any file left there, so it cannot fall back silently to Quint's
Rust evaluator or a downloaded executable. The fixture records the source SHA-256, and the checker
rejects a source/fixture mismatch. The OCaml test replays that ITF; it does not parse Quint source.

Quint declares `adm-zip` as a vulnerable `^0.5` dependency. The npm override in `package.json`
pins that development-only copy to `0.6.1`. This adds no runtime dependency to the mesh.
