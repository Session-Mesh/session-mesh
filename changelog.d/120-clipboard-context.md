---
kind: fixed
---
- **Clipboard reads keep their original terminal.** A clipboard result is discarded if its pane,
  connection or session changes while the read is pending, rather than pasting into a replacement.
  Clipboard pastes wait through terminal replay and keep their place ahead of keys typed after
  the paste action.
