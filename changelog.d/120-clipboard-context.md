---
kind: fixed
---
- **Clipboard reads keep their original terminal.** A clipboard result is discarded if its pane,
  connection or session changes while the read is pending, rather than pasting into a replacement.
