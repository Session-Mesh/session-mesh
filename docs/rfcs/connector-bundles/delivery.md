<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Atacama <contact@atacama.tech> -->

# Delivery, migration and conformance

Proposed workflows, not commands available today. The core invariant: adapter code can be
absent or replaced without losing artifact associations, restore bindings, uncertainty receipts
or revocation barriers. See the [contract](contract.md) and [evidence](evidence.md).

## Developer and operator flows

Develop an adapter against typed codecs and a fake host/provider. Declare actions, effects,
schemas, capability justification and UI messages before coding. Build OCaml executables or
TypeScript with an approved pinned runtime. Package each target with locked dependencies, SBOM,
licenses, exact file inventory, digest and provenance. `mesh connector check` would validate
schemas, views, runtime and inventory; `pack` would produce a deterministic archive when the
toolchain supports it. Record reproducibility results, do not assume them. Run relevant
conformance cases before distribution.

Distribute immutable release assets as offline archives plus digest/optional detached signature.
A static release catalog may advertise versions/platforms/digests; no executable catalog
content, registry daemon or dependency installation at load time. OCI can be a later transport.

| Step | Illustrative operation | Durable effect and boundary |
| --- | --- | --- |
| Inspect | `connector inspect ARCHIVE` | Show publisher evidence, digest, effects, requested permissions and isolation; execute nothing |
| Install | `connector install ARCHIVE --digest DIGEST` | Verify, extract and register immutable code; no activation, credentials, tools or network effects on provider |
| Configure | `connector instance create ID --bundle DIGEST` | Validate named endpoint/root/config locally; separately enroll any audience-scoped credential binding |
| Enable | `connector enable ID` | Set activation epoch, approved surfaces and bounded handshake, still no grants |
| Authorize | `connector grant ID …` | Explicit exact subject/action/resource/digest/account grant with expiry; separate from client tool approval |
| Use | Registered UI/MCP/plugin action | Verify caller and current target, authorize, admit, dispatch and report typed outcome |
| Disable/revoke | `connector disable ID` / `connector revoke-grant GRANT` | Fence future effects and subscriptions, drain or record uncertainty; no implied upstream revocation |
| Remove | `connector remove DIGEST` | Require inactive/unreferenced code and process settlement; no uninstall hooks; keep data/security evidence |

New agents see only explicitly selected host shims. Existing agents are not edited/restarted;
refresh discovery only where supported. A stale advertised tool cannot bypass host revocation.
Separate destructive data purge requires explicit scope, export and retention review; v1 should
not automatically purge revocation/dedup evidence. Local removal never revokes remote shares.

Persist immutable packages by digest, instance config/pointers/grants, durable admissions,
adapter-private state and core artifact/events independently. Use private validated stores with
transactional commit; for files, lock, sync, atomic rename and a durable multi-file intent.
Don't assume multiple renames are atomic. Corrupt/unsupported state is preserved and reported,
not rewritten as an empty default.

## Update, reload and rollback

1. Resolve/verify new digest before executing. Diff actions/schema hashes/effects, provider
   destinations, accounts, capabilities, isolation, view actions, source/event and state schemas.
   New code selection needs approval; suspend changed grants. Explicitly rebind reviewed,
   unchanged exact grants to the new digest—never infer consent from the same signer.
2. Stage candidate disabled. Run handshake in the requested profile without provider grants.
   Failed validation leaves the old generation selected. Developer reload follows the same
   generation fence; an unpinned tree is an explicit trusted development profile, not a release.
3. Quiesce old admissions, subscriptions and handles. Drain within bounds or record uncertainty
   for already admitted effects; retain capacity until cleanup is established. Do not replay
   old mutations in the new worker.
4. Snapshot only adapter-private state and migrate a copy using constrained core transforms
   or an isolated migration worker without grants/credentials/catalog access. Validate before
   switching. Preserve original bytes and schema metadata if migration is unsupported.
5. Journal old/new digest, config/state pointers, epochs and transaction phase. Atomically
   switch activation and state; deterministic crash recovery finishes or backs out pointers.
   New handles bind new generation. Restore source checkpoint or explicit gap, not false empty.
6. Keep old payload/state until pending receipts settle and rollback retention ends.

