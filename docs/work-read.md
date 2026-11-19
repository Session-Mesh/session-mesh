# The `work-read` program

`work-read` is the read path of the Projects view. It is a small, read-only OCaml program on top of the worklog library (`ocaml/worklog/`, data format in [worklog-format.md](worklog-format.md)): one subcommand per run, one JSON document on standard output, then exit. Its sources are `ocaml/work_read/` (library `work_read`, executable `work-read`). It reuses the text cleaning, the bounded renderers and the question fold of the `work_mcp` library; it does not start an MCP server.

It never writes, takes no lock, makes no commit and never creates a repository: the repository is found through the library's discovery (`WL_HOME`, else `~/worklog-data`, else `~/worklog`) and a missing one is a `repository` error. It reads nothing but the data repository. The program adds no path to its output: a repository is shown by its name only, the folder a session worked in is never shown, and the paths of read warnings are replaced by `<path>`. Free text written by agents (titles, notes, event texts, questions) is returned as written, so it can hold a path if an agent wrote one. Control, bidirectional and invisible characters are removed from every string.

## Invocation and errors

```
work-read products
work-read projects [--product P] [--all]
work-read project P-ID
work-read task T-ID
work-read resume [--product P] [--project P-ID] [--all]
work-read sessions-of (--product P | --project P-ID | --task T-ID)
work-read --request
```

Arguments are parsed strictly: an unknown or repeated flag, a flag without value, a stray argument, a value longer than 100 bytes or holding a control character, and a malformed identifier (`T-` or `P-` and 2 to 32 hexadecimal digits, a product of letters, digits, `.`, `_` and `-`) are refused.

`work-read --request` reads one request of at most 4096 bytes on standard input, `{"op": "<subcommand>", "args": {...}}`, and answers exactly as the command line would. Each argument becomes words of a command line (`id` is the identifier and is accepted only for `project` and `task`, and never when it starts with `-`; `"all": true` is `--all`; any other name `n` with a string value `v` is `--n v`), and those words go through the same strict parser. Anything else is `invalid_input`: text that is not JSON, not an object, an unknown or repeated top-level field, a repeated name inside `args`, an unknown op, `args` that is not an object, a value of the wrong type. The request is read by the same JSON reader as the rest of the program (Yojson), so it accepts what that reader accepts, then applies the rules above. The request never becomes the argv of a process.

An error is `{"error": {"code", "message"}}` on standard output with a non-zero exit code: 2 `invalid_input`, 3 `not_found`, 4 `malformed_data`, 5 `lock_timeout`, 6 `repository`, 7 `internal` (any unexpected exception, whatever it is), 1 anything else (`io_error`, `output_too_large`). Exit code 2 therefore always comes with an `invalid_input` document.

Every success document starts with `schema` (1) and `command` and ends with `truncated`. Lists are capped; a cut list adds `<key>_omitted` (the count) and sets `truncated`. Strings are cut at fixed lengths (with `...`) without setting `truncated`, except notes (8000 bytes).

### The output bound

A document is at most 1 000 000 bytes, and stored data always stays readable: a larger document is cut, not refused. The lists are cut in this order, least useful first: `questions`, `timeline`, `dependencies`, `sessions`, the `reprise` sections (`todo`, `due`, `stale`, `in_progress`, `blocked`), the same sections at the top level of `resume`, `blocking`, `blocked_by`, `no_project`, `projects`, and last `tasks`. Each list loses its second half (its head is kept) as many times as needed, down to one item, and `<key>_omitted` grows by what was cut. When `tasks` is cut, `columns` keeps only the ids still in `tasks` and `columns_omitted` counts the others. If the document is still too large, the remaining values are cut largest first, strings included, with the rule of the `work_*` MCP tools ([work-mcp.md](work-mcp.md)). A cut document has `truncated: true`. `output_too_large` is only returned when nothing is left to cut, which stored data does not reach.

## Documents

Counts are objects with `open` (neither `done` nor `dropped`), `done`, `blocked_tasks`, `dependency_open_tasks`, `blockers` (open blockers of open tasks) and `progress` (done over open plus done, absent when there is no task).

"Blocked" has one meaning in every document: an open task whose status is `blocked` or `waiting`, or that has an unresolved blocker. It is the definition of the library's resume. `blocked_tasks` counts those tasks, the `blocked` column of a project lists them, and the `blocked` section of `reprise` and of `resume` holds them (the sections are capped at 25 rows). Waiting on another task is a separate notion: `dependency_open_tasks` counts the open tasks with a `blocked_by` task that is still open (an unknown target does not count), and a task row says it with `dependency_open`. A task can be blocked, waiting on a dependency, both or neither.

