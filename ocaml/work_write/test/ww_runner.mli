(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Test support: temporary copies of the fixture with questions, and runs of
    the real [work-write] and [work-read] with a controlled environment. *)

type repo = { home : string; wl_home : string }
type result = { code : int; out : string; err : string }

val temp_dir : string -> string

val fixture : ?questions:int -> ?lines:string list -> unit -> repo
(** A fresh copy of the worklog fixture with [questions] open questions on
    task [T-3c4d] (ids {!qid} 0, 1, ...; default 2) and then the extra event
    [lines]. *)

val qid : int -> string
(** [N-0000a000] plus the index, in hex. *)

val request : string -> string -> string
(** The JSON request of an answer: question id, text. *)

val run : ?env:(string * string) list -> ?args:string list -> repo -> string -> result
(** Run work-write [--request] (or [args]) with this standard input, a
    minimal environment (PATH, HOME, WL_HOME, WL_HOST) plus [env]. *)

val spawn : repo -> string -> unit -> result
(** Start work-write at once; the returned function waits for it. *)

val json : result -> Yojson.Safe.t
(** The single line of standard output, parsed. *)

val questions : repo -> Yojson.Safe.t list
(** The [questions] of the [task T-3c4d] document of work-read. *)

val answer_events : repo -> Yojson.Safe.t list
(** Every [answer] event line of the repository, in file order. *)

val tree_state : string -> (string * int) list
(** Every path under a directory with its size, sorted. *)
