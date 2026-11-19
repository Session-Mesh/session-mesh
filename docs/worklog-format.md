# Worklog data format and the `mesh_worklog` library

This page describes the plain-file project-tracking repository that the OCaml library `session_mesh.worklog` (`ocaml/worklog/`) reads and writes, and the operations the library offers. Files written by the library and files written by the `wl` worklog tool coexist in one repository: the data format is the one of the `wl` worklog tool (MIT licence). This page is our own description of that format; it is not a copy of the tool's specification.

The library has no command line, server or user interface. A later slice puts an MCP server on top of it.

## What a repository is

A data repository is a directory that contains `taxonomy.yaml`. Everything else is optional and created on demand:

```
taxonomy.yaml                      categories and products
tasks/<product>/T-7f3a[-slug].md   identity of a task, plus free notes
events/YYYY-MM.<host>.jsonl        append-only history, one file per month and host
.wl.lock                           writer lock (not versioned)
```

State lives only in events. A task file holds the identity of a task (id, home product, category, creation time) and free-form notes; it never changes after creation except for the notes a person edits. Each host appends only to its own event files, so two machines never edit the same file and a git merge never conflicts on events.

### Discovery

The repository is `$WL_HOME` (a leading `~` or `~user` is expanded; a relative path is taken as given, so it is resolved against the current directory, as `wl` does), else `~/worklog-data`, else the older `~/worklog`. `~` is `$HOME`, or the account's home directory when `HOME` is unset or empty (the library never builds a relative default path; with no home at all it is an error). A directory is a repository when `taxonomy.yaml` is a file (or a link to one; a directory of that name does not count). If both default directories are valid the result is an error: set `WL_HOME`. Nothing is searched in the current directory.

### taxonomy.yaml

```yaml
categories:
  platform:
    name: Platform
    products:
      - gateway
      - relay:
          - relay-core
          - relay-edge
  office:
    name: Office
    projects:
      - supplies
```

A category has a `name` and either `products:` (a tree: each item is an id, or a one-key mapping `root: [children]`, two levels at most) or the older `projects:` (a flat list). It cannot have both. Product ids match `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 100 characters, and are unique across all categories. A root that has children can itself be assigned to tasks. Shapes that are not accepted (a third level, a multi-key item, two ids shared by categories) make the file invalid.

The library reads this file with its own reader for the subset of YAML used here (block and flow collections, plain and quoted scalars, comments). Anchors, tags, block scalars and multi-line scalars are refused rather than misread, and so is nesting deeper than 64 levels (the file is then invalid; the reader never overflows the stack).

Plain (unquoted) scalars are typed as YAML 1.1 types them, which is what the PyYAML loader of `wl` does: a product id, a category key or a category `name` that would be read as a boolean, null, number or date must be quoted. Only real numbers count as numbers: `yes`, `null`, `12`, `0x1F`, `1_000`, `1.5`, `1.5e+3`, `.inf`, `1:30` (base 60), `2026-11-19` are typed, but `2fa`, `3d`, `1e3`, `4b`, `0o17`, `1.5e3` and `08` are strings (an exponent needs a sign in YAML 1.1) and are valid ids. A plain scalar holding `: ` or ending in `:` (`name: a: b`) is refused, as PyYAML refuses it; a one-key item `12: [x]` or a category key `12:` is refused because the key is a number. Also refused, as PyYAML refuses them: a plain value that starts with `,`, `]` or `}`, or with `-`, `?` or `:` followed by a blank or the end of the line (`name: - Foo`, `name: ? x`, `name: -`); and a line that ends in a tab, which includes a tab before a comment and a tab after a flow collection or a quoted scalar. A comment needs a space before its `#`. Keys other than the category keys and root items are not typed-checked, as in `wl`. This is a list of the cases checked, not a proof of equality with PyYAML: any other difference found is listed under Known differences. New ids written by the library (`Init.init`, `Taxonomy_edit.add_product`) are held to the stricter rule that they must not even look like a number (`2fa` is refused for a new product, accepted when read). `Init.init` writes the category name plain when it is made of letters, digits, inner spaces, `_`, `.` and `-` and is not typed by YAML, and as a double-quoted string otherwise, and loads the text it is about to write before creating any file; a name that does not read back is refused with `Usage` and nothing is written. `taxonomy.yaml` is read with a limit of 1 MiB (a larger file is an error, not a truncation).

### Task files

```
---
id: T-7f3a
project: gateway
category: platform
created: "2026-11-10T10:00:00Z"
---
Free-form notes.
```

