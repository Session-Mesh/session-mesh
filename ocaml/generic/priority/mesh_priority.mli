(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A queue of keyed work items served by priority, without duplicates.

    Order, first served first:
    + items {!bump}ed to the front, the most recent bump first;
    + items named by the focus list ({!set_focus}), in the order of that list;
    + the other items by tier: [Focus], [Pinned], [Recent], [Visible], [Rest];
    + within a tier by ascending [rank] (a caller that serves the most recent
      activity first passes the negated activity time);
    + then by insertion order (the order is stable).

    A key is queued at most once: adding a queued key replaces its value and
    priority. {!pop} removes the item, so an item being worked on is no longer
    in the queue; adding it again queues it for later without affecting the
    work in progress. The focus list outlives the items: a key added after
    {!set_focus} takes its focus position.

    O(log n) for {!add}, {!pop}, {!remove} and {!bump}; {!set_focus} is
    O(k log n) for k changed keys. Mutable, not safe across domains. *)

type tier = Focus | Pinned | Recent | Visible | Rest

type priority = { tier : tier; rank : float }

val priority : ?rank:float -> tier -> priority
(** [rank] defaults to [0.]. *)

module type KEY = sig
  type t

  val equal : t -> t -> bool
  val hash : t -> int
end

module Make (Key : KEY) : sig
  type 'v t

  val create : unit -> 'v t
  val add : 'v t -> Key.t -> priority -> 'v -> unit
  (** Queue the item, or replace the value and priority of a queued key (its
      bump, if any, is kept). *)

  val bump : 'v t -> Key.t -> bool
  (** Move a queued key to the front. [false] when the key is not queued. *)

  val set_focus : 'v t -> Key.t list -> unit
  (** Replace the focus list: the first occurrence of each key counts. Keys
      not queued are remembered for a later {!add}. *)

  val pop : 'v t -> (Key.t * 'v) option
  (** Remove and return the first item. *)

  val peek : 'v t -> (Key.t * 'v) option
  val remove : 'v t -> Key.t -> unit
  val mem : 'v t -> Key.t -> bool
  val length : 'v t -> int
  val is_empty : 'v t -> bool

  val to_list : 'v t -> (Key.t * 'v) list
  (** All queued items in service order (O(n)). *)

  val position : 'v t -> Key.t -> int option
  (** The 0-based place of a queued key in service order (O(n)). *)
end
