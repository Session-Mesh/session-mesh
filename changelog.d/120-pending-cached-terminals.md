---
kind: fixed
---
- **Pending cached terminals keep their original identity.** A second page-cache suspension or
  temporarily unknown session incarnation no longer loses an unchanged pane's pending restoration.
  Explicit selection and replacement sessions never inherit that restoration or its old focus.