`project` here is the **home product**, the product in the `created` event. The file is stored under `tasks/<home product>/` and never moves, even when the task is later reclassified. The file name starts with the id; the slug after it is informational. If a file disagrees with the events, the events win and a warning is given. A task file without a `created` event is ignored with a warning; a `created` event without a file is valid.

### Events

One JSON object per line with `ts` (UTC `YYYY-MM-DDTHH:MM:SSZ`; the minute-precision form is accepted on reading), `task` (the id the event is about) and `type`. Optional on every event: `agent`, `session` (the full id) and `prov` (`stated`, `inferred` or `confirmed`; absent means `stated`, and writers omit it when `stated`).

| type | fields | effect |
|---|---|---|
| `created` | `title`, `project` (home product), `category`, `priority`, `status` | defines the task |
| `set` | `field`, `to` (`null` clears where allowed), `category` for `product` | scalar field |
| `add`, `remove` | `field`, `value` | list field, set semantics |
| `progress`, `note` | `text` | latest text becomes the task's last note |
| `decision`, `learning`, `risk`, `metric`, `mentoring` | `text` | typed record; never changes the last note or a field |
| `shipped` | `text`, `date` (`YYYY-MM-DD`) | typed record with a date |
| `session_linked` | `agent`, `session`, `cwd`, `host`, `repo`, `branch` | links an agent session |
| `blocker` | `id` (`B-` and hex), `kind`, `on`, `text` | opens a blocker |
| `unblocked` | `blocker`, `text` | closes it |
| `project_created` | `title`, `product`, `category` | defines a project (id `P-<hex>`) |

Task ids are `T-` plus four or more lowercase hex digits; project ids `P-` plus four or more. The two namespaces are separate.

Task scalar fields: `status` (`inbox todo in_progress blocked waiting done dropped`), `priority` (`P0`-`P3`), `due` and `eta` (dates), `title`, `product` (current product), `project` (a `P-` id), `track`, `owner` (default `me`), `size` (`S M L`), `origin` (`planned assigned reactive self`). List fields: `tags`, `links`, `blocked_by` (full task ids), `also` (product names). Project scalar fields: `title`, `product`, `quarter` (`2026Q4`), `owner`, `hlp`, `goal`, `status` (`active done dropped`); list fields `milestones`, `risks`. Text limits: titles 200 characters, labels 100, list items and project texts 500, event text 8000.

### Reading: the fold

The current state is a pure function of the events:

- Events from all hosts and months are ordered by `(ts, host, file name, line)`. The file name does not otherwise matter: readers trust `ts`. A later event wins; a host name that compares larger wins a tie.
- A scalar is the `to` of its latest valid `set`; a list is the sequential fold of `add` and `remove`. `created` is the initial-value event at its own key and resets everything keyed before it.
- The task's current product is the latest `set product` (which carries its `category`), else the home product.
- For a duplicate id, the earliest valid `created` defines the task; later ones are reported as `DUPLICATE_ID` and left out.
- Byte-identical lines in different files (a merge artefact) count once; identical lines in one file are separate events.
- A blocker is open until an `unblocked` event with a later key names its id.
- Unknown event types, unknown fields and invalid values are ignored with a warning naming file and line. A malformed line (blank, not UTF-8, CRLF, BOM, conflict marker, invalid JSON, missing `ts`/`task`/`type`, bad timestamp) is skipped with a warning and never stops a read. A timestamp more than a day ahead of the clock is accepted with a warning. A line must be strict JSON: comments (`/* */`, `//`), other JSON extensions and a raw control character (below U+0020, a literal tab for instance) inside a string are malformed, as for Python's `json.loads`; `NaN` and `Infinity` are accepted, as Python accepts them. The checks are those listed here (lone surrogates are in Known differences). An event file is read with a limit of 64 MiB: a larger file is skipped with a warning.

### Files and links

Task files, event files, the `events/` and `tasks/<product>/` directories and `.wl.lock` are never reached through a symbolic link, for reads and for writes, and anything that is not a regular file (or, for a directory, a real directory) is refused. A path is checked with `lstat` (a link, FIFO or device is refused without being opened), then opened with `O_NONBLOCK` and checked again (its type, device and inode must equal what `lstat` says about the path); OCaml's `Unix` has no `O_NOFOLLOW`, so a special file swapped in between the two checks is opened without blocking and then refused. A missing file is created with `O_EXCL` before it is opened. A refused entry is skipped by readers with a warning that names it; a write that would go through it fails with an error and writes nothing. The directory components between the repository root and the file are checked just before use; a local attacker who can swap a directory component in that window is outside the model, as for `wl`. The repository root itself may be a link (so may its parents). `taxonomy.yaml` is read as a file, links included, opened `O_NONBLOCK` and checked to be a regular file on the descriptor (a FIFO swapped in after discovery gives an error, never a hang); the editor refuses to edit it when it resolves outside the repository. Readers follow a `taxonomy.yaml` symbolic link to any file (as `wl` does), and git can carry a symbolic link: a data repository obtained from elsewhere can make a reader parse any file the user can read, and a parse error quotes at most a category key. Treat a data repository of unknown origin as untrusted input.

