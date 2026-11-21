---
kind: fixed
---
- **Restarting an agent in its own terminal is more robust.** When the agent is the session's own
  program, the session is replaced by a new one as before instead of the request failing. When the
  PTY host cannot stop the agent alone otherwise (it shares the shell's process group without job
  control, or the host cannot see what holds the terminal), another program holds the terminal, or
  the agent runs in the background, nothing is stopped and the request says what to do, so an
  agent that ignores the hang-up never keeps running beside the new one. A restarted Claude
  listens on its wake socket again (the stopped one's socket file is removed first), a line half
  typed at the prompt during the stop is erased instead of being joined to the launch command (in
  an emacs-mode shell), and a slow stop (up to 15 s) is waited for, with an accurate message if it
  still comes too late. See
  [Account aliases](docs/operations.md#account-aliases-separate-claude-and-codex-accounts).
