---
kind: fixed
---
- **A renamed session keeps its name when its agent restarts.** An account switch or an approved
  restart gave the session a new incarnation (in the same terminal) or a replacement session, and
  the name, folder and place in the list, bound to the previous incarnation, were dropped by the
  next listing; a later PTY host restart then offered the session back under its generated name.
  They now move to the incarnation that continues the session. See
  [Account aliases](docs/operations.md#account-aliases-separate-claude-and-codex-accounts).
