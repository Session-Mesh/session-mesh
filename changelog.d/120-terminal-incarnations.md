---
kind: fixed
---
- **Terminal reconnects distinguish replacement sessions from retained views.** An active pane can
  reconnect when its session is restarted under the same name. A view restored from the browser's
  back/forward cache stays detached if its original session was replaced, until explicitly selected.
  Pending input remains bound to its original session incarnation and is never replayed implicitly.
