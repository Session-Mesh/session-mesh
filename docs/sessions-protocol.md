# `mesh-sessions`: the session description protocol

`mesh-sessions` is a read-only native program that describes the sessions the PTY host lists: which agent
runs in each one, its conversation, its state and its last message. The web server is meant to start it once
as a long-lived child and talk to it over its standard input and output in JSON lines; it does not use the
PTY host, opens no socket and writes no file. The web server stays the only writer of the restart snapshot,
and it keeps building the answer of `GET /api/sessions` ([sessions-api.md](sessions-api.md)) from the rows
this program sends.

This version describes Claude sessions. A session that runs another agent is reported `unsupported`: the
web server describes it with its own code until that agent has an adapter here. The program is not wired
into the web server yet.

## Why a separate long-lived program

- **Isolation.** It parses files that other programs write. A defect in it ends this child, never the PTY
  host and its terminals; the web server kills it and starts it again.
- **Caches.** Describing a session is dominated by decoding transcripts. A child that lives across rounds
  keeps the decoded result of each transcript and reads only the bytes appended since, so an unchanged
  transcript is never decoded twice.
- **Upgrades.** It ships with the web server and needs nothing new from the PTY host, so a new version is
  in use as soon as the web server restarts.

## Framing

Each line on standard input is one request, each line on standard output one frame of an answer. The
framing is that of `Mesh_jsonl_rpc` (the `mesh-history` convention):

- a request is `{"v": 1, "req": <any JSON, echoed>, "op": "<name>", ...}`; `v` may be omitted;
- an answer is any number of event frames `{"v": 1, "req": ..., "event": "<name>", ...}` followed by one
  final frame, `{"v": 1, "req": ..., "ok": true, ...}` or
  `{"v": 1, "req": ..., "ok": false, "error": {"code": "...", "message": "..."}}`;
- a request line is at most 4 MiB and nested at most 64 levels; a final frame is at most 8 MiB. A longer
  request is answered `bad_request`; a longer final frame is replaced by a `too_large` error;
- up to 4 requests may be in progress; every frame carries its request's `req`. The web server is expected
  to run one `round` at a time and may send `describe` or `hello` beside it.

Error codes: `bad_request`, `unsupported_version`, `unknown_op`, `too_large`, `internal` (the message is
fixed: it never names a path).

## Operations

### `hello`

`{"op": "hello"}` answers `{"ok": true, "program": "mesh-sessions", "schema": 1, "adapters": ["claude"]}`.
`schema` is the version of the row format below; `adapters` the agent types this build describes.

### `round`

Describe the sessions of one host list, streaming each row as soon as it is ready.

```json
{"op": "round", "req": 12,
 "sessions": [{"name": "api", "created": 1763500000.25, "pid": 4242, "activity": 1763560000, "busy": false}],
 "focus": ["api"], "full": false, "avoid": []}
```

| Field | Meaning |
|---|---|
| `sessions` | The host's list: at most 4096 sessions. `name` matches `[A-Za-z0-9_-]{1,48}`, names are unique; `created` is a number; `pid` (the session leader) an integer from 1 to 2^31-1; `activity` (optional, seconds) orders the rows that are not in `focus`; `busy` (optional) marks a session its hooks report busy. |
| `focus` | Optional. Session names served first, in this order (the pane on screen, the other open panes, the pinned conversations, the visible rows). Unknown names are ignored. |
| `full` | Optional, default `false`. `true`: every row carries its body, even one that did not change since the previous round. The web server sends it after it lost its own copy of the rows. |
| `avoid` | Optional. Names whose description left a thread blocked in a previous run of the program (see `degraded`). They are reported `error` with reason `backoff` and retried one round in four, as if they had already been slow three times. |

**Order of service.** The rows are described in this order: the `focus` names in their order, then the
sessions marked `busy`, then the others by decreasing `activity`, ties by the order of `sessions`. A row
that is ready is sent at once: a slow row never delays a faster row behind it, since at most 8 rows are
described at a time and each has its own deadline.

**One process table per round.** A round reads the process table once and every row is described from it;
the agents' adapters also prepare what they share between sessions once per round. Process details
(command line, working directory) are read only for the processes that need them.

