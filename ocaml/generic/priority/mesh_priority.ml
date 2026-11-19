(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Make (Key : Hashtbl.HashedType) (Tier : Set.OrderedType) = struct
  type priority = { tier : Tier.t; rank : float }

  let priority ?(rank = 0.) tier = { tier; rank }

  (* The position of an item in service order: bumped (latest bump first),
     then named by the leading list (in its order), then by tier and rank.
     [seq] is unique per item, so two slots never compare equal. *)
  type place = Bumped of int | Leading of int | Tiered of priority
  type slot = { place : place; seq : int; slot_key : Key.t }

  let compare_places a b =
    match (a, b) with
    | Bumped x, Bumped y -> Int.compare y x
    | Bumped _, _ -> -1
    | _, Bumped _ -> 1
    | Leading x, Leading y -> Int.compare x y
    | Leading _, _ -> -1
    | _, Leading _ -> 1
    | Tiered x, Tiered y -> (
        match Tier.compare x.tier y.tier with 0 -> Float.compare x.rank y.rank | c -> c)

  module Table = Hashtbl.Make (Key)

  module Order = Set.Make (struct
    type t = slot

    let compare a b = match compare_places a.place b.place with 0 -> Int.compare a.seq b.seq | c -> c
  end)

  type 'v entry = {
    mutable value : 'v;
    mutable base : priority;
    mutable bumped : int option;
    mutable slot : slot;
  }

  type 'v t = {
    entries : 'v entry Table.t;
    leading : int Table.t;
    mutable order : Order.t;
    mutable next_seq : int;
    mutable bumps : int;
  }

  let create () =
    {
      entries = Table.create 64;
      leading = Table.create 64;
      order = Order.empty;
      next_seq = 0;
      bumps = 0;
    }

  let slot_for t key ~seq ~base ~bumped =
    let place =
      match (bumped, Table.find_opt t.leading key) with
      | Some bump, _ -> Bumped bump
      | None, Some position -> Leading position
      | None, None -> Tiered base
    in
    { place; seq; slot_key = key }

  (* Recompute an entry's slot after its base, bump or leading place changed. *)
  let reslot t key entry =
    t.order <- Order.remove entry.slot t.order;
    entry.slot <- slot_for t key ~seq:entry.slot.seq ~base:entry.base ~bumped:entry.bumped;
    t.order <- Order.add entry.slot t.order

  let add t key base value =
    match Table.find_opt t.entries key with
    | Some entry ->
        entry.value <- value;
        entry.base <- base;
        reslot t key entry
    | None ->
        let seq = t.next_seq in
        t.next_seq <- seq + 1;
        let slot = slot_for t key ~seq ~base ~bumped:None in
        Table.replace t.entries key { value; base; bumped = None; slot };
        t.order <- Order.add slot t.order

  let bump t key =
    match Table.find_opt t.entries key with
    | None -> false
    | Some entry ->
        t.bumps <- t.bumps + 1;
        entry.bumped <- Some t.bumps;
        reslot t key entry;
        true

  let set_leading t keys =
    let previous = Table.fold (fun key _ acc -> key :: acc) t.leading [] in
    Table.reset t.leading;
    List.iteri
      (fun position key ->
        if not (Table.mem t.leading key) then Table.replace t.leading key position)
      keys;
    let touched = previous @ keys in
    List.iter
      (fun key ->
        match Table.find_opt t.entries key with Some entry -> reslot t key entry | None -> ())
      touched

  let remove t key =
    match Table.find_opt t.entries key with
    | None -> ()
    | Some entry ->
        t.order <- Order.remove entry.slot t.order;
        Table.remove t.entries key

  let first t =
    match Order.min_elt_opt t.order with
    | None -> None
    | Some slot -> Some (slot.slot_key, (Table.find t.entries slot.slot_key).value)

  let pop t =
    let item = first t in
    Option.iter (fun (key, _) -> remove t key) item;
    item

  let peek = first
  let mem t key = Table.mem t.entries key
  let length t = Table.length t.entries
  let is_empty t = Table.length t.entries = 0

  let to_list t =
    Order.elements t.order
    |> List.map (fun slot -> (slot.slot_key, (Table.find t.entries slot.slot_key).value))

  let position t key =
    let rec find index = function
      | [] -> None
      | slot :: rest -> if Key.equal slot.slot_key key then Some index else find (index + 1) rest
    in
    find 0 (Order.elements t.order)
end
