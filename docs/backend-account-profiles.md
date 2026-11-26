# Native account-profile contract

`mesh-profile` validates profile metadata, registers aliases and manages confirmation preferences. It does not launch an
agent or switch a running session. On Linux, the web server can switch a Claude or Codex session between
native profiles when its PTY host supports bound in-place relaunch. The owner must approve each request.
macOS, Pi and OpenCode native-profile switches remain unavailable.
Pi sessions without a selected profile retain their existing behavior. Selected Pi profiles are not
offered for launch: launch and restart requests are refused before changing the session, and a
refused restore leaves its recovery offer available. Profiled Pi support remains incomplete until
its running conversation identity and safe restart can be established reliably.

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

## Root roles and launch selectors

These fields describe the intended native layout. `mesh-profile` itself does **not** set any
environment variables. The runner resolves one enabled `(backend, id)` through
`mesh-platform accounts launch-context FILE BACKEND ID [EXPECTED_CONTEXT_REVISION]`: this prepares and validates only
that profile's declared roots, then returns its root selectors, inherited-variable removals
and context/registry revisions
from one native snapshot. With an expected revision, it refuses a changed profile before creating
any roots. The legacy grouped `accounts prepare` output remains unchanged. Host-private
`accounts list` additionally returns closed, metadata-only `launch_profiles` entries
(`backend`, `id`, `label`) for enabled native profiles. `/api/config.accounts` exposes their
availability as `claude`, `codex`, `opencode`, and `pi` booleans; the OpenCode label remains keyed
`opencode-v2` in `backend_labels`. The Pi availability boolean is currently always false, even when
an enabled Pi profile exists. No profile root is exposed.

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

### Selected-context preflight seam

The OpenCode command builder accepts an explicit environment snapshot. Its version/configuration
probes and resume-existence check use that same context; finding a conversation in the ambient
store cannot admit a resume under another profile. Pi's overlay builder likewise accepts an explicit
environment and reads only that context's agent directory. Its version probe receives only its
search path, home and selected Pi directory, not Mesh or provider credentials.

These are internal adapter inputs, not browser-supplied environment maps. A selected launch
passes the same resolved environment to the preflight and the command sent to the terminal,
through an `env` wrapper because the PTY host forwards only `MESH_*` variables. The wrapper
removes known inherited provider overrides; OpenCode also removes inherited database and configuration
overrides. The Pi adapter can pass a selected `history` as `--session-dir` and look up a transcript
inside that root for `--session`; these adapter capabilities do not enable profiled Pi launches or
restarts. HOME stays the
runner's HOME: profiles have no HOME role. Existing unselected callers retain their ambient
behavior. A restored selected session needs its stored context revision; older offers without
one and changed revisions refuse before a resume. This does not transfer conversations or
establish an interactive checkpoint.

Running OpenCode sessions under a selected profile do not take their conversation identity
from ambient transcript/database discovery: until a profile-root-specific discovery reader is
available, discovery-only identity is unknown. OpenCode hook reports may still identify a running
conversation; a restart checks its ID against the selected store. This limits automatic
resume/restart for selected sessions that have no trustworthy hook or persisted identity.

## One-shot protocol

The default invocation reads one bounded JSON request from stdin and writes one versioned JSON line.
All objects use closed schemas: unknown or duplicate fields refuse. Operations are `profiles.list`,
`profiles.resolve`, `consent.get`, `consent.set_global`, `consent.set_pair`, `consent.remove_pair` and
`consent.reset` and `profiles.create`. No operation executes a switch.

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

First alias creation writes a separate, durable typed create intent before linking
the complete staged registry without replacing another writer's target. On
success, it removes the staging link and intent. Once an intent exists, a failed
create does not discard its recorded stage. Run `mesh-profile recover-create`
**explicitly on the host** after an interruption; it never creates a registry,
retries the request, or runs through HTTP. Under the migration lock it checks the
intent, recorded stage/inode and exact bytes, unchanged empty legacy source and
absence of migration/retirement state. If the target is absent and the exact
private single-link stage is still present, it retires the intent and syncs the
directory **before** optionally cleaning only that stage's inode and syncing
again. It reports `unpublished-aborted`: a new alias requires a **new explicit
request**. Interruption after intent retirement can leave an
inert private orphan stage, never a pending intent with both stage and target
absent. Such an orphan alone is not recovery evidence and is not automatically
used to publish. If the target is present, it verifies the
one- or two-link publication, removes only its recorded staging link if needed,
then retires the intent and reports `published-reconciled`. Ordinary reads reject
the two-link target
until this reconciliation. Missing stage **and** target, mismatched evidence or
changed source remain blocked for manual inspection; the command never infers
publication from a name or matching bytes alone. The legacy migration intent is
separate and cannot be reconciled by this command.

