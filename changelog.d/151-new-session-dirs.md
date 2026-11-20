---
kind: added
---
- **The New session dialog suggests the sub-folders of the allowed work folders, shares its recent
  folders between devices, and completes with Tab.** `GET /api/dirs` now lists the allowed work
  folders and their sub-folders (of `~/dev` when none is configured), keeping only folders a session
  may start in once symbolic links are resolved, inside the home folder and not protected; it is
  still a plain list of paths, at most 200 (one entry that cannot be examined, such as a symbolic
  link loop, is left out alone), and stops reading folders once it has them. The 8 recent
  folders are a runner setting (`recent_folders` in `settings.json`, read from `GET /api/config`,
  bounded under `max_entries`) that the server records when the signed-in browser starts a session
  in a folder `GET /api/dirs` could list; a `settings.json` that cannot be read whole is never
  rewritten by that recording. A browser moves
  the list it kept before once (`POST /api/dirs/recent`, owner cookie only, the folders `GET
  /api/dirs` could list) and removes its copy, as signing out and the sign-in page do. The list also
  opens when the field gets the focus. Tab completes as in a shell: it accepts the chosen
  suggestion, else the first one that starts with the typed text, and announces it; it never puts a
  fuzzy match in the field, and moves on when no suggestion starts with the text, when the field
  already holds it, or when nothing was typed. See
  [Starting and finding sessions](docs/features.md#starting-and-finding-sessions).
