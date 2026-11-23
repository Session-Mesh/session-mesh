# Native wake and message channels of the supported agents

Before typing a notice into an agent's terminal, check what the agent itself offers for receiving an
external message. This page records that search for each supported agent as of 2026-11-16: which native
mechanism exists, what Mesh does with it today, how safe it is, and whether it is worth integrating. The
rule that makes the search mandatory for a new agent is in
[Look for the client's native message channel first](agent-integration.md#look-for-the-clients-native-message-channel-first).

The five agents Mesh wakes by typing, or does not wake at all, come first: OpenCode (1.x and 2.x), Gemini CLI,
Mistral Vibe, GitHub Copilot CLI and Antigravity (`agy`). Claude Code, Codex and Pi follow in a short table.

## How to read the evidence

| Label | Meaning |
|---|---|
| observed | A command was run on this machine and its output read. Only `--help` and `--version` of the installed clients, and `vibe` installed in an isolated prefix, were run. No message was sent, no conversation created, no agent configuration directory read. |
| read in code | Read in source that is on disk: this repository, the Vibe 3.1.2 package, or text embedded in the `agy` and `opencode` binaries (`strings`). |
| documented | Read on the vendor's public documentation page named in the row. Not run. |
| to test | Assumed from the above; the manual trial listed in the section decides it. |

Versions: OpenCode 1.18.35 (installed) and 2.3.0 (not installed here),
Gemini CLI 0.68.0, Mistral Vibe 3.1.2 (not installed on the machine; installed with `uv tool install` into a
scratch prefix with its own `HOME`), Copilot CLI 1.0.112, `agy` 1.5.9.

## Summary

Delivery to a TUI that is already open is "to test" for every candidate: nothing could be sent into a real
session. "Typed" is the notice Mesh types at the prompt today, after the agent reported an idle turn
(`AGENT_WAKE_PRESETS`).

| Agent | Today | Best native candidate | Evidence | Recommendation |
|---|---|---|---|---|
| Copilot CLI | no wake | An extension (loaded through the Mesh plugin) that waits for the client's own idle event and calls `session.send` with a neutral notice | `copilot help extensions` observed; `session.send` and `session.idle` documented by a third party, not by the vendor page read | Best solution. Integrate after the trial (first in the order of work). |
| Antigravity (`agy`) | no wake | `Stop` hook answering `{"decision":"continue","reason":...}` when mail waits, plus `PreInvocation` `injectSteps` for the next prompt | read in code (hook documentation embedded in the 1.5.9 binary) | Best solution for turn ends; covers neither an interrupted turn nor an agent idle for a long time. Integrate that part. |
| OpenCode 1.x / 2.x | typed | The Mesh plugin, already loaded in the client, sends the notice with the client's own session API (`session.prompt`) | server routes observed as strings in 1.18.35; SDK methods documented; plugin `client` for 1.x documented but not re-read; 2.x plugin context not known to carry a prompt API | Best solution for 1.x after the trial. For 2.x study first; keep typing as the fallback. |
| Gemini CLI | typed | `AfterAgent` hook answering `deny` with a reason (forces a new turn), `BeforeAgent` `additionalContext` for the next prompt | documented (`geminicli.com/docs/hooks/reference`) | Study. Turn ends only; typing stays for an idle agent. |
| Mistral Vibe | typed | Native session queue of the app server (`session/turn/enqueue`, idempotent, `delivery: queue`) behind a Mesh-supplied `VIBE_APP_SERVER_CMD` wrapper | read in code (3.1.2 package) | Study; highest cost. A `pre_agent` hook with `additional_context` is the cheap complement. Keep typing meanwhile. |

## OpenCode 1.x and 2.x

**Today.** A plugin (`opencode-mesh-plugin.ts` for 1.x, `opencode-mesh-plugin-v2/` for 2.x) reports working,
waiting and done to `POST /api/event`. A notice is typed only after `done`.

**What the client offers.**

| Mechanism | Evidence | Delivery to an open TUI |
|---|---|---|
| HTTP server routes `POST /session/:id/message`, `POST /session/:id/prompt_async` (204), `POST /session/:id/command`, `POST /tui/append-prompt`, `/tui/submit-prompt`, `/tui/show-toast`, `/tui/execute-command`; basic auth through `OPENCODE_SERVER_PASSWORD` | documented at `opencode.ai/docs/server`; the same route names are present as strings in the 1.18.35 binary (observed) | The TUI is a client of the server it starts; `--port` and `--hostname` fix its address (documented). Whether a message sent this way appears in the open TUI: to test. |
| `opencode attach <url>`, `opencode run --attach <url> -s <session>` | `opencode attach --help`, `opencode run --help` observed | `run --attach` creates a turn on a running server through the CLI. It needs the server URL, hence a known `--port`. |
| SDK `session.prompt` (`noReply: true` adds context without a model turn), `tui.showToast`, `tui.appendPrompt`, `tui.submitPrompt`, `event.subscribe` | documented at `opencode.ai/docs/sdk` | A plugin that has the client can call them in process. |
| `opencode acp`, `opencode serve`, `opencode web` | `--help` observed | Separate processes with their own sessions; not a channel into the open TUI. |
| 2.x plugin `setup(ctx)` with `ctx.event.subscribe` | read in code (`opencode-mesh-plugin-v2/index.ts`) | 2.x is launched with `--standalone`, so the plugin runs in the server process of that terminal. Whether `ctx` carries a prompt API: unknown. |

**Candidates, best first.**

1. **Plugin in process, session API.** The plugin already runs inside the client, already knows the session
   (its events carry it) and already holds the session token. It would ask Mesh for pending wakes (a stream
   like Pi's, which does not exist for other agents yet), then call `session.prompt` for that exact session
   with the neutral notice text. No port, no password, nothing typed. Cost: a plugin change per major, a
   server-side generic wake stream and an acknowledgement, as Pi's. Risk: what the client does with a prompt
   sent while a permission or a question is open (to test; Mesh's gate must still apply).
2. **`/tui/show-toast`.** Notifies the owner without a model turn, so it wakes nothing. Needs a known port and a
   password in the environment. Not a replacement.
3. **`/tui/append-prompt` plus `/tui/submit-prompt`.** Equivalent to typing: it can overwrite what the owner is
   writing. Reject.

**Safety.** Exact conversation: the session id of the plugin's own events. No typed bytes: yes (candidate 1).
Secrets: candidate 1 adds none; candidate 2 puts a server password in the environment. Idempotence: Mesh's
notification id, acknowledged by the plugin. Consent: unchanged, the text is read later through the mailbox
with the owner's approval.

**Manual trial on a throw-away session (1.x).** A disposable `HOME` and project, a local model. Start the TUI,
fix `--port`, let the model answer once. From a second terminal, send a `prompt_async` with the neutral text to
the session id: is it shown and answered? Repeat with a permission dialog open. Then load a plugin that logs
the keys of its argument to learn whether it gets a `client`. For 2.x, the same with `--standalone`.

## Gemini CLI 0.68.0

**Today.** Five hooks (`BeforeAgent`, `BeforeTool`, `AfterTool`, `Notification`, `AfterAgent`) report state to
`POST /api/event`. A notice is typed after `done`.

**What the client offers.**

| Mechanism | Evidence | Delivery to an open TUI |
|---|---|---|
| `--acp` (stdio server), `-p`, `--output-format stream-json`, `--session-file`, `--resume` | `gemini --help` observed | ACP and headless runs are other processes, not a channel into the open TUI. |
| `AfterAgent` hook: `decision: "deny"` rejects the response and forces a retry, the `reason` being sent as a new prompt | documented at `geminicli.com/docs/hooks/reference` | Runs when a turn ends. To test: what the owner sees of the rejected response. |
| `BeforeAgent` hook: `hookSpecificOutput.additionalContext` appended to the prompt of that turn | same page | Next prompt only. |
| `Notification` hook: `systemMessage` shown to the owner, cannot block | same page | Display only; no model turn. |
| IDE companion, remote control, queue command | none found in `--help` (observed) or in a public search | none |

No documented hook or extension injects a user turn into an idle session.

**Candidates, best first.**

1. **`AfterAgent` deny.** The hook already runs at every turn end. When Mesh holds an unread notification for the
   session, the hook prints a deny with a neutral reason. A new turn starts at once, with no typed byte, for
   the exact `session_id` of the payload. Costs one model turn per batch, and loops unless Mesh answers once per
   notification id.
2. **`BeforeAgent` `additionalContext`.** The next time the owner prompts, the model is told that mail waits.
   Free, but not a wake.
3. **Typed notice** for an agent that is idle: unchanged, the only way today.

**Manual trial.** A disposable `GEMINI_CLI_HOME` and a local or dummy-key model that answers (an individual
Google sign-in is refused). With an `AfterAgent` hook that denies once: is a
new turn started, is the first answer still readable, does a permission prompt of the retry turn behave
normally?

## Mistral Vibe 3.1.2

**Today.** Hooks in `hooks.toml` report state to `POST /api/event`; the notice is typed after `done`.
`vibe` is not installed on this machine: it was installed with
`uv tool install mistral-vibe` into a scratch prefix (own `HOME`, `VIBE_HOME`, cache), `--help` and the package
source were read, nothing was started.

**What the client offers.**

| Mechanism | Evidence | Delivery to an open TUI |
|---|---|---|
| Rust TUI that starts `vibe-app-server` (stdio JSON-RPC) and takes its command from `VIBE_APP_SERVER_CMD` or `VIBE_APP_SERVER_BIN` | read in code (`vibe/cli/launcher.py`) | The only external hook is the command the TUI runs; no listening socket was found in `vibe/cli`. |
| Protocol methods `session/turn/enqueue` (with `idempotency_key`, `delivery: queue` or `start_turn`, `sender`), `session/peer/send`, refusals `busy` and `paused` | read in code (`vibe/app_server/protocol.py`) | Built for session-to-session messages inside one client. Whether the TUI shows a message enqueued by a wrapper: to test. |
| Hooks: `pre_agent` command may print `hook_specific_output.additional_context`; `notification` hooks cannot act | read in code (the bundled `vibe` skill, `SKILL.md`) | Next turn only. |
| `vibe-acp`, `vibe-app-server --multiplex`, `-p` | `--help` observed | Other processes. |
| Queued messages in the TUI (`turn_completed` waits until the queue is empty) | read in code | A user-facing queue; the protocol above is its external form. |

**Candidates, best first.**

1. **App-server wrapper.** Mesh sets `VIBE_APP_SERVER_CMD` to a small program that relays the TUI's stdio to the
   real app server and also listens on a private Unix socket (0700 directory, derived from the session nonce, as
   Claude's). On a wake it sends `session/turn/enqueue` with `delivery: queue`, the mail notification id as
   `idempotency_key` and the neutral text, for the session id the wrapper has seen on the wire. This is
   Vibe's own queue: nothing typed, idempotent, exact session. Cost: a protocol proxy coupled to Vibe's
   protocol version, a native program (OCaml) and a test per Vibe release. No secret on the command line.
2. **`pre_agent` `additional_context`.** Cheap, next turn only.
3. **Typed notice**: unchanged until 1 is proven.

**Manual trial.** In a scratch prefix and `VIBE_HOME`, run the TUI with a logging wrapper as
`VIBE_APP_SERVER_CMD` and a local OpenAI-compatible provider: record the handshake and the session id. Then
inject a `session/turn/enqueue` with `delivery: queue` while idle and while a turn runs: does the TUI show it,
start a turn when idle, keep one copy when it is sent twice?

## GitHub Copilot CLI 1.0.112

**Today.** The `copilot-mesh-plugin` hooks report state; no notice is ever typed, because autopilot entered from
the status bar makes `agentStop` ambiguous.

**What the client offers.**

| Mechanism | Evidence | Delivery to an open TUI |
|---|---|---|
| Extensions: `extension.mjs` calling `joinSession()` from `@github/copilot-sdk/extension`, in its own Node process, with tools and hooks; experimental (`--experimental`); loaded once the folder is trusted; plugins can bring extensions; `--extension-sdk-path` | `copilot help extensions` observed | The extension is attached to the user's foreground session. |
| `session.send({prompt})`, `session.on("session.idle")`, `session.log` | `session.log` documented at `docs.github.com/en/copilot/tutorials/create-an-extension`; `session.send` and `session.idle` documented only in a third-party article (`dev.to/htekdev/...`) and not in the vendor page | To test. |
| ACP (`--acp`) with the events `assistant.turn_start`, `assistant.idle` (foreground settled), `session.idle` (everything settled) | `copilot help acp` observed | Stdio protocol for editors; not a channel into the open TUI. Its event names show the client distinguishes foreground idle from background work, which is what `agentStop` lacks. |
| `--connect [sessionId]`, `/remote on` (steer from GitHub on the web or mobile) | `copilot --help` and `copilot help sessions` observed | Needs a GitHub account and cloud sync. Reject. |

**Candidates, best first.**

1. **Extension.** Loaded through the plugin Mesh already passes (`--plugin-dir`) if the client accepts an
   extension from it (to test), the extension would follow Pi's model: a content-free wake stream from Mesh, an
   acknowledgement, and `session.send` of the neutral notice only when the client's own idle event says the
   foreground is idle. That event replaces the guess about `agentStop` and autopilot. Costs: the experimental
   flag and the folder trust prompt, a JavaScript file in the plugin, a Mesh wake stream for this agent.
2. **Nothing else.** No queue command and no listening socket exist.

**Manual trial.** In a throw-away `COPILOT_HOME` with the fake local model server of
`tests/helpers/fake-openai-provider.ts`: an extension that logs `session.idle` and calls `session.send` after
5 seconds. Questions: is it loaded from `--plugin-dir`, does `--experimental` suffice, is the prompt shown and
answered in the open TUI, what happens with a permission dialog open, and in autopilot?

## Antigravity (`agy`) 1.5.9

**Today.** The plugin hooks `PreInvocation` and `Stop` (with `fullyIdle`) report state; a notice is never
typed because an interrupted turn sends no `Stop`.

**What the client offers.**

| Mechanism | Evidence | Delivery to an open TUI |
|---|---|---|
| `Stop` hook: `{"decision":"continue","reason":"..."}` blocks the stop and re-enters the loop; the reason is injected as a system message | read in code (hook documentation embedded in the binary) | At the end of a turn only. Subject to a forced-continuation limit (`MAX_FORCED_INVOCATIONS`). |
| `PreInvocation` hook: `injectSteps` with `systemMessage` (optionally `metadata.user_markdown`, shown to the owner only) or `userMessage` | same | At the start of the next turn only. |
| Hooks run as commands, synchronously; no HTTP or async hook | same ("Current Limitations") | |
| `agy remote-control start|status|stop` (background daemon), `--remote-control`, `agy acp`, `--input-format stream-json` (print mode only) | `agy --help` and subcommand help observed | Cloud-linked remote control, a separate ACP server and a headless mode; none reaches an open TUI. |

**Candidates, best first.**

1. **`Stop` continue.** The hook already runs at each `Stop`. When Mesh holds a notification for the
   conversation named in the payload (`conversationId`), it answers `continue` with a neutral reason. The agent
   starts a turn that tells it to check `mail.inbox`. No typed byte, exact conversation, no secret (the
   plugin inherits the session environment). It covers a message that arrives during a turn, not one that
   arrives after an interruption or long after the last `Stop`.
2. **`PreInvocation` `systemMessage`.** Same information at the next prompt.
3. **Typed notice**: stays off: an interrupted turn sends no `Stop`, so idleness would be a guess.

**Manual trial.** A signed-in agy in an isolated `HOME` with a plugin whose `Stop` hook answers `continue` once:
does a new turn start, is it visible, does the loop limit apply, does it also happen after a refused permission
(which sends no `Stop`)?

## Agents covered elsewhere

| Agent | Native channel | State in Mesh | Evidence |
|---|---|---|---|
| Claude Code 2.1.325 | `--messaging-socket-path <path>`: an NDJSON socket that wakes an idle session; absent from `--help`, so Mesh cannot probe it without launching a session (see [SECURITY.md](../SECURITY.md)). `claude --bg`, `attach`, `logs`, `stop` manage background sessions | used when Claude's own settings let the line through without approval; typed notice as the fallback | `claude --help` observed |
| Codex 0.169.0 | `codex queue --thread <UUID or exact name> --message <text> [--resume] [--remote <ADDR>]`; `app-server`, `remote-control`, `--remote` | used, off by default (`MESH_CODEX_QUEUE_WAKE=1`): `codex queue --thread <conversation id>` with a fixed line, only for an exact conversation, no typed byte (`agentwake.CodexQueue`; `docs/operations.md`); delivery to a Codex already open in a terminal is not verified; not analysed further here | `codex queue --help` observed |
| Pi 1.5.2 | extensions loaded with `-e`; `--mode rpc` | used: `pi_mesh_wake.mjs` and the `pi-wakes` stream | `pi --help` observed; repository read |

## What every candidate was held to

The checklist is the one in `docs/agent-integration.md`: exact conversation identity, no typed byte, no secret
on a command line or in a file, idempotence, owner consent, neutral text without a digit, a test with a fake
binary and a trial on a throw-away session. The messages stay behind the mailbox: whatever channel carries the
notice, it carries no message text, and the owner's approval is still asked when the agent reads.

## Order of work

Most profitable first, counting new coverage, then safety gained over typing, then cost.

1. **Copilot extension.** One of the supported agents with no wake today (with `agy`; Codex has none either unless the owner enabled `MESH_CODEX_QUEUE_WAKE=1`), and the client exposes its own idle
   event. Trial first: does the plugin load an extension at all.
2. **`agy` `Stop` continue.** The hook exists; a few lines of server and hook logic give a wake at turn end
   without typing.
3. **OpenCode 1.x plugin with `session.prompt`.** Replaces the typed notice by the client's own call. Needs the
   generic wake stream that item 1 also needs, so it follows it. 2.x after its plugin context is checked.
4. **Gemini `AfterAgent` deny.** Turn ends only; the typed notice stays for an idle agent.
5. **Vibe app-server wrapper.** Native queue and idempotency, but a protocol proxy to maintain: last.

Codex's `codex queue` is not ranked here: it is already in use (see the table above).

## Not verified

- Nothing was sent to a real session of any agent. Every "delivery to an open TUI" is to test.
- The 1.x plugin argument (`client`) and the 2.x plugin context were not run. The 2.x binary is not installed.
- Copilot's `session.send` and `session.idle` come from a third-party article; the vendor page read does not
  mention them. The `copilot-sdk` type definitions were not read.
- Vibe was read from its package, not run; its Rust TUI binary was only inspected with `strings`.
- The `agy` hook contract is the text embedded in version 1.5.9; no hook was run for this page.
- Public documentation may describe a newer version than the installed one.
