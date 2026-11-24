---
kind: fixed
---
- **Terminal reconnects distinguish replacement sessions from retained views.** An active pane can
  reconnect when its session is restarted under the same name. A view restored from the browser's
  back/forward cache stays detached if its original session was replaced, until explicitly selected.
  Pending input remains bound to its original session incarnation. After replay it is sent only
  while that incarnation remains bound; a replacement incarnation does not receive it.
  An account switch or in-place agent restart also retires input retained for the previous
  incarnation.
  When an older native host remains running during an upgrade, live terminals stay accessible
  in a clearly marked limited mode without restarting their programs. Automatic resizing and
  captured or delayed input stay disabled until the connected host confirms their guarantees;
  an explicit resize remains available.
