(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_client

let expected_tools =
  [
    "work_resume"; "work_list_tasks"; "work_get"; "work_list_projects"; "work_list_products";
    "work_add_task"; "work_add_project"; "work_add_product"; "work_update"; "work_log";
    "work_block"; "work_unblock"; "work_find_sessions"; "work_get_session"; "work_ask"; "work_answer";
    "work_list_questions"; "work_open_view"; "work_attempt";
  ]


let check_str msg expected actual = Alcotest.(check string) msg expected actual

let test_handshake () =
  let home, wl_home = fresh () in
  let c = start ~wl_home ~home () in
  let init = initialize c in
  let instructions = str (member "result" init) "instructions" in
  List.iter
    (fun needle -> Alcotest.(check bool) ("instructions mention " ^ needle) true (contains instructions needle))
    [ "work_resume"; "work_ask"; "untrusted"; "assumption"; "directly"; "work_log" ];
  let listed = rpc c "tools/list" (`Assoc []) in
  let tools = items (member "result" listed) "tools" in
  let names = List.map (fun t -> str t "name") tools in
  Alcotest.(check (list string)) "the 19 tools" (List.sort compare expected_tools) (List.sort compare names);
  List.iter
    (fun t ->
      let schema = member "inputSchema" t in
      Alcotest.(check bool) (str t "name" ^ " rejects unknown fields") true
        (member "additionalProperties" schema = `Bool false))
    tools;
  stop c

