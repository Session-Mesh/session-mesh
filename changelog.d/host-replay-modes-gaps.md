---
kind: fixed
---
- **A cut replay follows the browser terminal's modes more closely.** The PTY host now reads the
  trimmed output as the browser's terminal does: a mode switch with a line feed before its `?`
  counts, the rest of a title or DCS payload at the start of the replay is no longer shown as text,
  a full reset keeps a hidden cursor hidden, and alternate scroll, which that terminal ignores, is
  no longer restored. See
  [Terminal modes in a cut replay](docs/operations.md#terminal-modes-in-a-cut-replay).
