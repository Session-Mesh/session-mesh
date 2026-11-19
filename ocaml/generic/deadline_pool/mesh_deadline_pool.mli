(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Work items run with bounded concurrency and a deadline each, under Eio
    structured concurrency.

    {!run} pulls items one at a time from the caller, so a priority queue may
    change its order while the pool works, and runs each in a fibre of its
    own switch: [run] returns when every started item has ended. An item ends
    in exactly one {!outcome}; its exceptions never escape into the pool. An
    item past its deadline is cancelled (its fibre receives
    [Eio.Cancel.Cancelled] at its next suspension point) and reported [Slow].

    {b Blocking system calls.} A fibre that makes a blocking call ([read] on
    a stalled file system, [open] of a FIFO without [O_NONBLOCK]) stops the
    whole Eio domain, and no deadline can interrupt it. Such work goes
    through {!Blocking.call}: it runs in a system thread, the fibre waits in
    a cancellable way, and a thread still blocked at the deadline is
    abandoned (it runs on and its result is discarded), never killed.
    [Eio_unix.run_in_systhread] is not used for this because the fibre that
    calls it cannot be cancelled before the thread returns.

    {b Rounds.} {!Progress} bounds a round by the absence of progress rather
    than by its total duration, so that a slow first round on a loaded
    machine is not mistaken for a stall. *)

type 'a outcome =
  | Ready of 'a
  | Slow  (** Still running at the deadline: cancelled. *)
  | Failed of exn  (** The work raised (for example {!Blocking.Saturated}). *)

(** Progress of a round, and a watchdog on its absence. *)
module Progress : sig
  type t

  val create : unit -> t

  val tick : t -> unit
  (** Record progress (an item ended, a heartbeat). Safe from any thread. *)

  val ticks : t -> int

  val watch :
    clock:_ Eio.Time.clock -> idle:float -> t -> (unit -> 'a) -> ('a, [> `Stalled ]) result
  (** [watch ~clock ~idle progress f] runs [f], and cancels it with
      [Error `Stalled] when [idle] seconds pass without a {!tick}. *)
end

(** Blocking calls in system threads, with a bound on the threads in flight,
    abandoned ones included. *)
module Blocking : sig
  type t

  exception Saturated
  (** Every thread is busy, possibly blocked for good: nothing was started. *)

  val create : max_threads:int -> t
  (** @raise Invalid_argument if [max_threads < 1]. *)

  val call : t -> (unit -> 'a) -> 'a
  (** Run the function in a new system thread and wait for its result in a
      cancellable way; its exception is re-raised here. When the waiting
      fibre is cancelled, the thread is abandoned: it is counted by
      {!abandoned} until it returns, and the value it then returns is
      discarded (a function that returns a resource, such as an open file,
      leaks it when abandoned: close it inside the function). A fibre that is
      already cancelled raises [Eio.Cancel.Cancelled] and starts no thread.
      @raise Saturated when [max_threads] threads are in flight. *)

  val in_flight : t -> int
  (** Threads started and not yet returned, abandoned ones included. *)

  val abandoned : t -> int
  (** Threads whose caller stopped waiting and that have not returned. *)

  val saturated : t -> bool
  (** [in_flight t >= max_threads]: the next {!call} raises {!Saturated}. *)
end

val run :
  clock:_ Eio.Time.clock ->
  max_concurrency:int ->
  deadline:float ->
  ?progress:Progress.t ->
  next:(unit -> 'item option) ->
  work:('item -> 'a) ->
  report:('item -> 'a outcome -> unit) ->
  unit ->
  unit
(** Run items until [next] returns [None], at most [max_concurrency] at a
    time, each with [deadline] seconds. [next] is called only when a slot is
    free. [report] is called once per item, from the item's fibre, as soon as
    it ends; then [progress] (when given) is ticked. [next] and [report] must
    not raise: an exception there fails the whole run, cancelling the items
    in progress.
    @raise Invalid_argument if [max_concurrency < 1] or [deadline] is not
    positive. *)
