---
kind: internal
---
- **`mesh-platform accounts carry` copies one conversation between account folders.** It takes
  `accounts.json`, the agent (`claude` or `codex`), the conversation id and two accounts (alias
  ids or `default`), checks both folders as `accounts prepare` does, and copies only that
  conversation (Claude: its transcript and its own folder; Codex: its rollout), never a login file
  or a link. A different copy already in the target is never overwritten, and a failed copy leaves
  the target as it was. Nothing calls it yet: it prepares switching a session to another account.