A successful `profiles.create` reply reports a completed native creation or
append, not a successful subsequent settings read. If that read-back fails,
Settings preserves the draft, labels the state as **verification pending** and
requires an explicit refresh to inspect the authoritative listing; it does not
call the write "not saved" or send it again. A
`profile-publication-uncertain` response does not confirm publication at all:
the alias **may already have been registered**, so inspect the listing rather
than retrying automatically. Neither case is the host-only recovery command.

## HTTP routes

The web server binds seven routes to the transport mode, one operation each. Nothing else is
exposed through these routes: `profiles.resolve` (its reply holds folders) and every switch stay on the host, and the
path chooses the operation, never the body.

`GET /api/config` advertises `capabilities.account_settings: true` for this binding. Clients must
hide the settings entry when that explicit capability is absent or false; it is not a PTY-host or
live-switch qualification flag.

| Route | Operation |
| --- | --- |
| `GET /api/accounts/profiles` | `profiles.list` |
| `POST /api/accounts/profiles/create` | `profiles.create` |
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
  digest `context_revision` and `switch_qualified` false in the helper response; the server projects
  the flag from the availability of a compatible live session and PTY host. For every `consent.*` operation, the
  policy (`version`, an integer `revision`, `global` and `pairs`, each pair with its
  `confirmation` and its two accounts' known `backend`, `id` and digest `context_revision`, both
  accounts of one backend with two different ids). An `id` is what the helper accepts: 1 to 32
  characters among `a`-`z`, `0`-`9` and `-`, and not `default`. The label is relayed as the
  helper gives it; the helper checks it when it reads the registry.
- **A failed write.** A `503` on a write does not say whether the helper committed the change.
  Re-read the corresponding authoritative state (`GET /api/accounts/profiles` for creation,
  `GET /api/accounts/consent` for preferences) before any new explicit edit.

The server runs `mesh-profile --http <operation>` as an argument vector, never through a shell, in
its own process group, with an environment of `MESH_CONF_DIR` (the server's configuration folder,
so the registry and the store sit beside `accounts.json`), `PATH=/usr/bin:/bin` and `LANG` only.
At most four run at once. The program is `MESH_MESH_PROFILE_CMD` when set (an absolute path to an
existing file, else none), otherwise `mesh-profile` in `MESH_BIN_DIR`, or in the opam switch's
`bin` when `MESH_BIN_DIR` is unset.

The consent routes change preferences only; profile creation registers an alias. None switches an account, and in this version a
session's request to change its account is always put to the owner, whatever the global or pair
preference says: the session-action path does not read the consent store.

### Register an alias

`POST /api/accounts/profiles/create` uses the same owner-cookie/origin checks, JSON body bound,
helper process isolation and fail-closed reply decoder as the routes above. Its closed body is:

```json
{"registry_revision":null,"profile":{"backend":"claude","id":"work","label":"Work",
 "roots":{"config":"/existing/claude","history":"/existing/history"}}}
```

`registry_revision` is `null` only for a first registry, otherwise the exact digest returned by
`profiles.list`. `profile` contains exactly backend, id, label and roots; the native helper sets
`enabled: true`. The root roles are exactly those in the table above. A successful reply has
`registry_revision` (new digest) and `profile` (the same six public fields as a listing), **never
roots**. The UI refreshes the list after validating this reply and leaves the form intact on a
conflict, refusal or uncertain result; it never retries a write. The route does not collect
credentials, log into a provider, create agent directories, modify preferences or switch sessions.
Sign in separately through the native CLI. A label is not evidence of sign-in.

The settings action **Associate an existing configuration** uses this operation.
The native helper separately accepts `profiles.provision` in its host-only one-shot protocol:
`{"version":1,"op":"profiles.provision","registry_revision":null,"profile":{"backend":"codex","label":"Work"}}`.
Use the current registry revision instead of `null` for an existing registry. This operation allocates
the runner's private directories and records a **disabled** profile; it does not start an agent,
check a sign-in or expose the profile in New session. This host-only maintenance operation is
distinct from the capability-gated HTTP path below.
It rejects Pi, paths and caller-chosen IDs. A failure after allocation can leave unpublished
directories; neither profile reads nor `recover-create` adopt or delete them. For a witnessed
first write, `mesh-profile recover-create` either retires the unpublished stage or reconciles the
already published inode; it never publishes a stage. For an interrupted append, explicitly re-read
`profiles.list`: the surviving registry is authoritative. First-write recovery does not interpret
an append stage. Recovery refuses contradictory legacy switch evidence under the registry lock
without retiring the intent or stage. Do not replay the original request or discard an orphan based
on its name; review the current revision, rows and retained evidence before any new explicit request.

In the provision panel, read-back uses only the registry and never reads consent.
A validated receipt can be confirmed against its exact revision and profile; without a receipt,
neither an unchanged registry nor a plausible new row identifies the request. The panel blocks
further provisioning, including after capability loss and a reload in the same browser and origin.
Each opening of Accounts discards the previous creation offer and reads the current capability.
Refreshing the capability does not clear the journal. **Associate** is a separate explicit registry
write using the inspected revision, and its receipt cannot settle a creation journal. This browser hold does not
replace host recovery, is not a cross-client custody record, and cannot interpret a host recovery
without evidence linking that recovery to this request.

