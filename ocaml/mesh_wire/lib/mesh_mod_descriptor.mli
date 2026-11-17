(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A closed v1 identity descriptor for a future Mesh mod revision.

    This is neither a manifest loader, an installation record, an approval nor a
    capability grant. It deliberately contains no source bytes, URL, path,
    asset, entry point, target, runner or client identity. [code_digest]
    identifies proposed bytes syntactically; provenance must later be bound by
    an authenticated artifact and an owner decision. *)

type error =
  | Too_large
  | Malformed
  | Invalid_fields
  | Unsupported_version
  | Invalid_mod_id
  | Invalid_code_digest
  | Capabilities_unavailable

type t

val max_encoded_bytes : int

val create : mod_id:string -> code_digest:string -> (t, error) result
(** Construct a zero-capability v1 descriptor. *)

val mod_id : t -> string
val code_digest : t -> string

val encode : t -> string
(** Canonical, exact v1 JSON. *)

val decode : string -> (t, error) result
(** Refuses unknown, missing and duplicate fields; every non-empty capability
    list is unavailable until a separately reviewed host bridge grants it. *)

val same_code_revision : t -> t -> bool
(** Exact equality of the opaque mod identifier and code digest only. *)