let test_read_tools () =
  with_server (fun c _ ->
      let products = ok c "work_list_products" (`Assoc []) in
      let flat = Yojson.Safe.to_string products in
      Alcotest.(check bool) "tree has relay-core" true (contains flat "relay-core");
      Alcotest.(check bool) "tree has its parent" true (contains flat "\"parent\":\"relay\"");
      let project =
        str (ok c "work_add_project" (`Assoc [ ("title", `String "Launch"); ("product", `String "gateway"); ("quarter", `String "2026Q4") ])) "id"
      in
      let task_a =
        str (ok c "work_add_task" (`Assoc [ ("title", `String "Write the spec"); ("product", `String "gateway"); ("project", `String project); ("notes", `String "initial body text") ])) "id"
      in
      let task_b = str (ok c "work_add_task" (`Assoc [ ("title", `String "Core work"); ("product", `String "relay-core") ])) "id" in
      let listed = ok c "work_list_tasks" (`Assoc [ ("product", `String "relay") ]) in
      Alcotest.(check (list string)) "descendants rolled up" [ task_b ] (List.map (fun t -> str t "id") (items listed "tasks"));
      let by_project = ok c "work_list_tasks" (`Assoc [ ("project", `String project) ]) in
      Alcotest.(check int) "by project" 1 (List.length (items by_project "tasks"));
      let got = ok c "work_get" (`Assoc [ ("id", `String task_a) ]) in
      check_str "kind" "task" (str got "kind");
      check_str "body of the task file" "initial body text" (str got "notes");
      Alcotest.(check bool) "session linked" true (contains (Yojson.Safe.to_string (member "sessions" got)) "probe-session");
      let rec unique_prefix n =
        let prefix = String.sub task_a 0 n in
        if n < String.length task_a && String.starts_with ~prefix task_b then unique_prefix (n + 1)
        else prefix
      in
      let prefix = unique_prefix 4 in
      check_str "id prefix" task_a (str (member "task" (ok c "work_get" (`Assoc [ ("id", `String prefix) ]))) "id");
      let p = ok c "work_get" (`Assoc [ ("id", `String project) ]) in
      check_str "project kind" "project" (str p "kind");
      Alcotest.(check int) "project tasks" 1 (List.length (items p "tasks"));
      let projects = ok c "work_list_projects" (`Assoc []) in
      Alcotest.(check int) "one project" 1 (List.length (items projects "projects"));
      let resume = ok c "work_resume" (`Assoc []) in
      Alcotest.(check bool) "here section" true (contains (Yojson.Safe.to_string (member "here" resume)) task_a))

let status_of c task = str (member "task" (ok c "work_get" (`Assoc [ ("id", `String task) ]))) "status"

let test_write_tools () =
  with_server (fun c wl_home ->
      let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "T"); ("product", `String "gateway") ])) "id" in
      let upd args = ok c "work_update" (`Assoc (("id", `String task) :: args)) in
      ignore (upd [ ("set", `Assoc [ ("status", `String "in_progress"); ("priority", `String "P1") ]); ("add", `Assoc [ ("tags", `List [ `String "a"; `String "b" ]) ]) ]);
      check_str "status changed" "in_progress" (status_of c task);
      let again = upd [ ("set", `Assoc [ ("status", `String "in_progress") ]) ] in
      Alcotest.(check bool) "unchanged reported" true (contains (Yojson.Safe.to_string again) "unchanged");
      ignore (upd [ ("remove", `Assoc [ ("tags", `List [ `String "a" ]) ]) ]);
      Alcotest.(check bool) "tag removed" true
        (not (contains (Yojson.Safe.to_string (member "task" (ok c "work_get" (`Assoc [ ("id", `String task) ])))) "\"a\""));
      List.iter
        (fun kind ->
          ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("kind", `String kind); ("text", `String ("entry " ^ kind)) ])))
        [ "progress"; "note"; "decision"; "learning"; "risk"; "metric"; "mentoring" ];
      ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("kind", `String "shipped"); ("text", `String "released"); ("date", `String "2026-11-18"); ("prov", `String "confirmed") ]));
      Alcotest.(check bool) "shipped date stored" true (contains (events_text wl_home) "\"date\":\"2026-11-18\"");
      Alcotest.(check bool) "provenance stored" true (contains (events_text wl_home) "\"prov\":\"confirmed\"");
      let blocker = str (ok c "work_block" (`Assoc [ ("id", `String task); ("text", `String "waiting for review"); ("kind", `String "review") ])) "blocker" in
      let got = ok c "work_get" (`Assoc [ ("id", `String task) ]) in
      Alcotest.(check int) "one open blocker" 1 (List.length (items got "open_blockers"));
      check_str "unblock" blocker (str (ok c "work_unblock" (`Assoc [ ("id", `String task) ])) "blocker");
      let again = call c "work_unblock" (`Assoc [ ("id", `String task) ]) in
      Alcotest.(check bool) "no open blocker left" true again.is_error;
      let product = ok c "work_add_product" (`Assoc [ ("id", `String "edge"); ("category", `String "main"); ("parent", `String "relay") ]) in
      check_str "product added" "edge" (str product "id");
      Alcotest.(check bool) "visible in the tree" true (contains (Yojson.Safe.to_string (ok c "work_list_products" (`Assoc []))) "edge");
      let project = str (ok c "work_add_project" (`Assoc [ ("title", `String "P"); ("product", `String "gateway") ])) "id" in
      ignore (ok c "work_update" (`Assoc [ ("id", `String project); ("set", `Assoc [ ("goal", `String "ship it") ]); ("add", `Assoc [ ("risks", `List [ `String "late" ]) ]) ]));
      Alcotest.(check bool) "project goal" true (contains (Yojson.Safe.to_string (ok c "work_get" (`Assoc [ ("id", `String project) ]))) "ship it"))

let bad c name args expected_code =
  let r = call c name args in
  Alcotest.(check bool) (name ^ " is an error") true r.is_error;
  if expected_code <> "" then check_str (name ^ " code") expected_code (error_code r)

let test_bad_inputs () =
  with_server (fun c wl_home ->
      let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "T"); ("product", `String "gateway") ])) "id" in
      let before = List.length (event_lines wl_home) in
      bad c "work_list_tasks" (`Assoc [ ("bogus", `Int 1) ]) "";
      bad c "work_list_tasks" (`Assoc [ ("status", `List [ `String "nonsense" ]) ]) "";
      bad c "work_get" (`Assoc [ ("id", `String "xyz") ]) "invalid_input";
      bad c "work_get" (`Assoc [ ("id", `String "T-ffff") ]) "not_found";
      bad c "work_add_task" (`Assoc [ ("title", `String "x"); ("product", `String "nowhere") ]) "invalid_input";
      bad c "work_add_task" (`Assoc [ ("title", `String "x"); ("product", `String "gateway"); ("extra", `Int 1) ]) "";
      bad c "work_update" (`Assoc [ ("id", `String task) ]) "invalid_input";
      bad c "work_update" (`Assoc [ ("id", `String task); ("set", `Assoc [ ("status", `String "weird") ]) ]) "invalid_input";
      bad c "work_update" (`Assoc [ ("id", `String task); ("set", `Assoc [ ("color", `String "red") ]) ]) "";
      bad c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x"); ("kind", `String "question") ]) "";
      bad c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x"); ("kind", `String "shipped"); ("date", `String "2026-13-45") ]) "invalid_input";
      bad c "work_log" (`Assoc [ ("id", `String "P-0000"); ("text", `String "x") ]) "";
      bad c "work_unblock" (`Assoc [ ("id", `String task); ("blocker", `String "B-zzzz") ]) "";
      bad c "work_find_sessions" (`Assoc []) "invalid_input";
      bad c "work_find_sessions" (`Assoc [ ("product", `String "gateway"); ("include_closed", `Bool false) ]) "not_available";
      bad c "work_get_session" (`Assoc [ ("session", `String "nobody") ]) "not_found";
      bad c "work_open_view" (`Assoc [ ("target", `String "T-ffff") ]) "not_found";
      bad c "work_open_view" (`Assoc [ ("target", `String task); ("view", `String "weird") ]) "";
      bad c "work_no_such_tool" (`Assoc []) "";
      Alcotest.(check int) "failed calls wrote nothing" before (List.length (event_lines wl_home)))