Rollback restores compatible **code and adapter-private state**, not old core grants, catalog,
fences, receipts or restore intents. If code cannot handle current state and there is no safe
reverse migration, leave the instance disabled and retain the data. Remote effects are not
undone. Compromised/revoked publisher keys block new activations and trigger quarantine per
policy; withdraw egress, stop workers, retain evidence, and rotate upstream credentials
separately if needed. Signature revocation is not credential revocation.

## Migration without loss or duplicate effects

**M-only starting point:** native Projects and Roster exist; PR158's Notes catalog is not
present in M [E5–E7]. Keep existing Roster bridge operational until equivalent adapters qualify.
**R-derived starting point:** read the exact published v1/v2/v3 catalog schemas, grants and
ordinary/exact restore intents; do not assume anyone deployed R.

1. **Freeze fixtures.** Pin M/R contracts, build synthetic golden catalogs and source snapshots,
   include corruption, missing file/scope, zero proof, fences, uncertain effects and lost
   transfer receipts. No production credentials or state required.
2. **Extract core behind compatibility routes.** Preserve token/Origin rules and native
   authority. Adapt the Artifacts store into generic core metadata, scope associations and
   account namespaces. Keep legacy Notes in a preserved legacy account namespace until explicitly
   mapped. Never infer account equivalence or absence of artifacts from missing fields.
3. **Translate and verify before switching.** Quiesce writers, preserve private original bytes,
   translate into separate versioned state, compare exact mappings, URL bytes, clocks,
   generations, fences, positive empty proofs and transfer stamps—not counts alone. Publish
   together with durable receipt and a single authority pointer. Before commit use original;
   after commit use translated state. Unsupported data remains unavailable, not discarded.
4. **Notes cutover.** Independently package its domain adapter; preserve separate `mesh-notes`
   compatibility actions/opt-in and exact tool restrictions. Verify legacy identity/nonce when
   importing grants, keep suspended until explicit new digest/config/account binding. Import
   credentials only through an approved host binding, never pass legacy env to workers. One
   activation epoch chooses the only mutating path. No dual writes or shadow mutations.
5. **Roster cutover.** Preserve native source IDs/revisions/CAS, selector/board version checks,
   scope, resource budgets, producer schema and digest. Create inert instance/source mappings;
   explicitly approve roots/tasks. Read-only shadow checks on same fixture snapshots compare
   normalized success/error/truncation. Preserve unsupported pipeline behavior [E7]. Remove
   legacy route/provider-specific rendering only after parity and a documented recovery window.
6. **Third fixture.** CI polling/events uses the same installer, dispatcher, grants, catalog
   and renderer, with no MCP, live session or Roster-specific branch. Revise contract if this
   requires a special case. No live CI integration implied.

After cutover, an old executable must not silently write obsolete schema or resurrect old
security state; keep backward-compatible readers or block incompatible downgrades. Preserve
metadata and journals if package deletion or provider outage occurs. Test configured and
never-configured deployments per starting point.

### Recovery rules

| Failure | Required recovery |
| --- | --- |
| Missing/corrupt catalog or absent exact source | UNKNOWN; preserve bytes; if core intent works, create terminal once with pending association |
| Positive source-zero proof | Completion may proceed without bundle/helper under the same exact intent |
| Move committed, response lost | Verify exact destination provenance; finish without another terminal or overwrite |
| Destination reused/missing | Refuse completion; do not retarget |
| Revoked before dispatch admission | No new effect; old generation/handle denied |
| Revoked after dispatch admission | Best-effort cancellation, retain possibly completed/uncertain effect |
| Confirmed revoke after caller ends | Commit private object/account barrier without exposing other sessions |
| Pre-fence result arrives later | Refuse resurrection; only fresh confirmed post-fence observation can supersede |
| Provider succeeded, catalog write failed | Success/not-recorded warning and bounded recovery receipt where writable; no replay |
| Crash after dispatch without result | Uncertain; read-only reconciliation or operator review, no duplicate send |
| Package removed or incompatible | Preserve metadata and core restore, hide unavailable actions/preview, no PTY restart |

## Conformance matrix

All tests are planned, not passed. Require negative and positive fixtures for every declared
profile; no silent downgrade to trusted-local. Use model traces for durable state where useful,
OS tests for containment, fake transports for protocol, and real-browser CSP tests for views.

