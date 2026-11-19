(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Errors of the worklog library. Operations return [('a, Err.t) result]; the
    kinds map to the exit codes of the [wl] tool. *)

type kind =
  | Usage  (** invalid input or refused operation (exit 2) *)
  | Not_found  (** unknown or ambiguous task, project or blocker (exit 3) *)
  | Malformed  (** malformed data (exit 4) *)
  | Lock_timeout  (** the repository lock was not obtained in time (exit 5) *)
  | Repo  (** repository missing or invalid (exit 6) *)
  | Other  (** any other failure, such as an I/O error (exit 1) *)

type t = { kind : kind; message : string }

exception E of t
(** Raised inside the library; every public operation catches it. *)

val make : kind -> string -> t
val fail : kind -> string -> 'a
val usage : ('a, unit, string, 'b) format4 -> 'a
val not_found : ('a, unit, string, 'b) format4 -> 'a
val exit_code : kind -> int
val to_string : t -> string

val unwrap : ('a, t) result -> 'a
(** The value of an [Ok], or raise {!E}. *)

val protect : (unit -> 'a) -> ('a, t) result
(** Run a function, turning [E], [Unix.Unix_error] and [Sys_error] into [Error]. *)

val reraise_fatal : exn -> unit
(** Re-raise [Sys.Break] and [Out_of_memory]; do nothing for any other
    exception. Used by the library's catch-all handlers so that an interrupt or
    memory exhaustion is never turned into a warning. *)
