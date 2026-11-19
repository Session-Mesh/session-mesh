(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_client
module W = Mesh_worklog

let check_str msg expected actual = Alcotest.(check string) msg expected actual

let first_event_of_type wl_home typ =
  match List.find_opt (fun l -> contains l ("\"type\":\"" ^ typ ^ "\"")) (event_lines wl_home) with
  | Some l -> Yojson.Safe.from_string l
  | None -> Alcotest.failf "no %s event" typ

let write_with ~session =
  let home, wl_home = fresh () in
  let c = connect ~session ~wl_home ~home () in
  let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "I"); ("product", `String "gateway") ])) "id" in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x") ]));
  stop c;
  wl_home

let test_identity () =
  let wl_home = write_with ~session:"agent-x" in
  let created = first_event_of_type wl_home "created" in
  check_str "agent kind" "claude" (str created "agent");
  check_str "session name from MESH_SESSION" "agent-x" (str created "session");
  let linked = first_event_of_type wl_home "session_linked" in
  check_str "linked session" "agent-x" (str linked "session");
  Alcotest.(check int) "linked once" 1
    (List.length (List.filter (fun l -> contains l "session_linked") (event_lines wl_home)))

let test_identity_unusable () =
  let wl_home = write_with ~session:"not a valid name" in
  let created = first_event_of_type wl_home "created" in
  Alcotest.(check bool) "an invalid session name is dropped" true (member "session" created = `Null);
  let wl_home = write_with ~session:"" in
  Alcotest.(check bool) "no session" true (member "session" (first_event_of_type wl_home "created") = `Null);
  Alcotest.(check bool) "no link without a session" false (contains (events_text wl_home) "session_linked")

let test_concurrent_writers () =
  let home, wl_home = fresh () in
  let a = connect ~session:"client-a" ~wl_home ~home () in
  let b = connect ~session:"client-b" ~wl_home ~home () in
  let task = str (ok a "work_add_task" (`Assoc [ ("title", `String "Shared"); ("product", `String "gateway") ])) "id" in
  let n = 20 in
  let log c who i =
    call_request c "work_log" (`Assoc [ ("id", `String task); ("text", `String (Printf.sprintf "%s-%d" who i)) ])
  in
  (* All requests of both clients are in flight before any reply is read. *)
  for i = 1 to n do
    send a (log a "a" i);
    send b (log b "b" i)
  done;
  for _ = 1 to n do
    Alcotest.(check bool) "a ok" false (reply_of (recv a)).is_error;
    Alcotest.(check bool) "b ok" false (reply_of (recv b)).is_error
  done;
  let lines = event_lines wl_home in
  List.iter (fun l -> ignore (Yojson.Safe.from_string l)) lines;
  let progress = List.filter (fun l -> contains l "\"type\":\"progress\"") lines in
  Alcotest.(check int) "every write kept" (2 * n) (List.length progress);
  let snap = W.Err.unwrap (W.Reader.snapshot (W.Ctx.make ~root:wl_home ~host:"check" ~commit:false ())) in
  Alcotest.(check (list string)) "no malformed line" [] (W.Store.scan_malformed (W.Ctx.make ~root:wl_home ~host:"check" ~commit:false ()));
  Alcotest.(check int) "both sessions linked" 2 (List.length (W.Model.Smap.find task snap.loaded.world.tasks).sessions);
  stop a;
  stop b

let test_first_use () =
  let home = temp_dir "work-mcp-first" in
  let wl_home = Filename.concat home "fresh-data" in
  let c = connect ~wl_home ~home () in
  ignore (ok c "work_list_products" (`Assoc []));
  Alcotest.(check bool) "taxonomy exists" true (Sys.file_exists (Filename.concat wl_home "taxonomy.yaml"));
  ignore (ok c "work_add_product" (`Assoc [ ("id", `String "mine"); ("category", `String "main") ]));
  stop c;
  let again = connect ~wl_home ~home () in
  Alcotest.(check bool) "second start keeps the data" true
    (contains (Yojson.Safe.to_string (ok again "work_list_products" (`Assoc []))) "mine");
  stop again

let test_never_overwrites () =
  let home = temp_dir "work-mcp-foreign" in
  let wl_home = Filename.concat home "not-a-repo" in
  W.Appendfile.mkdir_p wl_home;
  let keep = Filename.concat wl_home "keep.txt" in
  Out_channel.with_open_bin keep (fun oc -> output_string oc "mine");
  let c = connect ~wl_home ~home () in
  let r = call c "work_list_products" (`Assoc []) in
  Alcotest.(check bool) "refused" true r.is_error;
  check_str "code" "repository" (error_code r);
  check_str "file untouched" "mine" (read_file keep);
  Alcotest.(check bool) "no taxonomy written" false (Sys.file_exists (Filename.concat wl_home "taxonomy.yaml"));
  stop c

let test_no_leaks () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = str (ok c "work_add_task" (`Assoc [ ("title", `String "L"); ("product", `String "gateway"); ("notes", `String "body") ])) "id" in
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x") ]));
  ignore (ok c "work_get" (`Assoc [ ("id", `String task) ]));
  ignore (ok c "work_find_sessions" (`Assoc [ ("task", `String task) ]));
  ignore (ok c "work_get_session" (`Assoc [ ("session", `String "probe-session") ]));
  ignore (ok c "work_resume" (`Assoc []));
  stop c;
  Alcotest.(check bool) "the folder is kept in the data repository" true
    (contains (events_text wl_home) "\"cwd\":");
  assert_no_leaks ~what:"token" ~forbidden:[ secret; "MESH_SESSION_TOKEN" ];
  assert_no_leaks ~what:"folder" ~forbidden:[ Unix.realpath (Sys.getcwd ()); "\"cwd\"" ];
  Alcotest.(check bool) "token not in the data repository" false (contains (events_text wl_home) secret)

let () =
  Alcotest.run "work_mcp server"
    [
      ( "server",
        [
          Alcotest.test_case "identity from the environment" `Quick test_identity;
          Alcotest.test_case "unusable identity" `Quick test_identity_unusable;
          Alcotest.test_case "two clients writing" `Quick test_concurrent_writers;
          Alcotest.test_case "repository created at first use" `Quick test_first_use;
          Alcotest.test_case "never overwrites" `Quick test_never_overwrites;
          Alcotest.test_case "no token, no folder in outputs" `Quick test_no_leaks;
        ] );
      ("questions", Test_questions.tests);
      ("answer", Test_answer.tests);
      ("hardening", Test_hardening.tests);
      ("requests", Test_requests.tests);
      ("review2", Test_review2.tests);
      ("review3", Test_review3.tests);
    ]
