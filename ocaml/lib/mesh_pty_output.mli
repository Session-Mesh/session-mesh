(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Reader : sig
  type t

  val create : unit -> t

  val run : t -> (unit -> unit) -> unit
  (** Run once in a private cancellation context, captured before [read].
      Stopping before the first run skips [read] but consumes that run. Repeated
      runs raise [Invalid_argument]. Only owned-stop cancellation is handled;
      programmer/fatal exceptions and unrelated cancellation propagate. *)

  val stop : t -> unit
  (** Idempotently cancel only this output reader, never the process reaper or
      sibling input writer. Call before releasing the reader's descriptor. No
      callback queue, retry or descriptor ownership is added. Single domain. *)
end

type t
(** Per-attachment framed-output queue. Single Eio domain only; producers never
    block. Pending accounting includes a frame until its write completes. *)

val create : unit -> t

val limit : int
(** Pending-output budget in encoded bytes, headers included: 8 MiB. The budget
    belongs to one [t], so to one client: with N lagging clients the host may
    hold N such budgets. Live output that is never merged is one string shared
    by every client; a merged frame is a per-client copy whose retained memory
    is about 1.25 times its counted payload, so the retained total for one
    client is about 10 MiB. "Retained" means the reachable heap, not the
    resident set size (RSS) of the process. *)

val coalesce_limit : int
(** Largest D payload [enqueue_output] builds by merging: 64 KiB, one PTY read. *)

val enqueue : t -> string -> bool
(** False after closure or when adding a frame exceeds the eight-MiB budget.
    Overflow aborts this attachment, without truncating a frame. *)

val enqueue_output : t -> string -> bool
(** Queue live terminal output as D payload bytes. While the previous live item
    has not been taken by [next], the bytes are appended to it, up to 64 KiB of
    payload; otherwise they start a new D frame. Never merged with an opaque
    frame from [enqueue]. Same budget, closure and overflow rules as [enqueue],
    counted on encoded bytes. *)

val next : t -> string option
(** The next encoded frame, waiting while the queue is empty; [None] once the
    queue is closed, or finished and drained. The caller writes the frame, then
    reports it with [sent]. Until then its bytes stay counted. Single writer. *)

val sent : t -> string -> unit
(** [sent t frame] releases the budget of a written frame. [frame] must be
    exactly the string a previous [next] returned, once per frame: the count
    is subtracted from [String.length frame], so any other string, a partial
    write or a second call corrupts the accounting. *)

val finish : t -> unit
(** Stop accepting frames: afterwards [enqueue] and [enqueue_output] return
    false. Drain the queued frames then return None from next. *)

val close : t -> unit
val aborted : t -> unit Eio.Promise.t
val done_ : t -> unit Eio.Promise.t
val detached : t -> unit
