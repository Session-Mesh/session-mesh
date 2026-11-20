---
kind: fixed
---
- **A phone beside a desktop on the same session no longer repeats Claude Code's footer.** One
  browser now owns the terminal size: the first to open the session, or the last to press "Take
  the size back". The others show the terminal at that size, clipped, with that button, instead
  of resizing it at each focus (a phone narrower than the desktop kept up to 31 copies of the
  footer in its scrollback). The PTY host decides and tells each browser the size and its owner;
  `mesh-attach` and older pages keep taking the size as before. The symbol "⏵" of Claude Code's
  footer, missing from Android's fonts, now comes from a bundled Noto Sans Symbols 2 (OFL-1.1),
  loaded only when the terminal shows such a symbol. See
  [Working in a terminal](docs/features.md#working-in-a-terminal).
