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

`GET /api/config` advertises `capabilities.account_settings: true` for this binding. Clients must
hide the settings entry when that explicit capability is absent or false; it is not a PTY-host or
live-switch qualification flag.

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
  coded answer. Not exactly the envelope means: an unknown or repeated key (at any depth), a
  `version` that is not the integer 1 or an `ok` that is not a boolean, a status outside
  200/400/404/409/413/503, `ok` or the exit code disagreeing with the status, a refusal code under
  another status than the transport mode gives it (a code it does not list must be 503), or `data` that is
  not exactly its operation's shape: for `profiles.list`, a boolean `configured`, a
  `registry_revision` that is `null` or a digest (64 lower-case hex digits), and profiles with
  their six public fields: an `id`, a string `label`, a known `backend`, a boolean `enabled`, a
  digest `context_revision` and `switch_qualified` false; for every `consent.*` operation, the
  policy (`version`, an integer `revision`, `global` and `pairs`, each pair with its
  `confirmation` and its two accounts' known `backend`, `id` and digest `context_revision`, both
  accounts of one backend with two different ids). An `id` is what the helper accepts: 1 to 32
  characters among `a`-`z`, `0`-`9` and `-`, and not `default`. The label is relayed as the
  helper gives it; the helper checks it when it reads the registry.
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

The consent/store format remains a draft v1 contract. Earlier experimental consent
references without a backend and journal tables without terminal metadata are not reinterpreted.
An experimental registry with labels outside the alias rules must be corrected explicitly before use;
an invalid entry refuses the whole registry, rather than silently dropping a profile.

## Explicit migration and account-source selection

Run `mesh-profile migrate` on the runner with the same `MESH_CONF_DIR` as the web server. This host-only
command converts legacy aliases without moving credentials or conversations. It is not an HTTP
operation and opening the settings never runs it.

Migration validates the complete `accounts.json` and converted registry before publishing a private
`backend-profiles.json` without replacing an existing target. Up to 64 aliases can produce 128
backend-qualified profiles. The original file bytes and agent directories remain unchanged; missing
agent directories are not created. Success reports only alias/profile counts. A repeat migration or
an existing target refuses rather than silently merging or overwriting it, except when retrying
an interrupted no-clobber publication whose private, fsynced publication-intent record binds the
exact stage, source and target identities and converted registry digest. A matching stage name
and bytes alone never establish that migration created the target. A recorded target left with
one link (after stage removal but before the marker) can also be completed on retry. If the
intent is missing, invalid or left before the target link, migration refuses; reconcile that
incomplete publication explicitly rather than removing an ambiguous file automatically.
Other existing targets and staging files are never removed automatically.
Migration rejects a trimmed label that newly collides with another ID in the same backend (or
`default`). It also refuses a derived `config/projects` or `config/sessions` path exceeding the native
1024-byte limit: shorten the legacy base path in `accounts.json` before migrating, and move the agent
directory separately if necessary. Neither a truncated path nor a changed native path limit is used.

After the registry is synced and published, a private `backend-profiles.migrated` marker retires automatic
legacy fallback. If the registry later disappears, resolution refuses instead of reviving stale
aliases. Legacy-only installations retain their existing behavior only while both registry and marker
are absent. A deliberate rollback therefore requires addressing the retirement marker as well as the
registry.

An error after publication can return `migration-publication-uncertain` while leaving a complete
registry in place. Inspect that target before taking another action. Registry and marker publication
are separate filesystem operations, not a crash-atomic cross-file transaction. The file and directory
`fsync` calls do not by themselves guarantee survival of a sudden power loss on every platform or
filesystem (notably macOS); a success response is not a power-loss durability guarantee.

Launch, restore and conversation-carry lookups use the native resolver's selected source. Enabled
Claude/Codex profiles retain their existing alias IDs, with backend-specific labels. A configured
invalid registry never falls back to legacy credentials. Disabled profiles are not offered for launch,
but their credential roots remain protected from document viewing. A carry resolves both accounts from
one snapshot; later registry edits apply to the next operation. This is not live checkpoint or arbitrary
same-user filesystem-race qualification. OpenCode/Pi profiles remain visible metadata without enabling
unqualified profile-aware launch or switching.
