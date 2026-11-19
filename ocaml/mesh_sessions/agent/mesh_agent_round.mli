(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The process table of one round, read once and shared by every session of
    the round.

    The table is immutable once built, so system threads may read it at the
    same time; the command lines read are kept for the round (guarded by a
    mutex), so that detection, the parent check and the row read each once. Process details (command line, working directory) are not part
    of the table: they are read when asked, through the platform the round was
    built with ({!Mesh_pty_processes.platform}, which tests replace). *)

type process = Mesh_platform.process
type t

val read : Mesh_pty_processes.platform -> (t, Mesh_platform.error) result
(** Scan the process table. It blocks the calling thread (tens to hundreds of
    milliseconds): run it in a system thread. *)

val of_scan : Mesh_pty_processes.platform -> Mesh_platform.process_scan -> t

val complete : t -> bool
(** No process was left out of the scan ([skipped = 0]). *)

val size : t -> int
val find : t -> int -> process option

val processes : t -> process list
(** Every process of the table, by ascending pid. *)

val session : t -> int -> process list
(** The processes of a session (by session id), by ascending pid. *)

val argv : t -> int -> string list
(** The command line, raw bytes; [[]] when it cannot be read. Read once per
    round and process. *)

val cwd : t -> int -> string option
(** The working directory; [None] when it cannot be read. *)

val open_files : t -> int -> ((int * string) list, Mesh_platform.error) result
(** The open descriptors that have a path ({!Mesh_platform.open_file_paths}).
    The error says why they are unknown: [Not_found] (the process exited) and
    [Denied] (no permission) are told apart from the others. [Denied] does
    not say whose process it is: a non-dumpable process of the same user is
    [Denied] too; {!owner} tells. *)

val owner : t -> int -> (int, Mesh_platform.error) result
(** The user id that owns the process ({!Mesh_platform.process_owner}). *)
