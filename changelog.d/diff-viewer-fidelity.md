---
kind: fixed
---
- **The diff viewer shows mode changes and keeps the loaded lines.** A file whose mode changed (made
  executable with `chmod`, created or deleted with a mode) shows it beside its name, even without a
  change in the content; switching a fully loaded file from "split" to "unified" no longer hides
  lines behind "show more"; and a watched reload loads again every file a deep reading position
  needs. See [Documents beside the terminals](docs/features.md#documents-beside-the-terminals).
