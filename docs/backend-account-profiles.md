# Native account-profile contract

`mesh-profile` validates profile metadata and manages confirmation preferences. It does not launch an
agent or switch a running session; all public profiles currently report `switch_qualified: false`.

## Identity and configuration

The private `backend-profiles.json` file under `MESH_CONF_DIR` contains
`{"version":1,"profiles":[...]}`. Each profile has exactly `id`, `label`, `backend`, `enabled` and
`roots`. Supported backend tags are `claude`, `codex`, `opencode-v2` and `pi`.

A profile's identity is **`(backend, id)`**. The same alias, such as `work`, may therefore identify one
Claude profile and one Codex profile without rewriting existing session account IDs. IDs reuse the
existing alias grammar: `[a-z0-9-]{1,32}`, excluding `default`. Within a backend, both IDs and labels
must be unique; labels are trimmed at their ASCII whitespace edges and comparison ignores ASCII case,
including disabled profiles. Labels use the existing alias validator: 1–24 Unicode characters, with
control/format characters and line separators refused. They are display text, not verified provider
identities.

The context revision hashes the backend and declared roots, not the label or enabled state. The
registry revision hashes the authored file bytes. An account reference in persisted consent rules has
exactly `backend`, `id` and `context_revision`; an unqualified ID is not enough to grant consent.

Root paths use the existing restricted alias path grammar: absolute, normalized paths of at most
1024 bytes, with only `A-Za-z0-9._+@/-`. Resolving a profile also checks current directory custody and
physical aliases. Public list responses omit roots. Profiles are not an OS sandbox or proof of login.

## Root roles are declarations, not automatic relocation

These fields describe the intended native layout. This helper does **not** set any environment
variables. A launch adapter must separately qualify the exact CLI version, its credential precedence
and its persisted conversation layout before using a profile.

| Backend | Required roles | Native selector to check in the adapter |
| --- | --- | --- |
| Claude | `config`, `history` | `CLAUDE_CONFIG_DIR` selects configuration and native history together. `history` declares a conversation subtree; it is not an independent environment selector. |
| Codex | `config`, `state` | `CODEX_HOME` selects the native home. `state` declares conversation state; it does not itself redirect the native home or SQLite database. |
| OpenCode V2 | `config`, `data`, `state`, `cache` | The roles denote XDG base directories, assigned unchanged to `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`. OpenCode appends its application subdirectory; do not append `opencode` to the bases yourself. |
| Pi | `config`, `history` | Check `PI_CODING_AGENT_DIR` for the agent directory and `--session-dir` / `--session` for conversation storage. Those selectors alone do not establish a safe live checkpoint. |

Claude/Pi `history` and Codex `state` must be a distinct subtree, never the credential root itself or
its ancestor. Shared conversation subtrees are permitted, including an explicitly declared subtree
under another profile's configuration folder **only when both profiles use the same backend**.
Cross-backend overlaps are rejected. Credential roots cannot otherwise overlap. Sharing a subtree or
carrying persisted conversation files is not proof that in-memory drafts, queues, dialogs and tools
have reached a safe switch boundary.

For migration of an existing Claude/Codex alias, the conventional declared conversation subtrees are
`<CLAUDE_CONFIG_DIR>/projects` and `<CODEX_HOME>/sessions`. Declaring those paths does not copy any
conversation or change where the CLI writes it.

## One-shot protocol

The default invocation reads one bounded JSON request from stdin and writes one versioned JSON line.
All objects use closed schemas: unknown or duplicate fields refuse. Operations are `profiles.list`,
`profiles.resolve`, `consent.get`, `consent.set_global`, `consent.set_pair`, `consent.remove_pair` and
`consent.reset`. No operation executes a switch.

A pair-management request must explicitly select its backend:

```json
{
  "version": 1,
  "op": "consent.set_pair",
  "backend": "claude",
  "source_id": "work",
  "target_id": "personal",
  "registry_revision": "<current registry digest>",
  "expected_revision": 0,
  "confirmation": "ask"
}
```

`confirmation` is `ask` or `skip`. Removal requires the same `backend`, `source_id`, `target_id` and
`expected_revision`, without `registry_revision` or `confirmation`; it can remove a retired pair.
Cross-backend pairs refuse. Global edits/reset remain global and do not take a backend.

`mesh-profile --http <operation>` is a native transport mode, **not an authenticated HTTP server**.
It accepts the same fields without `version` and `op`, adds those fields internally and projects an
`http_status` in the response. Its whitelist excludes private `profiles.resolve` and every native
process action. The HTTP binding below authenticates the human browser and enforces origin and body
bounds; the transport mode grants none of that authority.

## HTTP routes

