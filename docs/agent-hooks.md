# Agent hooks

Every agent Mesh launches gets Mesh's hooks from one declarative model: a list of generic events, a
normalised event, the consumers that react to them, and one *source* per agent that says how that agent
emits the events. This page is the model (schema 1) and the capability matrix of the agents Mesh launches
today.

What the table [`agent-hooks.json`](../agent-hooks.json) drives today is narrower than the model:

- **Driven by the table.** Which native hooks of an agent each consumer is installed on, in which order,
  and their timeout; for the project context hook, its program, arguments, switch and output format per
  agent. Each agent's generator reads these, so a consumer that generator already installs is wired into
  the agent by one line of the table ([Adding a hook or an agent](#adding-a-hook-or-an-agent) says what else
  a new consumer needs).
- **Still per agent.** Decoding each agent's native payload into a state (the normalised event, then the
  session state) is done agent by agent in Python, in `bin/mesh-event`; the OpenCode plugin and the Pi
  extension do their own in code. The normalised event and `stateEnvelope` (in `agent-hooks.ts`) are the
  model's description of that decoding and a test oracle: a test checks that `bin/mesh-event` sends exactly
  what `stateEnvelope` gives, but no production path runs `stateEnvelope`.
- **Descriptive only.** The `payload` section, the `fires` text of each event, the `program` and `switch`
  of the `state` consumer, a source's `kind`, `install` and `reason`, and `cap_seconds`: no generator reads
  them. The cap that runs is the OCaml constant `Wr_context.cap_seconds`; a test keeps the table's value
  equal to it.

The table is data. Its types and checks are [`agent-hooks.ts`](../agent-hooks.ts) (`loadModel` refuses a
table that breaks a rule below); the Python generators read the same file (`agentmcp.hook_events`,
`agentmcp.project_context_hooks`). JSON with TypeScript types was chosen over OCaml types because the
three readers of the table today are Python (the configuration generators), TypeScript (the OpenCode
plugin and the tests) and the shell configuration each agent reads: JSON is the one format all of them
read without a new dependency, and the TypeScript types give a future protocol source (an ACP client) the
same normalised event to emit.

## Generic events

| Event | Fires when |
|---|---|
| `session_start` | the agent opens or resumes a conversation, before the first prompt |
| `prompt_submit` | the user's prompt is accepted, before the model works on it |
| `tool_before` | a tool call is about to run |
| `tool_after` | a tool call has returned |
| `tool_failure` | a tool call has failed |
| `permission_request` | the agent asks the user to allow an action |
| `notification` | the agent shows the user a notice: a permission prompt, a question, the end of a turn |
| `turn_end` | the agent is back at its prompt |
| `turn_end_failure` | the turn ended on an error |
| `session_end` | the conversation or the process ends |

Order is the agent's: Mesh adds no ordering guarantee beyond the agent's own, and two events can reach a
consumer out of order (each runs its own process). Several native hooks can give one generic event, and one
native hook can give different generic events depending on its payload: Claude's `PermissionRequest` for
`AskUserQuestion` is a `notification` with the notice `question`; agy's `Stop` is `turn_end` when the agent
is fully idle and `turn_end_failure` when it ended on an error. That decoding belongs to the source.

## The normalised event

What a source reports for one occurrence. Only structured fields, each bounded; never a prompt, a reply, a
tool input or output, a path, or other free text of the agent.

| Field | Content |
|---|---|
| `schema` | 1 |
| `event` | a generic event |
| `agent` | the source's agent (`claude`, `vibe`, ...) |
| `native` | the agent's own hook name, at most 64 characters |
| `at` | epoch seconds, read when the hook ran |
| `conversation` | optional: the agent's conversation id, validated by the source |
| `occurrence` | optional: the agent's id of this prompt or tool call (or its timestamp), for deduplication |
| `tool`, `tool_use` | optional: the tool's name and the agent's id of the call, at most 256 characters each |
| `notice` | optional, with `notification`: `permission`, `question`, `turn_completed` or `turn_failed` |
| `error` | optional: the agent's error code, at most 256 characters |

The Mesh session is not a field: a consumer learns it from where the hook runs (the session token or
`MESH_SESSION` of the terminal), never from the agent's text.

## Reactions and the failure contract

A consumer has one reaction:

- `observe`: it reads the event and changes nothing in the agent. Permitted.
- `inject_context`: its output is added to the agent's context. Permitted, read-only consumers only.
- `block`: it allows or denies the agent's action. **Not permitted**: `loadModel` refuses a table that
  permits it or a consumer that uses it.

Every consumer, whatever its reaction:

