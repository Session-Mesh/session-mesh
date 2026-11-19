# Session Mesh OCaml tools

This directory is the opam package `session_mesh`. It builds eight programs, all of them shipped
in every release (bundles and native release assets): the six of this table, and `work-mcp` and
`work-read`, which have their own sections below.

| Program | What it is | Used by |
|---|---|---|
| `mesh-ptyhost` | The PTY host, the only one: the Unix-socket protocol that `ptyhost.py` (the Python client module of the web server) speaks, implemented with Eio, plus a `processes` operation that serves process facts (process table, argv, working directory, terminal) to its local clients where they cannot read `/proc` themselves (macOS). | `./install.sh` finds it on `PATH` or in the opam switch, or takes `--ptyhost PATH` ([Native PTY host](../docs/install.md#native-pty-host)). |
| `mesh-board-mcp` | The stdio MCP server, with 30 tools, that Claude, Codex and Pi sessions started by the mesh receive. | The web server, which finds it in the opam switch named by `MESH_OPAM_SWITCH` (`agentmcp.py`). |
| `mesh-platform` | A diagnostic CLI that prints, as JSON, what the `mesh_platform` library sees on this system: capabilities, runtime directory, process table, one process or its command line, and whether a Linux-only feature is available. | Tests and manual checks. |
| `mesh-read` | A stdio MCP server with 2 tools, `list_sessions` and `read_transcript`, that reads local Claude and Codex transcripts under `$HOME/.claude/projects` and `$HOME/.codex/sessions`. | Not wired by the web server; an agent configuration can add it. |
| `mesh-history` | The History index: a SQLite database (FTS5 full-text search) driven over stdin/stdout in JSON lines. | The web server (`history.py`), which feeds it the parsed conversations and reads listings and searches from it; without the program it keeps the JSON cache and ripgrep. |
| `mesh-logout-all` | The command that signs every browser out: it asks the local mesh, with the master token, to raise the cookie generation, and raises it in `cookie-generation` itself when no mesh answers. | The user, through `~/.local/bin/mesh-logout-all`, which `./install.sh` links to the release's program (bundle or native programs) or, for a source install, to the opam switch's. It replaces the Python script `bin/mesh-logout-all`. |

## Library: worklog

`worklog/` is a library only (`session_mesh.worklog`, no program yet): it reads and writes a
plain-file project-tracking repository in the data format of the `wl` worklog tool, so that files
written by either coexist. See [docs/worklog-format.md](../docs/worklog-format.md). Its tests run
with `dune runtest worklog` and use a fictional fixture in `worklog/test/fixture` and a repository written by `wl` itself, with its
outputs, in `worklog/test/golden`. Two C functions (`flock_stubs.c`) take the same BSD `flock(2)`
lock as `wl` and read the monotonic clock.

## Generic libraries

`generic/` holds small libraries that know nothing of sessions or agents. They have no program
and no caller yet; the session listing program is meant to be built on them. Each module has an
`.mli`, and the tests are in `generic/test` (`dune runtest generic`).

| Library | What it is |
|---|---|
| `mesh_lru` | A map bounded by entry count and optionally by a caller-measured weight, evicting the least recently used entry; O(1) operations. |
| `mesh_priority` | A keyed work queue without duplicates: bumped items first, then a leading list in its order, then the caller's own ordered tiers, by rank within a tier. The session listing is expected to name its tiers (focused, pinned, recent, visible, the rest) in its own module. |
| `mesh_deadline_pool` | Items run under Eio with bounded concurrency and a deadline each, ending `Ready`, `Slow` or `Failed`; blocking calls in abandonable system threads, with a bound on threads; a no-progress watchdog for rounds. |
| `mesh_jsonl` | Bounded JSON lines: a line splitter that never holds more than the line bound, and a decoder that checks length and nesting depth before parsing, refuses comments and raw control characters in strings, rejects or strips invalid UTF-8, and keeps the last value of a duplicated key, as Python does. Its encoder never raises and only writes strict JSON in UTF-8. |
| `mesh_safe_file` | Opening a file written by another program without following a link or blocking on a FIFO (`lstat`, `O_NONBLOCK`, then `fstat` of the same file), and positioned reads. |
| `mesh_jsonl_tail` | An incremental fold over an append-only JSON-lines file: reads only appended bytes, waits for a partial last line, starts again on truncation, inode change or changed bytes before the cursor, and bounds each call's reads. It ports the History index's Python reader. |
| `mesh_jsonl_rpc` | A JSON-lines request protocol over Eio flows, with the frames of `mesh-history` (`req` echo, `ok`, `error.code`), a version on every frame, streamed events, and lines bounded in both directions. |

**Independence rule.** A generic library depends only on other generic libraries and on `unix`,
`threads.posix`, `yojson`, `eio` and `cstruct`. `generic/test/generic_guard.ml`, run by
`dune runtest`, reads their dune files with an allow list: one `(library ...)` stanza per
directory with known fields only, `libraries` (including `select` and `re_export`) naming only
allowed packages, no preprocessor, no `rule`, `copy_files` or `include_subdirs`, no nested
directory and no directory it does not list. `test_generic_guard` injects each of these
violations into a temporary copy and checks that the guard refuses it. Adding a generic library,
or an allowed external dependency, means editing its lists on purpose.

### Follow-up: converge the safe-open copies

The same "open a file another program wrote, without following a link or blocking" logic exists
in five places: `worklog/lib/safefs.ml`, `lib/mesh_update_report.ml`, `lib/mesh_read.ml`,
`lib/mesh_agent_resume_preset.ml` and `generic/safe_file` (`Mesh_safe_file`). The next slice
moves `mesh_read`'s `with_regular_contents` onto `Mesh_safe_file.open_regular`. It currently calls
`lstat` and then `open_in_bin` without `O_NONBLOCK`, so a FIFO swapped in between the two calls
blocks the read. That slice adds a test showing that such a FIFO is answered in under 100 ms.
`mesh_update_report` and `mesh_agent_resume_preset` can then keep their extra owner, permission
and identity checks on top of `open_regular`. `Safefs` stays separate: it belongs to the worklog
library, opens files for writing and checks the path again after opening.

## work-mcp

`work_mcp/` holds the `work_mcp` library and the stdio program `work-mcp`: 17 `work_*` MCP tools
(resume, tasks, projects, products, update, log, blockers, sessions, non-blocking questions) over
the worklog library. It uses `mcp-kit` like `mesh-board-mcp` but does not talk to the Mesh. It
reads `WL_HOME` (the data repository, created at first use through the library's `init`, never
overwritten), `MESH_SESSION` (the session name) and the agent markers of the environment; it
never reads the session token. There is no tool that answers a question: `Work_questions.answer`
is a library function for the interface. Registering the server with an agent is a separate
owner step. See [docs/work-mcp.md](../docs/work-mcp.md); tests: `dune runtest work_mcp`.
By hand: `WL_HOME=/tmp/demo MESH_SESSION=demo ./_build/default/work_mcp/bin/work_mcp_main.exe`.

## work-read

`work_read/` holds the `work_read` library and the program `work-read`, the read path of the
Projects view: one subcommand per run (`products`, `projects`, `project`, `task`, `resume`,
`sessions-of`), one bounded JSON document on standard output. It is read-only (no write, no lock,
no repository creation) and reuses the text cleaning, renderers and question fold of `work_mcp`.
The server starts it through `POST /api/work/v1`. It is built and installed with the package
(`public_name work-read`, like `work-mcp`), and a release ships both: `bin/work-read` and
`bin/work-mcp` of a bundle, and the release assets `work-read-<platform>` and
`work-mcp-<platform>`. See
[docs/work-read.md](../docs/work-read.md); tests: `dune runtest work_read`.
By hand: `WL_HOME=/tmp/demo ./_build/default/work_read/bin/work_read_main.exe products`.

## mesh-logout-all

It takes no argument and reads `MESH_CONF_DIR` (the token and `cookie-generation`), `MESH_CACHE_DIR`
and `MESH_PORT` with the rules of `meshpaths.py` (`lib/mesh_paths.mli`). The request is an empty
`POST /api/logout-all` to `127.0.0.1` with `Authorization: Bearer <token>`: no proxy whatever the
`*_proxy` variables say, no redirection followed, one 10-second deadline for the whole exchange
(`lib/mesh_local_http.mli`). A 2xx answer prints the new generation; any other answer is reported
and exits 1 without touching the file; only a mesh that does not answer leads to the disk, where the
generation is read, created, repaired and raised as `cookiegen.py` does (`lib/mesh_generation.mli`).
The library `mesh_cli` (`mesh_paths`, `mesh_generation`, `mesh_local_http`, `mesh_python_text`) is
shared by the native command-line programs.

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
opam repository at the commit fixed in `scripts/release-pins.sh`, which the bootstrap selects for
that switch only (repository `session-mesh` in the opam root), whatever the host's own
repositories hold:

- `dune` to 3.24.2, so that the dependency phase does not upgrade it;
- `mcp-kit` as `0.2.0+pin`, to a public source revision: `mesh-board-mcp` needs an API newer than
  the 0.2.0 release (response policy, compatibility resource).

The exact revision is in `scripts/bootstrap.sh`. The `mcp-kit` pin is provisional, until a release
has that API. `quint-connect` (ITF replay of the PTY host lifecycle) comes from opam; a switch
prepared by an earlier version still pins `ocaml-quint-connect` to a Git revision, and the script
removes that stale pin because the two packages conflict.

## Build and local verification

`scripts/test-local.sh` runs the complete local suite and calls `scripts/bootstrap.sh` for the
OCaml part. For an OCaml-only iteration, run the bootstrap directly; it creates the switch with
OCaml 5.3 from the pinned repository when it does not exist. An existing switch must use OCaml 5.3
and already read only the pinned repository, or only the `session-mesh` repository of an earlier
run, whose URL then follows a changed pin (the former URL is printed to undo it); the bootstrap refuses to change the repositories of
another existing switch, unless it is the checkout's local switch `_opam/` (CI) or
`MESH_OPAM_SELECT_PINNED=1` is set, in which case it prints the command that restores them:

```sh
MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh
```

Without `MESH_OPAM_SWITCH` the current opam switch is used, under the same rule. The bootstrap
installs the pins above and the package's dependencies and test dependencies, builds and tests the package, then installs
`mesh-ptyhost`, `mesh-board-mcp`, `mesh-read`, `mesh-platform`, `mesh-history`,
`mesh-logout-all`, `work-read` and `work-mcp` into that switch.
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
