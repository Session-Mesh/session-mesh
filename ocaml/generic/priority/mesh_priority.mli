(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A queue of keyed work items served by priority, without duplicates.

    The caller names its own tiers: any ordered type, the smallest served
    first. Order, first served first:
    + items [bump]ed to the front, the most recent bump first;
    + items named by the leading list ([set_leading]), in the order of that
      list;
    + the other items by ascending tier ([Tier.compare]);
    + within a tier by ascending [rank] (a caller that serves the most recent
      activity first passes the negated activity time);
    + then by insertion order (the order is stable).

    A key is queued at most once: adding a queued key replaces its value and
    priority. [pop] removes the item, so an item being worked on is no longer
    in the queue; adding it again queues it for later without affecting the
    work in progress. The leading list outlives the items: a key added after
    [set_leading] takes its place in that list.

    O(log n) for [add], [pop], [remove] and [bump]; [set_leading] is
    O((p + k) log n), where p and k are the lengths of the previous and the
    new list (every key of both is placed again, changed or not). Mutable,
    not safe across domains. *)

module Make (Key : Hashtbl.HashedType) (Tier : Set.OrderedType) : sig
  type priority = { tier : Tier.t; rank : float }

  val priority : ?rank:float -> Tier.t -> priority
  (** [rank] defaults to [0.]. *)

  type 'v t

  val create : unit -> 'v t

  val add : 'v t -> Key.t -> priority -> 'v -> unit
  (** Queue the item, or replace the value and priority of a queued key (its
      bump, if any, is kept). *)

  val bump : 'v t -> Key.t -> bool
  (** Move a queued key to the front. [false] when the key is not queued. *)

  val set_leading : 'v t -> Key.t list -> unit
  (** Replace the leading list: keys served right after the bumped ones, in
      the order of the list, whatever their tier. The first occurrence of
      each key counts. Keys not queued are remembered for a later {!add}. *)

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
