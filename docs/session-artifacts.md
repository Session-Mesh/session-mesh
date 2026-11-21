# Session Artifacts and Notes

The **Artifacts** button inside a live session's **Tools** menu opens a catalogue
of confirmed connector references. It does not copy note contents, scan conversations,
fetch share links or widen the separate Projects/Roster artifact permissions.

## Attach session tools to a local project

Choose **Tools → Project attachment**, select a **local Mesh project**, then explicitly
attach or detach the session. This uses the native project registry, not tracker/worklog
projects; names or IDs from those separate registries are never matched implicitly.
The native workspace (**Projects → Old view**) shows the attached session Tools menus without requiring a Roster
observation. The reference records the project, machine ID, exact session name and creation
time. It contains no share capability or Notes grant.

Attachments are owner-authored metadata, not evidence that a terminal is live. Opening
Artifacts still resolves the exact live incarnation through Mesh. An offline host or a
same-name replacement cannot turn the recorded reference into access to another session.
Missing machine identity and incomplete owner reads stay unavailable, never an empty or
live-session claim. References are not rebound automatically after restore; explicitly
reattach the restored incarnation when appropriate. Artifact catalogue transfer itself
continues to use the separate restore completion proof described below.

Attachment changes use the existing native revision checks and request receipts. A lost
save response is uncertain: **Check uncertain save** reads its receipt without replaying
the mutation. Confirmed changes and recovered receipts invalidate and reread the owning
workspace projection; a detached row is not left active until navigation. Valid legacy
projects with no session field can receive their first attachment. Bounded omissions stay
unavailable rather than being interpreted as an empty field.
Changing the selected project discards old read results, and changing the
workspace project invalidates a dialog opened from its old context. Session/project
attachment never transfers, creates or broadens Notes permissions.

## Configure Notes explicitly

Set these variables in the **web server's** user-managed environment, not in an agent's
project configuration:

- `MESH_NOTES_MCP_URL`: the exact Notes MCP endpoint, for example
  `https://notes.example.invalid/mcp`. HTTPS is required except for literal loopback
  HTTP endpoints. URL credentials, queries, fragments and redirects are not accepted.
- `MESH_NOTES_TOKEN_FILE`: absolute path of a private, user-owned, regular file containing
  the separate Notes bearer credential (mode 0600; no symlinks or hard links).

Mesh does not obtain credentials from an assistant-side MCP connection, perform OAuth
enrollment, or configure the Notes service. Notes remains independent. Do not place these
credentials in agent MCP definitions. Configuration alone grants **no Notes authority**.

Set `MESH_NOTES_ADAPTER=1` explicitly in the web server's environment to inject the
separate **mesh-notes** server for newly launched agents. It registers
`notes_create_note`, `notes_replace_note`, `notes_mint_share` and `notes_revoke_share`.
Notes tools are absent from mesh-board, so existing board wildcard approvals do not
include them. Existing disable/approval restrictions remain; no automatic approval rules
or persistent agent configuration are added. Adapter opt-in is not a server grant.

The operator must separately maintain `notes-grants.json` in Mesh's private configuration
directory, as a private user-owned regular file (0600, no symlink/hard link):

```json
{"version":1,"sessions":[{"name":"example-session","created":1234,"nonce":"LIVE_NONCE_FROM_TRUSTED_HOST","tools":["mint_share"]}]}
```

Replace identity fields with the exact live incarnation from trusted host state, never
from an agent's request or text. Each operation is explicit; wildcards are unsupported.
Missing, malformed, unsafe or mismatched grants deny before upstream execution (403),
including when credentials exist. Use atomic replacement for updates. The worker checks
the grant again before execution. Grants do not transfer on restore: a new incarnation
needs a new operator grant. Withdrawing a grant prevents new operations, but cannot undo
an already authorized in-flight mutation. Ordinary Mesh works without a connector.

The built `mesh-board-mcp` also supplies its internal `--artifacts-worker` mode, so release
packaging needs no extra runtime. A source build uses its corresponding dune executable.
`MESH_ARTIFACTS_CMD` can select an explicit user-managed standalone helper for tests;
it must be an executable path, not a shell command.

Native worker operations also decide admission generations, observation/revocation recording,
and source-empty/restore-completion evidence. The existing Python bridge retains HTTP limits,
session authentication, live-host rechecks around awaited work and restore journal integration;
it is a compatibility boundary, not a second implementation of connector policy.

## Sharing and outcomes

Creating/replacing content **never mints a share**. Only an explicit successful mint
produces a catalogue observation, keyed by connector plus stable upstream share ID.
`target_present=false` is displayed as a minted share whose target was absent, not as
an existing document. URLs must match the configured Notes origin. Last observed presence
is not a continuous availability guarantee: out-of-band revocation or deletion is not
discovered automatically. Confirmed connector revocation clears matching capability URLs
across all sessions privately, without exposing another session's data to the caller.
Durable admission generations fence delayed pre-revocation observations. A fresh operation
admitted after the revoke may confirm a genuinely reused ID; old results remain fenced.

Create/replace parse Notes' domain `status: ok/error` independently of MCP `isError`.
An upstream domain error is not success; malformed/unknown outcomes are uncertain.
Malformed share results or unconfirmed revocation payloads are also uncertain, not
successful operations or catalogue observations; unsafe returned links are not relayed.
Paths must be canonical mirror-relative paths: no empty, dot or parent segments,
leading/trailing slash or backslash. Unsupported spellings are refused before mutation.

