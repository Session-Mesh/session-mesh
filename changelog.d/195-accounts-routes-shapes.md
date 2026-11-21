---
kind: fixed
---
- **The account routes relay only the data shape the helper gives.** A `profiles.list` reply
  whose `configured` or `enabled` is not a boolean, whose `registry_revision` is not null or a
  digest, or whose profile has an unknown backend or a malformed id is now refused with
  `503 backend-helper-unavailable`, as are consent pairs with an id the helper would refuse, two
  equal accounts or two backends. See
  [the HTTP routes](docs/backend-account-profiles.md#http-routes).
