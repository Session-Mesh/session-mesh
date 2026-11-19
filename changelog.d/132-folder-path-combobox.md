---
kind: added
---
- **The New session dialog suggests folders in its own list, allowed work folders first.** The
  "Folder" field is now an accessible combobox (`role="combobox"`, `aria-autocomplete="list"`,
  `aria-activedescendant`) instead of a native `<datalist>`: the arrows move in the list, Enter or
  Tab puts the chosen folder in the field without submitting, Escape closes the list before the
  dialog, a tap opens it on a phone, and options are 44 px tall on touch screens. Its known folders
  are the allowed work folders when they are configured (`GET /api/config`), then the 8 folders
  this browser last started a session in (kept in the browser), the folders of the open sessions
  and `GET /api/dirs`; a typed text ranks them by path prefix, folder-name prefix, substring, then
  letters in order. The sub-folders of a typed path (`POST /api/ls`, as before) come first, and a
  listing request for an older text is now aborted. When work folders are configured, a suggestion
  outside them is left out, except a parent folder on the way to one. No server change: the
  server still checks the folder when the session starts.
