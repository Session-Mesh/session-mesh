<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Atacama <contact@atacama.tech> -->

# Evidence and reuse

## Baselines

- **M:** public main `49ddee7e58adfd9174649c8edb7b2a471b988694`, checked against the
  public branch and used as the RFC base on 2026-11-22.
- **R:** `fe00e571e8ac6ded3203a7c3829c88585a84891b`, the specified Notes/Artifacts
  proposal revision of [PR158](https://github.com/Session-Mesh/session-mesh/pull/158),
  related to [#138](https://github.com/Session-Mesh/session-mesh/issues/138). Read from
  committed objects only. This is not a claim about the latest PR head.
- **RFC204:** [Mathias's plugin API discussion](https://github.com/Session-Mesh/session-mesh/issues/204),
  issue body observed with revision timestamp `2026-11-22T13:44:55Z`.

Observations below are source inspection, not claims about a deployed instance.
The [contribution rules][contributing] and [agent instructions][agents] apply to future
implementation: OCaml/TypeScript for new code, EN/FR UI, trust-boundary review, isolated tests.

| ID | Observation | Pinned source / anchor |
| --- | --- | --- |
| E1 | MeshSession checks allowed route, MAC and live native nonce; exact created identity is returned. R adds a token-only Notes route. | [M sessionauth.py][m-auth] and [R sessionauth.py][r-auth], `authenticate`, `TOKEN_ONLY_ROUTES` |
| E2 | R explicitly opts into a separate `mesh-notes` MCP server; worker mode is linked with board tooling, not distributed independently. | [R agentmcp.py][r-inject], `NOTES_SERVER_NAME`; [R mesh_board_mcp_main.ml][r-board], `--artifacts-worker`; [R dune][r-dune] |
| E3 | R validates Notes path/arguments and domain outcomes, uses a separate private credential file and bounded JSON HTTP exchange. Store handles generations, revoke fences and exact transfer provenance. | [R mesh_notes_connector.ml][r-notes], `configuration`, `call`, `write_outcome`, `observation`; [R mesh_session_artifacts.ml][r-store], `with_store`, `begin_observation`, `observe`, `revoke`, `transfer` |
| E4 | R authorizes first, admits a generation, invokes worker, then records outcome; helper copies server env except session token; worker reads private grants/config. | [R server.py][r-server], `artifact_command`, `api_session_notes`, `artifact_transfer_complete`; [R mesh_artifacts_worker.ml][r-worker], `run` |
| E5 | R distinguishes unknown/confirmed-empty/nonempty; restore journals before launch, requires typed transfer proof, and retries only the bound target. Catalog UI uses safe external links. | [R session-artifacts.md][r-doc], Persistence and lifecycle; [R specs/session-artifacts.md][r-spec], FR-5/7/8; [R static/session-artifacts.ts][r-ui] |
| E6 | Roster document reader is existing M code. It validates fresh sources and selectors, producer schema/digest, references and limits; it rechecks settings/board revision before returning. | [M projectartifacts.py][m-roster], `Reader.scope`, `run`, `artifact`, `collect` |
| E7 | Native PTY host owns Projects registry; observation has bounded independent accounting and cancellation/settlement; existing provider commands are trusted local code, not a sandbox. | [M docs/projects.md][m-projects], Observe and Resource bounds; [M mesh_project_observation.mli][m-observe], `make`, `tick`, `run` |
| E8 | Mesh's documented existing boundary trusts same-user processes/agents; product release attestations establish build provenance, not review or safety. | [M SECURITY.md][m-security], Threat model; [M docs/binary-bundles.md][m-bundle] |
| E9 | Current backend profiles describe launch roots and consent; their metadata is not proof of login or an OS sandbox, and profile qualification is not connector egress. | [M docs/backend-account-profiles.md][m-accounts], Identity and configuration and Root roles; [M mesh_account_resolver.mli][m-resolver] |
| E10 | MCP defines stdio and Streamable HTTP; HTTP responses may use JSON or SSE, and disconnection does not imply cancellation. Inbound tokens must not be passed through to upstream. | [MCP transports 2025-11-25][mcp-transports]; [MCP authorization 2025-11-25][mcp-auth], Token Handling and Access Token Privilege Restriction |

Main does not contain R's `ocaml/lib/mesh_notes_connector.ml`, `mesh_session_artifacts.ml`,
`docs/session-artifacts.md` or `static/session-artifacts.ts`. `projectartifacts.py` is unchanged
between R and M. Core server, restore, UI and session/account changes have advanced since R;
recheck these surfaces before integration instead of replaying the PR as a patch series.
The Roster roadmap and experimental pipeline profiles are distinct: unsupported output is not
an empty pipeline [E7]. The issue-reader section of Projects also documents gh/glab execution;
do not generalize the final historical sentence about Roster to all executable Mesh integrations.

## Reuse investigated

Capability and repository discovery in library-index was followed by exact entry and
maintained-copy inspection for Session Mesh, Roster and agent-tool-broker. The index is a lead,
not evidence of current API or platform compatibility.

| Candidate | Proposed use or rejection |
| --- | --- |
| Session Mesh | Reuse native live identity, separate observation accounting, strict codecs, atomic file persistence, safe renderers and existing MCP server tool layer [E1–E8]. |
| [Roster](https://github.com/mathiasbourgoin/roster) | Reuse the exercised producer protocol through an adapter [E6–E7]. Roster extension packs are not Mesh host-API packages. Do not install a harness to load a connector. |
| [agent-tool-broker](https://gitlab.com/nomadic-labs/ai-harness/agent-tool-broker) | Prior art for restricted MCP brokerage, no-network workers and receipts. No dependency adopted: verify pinned source, license, API and platform behavior before any reuse. |
| mcp-kit / mcp-kit.stdio | Already linked in R's board server [E2]; suitable server-side machinery, not proof of an upstream HTTP client [R spec][r-spec]. |
| State-machine trace tools | Useful for replay/conformance after the transition model is settled; not a loader, credentials broker or sandbox. |

No existing candidate was established as a drop-in bundle runtime for the Mesh resource
authority model. The proposed new work is the missing versioned host contract, lifecycle and
adaptation; do not add an OCI daemon, custom signing algorithm or registry service by default.
No new library is adopted by this RFC.

## Limits

Source comparison and document checks do not establish live provider compatibility, OS
isolation, performance, full-suite acceptance, or a completed migration. The contract, sample
manifest, quotas and CI example are proposed. Conformance gates are in [Delivery](delivery.md).

[agents]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/AGENTS.md
[contributing]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/CONTRIBUTING.md
[m-auth]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/sessionauth.py
[m-roster]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/projectartifacts.py
[m-projects]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/docs/projects.md
[m-observe]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/ocaml/lib/mesh_project_observation.mli
[m-security]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/SECURITY.md
[m-bundle]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/docs/binary-bundles.md
[m-accounts]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/docs/backend-account-profiles.md
[m-resolver]: https://github.com/Session-Mesh/session-mesh/blob/49ddee7e58adfd9174649c8edb7b2a471b988694/ocaml/accounts/resolver/mesh_account_resolver.mli
[r-auth]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/sessionauth.py
[r-inject]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/agentmcp.py
[r-board]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/ocaml/bin/mesh_board_mcp_main.ml
[r-dune]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/ocaml/lib/dune
[r-notes]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/ocaml/lib/mesh_notes_connector.ml
[r-store]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/ocaml/lib/mesh_session_artifacts.ml
[r-server]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/server.py
[r-worker]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/ocaml/lib/mesh_artifacts_worker.ml
[r-doc]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/docs/session-artifacts.md
[r-spec]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/specs/session-artifacts.md
[r-ui]: https://github.com/Session-Mesh/session-mesh/blob/fe00e571e8ac6ded3203a7c3829c88585a84891b/static/session-artifacts.ts
[mcp-transports]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
[mcp-auth]: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
