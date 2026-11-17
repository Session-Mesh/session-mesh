(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Shared bounded framing and Linux-compatible geometry/exit conversions. *)
val read_frame : _ Eio.Flow.source -> Mesh_wire.frame
(** Refuse an oversized header before allocating or reading its body. *)

val read_control_frame : max_payload:int -> _ Eio.Flow.source -> Mesh_wire.frame
(** Require kind C and an unsigned declared payload length no greater than the
    caller's bound before allocating or reading the body. The bound must be
    between zero and [Mesh_wire.max_small_frame]. Invalid headers raise
    [End_of_file]; existing [read_frame] behavior is unchanged. *)

val size : (string * Yojson.Basic.t) list -> int * int
(** Integers, finite floats, booleans and signed ASCII decimal strings
    (including between-digit underscores) clamped to 2..65535. Raises
    Invalid_argument for an invalid or absent dimension. Unicode
    digit/whitespace coercion is not yet Python-compatible; it remains a blocker
    for final host substitution. *)

val signal_code : int -> int
(** Translate OCaml wait-status signal encoding to negative Linux wire code. *)
