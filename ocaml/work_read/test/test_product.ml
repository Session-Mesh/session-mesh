(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [product]: every task of a product and of its child products, for the
   board and the timeline of the product page. Its scope and its counts are
   those of the [tree] of [products] (the counters of the left rail). *)

open Work_read_runner
module U = Yojson.Safe.Util

let ok repo args =
  let r = run repo args in
  if r.code <> 0 then
    Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

let ids doc =
  List.sort compare
    (List.map
       (fun t -> U.to_string (U.member "id" t))
       (U.to_list (U.member "tasks" doc)))

let tree_open repo product =
  let doc = ok repo [ "products" ] in
  let products =
    List.concat_map
      (fun c -> U.to_list (U.member "products" c))
      (U.to_list (U.member "categories" doc))
  in
  let row =
    List.find (fun p -> U.to_string (U.member "id" p) = product) products
  in
  U.to_int (U.member "open" (U.member "tree" row))

let open_columns doc =
  let counts = U.member "column_counts" doc in
  List.fold_left
    (fun n name -> n + U.to_int (U.member name counts))
    0
    [ "todo"; "in_progress"; "blocked"; "other" ]

(* relay holds relay-core and relay-edge: their tasks are in its document, and
   its open columns add up to its tree's open count. *)
let test_scope () =
  let repo = copy_fixture () in
  let doc = ok repo [ "product"; "relay" ] in
  Alcotest.(check (list string))
    "scope"
    [ "relay"; "relay-core"; "relay-edge" ]
    (List.map U.to_string (U.to_list (U.member "scope" doc)));
  Alcotest.(check (list string))
    "child products' tasks"
    [ "T-2d3e"; "T-3c4d"; "T-6b7c" ]
    (ids doc);
  Alcotest.(check int)
    "open columns = tree.open" (tree_open repo "relay") (open_columns doc);
  Alcotest.(check int)
    "totals.open = tree.open" (tree_open repo "relay")
    (U.to_int (U.member "open" (U.member "totals" doc)));
  let child = ok repo [ "product"; "relay-edge" ] in
  Alcotest.(check (list string))
    "a child alone" [ "T-3c4d"; "T-6b7c" ] (ids child);
  Alcotest.(check bool)
    "not truncated" false
    (U.to_bool (U.member "truncated" doc))

let test_every_product_agrees () =
  let repo = copy_fixture () in
  List.iter
    (fun product ->
      let doc = ok repo [ "product"; product ] in
      Alcotest.(check int)
        (product ^ " open") (tree_open repo product) (open_columns doc))
    [ "gateway"; "relay"; "relay-core"; "relay-edge"; "supplies" ]

let test_tags_and_request () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T12:00:00Z","task":"T-6b7c","type":"add","field":"tags","value":"harbour"}|};
    ];
  let r =
    run ~input:{|{"op":"product","args":{"id":"relay-edge"}}|} repo
      [ "--request" ]
  in
  Alcotest.(check int) "request exit" 0 r.code;
  let row =
    List.find
      (fun t -> U.to_string (U.member "id" t) = "T-6b7c")
      (U.to_list (U.member "tasks" (json r)))
  in
  Alcotest.(check string) "column" "in_progress" (U.to_string (U.member "column" row));
  Alcotest.(check (list string))
    "tags" [ "harbour" ]
    (List.map U.to_string (U.to_list (U.member "tags" row)))

let test_refusals () =
  let repo = copy_fixture () in
  Alcotest.(check int)
    "unknown product" 3 (run repo [ "product"; "nowhere" ]).code;
  Alcotest.(check int) "no id" 2 (run repo [ "product" ]).code;
  Alcotest.(check int)
    "two ids" 2 (run repo [ "product"; "relay"; "gateway" ]).code;
  Alcotest.(check int)
    "hostile id" 2 (run repo [ "product"; "<img src=x>" ]).code;
  Alcotest.(check int)
    "flag as id" 2
    (run ~input:{|{"op":"product","args":{"id":"--all"}}|} repo [ "--request" ])
      .code;
  Alcotest.(check int)
    "number id" 2
    (run ~input:{|{"op":"product","args":{"id":7}}|} repo [ "--request" ]).code

(* Past 1000 tasks the list is cut: the rest is counted, the document says it
   is truncated, and the column counts still cover every task. *)
let test_cap () =
  let repo = copy_fixture () in
  let n = 1010 in
  append_events repo
    (List.init n (fun i ->
         Printf.sprintf
           {|{"ts":"2026-11-09T%02d:%02d:%02dZ","task":"T-%05x","type":"created","title":"Bulk %d","project":"relay-core","category":"platform","priority":"P2","status":"todo"}|}
           (10 + (i / 3600))
           (i / 60 mod 60)
           (i mod 60) (0x90000 + i) i));
  let r = run repo [ "product"; "relay" ] in
  Alcotest.(check int) "exit" 0 r.code;
  let doc = json r in
  Alcotest.(check int)
    "tasks capped" 1000
    (List.length (U.to_list (U.member "tasks" doc)));
  Alcotest.(check int)
    "omitted counted"
    (n + 3 - 1000)
    (U.to_int (U.member "tasks_omitted" doc));
  Alcotest.(check bool) "truncated" true (U.to_bool (U.member "truncated" doc));
  Alcotest.(check int)
    "counts cover every task" (tree_open repo "relay") (open_columns doc);
  Alcotest.(check bool)
    "within the output bound" true
    (String.length r.out < 1_000_000)

let tests =
  [
    Alcotest.test_case "scope" `Quick test_scope;
    Alcotest.test_case "every product agrees with products" `Quick
      test_every_product_agrees;
    Alcotest.test_case "tags and request" `Quick test_tags_and_request;
    Alcotest.test_case "refusals" `Quick test_refusals;
    Alcotest.test_case "cap" `Quick test_cap;
  ]
