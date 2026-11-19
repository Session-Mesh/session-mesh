(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The tiers are the caller's: any ordered type. *)
module Tier = struct
  type t = Urgent | High | Normal | Low | Idle

  let compare = Stdlib.compare
end

open Tier

module Queue =
  Mesh_priority.Make
    (struct
      type t = string

      let equal = String.equal
      let hash = Hashtbl.hash
    end)
    (Tier)

let p = Queue.priority
let order queue = List.map fst (Queue.to_list queue)
let check message expected queue = Alcotest.(check (list string)) message expected (order queue)

let test_tiers_and_ranks () =
  let queue = Queue.create () in
  Queue.add queue "idle" (p Idle) ();
  Queue.add queue "normal-old" (p ~rank:(-10.) Normal) ();
  Queue.add queue "normal-new" (p ~rank:(-20.) Normal) ();
  Queue.add queue "low" (p Low) ();
  Queue.add queue "high" (p High) ();
  Queue.add queue "urgent" (p Urgent) ();
  Queue.add queue "idle-2" (p Idle) ();
  check "tiers, then rank, then insertion"
    [ "urgent"; "high"; "normal-new"; "normal-old"; "low"; "idle"; "idle-2" ]
    queue;
  Alcotest.(check (option int)) "position" (Some 2) (Queue.position queue "normal-new")

let test_no_duplicates () =
  let queue = Queue.create () in
  Queue.add queue "a" (p Idle) 1;
  Queue.add queue "b" (p Idle) 2;
  Queue.add queue "a" (p High) 3;
  Alcotest.(check int) "two items" 2 (Queue.length queue);
  Alcotest.(check (list (pair string int))) "replaced" [ ("a", 3); ("b", 2) ] (Queue.to_list queue)

let test_bump () =
  let queue = Queue.create () in
  List.iter (fun key -> Queue.add queue key (p Idle) ()) [ "a"; "b"; "c"; "d" ];
  Queue.set_leading queue [ "d" ];
  Alcotest.(check bool) "bump c" true (Queue.bump queue "c");
  Alcotest.(check bool) "bump b" true (Queue.bump queue "b");
  Alcotest.(check bool) "bump absent" false (Queue.bump queue "zz");
  check "latest bump first, then the leading list" [ "b"; "c"; "d"; "a" ] queue;
  Queue.add queue "b" (p Idle) ();
  check "re-adding keeps the bump" [ "b"; "c"; "d"; "a" ] queue

let test_leading () =
  let queue = Queue.create () in
  List.iter (fun key -> Queue.add queue key (p Normal) ()) [ "a"; "b"; "c" ];
  Queue.set_leading queue [ "c"; "later"; "a"; "c" ];
  check "leading order" [ "c"; "a"; "b" ] queue;
  Queue.add queue "later" (p Idle) ();
  check "a key added after set_leading takes its place" [ "c"; "later"; "a"; "b" ] queue;
  Queue.set_leading queue [ "b" ];
  check "a key no longer leading falls back to its tier" [ "b"; "a"; "c"; "later" ] queue

let test_pop_and_requeue () =
  let queue = Queue.create () in
  Queue.add queue "a" (p Urgent) 1;
  Queue.add queue "b" (p Idle) 2;
  Alcotest.(check (option (pair string int))) "peek" (Some ("a", 1)) (Queue.peek queue);
  Alcotest.(check (option (pair string int))) "pop" (Some ("a", 1)) (Queue.pop queue);
  Alcotest.(check bool) "popped is gone" false (Queue.mem queue "a");
  Queue.add queue "a" (p Idle) 5;
  check "requeued behind b" [ "b"; "a" ] queue;
  Queue.remove queue "b";
  Alcotest.(check (option (pair string int))) "pop a" (Some ("a", 5)) (Queue.pop queue);
  Alcotest.(check (option (pair string int))) "empty" None (Queue.pop queue);
  Alcotest.(check bool) "is empty" true (Queue.is_empty queue)

(* Another caller's tiers: integers, the largest served first. *)
let test_caller_tiers () =
  let module By_level =
    Mesh_priority.Make
      (Int)
      (struct
        type t = int

        let compare a b = Int.compare b a
      end)
  in
  let queue = By_level.create () in
  List.iter (fun (key, level) -> By_level.add queue key (By_level.priority level) ()) [ (1, 0); (2, 9); (3, 4) ];
  By_level.set_leading queue [ 1 ];
  Alcotest.(check (list int)) "leading, then by the caller's order" [ 1; 2; 3 ]
    (List.map fst (By_level.to_list queue))

(* Property: popping everything gives the order of a sort by
   (leading position, tier, rank, insertion). *)
let tier_of_int = function
  | 0 -> Urgent
  | 1 -> High
  | 2 -> Normal
  | 3 -> Low
  | _ -> Idle

let tier_index = function
  | Urgent -> 0
  | High -> 1
  | Normal -> 2
  | Low -> 3
  | Idle -> 4

let model_order items leading =
  let leading_position key =
    let rec find index = function
      | [] -> None
      | head :: rest -> if head = key then Some index else find (index + 1) rest
    in
    find 0 leading
  in
  let last = Hashtbl.create 16 and first_seen = Hashtbl.create 16 in
  List.iteri
    (fun index (key, tier, rank) ->
      if not (Hashtbl.mem first_seen key) then Hashtbl.replace first_seen key index;
      Hashtbl.replace last key (tier, rank))
    items;
  let sort_key key =
    let tier, rank = Hashtbl.find last key in
    match leading_position key with
    | Some position -> (0, float_of_int position, Hashtbl.find first_seen key)
    | None -> (1 + tier, float_of_int rank, Hashtbl.find first_seen key)
  in
  Hashtbl.fold (fun key _ acc -> key :: acc) last []
  |> List.sort (fun a b -> compare (sort_key a) (sort_key b))

let test_model () =
  let key = QCheck.Gen.(map (fun index -> String.make 1 (Char.chr (97 + index))) (int_bound 7)) in
  let item = QCheck.Gen.(triple key (int_bound 4) (int_range (-3) 3)) in
  let arbitrary =
    QCheck.make
      ~print:(fun (items, leading) ->
        String.concat " " (List.map (fun (k, t, r) -> Printf.sprintf "%s/%d/%d" k t r) items)
        ^ " | " ^ String.concat "," leading)
      QCheck.Gen.(pair (list_size (int_bound 30) item) (list_size (int_bound 4) key))
  in
  Support.qcheck ~name:"service order matches a sort" arbitrary (fun (items, leading) ->
      let queue = Queue.create () in
      Queue.set_leading queue leading;
      List.iter
        (fun (key, tier, rank) ->
          Queue.add queue key (p ~rank:(float_of_int rank) (tier_of_int tier)) ())
        items;
      let rec drain acc = match Queue.pop queue with Some (key, ()) -> drain (key :: acc) | None -> List.rev acc in
      let model = model_order (List.map (fun (k, t, r) -> (k, tier_index (tier_of_int t), r)) items) leading in
      drain [] = model)

let () =
  Alcotest.run "mesh_priority"
    [
      ( "priority",
        [
          Alcotest.test_case "tiers and ranks" `Quick test_tiers_and_ranks;
          Alcotest.test_case "no duplicates" `Quick test_no_duplicates;
          Alcotest.test_case "bump" `Quick test_bump;
          Alcotest.test_case "leading list" `Quick test_leading;
          Alcotest.test_case "pop and requeue" `Quick test_pop_and_requeue;
          Alcotest.test_case "caller tiers" `Quick test_caller_tiers;
          Alcotest.test_case "model (property)" `Quick test_model;
        ] );
    ]
