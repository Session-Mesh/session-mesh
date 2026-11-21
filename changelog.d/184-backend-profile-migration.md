---
kind: added
---
- **Migrate account aliases to backend profiles.** Add the explicit `mesh-profile migrate`
  command, use the registry for Claude/Codex account resolution and conversation carry,
  and ship the profile helper in bundles and native-program installations. Migrated alias
  IDs and backend-specific labels are preserved; migration does not copy credentials or
  conversations, restart terminals, or qualify live account switching.
