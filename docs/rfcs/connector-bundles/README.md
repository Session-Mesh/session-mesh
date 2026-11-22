<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Atacama <contact@atacama.tech> -->

# RFC: independently distributed connector bundles

**Status: proposed, not implemented.** This RFC complements
[#204, A plugin API for Session Mesh](https://github.com/Session-Mesh/session-mesh/issues/204).
It proposes how to package, install and operate connectors on that shared action model,
without introducing a second dispatcher or delegating Mesh authority to plugin code.

The recommendation is **immutable bundles containing supervised executables**, a versioned
language-neutral protocol, scoped host services and declarative UI contributions. Mesh retains
identity verification, grants, durable operation receipts, artifact references and core lifecycle.
Installation, activation and authorization are separate decisions. A signature establishes
provenance under a trust policy; it does not establish isolation or safe behavior.

## Reading guide

- [Architecture](architecture.md): alternatives, relation to #204, trust boundaries, hooks and
  three contrasting examples.
- [Contract](contract.md): manifest, capabilities, host API, identity, grants, credentials,
  transports, artifacts, sources and events.
- [Delivery and migration](delivery.md): developer/operator workflow, update/rollback/remove,
  lossless migration, conformance matrix and incremental roadmap.
- [Evidence](evidence.md): pinned code observations, reuse investigation and limitations.

## Decisions requested

1. Use #204's shared action registry for connector actions, rather than a connector-specific
   permission path. Make supported hook phases explicit; protected core actions are not
   plugin-modifiable.
2. Adopt out-of-process bundles as the first independent delivery profile; keep third-party code
   out of the web/native host processes. Qualify OS containment separately.
3. Keep artifact association transfer, revocation barriers and uncertain-operation receipts in
   core, so removing a bundle cannot remove recovery or security evidence.
4. Use host-rendered UI and host-brokered credentials, not arbitrary browser code or credential
   passthrough.
5. Retain #204's small notification pilot. Before freezing the generic contract, also exercise
   remote Notes mutations, local Roster observations and a fixture CI source/event connector.

## Scope and non-goals

This is a documentation-only proposal, not an implementation plan authorized for execution.
No product behavior, existing PR, deployed service, authentication configuration or credential
is changed by these documents. No new registry service, workflow engine, custom cryptography,
general-purpose plugin marketplace or third-party in-process loader is required.

The Notes implementation analyzed here is the **proposal** at PR158's specified revision, not
functionality attributed to current main. Roster's project observations are existing code.
Neither example defines the limits of the extension model. Sources and status distinctions are
documented in [Evidence](evidence.md).

Review should settle the authority and recovery invariants first. Exact command names, file
layout, quotas, schema generation tooling and optional signing mechanism remain proposals;
examples are not executable product interfaces.