- `products`: `categories[] {key, name, products[]}` (at most 200 products per category); a product is `{id, parent?, <counts of its own tasks>, tree {<counts with descendants>}, projects (active), no_project_open}`; `totals`, `unlisted_tasks` (tasks whose product is not in the taxonomy).
- `projects`: `projects[]` (at most 200; `id, title, product, status, quarter?, owner?, <counts>, last_activity?`), `total`, `no_project[]` (tasks without a project per product: `{product, <counts>}`); `--all` adds done and dropped projects, `--product` includes descendants.
- `project`: `project` (the fields, `milestones`, `risks`, `open_tasks`, `done_tasks`, `created`, `blocked_tasks`, `dependency_open_tasks`, `blockers`), `tasks[]` (at most 200 task rows), `columns`, `columns_omitted?`, `dependencies[]` (at most 300 edges `{from, to, state: open|finished|unknown, to_title?, to_status?, to_in_project}`, from the tasks shown; `to_in_project` looks at every task of the project), `reprise {in_progress, blocked, stale, due}` (at most 25 rows each), `open_questions`, `questions[]` (about the project or its tasks, at most 20, shortened as below), `timeline[]` (newest first, at most 40).
- `task`: `task` (folded fields), `project?`, `notes`, `resolved_blockers`, `open_blockers[]`, `blocked_by[] {id, state, title?, status?}`, `blocking[]` (tasks waiting on this one), `sessions[] {name, agent, repo?, branch?, last_activity, tasks, projects}`, `timeline[]` (newest first, at most 60; `at, task, type, agent?, session?`, the event's fields from an allow-list, `prov?`), `open_questions`, `questions[]` (at most 50, in full).
- `resume`: `in_progress`, `blocked`, `stale`, `due` (task rows with `days_since_activity` and `open_blockers`; at most 25 each), `todo` with `--all`, `open_questions`, `questions[]` (open ones, at most 20, shortened). With `--product` or `--project`, the questions and their count are those about a task in the scope, about the project given, or about a project of the product (with its descendants); without a scope, every open question.
- `sessions-of`: `scope {kind, id}`, `sessions[]` (at most 100, most recent first), `total`, `tasks_considered`. Whether a session is still open is known to the Mesh, not here.

`columns` holds five lists of task ids, and every task shown is in exactly one: `done` (`done` and `dropped`), then `blocked` (blocked as defined above, whatever the status), then by status `in_progress`, `todo` (`inbox` and `todo`), and `other` for any other status. The library refuses an unknown status in an event, so `other` is a guard for hand-edited data and is normally empty. The columns are built from the tasks shown in `tasks`; when some tasks are left out, `columns_omitted` gives, per column, how many (only the columns with a count).

`questions[]` are ordered open first, then answered, each group newest first, so an old unanswered question is never pushed out by newer answered ones. Each is `{id, state, text, options?, assumption?, about?, asked_by_agent?, asked_by_session?, asked_at, answers[], answers_omitted?}` with the five newest answers. In `project` and `resume` the text, the assumption and each answer are cut at 300 characters; `task` gives them in full.

A task row is `id, title, status, priority, product, project?, project_title?, track?, due?, owner?, last_activity?, last_note?, created, eta?, size?, done_at?, blockers (count), blocked_by[], dependency_open, sessions[] (names)`.

## The server route

`POST /api/work/v1` with `{"op": "products" | "projects" | "project" | "task" | "resume" | "sessions-of", "args": {...}}` runs `work-read --request` once, writes the body to its standard input and returns the one line it prints unchanged. It has the authentication of `/api/ls` and the project routes: the page cookie or the master token, never a session token; a request with a foreign `Origin` is refused. The server only checks that the body is at most 4096 bytes and starts with `{`; the program checks everything else, with the rules above.

The program runs without a shell, in its own process group, with a reduced environment (`HOME`, `WL_HOME`), a timeout of 5 seconds for the exchange once the program has started (writing the request, reading the line, the exit; `MESH_WORK_READ_TIMEOUT`, a number of seconds; a malformed value keeps 5). Starting the process and reaping it are outside that bound, so on a loaded machine a request can hold its slot a little longer, a 2 MiB cap on its output line and at most 4 programs at a time (more is a 503, so a client retries). The process group is killed when the request ends, so nothing it started survives. Its location is `MESH_WORK_READ_CMD` when set (an absolute path to a file, else the route answers 503: there is no fallback), else `work-read` in the installation's `bin` directory; only when `MESH_BIN_DIR` is not set (a source checkout) is the opam switch's `bin` tried next.

Status: 200 on success; 400 for a refused request (the program's `invalid_input`, or the server's own check); 404 for `not_found`; 502 for any other failure of the program (`internal` included) or an output line over the cap; 503 when the program is not installed or busy; 504 on timeout. A program that prints nothing, prints a line without its final newline, or is killed by a signal is a 502 `internal` (JSON); only a complete line is relayed. Every answer of the route is JSON with `Cache-Control: no-store`, except the refusals made before the route runs: 401 (authentication), 403 (foreign `Origin`) and 413 (body over the server's size limit) are `text/plain`. The server's own errors have the program's shape, `{"error": {"code", "message"}}`, with the codes `invalid_input` (400), `not_available` (503), `busy` (503), `output_too_large` (502) and `timeout` (504).

Packaging: a source install gets `work-read` from `dune install` in the opam switch. The release scripts do not ship it yet (`ocaml/README.md`), so a release install answers 503 on `/api/work/v1` until they list the program.

## Tests

`dune runtest work_read` runs the real executable against temporary copies of the worklog fixture: every subcommand, strict arguments, the `--request` form (including a NUL, a lone surrogate, a repeated field and an oversized request), a missing repository (exit 6, nothing created), the absence of any write, the absence of paths (the session folder, the home and the data directory), text cleaning, the caps, a project of 402 tasks with 100 maximal questions of five answers each (the documents stay under the bound and are cut, never refused), the one meaning of "blocked", the columns and the scope of `resume` questions.

`tests/work-read-api.test.ts` runs the route against the real server on a free port, with a temporary `MESH_CONF_DIR` and a fixture copy: authentication, the documents, the refusals, the absence of paths, and with a stand-in program the timeout, the output cap, a failing program, a process left behind, the concurrency limit, and a bad `MESH_WORK_READ_CMD`. It needs `MESH_PYTHON` and a built `work-read`, else it is skipped; `MESH_REQUIRE_WORK_READ=1` makes a missing prerequisite fail instead. Public CI does not run it yet: the OCaml job would need a step that sets `MESH_WORK_READ_CMD` to the installed program and `MESH_REQUIRE_WORK_READ=1` and checks that nothing was skipped, which is a workflow change left to the owner.
