(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The key of one version of a rollout file: [lstat] with the modification
    time in integer nanoseconds, which OCaml's [Unix.stats] (a float) cannot
    carry. *)

type t = {
  device : int;
  inode : int;
  size : int;
  mtime_ns : int;  (** Modification time, integer nanoseconds since the epoch. *)
  mtime : float;
      (** The same time in seconds, computed as Python's [os.stat] does
          ([sec + nsec * 1e-9]). *)
}

val lstat_regular : string -> t option
(** The [lstat] of the path when it is a regular file (a symbolic link is not
    followed); [None] for anything else or when [lstat] fails. The runtime
    lock is released during the call. *)
