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
val terminal_reports_only : string -> bool
(** Strict complete focus, mouse, cursor-position and status reply grammar.
    Mixed human bytes (including Enter or paste framing) are not reports. *)
val enqueue : t -> string -> bool
val acquire_fence : t -> bool
(** Only succeeds with no queued or in-flight PTY write. No implicit timeout
    or release on a caller disconnect. *)
val release_fence : t -> bool
(** Refuses release if the writer is closed or an owned control frame is queued
    or in flight. A closed writer may have discarded an undelivered frame. *)
val enqueue_fenced : t -> string -> bool
(** The host's owned relaunch command drains while fenced. Ordinary input and
    wakes remain refused. Success acknowledges queue admission, not a completed
    PTY write or editor readiness. *)
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
