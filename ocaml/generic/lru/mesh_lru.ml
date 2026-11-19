(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module type KEY = sig
  type t

  val equal : t -> t -> bool
  val hash : t -> int
end

module Make (Key : KEY) = struct
  module Table = Hashtbl.Make (Key)

  (* A doubly linked list threaded through the nodes: [newest] is the most
     recently used, [oldest] the next to evict. *)
  type 'v node = {
    key : Key.t;
    mutable value : 'v;
    mutable node_weight : int;
    mutable newer : 'v node option;
    mutable older : 'v node option;
  }

  type 'v weight = { limit : int; measure : 'v -> int }

  type 'v t = {
    table : 'v node Table.t;
    mutable newest : 'v node option;
    mutable oldest : 'v node option;
    mutable bound : int;
    weight : 'v weight option;
    mutable weight_total : int;
    on_evict : Key.t -> 'v -> unit;
  }

  let create ~max_entries ?weight ?(on_evict = fun _ _ -> ()) () =
    if max_entries < 1 then invalid_arg "Mesh_lru.create: max_entries < 1";
    Option.iter
      (fun w -> if w.limit < 0 then invalid_arg "Mesh_lru.create: weight limit < 0")
      weight;
    {
      table = Table.create (min max_entries 1024);
      newest = None;
      oldest = None;
      bound = max_entries;
      weight;
      weight_total = 0;
      on_evict;
    }

  let unlink t node =
    (match node.newer with
    | Some newer -> newer.older <- node.older
    | None -> t.newest <- node.older);
    (match node.older with
    | Some older -> older.newer <- node.newer
    | None -> t.oldest <- node.newer);
    node.newer <- None;
    node.older <- None

  let push_newest t node =
    node.older <- t.newest;
    node.newer <- None;
    (match t.newest with
    | Some previous -> previous.newer <- Some node
    | None -> t.oldest <- Some node);
    t.newest <- Some node

  let drop t node =
    unlink t node;
    Table.remove t.table node.key;
    t.weight_total <- t.weight_total - node.node_weight

  let over_bounds t =
    Table.length t.table > t.bound
    || match t.weight with Some w -> t.weight_total > w.limit | None -> false

  let rec evict t =
    match t.oldest with
    | Some node when over_bounds t ->
        drop t node;
        t.on_evict node.key node.value;
        evict t
    | _ -> ()

  let measure t value =
    match t.weight with Some w -> max 0 (w.measure value) | None -> 0

  let too_heavy t weight =
    match t.weight with Some w -> weight > w.limit | None -> false

  let add t key value =
    let weight = measure t value in
    (match Table.find_opt t.table key with Some node -> drop t node | None -> ());
    if too_heavy t weight then t.on_evict key value
    else begin
      let node = { key; value; node_weight = weight; newer = None; older = None } in
      Table.replace t.table key node;
      push_newest t node;
      t.weight_total <- t.weight_total + weight;
      evict t
    end

  let find t key =
    match Table.find_opt t.table key with
    | None -> None
    | Some node ->
        unlink t node;
        push_newest t node;
        Some node.value

  let peek t key = Option.map (fun node -> node.value) (Table.find_opt t.table key)
  let mem t key = Table.mem t.table key

  let remove t key =
    match Table.find_opt t.table key with Some node -> drop t node | None -> ()

  let clear t =
    Table.reset t.table;
    t.newest <- None;
    t.oldest <- None;
    t.weight_total <- 0

  let length t = Table.length t.table
  let total_weight t = t.weight_total
  let max_entries t = t.bound

  let set_max_entries t bound =
    if bound < 1 then invalid_arg "Mesh_lru.set_max_entries: bound < 1";
    t.bound <- bound;
    evict t

  let iter f t =
    let rec walk = function
      | None -> ()
      | Some node ->
          f node.key node.value;
          walk node.older
    in
    walk t.newest

  let to_list t =
    let items = ref [] in
    iter (fun key value -> items := (key, value) :: !items) t;
    List.rev !items

  let same_node a b =
    match (a, b) with Some a, Some b -> a == b | None, None -> true | _ -> false

  (* Walks from the newest node; returns the number of nodes and their weight. *)
  let check_links t =
    let rec walk count weight newer = function
      | None ->
          if not (same_node newer t.oldest) then failwith "oldest pointer is wrong";
          (count, weight)
      | Some node ->
          if not (same_node node.newer newer) then failwith "broken newer link";
          (match Table.find_opt t.table node.key with
          | Some indexed when indexed == node -> ()
          | _ -> failwith "node missing from table");
          walk (count + 1) (weight + node.node_weight) (Some node) node.older
    in
    walk 0 0 None t.newest

  let check_invariants t =
    let count, weight = check_links t in
    if count <> Table.length t.table then failwith "list length differs from table";
    if weight <> t.weight_total then failwith "total weight is wrong";
    if over_bounds t then failwith "a bound does not hold"
end
