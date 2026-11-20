# Session references contract

Behavioural contract for issue #138. Targeted checks do not establish complete product acceptance.

## Stories

### US-1: Explicit share references

As an agent using Mesh tools, I can explicitly mint a Notes share and have its confirmed reference attributed only to my live session.

1. Given a live token, explicit mint success creates one reference.
2. Given create_note success without share, no reference is invented.
3. Given target_present=false, the reference is pending-target, not a verified document.
4. Given upstream success and disk failure, caller receives upstream success and catalogue warning, with no replay.

### US-2: Durable isolated inspection

As the authenticated operator, I can inspect a session's references from Info after restart or explicit restore.

1. Same connector/upstream ID updates one entry; different connector is distinct.
2. A new incarnation reusing a name sees no previous references.
3. Exact explicit restore transfer preserves references; arbitrary History does not.
4. Confirmed revocation removes actionable URL; outage leaves ordinary terminal usable.

## Requirements / acceptance

- FR-1 / AC-1: Token determines live identity, not Notes authority. Default deny without a private operator grant for exact name/created/nonce and operation; endpoint/credentials never imply a grant. The worker rechecks the grant before forwarding. Reject caller identity/endpoint fields and owner token on the connector route. Notes tools exist only in separately opted-in `mesh-notes`, never `mesh-board`; old board wildcard approvals cannot include them. Adapter opt-in controls injection, not server authorization.
- FR-2 / AC-2: Private bounded atomic catalogue, deterministic dedup, strict stored schema, no unvalidated returned links.
- FR-3 / AC-3: Explicit create/replace/mint/revoke only. Parse Notes create/replace structured or text Outcome status independently of MCP isError: domain errors never become success; unknown/malformed outcomes are uncertain. No implicit publication or mutation retry. Preserve uncertain and partial outcomes. Reject noncanonical mirror-relative paths before mutation: empty, dot or parent segments, leading/trailing slash and backslash are unsupported.
- FR-4 / AC-4: Separate credentials, HTTPS except literal loopback HTTP, no redirects, bounded response/deadline and MCP initialization. Capability URLs not included in diagnostics or logs.
- FR-5 / AC-5: Exact incarnation lifecycle transfer/removal; no name/History inference. Every ordinary/exact creation records a nonce intent BEFORE launch, then binds target name/created. Knowledge is EMPTY-CONFIRMED only from a validated existing catalogue, explicit matching source entry and zero references; all other states are UNKNOWN or NONEMPTY and require transfer proof. Missing file/scope, empty replacement store, helper failure, corruption, legacy empty list or never-enabled claim never proves non-use. Unknown metadata does not block terminal creation when core journaling/host work: retain binding/offer/warning until authoritative completion. Retry never creates a second process. Durable artifacts_empty_confirmed=true permits helper-free completion; absence of that positive field is UNKNOWN, and legacy artifacts_required=false is not trusted. Core intent failure prevents launch; definite pre-send refusal withdraws intent, uncertain creation never does. Known-zero failure/retry is journaled too. Existing offer retention, missing/replaced-incarnation refusal, route separation and new-grant-after-restore rules remain.
- FR-6 / AC-6: Safe accessible EN/FR UI, external noopener/noreferrer links, no prefetch, stale-session responses ignored. Existing project-artifact auth unchanged.
- FR-7 / AC-7: A confirmed revoke clears every stored capability for the connector/upstream ID privately, without returning other-session contents or granting reads, even if its originally authorized caller ended during the request. Durably admit operations before forwarding; revoke commit fences all currently admitted generations. Older observations cannot revive the ID, including before its first observation. A fresh post-fence operation may confirm a genuinely reused ID; retained fences and per-reference generations still prevent old results overwriting it. Never silently discard fences at capacity.
- FR-8 / AC-8: Required completion accepts only native moved, already-moved (exact target provenance), or source-empty (explicit zero source entry), with catalogue_present=true from an existing valid locked read. Absence is UNKNOWN at both initial probe and completion, never a special initial no-feature proof. Bare booleans, unsupported/malformed results, missing/corrupt data, absent scope and helper failure remain pending. Catalogue v3 stores one bounded target provenance stamp, preserved through mutation. Both completion routes use the same gate. A positive initial empty proof is persisted as artifacts_empty_confirmed=true through binding/retry; legacy false requirement values/new-field absence do not bypass the gate. Operator confirmation must identify the exact old scope and preserve other data; no migration infers never-used from absence of a newly introduced marker.

## Design limits

Notes mint may precede target existence: keep pending-target state. Revocation outside Mesh cannot be discovered without upstream API support: show last observed state, never claim continuous availability. A lost upstream response is uncertain: do not retry. Restored references follow exact explicit Mesh transfer only. mcp-kit exposes a server, not a client: reuse its tool layer without claiming it supplies upstream transport.

## Checks

`tests/session-artifacts-review.test.ts` verifies grant, Outcome, restore, normalization and ordering contracts. Native tests cover all Notes Outcome error variants, account-wide revoke, fresh ID reuse and concurrent persistence. `tests/artifacts-actual-qa.test.ts` follows real app/PTY/Info/restart/restore flows; its lifecycle sequence runs once, while rendering is EN/FR × 1440/390.

`tests/session-artifacts-optional-restore.test.ts` covers corrupt/unreadable/missing-helper probes with empty and populated catalogues, preserved faulted bytes, durable binding through snapshot maintenance and cleared in-memory holds, completion-only recovery after operator-like repair, helper disappearance after a known-empty probe, no-file/no-helper behavior and failure of the core intent writer. Corruption is not automatically discarded to make restoration appear successful.

`tests/session-artifacts-transfer.test.ts` audits both completion paths: disappearance before dispatch and before native open, unknown-probe disappearance, replacement-store initialization, unproven false/true replies, committed move with lost receipt, explicit source-empty proof, exact known-empty binding/retry without a helper, and legacy unknown-intent recovery. Backup restoration retries the bound session without another creation call. Native tests assert missing file and missing scope are not empty proof, explicit zero scope is proof, and target provenance survives reads/observe/revoke for idempotent retry.

The knowledge-state matrix now includes disappearance BEFORE the probe, never-enabled/absent legacy installations, existing empty-without-source, explicit empty and nonempty records, corrupt/unreadable stores, unavailable helper, recovery during first completion, helper-free confirmed-zero retries in both modes and legacy required=false. A separate predicate table rejects legacy/untyped/numerically truthy attestations; native catalogue reads attest file/source presence atomically rather than synthesizing zero from absence.

Targeted executable tests accompany each invariant. Fixture transport checks do not establish live Notes/TLS compatibility or complete product acceptance.
