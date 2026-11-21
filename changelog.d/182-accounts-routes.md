---
kind: added
---
- **The web server serves the account profile and confirmation preference routes.** The owner's
  browser lists the declared profiles (ids and labels, never a folder) and reads or edits the
  global and per-pair confirmation preferences through `/api/accounts/profiles` and
  `/api/accounts/consent*`, which run `mesh-profile` and return its answer with its own status. Only
  the owner cookie is accepted, the profile lookup that returns folders has no route, and no route
  switches an account; a session's switch request is still always put to the owner. Without
  `mesh-profile` the routes answer 503, and beyond four running and eight waiting requests they
  answer `503 busy`. See
  [the HTTP routes](docs/backend-account-profiles.md#http-routes).
