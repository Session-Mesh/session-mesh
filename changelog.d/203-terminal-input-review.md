---
kind: fixed
---
- **Terminal input review survives session replacement.** A new incarnation gets a fresh
  input attachment without replaying retained bytes from the previous one. Pending input
  blocks automatic page reload, and closing its pane requires an explicit decision.
  An unfinished draft already sent to the terminal also holds reload and warns on close.
