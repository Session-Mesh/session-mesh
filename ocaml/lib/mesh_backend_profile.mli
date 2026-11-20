(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type backend = Claude | Codex | Opencode_v2 | Pi

type error =
  | Invalid_config
  | Unknown_profile
  | Disabled_profile
  | Backend_mismatch
  | Context_changed
  | Unsafe_roots

type t
type registry

val error_code : error -> string
(** Fixed public error code; never includes authored configuration or paths. *)

val valid_id : string -> bool
(** Existing alias grammar: [[a-z0-9-]{1,32}], never [default]. Not a label or
    authentication capability. *)

val of_string : string -> (registry, error) result
(** Strict version-one registry decoding. IDs and ASCII-case-insensitive labels
    are unique within each backend, not across different backends. Paths reuse
    the restricted alias path grammar; finite bounds and aliases are checked. *)

val profiles : registry -> t list
(** Immutable profiles in authored display order. *)

val registry_revision : registry -> string
(** Hash of the authored registry bytes for optimistic configuration updates. *)

val id : t -> string
(** Stable configured ID, qualified by {!backend} for identity. *)

val label : t -> string
(** Display text, never an identity or permission resource. *)

val backend : t -> backend
(** Exact backend variant, independent of native approval/sandbox presets. *)

val enabled : t -> bool
(** Whether resolution is permitted by this registry. *)

val context_revision : t -> string
(** Backend/root fingerprint; label and enabled state do not change identity. *)

val roots : t -> (string * string) list
(** Trusted native-side roots. Never forward these in browser metadata. *)

val public_json : t -> Yojson.Safe.t
(** ID/label/backend/context only; live switching remains explicitly
    unqualified. *)

val resolve :
  registry ->
  id:string ->
  backend:backend ->
  expected_context:string option ->
  (t, error) result
(** Reject unknown, disabled, mismatched or stale selections. No default
    fallback. *)

val validate_roots : ?registry:registry -> t -> (unit, error) result
(** Check current canonical directory identity, user ownership and no foreign
    write permission. With a registry, also reject physical credential-root
    aliases across profiles. This is not upstream login attestation. *)

val validate_private_root : string -> (unit, error) result
(** Validate an existing private Mesh configuration directory and its ancestors.
*)

val load : root:string -> (registry option, error) result
(** Read only the fixed private [backend-profiles.json] file. Absence is
    explicit unconfigured state, never a guessed native account or credential
    fallback. *)