- never blocks the agent: a hard time cap below the agent's hook timeout, and on any failure (missing
  program, no data, a crash) it exits with status 0 and prints nothing;
- never needs to run: an agent with no hook, or a hook that failed, works as it did without Mesh;
- is idempotent: an event can arrive twice (the agent retries, two hooks map to one event); the state
  consumer deduplicates by `native:occurrence` on the server;
- writes nothing to the project tracker. A consumer that would write is a change of this model.

## Consumers

| Consumer | Reaction | Program | Subscribed events | Switch |
|---|---|---|---|---|
| `state` | observe | `bin/mesh-event`, which sends one bounded envelope to `POST /api/event` | per agent, below | none |
| `project_context` | inject_context | `work-read context --format <agent format>` | `session_start` | `MESH_PROJECT_HOOKS` |

`state` turns a generic event into a session state: `session_start` and `turn_end` are idle (`done`),
`prompt_submit` and the tool events are `working`, `permission_request` is `waiting_permission`,
`turn_end_failure` is `error`; a `notification` takes its state from its notice. In production that
mapping, and the decoding of each agent's payload, is `bin/mesh-event`'s, agent by agent. `stateEnvelope`
in `agent-hooks.ts` states the same projection against the normalised event, as a test oracle only: the
tests check that it gives, for each agent's native hooks, exactly the envelope `bin/mesh-event` sends.