HTTP JSON MCP initialization, initialized notification and one explicit operation run
under a 25-second total deadline with a 1 MiB response bound. The first version supports
Notes' JSON HTTP transport, not SSE streaming, multi-round interactive tools or automatic
OAuth negotiation. Upstream errors are deliberately generic to avoid logging capabilities.
Mesh's session token is never sent to Notes.

An upstream success plus local recording failure returns `status: success` and
`catalogue: not-recorded`, with the successful upstream result and a warning. Do **not**
replay creation or minting to repair local recording. A lost response/interrupted helper
is `uncertain`; it does not prove that Notes did nothing. There is no automatic mutation
retry. Ordinary terminal actions are independent of connector networking.

## Persistence and lifecycle

`session-artifacts.json` under Mesh's private configuration directory holds reference
metadata and sensitive capability URLs. It is bounded to 256 exact session incarnations,
128 references each, 4096 revocation fences, and 4 MiB total. Catalogue v3 reads/migrates
v1/v2 atomically on mutation and adds one bounded transfer-provenance stamp per target.
Writes use a cross-process lock, synced private
temporary file and atomic rename. Bounds/corruption fail closed rather than silently
overwriting unrelated references.

An incarnation is the verified live `(name, created)` pair, not a caller argument. New
sessions reusing a name inherit nothing. Explicit restore transfers exactly the offered
old incarnation to the newly created one, without replacing an existing destination.
Restart reads the same private catalogue. Explicit removal/discard attempts exact cleanup;
unavailable cleanup never prevents stopping the terminal. References following arbitrary
History conversations into another session are not supported. Back up the catalogue as
private data along with other Mesh configuration; never publish it as a project artifact.

Every ordinary or exact restore writes a durable nonce intent before creating a shell,
then binds its target name/created identity before transfer. Transfer/binding failure keeps
that intent and the old offer. Repeating the original ordinary restore completes only the
bound live incarnation, without another shell; if absent/replaced it refuses. Exact-mode
restore stays separate. No-reference knowledge must be affirmative, not inferred from absence.

An unreadable/corrupt catalogue or unavailable helper cannot, by itself, prevent ordinary
terminal restoration. A failed probe is **unknown**, not an empty catalogue: Mesh writes the
same durable intent before creation. If transfer is still unavailable, the terminal exists
and the response retains an artifact warning and old offer. Mesh never resets unreadable
catalogue bytes. Repair the private catalogue from a trusted backup or restore the helper,
then repeat the original ordinary restore to complete only the bound incarnation, without
another process. Missing/replaced targets refuse; existing offer-retention limits still apply.
If the probe and transfer recover within the first request, completion can finish normally.

Only an existing validated **source record explicitly containing zero references** proves
no transfer is needed. An empty catalogue without that source is not proof. No catalogue
file plus no helper is UNKNOWN, even on a never-enabled or legacy installation. The terminal
is still created with a durable completion binding; its warning and old offer can remain
until a trusted backup or explicit operator confirmation provides proof. Optionality means
usable terminal creation, not automatic disappearance of the offer. Failure of the core
intent writer is different: creation stops before launch because retry cannot be safely bound.

| Restore knowledge | Creation and completion |
|---|---|
| Never enabled by assertion/configuration, absent file or absent source scope | UNKNOWN: create once with journal; retain completion-only recovery |
| Corrupt/unreadable data or unavailable/old helper | UNKNOWN: same; never reset data |
| Existing validated exact source record with references: [] | EMPTY-CONFIRMED: journal creation; transfer/helper may be skipped |
| Existing exact source record with references | NONEMPTY: journal creation; require atomic transfer proof |
| Disappearance before/during probe | UNKNOWN, not an empty default |
| Disappearance after nonempty/unknown probe | Keep binding/offer/warning until backup reinstated |
| Disappearance after positive source-zero proof | Persisted confirmation remains usable; no old data was declared absent by inference |
| Earlier committed move, lost completion response | Verify exact target provenance and finish same session |
| Legacy intent or artifacts_required=false alone | UNKNOWN: old false may have been inferred from absence |

Every ordinary and exact creation is journaled, including confirmed-empty cases. Binding
preserves artifacts_empty_confirmed=true only when positively established. Missing new
metadata never implies never-used. There is no new global never-used marker inferred from
its absence. Known-zero completion failure can therefore retry without a helper or another
process. Definite pre-send refusals withdraw the intent; uncertain creation remains bound.

Required transfers do not treat `transferred: false` as success. Completion accepts only
an explicit native `moved` result after atomic publication, `already-moved` from exact target
provenance, or `source-empty` from an explicit zero-reference source entry. All proofs require
an **existing valid catalogue** read under its lock. Missing file or missing source entry is
unknown: even a valid replacement store initialized by another operation is not zero proof
for old data. A move atomically records the source identity on the target; reads, observation
and revocation preserve this stamp. Retry can verify that earlier move without moving again.
Unsupported/bare boolean replies remain incomplete until a coherent helper supplies proof.

Both ordinary and guarded/exact completion apply this rule. Restore persists positive
source-zero evidence and keeps it when binding the created incarnation. A confirmed-empty
restore works without an optional helper on completion retry. Legacy intents lacking evidence remain conservative if the catalogue
is absent; restore a trusted catalogue backup, then repeat completion. If independently
confirmed that the old scope has no references, the operator can restore an explicit source
entry with that old name/created identity and `references: []`, preserving all other data.
Do not infer this from a missing scope or replace unrelated entries. The terminal remains
created; never recreate it to repair association. Old helpers rejecting v3 fail safely;
use coherent web/helper versions to complete recovery.

External share links use `noopener noreferrer` and no-referrer, are never embedded or
prefetched, and remain sensitive even when the secret is in the URL fragment. Do not
copy capability URLs into logs, public reports or screenshots.