The web server binds six routes to the transport mode, one operation each. Nothing else is
exposed: `profiles.resolve` (its reply holds folders) and every switch stay on the host, and the
path chooses the operation, never the body.

| Route | Operation |
| --- | --- |
| `GET /api/accounts/profiles` | `profiles.list` |
| `GET /api/accounts/consent` | `consent.get` |
| `POST /api/accounts/consent/set-global` | `consent.set_global` |
| `POST /api/accounts/consent/set-pair` | `consent.set_pair` |
| `POST /api/accounts/consent/remove-pair` | `consent.remove_pair` |
| `POST /api/accounts/consent/reset` | `consent.reset` |

- **Caller.** The owner's browser only: the owner cookie, and no `Authorization` header of any
  kind. The master Bearer token, a session token, an empty or all-space `Authorization` header
  beside the cookie, and a missing or wrong cookie are all `401`, as on every owner-only route. A
  foreign `Origin`, or a `Sec-Fetch-Site` other than `same-origin` or `none`, is a bare `403`,
  reads included.
- **Request.** A `POST` body holds the operation's fields without `version` and `op`, as in the
  transport mode, sent as `application/json`, at most 16 KiB. A read takes no query string.
- **Reply.** The helper's envelope, byte for byte, with the HTTP status equal to its
  `http_status`: `{"http_status":200,"version":1,"ok":true,"data":…}` or
  `{"http_status":409,"version":1,"ok":false,"code":"consent-revision-conflict"}`. Statuses and
  codes are those of the transport mode: 409 for a stale `expected_revision`, a changed registry or
  context, a full rule set or an exhausted revision; 404 for an unknown profile or no registry; 400
  for a refused request; 413; 503.
- **Refusals the server gives itself**, in the same envelope, before the helper runs:
  `400 invalid-request` (a query string, or a body that is not a JSON object's text),
  `413 request-too-large` and `415 unsupported-media-type`. When four helpers are running and eight
  more requests are waiting for one, the next request is `503 busy` at once.
- **Fail closed.** No helper, no complete line within 8 s, or a reply that is not exactly the
  envelope gives `503 backend-helper-unavailable`, and the helper's output is not relayed. The
  8 s outlast the helper's own 5 s store busy timeout, so a contended store gives the helper's
  coded answer. Not exactly the envelope means: an unknown key, a status outside
  200/400/404/409/413/503, `ok` or the exit code disagreeing with the status, or `data` that is
  not exactly its operation's shape: for `profiles.list`, `configured`, `registry_revision` and
  profiles with their six public fields; for every `consent.*` operation, the policy (`version`,
  an integer `revision`, `global` and `pairs`, each pair with its two accounts' `backend`, `id`
  and `context_revision`, and its `confirmation`).
- **A failed write.** A `503` on a write does not say whether the helper committed the change.
  Read `GET /api/accounts/consent` again and send the next edit with the revision it gives.

The server runs `mesh-profile --http <operation>` as an argument vector, never through a shell, in
its own process group, with an environment of `MESH_CONF_DIR` (the server's configuration folder,
so the registry and the store sit beside `accounts.json`), `PATH=/usr/bin:/bin` and `LANG` only.
At most four run at once. The program is `MESH_MESH_PROFILE_CMD` when set (an absolute path to an
existing file, else none), otherwise `mesh-profile` in `MESH_BIN_DIR`, or in the opam switch's
`bin` when `MESH_BIN_DIR` is unset.

These routes change preferences only. They never switch an account, and in this version a
session's request to change its account is always put to the owner, whatever the global or pair
preference says: the session-action path does not read the consent store.

## Policy and journal transactions

Pair Ask exceptions override global Skip. Pair Skip requires the exact backend/IDs/context revisions;
a stale context does not retain pair Skip. Pair rules are unordered and never transitive. Management
edits, including a no-op reset or removal, advance a checked revision. Remembered consent removes a
dialog, not native safety checks or the requirement for an approved request path.

The store permits at most 1024 journal rows. `finish_operation` marks an existing row terminal and
immutable; only a qualified coordinator may assert that no recovery remains pending.
`purge_finished` deletes only those explicitly terminal rows. Active or uncertain operations are
never evicted to admit a new one. Finishing, purge, replacement rows and policy edits all roll back
together when their enclosing transaction fails. Retention timing belongs to the future coordinator;
there is no public journal-management operation.

This is a draft v1 contract, not a migration for deployed aliases. Earlier experimental consent
references without a backend and journal tables without terminal metadata are not reinterpreted.
An experimental registry with labels outside the alias rules must be corrected explicitly before use;
an invalid entry refuses the whole registry, rather than silently dropping a profile.
Migration from `accounts.json` and the server/launch/UI bindings are separate integration work.
