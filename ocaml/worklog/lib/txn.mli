(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A write transaction: the repository lock is held from the read of the
    current state to the commit. *)

type t = {
  ctx : Ctx.t;
  session : Session.t option;
  now : int;  (** the clock reading shared by every event of the transaction *)
  loaded : Store.loaded;  (** the state read under the lock *)
  mutable paths : string list;  (** files written, for the commit *)
}

type items = (string * string * (string * Yojson.Safe.t) list) list
(** Events to write: (task or project id, type, payload fields). *)

val run : Ctx.t -> ?session:Session.t -> (t -> 'a) -> ('a, Err.t) result
(** Take [.wl.lock] (waiting up to [ctx.lock_timeout], then [Lock_timeout]),
    read the current state, run the function. {!Err.E} and I/O errors become
    [Error]. *)

val max_blob_bytes : int
(** Largest set of event lines of one change (60 000 bytes, under the 64 KiB a
    single [write(2)] of the OCaml [Unix] library carries). A change whose
    events are bigger (too many tags, links, milestones or risks at once) is
    refused with [Usage] before any write. *)

val prepare : t -> items -> unit -> unit
(** Encode events for this host's file of the UTC month of their timestamp,
    failing before any write if one cannot be encoded or if they exceed
    {!max_blob_bytes}; the returned function
    appends them: one write on an [O_APPEND] descriptor, then [fsync], with a
    newline first if the file lacks one. The timestamp is the transaction's
    clock reading, never lower than the last timestamp of this host's newest
    event file. [agent] and [session] are added to every event that does not
    carry them. *)

val append : t -> items -> unit
(** [prepare] then write. *)

val touch : t -> string -> unit
(** Record a written file for the commit. *)

val commit : t -> cmd:string -> subject:string option -> unit
(** When [ctx.commit] is set, commit only the written paths with the message
    [wl: <cmd> <subject>] (or [wl: <cmd>]). Skipped without error outside a
    git repository, during a merge or rebase; a failure is reported to
    [ctx.warn] and the data is kept. Never pushes. *)

val has_written : t -> bool
