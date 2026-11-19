(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The cache of transcript folds an adapter keeps across rounds: one
    {!Mesh_jsonl_tail} result per key (a conversation, or a file), bounded by
    a {!Mesh_lru}, so that an unchanged transcript is not opened again and a
    grown one is read from where the last read stopped. Guarded by a mutex:
    adapters describe sessions from several system threads at once.

    The Claude adapter keeps its own copy of this logic for now; it is meant
    to move onto this module. *)

type 's t

type counters = {
  restarted : int;  (** Transcripts folded from their start (or window). *)
  appended : int;  (** Transcripts read from a previous cursor. *)
  unchanged : int;  (** Transcripts not opened: unchanged since the last read. *)
}

val create : Mesh_jsonl_tail.limits -> 's Mesh_jsonl_tail.fold -> 's t
(** Bounded to 64 entries until {!resize}. *)

val resize : 's t -> int -> unit
(** At least one entry. *)

val read : 's t -> key:string -> string -> 's Mesh_jsonl_tail.t option
(** The fold of the file at this path, brought up to date. A cached result for
    the same key and path is reused; [None] when the file cannot be read
    (the key is then forgotten). Never raises on a file error. *)

val counters : 's t -> counters
