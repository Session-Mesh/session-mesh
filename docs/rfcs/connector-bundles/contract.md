<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Atacama <contact@atacama.tech> -->

# Proposed bundle and host contract

This is a concrete reference for review, not an implemented API or final JSON Schema.
Generate closed codecs/schemas and qualify them before freezing v1.

## Package and versioning

First distribution format: an offline-capable `.mesh-connector.tar.gz` containing:

```text
manifest.json
files.sha256
bin/<platform>/adapter
schemas/*.json
views/*.json
i18n/en.json
i18n/fr.json
LICENSES/*
provenance.json
```

Illustrative Notes subset:

```json
{
  "manifestVersion": 1,
  "id": "org.example.notes",
  "version": "1.0.0",
  "hostApi": {"major": 1, "minMinor": 0},
  "execution": {
    "kind": "executable",
    "entrypoints": {"linux-x86_64": "bin/linux-x86_64/adapter"},
    "isolation": "brokered-isolated"
  },
  "capabilities": ["upstream.mcp/1", "artifacts.propose/1"],
  "actions": [{
    "id": "org.example.notes.mint_share",
    "inputSchema": "schemas/mint-input.json",
    "outputSchema": "schemas/mint-output.json",
    "effect": "mutation",
    "upstream": "notes",
    "upstreamOperation": "mint_share",
    "hooks": [],
    "requiresConfirmation": true,
    "idempotency": "none"
  }],
  "upstreams": [{
    "id": "notes",
    "protocol": "mcp",
    "profile": "notes-json-http/1",
    "operations": ["mint_share"]
  }],
  "contributions": {
    "tools": [{"id": "notes_mint_share", "action": "org.example.notes.mint_share"}],
    "artifactTypes": [{"id": "note-share", "renderer": "external-link/1"}],
    "projectSources": [],
    "events": [],
    "views": ["views/shares.json"]
  },
  "limits": {"maxInFlight": 2, "deadlineMs": 25000, "maxFrameBytes": 1048576},
  "state": {"schemaVersion": 1, "migration": "none"}
}
```

Strict UTF-8 JSON; reject duplicate/unknown keys, unsafe numbers and unbounded nesting.
Reverse-domain ID is an identifier, not proof of publisher control. Host registry reserves core
action IDs; plugins cannot replace/shadow them or another plugin's actions.
Separate package semver, manifest major, host API major/minor, capability versions, provider
schema/digest and private-state version. Reject unknown mandatory capabilities, unsupported
platform/runtime/isolation and incompatible major. Optional capability loss must be declared
and cannot silently change an action's effect or confirmation semantics.

Schemas and views are local bounded data files, with no remote references or evaluation code.
Include operation semantics/effects and schema hashes in the authorization fingerprint.
Runtime registration must match the installed manifest; discovery cannot expand tools or grants.

## Integrity and provenance

`files.sha256` covers manifest, binaries, schemas, views and provenance, excluding itself and
detached signatures. Verify exact inventory, including absence of extra files. A resolved archive
digest identifies immutable bytes. A detached signature signs a domain-separated statement
binding connector ID/version, archive digest and inventory digest; do not embed a self-referential
archive signature.

Provenance records source revision/URL, build recipe/toolchain/dependency digests, target,
license/SBOM and builder claims. Self-asserted provenance is not verified attestation. Trust policy
separately decides allowed publishers/builders and key rotation/revocation. A checksum from the
same untrusted download location does not authenticate a publisher.

Reject traversal, absolute/NUL/duplicate/case-colliding paths, links, devices, excess files,
decompression bombs and executable escapes. Extract privately, verify before execution, sync
and atomically publish into content-addressed storage. No install/postinstall/uninstall scripts.
Record retrieval source, resolved digest and explicit trust decision; mutable tags/catalog
entries are discovery hints only. Signatures do not constrain runtime behavior.

## Independent installation, activation and authority

