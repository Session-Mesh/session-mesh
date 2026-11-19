# `mesh-sessions`: the session description protocol

`mesh-sessions` is a read-only native program that describes the sessions the PTY host lists: which agent
runs in each one, its conversation, its state and its last message. The web server is meant to start it once
as a long-lived child and talk to it over its standard input and output in JSON lines; it does not use the
PTY host, opens no socket and writes no file. The web server stays the only writer of the restart snapshot,
and it keeps building the answer of `GET /api/sessions` ([sessions-api.md](sessions-api.md)) from the rows
this program sends.

This version describes Claude and Codex sessions. A session that runs another agent is reported `unsupported`: the
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

- a request is `{"v": 1, "req": <any JSON, echoed>, "op": "<name>", ...}`; `v` and `req` may be omitted
  (the frames of a request without `req` carry none);
- an answer is any number of event frames `{"v": 1, "req": ..., "event": "<name>", ...}` followed by one
  final frame, `{"v": 1, "req": ..., "ok": true, ...}` or
  `{"v": 1, "req": ..., "ok": false, "error": {"code": "...", "message": "..."}}`;
- a request line is at most 4 MiB and nested at most 64 levels; a final frame is at most 8 MiB. A longer
  request is answered `bad_request`; a longer final frame is replaced by a `too_large` error;
- up to 4 requests may be in progress; every frame carries its request's `req`, as it was sent: an
  escaped lone surrogate in a string value of `req`, which the other fields read as U+FFFD, is echoed
  unchanged. Two exceptions: a `req` holding `NaN` or an infinity has no strict JSON form and is answered
  `bad_request` without `req`; a lone surrogate in an object key of `req` is echoed as U+FFFD. Every frame
  is strict JSON. The web server is expected to run one `round` at a time and may send `describe` or
  `hello` beside it.

Error codes: `bad_request`, `unsupported_version`, `unknown_op`, `too_large`, `internal` (the message is
fixed: it never names a path).

## Operations

### `hello`

