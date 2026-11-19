(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type tier = Focus | Pinned | Recent | Visible | Rest
type priority = { tier : tier; rank : float }

let priority ?(rank = 0.) tier = { tier; rank }

module type KEY = sig
  type t

  val equal : t -> t -> bool
  val hash : t -> int
end

(* The position of an item in service order: [group] 0 is bumped, 1 named by
   the focus list, 2 and above the tiers. [seq] is unique per item, so two
   slots never compare equal. *)
type 'k slot = { group : int; sub : float; seq : int; slot_key : 'k }

let compare_slots a b =
  match Int.compare a.group b.group with
  | 0 -> ( match Float.compare a.sub b.sub with 0 -> Int.compare a.seq b.seq | c -> c)
  | c -> c

let tier_group = function
  | Focus -> 2
  | Pinned -> 3
  | Recent -> 4
  | Visible -> 5
  | Rest -> 6

module Make (Key : KEY) = struct
  module Table = Hashtbl.Make (Key)

  module Order = Set.Make (struct
    type t = Key.t slot

    let compare = compare_slots
  end)

  type 'v entry = {
    mutable value : 'v;
    mutable base : priority;
    mutable bumped : int option;
    mutable slot : Key.t slot;
  }

  type 'v t = {
    entries : 'v entry Table.t;
    focus : int Table.t;
    mutable order : Order.t;
    mutable next_seq : int;
    mutable bumps : int;
  }

  let create () =
    {
      entries = Table.create 64;
      focus = Table.create 64;
      order = Order.empty;
      next_seq = 0;
      bumps = 0;
    }

  let slot_for t key ~seq ~base ~bumped =
    match (bumped, Table.find_opt t.focus key) with
    | Some bump, _ -> { group = 0; sub = -.float_of_int bump; seq; slot_key = key }
    | None, Some position -> { group = 1; sub = float_of_int position; seq; slot_key = key }
    | None, None -> { group = tier_group base.tier; sub = base.rank; seq; slot_key = key }

  (* Recompute an entry's slot after its base, bump or focus changed. *)
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

  let set_focus t keys =
    let previous = Table.fold (fun key _ acc -> key :: acc) t.focus [] in
    Table.reset t.focus;
    List.iteri
      (fun position key -> if not (Table.mem t.focus key) then Table.replace t.focus key position)
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
