(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A bounded map that evicts its least recently used entries.

    The map is mutable. It is bounded by a number of entries and, optionally,
    by a total weight that the caller measures (an approximate size in bytes,
    for example). Every operation is O(1) apart from {!to_list}, {!iter} and
    {!check_invariants}, which are O(n).

    Invariants, which hold after every operation:
    - [length t <= max_entries t];
    - when a weight limit is set, [total_weight t <= max_weight] and every
      entry's weight is at most [max_weight];
    - a key appears at most once;
    - the recency order is the order of the last {!add} or {!find} of each
      key.

    The map is not safe for concurrent use from several domains or system
    threads; Eio fibres of one domain may share it. *)

module Make (Key : Hashtbl.HashedType) : sig
  type 'v t

  type 'v weight = { limit : int; measure : 'v -> int }
  (** [measure] gives an entry's weight, a non-negative integer; [limit] is
      the largest total weight the map keeps. *)

  val create :
    max_entries:int -> ?weight:'v weight -> ?on_evict:(Key.t -> 'v -> unit) -> unit -> 'v t
  (** [on_evict] is called for each entry removed to respect a bound, not for
      {!remove}, {!clear} or a replacement by {!add}.
      @raise Invalid_argument if [max_entries < 1] or [weight.limit < 0]. *)

  val add : 'v t -> Key.t -> 'v -> unit
  (** Insert or replace, and make the key the most recently used. Then evict
      the least recently used entries until both bounds hold. A value heavier
      than the weight limit on its own is not kept (and any previous value of
      the key is removed): it is reported to [on_evict]. *)

  val find : 'v t -> Key.t -> 'v option
  (** The value, made the most recently used. *)

  val peek : 'v t -> Key.t -> 'v option
  (** The value, without changing the recency order. *)

  val mem : 'v t -> Key.t -> bool
  val remove : 'v t -> Key.t -> unit
  val clear : 'v t -> unit
  val length : 'v t -> int
  val total_weight : 'v t -> int
  (** [0] when no weight limit is set. *)

  val max_entries : 'v t -> int

  val set_max_entries : 'v t -> int -> unit
  (** Change the entry bound (for example to twice the number of live
      sessions), evicting at once if needed.
      @raise Invalid_argument if the bound is below 1. *)

  val to_list : 'v t -> (Key.t * 'v) list
  (** Most recently used first. *)

  val iter : (Key.t -> 'v -> unit) -> 'v t -> unit
  (** Most recently used first. The function must not change the map. *)

  val check_invariants : 'v t -> unit
  (** For tests: @raise Failure when an invariant above does not hold. *)
end
