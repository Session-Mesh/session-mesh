(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Test support: temporary copies of the fixture and runs of the real
    executable with a controlled environment. *)

type repo = { home : string; wl_home : string }

val temp_dir : string -> string
val copy_fixture : unit -> repo
(** A fresh copy of the worklog fixture, with its own empty home directory. *)

val append_events : repo -> string list -> unit
(** Append JSON lines to a new host file of the copy's [events/]. *)

val write_file : string -> string -> unit

type result = { code : int; out : string; err : string }

val run : ?env:(string * string) list -> ?input:string -> repo -> string list -> result
(** Run work-read on the repository, WL_NOW fixed at 2026-11-10T00:00:00Z;
    [input] is its standard input (else [/dev/null]). *)

val json : result -> Yojson.Safe.t
(** The single line of standard output, parsed; fails unless it is exactly one
    JSON document. *)

val tree_state : string -> (string * float * int) list
(** Every path under a directory with its mtime and size, sorted. *)
