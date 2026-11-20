---
kind: added
---
- **Account aliases: a session can run Claude or Codex under another account.** The operator
  declares any number of aliases, up to 64, in `accounts.json` on the runner (an id, a label such
  as "Atacama", a Claude configuration folder and/or a Codex home). New session then offers an
  **Account** choice for Claude and Codex, sorted by label and remembered per device; the agent
  runs with that alias's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, without the default account's
  credential variables, and the alias label is shown as a badge on the session's row and pane
  header. The page only sends the alias id, never a folder; an alias without a folder for the
  agent, or no longer declared, is refused rather than replaced by the default account; a restore
  or an approved restart keeps the alias, and a restore looks for the conversation in its folder
  only. Mesh never opens the login files kept in these folders and refuses them in `/view`. With
  no `accounts.json`, nothing changes. See
  [Account aliases](docs/operations.md#account-aliases-separate-claude-and-codex-accounts).
