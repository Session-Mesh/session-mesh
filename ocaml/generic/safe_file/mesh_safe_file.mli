(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Opening a file that another program writes, without following a link or
    blocking on a special file.

    OCaml's [Unix] has no [O_NOFOLLOW]. {!open_regular} therefore checks the
    path with [lstat] (a symbolic link, FIFO, socket or device is never
    opened), opens it with [O_NONBLOCK] (one swapped in after the check
    cannot block the open), then checks the descriptor: it must be a regular
    file, the same one [lstat] saw. Only the last path component is checked:
    the caller chooses the directories it trusts. This is the rule the mesh
    already applies to its own files (worklog's [Safefs.open_regular],
    [Mesh_update_report.read_settings_file]).

    On a regular file, [O_NONBLOCK] has no effect on reads. A read can still
    wait on a stalled file system: callers that must keep a deadline run these
    functions in a system thread ([Mesh_deadline_pool.Blocking]). *)

type error =
  | Missing  (** No such file. *)
  | Not_regular  (** A symbolic link, directory, FIFO, socket or device. *)
  | Changed  (** Replaced between the check and the open. *)
  | Unreadable of string  (** Another system error, with its message. *)

val error_message : error -> string

val open_regular : string -> (Unix.file_descr * Unix.stats, error) result
(** A read-only, close-on-exec descriptor and its [fstat]. The caller closes
    it. *)

val with_regular : string -> (Unix.file_descr -> Unix.stats -> 'a) -> ('a, error) result
(** Open, apply, close (also when the function raises). *)

val read_at : Unix.file_descr -> offset:int -> bytes -> pos:int -> len:int -> int
(** Read at most [len] bytes at file offset [offset] into [bytes] at [pos];
    [0] at end of file. Retries on [EINTR]. Moves the descriptor's position.
    @raise Unix.Unix_error on a read error. *)

val read_range : Unix.file_descr -> offset:int -> length:int -> string
(** The bytes of [\[offset, offset + length)], fewer if the file ends first.
    @raise Unix.Unix_error on a read error. *)