- **Installed:** verified immutable code, no execution, provider contact, tools or grants.
- **Enabled:** instance selects a digest/config and permitted contributions; isolated handshake
  may run, but provider calls remain denied.
- **Authorized:** separately persisted grant permits exact actions/subjects/resources/account
  bindings. Credentials, configuration and MCP client approvals are not Mesh grants.

Effective authority intersects manifest request, supported capabilities, platform enforcement,
instance config, operator grant, authenticated subject, resource restriction, current epochs
and any per-call confirmation. Keep dedicated connector MCP namespaces: adding tools must not
expand an old wildcard-approved board surface [E2].

An update changes the approved code digest and requires explicit update acceptance. Changes to
endpoint/account/root/schema/effect/capability semantics suspend affected grants. Carry-forward
of unchanged exact grants is an explicit recorded decision, not an inference from signer/semver.

## Wire boundary and host services

Plugin-host protocol: bounded newline-delimited UTF-8 JSON-RPC on stdio, version
`mesh-plugin/1`. It is not falsely advertised as standard MCP. Use a dedicated inherited private
IPC descriptor for host service calls, or equivalently framed bidirectional IDs without
reentrancy ambiguity. No stdout logs; bound/redact stderr. All channels share aggregate budgets.

Handshake negotiates host API version, manifest digest, instance, capability subset, effective
limits and random process generation. Compare action/schema registrations to the manifest.
Handshake must not access providers or credentials. Shutdown drains within a bound, then
terminates the containment unit. Old-generation handles become invalid.

