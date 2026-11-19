(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The exclusive repository lock [.wl.lock]: a BSD [flock(2)], the same one
    [wl] takes, so the two tools exclude each other. *)

val monotonic : unit -> float
(** Seconds on the monotonic clock (unaffected by wall-clock changes). *)

val raise_nofile_limit : int -> int
(** [raise_nofile_limit n] raises the soft limit on open descriptors of the
    process to [n], or to the hard limit when that is lower, and returns the
    soft limit in force afterwards ([-1] when it cannot be read). For callers
    and tests that need many descriptors. *)

val with_lock : path:string -> timeout:float -> (unit -> 'a) -> 'a
(** Run a function holding the lock. Waits up to [timeout] seconds, then
    raises {!Err.E} with kind [Lock_timeout]. The file is created if absent;
    the lock is released when the function returns or raises. *)
