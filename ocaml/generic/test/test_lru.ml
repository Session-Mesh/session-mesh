(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Lru = Mesh_lru.Make (struct
  type t = string

  let equal = String.equal
  let hash = Hashtbl.hash
end)

let keys lru = List.map fst (Lru.to_list lru)
let check_keys message expected lru = Alcotest.(check (list string)) message expected (keys lru)

let test_count_bound () =
  let evicted = ref [] in
  let lru = Lru.create ~max_entries:2 ~on_evict:(fun key _ -> evicted := key :: !evicted) () in
  Lru.add lru "a" 1;
  Lru.add lru "b" 2;
  Lru.add lru "c" 3;
  check_keys "newest first" [ "c"; "b" ] lru;
  Alcotest.(check (list string)) "a evicted" [ "a" ] !evicted;
  Lru.check_invariants lru

let test_find_promotes_peek_does_not () =
  let lru = Lru.create ~max_entries:2 () in
  Lru.add lru "a" 1;
  Lru.add lru "b" 2;
  Alcotest.(check (option int)) "peek" (Some 1) (Lru.peek lru "a");
  check_keys "peek keeps order" [ "b"; "a" ] lru;
  Alcotest.(check (option int)) "find" (Some 1) (Lru.find lru "a");
  Lru.add lru "c" 3;
  check_keys "b was the oldest" [ "c"; "a" ] lru;
  Lru.check_invariants lru

let test_replace () =
  let evicted = ref 0 in
  let lru = Lru.create ~max_entries:3 ~on_evict:(fun _ _ -> incr evicted) () in
  Lru.add lru "a" 1;
  Lru.add lru "b" 2;
  Lru.add lru "a" 10;
  check_keys "one a, now newest" [ "a"; "b" ] lru;
  Alcotest.(check (option int)) "new value" (Some 10) (Lru.peek lru "a");
  Alcotest.(check int) "replacement is no eviction" 0 !evicted;
  Lru.check_invariants lru

let string_weight limit = { Lru.limit; measure = String.length }

let test_weight_bound () =
  let evicted = ref [] in
  let lru =
    Lru.create ~max_entries:10 ~weight:(string_weight 10)
      ~on_evict:(fun key _ -> evicted := key :: !evicted)
      ()
  in
  Lru.add lru "a" "xxxx";
  Lru.add lru "b" "xxxx";
  Lru.add lru "c" "xxxx";
  check_keys "a evicted by weight" [ "c"; "b" ] lru;
  Alcotest.(check int) "total" 8 (Lru.total_weight lru);
  Lru.add lru "b" "xxxxxxxxxxx";
  check_keys "too heavy alone: not kept, old b gone" [ "c" ] lru;
  Alcotest.(check (list string)) "reported" [ "b"; "a" ] !evicted;
  Alcotest.(check int) "total after" 4 (Lru.total_weight lru);
  Lru.check_invariants lru

let test_resize_remove_clear () =
  let lru = Lru.create ~max_entries:4 () in
  List.iter (fun key -> Lru.add lru key 0) [ "a"; "b"; "c"; "d" ];
  Lru.set_max_entries lru 2;
  check_keys "shrunk" [ "d"; "c" ] lru;
  Lru.remove lru "d";
  Lru.remove lru "absent";
  check_keys "removed" [ "c" ] lru;
  Lru.check_invariants lru;
  Lru.clear lru;
  Alcotest.(check int) "cleared" 0 (Lru.length lru);
  Lru.check_invariants lru;
  Alcotest.check_raises "bound below 1" (Invalid_argument "Mesh_lru.set_max_entries: bound < 1")
    (fun () -> Lru.set_max_entries lru 0)

(* A model: the list of (key, value), newest first, cut to the bound. *)
type operation = Add of string * int | Find of string | Remove of string

let apply_model bound model = function
  | Add (key, value) ->
      let rest = List.remove_assoc key model in
      List.filteri (fun index _ -> index < bound) ((key, value) :: rest)
  | Find key -> (
      match List.assoc_opt key model with
      | Some value -> (key, value) :: List.remove_assoc key model
      | None -> model)
  | Remove key -> List.remove_assoc key model

let apply_lru lru = function
  | Add (key, value) -> Lru.add lru key value
  | Find key -> ignore (Lru.find lru key)
  | Remove key -> Lru.remove lru key

let operation_gen =
  let open QCheck.Gen in
  let key = map (fun index -> String.make 1 (Char.chr (97 + index))) (int_bound 6) in
  oneof_weighted
    [
      (5, map2 (fun key value -> Add (key, value)) key nat_small);
      (3, map (fun key -> Find key) key);
      (1, map (fun key -> Remove key) key);
    ]

let show = function
  | Add (key, value) -> Printf.sprintf "add %s %d" key value
  | Find key -> "find " ^ key
  | Remove key -> "remove " ^ key

let test_model () =
  let arbitrary =
    QCheck.make
      ~print:(fun (bound, operations) ->
        string_of_int bound ^ ": " ^ String.concat "; " (List.map show operations))
      QCheck.Gen.(pair (int_range 1 5) (list_size (int_bound 60) operation_gen))
  in
  Support.qcheck ~name:"lru agrees with a list model" arbitrary (fun (bound, operations) ->
      let lru = Lru.create ~max_entries:bound () in
      let model =
        List.fold_left
          (fun model operation ->
            apply_lru lru operation;
            Lru.check_invariants lru;
            apply_model bound model operation)
          [] operations
      in
      Lru.to_list lru = model)

let () =
  Alcotest.run "mesh_lru"
    [
      ( "lru",
        [
          Alcotest.test_case "entry bound" `Quick test_count_bound;
          Alcotest.test_case "find promotes, peek does not" `Quick test_find_promotes_peek_does_not;
          Alcotest.test_case "replace" `Quick test_replace;
          Alcotest.test_case "weight bound" `Quick test_weight_bound;
          Alcotest.test_case "resize, remove, clear" `Quick test_resize_remove_clear;
          Alcotest.test_case "model (property)" `Quick test_model;
        ] );
    ]
