---
kind: added
---
- **Copy as shell command for every copy (opt-in).** A per-browser preference `copyAsShell` in the
  client store, off by default (only `true` turns it on), makes `Ctrl+C`, `Ctrl+Shift+C`,
  right-click, the phone "Copy" button and copy on select write what `Ctrl+Shift+X` writes: the
  `\` continuations of a multi-line command, with the same conservative rules. When the rows cannot
  be rebuilt from the terminal, the text is copied as it is. See
  [Working in a terminal](docs/features.md#working-in-a-terminal).