`project_context` is described in [The project context hook](#the-project-context-hook).

## Sources

A source is how one agent emits the generic events. Its `kind` is one of:

| Kind | Mesh declares the hooks in | Today |
|---|---|---|
| `native_config` | a configuration the agent reads for this session only | Claude (inline `--settings`), Gemini (a private `GEMINI_CLI_HOME`), Vibe (a private `--add-dir` holding `.vibe/hooks.toml`), Codex (`-c hooks.<Event>=...` on its command line, run once the user has trusted them) |
| `plugin` | a plugin directory the agent loads | Copilot (`--plugin-dir`, shipped as is), agy (installed once by the user), OpenCode (code) |
| `extension` | extension code loaded into the agent | Pi |
| `wrapper` | a program around the agent | none |
| `protocol` | a client of an agent protocol (ACP) that emits normalised events | none; ACP is set aside |
| `none` | nowhere | none |

A source row gives its `events` (generic event, native hook name), the `subscriptions` (which consumer is
installed on which events, in the order the configuration is written), its `timeout` (value and unit, as
the agent reads it), and `inject`: for each event where the agent adds a hook's output to the model's
context, the format name `work-read context` prints for it. A `none` source states its `reason`. How each
generator calls `mesh-event` is in that generator's code.

OpenCode and Pi have no `subscriptions`, so the table installs no consumer on their native hooks. That
does not mean OpenCode reports no state: its plugin code translates its events and reports the state itself.
Pi's extension wakes Pi and reports no state (see the matrix below).

## Capability matrix

What each agent can do for Mesh, and what Mesh installs. Evidence: **run** (observed by running the agent
with a temporary home, no model), **read** (read in the installed package or binary, version given),
**code** (what Mesh's code already does), **not verified**.

| Agent | Source | Session start (native) | Context injection format | Mesh installs: state | Mesh installs: project context |
|---|---|---|---|---|---|
| Claude Code 2.1.329 | native_config, inline settings, timeout 5 s | `SessionStart`, also on resume (run) | `hookSpecificOutput.additionalContext`, or plain stdout (run) | 6 hooks (code) | **wired** (run: the sentence reached the request) |
| Mistral Vibe 3.1.3 | native_config, private overlay, timeout 5 s | `session_start`, also on resume (read) | `hook_specific_output.additional_context`, added to the next user message (read) | 5 hooks (code) | **wired** (run: in `vibe -p`, the sentence reached the request of a local stand-in model) |
| Gemini CLI 0.68.0 | native_config, private overlay, timeout 5000 ms | `SessionStart`, also on resume (read) | `hookSpecificOutput.additionalContext` (read) | 5 hooks (code) | not wired |
| Copilot CLI 1.0.114 | plugin, per session, timeout 5 s | `sessionStart`, also on resume (read) | top-level `additionalContext` (read) | 6 hooks (code) | not wired |
| Antigravity (agy) 1.5.9 | plugin, installed once by the user, timeout 5 s | `SessionStart`, probably not on resume (read, not verified) | `injectSteps` (read) | 2 hooks (code) | not wired |
| OpenCode 1.18.35 | plugin code | none (read) | `experimental.chat.system.transform` in plugin code (read) | translated in the plugin (code) | not wired |
| Pi 1.5.2 | extension code | `session_start` (read) | `pi.sendMessage(..., {deliverAs: "nextTurn"})` in extension code (read) | none; the extension wakes Pi (code) | not wired |
| Codex 0.170.0 | native_config, per-run `-c` overrides, timeout 5 s, run only once trusted by the user | `SessionStart`, also on resume (run) | `hookSpecificOutput.additionalContext`, added as a developer message (run) | none | **wired**, folder only (run: after "Trust all", the sentence reached the request of a local stand-in model; see [Codex](#codex)) |

Why the others are not wired in this first slice:

- **Gemini.** Its private home is refreshed, not rebuilt for each session, so a stale project hook from an
  earlier switch value or installation must be recognised and replaced, as the state hooks are
  (`_is_mesh_gemini_hook`); the state hooks' command ends with `>/dev/null 2>&1 || true`, which would also
  discard the context. Both need a change to the Gemini generator and a run of the real agent.
- **Copilot.** The plugin's `hooks.json` is shipped as is and finds `mesh-event` through `MESH_EVENT_BIN`;
  the project hook needs a second variable passed through the PTY host, and a run of the real agent.
- **agy.** The plugin is installed once, for every agy of the user, Mesh terminal or not, and its
  `SessionStart` probably does not fire on resume: a reinstall by the user and a verification first.
- **OpenCode and Pi.** No configurable session-start hook: injection means changing the plugin or the
  extension code to run `work-read context`, a source of kind `plugin`/`extension`, not a table line.
- **Codex, state.** `bin/mesh-event` finds its session through `MESH_SESSION_TOKEN` in its environment,
  which Codex's shared process can hold from another session (see [Codex](#codex)); a `Stop` hook must
  also print nothing or valid JSON. Not installed until the state hook identifies its session another way.

## The project context hook

At the start (or resume) of a Claude, Vibe or Codex session started by Mesh, `work-read context` reads the project
tracker ([work-read.md](work-read.md)) and adds one sentence to the agent's context, for example:

```text
Project tracker: 2 tasks linked to this session (T-4f5a, T-1a2b), 1 open question. Call work_resume for the details.
```

- **Only ids, counts and a fixed sentence.** Tasks linked to this session (all counted, at most five ids
  shown, `T-` and hexadecimal digits only), tasks linked to this folder or branch (at most five, as in the
  `work_resume` briefing, "at least 5" when it is full), this session's open questions and those
  answered in the last 14 days. Never a title, a note, a question text or a path: tracker text is written by
  other agents, and injected at session start it would read as trusted context.
- **Nothing to say, nothing printed.** No linked task and no question: the agent's context is unchanged.
- **Read-only.** No lock, no commit, no repository creation; a writer holding the lock does not delay it.
- **Never blocks.** A real-time cap of 1.5 s ends the program silently; the agent's own timeout (5 s)
  is a second bound. The read runs in a child process in a process group of its own, and the cap kills that
  whole group, so a `git` that hangs (on a stalled network file system, say) does not outlive it. The cap
  holds even when the program is started with SIGALRM blocked. No Mesh session (`MESH_SESSION` unset), no tracker, an unreadable one, bad arguments or
  any error: exit 0, nothing on standard output or standard error.
- **No token.** `MESH_SESSION_TOKEN` is emptied before anything else, so the git processes the library
  starts do not inherit it.
- **Only where the table wires it**, only when `work-read` is installed (in `MESH_BIN_DIR`, or the opam
  switch of a source install), and only while `MESH_PROJECT_HOOKS` is not `0`, `off`, `false` or `no`. The
  switch is read by the web server when it builds a session's configuration: a change applies to the
  sessions started (or restored) after it. A restored Claude or Codex command drops a project hook it
  carried from an earlier switch value or another installation before adding the current one.

The hook is on by default because it is read-only and bounded in time, which the tests prove: a missing
tracker, a locked tracker, a hanging read, `work-read` absent from the installation, and a terminal outside
Mesh all leave the agent's start undelayed beyond the cap and its output unchanged.

### Codex

Mesh adds the hook to every Codex command it starts (both presets, a resume, a restore, an account alias)
as one override for that run only:

```text
codex ... -c 'hooks.SessionStart=[{hooks=[{type="command",command="<bin>/work-read context --format codex",timeout=5}]}]'
```

Mesh writes no Codex file: not `config.toml`, not `hooks.json`, nothing under `/etc`.

- **Codex runs it only once you trust it.** A new or changed hook definition is held back until the user
  answers Codex's "Hooks need review" screen with "Trust all and continue" (or trusts it from "Review
  hooks"). Codex then records the trust itself in the `config.toml` of that Codex home
  (`[hooks.state."/<session-flags>/config.toml:session_start:0:0"] trusted_hash = "sha256:..."`) and does
  not ask again while the definition stays the same. Mesh never answers that screen and never writes that
  record. Untrusted, the hook does not run: `codex exec` skips it without a word, and "Continue without
  trusting" starts the session without it. [operations.md](operations.md#codex-hooks-trust-once-per-codex-home)
  says what the operator does.
- **A stable definition.** The trust covers the command, so the command holds nothing that changes from one
  launch to the next: no session name, no token, no environment value. It does change with the
  installation directory (a move from a source install to a release, say), which asks for the trust again.
  A user's own `-c hooks.SessionStart` (or `-c hooks={...}`) in a saved command is kept, and Mesh then adds
  none.
- **No identity from the environment.** Codex may run hooks from one process shared by every session of a
  Codex home, started with the environment of the first session it served (observed with a bare `codex`,
  codex-cli 0.170.0): a hook there would see another session's `MESH_SESSION` and `MESH_SESSION_TOKEN`. So
  `--format codex` reads neither. It reads the JSON Codex writes on its standard input (at most 64 KiB):
  the event must be `SessionStart`, `session_id` a lowercase UUID (Codex's conversation id) and `cwd` an
  absolute existing folder; anything else prints nothing. Of the environment it reads only the tracker's own
  variables (`HOME`, `WL_HOME`, `WL_HOST`, `WL_NOW`, `WL_LOCK_TIMEOUT`).
- **Folder only.** Mesh keeps no mapping from Codex's `session_id` to a Mesh session that the hook could
  read, so a Codex session is told about the tasks linked to its folder (or its repository and branch) and
  not about the tasks and questions of its Mesh session, which `work_resume` gives.
- **Outside Codex's sandbox.** Codex runs hooks outside its sandbox, which is why only this read-only,
  bounded program is installed.

## Adding a hook or an agent

- **A consumer on more events of an agent.** Add the event to the source's `subscriptions`: the
  generator installs every subscribed event of the consumers it handles. The `state` consumer is handled
  by the Claude, Gemini, agy and Vibe generators (Copilot's file is checked against the table), the
  `project_context` consumer by the Claude, Vibe and Codex generators (`agentmcp.project_context_hooks`).
- **A consumer on a new agent.** Subscribe it and, for `inject_context`, add the format to `inject`. If
  that agent's generator does not handle the consumer yet, add the call there too (for `project_context`,
  one call to `project_context_hooks` and the agent's way of writing a command hook), and make the
  commands it recognises as Mesh's on resume include the new hook.
- **A new consumer.** Add it to `consumers` with its reaction, program and switch, subscribe it in the
  sources, and add one call to each generator that should install it: a table entry alone installs
  nothing.
- **A new agent.** Add a source row. A `native_config` source also needs a generator that writes the
  agent's configuration for one session; a `plugin`, `extension` or `protocol` source emits the normalised
  event from its own code.

## Tests

- `tests/agent-hooks-model.test.ts`: the table is valid and a broken one is refused; it has a source for
  every agent in `agentcap.MATRIX`; the Python generators install what the table says; the shipped Copilot
  `hooks.json` is the table's rendering byte for byte; the table's `cap_seconds` equals
  `Wr_context.cap_seconds`; `stateEnvelope` equals `bin/mesh-event`'s envelope for each agent's native hooks.
- `tests/agent-hooks-golden.test.ts`: the configurations generated for Claude, Gemini, agy, Vibe and Copilot
  are byte for byte those of the revision before the model (`tests/fixtures/agent-hooks-model/`) without
  `work-read` or with the switch off, and differ by the project hook alone otherwise.
- `tests/agent-hooks-fake-agent.test.ts`: a stand-in for Claude's and Vibe's hook runners runs the generated
  session-start hooks with the real `work-read` on a fictional tracker.
- `tests/codex-hooks-launch.test.ts`: with a stand-in `codex` started by the real server and PTY host, the
  exact `-c hooks.SessionStart` item on both presets, on an alias launch (its `CODEX_HOME`, its credentials
  unset) and on its resume, no token or session name in it, none with `MESH_PROJECT_HOOKS=0`; and on
  `agentmcp.inject`: an earlier Mesh hook replaced or removed, a user's own override kept.
- `ocaml/work_read/test/test_context_codex.ml`: `--format codex` takes its folder from standard input and no
  identity from the environment (another session's `MESH_SESSION` and token are ignored), refuses malformed
  input silently, and keeps the cap.
- `ocaml/work_read/test/test_context.ml`: the program itself (formats, silence, read-only, lock, cap); a
  hanging `git` killed with the program, also with SIGALRM blocked; ill-formed task ids never printed nor
  counted; the session token emptied in the `git` it starts.
