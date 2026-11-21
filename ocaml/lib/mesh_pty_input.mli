(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A bounded, per-session input queue. Whole frames are accepted or dropped;
    the writer runs in its own fiber so a PTY that stops reading does not stall
    another attachment or session. *)

type t

val create : string -> t
val enqueue : ?current:(unit -> bool) -> t -> string -> bool
(** [current] fences conditional attachment data at dispatch. Before changing
    the incarnation, call {!retire_guarded} to cancel and join an in-flight
    conditional write as well as discard queued conditional data. *)
val retire_guarded : t -> unit
(** Discard only conditional data and wait until its active write has stopped.
    Ordinary input and wake frames are retained. Callers must prevent new
    conditional admissions until the incarnation transition is complete. *)
val enqueue_submit : t -> string -> bool
(** [enqueue_submit t text] queues [text], a short delay, then an Enter key.
    Any later {!enqueue} while that Enter is still queued withdraws it and
    erases the line (Ctrl-U) before its own data, unless that data is made
    only of terminal reports (focus, mouse, cursor-position and status
    replies), which pass through and leave the Enter queued. *)

val cancel_submit : t -> bool
(** Withdraw every queued wake Enter (and its delay); [true] if there was one. *)
val close : t -> unit
val run : t -> _ Eio.Time.clock -> 'a Eio.Flow.sink -> unit