Every reader function returns `Error` instead of raising: an unreadable directory or file under the repository is an `Error` (a single unreadable event file is a warning, as before).

## Operations of the library

Reads take no lock. Writes take an exclusive lock on `.wl.lock` (a BSD `flock(2)`, the one `wl` takes, so the two tools exclude each other; 30 s timeout on the monotonic clock, `WL_LOCK_TIMEOUT` overrides it, and a value that is not finite or is negative is replaced by 30 s or 0), read the current state under the lock, validate, write, and commit.

| Area | Functions | Notes |
|---|---|---|
| Discovery and clock | `Ctx.of_env`, `Ctx.make` | `WL_HOME`, `WL_HOST`, `WL_NOW`, `WL_LOCK_TIMEOUT`; clock, host and id generator can be injected |
| Read | `Store.load`, `Reader.snapshot` | folded world plus warnings |
| Task lists | `Query.list_tasks` | filters: product (rolled up through the taxonomy), project, status (default hides `done` and `dropped`), track, owner, session, category |
| One task | `Query.get_task` | folded fields, open blockers, sessions, full timeline, notes |
| Briefing | `Resume.build` | sections below |
| Projects | `Query.list_projects`, `Query.get_project` | open and done counts; progress is done / (open + done), `None` when both are 0; `dropped` tasks count in neither |
| Write tasks | `Write_task.add set add_item remove_item log note block unblock link` | validations as in the tables above |
| Write projects | `Write_project.add set add_item remove_item` | case-insensitive duplicate title refused within a product |
| Taxonomy | `Taxonomy_edit.add_product` | see below |
| Initialisation | `Init.init` | one category, one product, empty `tasks/` and `events/`, a local git repository with one commit and no remote; refuses a directory that has a `taxonomy.yaml` |

Agent and session are inputs: `Session.make` or `Session.resolve` (precedence: argument, `WL_SESSION`, `CLAUDE_CODE_SESSION_ID`, `OPENCODE_SESSION_ID`; the agent from the argument, `WL_AGENT`, or implied by the variable). Because a caller such as an MCP server passes them through, `cwd` and `repo` (at most 4096 characters) and `branch` (at most 255) must be single-line text without control characters; `wl` takes these from the process and git instead and does not check them. `Session.resolve` validates `cwd` (absolute, single line) before it runs any git call, and never raises. `Write_task.log` writes a `session_linked` event first, in the same append, when the session has an id and is not yet linked to the task, as `wl log` does; `link` does it explicitly. No other write links the session: the MCP layer calls `link` on the first write of a session.

### Briefing sections

`Resume.build` sorts open tasks into HERE (at most 5: a link to the caller's session; else the same host, repo and branch; else a linked folder that is the caller's folder or an ancestor, never `/` or the home directory), BLOCKED/WAITING (status `blocked` or `waiting`, or an open blocker; with an "unblock?" hint when every `blocked_by` task is `done` or `dropped`), DUE (due within 7 days, overdue included), STALE (`in_progress`, no event for more than 5 days) and IN PROGRESS. A task appears once, in that precedence. Dates are UTC. When any task shown in some section has a project or track, each section is ordered first by product, project and track; tasks that appear in no section (`todo` and `inbox` without `show_all`) do not count, as in `wl`.

### Writer guarantees