let test_sessions_and_view () =
  with_server (fun c _ ->
      let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "S"); ("product", `String "gateway"); ("track", `String "alpha") ])) "id" in
      ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "did a thing") ]));
      let found = ok c "work_find_sessions" (`Assoc [ ("product", `String "gateway") ]) in
      let s = List.hd (items found "sessions") in
      check_str "session name" "probe-session" (str s "name");
      check_str "agent kind" "claude" (str s "agent");
      Alcotest.(check bool) "no folder key" true (member "cwd" s = `Null);
      Alcotest.(check int) "by track" 1 (List.length (items (ok c "work_find_sessions" (`Assoc [ ("track", `String "alpha") ])) "sessions"));
      Alcotest.(check int) "by task" 1 (List.length (items (ok c "work_find_sessions" (`Assoc [ ("task", `String task); ("include_closed", `Bool true) ])) "sessions"));
      let got = ok c "work_get_session" (`Assoc [ ("session", `String "probe-session") ]) in
      Alcotest.(check bool) "tasks of the session" true (contains (Yojson.Safe.to_string (member "tasks" got)) task);
      Alcotest.(check bool) "events of the session" true (items got "events_newest_first" <> []);
      let view = ok c "work_open_view" (`Assoc [ ("target", `String task); ("view", `String "board") ]) in
      Alcotest.(check bool) "not opened" true (member "opened" view = `Bool false);
      check_str "reason" "not available until the interface slice" (str view "reason");
      ignore (ok c "work_open_view" (`Assoc [ ("target", `String "gateway") ])))

let () =
  Alcotest.run "work_mcp tools"
    [
      ( "tools",
        [
          Alcotest.test_case "handshake and tool list" `Quick test_handshake;
          Alcotest.test_case "read tools" `Quick test_read_tools;
          Alcotest.test_case "write tools" `Quick test_write_tools;
          Alcotest.test_case "bad inputs" `Quick test_bad_inputs;
          Alcotest.test_case "sessions and view" `Quick test_sessions_and_view;
        ] );
    ]