`{"op": "hello"}` answers `{"ok": true, "program": "mesh-sessions", "schema": 1, "adapters": ["claude", "codex"]}`.
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
cross-session check changed after every row had ended (see "Adding an agent"); the later event replaces
the earlier. The program remembers each session's last correction (by `name` and `created`) as the keys
the check changed, each with its value before and after. While the session has the same `created` and
each of those keys still holds its value before, the next rounds send the row with the correction applied
in the first event, whatever else changed in the row (a busy session's `updated` or `said`): a correction
is sent as a second event once, then the row is sent corrected at once (`same` when nothing else changed).
A second event comes again only when the correction changes: when it no longer holds (the row is then sent
corrected first, then as described), or when a key it changes no longer holds its value before, or the
check changes it otherwise (the row is then sent as described, or with the earlier correction, then with
the new one):

```json
{"event": "row", "name": "api", "created": 1763500000.25, "priority": 0, "state": "ready",
 "row": {"cwd": "/work/api", "cmd": "claude", "agent": {"type": "claude", "...": "..."}}}
```

| Field | Meaning |
|---|---|
| `priority` | The row's place in the order of service, 0 first. |
| `state` | `ready`: described. `unsupported`: the session runs an agent this build has no adapter for; `row` holds what does not depend on the agent (below) and `agent.type`, and the web server completes it. `slow`: past its deadline. `error`: not described (`reason`). |
| `reason` | With `error` only: `backoff`, `saturated` (no system thread was left to describe it), `failed` (the description raised, or the preparation of the session's agent adapter for this round raised; the other adapters' rows are still described), `too_large` (the row exceeds the frame bound), or `no_process_table` (the process table could not be read; every row of the round then has it). |
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

The adapters' cross-session checks run over the requested rows, described now, and over the rows of the
last round for the other sessions whose agent process is still in the process table: a session described
alone is checked against the sessions it shares a conversation with, and gets the fields a round would
give it. The other sessions' rows are those of the last round: a change since then is seen at the next
round. Before the first round, the requested rows are checked among themselves only.

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

The Codex adapter adds, when the process's conversation is known: `session_id` and `identity_source`.
The source is, in this order of preference (as `discover._codex_conversation`):

| `identity_source` | Meaning |
|---|---|
| `open_rollout` | The newest top-level rollout the process holds open: exact. `session_id` is that rollout's id, `null` when its first line has none. |
| `argv_resume` | The id of `codex [options] resume <id>`: where the process started. Not used when another Codex may have been launched on that id or holds its rollout open (the session then has no id), nor when its folder shows a later conversation written since it started (then the next rule). |
| `cwd_unique` | The newest top-level rollout of its folder written since it started, when it is the only Codex in that folder and no other Codex holds that rollout open. A guess. |
| `contested` | With `session_id: null`: another session holds this id under decision I4 (registered identities only, below). |

When the rollout is found it adds `last` (the last prompt typed), `updated` (the rollout's modification
time), `cwd` (Codex's working directory for the latest turn), `status` (`busy` when the rollout was written
in the last 20 seconds, else `idle`) and `said` (the agent's last reply). A rollout that cannot be read gives
`last`, `cwd` and `said` `null`, `updated` 0 and `status` `idle`, as Python.

**Checks between sessions.** Before any Codex row of a round is described, the conversations of every
terminal session whose agent is Codex are resolved and checked together (`Mesh_session_checks`), with the
rules of `discover.drop_duplicate_guessed_ids`: a guessed id that another session also reports exactly, or
that two sessions guess, is withdrawn (`session_id` and `identity_source` `null`); an id read from launch
arguments is withdrawn from every session that shares it; exact ids that collide only with each other are
kept. The web server still applies its own pass over all agents until it uses this program.

**The identity registry** is not read by this version. The Codex adapter has the hook where it plugs in
(`Mesh_agent_codex.config.registry_lookup`): a session it answers for takes the registered id with no
heuristic (`identity_source` `chosen`, `hook` or `observed`), and a duplicated id then follows decision I4:
the strongest source keeps it (`chosen`, then `hook`, then an observation), a tie is broken by holding the
rollout open, the other exact claims are `contested` and the guesses are withdrawn.

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
- **A transcript not found yet (differs).** A search that found no transcript is not made again until the
  list of project directories or the modification time of one of them changes. On a file
  system with coarse directory times (whole seconds or more), a transcript created within the same tick
  as the round that searched for it leaves that time unchanged, and the session is reported without its
  transcript fields until another change in those directories. Python searches at every listing. On local
  Linux file systems, whose directory times are fine-grained, this does not arise in practice.
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

For Codex:

- **Rollouts are folded incrementally**, in the same 8 MB window as Python, with the same consequence
  beyond it as for Claude transcripts.
- **Unsafe files are not read.** A rollout that is a symbolic link, a FIFO or a device is not listed nor
  opened (Python follows the link). A rollout's first line over 8 MB, or nested deeper than 128 levels, reads
  as no header (a sub-agent rollout, as Python's unreadable one).
- **Process table.** When the process table left processes out (`table.complete` is `false`), every folder
  counts at least two Codex and any conversation may be named by another Codex, so no id is guessed or read
  from arguments. Python on Linux always takes its table as complete.
- **Open files.** A Codex whose open files are `Denied` is taken as another user's, holding no rollout of
  this user (the platform reports `Denied` for another user's process). Python checks the owner of
  `/proc/<pid>`.
- **Ties.** Two rollouts with the same modification time: Python takes the first its set iteration gives,
  this program the first by path.
- **Duplicated ids** are withdrawn before the row is sent (above), where Python's web server withdraws them
  after the listing; the result is the same for Codex sessions.
- The notice Python prints when an open rollout differs from the `resume` argument is not printed.

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

The program reads `HOME` only, in this version (Codex's files in `$HOME/.codex`, as Python: `CODEX_HOME` is
not read). On Linux it reads the boot time from `/proc/stat` once, to compare a process's start with a
rollout's modification time. The roots of the other agents (`PI_CODING_AGENT_DIR`,
`XDG_DATA_HOME`, `VIBE_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `OPENCODE_DB`) will be read by
`Mesh_agent_roots` when their adapters are added, so that every adapter resolves them in one place.

## Code layout

| Library (`ocaml/mesh_sessions/`) | Responsibility |
|---|---|
| `mesh_agent` (`agent/`) | The adapter interface (`Mesh_agent.ADAPTER`) and the registry of adapters keyed by agent type; the round's process table (`Mesh_agent_round`); agent detection and the session's foreground and outermost agent (`Mesh_agent_session`); the agents' directories (`Mesh_agent_roots`); Python's value semantics on JSON (`Mesh_agent_py`). |
| `mesh_agent_claude` (`claude/`) | The Claude adapter: the transcript fold (`Mesh_agent_claude_fold`, pure) and the adapter with its cache (`Mesh_agent_claude`). |
| `mesh_agent_codex` (`codex/`) | The Codex adapter: the command-line reader (`Mesh_agent_codex_argv`), the rollout walk and header cache (`Mesh_agent_codex_rollouts`), the round's Codex processes (`Mesh_agent_codex_view`), the identity rules (`Mesh_agent_codex_identity`), the rollout fold (`Mesh_agent_codex_fold`, pure) and the adapter (`Mesh_agent_codex`). |
| `mesh_agent_transcripts` (`transcripts/`) | The transcript fold cache an adapter keeps across rounds (used by Codex; the Claude adapter is meant to move onto it). |
| `mesh_session_checks` (`checks/`) | The checks between the sessions of a round: one conversation id kept by at most one session. Pure. |
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
| `prepare` | Once per round and per `describe` request, before any row | What every session of that agent shares, such as one walk of a rollout directory. If it raises, that request's rows of this agent are `error` with reason `failed` and the adapter is not asked to describe them; one that overruns the setup deadline does not stop them from being described. |
| `resize` | Once per `round` (never for `describe`) | The cache bound: twice the number of listed sessions. |
| `describe` | Once per row, in several system threads | The agent fields of one process. It receives the listed session (`Mesh_agent.session`: `name`, `created`, `pid`), which keys an identity registry by incarnation. |
| `check` | Once per round and per `describe` request, after every row has ended | The cross-session step. It receives the rows of its type described in time (`Mesh_agent.described`: session, process, fields) and returns, by session name, the complete new fields of the rows it corrects (one conversation id claimed by two sessions, for instance). In a round, a row whose final form differs from the one sent first is sent again as a second `row` event before the final frame, and counted with the state it was last sent with; a correction is remembered as the keys it changed and applied to the next rounds' first event while the session is unchanged and those keys hold their values before (see "Events"). In a `describe`, it also receives the last round's rows of the sessions not requested whose agent process is still in the table (their `process` is from that round's table); only the requested rows' corrections are used. It runs in a system thread with the setup deadline; one that raises or overruns changes nothing in that request: the rows keep the form they were first sent with, and the remembered corrections are kept. `Mesh_agent.no_check`, which corrects nothing, is the default (the Claude adapter uses it). |

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
  saved to disk so that the first round after a restart does not read every file again
  (`Mesh_agent_codex_rollouts.entries` and `restore`; nothing is saved yet).
- **One process table per round**, from the `Mesh_agent_round.t` the adapter receives; an adapter never
  scans the process table itself.