Provisioning also retains a runner-side intent until it is explicitly acknowledged. This includes
requests from older clients that do not send an operation ID: even after a success response, a
later profile write is refused until the owner opens Accounts, inspects the retained provisioning
result and confirms it. The owner can then issue a new request after reviewing the current registry.
An old client cannot perform this acknowledgement itself. A server cannot distinguish a delivered
response from one lost after publication, so it must not retire this evidence merely on return.
The inspection and acknowledgement routes are owner-only; neither automatically replays creation.

### Managed first launch

The owner-only, same-origin `POST /api/accounts/profiles/provision` accepts precisely a
`registry_revision` and `profile: {backend, label}`. The browser learns the admitted backends
from `/api/config`, but cannot grant eligibility: the native helper checks its own capability
before allocation and again before publication. The distributed helper admits **none**. A
successful, admitted creation records a managed profile in the same registry write that
publishes its private directories. It neither opens a PTY nor checks sign-in.

Beyond the owner-cookie and same-origin account routes, the server permits exactly two native uses:

- Owner-cookie `GET /api/config` invokes `--http profiles.provision-capabilities` with `{}`.
  This read-only discovery projects only admitted backend tags and public profile metadata.
- The managed branch of `POST /api/new` invokes private `profiles.managed-launch` with a closed
  `(backend, id, context revision)` reference. The dispatcher validates that reference and builds
  the private request itself. The server uses the result only for the explicit
  launch; the private executable and roots do not enter the HTTP response. Ordinary starts,
  resume and switch cannot use this resolver.

The managed option in New session sends `managed_profile: {backend, id, context_revision}`.
The server gets the private executable and roots from a fresh native check, revalidates
the same context before PTY admission, and refuses a missing or changed binding. No command,
paths or fallback account can be supplied on this path. Ordinary aliases, resume and account
switch cannot resolve a managed entry through the legacy resolver. An explicit connection
command is not offered. The browser acceptance test uses a separately built, non-installed
helper with only the capability module substituted and a known synthetic executable.

The native writer checks the whole candidate registry and existing directory custody, serializes
with explicit host migration under the permanent registry lock, requires the exact authored-byte
revision, stages and syncs a complete private file and publishes a first registry without
clobbering a target. An append replaces only the checked existing registry; source `accounts.json`
and any retirement marker are left unchanged. Existing real legacy aliases without a retirement
marker require the host-only `mesh-profile migrate` first; a missing migrated registry, corrupt
registry or unresolved migration intent is not a fresh installation. A stale digest, duplicate ID
or migration-required state yields a path-free 409 refusal. No same-user out-of-band filesystem
race or sudden power-loss durability guarantee is implied by this mechanism.

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
Migration and recovery hold a nonblocking advisory lock on the stable, private 0600
`.backend-profiles.lock` throughout validation and final cleanup. A simultaneous caller returns
`migration-busy` without changing the source or target; a later caller sees the completed target
as `migration-target-exists`. Do not remove the lock file: its stable inode prevents two callers
from locking different files. An unsafe lock file refuses with `migration-unsafe-configuration-root`.
The lock is process-scoped; the host-only CLI runs one migration per process and does not qualify
parallel calls to the migration library within the same process.
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
same-user filesystem-race qualification. Enabled OpenCode profiles also admit backend-qualified
launches; their live switches are not qualified. Pi profile metadata can be managed, but selected
Pi launches and restarts remain unavailable, and refused recovery offers are retained.

The browser terminal opts into `acknowledged_input_v1` when the live inventory
advertises it for this session. The attachment is bound to its current `created`
incarnation and an opaque attachment ID. Cached rows cannot select a legacy
attachment, and a failed ACK handshake does not switch it to raw input. This is a
transport receipt: the native host queues each bounded, sequenced input frame
before acknowledging it. The browser keeps bytes until that ACK, requires human
review after a rejection or uncertain disconnect, and cannot send raw `D` on
an opt-in attachment. A legacy attachment still works while unfenced, but
prevents switch-input acquisition. The host waits for queued/in-flight PTY writes
and dirty human leases before acquisition; an existing negotiated attachment
cannot submit bytes through a held fence. Strictly recognized terminal-only
focus, mouse and query replies are still queued and ACKed without creating or
clearing a human draft lease; mixed human bytes are not exempt. This does
**not** inspect a native
composer, queue, dialog or tool; it is not a checkpoint or live-switch receipt.
For an approved Linux Claude/Codex switch, the request binds the conversation, both profile contexts,
and the foreground process identity. The host verifies the process before each signal. A successful
switch preserves the terminal and resumes the copied conversation in the target account. A failed
carry resumes the source only while its context remains verifiable; an uncertain stop is reported for
inspection and is not replayed automatically. The process check and signal, and the final directory
check and launch admission, are separate operations rather than atomic guarantees.
