(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the independent review: retried writes (S5), question
   handling, warnings noise, concurrent first use, and the smaller findings. *)

open Work_client
open Work_support
module W = Mesh_worklog
module Q = Work_mcp.Work_questions

let check_str msg expected actual = Alcotest.(check string) msg expected actual
let int_of = function `Int n -> n | _ -> -1
let no_warnings what json = Alcotest.(check bool) (what ^ ": no data_warnings") true (member "data_warnings" json = `Null)

(* ---- S5 ---------------------------------------------------------------- *)

let log_with c task rid text =
  ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String text); ("request_id", `String rid) ])

let test_log_retry () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = new_task c () in
  let first = log_with c task "req-1" "once" in
  Alcotest.(check bool) "first call is not a duplicate" true (member "duplicate" first = `Null);
  let again = log_with c task "req-1" "once" in
  Alcotest.(check bool) "the retry is a duplicate" true (member "duplicate" again = `Bool true);
  check_str "the original result" (str first "id") (str again "id");
  let prefix = String.sub task 0 6 in
  Alcotest.(check bool) "a prefix of the same task is the same target" true
    (member "duplicate" (log_with c prefix "req-1" "once") = `Bool true);
  Alcotest.(check int) "one progress event" 1 (count_events wl_home "progress");
  ignore (log_with c task "req-2" "twice");
  Alcotest.(check int) "another request id writes" 2 (count_events wl_home "progress");
  let other = new_task c ~title:"Other" () in
  Alcotest.(check bool) "the same id on another task writes" true
    (member "duplicate" (log_with c other "req-1" "elsewhere") = `Null);
  Alcotest.(check int) "three progress events" 3 (count_events wl_home "progress");
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "no key") ]));
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "no key") ]));
  Alcotest.(check int) "without a request id nothing is deduplicated" 5 (count_events wl_home "progress");
  stop c

let test_request_id_is_per_session () =
  let home, wl_home = fresh () in
  let a = connect ~session:"session-a" ~wl_home ~home () in
  let b = connect ~session:"session-b" ~wl_home ~home () in
  let task = new_task a () in
  ignore (log_with a task "same-key" "from a");
  Alcotest.(check bool) "another session is not a duplicate" true
    (member "duplicate" (log_with b task "same-key" "from b") = `Null);
  Alcotest.(check int) "both wrote" 2 (count_events wl_home "progress");
  stop a;
  stop b

