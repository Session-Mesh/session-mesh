# Integrating and requalifying a coding-agent CLI

This page is the test protocol for adding a coding-agent CLI to session-mesh, and for checking an
existing one again after a breaking update. Following it takes a few hours for a new agent and
about thirty minutes for a requalification, and it ends with a table that says, for each feature,
whether the agent supports it and what proves it.

It is written for a maintainer or an agent doing the work. The model integrations to read first are
Claude Code, Codex, Pi and OpenCode.

## What "integrated" means

An agent counts as integrated when the mesh can do these things with it. Each is a row of the
result table at the end, and each can be `supported`, `partial` or `impossible`.

| Feature | What it means |
|---|---|
| Launch | "+ New" starts it, with the `mesh-board` MCP server (and `mesh-work`, the tracker, when `work-mcp` is installed: [work-mcp.md](work-mcp.md#registration)) injected and no secret written to disk |
| State | The sidebar tells working, idle, waiting for a question and waiting for a permission apart |
| Resume | After a PTY host restart, the same conversation comes back with its safety options |
| History | Past conversations are listed and searchable |
| Mailbox | The agent lists its inbox, reads a message after the owner's consent, replies |
| Wake | An idle agent learns that a message waits, without a keystroke from the owner |
| Terminal | Scrolling, bracketed paste and the alternate screen work on desktop and on a phone |
| Phone direct writing | A line starting with `/` switches to direct writing and the agent's menu appears |

A feature the agent cannot provide is recorded as `impossible` with the reason. It is not a
failure of the integration.

## Rules that hold for every step

These come from incidents on this project. They are not optional.

- **Never touch the live mesh.** Do not call the live port, the live PTY host socket or the
  user's systemd units. Everything runs on a test instance: `scripts/preprod.sh start` starts a
  separate server and PTY host with their own port, configuration, cache and runtime directories,
  and `scripts/preprod.sh check` proves that nothing it would use belongs to the live mesh.
- **Never touch the agent's own configuration.** Pass the mesh configuration inline or by
  environment variable. Do not write to the agent's home configuration directory, and do not read
  credentials. If the agent needs the user's sign-in for a real trial, keep the real `HOME`
  for the test instance only, read nothing from it, and run one minimal prompt per check.
- **Never write to another session's messaging socket**, and never run a real session of an agent
  that is not the one under test.
- **A secret never appears on a command line or in a file.** The session token reaches the agent
  through its environment, as for the other agents. Check `/proc/<pid>/cmdline` and the files the
  integration writes. A line typed into the terminal is expanded by its shell first: an
  unquoted `"$MESH_SESSION_TOKEN"` in `env VAR=...` ends up in the argument of `env`. Expand it
  inside a `/bin/sh -c` script that execs the agent, as Vibe's launch line does.
- **A stricter choice of the user wins.** If the user's configuration disables a tool, sets a
  stricter permission or removes a server, the mesh must not undo it.
- **Tests run in a clean environment**: `env -i` with a temporary `HOME`, `XDG_RUNTIME_DIR` and
  `TMPDIR` under a short path (a long path overflows the 108-byte Unix socket limit), no `MESH_*`
  variable from the caller, and a virtual environment made from `/usr/bin/python3`.
- **No new Python file.** Minimal changes to existing Python files are allowed; new tests are
  TypeScript, new native code is OCaml.

## Step 0: identify the agent and decide whether it fits

Read `<agent> --help` and the official documentation. Record the version, where it keeps its
configuration and its conversations, and which modes it has.

The mesh runs an agent in a terminal. The agent must therefore have an interactive terminal
interface. A web interface, a headless mode or a JSON-RPC server does not qualify. Stop here and
report if the agent has none. The DeepSeek harness is an example: its profiles are web, headless,
ACP and SDK, so it was not integrated.

Also record how the agent exposes each of the following, because they decide what is possible:
MCP servers (inline configuration, a file, a flag), hooks or plugins (for state), resumption
(an option and an identifier), and where it stores conversations (files, a database). Also record
its native way to receive an external message, as the next section requires.

## Look for the client's native message channel first

Before choosing "a notice typed into the terminal" or "no wake" for a new agent, look for the way
the client itself accepts an external message. A typed notice is a keystroke in the owner's
terminal; a native channel is addressed to one conversation and cannot land in a half-written
prompt. Search for each of these, and write down what you found, including "none found":

- a messaging socket or a pipe of its own (Claude Code's `--messaging-socket-path`);
- a command that queues a message for an existing session (`codex queue --thread ...`);
- a server or API that the open terminal interface also uses (OpenCode's HTTP routes, an app
  server, a remote-control endpoint);
- an extension or plugin already loaded in the client that can call the client's own prompt API
  (Pi's extension, Copilot CLI's extensions);
- hooks whose answer can start or extend a turn (a stop hook that continues, an after-agent hook
  that retries).

Find them by listing `<agent> --help` and the help of every subcommand that mentions a server,
a session, a queue, a remote, an app server, ACP, RPC or a daemon, then the vendor's documentation.
Run help only: do not start the client with a message, and do not read its configuration directory.
An agent's ACP or JSON-RPC mode is another process and does not reach the open terminal
interface; it does not count unless the terminal interface is a client of it.

A channel is acceptable only if it passes this list:

1. **Exact identity.** It targets one conversation by its identifier, never "the latest" or "the
   one in this folder".
2. **No typing.** No byte reaches the terminal as keystrokes, so none can answer a dialog or join
   the owner's draft.
3. **No secret in argv or the environment** beyond the session token the agent already inherits.
   Check `/proc/<pid>/cmdline`.
4. **Idempotent.** Sending the same notification twice produces one wake; the sender can tell
   whether it was delivered.
5. **Consent.** The notice carries no message text. The owner's approval is still asked when
   the agent reads the message.
6. **Neutral text without a digit**, as for the typed notice.
7. **Fake-binary test.** A fake binary or server that records what it receives proves the
   arguments, the target and the absence of a secret before any real client is used.
8. **Trial on a throw-away session.** On the test instance, with a disposable home: does the
   message reach the already open terminal interface, while idle, while working and with a
   permission dialog open? A channel that has not passed this trial is shipped **off by default**,
   behind an opt-in setting, and documented with the manual trial that turns it on (Codex:
   `MESH_CODEX_QUEUE_WAKE`, `docs/operations.md`).

If a channel passes, use it and keep the typed notice only as a fallback. If none exists or none
passes, record why in the pull request. The analysis of the supported agents, with the
evidence and the order in which to integrate what was found, is in
[agent-wake-mechanisms.md](agent-wake-mechanisms.md).

## Step 1: wire the agent in

The integration touches a small set of files. Find them by searching for how an existing agent,
OpenCode being the most recent, appears.

- **`agentcap.py`**: the capability matrix. Start every feature as `unavailable` or `unknown` and
  promote it only with evidence.
- **`launchplan.py`**: the launch command and the preset.
- **`resumeargs.py`**: which options survive a resumption. List the options explicitly. A safety
  option (read-only, a permission mode, a disabled tool) that cannot be read back must make the
  resumption refuse. An option the mesh adds must never be more permissive than the user's.
- **`discover.py`**: recognising the agent in the foreground and reading its state.
- **`agentmcp.py`**: the MCP configuration, and how the user's own configuration is merged.
- **The wake paths**: `AGENT_WAKE_PRESETS` in `server.py` (the agents the server types a wake notice
  into) and the agent pattern of `notify_if` in `ocaml/lib/mesh_ptyhost.ml` (the native PTY host
  refuses a conditional notice for any other agent). Three agents are also woken without typing,
  each on its own path: Claude Code on its messaging socket (`claudewake`; it is in
  `AGENT_WAKE_PRESETS` too, where the typed notice is the fallback), Pi through its extension and
  the `pi-wakes` stream, and Codex through `codex queue` (`agentwake.CodexQueue`), only for an
  exact conversation and only when the owner enabled it (`MESH_CODEX_QUEUE_WAKE=1`, off until the
  criterion 8 trial has been done on a real session). An agent on none of these paths is never woken: its messages wait in the
  inbox until it reads them (Copilot CLI and Antigravity today).
- **The pane menu and the catalogues** under `static/` when the agent needs an action of its own.
- **Documentation**: `docs/features.md`, `docs/agents.md` (the agent table) and the README agent list, a changelog fragment under `changelog.d/`, `SECURITY.md` when a
  boundary changes, and the agent's section of
  [agent-wake-mechanisms.md](agent-wake-mechanisms.md).

## Step 2: launch and MCP

1. Build a fake binary that records its arguments and environment and exits. Test that the launch
   command, the injected MCP configuration and the merge with a user configuration are exactly
   what you expect, including a user configuration that disables the server or tightens a
   permission.
2. Check that the token is in the environment and nowhere else.
3. Run the real agent on the test instance. The `mesh-board` tools must appear in the agent's tool
   list and answer: call `mail.peers` and `mail.inbox`.

**Known trap.** An agent may hand the model only the text of an MCP result and ignore its
structured content. OpenCode does, and its inbox and peer lists then looked empty. The bridge
therefore also writes the JSON into the text part. If the lists look empty to the agent but the
server returns data, suspect this first.

## Step 3: state

Run a prompt that needs a permission and one that asks a question. The sidebar must show
`working`, `waiting_permission`, `waiting_question` and idle at the right moments. Prefer the
agent's own hooks or plugin over guessing from the screen or from its database. If the state can
only be guessed, record the feature as `partial` and say what is guessed from.
Declare the agent's hooks as a source in `agent-hooks.json` ([agent-hooks.md](agent-hooks.md)): its
native events, the consumers it subscribes and, where it adds a hook's output to the model's context, the
format; the configuration generator then installs every subscribed hook.

## Step 4: resume and restore

1. With the fake binary, test the resumption command and the options that are kept, refused or
   added.
2. On the test instance, start a real session, say one distinctive sentence, restart the test PTY
   host, and use "Restore". The conversation must come back and the sentence must be recalled.
3. Test that a restrictive option the user set survives, and that an unreadable one refuses the
   resumption.

## Step 5: history

The History tab and pins are part of every integration, not an extra. Learn the agent's conversation
store from its own source code or documentation, never from your own data, and record per agent: where
it lives (and the environment variable that moves it), its format (append-only JSONL, a file rewritten on
each save, SQLite), the conversation id and the pattern that id must match, where the title, the working
folder and the timestamps come from, and whether token counts are recorded.

1. **Index it** in `history.py`: an append-only file gets a feed function (`_<agent>_line`) and is read from
   where the last pass stopped; a file that is rewritten (Vibe's `meta.json` and chunk store, handled in `_parse`) or a source that is not a file of lines gets a planner in `_WHOLE_TEXTS` of `history_db.py`; a database is opened
   read-only (`mode=ro`, a timeout, only the tables you need) and each conversation becomes an entry
   refreshed when its update time moves. Add the agent to `history.AGENTS` (the server's
   `HISTORY_AGENTS` and the capability matrix follow it, and `tests/agentcap-history.test.ts` fails if they
   differ).
2. **Search it**: the transcripts' directories go in `_search_roots`; for a database, add the query to
   `search_db`. A hit in a file other than the indexed one needs a mapping in `search_ids`.
3. **Say what Mesh can do with it**: `resumable` (the agent resumes from a folder Mesh knows, in a store
   Mesh's launch can reach: Mesh-started Gemini has its own home) and `deletable` (only when one transcript
   file is the whole conversation). The resume argv is the one in `resumeargs.py`; the id is validated
   by `SID_RE` and is never put in a shell string.
4. **Pin it**: add the agent to `PIN_HISTORY_AGENTS` in `static/app.js`, and, if its hooks and process can
   name no conversation, to `_HISTORY_IDENTITY` in `server.py` so that the history index supplies the one
   conversation written in the session's folder since it started. If the agent truly exposes no id, say so
   here and in `docs/features.md`; do not guess.
5. **Test it** with a synthetic home built from the documented format: listing, title, search hit,
   an incremental update, a malformed file, the resume argv (`tests/history-agents.test.ts`), and a pin
   (`tests/pins-agents-browser.test.ts`).

If the agent keeps no readable conversation at all (an encrypted store, no id), record `impossible` or
`partial`, with the reason.

## Step 6: mailbox and wake

1. Start two sessions on the test instance, one of them the agent. Without standing permission
   between them, send a message from the other session. The owner's approval request must appear
   in Mesh before the recipient checks its inbox, and the recipient must not be woken yet.
2. The recipient's `mail.inbox` must list metadata only, with `authorization_pending: true` on the
   held entry. An explicit `mail.read` must return the existing pending request, not the text or
   another request. Choose "Read this time" in Mesh. The entry now shows `authorization: "once"`;
   a standing grant shows `"always"` instead, only for the exact pair. The agent can read directly,
   without a separate question in chat. Sending a reply must raise a new approval request unless
   the reverse direction already has standing permission in Mesh.
3. Wake: with the recipient idle, approve a message and check its wake mechanism, if supported.
   For a typed wake, a one-line notice must be typed at the prompt and submitted, with no message
   text in it. While the agent is working, nothing must be typed. Check this against the native
   PTY host (`MESH_PTYHOST_CMD`); `ptyhost.py` is only the client module the web server uses to
   reach it.
4. Check that the message text was never injected into the terminal and that the agent does not
   treat permission to read as permission to act on the message.

## Step 7: terminal

In Chromium, against the test instance:

- the mouse wheel and touch scrolling reach the agent when it uses the alternate screen, and the
  page scrolls when it does not;
- a multi-line paste arrives as one bracketed paste, not as separate lines;
- after a replay that was cut at 2 MiB, the agent's input modes are still right. Pi and OpenCode
  lose theirs and have an explicit "Restore full-screen scrolling" action. Decide whether the new
  agent needs one.

## Step 8: phone direct writing

On a phone-sized viewport with the agent in the foreground, type `/`. The line must switch to
direct writing and the agent's command menu must appear while typing. In a plain shell it must
not. Check Enter, Tab and a composed word: no byte may leave before the text that precedes it, and
no Enter may follow a text that was not delivered. The existing browser tests of the feature
(`tests/phone-direct-line-*-browser.test.ts`) show the cases to repeat. A real phone is not
available to the automated tests, so record this row as verified on an emulated phone only.

## Requalifying after an update

When an agent updates and something breaks, do not redo the whole protocol. Change the agent's
version and rerun these, in this order. Stop at the first failure: it is the regression.

1. **Step 0**: does it still have a terminal interface, and did the options or the configuration
   format change?
2. **Fake-binary tests** for launch, MCP merge and resumption. They run in seconds.
3. **Step 2**, real launch: do the `mesh-board` tools still appear and answer?
4. **Step 3**, one permission prompt: is the state still detected?
5. **Step 4**, restore one session.
6. **Step 6**, one message and one wake.
7. **Step 7**, the scrolling and paste checks.

Record the version that was requalified. If the agent changed something the mesh depends on, the
fix goes in the integration and the table below is updated, never only in the user's setup.

## Result table

Finish with this table, in the pull request. Each row has a status
and its proof: a test file, a command, or a trial on a named version of the agent.

| Feature | Status | Proof |
|---|---|---|
| Launch and MCP | supported / partial / impossible | |
| State | | |
| Resume and restore | | |
| History (list, title, search, card, resume, delete policy) | | |
| Pins (conversation id source) | | |
| Mailbox | | |
| Wake | | |
| Terminal | | |
| Phone direct writing | | |

State what was not verified, for example a real phone or a platform that was not available. A
missing row is not a pass.

## Review

The integration is reviewed independently before it is merged, in a copy of the branch, with the
same rules. The review should try to break the three places where an integration has gone wrong
before: the token (written somewhere, or visible in the process list), the resumption (a
restrictive option lost or a permissive one added) and the wake (typed while the agent is working).
The review also checks that the pull request records the search for a native message channel, with the commands run.
