---
kind: fixed
---
- **A full-screen agent opened late keeps its alternate screen and mouse wheel.** After pi,
  OpenCode, Copilot or Antigravity had written more than the 2 MiB a replay keeps, a browser that
  opened the session afterwards was on the normal screen with mouse reporting off, and the wheel
  did nothing. The PTY host now starts a cut replay with the terminal modes the output had set
  where the replay starts; it takes effect after a PTY host restart. See
  [Terminal modes in a cut replay](docs/operations.md#terminal-modes-in-a-cut-replay).
