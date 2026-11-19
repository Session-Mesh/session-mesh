(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Random hex ids. Task and project ids are four hex digits; after 20 draws
    that all collide at one length, one more digit is used, up to eight.
    Blocker ids are six hex digits. [taken] holds the lowercase hex parts of
    the ids already in use. *)

val task : Random.State.t -> taken:string list -> string
(** [T-xxxx]. *)

val project : Random.State.t -> taken:string list -> string
(** [P-xxxx]; [taken] holds project ids only (the namespaces are separate). *)

val blocker : Random.State.t -> taken:string list -> string
(** [B-xxxxxx], unique among all blockers. *)