**Deadlines.** Each row has 2 seconds. A row still running then is cancelled and reported `slow`; its system
thread, if blocked in the kernel (a stalled file system), is abandoned, never killed. A session slow in three
consecutive rounds is reported `error` with reason `backoff` and described again only one round in four; a
description that ends, ready or `failed`, clears its count, and a round that could not try it (`saturated`,
`no_process_table`) leaves the count as it was. The process table, the adapters' preparation and rows are
read in system threads, at most 16 in flight, abandoned ones included; when every thread is taken, the
remaining rows are reported `error` with reason `saturated`, and so is every row of a round that has no
thread left for its process table.

**Events.** One `row` event per session, and a second one for a session whose row an adapter's
cross-session check corrected after every row had ended (see "Adding an agent"); the later event replaces
the earlier:

```json
{"event": "row", "name": "api", "created": 1763500000.25, "priority": 0, "state": "ready",
 "row": {"cwd": "/work/api", "cmd": "claude", "agent": {"type": "claude", "...": "..."}}}
```

| Field | Meaning |
|---|---|
| `priority` | The row's place in the order of service, 0 first. |
| `state` | `ready`: described. `unsupported`: the session runs an agent this build has no adapter for; `row` holds what does not depend on the agent (below) and `agent.type`, and the web server completes it. `slow`: past its deadline. `error`: not described (`reason`). |
| `reason` | With `error` only: `backoff`, `saturated` (no system thread was left to describe it), `failed` (the description raised), `too_large` (the row exceeds the frame bound), or `no_process_table` (the process table could not be read; every row of the round then has it). |
| `row` | With `ready` and `unsupported`, unless `same` is set. |
| `same` | `true` instead of `row` when the row is exactly the one sent for this session (same `name` and `created`) in an earlier round of this run, and `full` was not asked. The web server then keeps the row it has and does not change its generation. |

**Final frame.**

```json
{"ok": true, "round": 7, "complete": true,
 "counts": {"total": 52, "ready": 49, "unsupported": 2, "slow": 1, "error": 0},
 "table": {"complete": true}, "degraded": {"abandoned": 1, "avoid": ["api"], "restart": false}}
```

`round` counts the rounds of this run. `complete` is `true` when every row is `ready` or `unsupported`.
`table.complete` is `false` when the process table left processes out (another user's, or an unreadable
entry); processes the kernel hides (`/proc` mounted with `hidepid`) are absent rather than left out, so it
cannot count them. `degraded` is present when system threads are still blocked: `avoid` names the sessions reported
`slow` or `backoff` in this round, after those of the earlier rounds that are still listed, for as long as
threads stay blocked. `restart` is `true` when this round lacked a thread (a row or the process table was
`saturated`) or none is left for the next round: the program cannot recover by itself, and the web server
then stops it and starts a new child (see below). The web server keeps the last `avoid` it received and
sends it in the first round of the next run, so that a session that blocks the program is not retried at
full rate after a restart.

### `describe`

`{"op": "describe", "sessions": [...]}`, with the same `sessions` as a round, describes these sessions now,
from a process table read for this request, without the order of service, the `same` rows or the backoff.
It answers one final frame, `{"ok": true, "rows": [{"name", "created", "state", "reason"?, "row"?}, ...]}`,
in the order of `sessions`. It is meant for actions that need an identity read at the time they act
(restart in place, resume, wake), so that they do not act on a row of an earlier round.

## Rows

A row is what the web server's listing computes for a session today (`discover.describe` in `discover.py`),
with the same keys and values:

