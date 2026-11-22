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
  | Publication_failed
  | Publication_uncertain

type report = { aliases : int; profiles : int }

val error_code : error -> string
(** Fixed, path-free error codes. *)

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
    file, data fsync, atomic no-clobber link and directory fsync. A matching
    interrupted two-link staging publication can be completed on retry only
    after private-directory, source, content and inode checks; other existing
    targets (including an equivalent registry, a link or a foreign file) are
    refused. A preexisting [backend-profiles.migrated] entry of any kind then
    refuses with [Already_retired], even when the registry is absent.

    After the registry has been synced and published, publish the fixed private 0600
    [backend-profiles.migrated] marker with the same no-clobber/fsync protocol.
    Its version-one JSON contains only the registry revision. Success confirms
    both publications; the source file remains unchanged. Removing the registry
    alone must not reactivate legacy aliases: manual rollback also requires
    deliberate removal of the retirement marker by the operator.

    The two files are not published atomically together. A crash between them
    can leave a registry without a retirement marker. The caller must
    reconcile that incomplete migration before deliberately removing its
    registry; this is not protection against same-user manual changes.

    At most 64 legacy aliases expand to at most 128 native profiles, preserving
    both backends of each alias. Expansion beyond the compatibility bound fails
    with [Profile_compatibility_limit], without dropping profiles.
    [Publication_failed] means no target was published by this call;
    [Publication_uncertain] means a complete registry was linked but its final
    directory sync or retirement-marker publication was not confirmed. On
    filesystems/platforms where fsync on a directory does not guarantee
    power-loss persistence (notably macOS), success does not establish that
    both links survive a sudden power loss. The registry
    is retained on every marker failure. Do not retry the latter as permission
    to overwrite or remove that target. *)
