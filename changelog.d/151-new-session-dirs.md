---
kind: added
---
- **The New session dialog suggests the sub-folders of the allowed work folders, shares its recent
  folders between devices, and completes with Tab.** `GET /api/dirs` now lists the allowed work
  folders and their sub-folders (of `~/dev` when none is configured), keeping only folders a session
  may start in once symbolic links are resolved, inside the home folder and not protected; it is
  still a plain list of paths, at most 200. The 8 recent folders are a runner setting
  (`recent_folders` in `settings.json`, read from `GET /api/config`) that the server records when
  the signed-in browser starts a session; a browser moves the list it kept before once (`POST
  /api/dirs/recent`, owner cookie only) and removes its copy, as signing out and the sign-in page
  do. The list also opens when the field gets the focus. Tab accepts the chosen suggestion, else
  the first one once something is typed, and announces it; it moves on when the field already
  holds it, when nothing was typed, or when there is no suggestion. See
  [Starting and finding sessions](docs/features.md#starting-and-finding-sessions).
