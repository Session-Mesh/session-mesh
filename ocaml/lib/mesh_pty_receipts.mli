(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(******************************************************************************)

(** Keep old identities for replay rejection, but release their payloads. *)
val retire_v1 : (string, float * int * string) Hashtbl.t -> unit
