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
val pending : t -> bool
(** True while an input frame is queued or being written. *)

val enqueue : t -> string -> bool
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