let test_add_task_and_ask_retry () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let args rid = `Assoc [ ("title", `String "Retried"); ("product", `String "gateway"); ("request_id", `String rid) ] in
  let first = ok c "work_add_task" (args "add-1") in
  let again = ok c "work_add_task" (args "add-1") in
  check_str "the same task id" (str first "id") (str again "id");
  Alcotest.(check bool) "duplicate" true (member "duplicate" again = `Bool true);
  Alcotest.(check int) "one task created" 1 (count_events wl_home "created");
  let ask rid = ok c "work_ask" (`Assoc [ ("text", `String "Which?"); ("request_id", `String rid) ]) in
  let q1 = ask "ask-1" in
  let q2 = ask "ask-1" in
  check_str "the same question" (str q1 "id") (str q2 "id");
  Alcotest.(check bool) "duplicate question" true (member "duplicate" q2 = `Bool true);
  Alcotest.(check int) "one question written" 1 (count_events wl_home "question");
  let answered = W.Err.unwrap (Q.answer (library_ctx wl_home) ~question:(str q1 "id") ~text:"A" ~by:"owner" ()) in
  check_str "answered" (str q1 "id") answered;
  check_str "the retry now reports the state" "answered" (str (ask "ask-1") "state");
  stop c

let test_request_id_is_checked () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = new_task c () in
  let before = List.length (event_lines wl_home) in
  List.iter
    (fun rid ->
      Alcotest.(check bool) ("refused: " ^ rid) true
        (call c "work_log" (`Assoc [ ("id", `String task); ("text", `String "x"); ("request_id", `String rid) ])).is_error)
    [ String.make 65 'a'; "has space"; "semi;colon"; "new\nline"; "" ];
  Alcotest.(check int) "nothing written" before (List.length (event_lines wl_home));
  ignore (log_with c task (String.make 64 'a') "limit is 64");
  stop c;
  let anonymous = connect ~session:"" ~wl_home ~home () in
  let r = call anonymous "work_log" (`Assoc [ ("id", `String task); ("text", `String "x"); ("request_id", `String "k") ]) in
  Alcotest.(check bool) "a request id needs a session" true r.is_error;
  check_str "code" "invalid_input" (error_code r);
  stop anonymous

(* ---- questions --------------------------------------------------------- *)

let test_question_ids () =
  with_server (fun c _ ->
      let id = str (ok c "work_ask" (`Assoc [ ("text", `String "Id?") ])) "id" in
      Alcotest.(check int) "N- and eight hex digits" 10 (String.length id);
      Alcotest.(check bool) "valid" true (Q.valid_id id);
      Alcotest.(check bool) "six-digit ids are still read" true (Q.valid_id "N-123456"))

let test_id_collision_reported () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let line host text =
    W.Err.unwrap
      (W.Txn.run (library_ctx ~host wl_home) (fun tx ->
           W.Txn.append tx
             [ ("N-deadbeef", "question", [ ("id", `String "N-deadbeef"); ("text", `String text) ]) ]))
  in
  line "host-a" "first";
  line "host-b" "second";
  let listed = call c "work_list_questions" (`Assoc []) in
  Alcotest.(check int) "one question remains" 1 (List.length (items listed.json "questions"));
  check_str "the first defines it" "first" (str (List.hd (items listed.json "questions")) "text");
  Alcotest.(check bool) "the collision is reported" true
    (contains (Yojson.Safe.to_string (member "data_warnings" listed.json)) "N-deadbeef");
  stop c

let test_answer_before_question_across_hosts () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let same_second = fun () -> 1_800_000_000 in
  let qid =
    fst (W.Err.unwrap (Q.ask (library_ctx ~host:"zzz-host" ~now:same_second wl_home) ~text:"Same second?" ()))
  in
  ignore (W.Err.unwrap (Q.answer (library_ctx ~host:"aaa-host" ~now:same_second wl_home) ~question:qid ~text:"Yes" ~by:"owner" ()));
  let listed = ok c "work_list_questions" (`Assoc [ ("state", `String "answered") ]) in
  Alcotest.(check int) "the answer sorting first still attaches" 1 (List.length (items listed "questions"));
  stop c

let test_no_wl_noise () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = new_task c () in
  let q_task = str (ok c "work_ask" (`Assoc [ ("text", `String "About a task?"); ("task", `String task) ])) "id" in
  let q_none = str (ok c "work_ask" (`Assoc [ ("text", `String "About nothing?") ])) "id" in
  ignore (W.Err.unwrap (Q.answer (library_ctx wl_home) ~question:q_task ~text:"yes" ~by:"owner" ()));
  ignore (W.Err.unwrap (Q.answer (library_ctx wl_home) ~question:q_none ~text:"no" ~by:"owner" ()));
  ignore (log_with c task "noise-1" "marker");
  let snap = W.Err.unwrap (W.Reader.snapshot (library_ctx wl_home)) in
  Alcotest.(check bool) "the library does warn about our event types" true
    (List.exists (fun w -> contains w "unknown event type \"question\"") snap.warnings
    && List.exists (fun w -> contains w "unknown event type \"answer\"") snap.warnings
    && List.exists (fun w -> contains w "unknown task N-") snap.warnings
    && List.exists (fun w -> contains w "unknown event type \"request\"") snap.warnings);
  List.iter
    (fun (name, args) -> no_warnings name (ok c name args))
    [
      ("work_resume", `Assoc []);
      ("work_list_tasks", `Assoc []);
      ("work_get", `Assoc [ ("id", `String task) ]);
      ("work_list_questions", `Assoc []);
      ("work_get_session", `Assoc [ ("session", `String "probe-session") ]);
      ("work_list_projects", `Assoc []);
    ];
  stop c

let test_scope_filter () =
  with_server (fun c _ ->
      let task = new_task c () in
      let about = str (ok c "work_ask" (`Assoc [ ("text", `String "With"); ("task", `String task) ])) "id" in
      let none = str (ok c "work_ask" (`Assoc [ ("text", `String "Without") ])) "id" in
      let ids scope = List.map (fun q -> str q "id") (items (ok c "work_list_questions" (`Assoc [ ("scope", `String scope) ])) "questions") in
      Alcotest.(check (list string)) "without a task" [ none ] (ids "without_task");
      Alcotest.(check (list string)) "with a task" [ about ] (ids "with_task");
      Alcotest.(check int) "all" 2 (List.length (ids "all"));
      Alcotest.(check bool) "combined with a task is refused" true
        (call c "work_list_questions" (`Assoc [ ("scope", `String "without_task"); ("task", `String task) ])).is_error)

let test_my_questions () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let ids = List.init 12 (fun i -> str (ok c "work_ask" (`Assoc [ ("text", `String (Printf.sprintf "Question %d" i)) ])) "id") in
  (* Every question but the oldest is answered: ten newer answered ones used
     to push the unanswered one out. *)
  List.iteri
    (fun i id -> if i > 0 then ignore (W.Err.unwrap (Q.answer (library_ctx wl_home) ~question:id ~text:"done" ~by:"owner" ())))
    ids;
  let resume = ok c "work_resume" (`Assoc []) in
  let mine = items resume "my_questions" in
  Alcotest.(check bool) "at most ten" true (List.length mine <= 10);
  check_str "the unanswered question comes first" (List.hd ids) (str (List.hd mine) "id");
  check_str "and is open" "open" (str (List.hd mine) "state");
  Alcotest.(check int) "open count" 1 (int_of (member "open_questions" resume));
  stop c

let test_old_answered_questions_are_not_inherited () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let old = Unix.time () |> int_of_float |> fun now -> now - (60 * 86_400) in
  (* A question of a reused session name, asked and answered long ago. *)
  W.Err.unwrap
    (W.Txn.run (library_ctx ~host:"old-host" ~now:(fun () -> old) wl_home) (fun tx ->
           W.Txn.append tx
             [ ( "N-0ddba11a", "question", [ ("id", `String "N-0ddba11a"); ("text", `String "Reused name"); ("session", `String "probe-session") ] );
               ( "N-0ddba11a", "answer", [ ("question", `String "N-0ddba11a"); ("text", `String "long ago"); ("by", `String "owner") ] ) ]))
  ;
  let resume = ok c "work_resume" (`Assoc []) in
  Alcotest.(check bool) "an answer from two months ago is not inherited" false
    (contains (Yojson.Safe.to_string (member "my_questions" resume)) "Reused name");
  stop c

(* ---- the smaller findings ---------------------------------------------- *)

let test_block_returns_full_ids () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = new_task c () in
  let prefix = String.sub task 0 6 in
  let blocked = ok c "work_block" (`Assoc [ ("id", `String prefix); ("text", `String "waiting") ]) in
  check_str "block: the full task id" task (str blocked "task");
  let resolved = ok c "work_unblock" (`Assoc [ ("id", `String prefix) ]) in
  check_str "unblock: the full task id" task (str resolved "task");
  check_str "same blocker" (str blocked "blocker") (str resolved "blocker");
  stop c

let test_session_filter_by_agent () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let task = new_task c () in
  ignore (ok c "work_ask" (`Assoc [ ("text", `String "By claude") ]));
  ignore (ok c "work_log" (`Assoc [ ("id", `String task); ("text", `String "by claude") ]));
  let other = connect ~session:"probe-session" ~extra:[ "WL_AGENT=pi" ] ~unset:[ "CLAUDECODE" ] ~wl_home ~home () in
  ignore (ok other "work_log" (`Assoc [ ("id", `String task); ("text", `String "by pi") ]));
  ignore (ok other "work_ask" (`Assoc [ ("text", `String "By pi") ]));
  let only agent = ok c "work_get_session" (`Assoc [ ("session", `String "probe-session"); ("agent", `String agent) ]) in
  let texts json key = List.map (fun e -> try str e "text" with _ -> "") (items json key) in
  let pi = only "pi" in
  Alcotest.(check bool) "events of the agent only" true
    (List.for_all (fun t -> t = "by pi" || t = "") (texts pi "events_newest_first"));
  Alcotest.(check (list string)) "questions of the agent only" [ "By pi" ] (texts pi "questions");
  Alcotest.(check (list string)) "questions of the other agent" [ "By claude" ] (texts (only "claude") "questions");
  stop other;
  stop c

let test_failed_link_is_reported () =
  Work_mcp.Work_repo.reset_warnings ();
  Work_mcp.Work_link.report (Error (W.Err.make W.Err.Lock_timeout "lock held by /srv/data/store"));
  Work_mcp.Work_link.report (Ok ("T-1", W.Write_task.Unchanged));
  match Work_mcp.Work_repo.take_warnings () with
  | [ w ] ->
      Alcotest.(check bool) "says the link failed" true (contains w "session link failed");
      assert_no_path_text ~what:"link warning" w
  | l -> Alcotest.failf "expected one warning, got %d" (List.length l)

let test_ask_links_its_session () =
  with_server (fun c _ ->
      let task = new_task c () in
      let other = ok c "work_add_task" (`Assoc [ ("title", `String "Quiet"); ("product", `String "gateway") ]) in
      ignore other;
      ignore (ok c "work_ask" (`Assoc [ ("text", `String "Linked?"); ("task", `String task) ]));
      check_str "linked once" "probe-session"
        (str (List.hd (items (ok c "work_get" (`Assoc [ ("id", `String task) ])) "sessions")) "session"))

(* ---- first use by two servers at once ---------------------------------- *)

let test_concurrent_first_use () =
  let home = temp_dir "work-mcp-race" in
  let wl_home = Filename.concat home "race-data" in
  let a = connect ~session:"race-a" ~wl_home ~home () in
  let b = connect ~session:"race-b" ~wl_home ~home () in
  send a (call_request a "work_list_products" (`Assoc []));
  send b (call_request b "work_list_products" (`Assoc []));
  let ra = reply_of (recv a) and rb = reply_of (recv b) in
  Alcotest.(check bool) "first server" false ra.is_error;
  Alcotest.(check bool) "second server" false rb.is_error;
  Alcotest.(check bool) "one repository" true (Sys.file_exists (Filename.concat wl_home "taxonomy.yaml"));
  ignore (new_task a ~product:"general" ());
  ignore (new_task b ~product:"general" ());
  stop a;
  stop b

(* A first use whose writes fail (no file may grow: a full disk, a quota) creates no taxonomy.yaml: the folder
   is not left holding an empty one, which every later server would take for a repository it cannot read. *)
let test_failed_creation_leaves_no_taxonomy () =
  let home = temp_dir "work-mcp-whole" in
  let wl_home = Filename.concat home "whole-data" in
  let taxonomy = Filename.concat wl_home "taxonomy.yaml" in
  let full = [ "/bin/sh"; "-c"; "trap '' XFSZ; ulimit -f 0; exec \"$0\"" ] in
  let limited = connect ~session:"whole-a" ~wrap:full ~wl_home ~home () in
  send limited (call_request limited "work_list_products" (`Assoc []));
  let refused = reply_of (recv limited) in
  stop limited;
  Alcotest.(check bool) "the creation fails" true refused.is_error;
  Alcotest.(check bool) "and leaves no taxonomy.yaml" false (Sys.file_exists taxonomy);
  let c = connect ~session:"whole-b" ~wl_home ~home () in
  send c (call_request c "work_list_products" (`Assoc []));
  let reply = reply_of (recv c) in
  Alcotest.(check bool) ("the next first use creates the repository: " ^ reply.text) false reply.is_error;
  stop c

let tests =
  [
    Alcotest.test_case "work_log retry" `Quick test_log_retry;
    Alcotest.test_case "request id is per session" `Quick test_request_id_is_per_session;
    Alcotest.test_case "work_add_task and work_ask retry" `Quick test_add_task_and_ask_retry;
    Alcotest.test_case "request id is checked" `Quick test_request_id_is_checked;
    Alcotest.test_case "question ids" `Quick test_question_ids;
    Alcotest.test_case "id collision is reported" `Quick test_id_collision_reported;
    Alcotest.test_case "answer before question, two hosts" `Quick test_answer_before_question_across_hosts;
    Alcotest.test_case "no wl warning noise" `Quick test_no_wl_noise;
    Alcotest.test_case "scope filter" `Quick test_scope_filter;
    Alcotest.test_case "my_questions keeps the open ones" `Quick test_my_questions;
    Alcotest.test_case "old answers are not inherited" `Quick test_old_answered_questions_are_not_inherited;
    Alcotest.test_case "block and unblock return full ids" `Quick test_block_returns_full_ids;
    Alcotest.test_case "agent filter of work_get_session" `Quick test_session_filter_by_agent;
    Alcotest.test_case "a failed link is reported" `Quick test_failed_link_is_reported;
    Alcotest.test_case "work_ask links its session" `Quick test_ask_links_its_session;
    Alcotest.test_case "two servers creating the repository" `Quick test_concurrent_first_use;
    Alcotest.test_case "a failed creation leaves no taxonomy" `Quick test_failed_creation_leaves_no_taxonomy;
  ]
