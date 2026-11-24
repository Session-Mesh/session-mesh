(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type backend = Codex | Claude

val backend : string -> backend option
val efforts : string list

val inspect : backend -> string list list -> string option * string option
(** Model and reasoning effort declared in the launch arguments. *)

val apply :
  backend ->
  model:string option ->
  effort:string option ->
  string list list ->
  (string list, string) result
(** Replace only the selected settings in a resume argv. *)