| Field | Meaning |
|---|---|
| `cwd` | The working directory, as the kernel reports it, of the agent's process when the session runs an agent, else of the foreground process group's leader; when that one cannot be read or is empty, the session leader's (Python's `cwd(ag[0] if ag else fg) or cwd(sid)`); `null` when neither can be read. |
| `cmd` | The command line of the session's foreground process group leader, arguments joined by spaces, at most 160 code points; else that process's name; else `"?"`. |
| `agent` | `null` when no agent runs in the session. Otherwise the outermost agent process of the session, preferring the one in the foreground process group: `type`, `pid`, `argv` (its command line), `foreground` (whether its process group is the terminal's foreground group), and the adapter's fields. |

The Claude adapter adds, when `~/.claude/sessions/<pid>.json` can be read: `session_id`, `identity_source`
(`"pid_metadata"`), `name`, `status`, `since` (seconds), `waiting_for` (only while `status` is `waiting`).
When the conversation's transcript `~/.claude/projects/*/<session_id>.jsonl` is found, it adds `title`,
`last` (the last prompt typed), `updated` (the transcript's modification time), `cwd` (Claude's working
directory after any `cd`), `said` (how the last answer ends: its text, or the tool it asks to run), and
`choices` and `ask_id` when it ends with a single single-choice question.

### What a row never holds

- no process environment: `/proc/<pid>/environ` is never read;
- no transcript path, and no transcript text other than the folded fields: `last` and `said` are cut to 240
  code points and each of `choices` to 40;
- no text that is not valid UTF-8: invalid bytes are dropped, as Python's `errors="ignore"` does;
- the process command line only in `cmd` (160 code points) and `agent.argv`, as today; the web server may
  leave `agent.argv` out of what it sends to pages.

### Differences from the Python listing

The rows are equal to those of `discover.describe` for the same processes and files, except in the cases
below. In most of them this program reports less (a field left out) or keeps more (a value Python has
lost). Four report a different value; they are marked **differs**.

- **Transcripts are folded incrementally.** Python folds the last 1.5 MB of a Claude transcript at every
  listing; this program folds that window once, then only the appended lines. Below the window the result is
  the same. Beyond it, a title or a prompt that has left the window is still reported here, where Python
  loses it. When more than the window was appended since the last read, the transcript is folded again from
  an empty state over the window at its end, exactly as Python reads it: what was folded before is dropped,
  since a change in the skipped lines (a new title, a question answered) cannot be seen.
- **Rewrites read as appends (differs).** A transcript counts as rewritten, and is folded again from its
  window, when its device or inode changed, when it is shorter than the last read position, when its
  modification time went back, or when the 256 bytes before that position or the first 256 bytes of the
  file changed. A rewrite that changes none of these (a line in the middle replaced by one of the same
  length, the time moving forward) is read as an append and keeps the earlier fold, where Python, whose
  cache key is the path, size and time, reads the new content. Claude appends to its transcripts.
- **Several transcripts for one session id (differs).** Python takes the first the directory listing
  returns; this program takes the most recently modified one at the time of the search. The search is made
  again when a project directory changes (a transcript created, removed or renamed in it); in between, a
  copy elsewhere that is only modified does not replace the one found.
- **Escaped lone surrogates (differs).** A transcript string holding half of a UTF-16 surrogate pair as an
  escape (`\ud800`) is read with U+FFFD in its place; Python reads the lone surrogate into its string.
- **Command line without a final NUL (differs).** A process that rewrote its command line without the
  final NUL (as `setproctitle` does) keeps its last word in `cmd` and `agent.argv` here; Python drops it and
  `cmd` falls back to the process name.
- **Unsafe files are not read.** A transcript or metadata file that is a symbolic link, a FIFO or a device is
  not opened (Python follows the link or blocks on the FIFO). A session id that is not a string or not a
  plain file name component (`[A-Za-z0-9_-]`, dots inside) is not looked up as a path (Python looks up a
  number as `<number>.jsonl` and expands glob characters); the session id is still reported.
- **Bounded and strict input.** A metadata file over 1 MiB, or a transcript line over 1.5 MB (the window)
  or nested deeper than 128 levels, is skipped where Python might parse it. A metadata file that starts
  with a UTF-8 byte order mark, or is in UTF-16 or UTF-32, is not read (Python's `json.load` reads it).
- **Line ends.** A transcript line is ended by a newline only. Python's `splitlines` also ends lines at
  `\r` alone, `\x0b`, `\x0c`, `\x1c` to `\x1e`, U+0085, U+2028 and U+2029, so it drops a JSON line that
  holds one of them raw (between tokens or in a string); this program reads it. A CRLF file reads the same
  in both. A last line without its newline is read once it is complete, where Python reads it at once.
- **A prompt part with `"text": null`** counts as empty text here; Python fails on it and drops the
  session's whole Claude description.

## Process exits and failure

| Exit status | Meaning |
|---|---|
| 0 | The standard input ended; the requests in progress were answered. |
| 70 | An unexpected failure, such as a write error on the standard output (the web server went away). |
| 78 | `HOME` is unset, empty or relative. |

The program writes nothing on its standard error during normal operation, and never a session id, a path
or transcript text there. It must never block the web server: the web server reads its frames
asynchronously, and kills its process group (`SIGKILL`) when a round sends no frame for 10 seconds, then
starts a new child for the next round, passing the last `degraded.avoid`. It does the same, without waiting,
after a final frame with `degraded.restart: true`: the blocked threads can only be released by ending the
process. The rows of a round that did not
finish keep their previous state in the web server (`ready: false` for those never described). A missing or
failing binary leaves the web server on its Python listing.

## Environment

The program reads `HOME` only, in this version. The roots of the other agents (`PI_CODING_AGENT_DIR`,
`XDG_DATA_HOME`, `VIBE_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `OPENCODE_DB`) will be read by
`Mesh_agent_roots` when their adapters are added, so that every adapter resolves them in one place.

## Code layout

| Library (`ocaml/mesh_sessions/`) | Responsibility |
|---|---|
| `mesh_agent` (`agent/`) | The adapter interface (`Mesh_agent.ADAPTER`) and the registry of adapters keyed by agent type; the round's process table (`Mesh_agent_round`); agent detection and the session's foreground and outermost agent (`Mesh_agent_session`); the agents' directories (`Mesh_agent_roots`); Python's value semantics on JSON (`Mesh_agent_py`). |
| `mesh_agent_claude` (`claude/`) | The Claude adapter: the transcript fold (`Mesh_agent_claude_fold`, pure) and the adapter with its cache (`Mesh_agent_claude`). |
| `mesh_sessions` (`lib/`) | The protocol's requests and rows, the description of a row, the order of service and backoff, the round, and the request handler. It contains no agent name: the adapters are a value. |
| `mesh-sessions` (`bin/`) | The program: reads `HOME`, builds the registry, serves standard input. |

The generic libraries it is built on are in `ocaml/generic`: `mesh_priority` (order of service),
`mesh_deadline_pool` (deadlines, bounded concurrency, abandonable threads), `mesh_jsonl_tail` (incremental
transcript fold), `mesh_lru` (bounded caches), `mesh_safe_file` and `mesh_jsonl_rpc`.

## Adding an agent

An adapter is a module of signature `Mesh_agent.ADAPTER`:

| Function | Called | Role |
|---|---|---|
| `kind` | | The agent type. |
| `create` | Once, at start | The adapter's state, from the agents' roots. |
| `prepare` | Once per round and per `describe` request, before any row | What every session of that agent shares, such as one walk of a rollout directory. |
| `resize` | Once per `round` (never for `describe`) | The cache bound: twice the number of listed sessions. |
| `describe` | Once per row, in several system threads | The agent fields of one process. It receives the listed session (`Mesh_agent.session`: `name`, `created`, `pid`), which keys an identity registry by incarnation. |
| `check` | Once per round and per `describe` request, after every row has ended | The cross-session step. It receives the rows of its type described in time (`Mesh_agent.described`: session, process, fields) and returns, by session name, the complete new fields of the rows it corrects (one conversation id claimed by two sessions, for instance). Each corrected row is sent again as a second `row` event before the final frame and counted once. It runs in a system thread with the setup deadline; one that raises or overruns corrects nothing. `Mesh_agent.no_check`, which corrects nothing, is the default (the Claude adapter uses it). |

It is registered by adding it to the list the program passes to `Mesh_agent.Registry.create`; neither the
round nor the protocol changes. Detection of the agent type stays in `Mesh_agent_session`, shared by all.

Rules every adapter keeps, so that a round costs what changed and not what exists:

- **No transcript decoded twice.** A transcript's fold is cached by conversation and checked against the
  file's identity, size and modification time; a grown file is read from the previous cursor
  (`Mesh_jsonl_tail`). A second round over unchanged files opens none of them (the Claude adapter's
  counters show it in its tests).
- **Shared discovery once per round.** A directory every session of an agent searches (Codex's recent
  rollouts) is walked once in `prepare`, not once per session; what is read from each file found there
  (a rollout's first line) is cached by file and signature across rounds, in a form that can later be
  saved to disk so that the first round after a restart does not read every file again.
- **One process table per round**, from the `Mesh_agent_round.t` the adapter receives; an adapter never
  scans the process table itself.
