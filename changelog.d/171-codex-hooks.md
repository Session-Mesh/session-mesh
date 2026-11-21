---
kind: added
---
- **Codex sessions start with a reminder of their folder's tracked tasks.** Mesh passes its
  read-only project context hook to every Codex it starts as a per-run `-c hooks.SessionStart`
  override, without a token or session name; Codex runs it once you have answered "Trust all and
  continue", once per Codex home (each account alias has its own). The hook reads its folder from
  the JSON Codex writes on standard input, never a session from its environment. Mesh writes no
  Codex file. `MESH_PROJECT_HOOKS=0` turns it off. See
  [Codex hooks](docs/operations.md#codex-hooks-trust-once-per-codex-home).