| ID | Surface | Acceptance evidence |
| --- | --- | --- |
| C01 | Loader | Reject bad digest/inventory, links, traversal, collisions, duplicate fields and expansion overflow; no execution during install/remove |
| C02 | Versions | Unknown required capabilities, unsupported platform/runtime/isolation and schemas refuse without rewrite |
| C03 | State axes | Installed is inert; enabled handshake has no provider rights; credential-only request denies |
| C04 | Identity | Stale/reused session, nonce mismatch, slow body/await races and wrong owner/token route deny |
| C05 | Grants | Exact scope incl. effect/schema/account/digest; no wildcard inheritance; pre-dispatch revocation prevents send |
| C06 | Egress | No ambient token/env/descriptor exposure; wrong audience/destination/redirect denied; secret never worker-readable |
| C07 | Protocol | Partial/oversized or invalid frames, stdout noise, wrong initialization, stale generation and invalid scoped handles |
| C08 | Supervisor | Time/byte/CPU/memory/PID/queue bounds, hung or unsettled workers, fair instance failure; PTY and Projects remain usable |
| C09 | Isolation | Actual platform probes deny direct network, private host data, unauthorized writes and escape from agreed roots |
| C10 | MCP stdio | Bounded initialization/calls, server requests rejected by default, death does not replay mutations |
| C11 | Streamable HTTP | JSON and SSE, headers/version, expiry, cancellation vs disconnect, bounded resume; 404 reinit does not replay |
| C12 | Notes | Closed path/schema/Outcome validation, pending-target, no implicit share, unsafe links refused, malformed post-send uncertainty |
| C13 | Receipts | Pre-send vs post-send faults, same-ID dedup, changed-input refusal, crash-after-dispatch, success/not-recorded |
| C14 | Artifacts | Account and scope isolation, shared verified account revocation, authorized opens and safe previews |
| C15 | Revoke | Delayed results, revoke-before-first-observe, ended caller, ID reuse, bounded fences persist through removal |
| C16 | Lifecycle | Both restore modes; missing/corrupt/unknown/positive zero/nonempty; lost move receipt; replaced target; one creation |
| C17 | Roster/source | Selector/schema/revision invalidation, root boundary, unsupported pipeline and unknown/truncated output |
| C18 | Events | Duplicate, restart, out-of-order, gap/overflow, expiry and grant/revision change; no trigger authority |
| C19 | UI | Hostile text/HTML/URLs, no remote code/prefetch, protected targets, stale actions, EN/FR/mobile/keyboard |
| C20 | Update/rollback | Crash each phase; failed candidate preserves old; no rollback of grants/barriers/receipts; exact approval diff |
| C21 | Remove/reinstall | No scripts or remote-revoke implication; retain metadata/fences/intent; no stale handles or implicit rebinding |
| C22 | Data import | Exact v1/v2/v3 association/URL/fence/stamp parity; unknown schemas/corrupt bytes remain intact |
| C23 | Genericity | Notification pilot, Notes, Roster and fixture CI share dispatcher/loader; no provider-specific core branch |

## Increments and stop conditions

| Increment | Gate |
| --- | --- |
| 0. #204 notification and additive view pilot | Committed event, separately authorized target, durable dedup, no comment rollback; develop/reload without enabling before hooks |
| 1. Core identity/admission/artifact recovery | Legacy routes and source parity; stop on any weaker revocation/empty/restore behavior (C04, C13–16, C22) |
| 2. Offline executable bundle lifecycle | Immutable install, activation/grants, versioned worker and qualified profile (C01–09, C20–21) |
| 3. Notes extraction | C12–16, C19; clearly label JSON-only MCP compatibility until C11 passes |
| 4. Roster extraction | C17, C19, C22; read-only fixture parity before switch |
| 5. CI source/event fixture | C18 and C23; revise any overfit before freezing v1 |
| 6. Distribution and deprecation | Supported platform table, conformance kit, explicit update/rollback; independent trust-boundary review before enabling by default |

The first pilot does not need bundle distribution, third-party OS containment or broad hooks
all at once. Keep legacy compatibility until gates pass. MacOS and Linux qualification are
separate; platform absence is a limitation, not permission to lower a required profile.
