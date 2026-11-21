---
kind: security
---
- **Owner-only routes refuse any `Authorization` header, an empty one included.** A request
  carrying the owner cookie and an empty or all-space `Authorization` header was accepted; it
  granted nothing more, but the rule is that these routes take the owner's browser cookie and no
  `Authorization` header of any kind. It is now `401`. See
  [the HTTP routes](docs/backend-account-profiles.md#http-routes).
