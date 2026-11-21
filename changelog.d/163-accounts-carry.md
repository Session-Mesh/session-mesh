---
kind: internal
---
- **`mesh-platform accounts carry` copies one conversation between account folders.** It takes
  `accounts.json`, the agent (`claude` or `codex`), the conversation id and two accounts (alias
  ids or `default`), checks both folders as `accounts prepare` does, and copies only that
  conversation (Claude: its transcript and its own folder; Codex: its rollout file only), never a
  login file, a link, a hard link or a file other users can write. For Codex, resuming from the
  rollout alone under the other `CODEX_HOME` was verified afterwards (see the carry-resume fragment). A carry is bounded (5000 files, 2 GiB)
  and   refused when the target's disk would keep less than 512 MiB free (checked, not reserved); two
  carries of the same conversation into the same account never run together; the lock is between
  processes only (a caller runs one process per carry, or adds its own mutex; nothing is
  guaranteed on NFS, FUSE or SMB); files left by a killed carry are cleaned up by the next one. A
  copy already in the target is replaced only when it is an earlier part of the same conversation,
  never when it differs, and a failed copy leaves the target as it was (a target folder it created
  is removed again) or names what it could not undo. Nothing calls it yet: it prepares switching a
  session to another account.
