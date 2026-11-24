(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

(** Explicit, host-only migration of the fixed private [accounts.json] file.
    This is metadata conversion, not login, launch or live-switch qualification.
*)

type error =
  | Unsafe_configuration_root
  | Source_missing
  | Unsafe_source
  | Invalid_source
  | Invalid_profiles
  | Profile_name_collision
  | Derived_root_too_long
  | Profile_compatibility_limit
  | Unsafe_agent_roots
  | Target_exists
  | Already_retired
  | Migration_busy
  | Publication_failed
  | Publication_uncertain

type report = { aliases : int; profiles : int }

val error_code : error -> string
(** Fixed, path-free error codes. *)

val create_profile :
  root:string ->
  expected_revision:string option ->
  profile:Yojson.Safe.t ->
  (string * Yojson.Safe.t, string) result
(** Register exactly one enabled profile under the migration lock. The caller
    supplies a backend-qualified profile without [enabled]; returns the new
    registry revision and its public projection, never private roots. Refuses
    legacy aliases pending explicit migration and any ambiguous registry. *)

type create_recovery = Unpublished_aborted | Published_reconciled

val recover_created_profile : root:string -> (create_recovery, string) result
(** Host-only reconciliation of an interrupted first create. For an absent
    target, verify the durable create intent, exact private single-link stage,
    bytes, unchanged empty legacy declaration and no migration/retirement state;
    then discard only that staged candidate. For a published target, reconcile
    only its verified stage/intent. An absent target and absent stage remain
    blocked for manual inspection. Never publishes or replays the request.
    In the unpublished case retire and sync the intent before optional exact
    staging-inode cleanup; a crash may leave an inert orphan, not a pending
    intent without evidence. Published reconciliation keeps the destination
    as evidence while removing the stage before the intent.
    Returns whether publication had already happened, not a new create receipt. *)

val migrate : root:string -> (report, error) result
(** Validate the whole legacy file with the alias parser and the whole converted
    registry with the native profile validator before writing anything. Preserve
    backend-qualified IDs; trim labels; refuse newly introduced same-backend
    label/ID ambiguity (including [default]); declare Claude [config/projects]
    history and Codex [config/sessions] state, with every profile enabled.
    Derived conversation roots must also fit the native 1024-byte path bound;
    shorten the legacy base paths before migration if they do not.

    Require an existing trusted private Mesh root and a private, singly linked
    source file. Check current agent-root custody without creating missing agent
    directories. Never read credentials or history, copy them, or modify the
    legacy file. Publish a complete 0600 target using a same-directory staged
    file, data fsync, atomic no-clobber rename and directory fsync. If the
    platform or filesystem cannot perform that rename, publication fails closed. A matching
    interrupted publication can be completed on retry only when a private,
    bounded [.backend-profiles.migration-intent] record was fsynced before
    publication and still binds the exact random stage, source identity and digest,
    target inode and registry digest. Recovery checks the record, current source,
    target and optional two-link stage before cleanup; a matching unrecorded
    stage is foreign and never unlinked. An intent without a target requires
    operator reconciliation rather than automatic linking. Other existing
    targets are refused. A preexisting [backend-profiles.migrated] entry then
    refuses with [Already_retired], even when the registry is absent.

    A permanent, private, singly linked 0600 [.backend-profiles.lock] is
    locked nonblockingly across validation, recovery, intent creation, publication,
    marker publication and cleanup. Concurrent callers get [Migration_busy]
    without modifying source or target. The lock file is never removed; invalid
    lock custody refuses the migration. POSIX record locks are process-scoped:
    this interface requires at most one migration call per host process.

    After the registry has been synced and published, publish the fixed private 0600
    [backend-profiles.migrated] marker with the same no-clobber/fsync protocol.
    Its version-one JSON contains only the registry revision. Success confirms
    both publications; the source file remains unchanged. Removing the registry
    alone must not reactivate legacy aliases: manual rollback also requires
    deliberate removal of the retirement marker by the operator.

    The two files are not published atomically together. A crash between them
    can leave a registry without a retirement marker; a verified intent lets a
    retry publish the marker without replacing the registry. A missing, stale
    or unverified intent requires operator reconciliation. This is not
    protection against same-user manual changes.

    At most 64 legacy aliases expand to at most 128 native profiles, preserving
    both backends of each alias. Expansion beyond the compatibility bound fails
    with [Profile_compatibility_limit], without dropping profiles.
    [Publication_failed] means no target was published by this call;
    [Publication_uncertain] means a complete registry was published but its final
    directory sync or retirement-marker publication was not confirmed. On
    filesystems/platforms where fsync on a directory does not guarantee
    power-loss persistence (notably macOS), success does not establish that
    both files survive a sudden power loss. The registry
    is retained on every marker failure. Do not retry the latter as permission
    to overwrite or remove that target. *)
