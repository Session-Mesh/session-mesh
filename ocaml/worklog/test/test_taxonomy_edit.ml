(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Adding a product to taxonomy.yaml: every other byte preserved. *)

open Mesh_worklog
open Tutil

let base =
  "# Fictional taxonomy.\n\
   categories:\n\
  \  platform:   # the tree category\n\
  \    name: Platform\n\
  \    products:\n\
  \      - gateway\n\
  \      - relay:   # has children\n\
  \          - relay-core\n\
  \          - 'relay-edge'\n\
  \n\
  \  office:\n\
  \    name: Office\n\
  \    projects:\n\
  \    - supplies\n\
  \    - \"stationery\"\n"

let insert ?parent text ~id ~category = Taxonomy_edit.insert text ~id ~category ~parent

let insert_ok ?parent text ~id ~category =
  match insert ?parent text ~id ~category with
  | Ok t -> t
  | Error why -> Alcotest.failf "unexpected refusal: %s" why

let refused name r = Alcotest.(check bool) name true (Result.is_error r)

let test_root_insertion () =
  let edited = insert_ok base ~id:"harbour" ~category:"platform" in
  let expected =
    "# Fictional taxonomy.\ncategories:\n  platform:   # the tree category\n    name: Platform\n    products:\n      - gateway\n      - relay:   # has children\n          - relay-core\n          - 'relay-edge'\n      - harbour\n\n  office:\n    name: Office\n    projects:\n    - supplies\n    - \"stationery\"\n"
  in
  Alcotest.(check string) "after the last item of its category, children included" expected edited;
  let tax = Result.get_ok (Taxonomy.of_string edited) in
  Alcotest.(check (list string)) "reads as the old taxonomy plus one product"
    [ "gateway"; "relay"; "relay-core"; "relay-edge"; "harbour"; "supplies"; "stationery" ]
    (Taxonomy.products tax);
  let legacy = insert_ok base ~id:"paper" ~category:"office" in
  Alcotest.(check bool) "legacy projects list, indentless sequence kept" true
    (contains ~sub:"    - \"stationery\"\n    - paper\n" legacy)

let test_child_insertion () =
  let under_map = insert_ok base ~id:"relay-hub" ~category:"platform" ~parent:"relay" in
  Alcotest.(check bool) "after the last child, same indent" true
    (contains ~sub:"          - 'relay-edge'\n          - relay-hub\n\n  office:" under_map);
  let under_plain = insert_ok base ~id:"gateway-eu" ~category:"platform" ~parent:"gateway" in
  Alcotest.(check bool) "a plain parent becomes a mapping, other bytes untouched" true
    (contains ~sub:"      - gateway:\n          - gateway-eu\n      - relay:   # has children\n" under_plain);
  let tax = Result.get_ok (Taxonomy.of_string under_plain) in
  Alcotest.(check (list string)) "tree" [ "gateway"; "gateway-eu" ] (Taxonomy.descendants tax "gateway");
  let quoted =
    "categories:\n  a:\n    name: A\n    products:\n      - 'solo'   # quoted\n      - other\n"
  in
  Alcotest.(check string) "quoted parent keeps its quotes and comment"
    "categories:\n  a:\n    name: A\n    products:\n      - 'solo':   # quoted\n          - kid\n      - other\n"
    (insert_ok quoted ~id:"kid" ~category:"a" ~parent:"solo")

let test_bytes_preserved () =
  let strip_new ~id edited =
    String.concat "\n" (List.filter (fun l -> not (contains ~sub:id l)) (String.split_on_char '\n' edited))
  in
  Alcotest.(check string) "removing the new line gives back the original" base
    (strip_new ~id:"harbour" (insert_ok base ~id:"harbour" ~category:"platform"));
  let crlf = String.concat "\r\n" (String.split_on_char '\n' base) in
  let edited = insert_ok crlf ~id:"harbour" ~category:"platform" in
  Alcotest.(check bool) "CRLF kept, new line ends with CRLF" true (contains ~sub:"      - harbour\r\n" edited);
  Alcotest.(check bool) "no bare LF introduced" false (contains ~sub:"harbour\n" edited);
  let no_final = "categories:\n  a:\n    name: A\n    projects:\n      - x" in
  Alcotest.(check string) "a missing final newline stays missing"
    "categories:\n  a:\n    name: A\n    projects:\n      - x\n      - yy"
    (insert_ok no_final ~id:"yy" ~category:"a")

let test_refusals () =
  let try_ ?parent ?(category = "platform") name id = refused name (insert ?parent base ~id ~category) in
  try_ "duplicate id" "gateway";
  try_ "duplicate id in another category" "supplies";
  try_ "unknown category" ~category:"nope" "x1";
  try_ "unknown parent" ~parent:"nope" "x1";
  try_ "parent is itself a child" ~parent:"relay-core" "x1";
  try_ "parent in another category" ~parent:"supplies" "x1";
  refused "legacy list takes no parent" (insert base ~id:"x1" ~category:"office" ~parent:"supplies");
  List.iter
    (fun (name, id) -> refused name (Taxonomy_edit.check_id id |> Result.map (fun () -> "")))
    [ ("space", "a b"); ("YAML boolean", "yes"); ("YAML null", "null"); ("number", "12");
      ("task-id lookalike", "t-ab12"); ("project-id lookalike", "P-00ff"); ("empty", "");
      ("too long", String.make 65 'a'); ("leading dash", "-x"); ("colon", "product:x") ];
  Alcotest.(check bool) "ordinary ids pass" true
    (List.for_all (fun id -> Taxonomy_edit.check_id id = Ok ()) [ "harbour"; "relay.v2"; "a1"; "x-y_z" ])

