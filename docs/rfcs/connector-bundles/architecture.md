<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Atacama <contact@atacama.tech> -->

# Architecture: one action model, separately delivered adapters

This proposal extends [#204][rfc204] with a delivery and execution boundary. Source IDs below
refer to the [evidence ledger](evidence.md). Target architecture statements are proposals,
not claims about the current implementation.

## Alternatives and recommendation

| Criterion | A: in-process modules | B: supervised executables | C: remote MCP services only |
| --- | --- | --- | --- |
| Independent release | Possible, coupled to host runtime/ABI | Versioned wire boundary; platform-specific payloads | Independent service, still needs Mesh integration |
| Failures | Crash/blocking/memory failure shares host | Per-instance deadlines, quotas, containment unit | Network faults separate; remote resource control external |
| Authority | Module can access process state despite declared caps | Host can withhold credentials/store; OS isolation still necessary | MCP does not establish Mesh session identity |
| Local Roster/CLI | Convenient but broad filesystem access | Packaged producer reads approved snapshot/handles | Requires extra local service and deployment |
| UI and lifecycle | Easy to couple into core internals | Data contracts; core survives missing adapter | MCP does not define Mesh views or restore transfer |
| Cost | Cheap prototype, expensive later trust/ABI boundary | Broker/supervision/protocol qualification | Service/OAuth operations plus missing local contracts |

**Recommend B.** Use remote MCP as an upstream transport inside B, not as the extension
architecture. Keep in-process libraries for reviewed core components. WASM could later provide
an additional worker profile, but would still need grants, host services and resource limits.

## Shared dispatcher, not a second control plane

Figure 1 shows where authority stays. Clients and adapters use #204's action dispatcher;
the component responsible for a resource validates its authority before applying a change.

```text
operator UI / agent MCP shim / authenticated plugin connection
                              |
                    shared action dispatcher
                     schemas + caller + policy
                              |
            resource component: live identity / grants / admission
                  |                 |                 |
             native runner     core artifacts     receipts/events
                  +-----------------+-----------------+
                                    |
                         plugin host and supervisor
                                    |
                     [qualified OS containment unit]
                                    |
                        executable adapter instance
                                    |
                 scoped host upstream/filesystem services
                                    |
                      provider MCP / REST / source snapshot
```

**Figure 1 — Bundle code does not decide Mesh authority.** Proposed arrangement derived from
E1–E8 and #204. Arrows describe request/data paths, not automatic approval. Text equivalent:
Mesh authenticates callers and admits effects; workers receive limited handles and propose
results, not raw client credentials or catalog write access. Without OS containment, the process
boundary contains faults but does not prevent malicious code bypassing the broker.

Introduce a plugin-host component with a private local protocol and supervised worker units.
Whether that host is its own managed process or a compartment of an existing service should be
settled during implementation; **do not require a native PTY restart to install/reload a bundle**.
The native host remains authoritative for sessions and Projects [E1, E7]. The web layer remains
an authenticated bridge, not a new filesystem/credential authority.

Private sockets, peer credentials and audience/expiry-bound context attestations can constrain
the host connections. They are not protection against arbitrary same-user software outside
containment. Workers must not receive reusable native-session attestations. Restart invalidates
transient connection handles, not durable admissions and receipts.

## Core and adapter responsibilities

| Mesh core | Adapter | Not delegated |
| --- | --- | --- |
| Verify live native incarnation or current project/source revision | Validate provider semantics and normalize data | Caller identity, grant issuance |
| Installed digest, instance config, activation, grants | Declare requirements and stable actions | Self-install, permission expansion |
| Authenticated upstream and read-only source services | Prepare fixed provider requests, interpret responses | Credential resolution, unrestricted fetch/exec |
| Admit operations and record uncertainty | Report typed outcomes and observation proposals | Automatic mutation replay |
| Catalog, associations, transfer provenance, revoke fences | Provide namespaced object identity and observed state | Direct catalog writes or lifecycle transfer |
| Source IDs/settings, scheduling, event delivery | Produce declared observations/events | Registry writes or inferred session authority |
| Safe renderers, confirmation and navigation | Contribute declared view data/actions | Arbitrary JS, HTML controls or application routes |

The proposed Notes worker is built with the board release and accesses private configuration
directly [E2–E4]. Shipping that binary separately is not enough: extraction must remove ambient
authority while preserving its domain/result and recovery semantics.

## Hooks: explicit phases and independent authority

Use #204's registry definition to publish supported phases, execution policy and time budget
for each action. Prefer **no hook phases by default** over interpreting “every public action
is hookable” as universal interception. Core authentication, grant withdrawal and restoration
proofs must not become modifiable or vetoable by third-party code.

Start with filtered committed after-events, as #204 proposes. An event grants neither its
originator's authority nor authority for a reaction. Sending a session message requires its own
grant, a verified current target incarnation and any approved trigger restriction. Project text,
actor labels and causal IDs are provenance, not credentials.

Before hooks can later propose inputs or veto only on explicitly extensible actions:

- Capture an immutable original request and caller; never let a hook change identity, account
  binding or authorization context.
- Validate the complete resulting input and authorize it again as the original caller.
  A hook's broader grant cannot expand that caller's authority.
- Specify deterministic order, timeout, failure behavior, allowed fields and revision checks per
  action. Do not hold resource locks while awaiting plugin code.
- Give hook failures their own outcome; never turn a timeout into implicit approval for a
  security-critical check. Such checks belong in core policy, not optional hooks.

Carry causal parent/root, operation ID, hop/depth and total reaction budgets. Stable IDs dedup
durably; depth limits alone do not prevent cycles across restarts. Reload withdraws old
registrations/subscriptions, fences old-generation handles and preserves in-flight truth.
Exactly-once external effects are not promised.

## Execution and truthful isolation profiles

Default launch is an absolute immutable executable plus argument array, no shell, explicit
runtime, minimal environment, closed inherited descriptors and private working directory.
No ambient agent variables, credentials, HOME/PATH discovery or inherited proxy settings.
TypeScript workers package a runtime or request an approved digest-pinned host runtime; OCaml
workers have no host extension ABI. No package-install hook runs on installation.

Separate workers by instance/account/security domain. Keep mutation and observation quotas
independent from terminal/registry lanes. Initial illustrative ceilings are four active calls
globally, two per instance, 1 MiB frames, 2 MiB aggregate result and a 30-second ordinary deadline.
Reserve bytes before capture and bound stderr while streaming. Core limits override manifests.
No unbounded queue or output buffer followed by a late length check.

Crash, invalid frame, repeated timeout or unconfirmed shutdown opens an instance circuit breaker.
Kill the owned containment unit/process tree; an exited leader does not prove its descendants
settled. Keep unsettled capacity charged [E7]. Do not hold catalog locks across provider IO.

Two explicit profiles:

- **brokered-isolated:** no direct network; no Mesh config/credentials mounted; read-only payload
  and runtime; bounded private writes; approved read-only snapshots; only scoped host IPC.
  Qualify actual Linux namespaces/mount/network/syscall/resource controls and their failure paths.
- **trusted-local:** operator-approved code with process fault controls but no malicious-code
  containment claim. It may bypass logical API restrictions using its OS rights.
  Never silently fall back to this when isolation fails.

macOS requires its own verified profile. Without it, refuse isolated-required bundles or obtain
explicit trusted-local acceptance. Signature, stdio, fixed argv, process groups and read-only
payloads are not a sandbox. The host, approved runtime and OS remain trusted. A compromised
adapter can lie about provider observations or misuse data within a granted operation; input
scope and egress templates reduce but cannot eliminate that risk.

This is narrower than changing the entire Mesh threat model: current trusted agents and other
same-user processes retain their existing rights [E8].

## UI and Artifacts

Use #204's named targets with host-owned controls. Begin with `add`; later `update`/`hide` may
affect only explicitly extensible presentation, never conceal grants, revocation, uncertainty,
security warnings or essential recovery controls. Conflicting contributions retain the host
default and display the conflict. Disabling restores the original view.

Allow typed cards, bounded text/Markdown, tables, task/check summaries and event lists.
Use local parsers/sanitizers, escaped message catalogs and icon identifiers; reject remote JS,
CSS, arbitrary SVG/HTML, custom elements, DOM attributes or iframe contributions. A contributed
action selects a registered ID and validated input, not a shell command, URL or raw patch.
Recheck authorization and exact UI target on execution; drop stale responses. EN/FR,
keyboard/accessibility and mobile acceptance apply.

Artifacts is a generic **reference catalog**, not a Notes mirror or automatic publication.
Separate upstream object identity from its session/project associations. Preview/open descriptors
are separately authorized. Capability URLs remain private, are never prefetched/embedded and use
explicit no-referrer/noopener navigation [E5]. Provider type identifiers are inert schema names,
not fetched code. Connectors may provide actions only, sources only, events, artifacts or a
combination.

## Three examples before API freeze

| Dimension | Notes: proposed PR158 code | Roster: existing integration | CI observer: hypothetical fixture |
| --- | --- | --- | --- |
| Provider | Remote JSON HTTP MCP | Local CLI/selected roots | Remote REST poll/events; no MCP needed |
| Subject | Exact live session | Operator-approved project/source | Project/source subscription; no session needed |
| Effects | Create/replace/mint/revoke | Read-only first extraction | Read-only; rerun would need separate permission |
| Credentials | Separate Notes binding | None; filesystem read grant | Audience-scoped API binding |
| Artifacts | Sensitive share, possibly pending target | Source-scoped document pages/task data | Run/report references and status |
| Events | Confirmed revoke/fences | Recorded history, not live identity | Duplicate/out-of-order events and checkpoint gaps |
| Anti-overfit invariant | Creating is not sharing | Source authority is not a session grant | Works without local roots or interactive session |

The CI case is not a live integration. Initial polling avoids public ingress. A future webhook
receiver must be host-owned, authenticated and bound to a subscription/key/replay window; bundles
must not open arbitrary listeners. An event may update/invalidate observations, not start a
terminal or accept work. A fourth adapter using existing capabilities should need no
provider-specific core branch.

[rfc204]: https://github.com/Session-Mesh/session-mesh/issues/204
