(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Queue = Mesh_priority.Make (struct
  type t = string

  let equal = String.equal
  let hash = Hashtbl.hash
end)

let p = Mesh_priority.priority
let order queue = List.map fst (Queue.to_list queue)
let check message expected queue = Alcotest.(check (list string)) message expected (order queue)

let test_tiers_and_ranks () =
  let queue = Queue.create () in
  Queue.add queue "rest" (p Rest) ();
  Queue.add queue "recent-old" (p ~rank:(-10.) Recent) ();
  Queue.add queue "recent-new" (p ~rank:(-20.) Recent) ();
  Queue.add queue "visible" (p Visible) ();
  Queue.add queue "pinned" (p Pinned) ();
  Queue.add queue "focus" (p Focus) ();
  Queue.add queue "rest-2" (p Rest) ();
  check "tiers, then rank, then insertion"
    [ "focus"; "pinned"; "recent-new"; "recent-old"; "visible"; "rest"; "rest-2" ]
    queue;
  Alcotest.(check (option int)) "position" (Some 2) (Queue.position queue "recent-new")

let test_no_duplicates () =
  let queue = Queue.create () in
  Queue.add queue "a" (p Rest) 1;
  Queue.add queue "b" (p Rest) 2;
  Queue.add queue "a" (p Pinned) 3;
  Alcotest.(check int) "two items" 2 (Queue.length queue);
  Alcotest.(check (list (pair string int))) "replaced" [ ("a", 3); ("b", 2) ] (Queue.to_list queue)

let test_bump () =
  let queue = Queue.create () in
  List.iter (fun key -> Queue.add queue key (p Rest) ()) [ "a"; "b"; "c"; "d" ];
  Queue.set_focus queue [ "d" ];
  Alcotest.(check bool) "bump c" true (Queue.bump queue "c");
  Alcotest.(check bool) "bump b" true (Queue.bump queue "b");
  Alcotest.(check bool) "bump absent" false (Queue.bump queue "zz");
  check "latest bump first, then focus" [ "b"; "c"; "d"; "a" ] queue;
  Queue.add queue "b" (p Rest) ();
  check "re-adding keeps the bump" [ "b"; "c"; "d"; "a" ] queue

let test_focus () =
  let queue = Queue.create () in
  List.iter (fun key -> Queue.add queue key (p Recent) ()) [ "a"; "b"; "c" ];
  Queue.set_focus queue [ "c"; "later"; "a"; "c" ];
  check "focus order" [ "c"; "a"; "b" ] queue;
  Queue.add queue "later" (p Rest) ();
  check "a key added after the focus takes its place" [ "c"; "later"; "a"; "b" ] queue;
  Queue.set_focus queue [ "b" ];
  check "old focus falls back to its tier" [ "b"; "a"; "c"; "later" ] queue

let test_pop_and_requeue () =
  let queue = Queue.create () in
  Queue.add queue "a" (p Focus) 1;
  Queue.add queue "b" (p Rest) 2;
  Alcotest.(check (option (pair string int))) "peek" (Some ("a", 1)) (Queue.peek queue);
  Alcotest.(check (option (pair string int))) "pop" (Some ("a", 1)) (Queue.pop queue);
  Alcotest.(check bool) "popped is gone" false (Queue.mem queue "a");
  Queue.add queue "a" (p Rest) 5;
  check "requeued behind b" [ "b"; "a" ] queue;
  Queue.remove queue "b";
  Alcotest.(check (option (pair string int))) "pop a" (Some ("a", 5)) (Queue.pop queue);
  Alcotest.(check (option (pair string int))) "empty" None (Queue.pop queue);
  Alcotest.(check bool) "is empty" true (Queue.is_empty queue)

(* Property: popping everything gives the order of a sort by
   (focus position, tier, rank, insertion). *)
let tier_of_int = function
  | 0 -> Mesh_priority.Focus
  | 1 -> Pinned
  | 2 -> Recent
  | 3 -> Visible
  | _ -> Rest

let tier_index = function
  | Mesh_priority.Focus -> 0
  | Pinned -> 1
  | Recent -> 2
  | Visible -> 3
  | Rest -> 4

let model_order items focus =
  let focus_position key =
    let rec find index = function
      | [] -> None
      | head :: rest -> if head = key then Some index else find (index + 1) rest
    in
    find 0 focus
  in
  let last = Hashtbl.create 16 and first_seen = Hashtbl.create 16 in
  List.iteri
    (fun index (key, tier, rank) ->
      if not (Hashtbl.mem first_seen key) then Hashtbl.replace first_seen key index;
      Hashtbl.replace last key (tier, rank))
    items;
  let sort_key key =
    let tier, rank = Hashtbl.find last key in
    match focus_position key with
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
      ~print:(fun (items, focus) ->
        String.concat " " (List.map (fun (k, t, r) -> Printf.sprintf "%s/%d/%d" k t r) items)
        ^ " | " ^ String.concat "," focus)
      QCheck.Gen.(pair (list_size (int_bound 30) item) (list_size (int_bound 4) key))
  in
  Support.qcheck ~name:"service order matches a sort" arbitrary (fun (items, focus) ->
      let queue = Queue.create () in
      Queue.set_focus queue focus;
      List.iter
        (fun (key, tier, rank) ->
          Queue.add queue key (p ~rank:(float_of_int rank) (tier_of_int tier)) ())
        items;
      let rec drain acc = match Queue.pop queue with Some (key, ()) -> drain (key :: acc) | None -> List.rev acc in
      let model = model_order (List.map (fun (k, t, r) -> (k, tier_index (tier_of_int t), r)) items) focus in
      drain [] = model)

let () =
  Alcotest.run "mesh_priority"
    [
      ( "priority",
        [
          Alcotest.test_case "tiers and ranks" `Quick test_tiers_and_ranks;
          Alcotest.test_case "no duplicates" `Quick test_no_duplicates;
          Alcotest.test_case "bump" `Quick test_bump;
          Alcotest.test_case "focus list" `Quick test_focus;
          Alcotest.test_case "pop and requeue" `Quick test_pop_and_requeue;
          Alcotest.test_case "model (property)" `Quick test_model;
        ] );
    ]
