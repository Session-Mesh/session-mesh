(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Files for the tests of the generic libraries: everything lives in a fresh
    temporary directory, removed afterwards. *)

val with_directory : (string -> 'a) -> 'a
(** A new private directory under the temporary directory, removed (with its
    contents) after the function returns or raises. *)

val write_file : string -> string -> unit
(** Create or truncate. *)

val append_file : string -> string -> unit

val qcheck : ?count:int -> name:string -> 'a QCheck.arbitrary -> ('a -> bool) -> unit
(** Run a property with a fixed seed, so that a run is reproducible. *)