The shared action dispatcher remains the public entry point [#204]. Adapter protocol methods:

| Method | Core supplies | Adapter returns |
| --- | --- | --- |
| `action.prepare` | Invocation handle, action, validated input, service handles, deadline | Fixed provider request plan, no side effect |
| `action.interpret` | Same invocation and bounded provider receipt | Typed outcome, optional observation/revoke proposal |
| `source.collect` | Approved source handle/revision, selector subset, checkpoint | Bounded typed snapshot |
| `events.poll` | Approved subscription/checkpoint/limit | Bounded batch, next checkpoint, explicit gap |
| `health` | Process generation | Protocol liveness only |

Core executes each admitted mutation plan **at most once** through a restricted service handle.
Do not give a mutation grant an unlimited worker `fetch()` loop. Multi-step mutations require
separate approved receipts or a later reviewed transaction capability.
The host validates the exact operation/template and its final arguments against the grant's
resource envelope. An adapter's claim that a request is read-only is not evidence: known MCP
tools/HTTP templates are approved explicitly with their effects, and unknown effects cannot be
admitted as reads. Reject plans whose final resource cannot be checked by the host.

| Host capability | Enforced scope |
| --- | --- |
| `actions.invoke/1` | Registered action, plugin caller, fresh independent grant; no inherited trigger authority |
| `events.subscribe/1` | Named committed events, permitted fields, sources/targets, cursor and retention |
| `upstream.mcp/1` | Named configured upstream and exact tool/resource methods/schemas |
| `upstream.http/1` | Named request template, encoded parameters, bounded response; no arbitrary URL |
| `source.files/1` | Read-only opaque snapshot/root handle and canonical relative selector |
| `state.private/1` | Bounded instance-local versioned CAS data; no catalog/grants/credentials |
| `artifacts.propose/1` | Result proposals bound to admission; core validates/commits |

No general shell, exec, secret-read, registry-write, lifecycle-transfer or grant-management host
method. A Roster producer is a packaged/pinned worker dependency reading approved data, not an
arbitrary executable path supplied by a caller. Use a read-only snapshot where live traversal
cannot guarantee the intended race boundary; string prefix checks are not filesystem confinement.

Handles are unpredictable, short-lived, instance/process-generation/invocation-bound and
limited-use; leaking one must not grant broader authority. Stable errors include denied, invalid,
stale-context, busy, unavailable, uncertain, quota, unsupported and protocol-fault. Generic errors
must not expose upstream bodies, capability URLs, credentials or local paths.

## Identity, grants and durable dispatch

Mesh derives caller identity from the authenticated connection and fresh native state [E1].
Reject tool-supplied session name/created/nonce, endpoint, credential reference or authority.
An MCP transport session ID is not a Mesh session identity. Owner-targeted and token-only
`@self` calls keep separate authentication semantics; no master-token fallback.

Grant fields: ID/policy epoch, connector/approved digest, instance, verified account binding,
config/action-schema fingerprint, exact actions, subject/resource restrictions, expiry and
confirmation policy. Session subject binds host/machine authority and native `(name, created,
nonce)`; project subject binds machine/project/source and selector revision. Event subscriptions
can have separately approved durable project scope without any session. No wildcard future
actions, all-account authority or name-only inheritance in v1.

Dispatch:

1. Authenticate; validate bounded body; recheck live context after body/awaits.
2. Intersect current activation/config/grant policy and show any host-owned confirmation.
3. Persist admission with input digest, subject, action/account binding, package/policy epochs,
   request ID and catalog generation. Failure prevents upstream send.
4. Prepare/validate the provider plan. Recheck context and serialize a dispatch admission against
   grant withdrawal. Withdrawal ordered before admission prevents send; one ordered after that
   point cannot guarantee recall of the already admitted external effect.
5. Send once, record transport state and interpret provider semantics. Unknown/malformed results
   after dispatch are uncertain, not success or safe refusal.
6. Commit validated observation/revoke and receipt. Ordinary associations require a fresh live
   subject; confirmed account-wide revoke still applies if its caller ended [E3–E5].

Outcomes have independent axes: execution `success/refused/upstream-error/unavailable/uncertain`;
catalog `recorded/not-recorded/not-applicable`; availability
`observed-present/pending-target/revoked/stale/unknown`. MCP `isError:false` is not domain success.
Upstream success plus local recording failure stays success with a not-recorded warning.
Do not replay the provider operation to repair metadata.

Persist request-ID/input binding and receipts: retries return the existing result; changed input
under the same ID refuses. Crash-after-dispatch leaves durable uncertainty. Only a separately
approved read-only reconciliation may resolve it. Do not promise exactly-once remote effects.

Use a bounded durable host outbox for committed events, written with the owning action's
transaction or reconciled from its authoritative commit receipt. Derive a reaction key from
subscription, event and verified target, not over mutable message text or a reused session name.
Persist the input digest at first admission; retry delivery of the event may recover the same
reaction receipt, but must not repeat a dispatched effect. Mailbox acceptance is distinct from
the recipient processing the message.

Grant withdrawal increments epoch, invalidates queued handles and stops event delivery.
Cancellation after dispatch is best effort. Disabling code, withdrawing grants, revoking
credentials and revoking already minted remote shares are distinct operations.

## Credentials and egress

Instance configuration holds a host-issued credential binding reference, never a raw secret or
caller-selected file path. Enrollment separately confirms audience, account/tenant, endpoint and
scopes. Worker receives a service handle, not the credential reference or secret. Resolve only in
host egress after admission. Never forward Mesh bearer/cookie/session credentials or reuse
assistant-side MCP authentication [E10]. Main's backend account resolver is not this broker [E9].

Bind scheme/host/port/path and account to approved templates. Refuse URL userinfo, redirects,
secret query parameters and unapproved destination changes. Enforce DNS/destination policy on
each connection/reconnect; deny metadata/private addresses by default, with explicit private or
literal-loopback approval where needed. Validate TLS; do not inherit proxy settings. Validate
returned links separately; a response URL cannot change the upstream credential audience.

HTTP MCP OAuth is a separate host enrollment flow with PKCE/resource/audience validation and
secure refresh storage [E10]. Do not auto-enroll, broaden scopes on challenge or automatically
replay mutations after reauthorization. A stdio provider needing a dedicated upstream credential
is an explicitly secret-bearing trusted component; it does not receive ambient Mesh/assistant
credentials and is not equivalent to the credentialless adapter.

## Three transports, not one overloaded protocol

1. **Agent to Mesh:** host-owned MCP shim, stdio first, fixed approved tool schemas and fresh
   session auth. Client disable/approval settings remain an additional gate.
2. **Host to worker:** versioned local plugin protocol above; Mesh identity/receipts/grants are
   Mesh semantics, not supplied by generic MCP.
3. **Host to provider:** supervised MCP stdio, MCP Streamable HTTP or approved REST/files
   services. Full Streamable HTTP must handle negotiated versions, initialization, JSON **and**
   SSE, session/version headers, bounded cancellation/resumption and server requests [E10].

Keep PR158's JSON-only Notes exchange labeled `notes-json-http/1` until full conformance, not
“generic MCP HTTP.” Legacy HTTP+SSE is a separately enabled compatibility profile. Disconnection
does not prove cancellation. Reinitialization after a provider session 404 must not replay an
uncertain mutation. Reject unsupported sampling/elicitation/roots/server-initiated tool requests;
a provider cannot borrow agent authority.

## Generic artifacts, sources and events

Object key: `(connectorId, accountBindingId, namespace, upstreamObjectId)`. Scope associations
separately bind exact session incarnation or project/source. Multiple instances of one verified
account share revoke scope; instance ID alone cannot establish account identity. Unknown account
equivalence requires explicit mapping before claiming account-wide cleanup.

Record typed kind/version, bounded title, last observed timestamps/state, optional content
digest, package/receipt/source provenance and opaque open/preview references. Store sensitive
URLs privately, not in event/source DTOs. Bodies are not automatically mirrored or published.
Provider names/schema identifiers remain inert data.

Core issues admission generations. A confirmed revoke durably fences all older admissions for
the account/object, including before its first observation. Old delayed results cannot revive
it; a reused ID requires a fresh post-fence confirmation. Preserve barriers on disable/remove and
refuse capacity overflow rather than silently dropping security evidence [E3]. Unverified events
may invalidate freshness but cannot assert definitive revocation/success.

Source declaration includes selector/output schemas, read service needs, rendering and freshness
semantics. Native core keeps registry/revision authority [E7]. Saved selector alone is inert.
Collection captures boot/machine/project/source/revision and an opaque handle; recheck settings
before publication. Snapshot fields distinguish available/unavailable/unconfigured/stale,
provider versus observation time, known/unknown totals and truncation. Retain reported versus
accepted checks; actor labels never authenticate sessions.

Event fields include subscription, provider event ID, source revision, object/type, provider
time, host receive time/sequence and schema-validated data. Dedup within verified account/source.
Persist checkpoint only with accepted event/result commit. Gaps/overflow/expired retention mean
explicit stale/gap plus bounded read-only reconciliation, not empty successful history.
Authorize fields before delivery and invalidate old subscriptions on reload/config/grant changes.

## Core lifecycle, independent of installed code

Core owns exact restore intents, positive-empty evidence, catalog association moves, provenance,
revocation and uncertainty. No plugin hook runs in a critical terminal launch/stop/restore
transaction. Preserve PR158's distinction between UNKNOWN, EMPTY-CONFIRMED and NONEMPTY [E5].
Missing bundle/file/source/helper never proves zero references; corruption never initializes as
empty. Journal before launch and bind one exact destination; retries complete that destination
without a second terminal. Missing/replaced destination refuses completion.

Completion requires existing-catalog proof of moved, already-moved with exact provenance, or
source-empty from an affirmative exact source record. Core journal failure prevents launch;
optional association failure leaves the created terminal usable with warning and pending recovery.
Restored references transfer no session grant, credential or subscription. Removing a bundle
retains generic metadata/fences/receipts and disables unsupported previews/actions, not core
recovery. Optional cleanup cannot prevent terminal stop.

[#204]: https://github.com/Session-Mesh/session-mesh/issues/204
