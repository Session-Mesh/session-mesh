---
kind: internal
---
- **Account aliases are read through one resolver.** `mesh-platform accounts list` and
  `accounts prepare` now go through `Mesh_account_resolver`, which answers which accounts exist
  and where the account (backend, id) lives; their output is unchanged byte for byte. The new
  `mesh-platform accounts resolve FILE claude|codex NAME` finds an account of one backend by its
  exact id, else by its label ignoring ASCII case; it never accepts a prefix, never an account of
  another backend, and refuses an ambiguous name with the candidates.
