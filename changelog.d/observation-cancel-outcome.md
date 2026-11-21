---
kind: fixed
---
- **A cancelled project observation is reported as cancelled on a busy machine too.** When the
  catalog validator was still exiting after its reply, the PTY host stopped it and reported the
  observation as failed (`collector-failed`); it now reports it as cancelled.