- **Ids.** `T-`/`P-` plus four hex digits, a fifth after 20 collisions, up to eight; checked against task files and `created` events of every host. Blocker ids are `B-` plus six hex digits, unique among all blockers.
- **Appends.** One write on an `O_APPEND` descriptor, then `fsync`. This is true because the events of one change are capped at 60 000 bytes (under the 64 KiB that `Unix.single_write` carries): a change whose events are bigger (thousands of tags, links, also, milestones or risks at once) is refused with `Usage` before any write, and the same limit keeps the last event written by this library within the 64 KiB tail read for timestamps (see Known differences for lines written by `wl`). If the file does not end in a newline (a torn last line), a newline is written first.
- **Timestamps.** Never lower than the newest timestamp in the host's own newest event file.
- **No-op writes.** A `set` to the current value, an `add` of a present value or a repeated link writes nothing and reports `Unchanged`.
- **Validation first.** A refused input writes nothing. Errors are `Usage`, `Not_found`, `Malformed`, `Lock_timeout`, `Repo` and `Other`, mapped to the exit codes 2, 3, 4, 5, 6 and 1 of `wl`.
- **Commits.** When the repository is a git repository, only the written paths are committed, with message `wl: <command> <id>` (`wl: project add P-xxxx`, `wl: product add <id>`). Unrelated staged or dirty files stay out. Hooks and signing are off. The library never pushes. Each git call, made while the lock is held, is killed after 60 seconds (as `wl` does) and counts as a failed commit; the environment of git calls is scrubbed of the variables that redirect it (`GIT_DIR`, `GIT_PREFIX`, ...) or inject configuration (every `GIT_CONFIG_*`). During a merge or rebase, or outside a git repository, the commit is skipped and a warning goes to `Ctx.warn`. The git step runs after the events are durable and can never turn a successful write into an `Error`: any failure of it, an exception included, is a warning. Git output is read with a non-blocking poll (not `select`, which fails for descriptors at or above 1024), and the child is killed and reaped on every exit path.

### Adding a product

`Taxonomy_edit.add_product` edits `taxonomy.yaml` as text and leaves every other byte alone (comments, quoting, line endings, a missing final newline). It understands block-style lists of plain or quoted ids and one-key mappings; any other layout is refused. A plain parent gains a trailing `:` when it receives its first child. The edited text is loaded again and must equal the old taxonomy plus exactly the new product before it replaces the file atomically. There is no rename, move or delete. The id must not look like a task, project, proposal or blocker id, nor read as a YAML boolean, null or number.

## Compatibility with `wl`

### Evidence in the repository

`ocaml/worklog/test/golden/` holds a small fictional data repository (`repo/`: two hosts, a tree, a product named `2fa`, projects, blockers, a linked session, a dropped and a done task) that the real `wl` tool wrote, and three of its outputs on it as golden files: `ls.json` and `ls-all.json` (`wl ls --json`, with and without `--all`), `resume.json` and `resume-all.json` (`wl resume --json`, with and without `--all`) and `project-ls.json` (`wl project ls --json`). The tests `test_golden` read that repository with this library and compare every field of every row with the golden files (order included, object key order aside), and write the same operations with this library into a fresh repository and compare the shape of what was written (event type, field and key order of every event, task file names and frontmatter keys) with what `wl` wrote. They need neither `wl` nor Python.

The golden files were produced once, with the real tool, on fictional data only. Command lines (`wl` is the tool; `$W` its checkout; the clock and host changed between commands through `WL_NOW` and `WL_HOST`, `lab` or `desk`):

```sh
export WL_HOME=<empty temporary directory> WL_NO_SYNC=1 WL_NO_EXTRACT=1 HOME=<temporary directory>
# taxonomy.yaml written by hand (the one in golden/repo)
cd /tmp/wl-demo/project            # the folder recorded by the link, fictional
wl() { uv run --offline --no-dev --project "$W" wl --no-commit "$@"; }
WL_NOW=2026-11-02T09:00:00Z WL_HOST=lab wl project add -p gateway --quarter 2026Q4 --goal "Ship the gateway" --milestone alpha "Gateway rollout"
WL_NOW=2026-11-02T09:05:00Z WL_HOST=lab wl project add -p 2fa "Second factor"
WL_NOW=2026-11-03T09:00:00Z WL_HOST=lab wl add -p gateway-api -P P1 --status in_progress --proj $P1 --track auth --tag api --link https://example.org/spec --notes "First notes." "Design the token endpoint"
#   ... then add (four more tasks), log, note, blocker --kind decision --on design, add-item tags / blocked_by,
#   priority, set due, status, project set owner, project add-item risks, link (with WL_SESSION=sess-0001 --agent claude),
#   status changes; the exact sequence is the content of the events files in golden/repo/events
export WL_NOW=2026-11-10T12:00:00Z WL_HOST=lab
wl ls --all --json;  wl ls --json
wl resume --json;    wl resume --json --all
wl project ls --json
```

The tool's source and the scripts that call it are not part of this repository. The golden files must be regenerated, not edited, if the data format changes; the resume tests pass the same caller (host `lab`, the folder above, no session) that `wl resume` saw.

### Checked by hand earlier

Before the golden files existed, the compatibility was also checked by hand, on temporary directories with fictional data and `WL_NO_SYNC=1`, with scripts kept outside the repository:

- **`wl` reading our files.** A repository written by this library (two hosts, every task field, the six typed events, provenance, blockers, a project, a reclassification) was read by `wl`: `reindex` succeeded without malformed lines, `ls --all --json` was identical to ours, and `resume --json`, `project ls --json` and `show` agreed with our sections, project counts, sessions, open blockers and timeline lengths.
- **Us reading `wl` files.** A repository written by `wl` (two hosts, two months, git commits, `product add`) was read by this library without warnings.
- **Locking.** While this library held `.wl.lock`, `wl log` timed out with its lock-timeout exit code (5).

Not claimed: the reverse of every validation message, byte-for-byte equality of event key order for every command, and behaviour on hand-edited or forged data.

### Known differences

- Events that carry a `proposal` key are applied as ordinary events; `wl` gates them on the proposal's resolution.
- Proposal events, events on `Q-` or `product:` ids and `linear` list fields are skipped silently.
- The file-name slug transliterates Latin-1 and Latin Extended-A letters only. Other characters are dropped, where `wl` (Unicode NFKD) turns some of them, such as the no-break space, into a separator and a few (`²`, `ª`, `½`, `ſ`) into ASCII, so a slug can differ. The slug is informational.
- Duplicate project titles are compared ignoring ASCII case, not full Unicode case folding.
- Dates for "due within 7 days" use the UTC date; `wl` uses the local date.
- `WL_LOCK_TIMEOUT` set to `nan` or `inf` waits 30 s here and forever in `wl`.
- The taxonomy reader is a subset reader: a taxonomy that uses YAML features beyond it (anchors, tags, block scalars, multi-line scalars, deeper than 64 levels) is refused here although PyYAML reads it. Within the subset it types plain scalars as YAML 1.1 does and refuses the cases that were compared with PyYAML and are listed above (see taxonomy.yaml); it is not proven to refuse everything `wl` refuses. A lone surrogate escape (`\ud800`) in an event line is malformed here and accepted by Python's `json.loads`; this library never writes one.
- Plain YAML values `=` and `<<` in a key this library does not check (an `owner`, for instance) are accepted here; PyYAML refuses them (`ConstructorError`), so `wl` would refuse such a file. In category keys, names and ids they are refused, as they are typed.
- The 60 000-byte cap on the events of one write holds only for lines written by this library. `wl` has no cap and appends to the same host file, so a longer line written by `wl` can sit in that file; the library then cannot read the timestamp of the last event from the 64 KiB tail and uses the clock instead.
- A git call has a 60 second deadline counted from its start (also after its output has ended), keeps at most 16 MiB of output (beyond that the child is killed and the call is an error), and on a timeout kills only the direct child, not its process group (as the Python `subprocess` timeout of `wl`; OCaml's `Unix` cannot start a child in its own group). A git that has exited counts as finished even when a grandchild still holds its output pipe.
- If `git init` or the first commit of `Init.init` fails after the files were written, the files stay (`taxonomy.yaml`, `.gitignore`, `tasks/`, `events/`) and a retry is refused because `taxonomy.yaml` exists: remove the directory's contents or run git by hand.
- A host name is cut at its first dot only when it is the system name; `WL_HOST` is only normalised, as in `wl`. A non-ASCII host character becomes one `-` per code point.
- Blocker ids are drawn up to 20 times per length (`wl`: 100), with no practical effect.
- Limits kept as they are: the YAML reader is quadratic in the number of keys of one mapping (20 000 keys take about a second per load, and the taxonomy is loaded on every read and write); a commit makes up to eight sequential git calls under the lock, each with a 60 second timeout (as `wl`); `Model` exposes mutable fields and the library has no `private_modules`.
- A failed append after the creation of a task file leaves that file behind (it is never committed and each read warns about it), and no step calls `fsync` on a directory after creating a file; `wl` behaves the same.

### Not implemented

Capture (hooks, inbox, transcript extraction, proposals), the curator, reports, digests and the dashboard, `sync`, the SQLite index and `reindex`, Linear references, the `next` and `stale` commands, `doctor`, `data split`, and an HTML or text rendering of any view.

## Verification

```sh
cd ocaml && dune build @worklog/lib/check && dune runtest worklog
```

The tests cover the fold and its determinism (shuffled event order), every validation error path, the briefing sections and their precedence, two-writer and four-process concurrency, lock timeout, torn-line recovery, scoped git commits, taxonomy editing and refusal of existing repositories. The hardening tests cover symbolic links and special files (task, event and lock files, `events/`, `tasks/<product>/`), readers on an unreadable directory, PyYAML scalar typing, the taxonomy rejections and the nesting cap, the briefing order, session input validation, strict JSON lines, `WL_HOST`, `HOME`, `WL_LOCK_TIMEOUT`, and the git timeout and environment. The golden tests are described under Compatibility.
