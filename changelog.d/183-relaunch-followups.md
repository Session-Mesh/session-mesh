---
kind: fixed
---
- **Restarting an agent in its own terminal is more robust.** When the PTY host cannot stop the
  agent alone (it is the session's own program, it shares the shell's process group, or the
  terminal cannot be read), the session is replaced by a new one as before instead of the request
  failing; when another program holds the terminal or the agent runs in the background, nothing is
  stopped and the request says what to do. A restarted Claude listens on its wake socket again
  (the stopped one's socket file is removed first), a line half typed at the prompt during the stop
  is erased instead of being joined to the launch command, and a slow stop (up to 15 s) is waited
  for, with an accurate message if it still comes too late. See
  [Account aliases](docs/operations.md#account-aliases-separate-claude-and-codex-accounts).
