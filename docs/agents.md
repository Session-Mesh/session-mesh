# Supported agents

session-mesh starts eight coding agents from its "New session" dialog, besides a shell or any other
command. The table says what the mesh does with each one; the sections linked below it give the
details and the limits.

| Agent | Command | `mesh-board` MCP server | History, title and full-text search, pins | Resume from History | Delete from History | Woken when agent mail arrives |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | yes | yes | button | yes | without typing, on its messaging socket (Claude Code 2.1.325 or later, when its `crossSessionInbound` setting lets the line through); otherwise a typed notice while idle |
| Codex | `codex` | yes | yes | button | yes | with `codex queue`, only when `MESH_CODEX_QUEUE_WAKE=1` (off by default); never typed into |
| Pi | `pi` | yes (Pi 1.3 or later) | yes | button | yes | by its extension |
| OpenCode | `opencode` | yes | yes | button | no | typed notice while idle |
| Gemini CLI | `gemini` | yes | yes | button; command on the card for a chat of your own `~/.gemini` | yes | typed notice while idle |
| Antigravity | `agy` | through its plugin | yes | button; command on the card for a conversation that is not the latest of its workspace | no | never: mail waits until the agent checks its inbox |
| GitHub Copilot CLI | `copilot` | yes | yes | button | no | never: mail waits until the agent checks its inbox |
| Mistral Vibe | `vibe` | yes | yes | button | no | typed notice while idle |

What the columns mean:

- **`mesh-board` MCP server.** Agents started by a preset get the mesh's MCP server, which provides
  the whiteboard, demos, messages between agents and requests to you, without losing their other MCP
  servers. Antigravity gets it only once its plugin is installed (`scripts/agy-setup.sh install`,
  see [Antigravity sessions](features.md#antigravity-sessions)). Pi needs version 1.3 or later and
  `mesh-board-mcp`, which a release brings and a source install builds
  ([Native PTY host](install.md#native-pty-host)).
- **History.** The History tab reads each agent's own store, read-only, lists the conversations by
  folder, searches them by title and full text, and opens a card per conversation. Any of them can
  be pinned. See [Conversation history](features.md#conversation-history) for where each store is
  read and the limits.
- **Resume.** A conversation is resumed with the agent's own resume command, in its folder. Where
  the table says "command on the card", the mesh cannot resume it itself and shows the command to
  run.
- **Delete.** Offered where the agent keeps a conversation in one transcript file. For the others,
  remove the conversation with the agent itself.
- **Wake-up.** The recipient of agent mail is told only that messages are waiting, never their
  text. A typed notice is sent only while the agent is idle at its prompt and you have nothing
  unsent in it. See [Messages and requests from agents](features.md#messages-and-requests-from-agents)
  and, for Codex, [Waking Codex with codex queue](operations.md#waking-codex-with-codex-queue).

## Agents running outside the mesh

The sidebar also lists agents running in other terminals of the machine (SSH, tmux, terminal
emulators). When the mesh knows the conversation one of them is in, its card offers "Restart now",
which stops the agent and resumes the conversation in a mesh session. "Restart once it is idle",
which waits for the running task to end first, is offered only for Claude Code, Codex and OpenCode,
whose idle state the mesh can observe.

## Per-agent pages

[Pi](features.md#pi-sessions), [OpenCode](features.md#opencode-sessions),
[Gemini CLI](features.md#gemini-cli-sessions), [Antigravity](features.md#antigravity-sessions),
[GitHub Copilot CLI](features.md#github-copilot-cli-sessions) and
[Mistral Vibe](features.md#mistral-vibe-sessions) have their own sections in
[features.md](features.md), with their setup and limits. Adding an agent is described in
[agent-integration.md](agent-integration.md).
