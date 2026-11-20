---
kind: internal
---
- **`mesh-platform accounts carry` copies one conversation between account folders.** It takes
  `accounts.json`, the agent (`claude` or `codex`), the conversation id and two accounts (alias
  ids or `default`), checks both folders as `accounts prepare` does, and copies only that
  conversation (Claude: its transcript and its own folder; Codex: its rollout file only), never a
  login file, a link or a hard link. For Codex, resuming from the rollout alone under the other
  `CODEX_HOME` is not verified yet: it is to be tried on throwaway accounts before anything carries
  Codex conversations. A carry is bounded (5000 files, 2 GiB) and refused when the target's disk
  would keep less than 512 MiB free; two carries of the same conversation into the same account
  never run together; files left by a killed carry are cleaned up by the next one. A different
  copy already in the target is never overwritten, and a failed copy leaves the target as it was
  (a target folder it created is removed again). Nothing calls it yet: it prepares switching a
  session to another account.
