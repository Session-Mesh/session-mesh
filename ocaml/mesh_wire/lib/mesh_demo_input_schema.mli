(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t
(** Strict canonical [mesh-input-schema-v1] bytes. *)

type error = Too_large | Malformed | Noncanonical | Invalid_schema

val max_encoded_bytes : int
val decode : string -> (t, error) result
val bytes : t -> string
