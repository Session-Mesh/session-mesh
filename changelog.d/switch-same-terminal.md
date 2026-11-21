---
kind: changed
---
- **An account switch or an approved restart keeps the session's terminal.** Only the agent is
  stopped (SIGHUP to its foreground job, SIGKILL after 3 s) and started again in the same shell,
  under the same session name, with its output and every open tab or pane; the conversation is
  copied to the other account in between, and a failed copy resumes it in that terminal under its
  own account. The PTY host serves this through a new `stop_agent_if` operation, so it applies once
  the PTY host is restarted. See
  [Account aliases](docs/operations.md#account-aliases-separate-claude-and-codex-accounts).