let test_unsupported_layouts () =
  let layout name text = refused name (insert text ~id:"new1" ~category:"a") in
  let head = "categories:\n  a:\n    name: A\n" in
  layout "flow list" (head ^ "    projects: [x, y]\n");
  layout "tab" (head ^ "    projects:\n\t- x\n");
  layout "anchor" (head ^ "    projects: &p\n      - x\n");
  layout "block scalar name" "categories:\n  a:\n    name: |\n      A\n    projects:\n      - x\n";
  layout "mixed line endings" (head ^ "    projects:\r\n      - x\n");
  layout "BOM" ("\xef\xbb\xbf" ^ head ^ "    projects:\n      - x\n");
  layout "two lists" (head ^ "    projects:\n      - x\n    products:\n      - y\n");
  layout "not a taxonomy" "projects:\n  - x\n";
  layout "empty list" (head ^ "    projects: []\n")

(* ---- the operation ------------------------------------------------------- *)

let write_taxonomy root text = write_file (Filename.concat root "taxonomy.yaml") text

let test_add_product_operation () =
  let root = Filename.concat (temp_dir "wltaxop") "repo" in
  ok (Init.init ~root ~category:"platform" ~category_name:"Platform" ~product:"gateway" ());
  let path = Filename.concat root "taxonomy.yaml" in
  let c = ctx ~commit:true ~warn:(fun w -> Alcotest.failf "warning: %s" w) root in
  let original = read_file path in
  ok (Taxonomy_edit.add_product c ~id:"relay" ~category:"platform" ());
  ok (Taxonomy_edit.add_product c ~id:"relay-core" ~category:"platform" ~parent:"relay" ());
  Alcotest.(check string) "file edited in place" (original ^ "      - relay:\n          - relay-core\n") (read_file path);
  Alcotest.(check string) "commit message" "wl: product add relay-core" (git root [ "log"; "-1"; "--format=%s" ]);
  Alcotest.(check string) "only taxonomy.yaml committed" "taxonomy.yaml"
    (git root [ "show"; "--name-only"; "--format="; "HEAD" ]);
  Alcotest.(check bool) "no temporary file left" true
    (List.for_all (fun f -> not (contains ~sub:".tmp" f)) (Array.to_list (Sys.readdir root)));
  let before = tree_snapshot root in
  check_error "duplicate" Err.Usage (Taxonomy_edit.add_product c ~id:"relay" ~category:"platform" ());
  check_error "bad id" Err.Usage (Taxonomy_edit.add_product c ~id:"yes" ~category:"platform" ());
  Alcotest.(check bool) "refusals leave every file untouched" true (before = tree_snapshot root);
  let id = ok (Write_task.add c ~title:"In the new product" ~product:"relay-core" ()) in
  Alcotest.(check bool) "the new product is usable at once" true
    ((task_exn (load root).world id).category = "platform");
  let tax = ok (Taxonomy.load path) in
  Alcotest.(check (list string)) "roll-up through the new tree" [ "relay"; "relay-core" ] (Taxonomy.descendants tax "relay")

let test_add_product_symlink_and_lock () =
  let root = Filename.concat (temp_dir "wltaxlink") "repo" in
  ok (Init.init ~root ~git:false ());
  let elsewhere = Filename.concat (temp_dir "wltaxout") "taxonomy.yaml" in
  write_taxonomy (Filename.dirname elsewhere) "";
  write_file elsewhere (read_file (Filename.concat root "taxonomy.yaml"));
  Sys.remove (Filename.concat root "taxonomy.yaml");
  Unix.symlink elsewhere (Filename.concat root "taxonomy.yaml");
  let c = ctx ~lock_timeout:0.2 root in
  check_error "taxonomy resolving outside the repository" Err.Usage
    (Taxonomy_edit.add_product c ~id:"extra" ~category:"main" ());
  Sys.remove (Filename.concat root "taxonomy.yaml");
  write_file (Filename.concat root "taxonomy.yaml") (read_file elsewhere);
  Lock.with_lock ~path:(Ctx.lock_path c) ~timeout:1.0 (fun () ->
      check_error "lock held" Err.Lock_timeout (Taxonomy_edit.add_product c ~id:"extra" ~category:"main" ()))

let () =
  Alcotest.run "worklog taxonomy edit"
    [ ( "insertion",
        [ Alcotest.test_case "root" `Quick test_root_insertion;
          Alcotest.test_case "child" `Quick test_child_insertion;
          Alcotest.test_case "other bytes preserved" `Quick test_bytes_preserved ] );
      ( "refusals",
        [ Alcotest.test_case "ids and placement" `Quick test_refusals;
          Alcotest.test_case "unsupported layouts" `Quick test_unsupported_layouts ] );
      ( "operation",
        [ Alcotest.test_case "edit, verify, replace, commit" `Quick test_add_product_operation;
          Alcotest.test_case "symlink and lock" `Quick test_add_product_symlink_and_lock ] ) ]
