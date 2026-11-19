---
kind: fixed
---
- **A project configuration edit reports `busy` when another writer releases its lock during
  inspection.** Previously this race could incorrectly report `invalid-config`. The edit is
  refused and can be retried after reading the current revision.
